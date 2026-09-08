import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { hashDirectory } from "../src/transaction.js";
import { createTestProject } from "./project-builder.js";
import { pythonProject, runPythonProject } from "./support/python-project.mjs";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const parse = (result) => JSON.parse(result.stdout);
const prepare = (id) => ["prepare", "--task", id, "--mode", "normal", "--objective", "issue:58"];

// This is Windows package/tool integration, not a native Codex orchestration.
test("Windows distributed package completes the independent Python lifecycle", {
  skip: process.platform !== "win32" ? "Windows acceptance; Linux is tracked in #59" : false,
  timeout: 180000,
}, async (t) => {
  const staging = await createTestProject(t);
  const packed = await execute(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json",
    "--pack-destination", staging, "--cache", path.join(staging, "cache")],
  { cwd: repository, encoding: "utf8", windowsHide: true });
  const [pack] = JSON.parse(packed.stdout);
  const tarball = path.join(staging, pack.filename);
  const packageSha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
  await execute("tar", ["-xzf", tarball, "-C", staging], { windowsHide: true });
  const packageRoot = path.join(staging, "package");
  const installer = path.join(packageRoot, "bin/agentic-core.js");
  const { root, python } = await pythonProject(t, { installer });
  const { root: independent } = await pythonProject(t, { installer });
  const independentBefore = await hashDirectory(independent);
  assert.ok(root.includes(" "));
  // Make the bootstrap unavailable before exercising the persisted launcher.
  await rename(packageRoot, path.join(staging, "bootstrap unavailable"));
  for (const file of ["package.json", "package-lock.json", "node_modules", ".claude"])
    await assert.rejects(lstat(path.join(root, file)), { code: "ENOENT" });

  const counter = path.join(staging, "suite invocations.txt");
  const wrapper = path.join(root, "work dir/wrapper space.py");
  await writeFile(wrapper, `import os\nfrom pathlib import Path\np = Path(os.environ['ACCEPTANCE_COUNTER'])\np.write_text(str(int(p.read_text()) + 1) if p.exists() else '1')\n${await readFile(wrapper, "utf8")}`);
  await writeFile(path.join(root, ".env"), "API_KEY=synthetic-acceptance-secret\n");
  const run = (args, env = {}) => runPythonProject(root, args, { ACCEPTANCE_COUNTER: counter, ...env });
  const count = async () => Number(await readFile(counter, "utf8"));
  const maintenance = async (args) => {
    const result = await execute(process.execPath, [path.join(root, ".agentic-core/runtime-launcher.mjs"),
      "agentic-core", ...args, root], { cwd: root, encoding: "utf8", windowsHide: true,
      env: { ...process.env, AGENTIC_CORE_OUTPUT: "json" } });
    return JSON.parse(result.stdout);
  };
  const environmentBefore = await hashDirectory(path.join(root, ".venv"));
  const inputsBefore = await hashDirectory(path.join(root, "work dir"));
  const initialFiles = await readdir(root);
  const direct = parse(await run(["test"]));
  assert.equal(direct.status, "approved", JSON.stringify(direct));
  assert.equal(direct.suite.phases.call, 1);
  const [major, minor] = direct.python.version;
  assert.ok(major > 3 || (major === 3 && minor >= 11));
  assert.ok(direct.python.pytestVersion);
  await assert.rejects(lstat(path.join(root, ".agentic-core/quality/active-task.json")), { code: "ENOENT" });

  assert.equal((await run(prepare("windows-first"))).code, 0);
  const verified = parse(await run(["verify"]));
  assert.equal(verified.status, "approved", JSON.stringify(verified));
  assert.match(verified.receipt, /^QUALITY_OK/u);
  assert.equal(verified.verification.tests.suite.phases.call, 1);
  assert.equal(verified.verification.dry.status, "approved");
  assert.equal(verified.verification.crap.status, "approved");
  const callsBeforeReuse = await count();
  assert.equal(parse(await run(prepare("windows-first"))).reused, true);
  const reused = parse(await run(["verify"]));
  for (const control of ["tests", "dry", "crap"])
    assert.equal(reused.verification.reuse[control].reused, true);
  assert.equal(reused.budget.consumedMs, verified.budget.consumedMs);
  const explained = await run(["explain", "--json"]);
  assert.equal(parse(explained).evidence.current, true);
  assert.equal(parse(explained).testsExecuted, false);
  const pipe = await run(["explain"], { AGENTIC_CORE_OUTPUT: "" });
  assert.match(pipe.stdout, /diagnóstico sin ejecutar pruebas/u);
  assert.ok(pipe.stdout.split("\n").length < 20);
  assert.ok(!explained.stdout.includes(root));
  assert.doesNotMatch(explained.stdout + pipe.stdout, /synthetic-acceptance-secret|API_KEY/u);
  assert.equal(await count(), callsBeforeReuse);

  // Run the installed mutation tool directly; no Full agent flow is dispatched.
  const mutation = parse(await run(["mutate"]));
  assert.equal(mutation.complete, true, JSON.stringify(mutation));
  assert.equal(mutation.engine.version, "0.1.4");
  assert.equal(mutation.summary.killed, 2);
  assert.equal(mutation.details.length, 2);
  assert.ok(mutation.details.every((item) => item.status === "killed"));
  assert.equal(mutation.integrity.status, "preserved");
  const mutationCalls = await count();
  assert.equal(parse(await run(["mutate"])).reused, true);
  assert.equal(await count(), mutationCalls);
  assert.deepEqual(await readdir(root), initialFiles, "no automatic user export");

  const output = path.join(root, "resultado solicitado.md");
  assert.equal(parse(await run(["export", "--output", output])).status, "saved");
  const markdown = await readFile(output, "utf8");
  assert.match(markdown, /windows-first/u);
  assert.doesNotMatch(markdown, /synthetic-acceptance-secret|API_KEY/u);
  assert.equal(await count(), mutationCalls);
  const foreign = path.join(root, ".agentic-core/quality/foreign.txt");
  await writeFile(foreign, "contenido ajeno\n");
  const source = path.join(root, "work dir/src/subject.py");
  const original = await readFile(source, "utf8");
  await writeFile(source, original + "\n# input modificado\n");
  const stale = parse(await run(["explain"]));
  assert.equal(stale.status, "NO_VERIFICADO");
  assert.equal(stale.code, "quality_inputs_changed");
  assert.equal(await count(), mutationCalls);
  const refreshed = parse(await run(["verify"]));
  assert.equal(refreshed.status, "approved", JSON.stringify(refreshed));
  assert.equal(refreshed.verification.reuse.tests.reused, false);
  assert.equal(await count(), mutationCalls + 1);
  await writeFile(source, original);

  assert.equal((await run(prepare("windows-second"))).code, 0);
  for (const file of ["verification.json", "mutation.json"])
    await assert.rejects(lstat(path.join(root, ".agentic-core/quality", file)), { code: "ENOENT" });
  assert.equal(await readFile(output, "utf8"), markdown);
  const beforePreview = await hashDirectory(root);
  assert.equal((await maintenance(["update", "--dry-run"])).status, "ready");
  assert.equal(await hashDirectory(root), beforePreview);
  assert.equal((await maintenance(["update"])).status, "updated");
  assert.equal((await maintenance(["doctor"])).status, "healthy");
  assert.equal((await maintenance(["update", "--dry-run"])).plan.actions.length, 0);
  const beforeUninstall = await hashDirectory(root);
  await maintenance(["uninstall", "--dry-run"]);
  assert.equal(await hashDirectory(root), beforeUninstall);
  assert.equal((await maintenance(["uninstall"])).exitCode, 0);
  assert.equal(await readFile(foreign, "utf8"), "contenido ajeno\n");
  assert.equal(await readFile(output, "utf8"), markdown);
  assert.equal(await hashDirectory(path.join(root, ".venv")), environmentBefore);
  assert.equal(await hashDirectory(path.join(root, "work dir")), inputsBefore);
  assert.equal(await hashDirectory(independent), independentBefore,
    "task replacement, update and uninstall must preserve the other installation");
  await assert.rejects(lstat(path.join(root, ".agentic-core/runtime")), { code: "ENOENT" });
  const consumer = await execute(python, ["wrapper space.py", "argument with spaces & literal",
    "-c", "config space.ini", "python checks"], { cwd: path.join(root, "work dir"),
    encoding: "utf8", windowsHide: true, env: { ...process.env, AGENTIC_CORE_PYTHON: python,
      ACCEPTANCE_COUNTER: counter, PROJECT_SETTING: "required value", PYTHONDONTWRITEBYTECODE: "1" } });
  assert.match(consumer.stdout, /1 passed/u);
  t.diagnostic(JSON.stringify({ platform: process.platform, node: process.version,
    python: direct.python.version, pytest: direct.python.pytestVersion, packageSha256,
    mutation: mutation.summary, nativeCodex: "NO_VERIFICADO" }));
});
