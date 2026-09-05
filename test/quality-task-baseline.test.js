import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

const execute = promisify(execFile);
const prepare = (mode, extra = []) => ["prepare", "--task", "repair-43", "--mode", mode, "--objective", "issue:43", ...extra];
const parse = (result) => JSON.parse(result.stdout);

test("installed task baseline preserves the actual worktree and separates repairable and unrelated failures", async (t) => {
  const { root } = await pythonProject(t);
  const subject = path.join(root, "work dir/src/subject.py");
  const original = await readFile(subject, "utf8");
  await execute("git", ["init", "--quiet"], { cwd: root });
  await execute("git", ["add", "work dir/src/subject.py"], { cwd: root });
  await execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "initial"], { cwd: root });
  const preexisting = original.replace("return 'positive'", "return 'broken'") + "\n# preexisting edit\n";
  await writeFile(subject, preexisting);
  const untracked = path.join(root, "work dir/src/untracked.py");
  await writeFile(untracked, "VALUE = 42\n");
  await writeFile(path.join(root, "work dir/python checks/check_unrelated.py"), "def test_unrelated():\n    assert False\n");
  const first = await runPythonProject(root, prepare("normal", ["--repair-test", "work dir/python checks/check_subject.py"]));
  const report = parse(first);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(report.code, "baseline_tests_failed");
  assert.equal(report.task.baseline.valid, true);
  assert.equal(report.task.baseline.status, "rejected");
  assert.deepEqual(report.task.baseline.failures.map((failure) => failure.disposition).sort(), ["outside_task", "repair_in_task"]);
  assert.equal(await readFile(subject, "utf8"), preexisting);
  assert.equal(await readFile(untracked, "utf8"), "VALUE = 42\n");
  const evidence = path.join(root, report.task.reference);
  const baseline = await readFile(evidence, "utf8");
  const saved = JSON.parse(baseline).task;
  assert.equal(Buffer.from(saved.initial.sources.find((entry) => entry.path === "work dir/src/subject.py").content, "base64").toString(), preexisting);
  assert.ok(saved.initial.sources.some((entry) => entry.path === "work dir/src/untracked.py"));
  assert.equal(saved.initial.result.coverage.status, "measured");
  assert.equal(saved.initial.result.integrity.dependencies, "preserved");
  await writeFile(subject, original + "\n# preexisting edit\n");
  const continued = await runPythonProject(root, ["prepare", "--task", "repair-43"]);
  assert.equal(parse(continued).reused, true);
  assert.equal(parse(continued).task.baseline.sha256, report.task.baseline.sha256);
  assert.equal(await readFile(evidence, "utf8"), baseline);
  const diagnostic = parse(await runPythonProject(root, ["baseline"]));
  assert.deepEqual(diagnostic.freshness.changed, ["work dir/src/subject.py"]);
  assert.equal(diagnostic.freshness.conditionsChanged, false);
  await writeFile(path.join(root, "work dir/new-resource.json"), "[42]\n");
  const newInput = parse(await runPythonProject(root, ["baseline"]));
  assert.ok(newInput.freshness.changed.includes("work dir/new-resource.json"));
  assert.equal(newInput.freshness.evidenceCurrent, false);
  const failedFinal = await runPythonProject(root, ["verify"]);
  assert.equal(failedFinal.code, 1, failedFinal.stdout);
  assert.equal(parse(failedFinal).result.suite.failed, 1);
  assert.doesNotMatch(failedFinal.stdout, /QUALITY_OK/u);

  // A changed test is a new verification condition; it cannot rewrite the original baseline.
  await writeFile(path.join(root, "work dir/python checks/check_unrelated.py"), "def test_unrelated():\n    assert True\n");
  await configurePythonProject(root, (config) => { config.integration.python.command.args.push("-v"); });
  const changed = parse(await runPythonProject(root, ["baseline"]));
  assert.equal(changed.freshness.conditionsChanged, true);
  assert.ok(changed.freshness.changed.includes("work dir/python checks/check_unrelated.py"));
  assert.equal(await readFile(evidence, "utf8"), baseline);
  const final = await runPythonProject(root, ["verify"]);
  assert.equal(parse(final).result.suite.status, "passed");
  assert.equal(parse(final).code, "quality_pending");
  assert.doesNotMatch(final.stdout, /QUALITY_OK/u);
  const different = await runPythonProject(root, ["prepare", "--task", "different"]);
  assert.equal(parse(different).code, "task_already_active");
  assert.equal(await readFile(evidence, "utf8"), baseline);
  await writeFile(evidence, baseline.replace('"objective":"issue:43"', '"objective":"tampered"'));
  assert.equal(parse(await runPythonProject(root, ["baseline"])).code, "task_evidence_invalid");
});

for (const mode of ["light", "full"]) {
  test(`installed ${mode} captures a passing baseline while Directo requires no preparation`, async (t) => {
    const { root } = await pythonProject(t);
    assert.equal((await runPythonProject(root)).code, 0);
    const result = await runPythonProject(root, prepare(mode));
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(parse(result).task.mode, mode);
    assert.equal(parse(result).task.baseline.valid, true);
    const direct = await runPythonProject(root, prepare("direct"));
    assert.equal(direct.code, 4);
  });
}

