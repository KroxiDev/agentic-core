import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTestProject } from "./project-builder.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceRuntime = path.join(repositoryRoot, "src", "runtime-entry.mjs");
const mutantTimeoutMs = 100;
const delayedSuiteDurationMs = 250;

const manifest = {
  type: "module",
  scripts: { test: "node --test" },
};

const mutableSubject = `
export function mutationTriggersDelay() {
  return false;
}
`;

const timeoutSuite = `
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { mutationTriggersDelay } from "../src/subject.js";

test("passes unless a mutation enables the delay", async () => {
  if (mutationTriggersDelay()) {
    await delay(Number.parseInt(process.env.FIXTURE_SUITE_DURATION_MS, 10));
  }
  assert.equal(mutationTriggersDelay(), false);
});
`;

const unrelatedSuite = `
import assert from "node:assert/strict";
import test from "node:test";

test("passes without loading the subject", () => {
  assert.equal(1 + 1, 2);
});
`;

async function createFixtureProject(t, suite) {
  return createTestProject(t, {
    manifest,
    files: {
      "src/subject.js": mutableSubject,
      "test/subject.test.js": suite,
    },
  });
}

async function runMutation(root) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    AGENTIC_CORE_OUTPUT: "json",
    AGENTIC_CORE_TEST_MUTANT_TIMEOUT_MS: String(mutantTimeoutMs),
    FIXTURE_SUITE_DURATION_MS: String(delayedSuiteDurationMs),
  };
  try {
    const result = await execFileAsync(process.execPath, [
      sourceRuntime,
      "agentic-quality",
      "mutate",
      "--target",
      "src/subject.js",
    ], { cwd: root, env, encoding: "utf8", windowsHide: true });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("PR-05: mutation approves when every covered mutant exhausts its timeout", async (t) => {
  const timeoutRoot = await createFixtureProject(t, timeoutSuite);
  const timeoutResult = await runMutation(timeoutRoot);
  assert.equal(timeoutResult.code, 0, timeoutResult.stderr || timeoutResult.stdout);
  const timeoutReport = JSON.parse(timeoutResult.stdout);

  // This characterizes PR-05. When MJ-05 closes, invert this assertion:
  // timeouts must be inconclusive and can never make mutation approved.
  assert.equal(timeoutReport.status, "approved");
  assert.deepEqual(timeoutReport.summary, {
    mutants: 1,
    killed: 0,
    killedByTimeout: 1,
    survived: 0,
    uncovered: 0,
    equivalent: 0,
  });
  assert.deepEqual(timeoutReport.details.map(({ status }) => status), ["killedByTimeout"]);

  const uncoveredRoot = await createFixtureProject(t, unrelatedSuite);
  const uncoveredResult = await runMutation(uncoveredRoot);
  assert.equal(uncoveredResult.code, 1, uncoveredResult.stderr || uncoveredResult.stdout);
  const uncoveredReport = JSON.parse(uncoveredResult.stdout);

  // PR-05 also makes one uncovered mutant fail the complete gate. When MJ-05
  // closes, uncovered mutants become informational and score/budget decide it.
  assert.equal(uncoveredReport.status, "failed");
  assert.deepEqual(uncoveredReport.summary, {
    mutants: 1,
    killed: 0,
    killedByTimeout: 0,
    survived: 0,
    uncovered: 1,
    equivalent: 0,
  });
  assert.deepEqual(uncoveredReport.details.map(({ status }) => status), ["uncovered"]);
});
