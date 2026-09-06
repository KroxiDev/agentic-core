import assert from "node:assert/strict";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const keepReason = "first conserva el orden de entrada; second usa result.reverse() para entregar la secuencia invertida requerida por su consumidor.";

async function dry(root) {
  const result = await runPythonProject(root, ["dry"]);
  assert.equal(result.stderr, "");
  return { ...result, report: JSON.parse(result.stdout) };
}

async function addDuplicates(root) {
  await writeFile(path.join(root, "work dir/src/duplicates.py"), duplicateSource);
}

test("DRY cannot hide selected functions with engine pragmas", async (t) => {
  const { root } = await pythonProject(t);
  for (const source of [`# dry4python: ignore-file\n${duplicateSource}`,
    duplicateSource.replace("def second", "# dry4python: ignore\ndef second")]) {
    await writeFile(path.join(root, "work dir/src/duplicates.py"), source);
    const result = await dry(root);
    assert.equal(result.report.status, "rejected", result.stdout);
    assert.ok(result.report.candidates.length > 0);
    assert.equal(await readFile(path.join(root, "work dir/src/duplicates.py"), "utf8"), source);
  }
});

test("DRY rejects trivial and generic resolutions even when they name the candidate", async (t) => {
  const { root } = await pythonProject(t);
  await addDuplicates(root);
  const first = await dry(root);
  for (const reason of ["ok.", "", "Coincidencia mecánica fuera del alcance de esta tarea.",
    "first y second se conservan porque están bien y no necesitan cambios",
    "first y second usan result y se conservan porque están bien y no necesitan cambios",
    "first y second usan result.reverse() y se conservan porque están bien y no necesitan cambios"] ) {
    await writeFile(path.join(root, ".agentic-core/quality/dry-resolutions.json"), JSON.stringify({
      schemaVersion: 1, inputs: first.report.hashes.inputs, configuration: first.report.hashes.configuration,
      resolutions: [{ candidate: first.report.candidates[0].id, decision: "keep", reason }],
    }));
    const result = await dry(root);
    assert.notEqual(result.report.status, "approved", reason);
    assert.ok(!result.report.candidates?.some((candidate) => candidate.classification === "resolved"), reason);
  }
});

test("DRY reports unmeasured procedural code and preserves function candidates", async (t) => {
  const { root } = await pythonProject(t);
  const script = "result = []\nfor value in range(10):\n    if value > 0:\n        result.append(value + 1)\n    else:\n        result.append(value - 1)\nprint(result)\n";
  await writeFile(path.join(root, "work dir/src/script.py"), script);
  await writeFile(path.join(root, "work dir/src/other.py"), script);
  let result = await dry(root);
  assert.equal(result.report.status, "NO_VERIFICADO", result.stdout);
  assert.equal(result.report.code, "dry_measurement_incomplete");
  assert.ok(result.report.issues.some((issue) => issue.file === "work dir/src/script.py" && issue.startLine));
  await addDuplicates(root);
  result = await dry(root);
  assert.equal(result.report.status, "NO_VERIFICADO", result.stdout);
  assert.ok(result.report.candidates.length > 0);
  await rm(path.join(root, "work dir/src/script.py"));
  await rm(path.join(root, "work dir/src/other.py"));
  await writeFile(path.join(root, "work dir/src/broken.py"), "def broken(:\n");
  result = await dry(root);
  assert.equal(result.report.status, "NO_VERIFICADO", result.stdout);
  assert.ok(result.report.candidates.length > 0);
  assert.ok(result.report.issues.some((issue) => issue.code === "dry_syntax_unsupported" && issue.file === "work dir/src/broken.py"));
  const saved = JSON.parse(await readFile(path.join(root, ".agentic-core/quality/dry.json"), "utf8"));
  assert.deepEqual(saved.result, result.report);
});

test("DRY rejects checkpoint issues and withdrawn resolutions introduced during measurement", async (t) => {
  const { root } = await pythonProject(t);
  await addDuplicates(root);
  const first = await dry(root);
  const resolutionPath = path.join(root, ".agentic-core/quality/dry-resolutions.json");
  const resolution = JSON.stringify({ schemaVersion: 1, inputs: first.report.hashes.inputs,
    configuration: first.report.hashes.configuration,
    resolutions: [{ candidate: first.report.candidates[0].id, decision: "keep", reason: keepReason }] });
  const toolsRoot = path.join(root, ".agentic-core/tools");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { privatePython } = await import("../src/installation/python.js");
  const { stdout } = await promisify(execFile)(privatePython(toolsRoot), ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], { windowsHide: true });
  const hook = path.join(stdout.trim(), "sitecustomize.py");
  const syntheticFile = path.join(root, "work dir/src/synthetic.py");
  for (const [action, expected] of [
    [`Path(${JSON.stringify(syntheticFile)}).write_text('password = "synthetic-test-value"\\n')`, "input_checkpoint_incompatible"],
    [`Path(${JSON.stringify(resolutionPath)}).unlink()`, "dry_resolutions_changed"],
  ]) {
    await writeFile(resolutionPath, resolution);
    // Simulate an independent edit exactly after the initial checkpoint, inside private tool startup.
    await writeFile(hook, `import sys\nfrom pathlib import Path\nif sys.argv[0].endswith('agentic_dry.py'):\n    ${action}\n`);
    const result = await dry(root);
    assert.equal(result.report.status, "NO_VERIFICADO", result.stdout);
    assert.equal(result.report.code, expected, result.stdout);
    await rm(hook);
    await rm(syntheticFile, { force: true });
  }
  await configurePythonProject(root, (config) => { config.limits.operation.commandTimeoutMs = 1000; });
  await writeFile(hook, "import sys, time\nif sys.argv[0].endswith('agentic_dry.py'):\n    time.sleep(30)\n");
  const timeout = await dry(root);
  assert.equal(timeout.report.status, "NO_VERIFICADO", timeout.stdout);
  assert.equal(timeout.report.code, "command_timeout", timeout.stdout);
  assert.equal(timeout.code, 6, timeout.stdout);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, ".agentic-core/quality/dry.json"), "utf8")).result, timeout.report);
});

