import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { analyzeSource } from "../src/quality/ast.js";
import { analyzeQuality, identityFor } from "../src/quality/crap.js";
import { collectV8Coverage, runnerInvocation } from "../src/quality/coverage.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const qualityCli = path.join(repositoryRoot, "bin", "agentic-quality.js");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic quality "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "node --test" },
  }));
  await writeFile(path.join(root, "src", "subject.js"), `
export function exercised(value) {
  if (value > 0) {
    return "positive";
  }
  return "other";
}
export function boundary(value) {
  if (value === 1) value += 1;
  if (value === 2) value += 1;
  if (value === 3) value += 1;
  if (value === 4) value += 1;
  if (value === 5) value += 1;
  if (value === 6) value += 1;
  return value;
}
export function uncovered(left, right) {
  if (left && right) {
    return left;
  }
  return right;
}
`);
  await writeFile(path.join(root, "test", "subject.test.js"), `
import assert from "node:assert/strict";
import test from "node:test";
import { boundary, exercised } from "../src/subject.js";
test("exercises both outcomes", () => {
  assert.equal(exercised(1), "positive");
  assert.equal(exercised(0), "other");
  assert.equal(boundary(0), 0);
});
`);
  return root;
}
async function run(args, cwd, env = process.env) {
  try {
    const result = await execFileAsync(process.execPath, [qualityCli, ...args], { cwd, env, encoding: "utf8" });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("Jest and Vitest invocations exclude preserved agentic-core evidence", () => {
  const root = path.resolve("fixture");
  const vitest = runnerInvocation(root, { devDependencies: { vitest: "1.0.0" } });
  assert.deepEqual(vitest.args.slice(-3), ["run", "--exclude", "**/.agentic-core/**"]);
  const jest = runnerInvocation(root, { devDependencies: { jest: "29.0.0" } });
  assert.equal(jest.args.at(-2), "--runInBand");
  assert.equal(jest.args.some((argument) => argument.startsWith("--testPathIgnorePatterns")), false);
  const activeProjectTest = new RegExp(jest.args.at(-1));
  assert.equal(activeProjectTest.test(path.join(root, "test", "subject.test.js")), true);
  assert.equal(activeProjectTest.test(path.join(root, ".agentic-core", "runs", "evidence", "subject.test.js")), false);
  assert.equal(activeProjectTest.test(".agentic-core/runs/evidence/subject.test.js"), false);

  const workerRoot = path.join(root, ".agentic-core", "runs", "evidence", "worker-0");
  const workerJest = runnerInvocation(workerRoot, { devDependencies: { jest: "29.0.0" } });
  const activeWorkerTest = new RegExp(workerJest.args.at(-1));
  assert.equal(activeWorkerTest.test(path.join(workerRoot, "test", "subject.test.js")), true);
  assert.equal(activeWorkerTest.test(path.join(workerRoot, ".agentic-core", "runs", "nested.test.js")), false);
});

async function pythonFixture(t, testSource) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic python quality "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "src", "subject.py"), `
def exercised(value):
    if value > 0:
        return "positive"
    return "other"

def boundary(value):
    if value == 1: value += 1
    if value == 2: value += 1
    if value == 3: value += 1
    if value == 4: value += 1
    if value == 5: value += 1
    if value == 6: value += 1
    return value

def uncovered(left, right):
    if left and right:
        return left
    return right
`);
  await writeFile(path.join(root, "tests", "test_subject.py"), testSource ?? `
import unittest
from src.subject import boundary, exercised

class SubjectTest(unittest.TestCase):
    def test_exercises_both_outcomes(self):
        self.assertEqual(exercised(1), "positive")
        self.assertEqual(exercised(0), "other")
        self.assertEqual(boundary(0), 0)
`);
  return root;
}

test("TypeScript AST analysis matches JavaScript decisions and excludes type-only declarations", () => {
  const javascript = analyzeSource("subject.js", "function choose(a, b) { if (a && b) return a; return b; }");
  const typescript = analyzeSource("subject.ts", "type Pair = [number, number];\nfunction choose(a: number, b: number): number { if (a && b) return a; return b; }");
  assert.equal(javascript[0].complexity, 3);
  assert.equal(typescript[0].complexity, 3);
  assert.equal(typescript.length, 1);
});

test("crap reports attributable zero coverage and fails above threshold seven", async (t) => {
  const root = await fixture(t);
  const result = await run(["crap", "--target", "src/subject.js"], root);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.backend, "v8");
  assert.equal(report.runner, "node:test");
  assert.equal(report.status, "failed");
  assert.ok(report.hashes.inputs["src/subject.js"]);
  assert.ok(report.hashes.configuration);
  const boundary = report.details.find(({ symbol }) => symbol === "boundary");
  assert.equal(boundary.crap, 7);
  assert.equal(boundary.status, "approved");
  const uncovered = report.details.find(({ symbol }) => symbol === "uncovered");
  assert.equal(uncovered.coverage.percentage, 0);
  assert.ok(uncovered.crap > 7);
  assert.equal(uncovered.status, "failed");
});

test("scan and crap require exactly one explicit target", async () => {
  const missing = await run(["scan"], repositoryRoot);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /Exactly one --target/);
  const duplicate = await run(["crap", "--target", "src", "--target", "test"], repositoryRoot);
  assert.equal(duplicate.code, 4);
});

test("a target with no attributable coverage is unsupported rather than zero", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "src", "unused.js"), "export function unused() { return 1; }\n");
  const result = await run(["scan", "--target", "src/unused.js"], root);
  assert.equal(result.code, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "unsupported_environment");
  assert.deepEqual(report.summary.unsupportedFiles, ["src/unused.js"]);
})

test("source maps attribute transformed V8 ranges to the original TypeScript symbol", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic source map "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetPath = path.join(root, "subject.ts");
  const generatedPath = path.join(root, "subject.js");
  const source = "export function add(left: number, right: number) { return left + right; }\n";
  const generated = "export function add(left, right) { return left + right; }\n";
  await writeFile(targetPath, source);
  await writeFile(path.join(root, "coverage.json"), JSON.stringify({
    result: [{
      url: pathToFileURL(generatedPath).href,
      functions: [{ ranges: [{ startOffset: 0, endOffset: generated.length, count: 1 }] }],
    }],
    "source-map-cache": {
      [pathToFileURL(generatedPath).href]: {
        lineLengths: [generated.trimEnd().length],
        data: { version: 3, sources: [pathToFileURL(targetPath).href], names: [], mappings: "AAAA" },
      },
    },
  }));
  const result = await collectV8Coverage(root, [{ path: targetPath, source }]);
  const key = path.resolve(targetPath).toLowerCase();
  assert.equal(result.attributable.has(key), true);
  assert.equal(result.coveredByFile.get(key).has(1), true);
});

test("Python AST and unittest coverage preserve the common CRAP report contract", async (t) => {
  const root = await pythonFixture(t);
  const result = await run(["crap", "--target", "src/subject.py"], root);
  if (/Python 3\.10/i.test(result.stderr)) return t.skip(result.stderr);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.language, "python");
  assert.match(report.backend, /^(?:coverage\.py|stdlib-trace)$/);
  assert.equal(report.runner, "unittest");
  assert.ok(report.hashes.inputs["src/subject.py"]);
  const boundary = report.details.find(({ symbol }) => symbol === "boundary");
  assert.equal(boundary.complexity, 7);
  assert.equal(boundary.crap, 7);
  assert.equal(boundary.status, "approved");
  const uncovered = report.details.find(({ symbol }) => symbol === "uncovered");
  assert.equal(uncovered.complexity, 3);
  assert.equal(uncovered.coverage.percentage, 0);
  assert.equal(uncovered.status, "failed");
});

test("Python falls back to the standard-library tracer without installing dependencies", async (t) => {
  const root = await pythonFixture(t);
  const env = { ...process.env, AGENTIC_CORE_PYTHON_BACKEND: "trace" };
  const result = await run(["scan", "--target", "src/subject.py"], root, env);
  if (/Python 3\.10/i.test(result.stderr)) return t.skip(result.stderr);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.backend, "stdlib-trace");
  assert.equal(report.runner, "unittest");
});

test("pytest is selected when the project explicitly uses it", async (t) => {
  const root = await pythonFixture(t, `
import pytest
from src.subject import exercised

def test_exercised():
    assert exercised(1) == "positive"
    assert exercised(0) == "other"
`);
  const result = await run(["scan", "--target", "src/subject.py"], root);
  if (/Python 3\.10/i.test(result.stderr) || /No module named pytest/i.test(result.stderr)) return t.skip(result.stderr);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runner, "pytest");
  assert.equal(report.status, "failed");
  assert.deepEqual(report.summary.unsupportedFiles, []);
});

test("missing Python is explicit and does not affect JavaScript quality", async (t) => {
  const pythonRoot = await pythonFixture(t);
  const env = { ...process.env, AGENTIC_CORE_PYTHON: path.join(pythonRoot, "missing-python") };
  const unsupported = await run(["scan", "--target", "src/subject.py"], pythonRoot, env);
  assert.equal(unsupported.code, 2, unsupported.stderr || unsupported.stdout);
  const report = JSON.parse(unsupported.stdout);
  assert.equal(report.status, "unsupported_environment");
  assert.equal(report.backend, "unavailable");
  assert.deepEqual(report.summary.unsupportedFiles, ["src/subject.py"]);

  const javascriptRoot = await fixture(t);
  const javascript = await run(["scan", "--target", "src/subject.js"], javascriptRoot, env);
  assert.notEqual(javascript.code, 2, javascript.stderr || javascript.stdout);
});

test("stable symbol identity ignores bodies and separates containers and homonyms", () => {
  const before = analyzeSource("src/identity.js", `
class First { same(value) { return value; } }
class Second { same(value) { return value; } }
class Overloads {
  same(value) { return value; }
  same(value, other) { return value + other; }
}
`);
  const after = analyzeSource("src/identity.js", `
class First { same(value) { return value + 1; } }
`);
  const firstBefore = before.find((symbol) =>
    symbol.qualifiedName === "First.same");
  const firstAfter = after[0];
  assert.equal(
    identityFor("src/identity.js", firstBefore).stableId,
    identityFor("src/identity.js", firstAfter).stableId,
  );
  const named = before.filter((symbol) => symbol.name === "same")
    .map((symbol) => identityFor("src/identity.js", symbol).stableId);
  assert.equal(new Set(named).size, named.length);
  assert.ok(before.every((symbol) =>
    symbol.container && symbol.declarationKind
    && symbol.qualifiedName && symbol.disambiguator));
});

test("quality freshness inventories every relevant input class", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3 }),
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: {} }),
  );
  const first = await run(["crap", "--target", "src/subject.js"], root);
  const firstReport = JSON.parse(first.stdout);
  const kinds = new Set(firstReport.inputInventory.entries
    .map((entry) => entry.kind));
  assert.deepEqual(new Set([
    "target_code",
    "discovered_test",
    "runner_configuration",
    "manifest",
    "lockfile",
  ]), kinds);
  assert.ok(firstReport.inputInventory.commands.length > 0);
  const testPath = path.join(root, "test", "subject.test.js");
  await writeFile(
    testPath,
    `${await readFile(testPath, "utf8")}\n// freshness change\n`,
  );
  const second = await run(["crap", "--target", "src/subject.js"], root);
  const secondReport = JSON.parse(second.stdout);
  assert.notEqual(
    firstReport.hashes.inputs["test/subject.test.js"],
    secondReport.hashes.inputs["test/subject.test.js"],
  );
  assert.notEqual(
    firstReport.hashes.freshness,
    secondReport.hashes.freshness,
  );
});

test("a non-attributable baseline never invents zero", async (t) => {
  const root = await fixture(t);
  const report = await analyzeQuality({
    projectRoot: root,
    targets: ["src/subject.js"],
    tool: "crap",
    baseline: {
      details: [],
      inputInventory: { entries: [] },
      declaredScopes: [],
    },
  });
  const unknown = report.details.find(({ symbol }) => symbol === "uncovered");
  assert.equal(report.status, "approved");
  assert.equal(unknown.baseline.status, "not_attributable");
  assert.equal(unknown.delta, null);
  assert.equal("crap" in unknown.baseline, false);
  assert.equal(unknown.rule, "non_blocking_missing_baseline");
});
