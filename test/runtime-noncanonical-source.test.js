import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTestProject } from "./project-builder.js";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");

test("a declared noncanonical payload is accepted; incomplete or corrupt payloads fail before installation", async (t) => {
  const bootstrap = await createTestProject(t);
  const project = await createTestProject(t);
  await cp(path.join(repository, "bin"), path.join(bootstrap, "bin"), { recursive: true });
  await cp(path.join(repository, "dist"), path.join(bootstrap, "dist"), { recursive: true });
  await cp(path.join(repository, "package.json"), path.join(bootstrap, "package.json"));
  const manifestPath = path.join(bootstrap, "dist/runtime/payload-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.source = "https://example.org/distributions/agentic-core/0.2.0";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const run = () => execute(process.execPath, [path.join(bootstrap, "bin/agentic-core.js"),
    "init", project, "--provider", "codex", "--language", "python", "--dry-run"],
  { cwd: project, encoding: "utf8", env: { ...process.env, NODE_ENV: "production", AGENTIC_CORE_OUTPUT: "json" } });
  const preview = JSON.parse((await run()).stdout);
  assert.equal(preview.runtime.source, manifest.source);
  assert.equal(preview.status, "ready");
  const expectInvalid = async () => {
    await assert.rejects(run(), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /invalid_runtime/);
      assert.doesNotMatch(error.stdout, /installed|QUALITY_OK/);
      return true;
    });
    assert.deepEqual(await readdir(project), []);
  };
  for (const change of [
    (value) => { delete value.source; },
    (value) => { value.integrity.files.pop(); },
    (value) => { value.version = "99.0.0"; },
    (value) => { value.commit = "invalid-revision"; },
  ]) {
    const invalid = structuredClone(manifest); change(invalid);
    await writeFile(manifestPath, JSON.stringify(invalid));
    await expectInvalid();
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(bootstrap, "dist/runtime/python-helper.py"), "corrupt payload");
  await expectInvalid();
  await rm(path.join(bootstrap, "dist/runtime/python-helper.py"));
  await expectInvalid();
});
