import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { analyzeSource } from "../src/quality/ast.js";
import { identityFor } from "../src/quality/crap.js";
import { collectV8Coverage } from "../src/quality/coverage.js";

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

test("scan and crap require exactly one run or explicit target", async () => {
  const missing = await run(["scan"], repositoryRoot);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /Exactly one source/);
  const duplicate = await run(["crap", "--target", "src", "--run", "abc"], repositoryRoot);
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

test("--run reads persisted quality targets and limits analysis to declared symbols", async (t) => {
  const root = await fixture(t);
  const runDirectory = path.join(root, ".agentic-core", "runs", "run-1");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "state.json"), JSON.stringify({
    quality: { targets: [{ path: "src/subject.js", symbols: ["exercised"] }] },
  }));
  const result = await run(["scan", "--run", "run-1"], root);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "approved");
  assert.deepEqual(report.details.map(({ symbol }) => symbol), ["exercised"]);
});

test("--output persists the complete run C.R.A.P. report and returns its verified reference", async (t) => {
  const root = await fixture(t);
  const runDirectory = path.join(root, ".agentic-core", "runs", "artifact-run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "state.json"), JSON.stringify({
    quality: { targets: [{ path: "src/subject.js", symbols: ["exercised"] }] },
  }));

  const result = await run([
    "crap", "--run", "artifact-run", "--output", "artifacts/crap.json",
  ], root);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const reference = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(reference), ["path", "sha256"]);
  assert.equal(reference.path, "artifacts/crap.json");
  assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  const content = await readFile(path.join(runDirectory, "artifacts", "crap.json"));
  assert.equal(createHash("sha256").update(content).digest("hex"), reference.sha256);
  const report = JSON.parse(content);
  assert.equal(report.tool, "crap");
  assert.equal(report.status, "approved");

  const production = await readFile(path.join(root, "src", "subject.js"), "utf8");
  const escaped = await run([
    "crap", "--run", "artifact-run", "--output", "../../src/report.json",
  ], root);
  assert.equal(escaped.code, 4);
  assert.equal(await readFile(path.join(root, "src", "subject.js"), "utf8"), production);
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

test("explicit symbol selection that resolves nothing is an error", async (t) => {
  const root = await fixture(t);
  const runDirectory = path.join(
    root, ".agentic-core", "runs", "missing-symbol",
  );
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "state.json"), JSON.stringify({
    quality: {
      targets: [{ path: "src/subject.js", symbols: ["doesNotExist"] }],
    },
  }));
  const result = await run(["crap", "--run", "missing-symbol"], root);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /resolved no quality targets/i);
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

test("differential CRAP preserves high debt and rejects regression from seven", async (t) => {
  const highRoot = await fixture(t);
  const highBaseline = JSON.parse((
    await run(["crap", "--target", "src/subject.js"], highRoot)
  ).stdout);
  const highRun = path.join(
    highRoot, ".agentic-core", "runs", "high-baseline",
  );
  await mkdir(highRun, { recursive: true });
  await writeFile(path.join(highRun, "state.json"), JSON.stringify({
    quality: {
      targets: [{ path: "src/subject.js", symbols: ["uncovered"] }],
      baselineReport: highBaseline,
    },
  }));
  const inherited = await run(
    ["crap", "--run", "high-baseline"], highRoot,
  );
  assert.equal(inherited.code, 0, inherited.stderr || inherited.stdout);
  const inheritedDetail = JSON.parse(inherited.stdout).details[0];
  assert.ok(inheritedDetail.current.crap > 7);
  assert.equal(inheritedDetail.delta, 0);
  assert.equal(
    inheritedDetail.rule,
    "existing_above_seven_must_not_worsen",
  );

  const lowRoot = await fixture(t);
  const lowBaseline = JSON.parse((
    await run(["crap", "--target", "src/subject.js"], lowRoot)
  ).stdout);
  const sourcePath = path.join(lowRoot, "src", "subject.js");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(
    sourcePath,
    source.replace(
      "if (value === 6) value += 1;",
      "if (value === 6) value += 1;\n  if (value === 7) value += 1;",
    ),
  );
  const lowRun = path.join(
    lowRoot, ".agentic-core", "runs", "low-baseline",
  );
  await mkdir(lowRun, { recursive: true });
  await writeFile(path.join(lowRun, "state.json"), JSON.stringify({
    quality: {
      targets: [{ path: "src/subject.js", symbols: ["boundary"] }],
      baselineReport: lowBaseline,
    },
  }));
  const regressed = await run(
    ["crap", "--run", "low-baseline"], lowRoot,
  );
  assert.equal(regressed.code, 1);
  const detail = JSON.parse(regressed.stdout).details[0];
  assert.equal(detail.baseline.crap, 7);
  assert.ok(detail.current.crap > 7);
  assert.ok(detail.delta > 0);
});

test("new symbols use seven and missing baselines never invent zero", async (t) => {
  const root = await fixture(t);
  const baseline = JSON.parse((
    await run(["crap", "--target", "src/subject.js"], root)
  ).stdout);
  const sourcePath = path.join(root, "src", "subject.js");
  await writeFile(
    sourcePath,
    `${await readFile(sourcePath, "utf8")}
export function added(value) { return value; }
`,
  );
  const newRun = path.join(
    root, ".agentic-core", "runs", "new-symbol",
  );
  await mkdir(newRun, { recursive: true });
  await writeFile(path.join(newRun, "state.json"), JSON.stringify({
    quality: {
      targets: [{ path: "src/subject.js", symbols: ["added"] }],
      baselineReport: baseline,
    },
  }));
  const added = await run(["crap", "--run", "new-symbol"], root);
  assert.equal(added.code, 0, added.stderr || added.stdout);
  const addedDetail = JSON.parse(added.stdout).details[0];
  assert.equal(addedDetail.baseline.status, "new_symbol");
  assert.equal(addedDetail.rule, "new_symbol_at_or_below_seven");

  const unknownRun = path.join(
    root, ".agentic-core", "runs", "unknown-baseline",
  );
  await mkdir(unknownRun, { recursive: true });
  await writeFile(path.join(unknownRun, "state.json"), JSON.stringify({
    quality: {
      targets: [{ path: "src/subject.js", symbols: ["uncovered"] }],
      baselineReport: {
        details: [],
        inputInventory: { entries: [] },
      },
    },
  }));
  const unknown = await run(
    ["crap", "--run", "unknown-baseline"], root,
  );
  assert.equal(unknown.code, 0, unknown.stderr || unknown.stdout);
  const unknownDetail = JSON.parse(unknown.stdout).details[0];
  assert.equal(unknownDetail.baseline.status, "not_attributable");
  assert.equal(unknownDetail.delta, null);
  assert.notEqual(unknownDetail.baseline.crap, 0);
});
