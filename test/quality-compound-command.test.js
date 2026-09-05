import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

test("PR-02 regression: installed pytest preserves wrapper, preparation, arguments and configuration", async (t) => {
  const { root, config } = await pythonProject(t);
  const result = await runPythonProject(root);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.effectiveCommand.args, config.integration.python.command.args);
  assert.equal(report.suite.configuration, "work dir/config space.ini");
  await assert.rejects(access(path.join(root, "work dir/prepared.txt")), { code: "ENOENT" });
  assert.equal(report.suite.collected, 1);
  // A shell command string is never parsed into a different invocation.
  await configurePythonProject(root, (c) => { c.integration.python.command.executable = "python wrapper space.py && python -m pytest"; });
  const shellString = await runPythonProject(root);
  assert.equal(shellString.code, 2);
  assert.equal(JSON.parse(shellString.stdout).code, "command_unavailable");
});
