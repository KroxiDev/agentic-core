import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { hashDirectory } from "../src/transaction.js";
import { privatePython } from "../src/installation/python.js";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

test("PR-09 regression: installed pytest uses the project environment and actual suite", async (t) => {
  const { root, python, hostPython, config } = await pythonProject(t);
  const environmentHash = await hashDirectory(path.join(root, ".venv"));
  const toolsHash = await hashDirectory(path.join(root, ".agentic-core/tools"));
  const result = await runPythonProject(root);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.suite.status, "passed");
  assert.equal(report.suite.collected, 1);
  assert.equal(report.python.executable, "[Python del proyecto]");
  assert.deepEqual(report.effectiveCommand.args, config.integration.python.command.args);
  assert.equal(report.effectiveCommand.cwd, "work dir");
  assert.equal(report.effectiveCommand.location, "controlled_copy");
  assert.equal(report.coverage.backend, "coverage.py");
  const file = report.coverage.files["work dir/src/subject.py"];
  assert.deepEqual(file.executed_lines, [1, 2, 3, 4]);
  assert.equal(file.summary.percent_covered, 100);
  assert.match(report.coverage.lcov, /BRDA:/u);
  assert.equal(await hashDirectory(path.join(root, ".venv")), environmentHash);
  assert.equal(await hashDirectory(path.join(root, ".agentic-core/tools")), toolsHash);
  await assert.rejects(access(path.join(root, "work dir/declared-suite-ran.txt")), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, "lcov.info")), { code: "ENOENT" });
  t.diagnostic(`Windows/local Python ${report.python.version.join(".")}, pytest ${report.python.pytestVersion}, coverage ${report.coverage.version}`);

  await t.test("environment override has maximum priority and invalid selections never fall back", async () => {
    await configurePythonProject(root, (c) => { c.integration.python.interpreter = "missing-config-python"; c.integration.python.command.executable = "missing-config-python"; });
    const validOverride = await runPythonProject(root, ["test"], { AGENTIC_CORE_PYTHON: python });
    assert.equal(validOverride.code, 0, validOverride.stdout);
    const missing = await runPythonProject(root, ["test"], { AGENTIC_CORE_PYTHON: path.join(root, "missing python") });
    assert.equal(missing.code, 2, missing.stdout);
    assert.equal(JSON.parse(missing.stdout).code, "command_unavailable");
    const invalidConfig = await runPythonProject(root);
    assert.equal(invalidConfig.code, 2);
    const toolsAsProject = await runPythonProject(root, ["test"], { AGENTIC_CORE_PYTHON: privatePython(path.join(root, ".agentic-core/tools")) });
    assert.equal(toolsAsProject.code, 2);
    assert.equal(JSON.parse(toolsAsProject.stdout).code, "pytest_unavailable");
    await configurePythonProject(root, (c) => { c.integration.python.interpreter = python; c.integration.python.command.executable = python; });
  });

  await t.test("a wrapper selecting the wrong Python cannot approve", async () => {
    await writeFile(path.join(root, "work dir/wrong.py"), `import subprocess,sys\nraise SystemExit(subprocess.call([${JSON.stringify(hostPython)}, '-m', 'pytest', '-c', 'config space.ini', 'python checks']))\n`);
    await configurePythonProject(root, (c) => { c.integration.python.command.args = ["wrong.py"]; });
    const wrong = await runPythonProject(root);
    assert.equal(wrong.code, 2, wrong.stdout);
    assert.equal(JSON.parse(wrong.stdout).code, "interpreter_mismatch");
  });

  await t.test("successful commands without observed pytest or coverage cannot approve", async () => {
    await configurePythonProject(root, (c) => { c.integration.python.command.args = ["-c", "pass"]; });
    const bypass = await runPythonProject(root);
    assert.equal(bypass.code, 2);
    assert.equal(JSON.parse(bypass.stdout).code, "pytest_unobserved");
    assert.equal(JSON.parse(bypass.stdout).coverage.files, null);
    await configurePythonProject(root, (c) => { c.integration.python.command.args = config.integration.python.command.args; c.integration.python.scope = ["missing-source"]; });
    const noCoverage = await runPythonProject(root);
    assert.equal(noCoverage.code, 2, noCoverage.stdout);
    assert.equal(JSON.parse(noCoverage.stdout).suite.status, "passed");
    assert.equal(JSON.parse(noCoverage.stdout).coverage.files, null);
  });

  await t.test("pytest failure, invalid usage and internal error use numeric codes", async () => {
    await configurePythonProject(root, (c) => { c.integration.python.scope = config.integration.python.scope; c.integration.python.command.args = ["-m", "pytest", "tests"]; });
    const failedCollection = await runPythonProject(root);
    assert.equal(JSON.parse(failedCollection.stdout).suite.exitCode, 2);
    await configurePythonProject(root, (c) => { c.integration.python.command.args = ["-m", "pytest", "-c", "config space.ini", "python checks"]; c.integration.python.environment.PROJECT_SETTING = "incorrect"; });
    const failed = await runPythonProject(root);
    assert.equal(failed.code, 1, failed.stdout);
    assert.equal(JSON.parse(failed.stdout).code, "tests_failed");
    assert.equal(JSON.parse(failed.stdout).coverage.status, "measured");
    await configurePythonProject(root, (c) => { c.integration.python.command.args = ["-m", "pytest", "--not-a-pytest-option"]; });
    const invalid = await runPythonProject(root);
    assert.equal(invalid.code, 4, invalid.stdout);
    assert.equal(JSON.parse(invalid.stdout).code, "pytest_invalid_usage");
    await writeFile(path.join(root, "work dir/conftest.py"), "def pytest_sessionstart(session):\n    raise RuntimeError('required not found timeout: diagnostic text must not classify errors')\n");
    await configurePythonProject(root, (c) => { c.integration.python.command.args = ["-m", "pytest", "-c", "config space.ini", "python checks"]; });
    const internal = await runPythonProject(root);
    assert.equal(internal.code, 5, internal.stdout);
    assert.equal(JSON.parse(internal.stdout).code, "pytest_internal_error");
  });
});
