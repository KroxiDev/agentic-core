import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestProject } from "./project-builder.js";
import { defaultConfiguration } from "../src/installation/config.js";
import { executeCommand } from "../src/quality/command.js";
import { budgetSummary, withTaskBudget } from "../src/quality/task-budget.js";

async function project(t, limits = {}) {
  const config = defaultConfiguration(process.execPath);
  Object.assign(config.limits.operation, limits);
  return createTestProject(t, { files: { ".agentic-core/config.json": JSON.stringify(config) } });
}

const run = (root, code) => executeCommand({ executable: process.execPath, args: ["-e", code] },
  { cwd: root, env: process.env, timeoutMs: 1000 });

test("mutation execution contract enforces worker cap and sums actual command time only", async (t) => {
  const root = await project(t, { workers: 1 });
  await withTaskBudget(root, "workers", async () => {
    const first = run(root, "setTimeout(() => {}, 100)");
    await assert.rejects(run(root, "process.exit(0)"), { code: "concurrency_limit" });
    await first;
    const before = budgetSummary();
    // Agent time between commands is not a verification charge.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(budgetSummary(), before);
    assert.equal((await run(root, "process.exit(1)")).exitCode, 1);
    assert.equal(budgetSummary().commands, 2);
    assert.ok(budgetSummary().consumedMs > before.consumedMs);
    assert.equal(budgetSummary().reservedMs, 0);
  }, { newTask: true });
});

test("interrupted reservations cannot be reused as free budget", async (t) => {
  const root = await project(t);
  await withTaskBudget(root, "crash", async () => {
    const { verificationBudget } = await import("../src/quality/command.js");
    await verificationBudget.getStore().reserve(100);
  }, { newTask: true });
  await assert.rejects(withTaskBudget(root, "crash", () => run(root, "process.exit(0)")), { code: "budget_interrupted" });
});

test("failed replacement preserves active consumption and charges pending retries", async (t) => {
  const root = await project(t);
  const file = path.join(root, ".agentic-core/quality/budget.json");
  await withTaskBudget(root, "original", () => run(root, "process.exit(0)"), { newTask: true });
  const initial = JSON.parse(await readFile(file, "utf8")).ledger;
  const fail = async () => { await run(root, "process.exit(0)"); throw new Error("publication failed"); };
  await assert.rejects(withTaskBudget(root, "replacement", fail, { newTask: true }), /publication failed/u);
  const pending = JSON.parse(await readFile(file, "utf8")).ledger;
  assert.equal(pending.consumedMs, initial.consumedMs);
  assert.equal(pending.task, "original");
  assert.ok(pending.pending.consumedMs > 0);
  await assert.rejects(withTaskBudget(root, "replacement", fail, { newTask: true }), /publication failed/u);
  const retried = JSON.parse(await readFile(file, "utf8")).ledger;
  assert.ok(retried.pending.consumedMs > pending.pending.consumedMs);
  assert.equal(retried.consumedMs, initial.consumedMs);
});

test("configuration rejects fractional, excessive and disabled operational limits", async (t) => {
  const root = await project(t);
  for (const [key, value] of [["totalBudgetMs", 0], ["totalBudgetMs", 0.5], ["commandTimeoutMs", 2147483648], ["workers", 5]]) {
    const config = defaultConfiguration(process.execPath);
    config.limits.operation[key] = value;
    await writeFile(path.join(root, ".agentic-core/config.json"), JSON.stringify(config));
    await assert.rejects(withTaskBudget(root, "invalid", () => run(root, "process.exit(0)"), { newTask: true }), { code: "invalid_configuration" });
  }
});
