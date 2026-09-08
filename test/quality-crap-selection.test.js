import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runPythonCrap } from "../src/quality/python-crap.js";
import { runProjectTests } from "../src/quality/python-project.js";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

test("installed standalone C.R.A.P. measures only selected code with observed selected tests", async (t) => {
  const { root, config } = await pythonProject(t);
  const source = "work dir/src/subject.py";
  const chosen = "work dir/python checks/check_subject.py";
  const other = "work dir/python checks/check_other.py";
  await writeFile(path.join(root, other), "from src.subject import classify\ndef test_other():\n    assert classify(1) == 'positive'\n");
  await writeFile(path.join(root, "work dir/src/auxiliary.py"), "def unused():\n    return 42\n");
  const configPath = path.join(root, ".agentic-core/config.json");
  const configBytes = await readFile(configPath);
  const invoke = async (...args) => {
    const result = await runPythonProject(root, ["crap", ...args]);
    assert.equal(result.stderr, "");
    return { ...JSON.parse(result.stdout), processCode: result.code };
  };
  const selectedArgs = ["--scope", source, "--test", chosen];
  const selected = await invoke(...selectedArgs);
  assert.equal(selected.processCode, 0, JSON.stringify(selected));
  assert.equal(selected.analysis, "current");
  assert.deepEqual(selected.execution.effectiveCommand.args, config.integration.python.command.args);
  assert.deepEqual(selected.execution.suite.executed.map((entry) => entry.path), [chosen]);
  assert.deepEqual(selected.selection.measuredFiles, [source]);
  assert.deepEqual(selected.details.map((row) => [row.name, row.value, row.coverage.fraction]), [["classify", 2, 1]]);
  assert.equal(selected.execution.integrity.status, "preserved");
  assert.equal(selected.budget.commands, 2, "only the authoritative tests and C.R.A.P. adapter execute");
  const alternate = await invoke("--scope", source, "--test", other);
  assert.equal(alternate.processCode, 0, JSON.stringify(alternate));
  assert.deepEqual(alternate.execution.suite.executed.map((entry) => entry.path), [other]);
  assert.notEqual(alternate.identity, selected.identity);
  assert.equal(alternate.details[0].coverage.fraction, 0.5);
  const folder = await invoke("--scope", "work dir/src", "--test", chosen);
  assert.equal(folder.processCode, 2, JSON.stringify(folder));
  assert.notEqual(folder.identity, selected.identity);
  const unmeasured = folder.details.find((row) => row.name === "unused");
  assert.equal(unmeasured.code, "coverage_not_loaded");
  assert.equal(unmeasured.value, null);
  assert.equal(unmeasured.coverage.fraction, null);
  assert.equal(folder.details.find((row) => row.name === "classify").value, 2);
  assert.deepEqual(await readFile(configPath), configBytes);
  for (const artifact of ["dry.json", "mutation.json", "verification.json", "active-task.json", "budget.json"]) {
    await assert.rejects(access(path.join(root, ".agentic-core/quality", artifact)), { code: "ENOENT" });
  }

  await t.test("incompatible supplied coverage is rejected without running a broader suite", async () => {
    const execution = await runProjectTests(root, { code: [source], tests: [chosen] });
    assert.equal(execution.exitCode, 0, JSON.stringify(execution));
    for (const selection of [{ code: [source], tests: [other] }, { code: ["work dir/src"], tests: [chosen] }]) {
      await assert.rejects(runPythonCrap(root, { selection, execution }), { code: "crap_execution_conflict" });
    }
    const compatible = await runPythonCrap(root, { selection: { code: [source], tests: [chosen] }, execution });
    assert.equal(compatible.status, "approved");
  });

  await t.test("invalid selection preserves the report and does not fall back", async () => {
    const previous = await readFile(path.join(root, selected.reference));
    const invalid = await invoke("--scope", "missing.py", "--test", chosen);
    assert.equal(invalid.processCode, 4);
    assert.equal(invalid.code, "invalid_selection");
    assert.equal(invalid.execution, undefined);
    assert.deepEqual(await readFile(path.join(root, selected.reference)), previous);
  });

  await t.test("unobserved tests preserve unknown coverage and measured empty code stays not applicable", async () => {
    await writeFile(path.join(root, "work dir/src/empty.py"), '"""No executable behavior."""\n');
    const empty = await invoke("--scope", "work dir/src/empty.py", "--test", chosen);
    assert.equal(empty.status, "NO_APLICA", JSON.stringify(empty));
    await configurePythonProject(root, (c) => { c.integration.python.command.args.push("--collect-only"); });
    const unobserved = await invoke(...selectedArgs);
    assert.equal(unobserved.processCode, 2, JSON.stringify(unobserved));
    assert.equal(unobserved.execution.code, "tests_not_executed");
    assert.deepEqual(unobserved.execution.suite.executed, []);
    assert.equal(unobserved.status, "NO_VERIFICADO");
    assert.equal(unobserved.details[0].coverage.fraction, 0, "collection imports the module but does not run its function");
    await writeFile(configPath, configBytes);
    const wrapperPath = path.join(root, "work dir/wrapper space.py");
    const wrapper = await readFile(wrapperPath, "utf8");
    await writeFile(wrapperPath, wrapper.replace("raise SystemExit", "os.environ.pop('PYTEST_PLUGINS', None)\nraise SystemExit"));
    const unknown = await invoke(...selectedArgs);
    assert.equal(unknown.processCode, 2, JSON.stringify(unknown));
    assert.equal(unknown.execution.code, "pytest_unobserved");
    assert.equal(unknown.details[0].value, null);
    assert.equal(unknown.details[0].coverage.fraction, null);
    await writeFile(wrapperPath, wrapper);
  });
});

