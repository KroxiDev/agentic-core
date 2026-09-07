import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { aggregateMutation, compareCrap, verificationConsistency, verificationExit } from "../src/quality/python-verification.js";
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
const completeMutationSource = [
  "",
  "def detected(value):",
  "    return value > 2",
  "",
  "def survivor(value):",
  "    return value > 5",
  "",
].join("\n");
const inconclusiveMutationSource = [
  "",
  "def detected(value):",
  "    return value > 2",
  "",
  "def survivor(value):",
  "    return value > 5",
  "",
  "def untouched(value):",
  "    return value > 3",
  "",
  "def broken(value):",
  "    if value > 2:",
  "        raise ImportError('synthetic missing dependency')",
  "",
].join("\n");

const fullMutationCorpora = {
  complete: {
    source: completeMutationSource,
    imports: "from src.subject import classify, detected, survivor",
    assertions: [
      "    assert detected(2) is False",
      "    assert survivor(9) is True",
    ].join("\n"),
  },
  inconclusive: {
    source: inconclusiveMutationSource,
    imports: "from src.subject import classify, detected, survivor, untouched, broken",
    assertions: [
      "    assert detected(2) is False",
      "    assert survivor(9) is True",
      "    assert broken(2) is None",
    ].join("\n"),
  },
  timeout: {
    source: [
      "",
      "def detected(value):",
      "    return value > 2",
      "",
      "def slow(value):",
      "    if value > 2:",
      "        import time",
      "        time.sleep(15)",
      "    return value",
      "",
    ].join("\n"),
    imports: "from src.subject import classify, detected, slow",
    assertions: [
      "    assert detected(2) is False",
      "    assert slow(2) == 2",
    ].join("\n"),
  },
  interrupted: {
    source: [
      "",
      "def interrupted(value):",
      "    if value > 2:",
      "        raise KeyboardInterrupt()",
      "    return value",
      "",
    ].join("\n"),
    imports: "from src.subject import classify, interrupted",
    assertions: "    assert interrupted(2) == 2",
  },
  budget: {
    source: [
      "",
      "def detected(value):",
      "    return value > 2",
      "",
      "def budget_limited(value):",
      "    return value > 2",
      "",
      "def pending(value):",
      "    return value > 7",
      "",
    ].join("\n"),
    imports: "from src.subject import classify, detected, budget_limited, pending",
    assertions: [
      "    time.sleep(2)",
      "    assert detected(2) is False",
      "    assert budget_limited(2) is False",
      "    assert pending(1) is False",
    ].join("\n"),
  },
  equivalent: {
    source: [
      "",
      "def detected(value):",
      "    return value > 2",
      "",
      "def equivalent(value):",
      "    return (value # >",
      "            > 1)",
      "",
    ].join("\n"),
    imports: "from src.subject import classify, detected, equivalent",
    assertions: [
      "    assert detected(2) is False",
      "    assert equivalent(1) is False",
    ].join("\n"),
  },
};

async function fullMutationProject(t, { threshold, corpus = "complete", commandTimeoutMs, totalBudgetMs }) {
  const { root } = await pythonProject(t);
  await configurePythonProject(root, (config) => {
    config.limits.crap = 100;
    config.limits.mutationScore = threshold;
    if (commandTimeoutMs !== undefined) config.limits.operation.commandTimeoutMs = commandTimeoutMs;
    if (totalBudgetMs !== undefined) config.limits.operation.totalBudgetMs = totalBudgetMs;
  });
  const prepared = await runPythonProject(root, prepare("full"));
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const selectedCorpus = fullMutationCorpora[corpus];
  assert.ok(selectedCorpus, `Unknown Full corpus: ${corpus}`);
  const subject = path.join(root, "work dir/src/subject.py");
  const source = await readFile(subject, "utf8");
  await writeFile(subject, source + selectedCorpus.source);
  const checks = path.join(root, "work dir/python checks/check_subject.py");
  const checksSource = await readFile(checks, "utf8");
  await writeFile(checks, checksSource
    .replace("from src.subject import classify", selectedCorpus.imports)
    .replace("    assert classify(0) == 'other'", `    assert classify(0) == 'other'\n${selectedCorpus.assertions}`));
  return root;
}

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

