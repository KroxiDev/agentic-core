import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compareCrap, verificationConsistency, verificationExit } from "../src/quality/python-verification.js";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

const parse = (result) => JSON.parse(result.stdout);
const prepare = (mode = "normal") => [
  "prepare", "--task", "issue-46", "--mode", mode, "--objective", "issue:46",
];
const duplicateSource = [
  "",
  "def first(values):",
  "    result = []",
  "    for value in values:",
  "        if value > 0:",
  "            result.append(value + 1)",
  "        else:",
  "            result.append(value - 1)",
  "    return result",
  "",
  "def second(items):",
  "    result = []",
  "    for item in items:",
  "        if item > 0:",
  "            result.append(item + 1)",
  "        else:",
  "            result.append(item - 1)",
  "    result.reverse()",
  "    return result",
  "",
].join("\n");
const resolutionReason = "first conserva el orden de entrada; second usa result.reverse() para entregar la secuencia invertida requerida por su consumidor.";

test("installed Light and Normal verification emit a receipt backed by all required controls", async (t) => {
  for (const mode of ["light", "normal"]) {
    const { root } = await pythonProject(t);
    const prepared = await runPythonProject(root, prepare(mode));
    assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);

    const verified = await runPythonProject(root, ["verify"]);
    const report = parse(verified);
    assert.equal(verified.code, 0, verified.stdout + verified.stderr);
    assert.equal(report.status, "approved");
    assert.equal(report.code, "quality_approved");
    assert.equal(report.result.code, "tests_passed");
    assert.equal(report.verification.controls.baseline.status, "approved");
    assert.equal(report.verification.controls.evidence.status, "approved");
    assert.equal(report.verification.controls.tests.status, "approved");
    assert.equal(report.verification.controls.dry.status, "approved");
    assert.equal(report.verification.controls.crap.status, "approved");
    assert.equal(report.verification.controls.mutation.status, "NO_APLICA");
    assert.match(report.receipt, /^QUALITY_OK task=issue-46 mode=/u);
    assert.equal(report.verification.mode, mode);
    assert.deepEqual(report.verification.scopes, ["work dir/src"]);

    const reportPath = path.join(root, report.report);
    const saved = await readFile(reportPath);
    assert.equal(report.sha256, createHash("sha256").update(saved).digest("hex"));
    assert.deepEqual(JSON.parse(saved), report.verification);
    if (mode === "normal") {
      const human = await runPythonProject(root, ["verify"], { AGENTIC_CORE_OUTPUT: "text" });
      assert.equal(human.code, 0, human.stdout + human.stderr);
      assert.match(human.stdout, /^QUALITY_OK task=issue-46 mode=normal /u);
      assert.ok(!human.stdout.includes(root));
      const validReport = JSON.parse(await readFile(reportPath, "utf8"));
      validReport.crap.details[0].value = 999;
      const corrupted = JSON.stringify(validReport);
      await writeFile(reportPath, corrupted);
      const refused = await runPythonProject(root, ["verify"]);
      assert.equal(refused.code, 2, refused.stdout + refused.stderr);
      assert.equal(parse(refused).code, "quality_report_conflict");
      assert.equal(await readFile(reportPath, "utf8"), corrupted);
      assert.doesNotMatch(refused.stdout, /QUALITY_OK/u);
    }
  }
});

test("C.R.A.P. identity reserves existing symbols and only attributes unique relocations", () => {
  const row = (file, value, fingerprint = "original") => ({
    id: file, file, name: "classify", kind: "function", fingerprint,
    value, status: value <= 7 ? "approved" : "rejected",
  });
  const baseline = { status: "rejected", details: [row("z.py", 12)] };
  const compare = (rows) => compareCrap({ status: "rejected", details: rows }, baseline, 7);
  const copied = compare([row("a.py", 12), row("z.py", 4, "improved")]);
  assert.equal(copied.status, "rejected");
  assert.equal(copied.details[0].baseline.status, "new_symbol");
  assert.equal(copied.details[0].status, "rejected");
  assert.equal(copied.details[1].baseline.status, "attributed");
  assert.equal(copied.details[1].baseline.value, 12);
  assert.equal(copied.details[1].status, "approved");
  const relocated = compare([row("a.py", 12)]);
  assert.equal(relocated.status, "approved");
  assert.equal(relocated.details[0].baseline.status, "relocated");
  const ambiguous = compare([row("a.py", 12), row("b.py", 12)]);
  assert.equal(ambiguous.status, "NO_VERIFICADO");
  assert.ok(ambiguous.details.every((detail) => detail.baseline.status === "ambiguous_identity"));
  const uncertain = compareCrap({ status: "approved", exitCode: 0,
    details: [row("a.py", 4), row("b.py", 4)] }, baseline, 7);
  assert.equal(uncertain.status, "NO_VERIFICADO");
  assert.equal(verificationExit(uncertain.status, uncertain.code, [uncertain]), 2);
});

