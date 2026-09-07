import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { hashDirectory } from "../src/transaction.js";
import { inputHash } from "../src/quality/project-inputs.js";
import { selectIncrementalMutants } from "../src/quality/python-mutation.js";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

const parse = (result) => JSON.parse(result.stdout);
const source = `import time
def detected(value):
    return value > 2
def survivor(value):
    return value > 5
def untouched(value):
    return value > 3
def slow(value):
    if value > 2:
        time.sleep(15)
def broken(value):
    if value > 2:
        raise ImportError('synthetic missing dependency')
`;

async function corpus(t, inconclusive = true) {
  const project = await pythonProject(t);
  const cwd = path.join(project.root, "work dir");
  await writeFile(path.join(cwd, "src/subject.py"), inconclusive ? source : source.slice(0, source.indexOf("def slow")));
  await writeFile(path.join(cwd, "resource.json"), '{"expected": 42}');
  await writeFile(path.join(cwd, "helper.py"), "print(42)\n");
  await chmod(path.join(cwd, "helper.py"), 0o755);
  await writeFile(path.join(cwd, "python checks/check_subject.py"), `import json, os, subprocess, sys
from pathlib import Path
from project_only_dependency import VALUE
from src.subject import *
def test_contract():
    assert VALUE == 'project environment'
    assert Path(sys.prefix).name == '.venv'
    assert os.environ['PROJECT_SETTING'] == 'required value'
    assert Path('prepared.txt').read_text() == 'argument with spaces & literal'
    assert not Path('output-from-previous-run').exists()
    Path('output-from-previous-run').write_text('owned copy output')
    assert int(subprocess.check_output([sys.executable, 'helper.py'])) == json.loads(Path('resource.json').read_text())['expected']
    assert detected(2) is False
    assert survivor(9) is True
    ${inconclusive ? "slow(2)\n    broken(2)" : ""}
`);
  return project;
}

test("incremental mutation selection records required, preexisting and equivalent evidence", () => {
  const before = Buffer.from("def classify(value):\n    return value > 0\n");
  const after = Buffer.from("def classify(value):\n    return value >= 0\n");
  const beforeHash = inputHash(before);
  const afterHash = inputHash(after);
  const task = { id: "selection-task", scope: ["src"], initial: {
    inputs: { digest: "baseline-inputs" },
    sources: [{ path: "src/subject.py", kind: "measured_code", sha256: beforeHash, content: before.toString("base64") }],
  } };
  const checkpoint = { digest: "current-inputs", entries: [
    { path: "src/subject.py", kind: "measured_code", sha256: afterHash, content: after },
  ] };
  const selection = selectIncrementalMutants(task, checkpoint, [
    { id: "required", file: "src/subject.py", line: 2, sourceHash: afterHash, mutatedHash: "mutated" },
    { id: "preexisting", file: "src/subject.py", line: 1, sourceHash: afterHash, mutatedHash: "mutated" },
    { id: "equivalent", file: "src/subject.py", line: 2, sourceHash: afterHash, mutatedHash: afterHash },
  ]);
  assert.deepEqual(selection.required.map(({ id }) => id), ["required"]);
  assert.deepEqual(selection.preexisting.map(({ id }) => id), ["preexisting"]);
  assert.equal(selection.equivalent[0].id, "equivalent");
  assert.match(selection.equivalent[0].evidence.staticProof, /sha256\(original\)/u);
});

