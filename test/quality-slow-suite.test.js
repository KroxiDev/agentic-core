import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { initialize } from "../src/init.js";
import { createTestProject } from "./project-builder.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceRuntime = path.join(repositoryRoot, "src", "runtime-entry.mjs");
const analysisTimeoutMs = 100;
const declaredSuiteDurationMs = 250;

async function runCrap(root, nodeEnv) {
  const env = {
    ...process.env,
    NODE_ENV: nodeEnv,
    AGENTIC_CORE_OUTPUT: "json",
    AGENTIC_CORE_TEST_BASELINE_TIMEOUT_MS: String(analysisTimeoutMs),
    FIXTURE_SUITE_DURATION_MS: String(declaredSuiteDurationMs),
  };
  try {
    const result = await execFileAsync(process.execPath, [
      sourceRuntime,
      "agentic-quality",
      "crap",
      "--target",
      "src",
    ], { cwd: root, env, encoding: "utf8" });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("PR-03: a passing suite above the fixed timeout aborts analysis", async (t) => {
  const root = await createTestProject(t, {
    manifest: {
      type: "module",
      scripts: { test: "node --test" },
    },
    files: {
      "src/subject.js": `
export function classify(value) {
  return value > 0 ? "positive" : "other";
}
`,
      "test/subject.test.js": `
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { classify } from "../src/subject.js";

test("eventually passes", async () => {
  await delay(Number.parseInt(process.env.FIXTURE_SUITE_DURATION_MS, 10));
  assert.equal(classify(1), "positive");
  assert.equal(classify(0), "other");
});
`,
    },
  });
  await initialize(root, { runtimeSource: null });

  const configSchema = JSON.parse(await readFile(path.join(
    root,
    ".agentic-core",
    "config.schema.json",
  ), "utf8"));
  assert.equal(configSchema.additionalProperties, false);
  assert.equal(configSchema.properties.runners, undefined);
  assert.equal(configSchema.properties.quality.additionalProperties, false);
  assert.deepEqual(
    Object.keys(configSchema.properties.quality.properties).sort(),
    ["crapThreshold", "mutationWorkers"],
  );

  const timedOut = await runCrap(root, "test");

  // This characterizes PR-03. When MJ-03 closes, replace the schema-absence
  // proof with a declared runner timeout, then invert these outcome assertions:
  // the configured limit must let the suite finish and emit a report.
  // Exit 5 is the observed behavior, although the CLI contract reserves exit
  // 3 for a failed baseline; PR-14 owns that separate classification defect.
  assert.equal(timedOut.code, 5, timedOut.stderr || timedOut.stdout);
  assert.match(timedOut.stderr, /Test command failed/);
  assert.equal(timedOut.stdout, "");

  // The override is a test-only seam, not project configuration. With the
  // same override outside NODE_ENV=test, the suite completes successfully
  // under the hard-coded 30-second production fallback.
  const productionLike = await runCrap(root, "production");
  assert.equal(productionLike.code, 0, productionLike.stderr || productionLike.stdout);
  assert.equal(JSON.parse(productionLike.stdout).status, "approved");
});
