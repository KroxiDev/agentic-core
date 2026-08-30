import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize } from "../src/init.js";
import {
  listOrchestrations,
  resumeOrchestration,
  startOrchestration,
  submitHandoff,
} from "../src/orchestration.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic core full "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "greeting.js"), "export const greeting = 'hello';\n");
  return root;
}

const intention = () => ({
  objective: "Add a greeting",
  constraints: ["Keep compatibility"],
  criteria: ["Print the greeting", "Preserve compatibility"],
});

const explorerDone = () => ({
  schemaVersion: 1,
  status: "completed",
  summary: "Sector identified",
  payload: {
    findings: [],
    exploration: {
      sector: ["src/greeting.js"],
      symbols: ["greeting"],
      dependencies: ["test/greeting.test.js"],
    },
  },
});
const plan = () => ({
  schemaVersion: 1,
  approach: "Use the existing seam",
  criteria: [
    { id: "C1", text: "Print greeting", sourceCriteria: ["Print the greeting"] },
    { id: "C2", text: "Keep callers", sourceCriteria: ["Preserve compatibility"] },
  ],
  steps: [{
    id: "S1", objective: "Implement", criteria: ["C1", "C2"],
    validation: "Run integration tests", qualitySurfaces: ["src/greeting.js#greeting"],
  }],
  qualitySurfaces: ["src/greeting.js#greeting"],
  documentationSuggestion: "Evaluate README",
});
const plannerDone = () => ({
  schemaVersion: 1,
  status: "completed",
  summary: "Plan ready",
  payload: { findings: [], plan: plan() },
});
const implementerDone = () => ({
  schemaVersion: 1,
  status: "completed",
  summary: "Implemented",
  payload: {
    findings: [],
    qualityTargets: ["src/greeting.js"],
    evidence: { red: "failed first", green: "passed", refactor: "stayed green" },
  },
});
async function crapReport(root, runId) {
  const runRoot = path.join(root, ".agentic-core", "runs", runId);
  const state = JSON.parse(await readFile(path.join(runRoot, "state.json"), "utf8"));
  await mkdir(path.join(runRoot, "artifacts"), { recursive: true });
  const content = `${JSON.stringify({
    $schema: "https://kroxidev.dev/agentic-core/quality-report.schema.json",
    schemaVersion: 1,
    tool: "crap",
    status: "approved",
    hashes: {
      inputs: state.baseline.hashes,
      configuration: hash(JSON.stringify({ crapThreshold: 7 })),
    },
    details: [],
  })}\n`;
  await writeFile(path.join(runRoot, "artifacts", "crap.json"), content);
  return { path: "artifacts/crap.json", sha256: hash(content) };
}
const refactorDone = (crap) => ({
  schemaVersion: 1,
  status: "completed",
  summary: "Structure approved",
  payload: {
    findings: [],
    structure: { status: "passed", evidence: "reviewed boundaries" },
    goldenRules: { status: "passed", evidence: "reviewed policy" },
    crap,
  },
});
const testerDone = () => ({
  schemaVersion: 1,
  status: "completed",
  summary: "Behavior verified",
  payload: {
    findings: [],
    criteria: [
      { criterionId: "C1", status: "passed", evidence: "output observed" },
      { criterionId: "C2", status: "passed", evidence: "compatibility passed" },
    ],
    tests: { status: "passed", evidence: "node --test" },
    goldenRules: { status: "passed", evidence: "policy reviewed" },
  },
});
async function mutationReport(root, runId) {
  const runRoot = path.join(root, ".agentic-core", "runs", runId);
  const state = JSON.parse(await readFile(path.join(runRoot, "state.json"), "utf8"));
  const targetInputs = Object.fromEntries(state.baseline.inputInventory
    .filter((entry) => entry.kind === "target_code")
    .map((entry) => [entry.path, entry.sha256]));
  const content = `${JSON.stringify({
    $schema: "https://kroxidev.dev/agentic-core/quality-report.schema.json",
    schemaVersion: 1,
    tool: "mutation",
    status: "approved",
    hashes: {
      inputs: targetInputs,
      configuration: hash(JSON.stringify({ mutationWorkers: 4 })),
    },
    details: [],
  })}\n`;
  await writeFile(path.join(runRoot, "artifacts", "mutation.json"), content);
  return { path: "artifacts/mutation.json", sha256: hash(content) };
}
const evaluatorDone = (mutation) => ({
  schemaVersion: 1,
  status: "completed",
  summary: "Evaluation approved",
  payload: {
    findings: [],
    comparison: {
      intention: { status: "passed", evidence: "original request compared" },
      criteria: { status: "passed", evidence: "all criteria preserved" },
      plan: { status: "passed", evidence: "changes match plan" },
      changes: { status: "passed", evidence: "diff inspected" },
      finalEvidence: { status: "passed", evidence: "current reports inspected" },
    },
    mutation,
  },
});
const blocker = (summary, extra = {}) => ({
  schemaVersion: 1,
  status: "changes_required",
  summary,
  payload: {
    findings: [{
      impact: "blocking",
      category: "tests",
      authority: { criterionIds: ["C1"] },
      scope: "changed",
      evidence: { kind: "static_proof", detail: "localized", location: "src/greeting.js:1" },
      materialImpact: "The changed behavior fails acceptance.",
      minimalFix: "Correct the localized implementation.",
    }],
    ...extra,
  },
});
async function toTester(root) {
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: explorerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: implementerDone() });
  await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: refactorDone(await crapReport(root, started.runId)),
  });
  return started;
}
async function toEvaluator(root) {
  const started = await toTester(root);
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: testerDone() });
  return started;
}