test("installed mutate4py executes the authoritative corpus and distinguishes five states", async (t) => {
  const { root } = await corpus(t);
  const before = await hashDirectory(path.join(root, "work dir"));
  const result = parse(await runPythonProject(root, ["mutate"]));
  assert.equal(result.code, "mutation_execution_complete", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.deepEqual(result.summary, { killed: 1, survived: 1, uncovered: 1, timeout: 1, error: 1, interrupted: 0 });
  assert.equal(result.status, "NO_VERIFICADO");
  assert.equal(result.engine.version, "0.1.4");
  assert.equal(result.resources.copies, 1);
  assert.equal(result.resources.workers, 1);
  assert.equal(result.integrity.status, "preserved");
  assert.equal(result.baseline.suite.phases.call, 1);
  assert.ok(result.timeout.requestedMs >= result.timeout.referenceMs);
  assert.ok(result.budget.commands >= 6);
  assert.equal(result.details.filter((item) => item.restored).length, 4);
  assert.deepEqual(await hashDirectory(path.join(root, "work dir")), before);
  assert.equal(JSON.parse(await readFile(path.join(root, result.reference), "utf8")).result.code, result.code);
  assert.doesNotMatch(JSON.stringify(result), /QUALITY_OK|synthetic missing dependency/u);
});

test("installed mutation reuses only current task evidence and cleans it on replacement", async (t) => {
  const { root } = await corpus(t, false);
  await runPythonProject(root, ["prepare", "--task", "mutation-task", "--mode", "full", "--objective", "issue:49"]);
  const first = parse(await runPythonProject(root, ["mutation"]));
  assert.equal(first.complete, true, JSON.stringify(first));
  const again = parse(await runPythonProject(root, ["mutate"]));
  assert.equal(again.reused, true, JSON.stringify(again));
  assert.equal(again.budget.consumedMs, first.budget.consumedMs);
  await writeFile(path.join(root, "work dir/resource.json"), '{"expected":42}\n');
  const changed = parse(await runPythonProject(root, ["mutate"]));
  assert.equal(changed.reused, false);
  assert.ok(changed.budget.consumedMs > first.budget.consumedMs);
  const full = parse(await runPythonProject(root, ["verify"]));
  assert.equal(full.status, "approved");
  assert.equal(full.verification.mutation.status, "NO_APLICA");
  assert.match(full.receipt, /^QUALITY_OK/u);
  await runPythonProject(root, ["prepare", "--task", "next", "--mode", "normal", "--objective", "next"]);
  await assert.rejects(readFile(path.join(root, first.reference)), { code: "ENOENT" });
});

test("installed mutation preserves protected inputs, foreign reports and collection-only failures", async (t) => {
  const { root } = await corpus(t, false);
  const check = path.join(root, "work dir/python checks/check_subject.py");
  const tests = await readFile(check, "utf8");
  await writeFile(check, tests + "\n    Path('resource.json').write_text('changed by test')\n");
  const refused = parse(await runPythonProject(root, ["mutate"]));
  assert.equal(refused.code, "input_integrity_changed", JSON.stringify(refused));
  assert.equal(await readFile(path.join(root, "work dir/resource.json"), "utf8"), '{"expected": 42}');
  await writeFile(check, tests);
  await configurePythonProject(root, (config) => config.integration.python.command.args.push("--collect-only"));
  const collected = parse(await runPythonProject(root, ["mutate"]));
  assert.equal(collected.code, "tests_not_executed", JSON.stringify(collected));
  assert.equal(collected.details.length, 0);
  const report = path.join(root, ".agentic-core/quality/mutation.json");
  await writeFile(report, "foreign report");
  assert.equal(parse(await runPythonProject(root, ["mutate"])).code, "mutation_report_conflict");
  assert.equal(await readFile(report, "utf8"), "foreign report");
});

test("installed mutation accounts baseline exhaustion without inventing detected mutants", async (t) => {
  const { root } = await corpus(t, false);
  await configurePythonProject(root, (config) => { config.limits.operation.totalBudgetMs = 1; });
  const result = parse(await runPythonProject(root, ["mutate"]));
  assert.equal(result.code, "budget_exhausted", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.summary.killed, 0);
  assert.equal(result.budget.reservedMs, 0);
});

test("installed mutant interruption retains partial results and stops subsequent work", async (t) => {
  const { root } = await corpus(t, false);
  await writeFile(path.join(root, "work dir/src/subject.py"), `def detected(value):
    if value >= 2:
        return bool([])
    raise KeyboardInterrupt()
def survivor(value):
    return value > 5
`);
  const result = parse(await runPythonProject(root, ["mutate"]));
  assert.equal(result.code, "pytest_interrupted", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.summary.interrupted, 1);
  assert.equal(result.summary.killed, 0);
  assert.equal(result.pending, 1);
  assert.equal(result.details[0].restored, true);
  assert.equal(result.budget.reservedMs, 0);
});

test("installed mutation detects concurrent original changes and preserves their bytes", async (t) => {
  const { root } = await corpus(t, false);
  const check = path.join(root, "work dir/python checks/check_subject.py");
  const tests = await readFile(check, "utf8");
  await writeFile(check, tests.replace("    assert detected(2) is False", `    if detected(2):
        Path(os.environ['SYNTHETIC_ORIGINAL_RESOURCE']).write_text('concurrent owner content')
    assert detected(2) is False`));
  const resource = path.join(root, "work dir/resource.json");
  const result = parse(await runPythonProject(root, ["mutate"], { SYNTHETIC_ORIGINAL_RESOURCE: resource }));
  assert.equal(result.code, "input_integrity_changed", JSON.stringify(result));
  assert.equal(result.summary.killed, 0);
  assert.equal(result.details[0].status, "error");
  assert.deepEqual(result.integrity.original, ["work dir/resource.json"]);
  assert.equal(await readFile(resource, "utf8"), "concurrent owner content");
});

test("installed mutation exhausts the shared budget mid-run and persists partial states", async (t) => {
  const { root } = await corpus(t, false);
  const check = path.join(root, "work dir/python checks/check_subject.py");
  await writeFile(check, (await readFile(check, "utf8")).replace("def test_contract():", "def test_contract():\n    import time\n    time.sleep(2)"));
  await configurePythonProject(root, (config) => {
    config.limits.operation.totalBudgetMs = 6500;
    config.limits.operation.commandTimeoutMs = 30000;
  });
  const result = parse(await runPythonProject(root, ["mutate"]));
  assert.equal(result.code, "budget_exhausted", JSON.stringify(result));
  assert.equal(result.complete, false);
  assert.equal(result.summary.interrupted, 1);
  assert.ok(result.details.length > 0);
  assert.ok(result.details.at(-1).timeoutMs < result.timeout.requestedMs);
  assert.equal(result.budget.reservedMs, 0);
  assert.equal(result.budget.remainingMs, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, result.reference), "utf8")).result.details, result.details);
});

test("installed mutation spans files, preserves UTF-8 BOM and classifies collection errors", async (t) => {
  const { root } = await corpus(t, false);
  const cwd = path.join(root, "work dir");
  await writeFile(path.join(cwd, "src/other.py"), "def another(válue):\n    return válue < 5\n");
  const subject = path.join(cwd, "src/subject.py");
  await writeFile(subject, '\uFEFF' + (await readFile(subject, "utf8")) + "\nif 2 > 2:\n    raise ImportError('synthetic collection failure')\n");
  const check = path.join(cwd, "python checks/check_subject.py");
  await writeFile(check, (await readFile(check, "utf8")) + "\n    from src.other import another\n    assert another(9) is False\n");
  const before = await hashDirectory(cwd);
  const result = parse(await runPythonProject(root, ["mutate"]));
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.resources.copies, 1);
  assert.ok(result.details.some((item) => item.file === "work dir/src/other.py" && item.status === "survived"));
  assert.ok(result.details.some((item) => item.code === "pytest_collection_failed" && item.status === "error"));
  assert.equal(result.summary.interrupted, 0);
  assert.deepEqual(await hashDirectory(cwd), before);
});