for (const scenario of [
  { name: "setup assertion", phase: "setup" },
  { name: "teardown assertion", phase: "teardown" },
  { name: "setup explicit failure", phase: "setup", explicit: true },
  { name: "setup production exception", phase: "setup", exception: true },
  { name: "pytest root outside cwd", phase: "call" },
]) {
  test(`installed task baseline accepts repairable production failure with ${scenario.name}`, async (t) => {
    const { root } = await pythonProject(t);
    const testPath = "work dir/python checks/check_subject.py";
    const subject = path.join(root, "work dir/src/subject.py");
    const original = await readFile(subject, "utf8");
    if (scenario.phase !== "call") {
      const fixture = scenario.phase === "teardown" ? "    yield\n" : "";
      const check = scenario.explicit ? "if classify(1) != 'positive':\n        pytest.fail('production check failed')" : "assert classify(1) == 'positive'";
      await writeFile(path.join(root, testPath), `import pytest
from src.subject import classify

@pytest.fixture(autouse=True)
def check_production():
${fixture}    ${check}

def test_subject():
    assert classify(0) == 'other'
`);
    } else {
      await writeFile(path.join(root, "pytest.ini"), "[pytest]\npythonpath = work dir\npython_files = check_*.py\naddopts = -q\n");
      await configurePythonProject(root, (config) => { config.integration.python.command.args[3] = "../pytest.ini"; });
    }
    const passing = await runPythonProject(root);
    assert.equal(passing.code, 0, passing.stdout + passing.stderr);
    assert.equal(parse(passing).code, "tests_passed");
    assert.equal(parse(passing).suite.collected, 1);
    assert.equal(parse(passing).suite.root, scenario.phase === "call" ? "." : "work dir");

    const broken = original.replace("return 'positive'", scenario.exception ? "raise RuntimeError('production defect')" : "return 'broken'");
    await writeFile(subject, broken);
    const first = await runPythonProject(root, prepare("normal", ["--repair-test", testPath]));
    const report = parse(first);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(report.code, "baseline_tests_failed");
    assert.equal(report.task.baseline.valid, true);
    assert.equal(report.task.baseline.status, "rejected");
    assert.equal(report.task.baseline.integrity.status, "preserved");
    assert.equal(report.task.baseline.failures.length, 1);
    assert.equal(report.task.baseline.failures[0].path, testPath);
    assert.equal(report.task.baseline.failures[0].phase, scenario.phase);
    assert.equal(report.task.baseline.failures[0].disposition, "repair_in_task");
    assert.equal(await readFile(subject, "utf8"), broken);
    const evidence = path.join(root, report.task.reference);
    const baseline = await readFile(evidence, "utf8");
    const failedFinal = await runPythonProject(root, ["verify"]);
    assert.equal(failedFinal.code, 1, failedFinal.stdout + failedFinal.stderr);
    assert.equal(parse(failedFinal).code, "tests_failed");

    await writeFile(subject, original);
    const repeated = await runPythonProject(root, ["prepare", "--task", "repair-43"]);
    assert.equal(repeated.code, 0, repeated.stdout + repeated.stderr);
    assert.equal(parse(repeated).reused, true);
    assert.equal(parse(repeated).task.baseline.sha256, report.task.baseline.sha256);
    const final = await runPythonProject(root, ["verify"]);
    assert.equal(parse(final).result.code, "tests_passed");
    assert.equal(parse(final).code, "quality_pending");
    assert.deepEqual(parse(final).freshness.changed, ["work dir/src/subject.py"]);
    assert.equal(await readFile(evidence, "utf8"), baseline);
    assert.equal(await readFile(subject, "utf8"), original);
    assert.doesNotMatch(first.stdout + final.stdout, /QUALITY_OK/u);
    assert.ok(!first.stdout.includes(root) && !first.stdout.includes(root.replaceAll("\\", "/")));
  });
}

for (const scenario of ["environment", "fixture", "fixture dependency", "integrity"]) {
  test(`installed preparation records invalid ${scenario} evidence without treating it as a repairable failure`, async (t) => {
    const { root } = await pythonProject(t);
    if (scenario === "environment") await configurePythonProject(root, (config) => { config.integration.python.interpreter = "python-does-not-exist-43"; });
    if (scenario === "fixture") await writeFile(path.join(root, "work dir/conftest.py"), "import pytest\n@pytest.fixture(autouse=True)\ndef broken_setup():\n    raise RuntimeError('fixture unavailable')\n");
    if (scenario === "fixture dependency") await writeFile(path.join(root, "work dir/conftest.py"), "import importlib, pytest\n@pytest.fixture(autouse=True)\ndef missing_dependency():\n    importlib.import_module('missing_dependency_43')\n");
    if (scenario === "integrity") await writeFile(path.join(root, "work dir/python checks/check_write.py"), "from pathlib import Path\ndef test_write():\n    Path('src/subject.py').write_text('changed')\n");
    const result = await runPythonProject(root, prepare("normal", ["--repair-test", "work dir/python checks/check_subject.py"]));
    const report = parse(result);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.equal(report.status, "NO_VERIFICADO");
    assert.equal(report.task.baseline.valid, false);
    assert.notEqual(report.code, "baseline_tests_failed");
    if (scenario === "integrity") assert.equal(report.code, "input_integrity_changed");
    if (scenario.startsWith("fixture")) {
      assert.equal(report.code, "pytest_fixture_failed");
      assert.equal(report.task.baseline.failures[0].disposition, "repair_in_task");
    }
    const repeat = await runPythonProject(root, ["prepare"]);
    assert.equal(repeat.code, 2);
    assert.equal(parse(repeat).task.baseline.sha256, report.task.baseline.sha256);
  });
}
