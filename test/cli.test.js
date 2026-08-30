import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { initialize } from "../src/init.js";
import { startOrchestration } from "../src/orchestration.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function runBinary(relativePath, args = [], options = {}) {
  return execFileAsync(process.execPath, [path.join(repositoryRoot, relativePath), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
}

test("the maintenance CLI reports the packaged version and help", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));

  const version = await runBinary("bin/agentic-core.js", ["--version"]);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await runBinary("bin/agentic-core.js", ["--help"]);
  assert.match(help.stdout, /agentic-core init/);
  assert.match(help.stdout, /agentic-core start/);
});

test("the quality CLI reports the packaged version and help", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));

  const version = await runBinary("bin/agentic-quality.js", ["--version"]);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await runBinary("bin/agentic-quality.js", ["--help"]);
  assert.match(help.stdout, /agentic-quality scan/);
  assert.match(help.stdout, /agentic-quality crap/);
  assert.match(help.stdout, /agentic-quality mutation/);
});

test("the maintenance CLI runs in a project path containing spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic core "));
  const result = await runBinary("bin/agentic-core.js", ["--version"], { cwd: root });

  assert.equal(result.stdout.trim(), "0.1.0");
});

test("start activates orchestration through the public CLI and returns the runtime-selected role", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic public start "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  const request = {
    request: "Orquesta light add greeting",
    intention: {
      objective: "Add greeting",
      constraints: [],
      criteria: ["The greeting is observable"],
    },
  };
  const inputPath = path.join(root, "start.json");
  await writeFile(inputPath, JSON.stringify(request));

  const result = await runBinary("bin/agentic-core.js", ["start", "--input", inputPath], { cwd: root });
  const started = JSON.parse(result.stdout);

  assert.equal(started.mode, "light");
  assert.equal(started.brief.role.name, "Implementador");
  assert.equal(started.brief.intention.objective, request.intention.objective);
});

test("start rejects non-boolean orchestration flags instead of coercing them", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic public flags "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  const inputPath = path.join(root, "start.json");
  await writeFile(inputPath, JSON.stringify({
    request: "Orquesta light reject coercion",
    intention: {
      objective: "Reject coercion",
      constraints: [],
      criteria: ["Strings are not treated as booleans"],
    },
    changesExecutableBehavior: "false",
  }));

  await assert.rejects(
    runBinary("bin/agentic-core.js", ["start", "--input", inputPath], { cwd: root }),
    (error) => error.code === 1 && /changesExecutableBehavior must be a boolean/.test(error.stderr),
  );
});

test("submit-handoff forwards an exact response file through the public raw-response seam", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic raw seam "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "greeting.js"), "export const greeting = 'hello';\n");
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta light add greeting",
    intention: {
      objective: "Add greeting",
      constraints: [],
      criteria: ["The greeting is observable"],
    },
  });
  const response = JSON.stringify({
    schemaVersion: 1,
    status: "completed",
    summary: "implemented",
    payload: {
      findings: [],
      evidence: { red: "failed", green: "passed", refactor: "passed" },
      qualityTargets: ["src/greeting.js"],
    },
  });
  const responsePath = path.join(root, "native-response.json");
  await writeFile(responsePath, response);
  const result = await runBinary("bin/agentic-core.js", [
    "submit-handoff", "--run", started.runId, "--input", responsePath,
  ], { cwd: root });
  const submitted = JSON.parse(result.stdout);
  assert.equal(submitted.role.name, "Tester");
  assert.deepEqual(submitted.transport, {
    bytes: Buffer.byteLength(response),
    sha256: createHash("sha256").update(response).digest("hex"),
  });
});

test("submit-handoff records the exact invalid bytes before requesting a protocol retry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic raw rejection "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  const startInput = JSON.stringify({
    request: "Orquesta light reject invalid raw",
    intention: {
      objective: "Reject invalid raw",
      constraints: [],
      criteria: ["Invalid raw is rejected without repair"],
    },
  });
  const startPath = path.join(root, "start.json");
  await writeFile(startPath, startInput);
  const started = JSON.parse((await runBinary(
    "bin/agentic-core.js",
    ["start", "--input", startPath],
    { cwd: root },
  )).stdout);
  const invalid = " {\"status\":\"completed\"}";
  const invalidPath = path.join(root, "invalid-response.json");
  await writeFile(invalidPath, invalid);

  const result = await runBinary(
    "bin/agentic-core.js",
    ["submit-handoff", "--run", started.runId, "--input", invalidPath],
    { cwd: root },
  );
  const rejected = JSON.parse(result.stdout);

  assert.equal(rejected.status, "protocol_retry");
  assert.deepEqual(rejected.transport, {
    bytes: Buffer.byteLength(invalid),
    sha256: createHash("sha256").update(invalid).digest("hex"),
  });
});