test("Full reports an explicit empty incremental mutation denominator", async (t) => {
  const { root } = await pythonProject(t);
  const prepared = await runPythonProject(root, prepare("full"));
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const verified = await runPythonProject(root, ["verify"]);
  const report = parse(verified);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  assert.equal(report.status, "approved");
  assert.equal(report.verification.mutation.status, "NO_APLICA");
  assert.equal(report.verification.mutation.code, "no_incremental_mutants");
  assert.equal(report.verification.mutation.score.percentage, null);
  assert.equal(report.verification.mutation.inventory.required, 0);
  assert.match(report.receipt, /^QUALITY_OK/u);
});

test("installed Full selects a mutation whose changed operator is below its AST start line", async (t) => {
  const { root } = await pythonProject(t);
  await configurePythonProject(root, (config) => {
    config.limits.crap = 100;
    config.limits.mutationScore = 90;
  });
  const subject = path.join(root, "work dir/src/subject.py");
  const baselineSource = await readFile(subject, "utf8");
  await writeFile(subject, baselineSource + "def multiline(value, limit):\n    return (value\n            > limit)\n");
  const checks = path.join(root, "work dir/python checks/check_subject.py");
  await writeFile(checks, (await readFile(checks, "utf8"))
    .replace("from src.subject import classify", "from src.subject import classify, multiline")
    .replace("    assert classify(0) == 'other'", "    assert classify(0) == 'other'\n    assert multiline(0, 0) is False"));
  const prepared = await runPythonProject(root, prepare("full"));
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const currentSource = await readFile(subject, "utf8");
  await writeFile(subject, currentSource.replace("            > limit", "            >= limit"));
  await writeFile(checks, (await readFile(checks, "utf8")).replace(
    "    assert multiline(0, 0) is False",
    "    assert multiline(0, 0) is True",
  ));

  const verified = await runPythonProject(root, ["verify"]);
  const report = parse(verified);
  const mutation = report.verification.mutation;
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  assert.equal(mutation.status, "approved");
  assert.equal(mutation.score.denominator, 1);
  assert.equal(mutation.score.detected, 1);
  assert.equal(mutation.selection.changedFiles.length, 1);
  assert.equal(mutation.selection.required.length, 1);
  assert.equal(mutation.details.length, 1);
  assert.equal(mutation.details[0].line, 6);
  assert.equal(mutation.details[0].endLine, 7);
  assert.match(report.receipt, /^QUALITY_OK/u);
});

test("installed Full applies a configured threshold to the complete mutation inventory", async (t) => {
  const approvedRoot = await fullMutationProject(t, { threshold: 40 });
  const approved = parse(await runPythonProject(approvedRoot, ["verify"]));
  assert.equal(approved.status, "approved");
  assert.equal(approved.verification.mutation.status, "approved");
  assert.equal(approved.verification.mutation.score.threshold, 40);
  assert.equal(approved.verification.mutation.score.denominator, 2);
  assert.equal(approved.verification.mutation.score.detected, 1);
  assert.equal(approved.verification.mutation.score.percentage, 50);
  assert.equal(approved.verification.mutation.summary.pending, 0);
  assert.equal(approved.verification.mutation.summary.inconclusive, 0);
  assert.equal(approved.verification.mutation.inventory.generated, 4);
  assert.equal(approved.verification.mutation.inventory.required, 2);
  assert.equal(approved.verification.mutation.inventory.preexisting, 2);
  assert.equal(approved.verification.mutation.selection.required.length, 2);
  assert.equal(approved.verification.mutation.details.length, 2);
  assert.match(approved.receipt, /^QUALITY_OK/u);

  const rejectedRoot = await fullMutationProject(t, { threshold: 90 });
  const rejected = parse(await runPythonProject(rejectedRoot, ["verify"]));
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.code, "mutation_score_below_limit");
  assert.equal(rejected.verification.mutation.status, "rejected");
  assert.equal(rejected.verification.mutation.score.threshold, 90);
  assert.equal(rejected.verification.mutation.score.percentage, 50);
  assert.equal(rejected.verification.mutation.summary.pending, 0);
  assert.doesNotMatch(rejected.receipt, /^QUALITY_OK/u);
});