test("verification consistency rejects inputs, configuration and environment changed between controls", () => {
  const consistent = { inputs: ["A", "A", "A", "A", "A"], configurations: ["C", "C"], identities: ["E", "E"] };
  assert.equal(verificationConsistency(consistent).status, "approved");
  for (const index of [1, 2, 3, 4]) {
    const changed = structuredClone(consistent);
    changed.inputs[index] = "B";
    assert.deepEqual(verificationConsistency(changed), { status: "NO_VERIFICADO", code: "quality_inputs_changed" });
  }
  for (const field of ["configurations", "identities"]) {
    const changed = structuredClone(consistent);
    changed[field][1] = "changed";
    assert.deepEqual(verificationConsistency(changed), { status: "NO_VERIFICADO", code: "quality_conditions_changed" });
  }
});

test("verification preserves typed failures through C.R.A.P. and aggregate exit codes", () => {
  for (const [code, exitCode] of [["dry_resolution_invalid", 4], ["crap_internal_error", 5], ["command_timeout", 6]]) {
    const failure = { status: "NO_VERIFICADO", code, exitCode };
    assert.equal(verificationExit("NO_VERIFICADO", code, [failure]), exitCode);
    const measured = compareCrap(failure, { status: "approved", details: [] }, 7);
    assert.equal(verificationExit("NO_VERIFICADO", code, [measured]), exitCode);
  }
  assert.equal(verificationExit("approved", "quality_approved", []), 0);
  assert.equal(verificationExit("rejected", "tests_failed", [{ code: "tests_failed", exitCode: 1 }]), 1);
  assert.equal(verificationExit("NO_VERIFICADO", "baseline_invalid", []), 2);
});

test("incremental C.R.A.P. rejects new code and degradation of existing code", async (t) => {
  const { root } = await pythonProject(t);
  const subject = path.join(root, "work dir/src/subject.py");
  const original = await readFile(subject, "utf8");
  const prepared = await runPythonProject(root, prepare());
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);

  await writeFile(subject, original.replace(
    "    if value > 0:",
    "    if value == 999:\n        return 'rare'\n    if value > 0:",
  ));
  const degraded = await runPythonProject(root, ["verify"]);
  const degradedReport = parse(degraded);
  assert.equal(degraded.code, 1, degraded.stdout + degraded.stderr);
  assert.equal(degradedReport.status, "rejected");
  assert.equal(degradedReport.code, "crap_limit_exceeded");
  const degradedRow = degradedReport.verification.crap.details.find((row) => row.name === "classify");
  assert.equal(degradedRow.incrementalStatus, "rejected");
  assert.equal(degradedRow.rule, "existing_must_not_worsen");
  assert.doesNotMatch(degradedReport.receipt, /^QUALITY_OK/u);

  const { root: newCodeRoot } = await pythonProject(t);
  const newSubject = path.join(newCodeRoot, "work dir/src/subject.py");
  const newPrepared = await runPythonProject(newCodeRoot, prepare());
  assert.equal(newPrepared.code, 0, newPrepared.stdout + newPrepared.stderr);
  const newSource = await readFile(newSubject, "utf8");
  await writeFile(newSubject, [
    newSource,
    "def risky(value):",
    "    if value == 0:",
    "        return 0",
    "    if value == 1:",
    "        return 1",
    "    if value == 2:",
    "        return 2",
    "    if value == 3:",
    "        return 3",
    "    if value == 4:",
    "        return 4",
    "    if value == 5:",
    "        return 5",
    "    return -1",
    "",
  ].join("\n"));
  const added = await runPythonProject(newCodeRoot, ["verify"]);
  const addedReport = parse(added);
  assert.equal(added.code, 1, added.stdout + added.stderr);
  assert.equal(addedReport.status, "rejected");
  assert.equal(addedReport.code, "crap_limit_exceeded");
  const addedRow = addedReport.verification.crap.details.find((row) => row.name === "risky");
  assert.equal(addedRow.baseline.status, "new_symbol");
  assert.equal(addedRow.incrementalStatus, "rejected");
  assert.ok(addedRow.value > addedRow.limit);
});

