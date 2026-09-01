import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function runBinary(relativePath, args = [], options = {}) {
  return execFileAsync(process.execPath, [path.join(repositoryRoot, relativePath), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
}

test("the maintenance CLI exposes only installation lifecycle commands", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const version = await runBinary("bin/agentic-core.js", ["--version"]);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await runBinary("bin/agentic-core.js", ["--help"]);
  for (const command of ["init", "update", "doctor", "uninstall"]) {
    assert.match(help.stdout, new RegExp(`agentic-core ${command}`));
  }
  for (const retired of ["start", "resume", "approve-mode-change", "submit-handoff"]) {
    assert.doesNotMatch(help.stdout, new RegExp(`agentic-core ${retired}`));
  }
});

test("the quality CLI exposes independent checks and QualitySession without model JSON", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const version = await runBinary("bin/agentic-quality.js", ["--version"]);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await runBinary("bin/agentic-quality.js", ["--help"]);
  for (const command of ["scan", "crap", "mutate", "mutation", "prepare", "verify"]) {
    assert.match(help.stdout, new RegExp(`agentic-quality ${command}`));
  }
  assert.doesNotMatch(help.stdout, /--run|--input|JSON/i);
});

test("the maintenance CLI runs in a project path containing spaces", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic core "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runBinary("bin/agentic-core.js", ["--version"], { cwd: root });
  assert.equal(result.stdout.trim(), "0.2.0");
});

test("maintenance dry-run accepts only canonical options once", async () => {
  for (const args of [
    ["init", ".", "--dry-run", "--dry-run"],
    ["init", ".", "--dry-run", "--force"],
    ["update", ".", "--dry-run", "--yes"],
    ["uninstall", ".", "--dryrun"],
    ["uninstall", ".", "--dry-run", "--yes"],
    ["doctor", ".", "--dry-run", "--force"],
  ]) {
    await assert.rejects(runBinary("bin/agentic-core.js", args), (error) => {
      assert.equal(error.code, 2, args.join(" "));
      assert.match(error.stderr, /Unknown option|specified more than once/);
      return true;
    });
  }
});

test("retired orchestration commands fail without creating run state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic retired cli "));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const command of ["start", "resume", "approve-mode-change", "submit-handoff"]) {
    await assert.rejects(runBinary("bin/agentic-core.js", [command], { cwd: root }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Unknown command/);
      return true;
    });
  }
  await assert.rejects(readdir(path.join(root, ".agentic-core", "runs")), { code: "ENOENT" });
});