test("installed Full keeps an error inconclusive after the score passes", async (t) => {
  const root = await fullMutationProject(t, { threshold: 10, corpus: "inconclusive" });
  const verified = await runPythonProject(root, ["verify"]);
  const report = parse(verified);
  const mutation = report.verification.mutation;
  assert.equal(verified.code, 2, verified.stdout + verified.stderr);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "mutation_inconclusive");
  assert.equal(mutation.status, "NO_VERIFICADO");
  assert.equal(mutation.score.threshold, 10);
  assert.equal(mutation.score.denominator, 4);
  assert.equal(mutation.score.detected, 1);
  assert.equal(mutation.score.percentage, 25);
  assert.ok(mutation.score.percentage > mutation.score.threshold);
  assert.equal(mutation.score.survived, 1);
  assert.equal(mutation.score.uncovered, 1);
  assert.equal(mutation.score.inconclusive, 1);
  assert.equal(mutation.summary.pending, 0);
  assert.equal(mutation.summary.timeout, 0);
  assert.equal(mutation.summary.error, 1);
  assert.equal(mutation.summary.interrupted, 0);
  assert.equal(mutation.inventory.generated, 6);
  assert.equal(mutation.inventory.required, 4);
  assert.equal(mutation.inventory.preexisting, 2);
  assert.equal(mutation.selection.required.length, 4);
  assert.equal(mutation.details.length, 4);
  assert.doesNotMatch(report.receipt, /^QUALITY_OK/u);
});

test("installed Full keeps a real command timeout inconclusive after the score passes", async (t) => {
  const root = await fullMutationProject(t, { threshold: 10, corpus: "timeout", commandTimeoutMs: 5000 });
  const verified = await runPythonProject(root, ["verify"]);
  const report = parse(verified);
  const mutation = report.verification.mutation;
  assert.equal(verified.code, 2, verified.stdout + verified.stderr);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "mutation_inconclusive");
  assert.equal(mutation.status, "NO_VERIFICADO");
  assert.equal(mutation.score.threshold, 10);
  assert.equal(mutation.score.denominator, 2);
  assert.equal(mutation.score.detected, 1);
  assert.equal(mutation.score.percentage, 50);
  assert.ok(mutation.score.percentage > mutation.score.threshold);
  assert.equal(mutation.summary.timeout, 1);
  assert.equal(mutation.summary.error, 0);
  assert.equal(mutation.summary.interrupted, 0);
  assert.equal(mutation.summary.pending, 0);
  assert.equal(mutation.inventory.generated, 4);
  assert.equal(mutation.inventory.required, 2);
  assert.equal(mutation.inventory.preexisting, 2);
  assert.equal(mutation.selection.required.length, 2);
  assert.equal(mutation.details.length, 2);
  assert.equal(mutation.details.find((item) => item.status === "timeout")?.code, "command_timeout");
  assert.doesNotMatch(report.receipt, /^QUALITY_OK/u);
});

