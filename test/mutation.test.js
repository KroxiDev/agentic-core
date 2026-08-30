import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { generateMutants } from "../src/quality/mutation.js";
import { findPython, generatePythonMutants } from "../src/quality/python.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const qualityCli = path.join(repositoryRoot, "bin", "agentic-quality.js");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t, {
  source = `export function choose(value) {
  if (value > 0) return true;
  return false;
}
`,
  tests = `import assert from "node:assert/strict";
import test from "node:test";
import { choose } from "../src/subject.js";
test("positive value", () => assert.equal(choose(1), true));
`,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic mutation "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "node --test" },
  }));
  await writeFile(path.join(root, "src", "subject.js"), source);
  await writeFile(path.join(root, "test", "subject.test.js"), tests);
  return root;
}
async function pythonFixture(t, {
  source = `def choose(value):
    if value > 0:
        return True
    return False

def uncovered(value):
    return value + 0
`,
  tests = `import unittest
from src.subject import choose

class SubjectTest(unittest.TestCase):
    def test_positive(self):
        self.assertTrue(choose(1))
`,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic python mutation "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "src", "subject.py"), source);
  await writeFile(path.join(root, "tests", "test_subject.py"), tests);
  return root;
}
async function run(args, cwd, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [qualityCli, ...args], { cwd, encoding: "utf8", ...options });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("the JavaScript and TypeScript catalogue emits every required valid mutation category", () => {
  const source = `type Flag = boolean;
export function catalogue(a: number, b: number) {
  const enabled = true;
  const missing = null;
  const label = "value";
  const zero = 0;
  return !enabled && (a === b || a >= b) ? a + zero : label ?? missing;
}
`;
  const mutants = generateMutants("subject.ts", source);
  assert.deepEqual(new Set(mutants.map(({ category }) => category)), new Set([
    "boolean", "null", "constant", "unary", "logical", "equality", "comparison", "arithmetic",
  ]));
  assert.equal(mutants.every(({ symbol }) => symbol === "catalogue"), true);
});

test("the Python catalogue emits every required valid mutation category", async (t) => {
  const root = await pythonFixture(t, {
    source: `def catalogue(a, b):
    enabled = True
    missing = None
    label = "value"
    zero = 0
    return not enabled and (a is b or a == b or a >= b) and a + zero
`,
  });
  const runtime = await findPython(root);
  if (!runtime) return t.skip("Python 3.10 or newer is unavailable");
  const filePath = path.join(root, "src", "subject.py");
  const mutants = await generatePythonMutants(runtime, root, filePath, "src/subject.py");
  assert.deepEqual(new Set(mutants.map(({ category }) => category)), new Set([
    "boolean", "identity", "null", "constant", "unary", "logical", "equality", "comparison", "arithmetic",
  ]));
  assert.equal(mutants.every(({ symbol }) => symbol === "catalogue"), true);
});

test("Python mutate shares mutation states and leaves the working tree untouched", async (t) => {
  const root = await pythonFixture(t);
  await mkdir(path.join(root, "src", "generated"));
  await writeFile(path.join(root, "src", "generated", "client.py"), "def generated(): return True\n");
  await writeFile(path.join(root, "src", "client_generated.py"), "def generated_too(): return False\n");
  await writeFile(path.join(root, "src", "setup.py"), "def manifest(): return True\n");
  const sourcePath = path.join(root, "src", "subject.py");
  const before = sha256(await readFile(sourcePath));
  const result = await run(["mutate", "--target", "src"], root);
  if (/Python 3\.10/i.test(result.stdout)) return t.skip(result.stdout);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.language, "python");
  assert.match(report.backend, /^python-ast-(?:coverage\.py|stdlib-trace)$/);
  assert.equal(report.runner, "unittest");
  assert.ok(report.summary.killed > 0);
  assert.ok(report.summary.survived > 0);
  assert.ok(report.summary.uncovered > 0);
  assert.ok(report.hashes.baseline);
  assert.equal(report.restoration.workingTreeUntouched, true);
  assert.equal(sha256(await readFile(sourcePath)), before);
  assert.deepEqual(new Set(report.details.map(({ file }) => file)), new Set(["src/subject.py"]));
});

