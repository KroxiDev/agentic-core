import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pythonProject, runPythonProject } from "./support/python-project.mjs";

const duplicates = `def first(values):
    result = []
    for value in values:
        if value > 0:
            result.append(value + 1)
        else:
            result.append(value - 1)
    return result

def second(items):
    result = []
    for item in items:
        if item > 0:
            result.append(item + 1)
        else:
            result.append(item - 1)
    result.reverse()
    return result
`;

test("installed task accepts late scoped DRY, rejects new debt and resets for the next task", async (t) => {
  const { root } = await pythonProject(t);
  const invoke = async (...args) => {
    const result = await runPythonProject(root, args);
    return { ...JSON.parse(result.stdout), processCode: result.code };
  };
  const file = "work dir/src/duplicates.py";
  await writeFile(path.join(root, file), duplicates);
  const prepared = await invoke("prepare", "--task", "dry-request", "--mode", "direct", "--objective", "issue:90");
  assert.equal(prepared.processCode, 0, JSON.stringify(prepared));
  const baselinePath = path.join(root, ".agentic-core/quality/active-task.json");
  const initial = await readFile(baselinePath);
  assert.equal(JSON.parse(initial).task.initial.quality.dry.executed, false);
  await writeFile(path.join(root, file), `${duplicates}\n# implementation change\n`);
  const args = ["verify", "--control", "dry", "--scope", file];
  const previous = await invoke(...args);
  assert.equal(previous.processCode, 0, JSON.stringify(previous));
  assert.ok(previous.verification.dry.summary.preexisting > 0);
  assert.equal(previous.verification.dry.baseline.scan, "measured");
  assert.deepEqual(previous.result.coverage.files, {});
  assert.equal(previous.result.suite.status, "passed");
  const requiresCoverage = await invoke("crap", "--scope", file);
  assert.equal(requiresCoverage.processCode, 2, JSON.stringify(requiresCoverage));
  assert.equal(requiresCoverage.code, "coverage_failed");
  for (const name of ["crap", "mutation"]) {
    assert.equal(previous.verification[name].executed, false);
    assert.equal(previous.verification[name].status, "NO_SOLICITADO");
  }
  const reused = await invoke(...args);
  assert.equal(reused.verification.reuse.dry.reused, true, JSON.stringify(reused));
  const explanation = await invoke("explain", "--json");
  assert.equal(explanation.evidence.current, true, JSON.stringify(explanation));
  const standalone = await invoke("dry", "--scope", file);
  assert.equal(standalone.processCode, 1, JSON.stringify(standalone));
  assert.equal(standalone.implementationApproval, false);
  await writeFile(path.join(root, file), duplicates + duplicates.replaceAll("first", "third").replaceAll("second", "fourth"));
  const rejected = await invoke(...args);
  assert.equal(rejected.processCode, 1, JSON.stringify(rejected));
  assert.ok(rejected.verification.dry.summary.unresolved > 0);
  assert.doesNotMatch(rejected.receipt, /QUALITY_OK/);
  await writeFile(path.join(root, file), `${duplicates}\n# corrected\n`);
  const corrected = await invoke("verify", "--control", "dry", "--changes");
  assert.equal(corrected.processCode, 0, JSON.stringify(corrected));
  assert.equal(corrected.verification.reuse.dry.reused, false);
  const folder = await invoke("verify", "--control", "dry", "--scope", "work dir/src");
  assert.equal(folder.processCode, 0, JSON.stringify(folder));
  assert.equal(folder.verification.reuse.dry.reused, false);
  assert.deepEqual(await readFile(baselinePath), initial);
  const next = await invoke("prepare", "--task", "next-task", "--mode", "direct", "--objective", "next");
  assert.equal(next.processCode, 0, JSON.stringify(next));
  const defaultResult = await invoke("verify");
  assert.equal(defaultResult.processCode, 0, JSON.stringify(defaultResult));
  assert.equal(defaultResult.verification.dry.status, "NO_SOLICITADO");
  const explicit = await invoke("prepare", "--task", "explicit-dry", "--mode", "direct", "--objective", "issue:90", "--control", "dry");
  assert.equal(explicit.processCode, 0, JSON.stringify(explicit));
  assert.equal((await invoke("verify")).verification.dry.required, true);
  const reportPath = path.join(root, ".agentic-core/quality/verification.json");
  const foreign = "divergent evidence\n";
  await writeFile(reportPath, foreign);
  const conflict = await invoke("verify");
  assert.equal(conflict.code, "quality_report_conflict");
  assert.equal(await readFile(reportPath, "utf8"), foreign);
  await writeFile(baselinePath, "invalid initial reference\n");
  const invalid = await invoke("verify", "--control", "dry");
  assert.equal(invalid.code, "task_evidence_invalid");
  assert.equal(invalid.processCode, 2);
  assert.equal(await readFile(baselinePath, "utf8"), "invalid initial reference\n");
});