test("installed Full keeps a real pytest interruption inconclusive", async (t) => {
  const root = await fullMutationProject(t, { threshold: 10, corpus: "interrupted" });
  const verified = await runPythonProject(root, ["verify"]);
  const report = parse(verified);
  const mutation = report.verification.mutation;
  assert.equal(verified.code, 6, verified.stdout + verified.stderr);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "pytest_interrupted");
  assert.equal(mutation.status, "NO_VERIFICADO");
  assert.equal(mutation.score.threshold, 10);
  assert.equal(mutation.score.denominator, 1);
  assert.equal(mutation.score.detected, 0);
  assert.equal(mutation.score.percentage, 0);
  assert.equal(mutation.score.inconclusive, 1);
  assert.equal(mutation.summary.interrupted, 1);
  assert.equal(mutation.summary.pending, 0);
  assert.equal(mutation.inventory.generated, 3);
  assert.equal(mutation.inventory.required, 1);
  assert.equal(mutation.inventory.preexisting, 2);
  assert.equal(mutation.selection.required.length, 1);
  assert.equal(mutation.details.length, 1);
  assert.equal(mutation.details[0].code, "pytest_interrupted");
  assert.doesNotMatch(report.receipt, /^QUALITY_OK/u);
});

test("installed Full preserves pending mutants when the real shared budget is exhausted after the score passes", async (t) => {
  const root = await fullMutationProject(t, {
    threshold: 10, corpus: "budget", commandTimeoutMs: 30000, totalBudgetMs: 12000,
  });
  const verified = await runPythonProject(root, ["verify"]);
  const report = parse(verified);
  const mutation = report.verification.mutation;
  assert.equal(verified.code, 6, verified.stdout + verified.stderr);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "budget_exhausted");
  assert.equal(mutation.status, "NO_VERIFICADO");
  assert.equal(mutation.score.threshold, 10);
  assert.equal(mutation.score.denominator, 3);
  assert.equal(mutation.score.detected, 1);
  assert.equal(mutation.score.percentage, 33.33);
  assert.ok(mutation.score.percentage > mutation.score.threshold);
  assert.equal(mutation.score.inconclusive, 2);
  assert.equal(mutation.summary.interrupted, 1);
  assert.equal(mutation.summary.pending, 1);
  assert.equal(mutation.summary.timeout, 0);
  assert.equal(mutation.inventory.generated, 5);
  assert.equal(mutation.inventory.required, 3);
  assert.equal(mutation.inventory.preexisting, 2);
  assert.equal(mutation.selection.required.length, 3);
  assert.equal(mutation.details.length, 2);
  assert.equal(mutation.details.at(-1).code, "budget_exhausted");
  assert.equal(mutation.budget.remainingMs, 0);
  assert.doesNotMatch(report.receipt, /^QUALITY_OK/u);
});

test("installed Full excludes an engine-generated AST-equivalent mutation with static evidence", async (t) => {
  const root = await fullMutationProject(t, { threshold: 90, corpus: "equivalent" });
  const verified = await runPythonProject(root, ["verify"]);
  const report = parse(verified);
  const mutation = report.verification.mutation;
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  assert.equal(report.status, "approved");
  assert.equal(mutation.status, "approved");
  assert.equal(mutation.score.threshold, 90);
  assert.equal(mutation.score.denominator, 2);
  assert.equal(mutation.score.detected, 2);
  assert.equal(mutation.score.percentage, 100);
  assert.equal(mutation.score.equivalent, 1);
  assert.equal(mutation.summary.pending, 0);
  assert.equal(mutation.summary.inconclusive, 0);
  assert.equal(mutation.inventory.generated, 5);
  assert.equal(mutation.inventory.required, 2);
  assert.equal(mutation.inventory.preexisting, 2);
  assert.equal(mutation.inventory.equivalent, 1);
  assert.equal(mutation.selection.required.length, 2);
  assert.equal(mutation.selection.equivalent.length, 1);
  assert.match(mutation.selection.equivalent[0].evidence.reason, /AST de Python/u);
  assert.match(mutation.selection.equivalent[0].evidence.staticProof, /sha256\(ast\(original\)\)/u);
  assert.equal(mutation.details.length, 2);
  assert.match(report.receipt, /^QUALITY_OK/u);
});

