import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

const parse = (result) => JSON.parse(result.stdout);
const prepare = (id = "budget-task") => ["prepare", "--task", id, "--mode", "normal", "--objective", "issue:48"];
const ledger = async (root) => JSON.parse(await readFile(path.join(root, ".agentic-core/quality/budget.json"), "utf8")).ledger;

test("installed task shares baseline, retries and controls without charging reuse or idle time", async (t) => {
  const { root } = await pythonProject(t);
  const first = parse(await runPythonProject(root, prepare()));
  assert.equal(first.status, "prepared", JSON.stringify(first));
  assert.ok(first.budget.consumedMs > 0);
  assert.ok(first.budget.commands > 0);
  const initial = await ledger(root);
  assert.equal(parse(await runPythonProject(root, prepare())).reused, true);
  assert.deepEqual(await ledger(root), initial);
  const verified = parse(await runPythonProject(root, ["verify"]));
  assert.equal(verified.status, "approved", JSON.stringify(verified));
  assert.ok(verified.budget.consumedMs > initial.consumedMs);
  const current = await ledger(root);
  const reused = parse(await runPythonProject(root, ["verify"]));
  assert.equal(reused.reused, true, JSON.stringify(reused));
  assert.deepEqual(await ledger(root), current);
  await writeFile(path.join(root, "work dir/src/subject.py"), "def classify(value):\n    return 'positive' if value > 0 else 'other'\n");
  const retried = parse(await runPythonProject(root, ["verify"]));
  assert.ok(retried.budget.consumedMs > current.consumedMs);
  assert.equal(retried.verification.reuse.tests.reused, false);
  const beforeReplacement = await ledger(root);
  const replaced = parse(await runPythonProject(root, prepare("next-task")));
  assert.equal(replaced.status, "prepared", JSON.stringify(replaced));
  assert.equal((await ledger(root)).task, "next-task");
  assert.ok(replaced.budget.commands < beforeReplacement.commands);
});

test("installed commands distinguish rejection, command timeout and cumulative exhaustion", async (t) => {
  const { root } = await pythonProject(t);
  await runPythonProject(root, prepare());
  await writeFile(path.join(root, "work dir/src/subject.py"), "def classify(value):\n    return 'wrong'\n");
  const rejected = parse(await runPythonProject(root, ["test"]));
  assert.equal(rejected.status, "rejected", JSON.stringify(rejected));
  assert.equal(rejected.code, "tests_failed");
  const used = await ledger(root);
  await configurePythonProject(root, (config) => {
    config.limits.operation.totalBudgetMs = used.consumedMs + 150;
    config.limits.operation.commandTimeoutMs = 10000;
    config.integration.python.environment.SUITE_DELAY = "2";
  });
  const exhausted = parse(await runPythonProject(root, ["test"]));
  assert.equal(exhausted.code, "budget_exhausted", JSON.stringify(exhausted));
  assert.equal(exhausted.status, "NO_VERIFICADO");
  const stopped = await ledger(root);
  const retry = parse(await runPythonProject(root, ["test"]));
  assert.equal(retry.code, "budget_exhausted", JSON.stringify(retry));
  assert.deepEqual(await ledger(root), stopped);
  const partial = parse(await runPythonProject(root, ["verify"]));
  assert.equal(partial.status, "NO_VERIFICADO", JSON.stringify(partial));
  assert.equal(partial.code, "budget_exhausted");
  assert.equal(partial.exitCode, 6);
  assert.equal(partial.verification.tests.code, "budget_exhausted");
  assert.doesNotMatch(partial.receipt, /^QUALITY_OK/u);
  assert.equal(JSON.parse(await readFile(path.join(root, partial.report), "utf8")).status, "NO_VERIFICADO");
  await configurePythonProject(root, (config) => {
    config.limits.operation.totalBudgetMs = stopped.consumedMs + 10000;
    config.limits.operation.commandTimeoutMs = 150;
  });
  const timeout = parse(await runPythonProject(root, ["test"]));
  assert.equal(timeout.code, "command_timeout", JSON.stringify(timeout));
  assert.equal(timeout.status, "NO_VERIFICADO");
});

test("installed baseline exhaustion persists partial evidence and cannot reset on prepare", async (t) => {
  const { root } = await pythonProject(t);
  await configurePythonProject(root, (config) => { config.limits.operation.totalBudgetMs = 1; });
  const first = parse(await runPythonProject(root, prepare()));
  assert.equal(first.status, "NO_VERIFICADO", JSON.stringify(first));
  assert.equal(first.code, "budget_exhausted");
  assert.equal(first.task.baseline.valid, false);
  const before = await ledger(root);
  const again = parse(await runPythonProject(root, prepare()));
  assert.equal(again.status, "NO_VERIFICADO");
  assert.deepEqual(await ledger(root), before);
  const verify = parse(await runPythonProject(root, ["verify"]));
  assert.equal(verify.status, "NO_VERIFICADO");
  assert.equal(verify.verification.tests.code, "budget_exhausted");
});

test("installed concurrent operations, missing ledger and corrupt ledger fail closed", async (t) => {
  const { root } = await pythonProject(t);
  await runPythonProject(root, prepare());
  const outcomes = (await Promise.all([runPythonProject(root, ["test"]), runPythonProject(root, ["test"])] )).map(parse);
  assert.equal(outcomes.filter((result) => result.code === "budget_busy").length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((result) => result.code === "tests_passed").length, 1);
  const file = path.join(root, ".agentic-core/quality/budget.json");
  await writeFile(file, "{corrupt}");
  const refused = parse(await runPythonProject(root, ["verify"]));
  assert.equal(refused.code, "budget_invalid");
  assert.equal(await readFile(file, "utf8"), "{corrupt}");
  await unlink(file);
  const missing = parse(await runPythonProject(root, ["verify"]));
  assert.equal(missing.code, "budget_missing");
  assert.equal(missing.status, "NO_VERIFICADO");
  await configurePythonProject(root, (config) => { config.limits.operation.workers = 5; });
  const invalid = parse(await runPythonProject(root, ["test"]));
  assert.equal(invalid.code, "invalid_configuration");
  assert.equal(invalid.exitCode, 4);
});