test("installed current C.R.A.P. retains debt with an active task and preserves concurrent reports", async (t) => {
  const { root } = await pythonProject(t);
  await configurePythonProject(root, (c) => { c.limits.crap = 1.5; });
  const prepared = await runPythonProject(root, ["prepare", "--task", "crap-current", "--mode", "normal", "--objective", "issue:87"]);
  assert.equal(prepared.code, 0, prepared.stdout);
  const activePath = path.join(root, ".agentic-core/quality/active-task.json");
  const activeBytes = await readFile(activePath);
  const args = ["crap", "--scope", "work dir/src/subject.py", "--test", "work dir/python checks/check_subject.py"];
  const current = await runPythonProject(root, args);
  const report = JSON.parse(current.stdout);
  assert.equal(current.code, 1, current.stdout);
  assert.equal(report.analysis, "current");
  assert.equal(report.details[0].status, "rejected");
  assert.equal(report.details[0].value, 2);
  assert.equal(report.baseline, undefined);
  assert.ok(report.budget.consumedMs > 0);
  assert.deepEqual(await readFile(activePath), activeBytes);
  const reportPath = path.join(root, report.reference);
  const previous = await readFile(reportPath, "utf8");
  const concurrent = JSON.stringify({ ...JSON.parse(previous), writer: "another session" });
  const wrapperPath = path.join(root, "work dir/wrapper space.py");
  const wrapper = await readFile(wrapperPath, "utf8");
  // A concurrent writer changes the report while the authoritative wrapper runs.
  await writeFile(wrapperPath, wrapper.replace("raise SystemExit",
    `Path(${JSON.stringify(reportPath)}).write_text(${JSON.stringify(concurrent)}, encoding='utf-8')\nraise SystemExit`));
  const conflict = await runPythonProject(root, args);
  const partial = JSON.parse(conflict.stdout);
  assert.equal(conflict.code, 2, conflict.stdout);
  assert.equal(partial.code, "quality_report_conflict");
  assert.equal(partial.details[0].value, 2);
  assert.equal(partial.reference, undefined);
  assert.equal(await readFile(reportPath, "utf8"), concurrent);
  await writeFile(wrapperPath, wrapper);
  await writeFile(reportPath, "foreign report\n");
  const foreign = JSON.parse((await runPythonProject(root, args)).stdout);
  assert.equal(foreign.code, "quality_report_conflict");
  assert.equal(await readFile(reportPath, "utf8"), "foreign report\n");
  assert.deepEqual(await readFile(activePath), activeBytes);
});