test("full starts with a fresh read-only Explorador", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });

  assert.equal(started.status, "started");
  assert.equal(started.mode, "full");
  assert.equal(started.role.name, "Explorador");
  assert.equal(started.role.sequence, 1);
  assert.deepEqual(started.brief.permissions, { read: true, write: [] });
  assert.match(started.brief.mission, /sector|symbols|dependencies/i);
  assert.doesNotMatch(started.brief.mission, /design|plan/i);
});

test("full runs persist and resume with their isolated current brief", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  const listed = await listOrchestrations(root);
  const resumed = await resumeOrchestration({ projectRoot: root, runId: started.runId });

  assert.equal(listed.length, 1);
  assert.equal(listed[0].mode, "full");
  assert.equal(listed[0].role.name, "Explorador");
  assert.equal(resumed.mode, "full");
  assert.deepEqual(resumed.brief, started.brief);
});

test("full control events create a fresh same-role agent without consuming retrabajo", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  const result = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: {
      schemaVersion: 1,
      status: "needs_input",
      summary: "Need exact compatibility target",
      payload: { findings: [], question: "Which caller defines compatibility?" },
    },
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.mode, "full");
  assert.equal(result.role.name, "Explorador");
  assert.notEqual(result.role.instanceId, started.role.instanceId);
  assert.equal(result.reworkCount, 0);
});

test("a full role can terminate with a material blocker without consuming retrabajo", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  const terminal = blocker("required source is unavailable");
  terminal.status = "failed";
  const result = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: terminal,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.mode, "full");
  assert.equal(result.reworkCount, 0);
});

test("Explorador hands an isolated scope to a fresh Planificador", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
    planningNeedsHowDecision: true,
  });
  const planner = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: explorerDone(),
  });

  assert.equal(planner.status, "continued");
  assert.equal(planner.role.name, "Planificador");
  assert.equal(planner.role.sequence, 2);
  assert.notEqual(planner.role.instanceId, started.role.instanceId);
  assert.deepEqual(planner.brief.exploration, explorerDone().payload.exploration);
  assert.deepEqual(planner.brief.permissions, { read: true, write: [] });
  assert.deepEqual(planner.brief.skills, ["agentic-grilling"]);
});