test("Python mutation distinguishes baseline and mutant timeouts", async (t) => {
  const baselineRoot = await pythonFixture(t, { tests: "while True: pass\n" });
  const baseline = await run(["mutate", "--target", "src/subject.py"], baselineRoot, {
    env: { ...process.env, NODE_ENV: "test", AGENTIC_CORE_TEST_BASELINE_TIMEOUT_MS: "100" },
  });
  assert.equal(baseline.code, 3, baseline.stderr || baseline.stdout);
  assert.equal(JSON.parse(baseline.stdout).status, "baseline_failed");

  const mutantRoot = await pythonFixture(t, {
    source: `def countdown(value):
    while value < 0:
        value -= 1
    return value
`,
    tests: `import unittest
from src.subject import countdown

class SubjectTest(unittest.TestCase):
    def test_zero(self):
        self.assertEqual(countdown(0), 0)
`,
  });
  const mutant = await run(["mutate", "--target", "src/subject.py"], mutantRoot, {
    env: { ...process.env, NODE_ENV: "test", AGENTIC_CORE_TEST_MUTANT_TIMEOUT_MS: "100" },
  });
  assert.equal(mutant.code, 1, mutant.stderr || mutant.stdout);
  assert.ok(JSON.parse(mutant.stdout).summary.killedByTimeout > 0);
});

test("Python --run limits mutation to declared symbols", async (t) => {
  const root = await pythonFixture(t, {
    source: `def chosen(value):
    return value + 0

def ignored(value):
    return value == 2
`,
    tests: `import unittest
from src.subject import chosen, ignored

class SubjectTest(unittest.TestCase):
    def test_subjects(self):
        self.assertEqual(chosen(1), 1)
        self.assertEqual(chosen(0), 0)
        self.assertTrue(ignored(2))
        self.assertFalse(ignored(0))
`,
  });
  const runDirectory = path.join(root, ".agentic-core", "runs", "run-1");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "state.json"), JSON.stringify({
    quality: { targets: [{ path: "src/subject.py", symbols: ["chosen"] }] },
  }));
  const result = await run(["mutate", "--run", "run-1"], root);
  assert.ok([0, 1].includes(result.code), result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.details.length > 0);
  assert.deepEqual(new Set(report.details.map(({ symbol }) => symbol)), new Set(["chosen"]));
});

test("Python mutation reports an unavailable interpreter explicitly", async (t) => {
  const root = await pythonFixture(t);
  const result = await run(["mutate", "--target", "src/subject.py"], root, {
    env: { ...process.env, AGENTIC_CORE_PYTHON: path.join(root, "missing-python") },
  });
  assert.equal(result.code, 2, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "unsupported_environment");
  assert.equal(report.backend, "unavailable");
});

test("Python mutation executes pytest when the project declares it", async (t) => {
  const root = await pythonFixture(t, {
    tests: `import pytest
from src.subject import choose

def test_choose():
    assert choose(1) is True
`,
  });
  const result = await run(["mutate", "--target", "src/subject.py"], root);
  if (result.code === 2 && /pytest runner is unavailable/i.test(result.stdout)) return t.skip("pytest is unavailable");
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).runner, "pytest");
});

test("mutate reports survived and uncovered mutants and never changes the working tree", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "src", "generated"));
  await writeFile(path.join(root, "src", "generated", "client.js"), "export function generated() { return true; }\n");
  await writeFile(path.join(root, "src", "client.generated.js"), "export function alsoGenerated() { return false; }\n");
  const sourcePath = path.join(root, "src", "subject.js");
  const before = sha256(await readFile(sourcePath));
  const result = await run(["mutate", "--target", "src"], root);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.tool, "mutation");
  assert.equal(report.status, "failed");
  assert.equal(report.runner, "node:test");
  assert.ok(report.summary.survived > 0);
  assert.ok(report.summary.uncovered > 0);
  assert.ok(report.summary.killed > 0);
  assert.ok(report.hashes.baseline);
  assert.equal(report.restoration.workingTreeUntouched, true);
  assert.equal(sha256(await readFile(sourcePath)), before);
  assert.equal(report.details.every(({ file }) => file === "src/subject.js"), true);
});

test("a failed baseline invalidates mutation analysis with its stable exit code", async (t) => {
  const root = await fixture(t, {
    tests: `import assert from "node:assert/strict";
import test from "node:test";
test("broken baseline", () => assert.fail("baseline"));
`,
  });
  const result = await run(["mutate", "--target", "src/subject.js"], root);
  assert.equal(result.code, 3, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "baseline_failed");
  assert.equal(report.summary.mutants, 0);
  assert.deepEqual(report.details, []);
});

test("an exhausted baseline also invalidates the complete analysis", async (t) => {
  const root = await fixture(t, { tests: "while (true) {}\n" });
  const result = await run(["mutate", "--target", "src/subject.js"], root, {
    env: { ...process.env, NODE_ENV: "test", AGENTIC_CORE_TEST_BASELINE_TIMEOUT_MS: "100" },
  });
  assert.equal(result.code, 3, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "baseline_failed");
});

