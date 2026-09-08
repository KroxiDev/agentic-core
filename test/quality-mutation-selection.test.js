import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pythonProject, runPythonProject } from "./support/python-project.mjs";

test("installed standalone mutation binds selected code and tests to its current-state score", async (t) => {
  const { root, config } = await pythonProject(t);
  const source = "work dir/src/subject.py";
  const chosen = "work dir/python checks/check_subject.py";
  const other = "work dir/python checks/check_other.py";
  await writeFile(path.join(root, other), "from src.subject import classify\ndef test_other():\n    assert classify(1) == 'positive'\n");
  await writeFile(path.join(root, "work dir/src/auxiliary.py"), "def auxiliary(value):\n    return value > 3\n");
  const configPath = path.join(root, ".agentic-core/config.json");
  const configBytes = await readFile(configPath);
  const sourceBytes = await readFile(path.join(root, source));
  const invoke = async (args) => {
    const result = await runPythonProject(root, args);
    return { ...JSON.parse(result.stdout), processCode: result.code };
  };
  const selectedArgs = ["mutate", "--scope", source, "--test", chosen];
  const selected = await invoke(selectedArgs);
  assert.equal(selected.processCode, 0, JSON.stringify(selected));
  assert.equal(selected.status, "approved");
  assert.equal(selected.analysis, "current_state");
  assert.equal(selected.taskId, null);
  assert.equal(selected.selection.method, "current_state");
  assert.equal(selected.selection.baseline, undefined);
  assert.equal(selected.score.percentage, 100);
  assert.equal(selected.score.denominator, 2);
  assert.deepEqual(selected.scopeSelection.measuredFiles, [source]);
  assert.deepEqual(selected.scopeSelection.tests, [chosen]);
  assert.equal(selected.inputs.inventory.find((entry) => entry.path.endsWith("auxiliary.py")).kind, "test_input");
  for (const execution of [selected.baseline, ...selected.details]) {
    assert.deepEqual(execution.effectiveCommand.args, config.integration.python.command.args);
    assert.deepEqual(execution.suite.executed.map((entry) => entry.path), [chosen]);
    assert.equal(execution.effectiveCommand.location, "controlled_copy");
  }
  assert.equal(selected.integrity.status, "preserved");
  assert.equal(selected.resources.cleanup, "completed");
  assert.equal(selected.budget.reference, null);
  const stored = JSON.parse(await readFile(path.join(root, selected.reference), "utf8"));
  assert.deepEqual(stored.result.assessment.score, selected.score);
  assert.equal(stored.result.assessment.status, "approved");

  const reused = await invoke(["mutation", ...selectedArgs.slice(1)]);
  assert.equal(reused.reused, true, JSON.stringify(reused));
  assert.equal(reused.evidenceIdentity, selected.evidenceIdentity);
  const weaker = await invoke(["mutate", "--scope", source, "--test", other]);
  assert.equal(weaker.processCode, 1, JSON.stringify(weaker));
  assert.equal(weaker.status, "rejected");
  assert.ok(weaker.score.percentage < 100);
  assert.ok(weaker.summary.survived > 0);
  assert.equal(weaker.reused, false);
  assert.notEqual(weaker.evidenceIdentity, selected.evidenceIdentity);
  assert.deepEqual(weaker.baseline.suite.executed.map((entry) => entry.path), [other]);
  const folder = await invoke(["mutate", "--scope", "work dir/src", "--test", "work dir/python checks"]);
  assert.equal(folder.status, "NO_VERIFICADO", JSON.stringify(folder));
  assert.equal(folder.code, "coverage_incomplete");
  assert.equal(folder.reused, false);
  assert.notEqual(folder.evidenceIdentity, weaker.evidenceIdentity);
  for (const args of [["--scope"], ["--test", "../outside"], ["--scope", "missing.py"], ["--test", "missing.py"]]) {
    const invalid = await invoke(["mutate", ...args]);
    assert.equal(invalid.processCode, 4, JSON.stringify(invalid));
    assert.equal(invalid.code, "invalid_selection");
    assert.equal(invalid.baseline, undefined);
  }
  assert.deepEqual(await readFile(configPath), configBytes);
  assert.deepEqual(await readFile(path.join(root, source)), sourceBytes);
  for (const artifact of ["dry.json", "crap.json", "verification.json", "active-task.json", "budget.json"]) {
    await assert.rejects(access(path.join(root, ".agentic-core/quality", artifact)), { code: "ENOENT" });
  }
  await writeFile(path.join(root, source), "import math\n");
  await writeFile(path.join(root, chosen), "from src.subject import math\ndef test_value():\n    assert math.sqrt(4) == 2\n");
  const empty = await invoke(selectedArgs);
  assert.equal(empty.processCode, 0, JSON.stringify(empty));
  assert.equal(empty.status, "NO_APLICA");
  assert.equal(empty.code, "no_mutants");
  assert.equal(empty.score.denominator, 0);
  assert.equal(empty.score.percentage, null);
  const reportPath = path.join(root, selected.reference);
  await writeFile(reportPath, "divergent report");
  const conflict = await invoke(selectedArgs);
  assert.equal(conflict.code, "mutation_report_conflict");
  assert.equal(await readFile(reportPath, "utf8"), "divergent report");
});
