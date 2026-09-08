import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pythonProject, runPythonProject } from "./support/python-project.mjs";

// Exercises real installed quality commands, not native agent dispatch.
test("Normal residual corrections retain the original task and accumulate verification budget", async (t) => {
  const { root } = await pythonProject(t);
  const source = path.join(root, "work dir/src/subject.py");
  const tests = path.join(root, "work dir/python checks/check_subject.py");
  const originalTests = await readFile(tests, "utf8");
  await writeFile(source, "def classify(value):\n    if value > 0:\n        return 'positive'\n    if value == 0:\n        return 'other'\n    return 'other'\n");
  await writeFile(tests, originalTests + "\ndef test_negative():\n    assert classify(-1) == 'other'\n");
  const prepared = await runPythonProject(root, [
    "prepare", "--task", "normal-residual", "--mode", "normal", "--objective", "issue:52",
  ]);
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const initial = JSON.parse(prepared.stdout);
  const activePath = path.join(root, ".agentic-core/quality/active-task.json");
  const active = await readFile(activePath);
  let consumed = initial.budget.consumedMs;
  let previousReceipt;

  // A green suite for the partial implementation does not settle the full request.
  for (const negative of ["other", "negative"]) {
    await writeFile(source, `def classify(value):
    if value > 0:
        return 'positive'
    if value == 0:
        return 'zero'
    return '${negative}'
`);
    await writeFile(tests, originalTests.replace("classify(0) == 'other'", "classify(0) == 'zero'")
      + `\ndef test_negative():\n    assert classify(-1) == '${negative}'\n`);
    const result = await runPythonProject(root, ["verify"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.match(report.receipt, /^QUALITY_OK task=normal-residual mode=normal/u);
    assert.notEqual(report.receipt, previousReceipt);
    assert.ok(report.result.suite.phases.call > 0, "pytest must really execute tests");
    assert.ok(report.budget.consumedMs > consumed);
    assert.equal(report.verification.controls.mutation.status, "NO_APLICA");
    assert.deepEqual(await readFile(activePath), active);
    consumed = report.budget.consumedMs;
    previousReceipt = report.receipt;
  }
});
