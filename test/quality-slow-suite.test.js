import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

test("PR-03 regression: configured command deadlines distinguish a slow suite from a timeout", async (t) => {
  const { root } = await pythonProject(t);
  await configurePythonProject(root, (c) => { c.integration.python.environment.SUITE_DELAY = "0.3"; c.limits.operation.commandTimeoutMs = 15000; });
  const completed = await runPythonProject(root);
  assert.equal(completed.code, 0, completed.stdout + completed.stderr);
  assert.equal(JSON.parse(completed.stdout).effectiveCommand.timeoutMs, 15000);
  await writeFile(path.join(root, "work dir/slow-wrapper.py"), `import subprocess,sys,time
subprocess.Popen([sys.executable, '-c', "import time; from pathlib import Path; time.sleep(4); Path('escaped.txt').write_text('escaped')"])
time.sleep(20)
`);
  await configurePythonProject(root, (c) => { c.integration.python.command.args = ["slow-wrapper.py"]; c.limits.operation.commandTimeoutMs = 1000; });
  const timedOut = await runPythonProject(root);
  assert.equal(timedOut.code, 6, timedOut.stdout);
  assert.equal(JSON.parse(timedOut.stdout).code, "command_timeout");
  assert.equal(JSON.parse(timedOut.stdout).coverage.files, null);
  await delay(4200);
  await assert.rejects(access(path.join(root, "work dir/escaped.txt")), { code: "ENOENT" });
  await configurePythonProject(root, (c) => { c.limits.operation.commandTimeoutMs = 15000; c.limits.operation.totalBudgetMs = 1000; });
  const budget = await runPythonProject(root);
  assert.equal(budget.code, 6, budget.stdout);
  assert.ok(JSON.parse(budget.stdout).effectiveCommand.timeoutMs <= 1000);
});