test("Planificador preserves criteria and creates a TDD Implementador", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
    changesExecutableBehavior: true,
  });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: explorerDone() });
  const implementer = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: plannerDone(),
  });

  assert.equal(implementer.role.name, "Implementador");
  assert.equal(implementer.role.sequence, 3);
  assert.deepEqual(implementer.brief.plan, plan());
  assert.deepEqual(implementer.brief.skills, ["agentic-tdd"]);
  assert.deepEqual(implementer.brief.permissions.write, ["production", "tests"]);
});

test("full protocol retries preserve only the conditional skills of the isolated role", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
    planningNeedsHowDecision: true,
  });
  const planner = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: explorerDone(),
  });
  assert.deepEqual(planner.brief.skills, ["agentic-grilling"]);

  const retry = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: {},
  });
  assert.equal(retry.status, "protocol_retry");
  assert.equal(retry.role.name, "Planificador");
  assert.deepEqual(retry.brief.skills, ["agentic-grilling"]);
});

test("Implementador creates a production-read-only Refactor without Mutation Testing", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: explorerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  const refactor = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: implementerDone(),
  });

  assert.equal(refactor.role.name, "Refactor");
  assert.deepEqual(refactor.brief.permissions, { read: true, write: ["quality_artifacts"] });
  assert.deepEqual(refactor.brief.quality.targets, ["src/greeting.js"]);
  assert.deepEqual(refactor.brief.qualityGate.command, { tool: "agentic-quality",
    args: ["crap", "--run", started.runId, "--output", "artifacts/crap.json"] });
  assert.doesNotMatch(JSON.stringify({
    mission: refactor.brief.mission,
    quality: refactor.brief.quality,
  }), /mutation/i);
});

test("Refactor validates structure and C.R.A.P. before creating an independent Tester", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: explorerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: implementerDone() });
  const tester = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: refactorDone(await crapReport(root, started.runId)),
  });

  assert.equal(tester.role.name, "Tester");
  assert.deepEqual(tester.brief.permissions.write, ["tests_when_production_is_correct"]);
  assert.match(tester.brief.contradictionPolicy, /never silently/i);
});

test("Tester creates an Evaluador that compares original authority and exclusively requests mutation", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: explorerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: implementerDone() });
  const crap = await crapReport(root, started.runId);
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: refactorDone(crap) });
  const evaluator = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: testerDone(),
  });

  assert.equal(evaluator.role.name, "Evaluador");
  assert.deepEqual(evaluator.brief.permissions, { read: true, write: ["quality_artifacts"] });
  assert.ok(evaluator.brief.sources.some((source) => source.kind === "original_request"));
  assert.equal(evaluator.brief.quality.mutation.required, true);
  assert.deepEqual(evaluator.brief.qualityGate.command, { tool: "agentic-quality",
    args: ["mutate", "--run", started.runId, "--output", "artifacts/mutation.json"] });
  assert.deepEqual(evaluator.brief.quality.crap, { repeat: false, report: crap });
});

test("Evaluador validates Mutation Testing before creating a mandatory fresh Documentador", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: explorerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: implementerDone() });
  await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: refactorDone(await crapReport(root, started.runId)),
  });
  const evaluator = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: testerDone(),
  });
  const documenter = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: evaluatorDone(await mutationReport(root, started.runId)),
  });

  assert.equal(documenter.role.name, "Documentador");
  assert.notEqual(documenter.role.instanceId, evaluator.role.instanceId);
  assert.deepEqual(documenter.brief.permissions.write, ["documentation"]);
  assert.match(documenter.brief.mission, /decide freshly/i);
  const done = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: { schemaVersion: 1, status: "completed", summary: "Docs evaluated", payload: { findings: [] } },
  });
  assert.equal(done.status, "completed");
});

test("Evaluador rejects a mutation report when any freshness input changed", async (t) => {
  const root = await project(t);
  const started = await toEvaluator(root);
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "test", "greeting.test.js"), "assert greeting output\n");
  const result = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: evaluatorDone(await mutationReport(root, started.runId)),
  });

  assert.equal(result.status, "protocol_retry");
  assert.equal(result.role.name, "Evaluador");
  assert.equal(result.reworkCount, 0);
});

