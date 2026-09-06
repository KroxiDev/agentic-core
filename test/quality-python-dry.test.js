import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

const duplicateSource = `def first(values):
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

async function dry(root) {
  const result = await runPythonProject(root, ["dry"]);
  assert.equal(result.stderr, "");
  return { ...result, report: JSON.parse(result.stdout) };
}

async function addDuplicates(root) {
  await writeFile(path.join(root, "work dir/src/duplicates.py"), duplicateSource);
}

test("installed dry4python reports candidates, preserves evidence and applies effective limits", async (t) => {
  const { root } = await pythonProject(t);
  await addDuplicates(root);
  const first = await dry(root);
  assert.equal(first.code, 1, first.stdout);
  assert.equal(first.report.status, "rejected");
  assert.deepEqual(first.report.engine, { name: "dry4python", version: "0.1.0" });
  assert.ok(first.report.candidates.length > 0);
  assert.ok(first.report.candidates.every((candidate) => candidate.evidence && candidate.left.file === "work dir/src/duplicates.py"
    && candidate.right.file === "work dir/src/duplicates.py"));
  assert.equal(first.report.summary.unresolved, first.report.candidates.length);
  assert.ok(first.report.candidates[0].score < 1, "the fixture must leave room for a stricter valid threshold");

  await configurePythonProject(root, (config) => { config.limits.dry.similarity = 1; });
  const strict = await dry(root);
  assert.equal(strict.code, 0, strict.stdout);
  assert.equal(strict.report.status, "approved");
  assert.equal(strict.report.code, "no_duplicates");
  assert.equal(strict.report.summary.candidates, 0);
  assert.notEqual(strict.report.identity, first.report.identity);
});

test("dry resolutions are concrete and become stale when measured inputs change", async (t) => {
  const { root } = await pythonProject(t);
  await addDuplicates(root);
  const first = await dry(root);
  const candidate = first.report.candidates[0];
  const resolutionFile = path.join(root, ".agentic-core/quality/dry-resolutions.json");
  await writeFile(resolutionFile, `${JSON.stringify({
    schemaVersion: 1,
    inputs: first.report.hashes.inputs,
    configuration: first.report.hashes.configuration,
    resolutions: [{ candidate: candidate.id, decision: "keep", reason: "Coincidencia conservada por el alcance deliberado del adaptador." }],
  })}\n`);
  const resolved = await dry(root);
  assert.equal(resolved.code, 0, resolved.stdout);
  assert.equal(resolved.report.status, "approved");
  assert.equal(resolved.report.candidates[0].classification, "resolved");
  assert.equal(resolved.report.candidates[0].resolution.reason, "Coincidencia conservada por el alcance deliberado del adaptador.");
  assert.deepEqual(resolved.report.resolutions.used, [candidate.id]);

  await writeFile(path.join(root, "work dir/src/duplicates.py"), duplicateSource.replace("result.reverse()", "result.sort()"));
  const stale = await dry(root);
  assert.equal(stale.code, 1, stale.stdout);
  assert.equal(stale.report.status, "rejected");
  assert.equal(stale.report.resolutions.status, "stale");
  assert.equal(stale.report.candidates[0].classification, "new_or_changed");
  assert.equal(stale.report.candidates[0].status, "unresolved");
});

test("DRY classifies unchanged baseline duplication as preexisting", async (t) => {
  const { root } = await pythonProject(t);
  await addDuplicates(root);
  const prepared = await runPythonProject(root, ["prepare", "--task", "issue-45", "--mode", "normal", "--objective", "issue-45"]);
  assert.equal(prepared.code, 0, prepared.stdout);
  const result = await dry(root);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.status, "approved");
  assert.equal(result.report.code, "preexisting_only");
  assert.equal(result.report.summary.preexisting, result.report.summary.candidates);
  assert.ok(result.report.candidates.length > 0);
  assert.ok(result.report.candidates.every((candidate) => candidate.classification === "preexisting"));
});

test("Python quality help exposes the installed DRY command", async (t) => {
  const { root } = await pythonProject(t);
  const result = await runPythonProject(root, ["--help"]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /agentic-quality dry/u);
  assert.match(result.stdout, /dry4python/u);
  assert.match(result.stdout, /no interpreta el código de salida/u);
  assert.equal(await readFile(path.join(root, ".agentic-core/config.json"), "utf8").then((content) => content.includes('"dry"')), true);
});
