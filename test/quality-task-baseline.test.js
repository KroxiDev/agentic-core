import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
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
  { name: "grouped teardown assertions", phase: "teardown", group: "native" },
  { name: "nested setup assertions", phase: "setup", group: "nested" },
  { name: "nested teardown production exception", phase: "teardown", group: "nested", exception: true },
  { name: "pytest root outside cwd", phase: "call" },
]) {
  test(`installed task baseline accepts repairable production failure with ${scenario.name}`, async (t) => {
    const { root } = await pythonProject(t);
    const testPath = "work dir/python checks/check_subject.py";
    const subject = path.join(root, "work dir/src/subject.py");
    const original = await readFile(subject, "utf8");
    if (scenario.phase !== "call") {
      const fixture = scenario.phase === "teardown" ? "    yield\n" : "";
      let check = scenario.explicit ? "if classify(1) != 'positive':\n        pytest.fail('production check failed')" : "assert classify(1) == 'positive'";
      if (scenario.group === "nested") check = `try:
        assert classify(1) == 'positive'
    except BaseException as error:
        raise BaseExceptionGroup('private group detail 43', [
            AssertionError('private check detail 43'),
            BaseExceptionGroup('nested', [error, pytest.fail.Exception('explicit check')]),
        ])`;
      await writeFile(path.join(root, testPath), `import pytest
from src.subject import classify

@pytest.fixture(autouse=True)
def check_production():
${fixture}    ${check}

${scenario.group === "native" ? `@pytest.fixture(autouse=True)
def another_check():
    yield
    assert classify(1) == 'positive'
` : ""}
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
    assert.doesNotMatch(first.stdout, /private group detail 43|private check detail 43/u);
  });
}

for (const phase of ["setup", "call", "teardown"]) {
  test(`installed task baseline rejects a nested mixed unattributed group during ${phase}`, async (t) => {
    const { root } = await pythonProject(t);
    const testPath = "work dir/python checks/check_subject.py";
    const subject = path.join(root, "work dir/src/subject.py");
    const original = await readFile(subject, "utf8");
    await writeFile(path.join(root, testPath), `import pytest
from src.subject import classify
${phase === "call" ? "" : `@pytest.fixture(autouse=True)
def check_production():
${phase === "teardown" ? "    yield\n" : ""}    classify(1)
`}
def test_subject():
    assert classify(${phase === "call" ? 1 : 0}) == '${phase === "call" ? "positive" : "other"}'
`);
    const positive = await runPythonProject(root);
    assert.equal(positive.code, 0, positive.stdout + positive.stderr);
    // A measured frame on the group cannot supply provenance for its unknown leaves.
    const broken = original.replace("return 'positive'", "raise BaseExceptionGroup('private mixed group 43', [AssertionError('known check'), BaseExceptionGroup('nested', [RuntimeError('unknown preparation')])])");
    await writeFile(subject, broken);
    const first = await runPythonProject(root, prepare("normal", ["--repair-test", testPath]));
    const report = parse(first);
    assert.equal(first.code, 2, first.stdout + first.stderr);
    assert.equal(report.status, "NO_VERIFICADO");
    assert.equal(report.code, "pytest_failure_unattributed");
    assert.equal(report.task.baseline.valid, false);
    assert.equal(report.task.baseline.integrity.status, "preserved");
    assert.equal(report.task.baseline.failures[0].phase, phase);
    assert.equal(report.task.baseline.failures[0].disposition, "repair_in_task");
    const evidence = path.join(root, report.task.reference);
    const baseline = await readFile(evidence, "utf8");
    await writeFile(subject, original);
    const final = await runPythonProject(root, ["verify"]);
    assert.equal(parse(final).result.code, "tests_passed");
    assert.equal(parse(final).code, "baseline_invalid");
    assert.equal(await readFile(evidence, "utf8"), baseline);
    assert.doesNotMatch(first.stdout, /private mixed group 43|unknown preparation/u);
  });

  for (const grouped of [false, true]) {
    test(`installed task baseline rejects an absent production dependency during ${phase}${grouped ? " in a nested group" : ""}`, async (t) => {
      const { root, python } = await pythonProject(t);
      const testPath = "work dir/python checks/check_subject.py";
      const subject = path.join(root, "work dir/src/subject.py");
      const source = (await readFile(subject, "utf8")).replace("def classify(value):", `def classify(value):
    if value > 0:
        from project_only_dependency import VALUE`);
      await writeFile(subject, source);
      const testSource = `import pytest
from src.subject import classify

def check_production():
    try:
        assert classify(1) == 'positive'
    except BaseException as error:
${grouped ? `        raise BaseExceptionGroup('private dependency detail 43', [
            AssertionError('known check'),
            BaseExceptionGroup('nested', [error, RuntimeError('unattributed')]),
        ])` : "        raise"}

${phase === "call" ? "" : `@pytest.fixture(autouse=True)
def production_fixture():
${phase === "teardown" ? "    yield\n" : ""}    check_production()
`}
def test_subject():
    ${phase === "call" ? "check_production()" : "assert classify(0) == 'other'"}
`;
      await writeFile(path.join(root, testPath), testSource);
      const positive = await runPythonProject(root);
      assert.equal(positive.code, 0, positive.stdout + positive.stderr);
      assert.equal(parse(positive).code, "tests_passed");
      const dependency = (await execute(python, ["-c", "import project_only_dependency; print(project_only_dependency.__file__)"],
        { encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } })).stdout.trim();
      assert.ok(path.resolve(dependency).startsWith(path.resolve(root, ".venv") + path.sep));
      const dependencySource = await readFile(dependency, "utf8");
      await rm(dependency);
      const first = await runPythonProject(root, prepare("normal", ["--repair-test", testPath]));
      const report = parse(first);
      assert.equal(first.code, 2, first.stdout + first.stderr);
      assert.equal(report.code, "pytest_dependency_failed");
      assert.equal(report.status, "NO_VERIFICADO");
      assert.equal(report.task.baseline.valid, false);
      assert.equal(report.task.baseline.code, "pytest_dependency_failed");
      assert.equal(report.task.baseline.integrity.status, "preserved");
      assert.equal(report.task.baseline.integrity.dependencies, "preserved");
      assert.equal(report.task.baseline.failures[0].phase, phase);
      assert.equal(report.task.baseline.failures[0].kind, "dependency_error");
      assert.equal(report.task.baseline.failures[0].disposition, "repair_in_task");
      assert.equal(report.task.baseline.suite.phases.call, phase === "setup" ? 0 : 1);
      assert.equal(await readFile(subject, "utf8"), source);
      assert.equal(await readFile(path.join(root, testPath), "utf8"), testSource);
      const evidence = path.join(root, report.task.reference);
      const baseline = await readFile(evidence, "utf8");
      await writeFile(dependency, dependencySource);
      const repeated = await runPythonProject(root, ["prepare"]);
      assert.equal(repeated.code, 2);
      assert.equal(parse(repeated).task.baseline.sha256, report.task.baseline.sha256);
      const final = await runPythonProject(root, ["verify"]);
      assert.equal(parse(final).result.code, "tests_passed");
      assert.equal(parse(final).code, "baseline_invalid");
      assert.equal(await readFile(evidence, "utf8"), baseline);
      assert.doesNotMatch(first.stdout, /private dependency detail 43|ModuleNotFoundError|No module named/u);
    });
  }
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
      assert.equal(report.code, scenario === "fixture dependency" ? "pytest_dependency_failed" : "pytest_fixture_failed");
      assert.equal(report.task.baseline.failures[0].disposition, "repair_in_task");
    }
    const repeat = await runPythonProject(root, ["prepare"]);
    assert.equal(repeat.code, 2);
    assert.equal(parse(repeat).task.baseline.sha256, report.task.baseline.sha256);
  });
}
