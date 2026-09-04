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
const generousMutantTimeoutMs = 10_000;
const suiteDurationMs = 250;

const manifest = {
  type: "module",
  scripts: { test: "node --test" },
};

// Two covered mutants with opposite fates once they are given time to run:
// `> -> >=` survives, because the suite never asserts the boundary value,
// and `0 -> 1` is a real semantic kill.
const mutableSubject = `
export function isPositive(value) {
  return value > 0;
}
`;

// The project's own suite passes and outlasts the time tolerated per mutant.
// The delay is unconditional: it is the suite that is slow, not the mutation.
const slowSuite = `
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { isPositive } from "../src/subject.js";

test("passes, but slower than the time tolerated per mutant", async () => {
  await delay(Number.parseInt(process.env.FIXTURE_SUITE_DURATION_MS, 10));
  assert.equal(isPositive(1), true);
  assert.equal(isPositive(-1), false);
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

async function runMutation(root, mutantTimeout) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    AGENTIC_CORE_OUTPUT: "json",
    AGENTIC_CORE_TEST_MUTANT_TIMEOUT_MS: String(mutantTimeout),
    FIXTURE_SUITE_DURATION_MS: String(suiteDurationMs),
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

test("PR-05: mutation approves when the suite outlasts the time tolerated per mutant", async (t) => {
  const slowRoot = await createFixtureProject(t, slowSuite);
  const timedOut = await runMutation(slowRoot, mutantTimeoutMs);
  assert.equal(timedOut.code, 0, timedOut.stderr || timedOut.stdout);
  const timedOutReport = JSON.parse(timedOut.stdout);

  // This characterizes PR-05. When MJ-05 closes, invert this assertion:
  // timeouts must be inconclusive and can never make mutation approved.
  assert.equal(timedOutReport.status, "approved");
  assert.deepEqual(timedOutReport.summary, {
    mutants: 2,
    killed: 0,
    killedByTimeout: 2,
    survived: 0,
    uncovered: 0,
    equivalent: 0,
  });
  assert.deepEqual(timedOutReport.details.map(({ status }) => status),
    ["killedByTimeout", "killedByTimeout"]);

  // Same project, same suite, same mutants: only the tolerated time changes.
  // The approval above hid a real survivor, so a timeout is evidence of
  // nothing -- and the count of timeouts never reaches the verdict either.
  const generous = await runMutation(slowRoot, generousMutantTimeoutMs);
  assert.equal(generous.code, 1, generous.stderr || generous.stdout);
  const generousReport = JSON.parse(generous.stdout);
  assert.equal(generousReport.status, "failed");
  assert.deepEqual(generousReport.summary, {
    mutants: 2,
    killed: 1,
    killedByTimeout: 0,
    survived: 1,
    uncovered: 0,
    equivalent: 0,
  });
  assert.deepEqual(generousReport.details.map(({ mutation, status }) => ({ mutation, status })), [
    { mutation: "> -> >=", status: "survived" },
    { mutation: "0 -> 1", status: "killed" },
  ]);

  const uncoveredRoot = await createFixtureProject(t, unrelatedSuite);
  const uncovered = await runMutation(uncoveredRoot, generousMutantTimeoutMs);
  assert.equal(uncovered.code, 1, uncovered.stderr || uncovered.stdout);
  const uncoveredReport = JSON.parse(uncovered.stdout);

  // PR-05 also makes uncovered mutants fail the complete gate. When MJ-05
  // closes, uncovered mutants become informational and score/budget decide it.
  assert.equal(uncoveredReport.status, "failed");
  assert.deepEqual(uncoveredReport.summary, {
    mutants: 2,
    killed: 0,
    killedByTimeout: 0,
    survived: 0,
    uncovered: 2,
    equivalent: 0,
  });
  assert.deepEqual(uncoveredReport.details.map(({ status }) => status), ["uncovered", "uncovered"]);
});