test("resuming divergent full evidence returns to a fresh full Tester", async (t) => {
  const root = await project(t);
  const started = await toEvaluator(root);
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "test", "greeting.test.js"), "assert greeting output\n");
  const resumed = await resumeOrchestration({ projectRoot: root, runId: started.runId });

  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.mode, "full");
  assert.equal(resumed.role.name, "Tester");
  assert.equal(resumed.staleReports, true);
  assert.deepEqual(resumed.brief.permissions.write, ["tests_when_production_is_correct"]);
});

test("localized Refactor blockers create fresh Implementadores and the third request blocks full", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: explorerDone() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  const implementerIds = [];
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await submitHandoff({ projectRoot: root, runId: started.runId, handoff: implementerDone() });
    const result = await submitHandoff({
      projectRoot: root,
      runId: started.runId,
      handoff: blocker(`cycle ${cycle}`),
    });
    if (cycle < 3) {
      assert.equal(result.role.name, "Implementador");
      assert.equal(result.reworkCount, cycle);
      implementerIds.push(result.role.instanceId);
    } else {
      assert.equal(result.status, "blocked");
      assert.equal(result.reworkCount, 3);
    }
  }
  assert.equal(new Set(implementerIds).size, 2);
});

test("Tester routes localized corrections to Implementador and HOW changes to Planificador", async (t) => {
  await t.test("localized", async (subtest) => {
    const root = await project(subtest);
    const started = await toTester(root);
    const implementer = await submitHandoff({
      projectRoot: root,
      runId: started.runId,
      handoff: blocker("localized tester defect"),
    });
    assert.equal(implementer.role.name, "Implementador");
  });
  await t.test("HOW change", async (subtest) => {
    const root = await project(subtest);
    const started = await toTester(root);
    const planner = await submitHandoff({
      projectRoot: root,
      runId: started.runId,
      handoff: blocker("HOW changed", { requiresHowChange: true }),
    });
    assert.equal(planner.role.name, "Planificador");
  });
});

test("Planificador reopens exploration only with material evidence of insufficient scope", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta full greeting",
    intention: intention(),
  });
  const planner = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: explorerDone(),
  });
  const explorer = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: blocker("scope insufficient", {
      explorationInsufficient: true,
      missingScope: ["src/config.js#loadGreeting"],
    }),
  });

  assert.equal(explorer.role.name, "Explorador");
  assert.notEqual(explorer.role.instanceId, started.role.instanceId);
  assert.notEqual(explorer.role.instanceId, planner.role.instanceId);
  assert.equal(explorer.reworkCount, 0);
  assert.deepEqual(explorer.brief.missingScope, ["src/config.js#loadGreeting"]);
});

test("Evaluador opens retrabajo only for a material finding", async (t) => {
  await t.test("material", async (subtest) => {
    const root = await project(subtest);
    const started = await toEvaluator(root);
    const implementer = await submitHandoff({
      projectRoot: root,
      runId: started.runId,
      handoff: blocker("material mutation survivor"),
    });
    assert.equal(implementer.role.name, "Implementador");
    assert.equal(implementer.reworkCount, 1);
  });
  await t.test("non-material", async (subtest) => {
    const root = await project(subtest);
    const started = await toEvaluator(root);
    const nonMaterial = blocker("hypothetical survivor");
    nonMaterial.payload.findings[0].advisoryReason = "hypothetical_scenario";
    const retry = await submitHandoff({
      projectRoot: root,
      runId: started.runId,
      handoff: nonMaterial,
    });
    assert.equal(retry.status, "protocol_retry");
    assert.equal(retry.mode, "full");
    assert.equal(retry.role.name, "Evaluador");
    assert.equal(retry.reworkCount, 0);
    const failed = await submitHandoff({
      projectRoot: root,
      runId: started.runId,
      handoff: nonMaterial,
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.mode, "full");
    assert.equal(failed.reworkCount, 0);
  });
});