test("DRY attributes candidate bodies across unrelated edits and moves without hiding new copies", async (t) => {
  const { root } = await pythonProject(t);
  await addDuplicates(root);
  const prepared = await runPythonProject(root, ["prepare", "--task", "dry-moves", "--mode", "normal", "--objective", "dry-moves"]);
  assert.equal(prepared.code, 0, prepared.stdout);
  await writeFile(path.join(root, "work dir/src/duplicates.py"), `# unrelated comment\n${duplicateSource}\nOTHER_SETTING = 17\n`);
  let result = await dry(root);
  assert.equal(result.report.code, "preexisting_only", result.stdout);
  await rename(path.join(root, "work dir/src/duplicates.py"), path.join(root, "work dir/src/moved.py"));
  result = await dry(root);
  assert.equal(result.report.code, "preexisting_only", result.stdout);
  await copyFile(path.join(root, "work dir/src/moved.py"), path.join(root, "work dir/src/new-copy.py"));
  result = await dry(root);
  assert.equal(result.report.status, "rejected", result.stdout);
  assert.equal(result.report.summary.preexisting, 1);
  assert.ok(result.report.summary.unresolved > 0);
});

test("DRY remeasures the original baseline with changed valid limits", async (t) => {
  const { root } = await pythonProject(t);
  await addDuplicates(root);
  const prepared = await runPythonProject(root, ["prepare", "--task", "dry-limits", "--mode", "normal", "--objective", "dry-limits"]);
  assert.equal(prepared.code, 0, prepared.stdout);
  const baselinePath = path.join(root, ".agentic-core/quality/active-task.json");
  const baseline = await readFile(baselinePath, "utf8");
  const first = await dry(root);
  assert.equal(first.report.code, "preexisting_only", first.stdout);
  await configurePythonProject(root, (config) => { config.limits.dry.similarity = 1; });
  const strict = await dry(root);
  assert.equal(strict.report.code, "no_duplicates", strict.stdout);
  assert.equal(strict.report.baseline.scan, "measured");
  assert.equal(strict.report.baseline.candidates.length, 0);
  assert.equal(await readFile(baselinePath, "utf8"), baseline);
});

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
    resolutions: [{ candidate: candidate.id, decision: "keep", reason: keepReason }],
  })}\n`);
  const resolved = await dry(root);
  assert.equal(resolved.code, 0, resolved.stdout);
  assert.equal(resolved.report.status, "approved");
  assert.equal(resolved.report.candidates[0].classification, "resolved");
  assert.equal(resolved.report.candidates[0].resolution.reason, keepReason);
  assert.deepEqual(resolved.report.resolutions.used, [candidate.id]);

  await writeFile(path.join(root, "work dir/src/duplicates.py"), duplicateSource.replace("result.reverse()", "result.sort()"));
  const stale = await dry(root);
  assert.equal(stale.code, 1, stale.stdout);
  assert.equal(stale.report.status, "rejected");
  assert.equal(stale.report.resolutions.status, "stale");
  assert.equal(stale.report.candidates[0].classification, "new_or_changed");
  assert.equal(stale.report.candidates[0].status, "unresolved");

  await writeFile(path.join(root, "work dir/src/duplicates.py"), "def first(value):\n    return value + 1\ndef second(item):\n    return item + 1\n");
  await rm(resolutionFile);
  await configurePythonProject(root, (config) => { config.limits.dry.minLines = 1; config.limits.dry.minNodes = 1; });
  const simple = await dry(root);
  assert.ok(simple.report.candidates.length > 0, simple.stdout);
  await writeFile(resolutionFile, JSON.stringify({ schemaVersion: 1, inputs: simple.report.hashes.inputs,
    configuration: simple.report.hashes.configuration,
    resolutions: simple.report.candidates.map((entry) => ({ candidate: entry.id, decision: "keep",
      reason: `${entry.left.qualname} y ${entry.right.qualname} comparten ${entry.left.bodyReferences[0]}; las interfaces independientes permiten evolucionar los incrementos por consumidor.` })),
  }));
  const simpleResolved = await dry(root);
  assert.equal(simpleResolved.report.status, "approved", simpleResolved.stdout);
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
