import assert from "node:assert/strict";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

test("installed test selection preserves the wrapper, inputs and transient evidence", async (t) => {
  const { root, config } = await pythonProject(t);
  const source = "work dir/src/subject.py";
  const chosen = "work dir/python checks/check_subject.py";
  const other = "work dir/python checks/check_other.py";
  await writeFile(path.join(root, other), "from src.subject import classify\ndef test_other():\n    assert classify(1) == 'positive'\n");
  await writeFile(path.join(root, "work dir/src/auxiliary.py"), "VALUE = 3\n");
  const originalTest = await readFile(path.join(root, chosen), "utf8");
  await writeFile(path.join(root, chosen), `from src.auxiliary import VALUE as AUX\n${originalTest}\n    assert AUX == 3\n`);
  // Optional engines have no executable available in this consumer.
  await rename(path.join(root, ".agentic-core/tools"), path.join(root, ".agentic-core/unavailable-tools"));
  const configPath = path.join(root, ".agentic-core/config.json");
  const configBytes = await readFile(configPath);
  const invoke = async (args) => {
    const result = await runPythonProject(root, ["test", ...args]);
    return { ...JSON.parse(result.stdout), processCode: result.code };
  };
  const selectedArgs = ["--scope", source, "--test", chosen];
  const selected = await invoke(selectedArgs);
  assert.equal(selected.processCode, 0, JSON.stringify(selected));
  assert.deepEqual(selected.effectiveCommand.args, config.integration.python.command.args);
  assert.equal(selected.suite.collected, 1);
  assert.deepEqual(selected.suite.executed.map((entry) => entry.path), [chosen]);
  assert.deepEqual(selected.selection.measuredFiles, [source]);
  assert.deepEqual(Object.keys(selected.coverage.files), [source]);
  assert.equal(selected.inputs.inventory.find((entry) => entry.path.endsWith("auxiliary.py")).kind, "test_input");
  assert.equal(selected.integrity.status, "preserved");

  const folder = await invoke(["--scope", "work dir/src", "--test", "work dir/python checks"]);
  assert.equal(folder.processCode, 0, JSON.stringify(folder));
  assert.equal(folder.suite.executed.length, 2);
  assert.notEqual(folder.executionIdentity, selected.executionIdentity);
  assert.notEqual(folder.inputs.digest, selected.inputs.digest);

  const codeSelection = await invoke(["--scope", source, "--scope", "work dir/src/auxiliary.py", "--test", chosen]);
  assert.equal(codeSelection.processCode, 0, JSON.stringify(codeSelection));
  assert.deepEqual(codeSelection.suite.executed, selected.suite.executed);
  assert.notEqual(codeSelection.executionIdentity, selected.executionIdentity);

  const otherSelection = await invoke(["--scope", source, "--test", other]);
  assert.equal(otherSelection.processCode, 0, JSON.stringify(otherSelection));
  assert.deepEqual(otherSelection.suite.executed.map((entry) => entry.path), [other]);
  assert.notEqual(otherSelection.executionIdentity, selected.executionIdentity);
  const defaults = await invoke([]);
  assert.equal(defaults.processCode, 0, JSON.stringify(defaults));
  assert.equal(defaults.suite.executed.length, 2);
  assert.equal(defaults.selection.testSelection, "project_command");
  assert.notEqual(defaults.executionIdentity, selected.executionIdentity);
  assert.deepEqual(await readFile(configPath), configBytes);
  for (const artifact of ["dry.json", "crap.json", "mutation.json", "verification.json", "active-task.json"]) {
    await assert.rejects(access(path.join(root, ".agentic-core/quality", artifact)), { code: "ENOENT" });
  }

  await t.test("invalid and excluded selections never fall back to the project suite", async () => {
    for (const args of [["--scope"], ["--test", "../outside"], ["--scope", ".venv"],
      ["--test", "missing.py"], ["--scope", "missing.py"], ["--test", `${chosen}::test_real_suite`]]) {
      const invalid = await invoke(args);
      assert.equal(invalid.processCode, 4, JSON.stringify(invalid));
      assert.equal(invalid.code, "invalid_selection");
      assert.equal(invalid.suite?.executed, undefined);
    }
  });

  await t.test("real failures and unexecuted tests retain partial results", async () => {
    await writeFile(path.join(root, other), "from src.subject import classify\ndef test_other():\n    assert classify(1) == 'wrong'\n");
    const passingSubset = await invoke(selectedArgs);
    assert.equal(passingSubset.processCode, 0, JSON.stringify(passingSubset));
    const failed = await invoke(["--scope", source, "--test", chosen, "--test", other]);
    assert.equal(failed.processCode, 1, JSON.stringify(failed));
    assert.equal(failed.code, "tests_failed");
    assert.equal(failed.suite.executed.length, 2);
    assert.equal(failed.coverage.status, "measured");
    await configurePythonProject(root, (c) => { c.integration.python.command.args.push("--collect-only"); });
    const collected = await invoke(selectedArgs);
    assert.equal(collected.processCode, 2, JSON.stringify(collected));
    assert.equal(collected.code, "tests_not_executed");
    assert.deepEqual(collected.suite.executed, []);
    await writeFile(configPath, configBytes);
    await configurePythonProject(root, (c) => { c.integration.python.command.args.push("-k", "no_matching_test"); });
    const empty = await invoke(selectedArgs);
    assert.equal(empty.processCode, 2, JSON.stringify(empty));
    assert.equal(empty.code, "no_tests_collected");
    await writeFile(configPath, configBytes);
  });

  await t.test("unloaded code and changed inputs cannot approve", async () => {
    await writeFile(path.join(root, "work dir/src/unloaded.py"), "def unused():\n    return 1\n");
    const incomplete = await invoke(["--scope", "work dir/src", "--test", chosen]);
    assert.equal(incomplete.processCode, 2, JSON.stringify(incomplete));
    assert.equal(incomplete.code, "coverage_incomplete");
    assert.deepEqual(incomplete.coverage.unmeasuredFiles, ["work dir/src/unloaded.py"]);
    assert.ok(incomplete.coverage.files[source]);
    await writeFile(path.join(root, chosen), `${originalTest}\n    Path('src/subject.py').write_text('changed')\n`);
    const changed = await invoke(selectedArgs);
    assert.equal(changed.processCode, 2, JSON.stringify(changed));
    assert.equal(changed.code, "input_integrity_changed");
    assert.deepEqual(changed.integrity.copy, [source]);
    assert.match(await readFile(path.join(root, source), "utf8"), /def classify/u);
  });
  t.diagnostic(`Installed consumer: Python ${selected.python.version.join(".")}, pytest ${selected.python.pytestVersion}; optional tool environment unavailable`);
});
