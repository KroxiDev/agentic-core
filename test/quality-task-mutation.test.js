import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";
const parse = (result) => JSON.parse(result.stdout);
const prepare = () => ["prepare", "--task", "issue-92", "--mode", "normal", "--objective", "issue:92", "--control", "mutation"];

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

const taskMutationCorpora = {
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

async function taskMutationProject(t, { threshold, corpus = "complete", commandTimeoutMs, totalBudgetMs, late = false }) {
  const { root } = await pythonProject(t);
  await configurePythonProject(root, (config) => {
    config.limits.crap = 100;
    config.limits.mutationScore = threshold;
    if (commandTimeoutMs !== undefined) config.limits.operation.commandTimeoutMs = commandTimeoutMs;
    if (totalBudgetMs !== undefined) config.limits.operation.totalBudgetMs = totalBudgetMs;
  });
  const prepared = await runPythonProject(root, late ? prepare().slice(0, -2) : prepare());
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const selectedCorpus = taskMutationCorpora[corpus];
  assert.ok(selectedCorpus, `Unknown mutation corpus: ${corpus}`);
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

test("late mutation binds scope and tests, reuses evidence and leaves future tasks unrequested", async (t) => {
  const root = await taskMutationProject(t, { threshold: 40, late: true });
  const activePath = path.join(root, ".agentic-core/quality/active-task.json");
  const initial = await readFile(activePath);
  assert.deepEqual(JSON.parse(initial).task.requiredControls, []);
  const args = ["verify", "--control", "mutation", "--changes", "--test", "work dir/python checks/check_subject.py"];
  const first = parse(await runPythonProject(root, args));
  assert.equal(first.status, "approved", JSON.stringify(first));
  assert.equal(first.verification.mutation.selection.method, "baseline_delta");
  assert.equal(first.verification.mutation.inventory.preexisting, 2);
  assert.deepEqual(first.verification.mutation.scopeSelection.measuredFiles, ["work dir/src/subject.py"]);
  assert.deepEqual(first.verification.mutation.baseline.suite.executed.map((entry) => entry.path), ["work dir/python checks/check_subject.py"]);
  for (const control of ["dry", "crap"]) assert.equal(first.verification[control].executed, false);
  const reused = parse(await runPythonProject(root, args));
  assert.equal(reused.verification.reuse.mutation.reused, true, JSON.stringify(reused));
  assert.deepEqual(await readFile(activePath), initial);
  const next = await runPythonProject(root, ["prepare", "--task", "next", "--mode", "normal", "--objective", "next"]);
  assert.equal(next.code, 0, next.stdout);
  assert.equal(parse(await runPythonProject(root, ["verify"])).verification.mutation.status, "NO_SOLICITADO");
});

test("Optional mutation reports an explicit empty incremental mutation denominator", async (t) => {
  const { root } = await pythonProject(t);
  const prepared = await runPythonProject(root, prepare());
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

test("installed optional mutation selects a mutation whose changed operator is below its AST start line", async (t) => {
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
  const prepared = await runPythonProject(root, prepare());
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

test("installed optional mutation applies a configured threshold to the complete mutation inventory", async (t) => {
  const approvedRoot = await taskMutationProject(t, { threshold: 40 });
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

  const rejectedRoot = await taskMutationProject(t, { threshold: 90 });
  const rejected = parse(await runPythonProject(rejectedRoot, ["verify"]));
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.code, "mutation_score_below_limit");
  assert.equal(rejected.verification.mutation.status, "rejected");
  assert.equal(rejected.verification.mutation.score.threshold, 90);
  assert.equal(rejected.verification.mutation.score.percentage, 50);
  assert.equal(rejected.verification.mutation.summary.pending, 0);
  assert.doesNotMatch(rejected.receipt, /^QUALITY_OK/u);
});

test("installed optional mutation keeps an error inconclusive after the score passes", async (t) => {
  const root = await taskMutationProject(t, { threshold: 10, corpus: "inconclusive" });
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

test("installed optional mutation keeps a real command timeout inconclusive after the score passes", async (t) => {
  const root = await taskMutationProject(t, { threshold: 10, corpus: "timeout", commandTimeoutMs: 5000 });
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

test("installed optional mutation keeps a real pytest interruption inconclusive", async (t) => {
  const root = await taskMutationProject(t, { threshold: 10, corpus: "interrupted" });
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

test("installed optional mutation preserves pending mutants when the real shared budget is exhausted after the score passes", async (t) => {
  const root = await taskMutationProject(t, {
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

test("installed optional mutation excludes an engine-generated AST-equivalent mutation with static evidence", async (t) => {
  const root = await taskMutationProject(t, { threshold: 90, corpus: "equivalent" });
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
