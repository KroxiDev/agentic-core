import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { defaultConfiguration, validateConfiguration } from "../src/installation/config.js";
import { captureProjectInputs, publicCheckpoint } from "../src/quality/project-inputs.js";
import { createProjectCopy, isolatedCommand, publicArguments, verifyProjectIntegrity } from "../src/quality/project-copy.js";
import { createTestProject } from "./project-builder.js";

const execute = promisify(execFile);

test("input policy shares measured code and resources while mandatory privacy beats Git overrides", async (t) => {
  const root = await createTestProject(t, { files: {
    "src/data/Thing.py": "VALUE = 1\n", "src/cache/helper.py": "VALUE = 2\n",
    "fixtures/cases.json": '[{"value":1}]', "fixtures/ignored.sql": "select 1;",
    "assets/raw.bin": Buffer.from([0, 255, 10]), ".gitignore": "fixtures/ignored.sql\n",
    ".env.synthetic": "SYNTHETIC_ONLY=1", "credentials/demo.json": '{"synthetic":true}',
    "private/person.txt": "SYNTHETIC PERSON", "fixtures/contact.json": '{"email":"synthetic.person@example.invalid"}',
    "fixtures/token.json": '{"api_key":"synthetic-token-only"}',
    "run helper.sh": "#!/bin/sh\nprintf success\n",
  } });
  await execute("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  await chmod(path.join(root, "run helper.sh"), 0o755);
  const config = defaultConfiguration();
  const unit = config.integration.python;
  unit.scope = ["src"];
  let checkpoint = await captureProjectInputs(root, unit);
  assert.equal(checkpoint.inventory.find((entry) => entry.path === "src/data/Thing.py").kind, "measured_code");
  assert.equal(checkpoint.inventory.find((entry) => entry.path === "src/cache/helper.py").kind, "measured_code");
  assert.ok(!checkpoint.inventory.some((entry) => entry.path === "fixtures/ignored.sql"));
  unit.inputs.includeIgnored = ["fixtures/ignored.sql", ".env.synthetic", "credentials", "private", "fixtures/contact.json", "fixtures/token.json"];
  checkpoint = await captureProjectInputs(root, unit);
  const publicText = JSON.stringify(publicCheckpoint(checkpoint));
  assert.ok(checkpoint.inventory.some((entry) => entry.path === "fixtures/ignored.sql"));
  assert.doesNotMatch(publicText, /synthetic|credentials|contact\.json|token\.json|person\.txt|api_key|example\.invalid/u);
  assert.ok(checkpoint.exclusions.private >= 5);
  const copy = await createProjectCopy(checkpoint);
  t.after(copy.dispose);
  assert.deepEqual(await readFile(path.join(copy.root, "assets/raw.bin")), Buffer.from([0, 255, 10]));
  assert.equal((await lstat(path.join(copy.root, "run helper.sh"))).mode & 0o777, (await lstat(path.join(root, "run helper.sh"))).mode & 0o777);
  assert.equal((await verifyProjectIntegrity(checkpoint, unit, copy.root, "preparation")).status, "preserved");
  const python = { executable: process.execPath };
  unit.interpreter = python.executable;
  unit.command.executable = python.executable;
  unit.environment = { PYTHONPATH: path.join(root, "src") };
  assert.equal(isolatedCommand(unit, python, checkpoint, copy.root, {}).env.PYTHONPATH, path.join(copy.root, "src"));
  assert.deepEqual(publicArguments(["--password", "synthetic-only", "--token=synthetic-only", "src/data/Thing.py"], checkpoint, copy.root),
    ["[privado]", "[privado]", "[privado]", "src/data/Thing.py"]);
  await writeFile(path.join(copy.root, "fixtures/cases.json"), "changed in copy");
  await writeFile(path.join(root, "src/cache/helper.py"), "CONCURRENT = True\n");
  const integrity = await verifyProjectIntegrity(checkpoint, unit, copy.root, "tests");
  assert.equal(integrity.status, "NO_VERIFICADO");
  assert.deepEqual(integrity.copy, ["fixtures/cases.json"]);
  assert.deepEqual(integrity.original, ["src/cache/helper.py"]);
  assert.equal(await readFile(path.join(root, "src/cache/helper.py"), "utf8"), "CONCURRENT = True\n");
  unit.inputs.includeIgnored = [];
  unit.inputs.respectGitIgnore = false;
  assert.ok((await captureProjectInputs(root, unit)).inventory.some((entry) => entry.path === "fixtures/ignored.sql"));
  assert.equal(validateConfiguration(config), config);
  assert.throws(() => validateConfiguration({ ...config, integration: { ...config.integration,
    python: { ...unit, inputs: { ...unit.inputs, respectGitIgnore: "false" } } } }));
  const privateKey = "synthetic.person@example.invalid";
  assert.throws(() => validateConfiguration({ ...config, integration: { ...config.integration,
    python: { ...unit, environment: { [privateKey]: 123 } } } }), (error) => !error.message.includes(privateKey));
});

test("copy preserves case-sensitive files and executable helpers on Linux", { skip: process.platform === "win32" }, async (t) => {
  const root = await createTestProject(t, { files: {
    "Case.txt": "upper", "case.txt": "lower", "helper space.sh": "#!/bin/sh\ncat Case.txt case.txt\n",
  } });
  await chmod(path.join(root, "helper space.sh"), 0o755);
  const checkpoint = await captureProjectInputs(root, defaultConfiguration().integration.python);
  const copy = await createProjectCopy(checkpoint);
  t.after(copy.dispose);
  assert.equal((await execute(path.join(copy.root, "helper space.sh"), [], { cwd: copy.root })).stdout, "upperlower");
});

test("input links are never followed or exposed by diagnosis", async (t) => {
  const root = await createTestProject(t, { files: { "public.py": "VALUE = 1\n" } });
  const outside = await createTestProject(t, { files: { "synthetic-private.txt": "synthetic.person@example.invalid" } });
  await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const checkpoint = await captureProjectInputs(root, defaultConfiguration().integration.python);
  assert.equal(checkpoint.issues[0].code, "input_type_unsupported");
  assert.doesNotMatch(JSON.stringify(publicCheckpoint(checkpoint)), /linked|synthetic|example/u);
});
