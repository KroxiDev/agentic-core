import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { analyzeSource } from "../src/quality/ast.js";
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
async function run(args, cwd) {
  try {
    const result = await execFileAsync(process.execPath, [qualityCli, ...args], { cwd, encoding: "utf8" });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
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