test("mutation aggregation preserves an exhausted budget as inconclusive", () => {
  const report = aggregateMutation({
    command: "mutation",
    code: "budget_exhausted",
    complete: false,
    integrity: { status: "preserved" },
    selection: {
      counts: { generated: 1 },
      required: [{ id: "budget" }],
      preexisting: [],
      equivalent: [],
    },
    details: [],
    pending: 1,
    exitCode: 6,
  }, 10);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "budget_exhausted");
  assert.equal(report.exitCode, 6);
  assert.equal(report.score.inconclusive, 1);
  assert.equal(report.summary.pending, 1);
});

test("mutation score compares the exact ratio and rounds only its presentation", () => {
  const buildReport = () => ({
    command: "mutation",
    code: "mutation_execution_complete",
    complete: true,
    integrity: { status: "preserved" },
    selection: {
      counts: { generated: 3 },
      required: [{ id: "killed-1" }, { id: "killed-2" }, { id: "survived-1" }],
      preexisting: [],
      equivalent: [],
    },
    details: [
      { id: "killed-1", status: "killed" },
      { id: "killed-2", status: "killed" },
      { id: "survived-1", status: "survived" },
    ],
  });

  const below = aggregateMutation(buildReport(), 66.67);
  assert.equal(below.score.percentage, 66.67);
  assert.equal(below.status, "rejected");
  assert.equal(below.code, "mutation_score_below_limit");

  const exact = aggregateMutation(buildReport(), (2 / 3) * 100);
  assert.equal(exact.score.percentage, 66.67);
  assert.equal(exact.status, "approved");
  assert.equal(exact.code, "mutation_score_approved");
});

test("mutation score never approves an inconclusive required mutant", () => {
  const report = aggregateMutation({
    command: "mutation",
    code: "mutation_execution_complete",
    complete: true,
    integrity: { status: "preserved" },
    selection: {
      counts: { generated: 5 },
      required: [
        { id: "killed-1" }, { id: "killed-2" }, { id: "timeout-1" },
        { id: "error-1" }, { id: "interrupted-1" },
      ],
      preexisting: [],
      equivalent: [],
    },
    details: [
      { id: "killed-1", status: "killed" },
      { id: "killed-2", status: "killed" },
      { id: "timeout-1", status: "timeout" },
      { id: "error-1", status: "error" },
      { id: "interrupted-1", status: "interrupted" },
    ],
  }, 40);
  assert.equal(report.score.percentage, 40);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "mutation_inconclusive");
  assert.equal(report.score.inconclusive, 3);
  assert.equal(report.summary.timeout, 1);
  assert.equal(report.summary.error, 1);
  assert.equal(report.summary.interrupted, 1);
});

test("mutation score accepts literal decimal equality without accepting a higher minimum", () => {
  for (const [detected, denominator, threshold] of [[29, 100, 29], [57, 100, 57], [58, 100, 58], [29, 200, 14.5]]) {
    const required = Array.from({ length: denominator }, (_, id) => ({ id: String(id) }));
    const report = { code: "mutation_execution_complete", complete: true, integrity: { status: "preserved" },
      selection: { required, preexisting: [], equivalent: [] },
      details: required.map((item, index) => ({ ...item, status: index < detected ? "killed" : "survived" })) };
    assert.equal(aggregateMutation(report, threshold).status, "approved", `${detected}/${denominator} = ${threshold}%`);
    assert.equal(aggregateMutation(report, threshold + 1e-12).status, "rejected");
    assert.equal(aggregateMutation(report, threshold - 1e-12).status, "approved");
  }
});

test("mutation aggregation preserves an operational failure after all mutants finish", () => {
  const result = aggregateMutation({ code: "mutation_cleanup_failed", message: "No se pudo limpiar la copia", exitCode: 5, complete: true,
    integrity: { status: "preserved" }, selection: { required: [{ id: "one" }], preexisting: [], equivalent: [] },
    details: [{ id: "one", status: "killed" }], pending: 0 }, 90);
  assert.equal(result.status, "NO_VERIFICADO");
  assert.equal(result.code, "mutation_cleanup_failed");
  assert.equal(result.message, "No se pudo limpiar la copia");
  assert.equal(result.exitCode, 5);
});
