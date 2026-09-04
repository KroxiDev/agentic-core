import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { findPython } from "../src/quality/python.js";
import { createTestProject } from "./project-builder.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceRuntime = path.join(repositoryRoot, "src", "runtime-entry.mjs");

const javaScriptProject = {
  manifest: {
    type: "module",
    scripts: { test: "node --test" },
  },
  files: {
    "src/procedural-subject.js": `
const mode = process.env.PROCEDURAL_MODE === "strict" ? "strict" : "safe";
const policies = [
  { name: " Core Access ", active: true, requiresReview: true, weight: 3 },
  { name: " Legacy Access ", active: false, requiresReview: true, weight: 5 },
  { name: " Fallback Access ", active: true, requiresReview: false, weight: 2 },
];

export const enabledPolicies = [];
export let riskScore = 0;

for (const policy of policies) {
  if (!policy.active) continue;
  const normalized = policy.name.trim().toLowerCase().replaceAll(" ", "-");
  enabledPolicies.push(normalized);
  if (policy.requiresReview && policy.weight >= 3) riskScore += policy.weight * 2;
  else if (policy.weight > 1) riskScore += policy.weight;
  else riskScore += 1;
}

if (mode === "strict" && enabledPolicies.length < 2) {
  throw new Error("Strict mode requires two active policies");
}

export const route = enabledPolicies.join(" -> ").toUpperCase();
export const outcome = riskScore > 5 ? "manual-review" : "automatic";
`,
    "test/procedural-subject.test.js": `
import assert from "node:assert/strict";
import test from "node:test";
import {
  enabledPolicies,
  outcome,
  riskScore,
  route,
} from "../src/procedural-subject.js";

test("evaluates the procedural policy table", () => {
  assert.deepEqual(enabledPolicies, ["core-access", "fallback-access"]);
  assert.equal(riskScore, 8);
  assert.equal(route, "CORE-ACCESS -> FALLBACK-ACCESS");
  assert.equal(outcome, "manual-review");
});
`,
  },
};

const pythonProject = {
  files: {
    "src/__init__.py": "",
    "src/procedural_subject.py": `
import os

mode = "strict" if os.environ.get("PROCEDURAL_MODE") == "strict" else "safe"
policies = (
    {"name": " Core Access ", "active": True, "requires_review": True, "weight": 3},
    {"name": " Legacy Access ", "active": False, "requires_review": True, "weight": 5},
    {"name": " Fallback Access ", "active": True, "requires_review": False, "weight": 2},
)

enabled_policies = []
risk_score = 0

for policy in policies:
    if not policy["active"]:
        continue
    normalized = policy["name"].strip().lower().replace(" ", "-")
    enabled_policies.append(normalized)
    if policy["requires_review"] and policy["weight"] >= 3:
        risk_score += policy["weight"] * 2
    elif policy["weight"] > 1:
        risk_score += policy["weight"]
    else:
        risk_score += 1

if mode == "strict" and len(enabled_policies) < 2:
    raise RuntimeError("Strict mode requires two active policies")

route = " -> ".join(enabled_policies).upper()
outcome = "manual-review" if risk_score > 5 else "automatic"
`,
    "tests/test_procedural_subject.py": `
import unittest

from src.procedural_subject import enabled_policies, outcome, risk_score, route


class ProceduralSubjectTests(unittest.TestCase):
    def test_evaluates_the_procedural_policy_table(self):
        self.assertEqual(enabled_policies, ["core-access", "fallback-access"])
        self.assertEqual(risk_score, 8)
        self.assertEqual(route, "CORE-ACCESS -> FALLBACK-ACCESS")
        self.assertEqual(outcome, "manual-review")
`,
  },
};

async function runCrap(root, target) {
  const env = {
    ...process.env,
    AGENTIC_CORE_OUTPUT: "json",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  try {
    const result = await execFileAsync(process.execPath, [
      sourceRuntime,
      "agentic-quality",
      "crap",
      "--target",
      target,
    ], { cwd: root, env, encoding: "utf8", windowsHide: true });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

// This characterizes PR-17. When MJ-13 closes, invert both characterizations
// below: each procedural file must expose a measured <module> symbol and a
// measured verdict; move the zero-symbol warning expectation to a truly empty
// scope.
function assertSilentNotApplicable(result, {
  backends,
  language,
  runner,
  target,
}) {
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);

  assert.equal(report.status, "not_applicable");
  assert.equal(report.language, language);
  assert.ok(
    backends.includes(report.backend),
    `Unexpected ${language} backend: ${report.backend}`,
  );
  assert.equal(report.runner, runner);
  assert.deepEqual(report.targets, [target]);
  assert.equal(report.summary.symbols, 0);
  assert.equal(report.summary.approved, 0);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.maximumCrap, null);
  assert.deepEqual(report.summary.unsupportedFiles, []);
  assert.equal(report.summary.baselineWarnings, 0);
  assert.deepEqual(report.details, []);
  assert.deepEqual(
    Object.keys(report).filter((key) => /^warnings?$/i.test(key)),
    [],
  );
  assert.deepEqual(
    Object.keys(report.summary).filter((key) => /^warnings?$/i.test(key)),
    [],
  );
}

test("PR-17: a JavaScript procedural file passes silently without any measured symbol", async (t) => {
  const root = await createTestProject(t, javaScriptProject);
  const result = await runCrap(root, "src/procedural-subject.js");

  assertSilentNotApplicable(result, {
    backends: ["v8"],
    language: "javascript-typescript",
    runner: "node:test",
    target: "src/procedural-subject.js",
  });
});

// The Python backend shares the defect, so it is characterized on its own test:
// an unavailable interpreter must show up as a skip, never as a silent pass.
test("PR-17: a Python procedural file passes silently without any measured symbol", async (t) => {
  const root = await createTestProject(t, pythonProject);
  if (!await findPython(root)) return t.skip("Python 3.10 or newer is unavailable");

  const result = await runCrap(root, "src/procedural_subject.py");

  assertSilentNotApplicable(result, {
    backends: ["coverage.py", "stdlib-trace"],
    language: "python",
    runner: "unittest",
    target: "src/procedural_subject.py",
  });
});