test("a mutant timeout is distinguished as killedByTimeout", async (t) => {
  const root = await fixture(t, {
    source: `export function countdown(value) {
  while (value < 0) value -= 1;
  return value;
}
`,
    tests: `import assert from "node:assert/strict";
import test from "node:test";
import { countdown } from "../src/subject.js";
test("zero", () => assert.equal(countdown(0), 0));
`,
  });
  const result = await run(["mutate", "--target", "src/subject.js"], root, {
    env: { ...process.env, NODE_ENV: "test", AGENTIC_CORE_TEST_MUTANT_TIMEOUT_MS: "100" },
  });
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.ok(JSON.parse(result.stdout).summary.killedByTimeout > 0);
});

test("--run applies differential symbol selection", async (t) => {
  const root = await fixture(t, {
    source: `export function chosen(value) { return value + 0; }
export function ignored(value) { return value === 2; }
`,
    tests: `import assert from "node:assert/strict";
import test from "node:test";
import { chosen, ignored } from "../src/subject.js";
test("subjects", () => {
  assert.equal(chosen(1), 1);
  assert.equal(chosen(0), 0);
  assert.equal(ignored(2), true);
  assert.equal(ignored(0), false);
});
`,
  });
  const source = await readFile(path.join(root, "src", "subject.js"), "utf8");
  const [equivalent] = generateMutants("src/subject.js", source, new Set(["chosen"]));
  const runDirectory = path.join(root, ".agentic-core", "runs", "run-1");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "state.json"), JSON.stringify({
    quality: {
      targets: [{ path: "src/subject.js", symbols: ["chosen"] }],
      equivalents: [{
        file: "src/subject.js",
        symbol: equivalent.symbol,
        mutation: equivalent.mutation,
        location: equivalent.location,
        reason: "Adding or subtracting zero yields the same numeric result.",
        staticProof: "For every JavaScript number x used by this symbol, x + 0 equals x - 0.",
      }],
    },
  }));
  const result = await run(["mutate", "--run", "run-1"], root);
  assert.ok([0, 1].includes(result.code), result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.details.length > 0);
  assert.deepEqual(new Set(report.details.map(({ symbol }) => symbol)), new Set(["chosen"]));
  assert.equal(report.details.find(({ id }) => id === equivalent.id).status, "equivalent");
});

test("mutation worker configuration is strictly limited to four", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, ".agentic-core"));
  await writeFile(path.join(root, ".agentic-core", "config.json"), JSON.stringify({
    quality: { mutationWorkers: 5 },
  }));
  const result = await run(["mutate", "--target", "src/subject.js"], root);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /mutationWorkers must be an integer from 1 to 4/);
});

test("a restoration failure preserves the isolated evidence and returns exit code five", async (t) => {
  const root = await fixture(t);
  const sourcePath = path.join(root, "src", "subject.js");
  const before = sha256(await readFile(sourcePath));
  const result = await run(["mutate", "--target", "src/subject.js"], root, {
    env: { ...process.env, NODE_ENV: "test", AGENTIC_CORE_TEST_FAIL_MUTANT_RESTORE: "1" },
  });
  assert.equal(result.code, 5, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "restoration_failure");
  assert.equal(report.restoration.evidencePreserved, true);
  assert.equal(report.restoration.workingTreeUntouched, true);
  assert.ok(report.restoration.evidencePath);
  assert.equal(sha256(await readFile(sourcePath)), before);
  await rm(report.restoration.evidencePath, { recursive: true, force: true });
});

test("in-run mutation evidence is ignored by later Node test discovery", async (t) => {
  const root = await fixture(t, {
    tests: `import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { choose } from "../src/subject.js";
test("runs only from the active project", () => {
  assert.equal(import.meta.dirname, path.join(process.cwd(), "test"));
  assert.equal(choose(1), true);
});
`,
  });
  const runDirectory = path.join(root, ".agentic-core", "runs", "evidence-run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "state.json"), JSON.stringify({
    quality: { targets: [{ path: "src/subject.js", symbols: ["choose"] }] },
  }));

  const mutation = await run([
    "mutate", "--run", "evidence-run", "--output", "artifacts/mutation.json",
  ], root, {
    env: { ...process.env, NODE_ENV: "test", AGENTIC_CORE_TEST_FAIL_MUTANT_RESTORE: "1" },
  });
  assert.equal(mutation.code, 5, mutation.stderr || mutation.stdout);
  const artifactDirectory = path.join(runDirectory, "artifacts");
  const report = JSON.parse(await readFile(path.join(artifactDirectory, "mutation.json"), "utf8"));
  const relativeEvidence = path.relative(artifactDirectory, report.restoration.evidencePath);
  assert.equal(relativeEvidence.startsWith("..") || path.isAbsolute(relativeEvidence), false);

  const crap = await run([
    "crap", "--run", "evidence-run", "--output", "artifacts/crap.json",
  ], root);
  assert.equal(crap.code, 0, crap.stderr || crap.stdout);
});
