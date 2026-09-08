import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  assert.equal(final.code, 2);
  assert.equal(parse(final).status, "NO_VERIFICADO");
  assert.equal(parse(final).code, "quality_conditions_changed");
  assert.equal(parse(final).verification.controls.evidence.code, "quality_conditions_changed");
  assert.doesNotMatch(final.stdout, /QUALITY_OK/u);
  const different = await runPythonProject(root, ["prepare", "--task", "different"]);
  assert.equal(parse(different).code, "invalid_usage");
  assert.equal(await readFile(evidence, "utf8"), baseline);
  await writeFile(evidence, baseline.replace('"objective":"issue:43"', '"objective":"tampered"'));
  assert.equal(parse(await runPythonProject(root, ["baseline"])).code, "task_evidence_invalid");
});

test("installed task verification reuses current evidence and replaces only owned artifacts", async (t) => {
  const firstProject = await pythonProject(t);
  const secondProject = await pythonProject(t);
  const projects = [firstProject, secondProject];
  const counters = [];
  for (const { root } of projects) {
    const counter = path.join(tmpdir(), `agentic-core-47-${path.basename(root)}.txt`);
    counters.push(counter);
    const wrapper = path.join(root, "work dir/wrapper space.py");
    const source = await readFile(wrapper, "utf8");
    await writeFile(wrapper, source.replace("import os, subprocess, sys", "import os, subprocess, sys, tempfile")
      .replace("Path('prepared.txt').write_text(sys.argv[1])", `counter = Path(tempfile.gettempdir()) / os.environ['QUALITY_COUNTER_NAME']
counter.write_text(str(int(counter.read_text()) + 1 if counter.exists() else 1))
Path('prepared.txt').write_text(sys.argv[1])`));
  }
  t.after(() => Promise.all(counters.map((counter) => rm(counter, { force: true }))));
  const count = (counter) => readFile(counter, "utf8").then(Number);
  const counterEnvironments = counters.map((counter) => ({ QUALITY_COUNTER_NAME: path.basename(counter) }));

  const firstPrepared = await runPythonProject(firstProject.root, [
    "prepare", "--task", "first", "--mode", "normal", "--objective", "issue:47",
  ], counterEnvironments[0]);
  assert.equal(firstPrepared.code, 0, firstPrepared.stdout + firstPrepared.stderr);
  const firstVerified = await runPythonProject(firstProject.root, ["verify"], counterEnvironments[0]);
  assert.equal(firstVerified.code, 0, firstVerified.stdout + firstVerified.stderr);
  assert.equal(await count(counters[0]), 2);
  const repeated = await runPythonProject(firstProject.root, ["verify"], counterEnvironments[0]);
  assert.equal(repeated.code, 0, repeated.stdout + repeated.stderr);
  assert.equal(parse(repeated).reused, true);
  assert.equal(await count(counters[0]), 2);

  const subject = path.join(firstProject.root, "work dir/src/subject.py");
  await writeFile(subject, `${await readFile(subject, "utf8")}\n# relevant input changed\n`);
  const changed = await runPythonProject(firstProject.root, ["verify"], counterEnvironments[0]);
  assert.equal(parse(changed).reused, undefined);
  assert.equal(await count(counters[0]), 3);

  const standaloneCrap = await runPythonProject(firstProject.root, ["crap"], counterEnvironments[0]);
  assert.equal(standaloneCrap.code, 0, standaloneCrap.stdout + standaloneCrap.stderr);
  assert.equal(await count(counters[0]), 4);
  const standaloneDry = await runPythonProject(firstProject.root, ["dry"], counterEnvironments[0]);
  assert.equal(standaloneDry.code, 0, standaloneDry.stdout + standaloneDry.stderr);
  const resolutionsPath = path.join(firstProject.root, ".agentic-core/quality/dry-resolutions.json");
  await writeFile(resolutionsPath, JSON.stringify({ schemaVersion: 1, resolutions: [] }));
  const privateEvidence = path.join(firstProject.root, ".agentic-core/quality/unknown-result.json");
  const savedResult = path.join(firstProject.root, "saved-result.md");
  await writeFile(privateEvidence, "keep this unknown result\n");
  await writeFile(savedResult, "keep this result outside internal evidence\n");
  const replaced = await runPythonProject(firstProject.root, [
    "prepare", "--task", "second", "--mode", "normal", "--objective", "issue:47-correction",
  ], counterEnvironments[0]);
  const replacedReport = parse(replaced);
  assert.equal(replaced.code, 0, replaced.stdout + replaced.stderr);
  assert.equal(replacedReport.reused, false);
  assert.equal(replacedReport.replaced, true);
  assert.equal(replacedReport.task.id, "second");
  assert.equal(await count(counters[0]), 5);
  await access(privateEvidence);
  await access(savedResult);
  await assert.rejects(() => access(path.join(firstProject.root, ".agentic-core/quality/verification.json")), { code: "ENOENT" });
  await assert.rejects(() => access(path.join(firstProject.root, ".agentic-core/quality/crap.json")), { code: "ENOENT" });
  await assert.rejects(() => access(path.join(firstProject.root, ".agentic-core/quality/dry.json")), { code: "ENOENT" });
  await assert.rejects(() => access(resolutionsPath), { code: "ENOENT" });

  const secondVerified = await runPythonProject(firstProject.root, ["verify"], counterEnvironments[0]);
  assert.equal(secondVerified.code, 0, secondVerified.stdout + secondVerified.stderr);
  assert.equal(await count(counters[0]), 6);
  const secondRepeated = await runPythonProject(firstProject.root, ["verify"], counterEnvironments[0]);
  assert.equal(parse(secondRepeated).reused, true);
  assert.equal(await count(counters[0]), 6);

  const independentPrepared = await runPythonProject(secondProject.root, [
    "prepare", "--task", "independent", "--mode", "normal", "--objective", "issue:47-independent",
  ], counterEnvironments[1]);
  assert.equal(independentPrepared.code, 0, independentPrepared.stdout + independentPrepared.stderr);
  const independentVerified = await runPythonProject(secondProject.root, ["verify"], counterEnvironments[1]);
  assert.equal(independentVerified.code, 0, independentVerified.stdout + independentVerified.stderr);
  const independentRepeated = await runPythonProject(secondProject.root, ["verify"], counterEnvironments[1]);
  assert.equal(parse(independentRepeated).reused, true);
  assert.equal(await count(counters[1]), 2);
});