test("incremental DRY requires a concrete resolution and then permits the aggregate approval", async (t) => {
  const { root } = await pythonProject(t);
  const subject = path.join(root, "work dir/src/subject.py");
  const checks = path.join(root, "work dir/python checks/check_subject.py");
  const prepared = await runPythonProject(root, prepare());
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const subjectSource = await readFile(subject, "utf8");
  await writeFile(subject, subjectSource + duplicateSource);
  const existingChecks = await readFile(checks, "utf8");
  const changedChecks = existingChecks.replace(
    "from src.subject import classify",
    "from src.subject import classify, first, second",
  ) + "\n\ndef test_duplicate_functions_are_exercised():\n    assert first([1, 0]) == [2, -1]\n    assert second([1, 0]) == [-1, 2]\n";
  await writeFile(checks, changedChecks);

  const measured = await runPythonProject(root, ["dry"]);
  const dryReport = parse(measured);
  assert.equal(measured.code, 1, measured.stdout + measured.stderr);
  assert.ok(dryReport.candidates.length > 0);
  const unresolved = await runPythonProject(root, ["verify"]);
  const unresolvedReport = parse(unresolved);
  assert.equal(unresolved.code, 1, unresolved.stdout + unresolved.stderr);
  assert.equal(unresolvedReport.status, "rejected");
  assert.equal(unresolvedReport.code, "dry_candidates_unresolved");
  assert.equal(unresolvedReport.verification.controls.dry.status, "rejected");

  const resolution = {
    schemaVersion: 1,
    inputs: dryReport.hashes.inputs,
    configuration: dryReport.hashes.configuration,
    resolutions: dryReport.candidates.map((candidate) => ({
      candidate: candidate.id,
      decision: "keep",
      reason: resolutionReason,
    })),
  };
  await writeFile(path.join(root, ".agentic-core/quality/dry-resolutions.json"), JSON.stringify(resolution) + "\n");
  const resolved = await runPythonProject(root, ["verify"]);
  const resolvedReport = parse(resolved);
  assert.equal(resolved.code, 0, resolved.stdout + resolved.stderr);
  assert.equal(resolvedReport.status, "approved");
  assert.equal(resolvedReport.code, "quality_approved");
  assert.equal(resolvedReport.verification.dry.code, "dry_resolved");
  assert.equal(resolvedReport.verification.dry.summary.resolved, dryReport.candidates.length);
  assert.match(resolvedReport.receipt, /^QUALITY_OK/u);
});

test("configuration changes and foreign verification evidence cannot produce a current approval", async (t) => {
  const { root } = await pythonProject(t);
  const prepared = await runPythonProject(root, prepare());
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  await configurePythonProject(root, (config) => { config.limits.crap = 1.5; });
  const changed = await runPythonProject(root, ["verify"]);
  const changedReport = parse(changed);
  assert.equal(changed.code, 2, changed.stdout + changed.stderr);
  assert.equal(changedReport.status, "NO_VERIFICADO");
  assert.equal(changedReport.code, "quality_conditions_changed");
  assert.equal(changedReport.verification.controls.evidence.code, "quality_conditions_changed");
  assert.doesNotMatch(changedReport.receipt, /^QUALITY_OK/u);

  const { root: foreignRoot } = await pythonProject(t);
  const foreignPrepared = await runPythonProject(foreignRoot, prepare());
  assert.equal(foreignPrepared.code, 0, foreignPrepared.stdout + foreignPrepared.stderr);
  const foreignPath = path.join(foreignRoot, ".agentic-core/quality/verification.json");
  const foreign = "evidencia ajena\n";
  await writeFile(foreignPath, foreign);
  const conflict = await runPythonProject(foreignRoot, ["verify"]);
  const conflictReport = parse(conflict);
  assert.equal(conflict.code, 2, conflict.stdout + conflict.stderr);
  assert.equal(conflictReport.code, "quality_report_conflict");
  assert.equal(await readFile(foreignPath, "utf8"), foreign);
  assert.doesNotMatch(conflict.stdout, /QUALITY_OK/u);
});

test("Full remains unverified until mutation evidence is integrated", async (t) => {
  const { root } = await pythonProject(t);
  const prepared = await runPythonProject(root, prepare("full"));
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const verified = await runPythonProject(root, ["verify"]);
  const report = parse(verified);
  assert.equal(verified.code, 2, verified.stdout + verified.stderr);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "mutation_not_integrated");
  assert.equal(report.verification.mutation.status, "NO_VERIFICADO");
  assert.equal(report.verification.mutation.executed, false);
  assert.doesNotMatch(report.receipt, /^QUALITY_OK/u);
});
