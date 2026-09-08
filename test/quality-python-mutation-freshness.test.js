import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { configurePythonProject, pythonProject } from "./support/python-project.mjs";

const execute = promisify(execFile);
const runner = path.join(import.meta.dirname, "support/mutation-fault-runner.mjs");
async function run(root, args, fault = null) {
  await writeFile(path.join(root, ".agentic-core/mutation-fault.json"), JSON.stringify(fault));
  const env = { ...process.env, AGENTIC_CORE_OUTPUT: "json" };
  delete env.AGENTIC_CORE_PYTHON;
  try {
    const result = await execute(process.execPath, [runner, ...args], { cwd: root, env, windowsHide: true, timeout: 60000 });
    return { exitCode: 0, ...JSON.parse(result.stdout) };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    assert.ok(error.stdout.trim(), error.stderr);
    return { exitCode: error.code, ...JSON.parse(error.stdout) };
  }
}

test("Explicit controls bind mutation to preceding evidence and rechecks freshness even on reuse", async (t) => {
  const { root } = await pythonProject(t);
  await configurePythonProject(root, (config) => { config.limits.crap = 100; config.limits.mutationScore = 40; });
  const prepared = await run(root, ["prepare", "--task", "control-freshness", "--mode", "normal", "--control", "dry", "--control", "crap", "--control", "mutation", "--objective", "PR 71"]);
  assert.equal(prepared.exitCode, 0, JSON.stringify(prepared));
  const subject = path.join(root, "work dir/src/subject.py");
  const source = await readFile(subject, "utf8") + "\ndef detected(value):\n    return value > 2\n\ndef survivor(value):\n    return value > 5\n";
  await writeFile(subject, source);
  const checks = path.join(root, "work dir/python checks/check_subject.py");
  await writeFile(checks, (await readFile(checks, "utf8"))
    .replace("from src.subject import classify", "from src.subject import classify, detected, survivor")
    .replace("    assert classify(0) == 'other'", "    assert classify(0) == 'other'\n    assert detected(2) is False\n    assert survivor(9) is True"));

  const control = await run(root, ["verify"]);
  assert.equal(control.status, "approved", JSON.stringify(control));
  assert.equal(control.verification.mutation.score.percentage, 50);
  const changed = await run(root, ["verify"], "before-configuration");
  assert.equal(changed.status, "NO_VERIFICADO", JSON.stringify(changed));
  assert.equal(changed.code, "quality_conditions_changed");
  assert.doesNotMatch(changed.receipt, /^QUALITY_OK/u);
  assert.equal(changed.verification.reuse.tests.reused, true);

  await configurePythonProject(root, (config) => { config.limits.mutationScore = 40; });
  const transient = await run(root, ["verify"], "transient-configuration");
  assert.equal(transient.status, "NO_VERIFICADO", JSON.stringify(transient));
  assert.equal(transient.code, "quality_conditions_changed");
  assert.doesNotMatch(transient.receipt, /^QUALITY_OK/u);
  const restored = await run(root, ["verify"]);
  assert.equal(restored.status, "approved", JSON.stringify(restored));
  for (const [fault, code] of [["after-configuration", "quality_conditions_changed"],
    ["after-inputs", "quality_inputs_changed"], ["after-resolutions", "dry_resolutions_changed"]]) {
    await t.test(fault, async () => {
      const result = await run(root, ["verify"], fault);
      assert.equal(result.status, "NO_VERIFICADO", JSON.stringify(result));
      assert.equal(result.code, code);
      assert.equal(result.verification.mutation.reused, true);
      assert.notEqual(result.exitCode, 0);
      assert.doesNotMatch(result.receipt, /^QUALITY_OK/u);
      await configurePythonProject(root, (config) => { config.limits.mutationScore = 40; });
      await writeFile(subject, source);
      await rm(path.join(root, ".agentic-core/quality/dry-resolutions.json"), { force: true });
    });
  }

  // A changed input forces real mutation work, then disposal fails after all
  // results exist. The subsequent identical verification must execute again.
  await writeFile(subject, source + "\n# force a fresh mutation run\n");
  const cleanup = await run(root, ["verify"], "cleanup");
  assert.equal(cleanup.status, "NO_VERIFICADO", JSON.stringify(cleanup));
  assert.equal(cleanup.code, "mutation_cleanup_failed");
  assert.equal(cleanup.exitCode, 5);
  assert.equal(cleanup.verification.mutation.complete, false);
  assert.equal(cleanup.verification.mutation.resources.cleanup, "failed");
  assert.doesNotMatch(cleanup.receipt, /^QUALITY_OK/u);
  const retry = await run(root, ["verify"]);
  assert.equal(retry.status, "approved", JSON.stringify(retry));
  assert.equal(retry.verification.mutation.reused, false);
  assert.equal(retry.verification.mutation.resources.cleanup, "completed");
});