test("installed new task preserves active evidence when the previous verdict is corrupt", async (t) => {
  const { root } = await pythonProject(t);
  const prepared = await runPythonProject(root, [
    "prepare", "--task", "current", "--mode", "normal", "--objective", "issue:47",
  ]);
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const verified = await runPythonProject(root, ["verify"]);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  const activePath = path.join(root, ".agentic-core/quality/active-task.json");
  const verdictPath = path.join(root, ".agentic-core/quality/verification.json");
  const active = await readFile(activePath, "utf8");
  const corrupt = "verdict from an unknown producer\n";
  await writeFile(verdictPath, corrupt);
  const replacement = await runPythonProject(root, [
    "prepare", "--task", "next", "--mode", "normal", "--objective", "issue:47-next",
  ]);
  assert.equal(replacement.code, 2, replacement.stdout + replacement.stderr);
  assert.equal(parse(replacement).code, "task_evidence_cleanup_failed");
  assert.equal(await readFile(activePath, "utf8"), active);
  assert.equal(await readFile(verdictPath, "utf8"), corrupt);
});

for (const mode of ["light", "normal"]) {
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
    assert.equal(final.code, 0);
    assert.equal(parse(final).status, "approved");
    assert.equal(parse(final).code, "quality_approved");
    assert.deepEqual(parse(final).freshness.changed, ["work dir/src/subject.py"]);
    assert.equal(await readFile(evidence, "utf8"), baseline);
    assert.equal(await readFile(subject, "utf8"), original);
    assert.doesNotMatch(first.stdout, /QUALITY_OK/u);
    assert.match(parse(final).receipt, /^QUALITY_OK/u);
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
