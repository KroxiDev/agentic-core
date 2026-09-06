import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTestProject } from "./project-builder.js";
import { hashDirectory } from "../src/transaction.js";
import { defaultConfiguration } from "../src/installation/config.js";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
const binary = path.join(repository, "bin/agentic-core.js");
const selection = ["--provider", "codex", "--language", "python"];
async function run(args, cwd, { entry = binary, env = {} } = {}) {
  try {
    return { ...await execute(process.execPath, [entry, ...args], { cwd, encoding: "utf8", windowsHide: true,
      env: { ...process.env, AGENTIC_CORE_OUTPUT: "json", ...env } }), code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("Python installation validates selections, closed configuration and previews without writes", async (t) => {
  const root = await createTestProject(t, { files: { "keep.txt": "unchanged" } });
  const before = await hashDirectory(root);
  for (const options of [[], ["--provider", "claude", "--language", "python"], ["--provider", "codex", "--language", "python,javascript"], [...selection, "--language", "python"], [...selection, "--replace-conflicts"]]) {
    const result = await run(["init", root, ...options], root);
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(await hashDirectory(root), before);
  }
  const preview = await run(["init", root, ...selection, "--dry-run"], root);
  assert.equal(preview.code, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.limits.crap, 7);
  assert.equal(plan.limits.mutationScore, 90);
  assert.equal(plan.verification, "NO_VERIFICADO");
  assert.equal(await hashDirectory(root), before);
  for (const mutate of [
    (c) => { c.limits.enabled = false; },
    (c) => { c.limits.constructor = false; },
    (c) => { c.limits.crap = "7"; },
    (c) => { c.limits.mutationScore = 0; },
    (c) => { c.limits.operation.workers = 1.5; },
    (c) => { c.integration.python = [c.integration.python]; },
    (c) => { c.integration.python.runner = "unittest"; },
    (c) => { c.integration.python.cwd = "../outside"; },
    (c) => { c.integration.languages.push("python"); },
  ]) {
    const config = defaultConfiguration(); mutate(config);
    await writeFile(path.join(root, "settings.json"), JSON.stringify(config));
    const snapshot = await hashDirectory(root);
    const result = await run(["init", root, "--config", path.join(root, "settings.json"), "--dry-run"], root);
    assert.equal(result.code, 4, result.stderr);
    assert.equal(await hashDirectory(root), snapshot);
  }
});

test("private tools and installed runtime survive the bootstrap and remain independent", async (t) => {
  const root = await createTestProject(t, { pythonVenv: true, files: { "AGENTS.md": "# Instrucciones propias\r\n", "pyproject.toml": "[project]\nname='consumer'\nversion='1.0'\n", "uv.lock": "consumer lock", ".venv/sentinel": "consumer environment" } });
  const second = await createTestProject(t);
  const bootstrap = await createTestProject(t);
  await cp(path.join(repository, "bin"), path.join(bootstrap, "bin"), { recursive: true });
  await cp(path.join(repository, "dist"), path.join(bootstrap, "dist"), { recursive: true });
  await cp(path.join(repository, "package.json"), path.join(bootstrap, "package.json"));
  const payloadPath = path.join(bootstrap, "dist/runtime/payload-manifest.json");
  const payload = JSON.parse(await readFile(payloadPath, "utf8"));
  payload.source = "https://example.org/distributions/agentic-core/0.2.0";
  await writeFile(payloadPath, JSON.stringify(payload));
  const entry = path.join(bootstrap, "bin/agentic-core.js");
  const preserved = new Map(await Promise.all(["pyproject.toml", "uv.lock", ".venv/sentinel"].map(async (file) => [file, await readFile(path.join(root, file))])));
  const consumerEnvironment = await hashDirectory(path.join(root, ".venv"));
  for (const project of [root, second]) {
    const installed = await run(["init", project, ...selection], project, { entry });
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).status, "installed");
    assert.ok(!(await readdir(project)).includes("node_modules"));
    assert.ok(!(await readdir(project)).includes(".claude"));
    const agents = await readFile(path.join(project, "AGENTS.md"), "utf8");
    const block = agents.match(/<!-- AGENTIC_CORE_START -->[\s\S]*?<!-- AGENTIC_CORE_END -->/gu);
    assert.equal(block?.length, 1);
    const owner = JSON.parse(await readFile(path.join(project, ".agentic-core/ownership.json"), "utf8"));
    assert.equal(owner.managedBlocks[0].sha256, createHash("sha256").update(block[0]).digest("hex"));
    assert.deepEqual(await readFile(path.join(project, ".agentic-core/golden-rules.md")),
      await readFile(path.join(repository, "golden-rules.md")));
    assert.ok(!(await readdir(path.join(project, ".agentic-core"))).includes("quality"));
    assert.ok(!(await readdir(project)).includes(".codex"));
    assert.ok(!(await readdir(project)).includes(".agents"));
  }
  await rm(bootstrap, { recursive: true });
  for (const [file, content] of preserved) assert.deepEqual(await readFile(path.join(root, file)), content);
  assert.equal(await hashDirectory(path.join(root, ".venv")), consumerEnvironment);
  assert.ok((await readFile(path.join(root, "AGENTS.md"), "utf8")).startsWith("# Instrucciones propias\r\n"));
  const installedRun = (project, command, args = []) => run([command, ...args], project, { entry: path.join(project, ".agentic-core/runtime-launcher.mjs") });
  for (const project of [root, second]) {
    const diagnostic = await installedRun(project, "agentic-core", ["doctor"]);
    assert.equal(diagnostic.code, 0, diagnostic.stderr);
    const report = JSON.parse(diagnostic.stdout);
    assert.equal(report.runtime.source, payload.source);
    assert.equal(report.tools.tools.mutate4py, "0.1.4");
    assert.notEqual(report.python.executable, report.tools.executable);
    assert.equal(report.verification, "NO_VERIFICADO");
    const quality = await installedRun(project, "agentic-quality", ["prepare", "--task", "installation", "--mode", "normal", "--objective", "installation"]);
    assert.equal(quality.code, 2);
    assert.doesNotMatch(quality.stdout + quality.stderr, /QUALITY_OK/);
  }
  const secondHash = await hashDirectory(second);
  await rm(path.join(root, ".agentic-core/tools"), { recursive: true });
  assert.equal(await hashDirectory(second), secondHash);
  assert.equal((await installedRun(second, "agentic-core", ["doctor"])).code, 0);
  assert.equal((await installedRun(root, "agentic-core", ["doctor"])).code, 2);
});

test("installation rollback and conflicts preserve foreign files", async (t) => {
  const root = await createTestProject(t, { files: { "AGENTS.md": "foreign", ".agentic-core/foreign.bin": "data" } });
  const before = await hashDirectory(root);
  for (const failAfter of [6, 8, 9]) {
    const result = await run(["init", root, ...selection], root, { env: { NODE_ENV: "test", AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: String(failAfter) } });
    assert.equal(result.code, 5, result.stderr);
    assert.equal(await hashDirectory(root), before);
  }
  await mkdir(path.join(root, ".agentic-core/tools"));
  await writeFile(path.join(root, ".agentic-core/tools/foreign.txt"), "keep");
  const snapshot = await hashDirectory(root);
  const result = await run(["init", root, ...selection, "--dry-run"], root);
  assert.equal(result.code, 4);
  assert.ok(JSON.parse(result.stdout).conflicts.includes(".agentic-core/tools"));
  assert.equal(await hashDirectory(root), snapshot);
});

test("an explicit interpreter failure never falls back to autodetection", async (t) => {
  const root = await createTestProject(t);
  const result = await run(["init", root, ...selection, "--python", process.execPath, "--dry-run"], root,
    { env: { AGENTIC_CORE_PYTHON: path.join(root, "missing-python") } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /python_unavailable/);
  assert.deepEqual(await readdir(root), []);
});
