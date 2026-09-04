import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTestProject } from "./project-builder.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const qualityCli = path.join(repositoryRoot, "bin", "agentic-quality.js");
const resourcePath = "fixtures/classification-cases.json";

const subject = `
export function classify(value) {
  return value > 0 ? "positive" : "other";
}
`;

const resourceBackedSuite = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classify } from "../src/subject.js";

function casesFromFixture() {
  try {
    return JSON.parse(readFileSync(new URL("../${resourcePath}", import.meta.url), "utf8"));
  } catch {
    return [];
  }
}

test("classifies every fixture case", () => {
  const cases = casesFromFixture();
  assert.ok(cases.length > 0, "classification cases should be available");
  for (const { value, expected } of cases) {
    assert.equal(classify(value), expected);
  }
});
`;

const selfContainedSuite = `
import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "../src/subject.js";

test("classifies every inline case", () => {
  const cases = [
    { value: 1, expected: "positive" },
    { value: 0, expected: "other" },
  ];
  for (const { value, expected } of cases) {
    assert.equal(classify(value), expected);
  }
});
`;

async function createFixtureProject(t, suite) {
  return createTestProject(t, {
    manifest: {
      type: "module",
      scripts: { test: "node --test" },
    },
    files: {
      "src/subject.js": subject,
      "test/subject.test.js": suite,
      [resourcePath]: JSON.stringify([
        { value: 1, expected: "positive" },
        { value: 0, expected: "other" },
      ]),
    },
  });
}

async function runMutation(root) {
  try {
    const result = await execFileAsync(process.execPath, [
      qualityCli,
      "mutate",
      "--target",
      "src/subject.js",
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("PR-06: mutation fails its snapshot baseline when the suite requires a non-code resource", async (t) => {
  const resourceBackedRoot = await createFixtureProject(t, resourceBackedSuite);

  await execFileAsync(process.execPath, ["--test"], {
    cwd: resourceBackedRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  const resourceBackedResult = await runMutation(resourceBackedRoot);
  assert.equal(resourceBackedResult.code, 3, resourceBackedResult.stderr || resourceBackedResult.stdout);
  const resourceBackedReport = JSON.parse(resourceBackedResult.stdout);

  // This characterizes PR-06. When MJ-05 closes, invert the snapshot outcome
  // and diagnostic assertions: mutation must complete with the resource in the
  // snapshot, while any real baseline failure must identify the missing input.
  assert.equal(resourceBackedReport.status, "baseline_failed");
  assert.equal(resourceBackedReport.summary.mutants, 0);
  assert.equal(resourceBackedReport.restoration.snapshotsVerified, false);
  assert.match(resourceBackedReport.error, /Mutation snapshot baseline failed/);
  assert.doesNotMatch(JSON.stringify(resourceBackedReport), /classification-cases\.json/i);

  const selfContainedRoot = await createFixtureProject(t, selfContainedSuite);
  const selfContainedResult = await runMutation(selfContainedRoot);
  assert.equal(selfContainedResult.code, 0, selfContainedResult.stderr || selfContainedResult.stdout);
  const selfContainedReport = JSON.parse(selfContainedResult.stdout);
  assert.equal(selfContainedReport.status, "approved");
  assert.ok(selfContainedReport.summary.mutants > 0);
  assert.equal(selfContainedReport.restoration.snapshotsVerified, true);
  assert.equal(Object.hasOwn(selfContainedReport, "error"), false);
});
