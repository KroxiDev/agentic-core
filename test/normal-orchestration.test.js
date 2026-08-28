import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize } from "../src/init.js";
import { startOrchestration, submitHandoff } from "../src/orchestration.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function createProject(t) {
  const project = await mkdtemp(path.join(tmpdir(), "agentic core normal "));
  t.after(() => rm(project, { recursive: true, force: true }));
  await initialize(project);
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "greeting.js"), "export const greeting = 'hello';\n");
  return project;
}
function intention() {
  return {
    objective: "Add a configurable greeting",
    constraints: ["Keep the public CLI compatible"],
    criteria: ["The CLI prints the configured greeting", "Existing callers remain compatible"],
  };
}
function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    approach: "Expose the greeting through the existing CLI seam",
    criteria: [
      { id: "C1", text: "Print the selected greeting", sourceCriteria: ["The CLI prints the configured greeting"] },
      { id: "C2", text: "Preserve compatibility", sourceCriteria: ["Existing callers remain compatible"] },
    ],
    steps: [
      { id: "S1", objective: "Implement and verify the greeting", criteria: ["C1", "C2"],
        validation: "Run the public CLI integration tests", qualitySurfaces: ["src/greeting.js#greeting"] },
    ],
    qualitySurfaces: ["src/greeting.js#greeting"],
    documentationSuggestion: "Document the configurable greeting",
    ...overrides,
  };
}
function completedPlan(currentPlan = plan(), overrides = {}) {
  return { schemaVersion: 1, status: "completed", summary: "Plan is traceable and verifiable",
    payload: { findings: [], plan: currentPlan }, ...overrides };
}
function implementerHandoff() {
  return { schemaVersion: 1, status: "completed", summary: "Plan implemented test-first", payload: {
    findings: [], evidence: { red: "integration test failed", green: "integration test passed", refactor: "suite stayed green" },
    qualityTargets: ["src/greeting.js"],
  } };
}
function changesRequired(summary, category = "tests", extra = {}) {
  return { schemaVersion: 1, status: "changes_required", summary, payload: {
    findings: [{
      impact: "blocking",
      category,
      authority: { criterionIds: ["C1"] },
      scope: "changed",
      evidence: { kind: "static_proof", detail: `${category} blocker`, location: "src/greeting.js:1" },
      materialImpact: "The changed greeting violates an accepted criterion.",
      minimalFix: "Correct the localized greeting implementation.",
    }], ...extra,
  } };
}
async function writeGateReports(project, runId) {
  const runRoot = path.join(project, ".agentic-core", "runs", runId);
  const state = JSON.parse(await readFile(path.join(runRoot, "state.json"), "utf8"));
  await mkdir(path.join(runRoot, "artifacts"), { recursive: true });
  const references = {};
  for (const [tool, configuration] of [
    ["crap", { crapThreshold: 7 }],
    ["mutation", { mutationWorkers: 4 }],
  ]) {
    const content = `${JSON.stringify({
      $schema: "https://kroxidev.dev/agentic-core/quality-report.schema.json",
      schemaVersion: 1, tool, status: "approved",
      hashes: { inputs: state.baseline.hashes, configuration: hash(JSON.stringify(configuration)) },
    })}\n`;
    const relative = `artifacts/${tool}.json`;
    await writeFile(path.join(runRoot, relative), content);
    references[tool] = { path: relative, sha256: hash(content) };
  }
  return references;
}
function refactorCompleted(references) {
  return { schemaVersion: 1, status: "completed", summary: "Structure and both differential gates passed",
    payload: { findings: [], ...references } };
}
function testerCompleted() {
  return { schemaVersion: 1, status: "completed", summary: "Every criterion and gate passed", payload: {
    findings: [],
    criteria: [
      { criterionId: "C1", status: "passed", evidence: "observed configured output" },
      { criterionId: "C2", status: "passed", evidence: "existing integration remained green" },
    ],
    tests: { status: "passed", evidence: "node --test" },
    goldenRules: { status: "passed", evidence: "canonical policy reviewed" },
  } };
}
async function reachRefactor(project, started) {
  await submitHandoff({ projectRoot: project, runId: started.runId, handoff: completedPlan() });
  return submitHandoff({ projectRoot: project, runId: started.runId, handoff: implementerHandoff() });
}
async function reachTester(project, started) {
  await reachRefactor(project, started);
  const references = await writeGateReports(project, started.runId);
  return submitHandoff({ projectRoot: project, runId: started.runId, handoff: refactorCompleted(references) });
}

test("normal is selected by every activator with or without its explicit name", async (t) => {
  for (const request of ["Orquesta implement it", "/orquestar implement it", "$orquestar implement it",
    "Orquesta normal implement it", "/orquestar normal implement it", "$orquestar normal implement it"]) {
    await t.test(request, async (subtest) => {
      const project = await createProject(subtest);
      const result = await startOrchestration({ projectRoot: project, request, intention: intention() });
      assert.equal(result.mode, "normal");
      assert.equal(result.role.name, "Planificador");
      assert.equal(result.brief.sources[0].kind, "original_request");
      assert.deepEqual(result.brief.skills, []);
    });
  }
});

test("the planner uses grilling only for a declared HOW decision and cannot weaken criteria", async (t) => {
  const project = await createProject(t);
  const started = await startOrchestration({ projectRoot: project, request: "Orquesta normal implement it",
    intention: intention(), planningNeedsHowDecision: true, changesExecutableBehavior: true });
  assert.deepEqual(started.brief.skills, ["agentic-grilling"]);
  const invalid = plan({ criteria: [
    { id: "C1", text: "Print something", sourceCriteria: ["The CLI prints the configured greeting"] },
  ] });
  const retry = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: completedPlan(invalid) });
  assert.equal(retry.status, "protocol_retry");
  assert.match(retry.brief.protocolErrors.join(" "), /must not weaken/);
  const implementer = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: completedPlan() });
  assert.equal(implementer.role.name, "Implementador");
  assert.deepEqual(implementer.brief.skills, ["agentic-tdd"]);
  assert.equal(implementer.brief.plan.steps[0].criteria.length, 2);
  assert.equal(implementer.brief.plan.steps[0].validation, "Run the public CLI integration tests");
});

test("normal runs Planificador, Implementador, Refactor, Tester and Documentador end-to-end", async (t) => {
  const project = await createProject(t);
  const started = await startOrchestration({ projectRoot: project, request: "Orquesta add greeting",
    intention: intention(), changesExecutableBehavior: true });
  const implementer = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: completedPlan() });
  assert.equal(implementer.role.name, "Implementador");
  const refactor = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: implementerHandoff() });
  assert.equal(refactor.role.name, "Refactor");
  assert.deepEqual(refactor.brief.permissions.write, []);
  assert.match(refactor.brief.mission, /C\.R\.A\.P.*Mutation Testing/);
  const references = await writeGateReports(project, started.runId);
  const tester = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: refactorCompleted(references) });
  assert.equal(tester.role.name, "Tester");
  assert.deepEqual(tester.brief.permissions.write, ["tests_when_production_is_correct"]);
  assert.match(tester.brief.contradictionPolicy, /Never modify.*silently/);
  const documenter = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: testerCompleted() });
  assert.equal(documenter.role.name, "Documentador");
  assert.deepEqual(documenter.brief.permissions.write, ["documentation"]);
  const completed = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: {
    schemaVersion: 1, status: "completed", summary: "Documentation updated",
    payload: { findings: [{ impact: "advisory", category: "documentation", evidence: "README updated" }] },
  } });
  assert.equal(completed.status, "completed");
  await assert.rejects(readFile(path.join(project, ".agentic-core", "runs", started.runId, "state.json")), { code: "ENOENT" });
});

test("a Refactor blocker creates only a fresh Implementador and the fourth request blocks", async (t) => {
  const project = await createProject(t);
  const started = await startOrchestration({ projectRoot: project, request: "Orquesta normal add greeting",
    intention: intention(), changesExecutableBehavior: true });
  await submitHandoff({ projectRoot: project, runId: started.runId, handoff: completedPlan() });
  let previousInstance;
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    const refactor = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: implementerHandoff() });
    const result = await submitHandoff({ projectRoot: project, runId: started.runId,
      handoff: changesRequired(`refactor cycle ${cycle}`, "golden_rules") });
    if (cycle < 4) {
      assert.equal(result.role.name, "Implementador");
      assert.equal(result.reworkCount, cycle);
      assert.notEqual(result.role.instanceId, refactor.role.instanceId);
      if (previousInstance) assert.notEqual(result.role.instanceId, previousInstance);
      previousInstance = result.role.instanceId;
    } else {
      assert.equal(result.status, "blocked");
      assert.equal(result.reworkCount, 4);
    }
  }
});

test("a Tester production defect creates a new Planner and atomically replaces the current plan with its delta", async (t) => {
  const project = await createProject(t);
  const started = await startOrchestration({ projectRoot: project, request: "Orquesta normal add greeting",
    intention: intention() });
  await reachTester(project, started);
  const planner = await submitHandoff({ projectRoot: project, runId: started.runId,
    handoff: changesRequired("Production violates the specification", "specification", { productionDefect: true }) });
  assert.equal(planner.role.name, "Planificador");
  assert.equal(planner.brief.deltaRequired, true);
  const replacement = plan({ approach: "Correct the production seam while preserving compatibility" });
  const implementer = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: {
    schemaVersion: 1, status: "completed", summary: "Delta addresses the production defect", payload: {
      findings: [], delta: { reason: "Tester found a production defect", replacementPlan: replacement },
    },
  } });
  assert.equal(implementer.role.name, "Implementador");
  const runRoot = path.join(project, ".agentic-core", "runs", started.runId);
  assert.deepEqual(JSON.parse(await readFile(path.join(runRoot, "plan.json"), "utf8")), replacement);
  assert.deepEqual((await readdir(runRoot)).filter((name) => /plan.*history|delta/i.test(name)), []);
});

test("Tester changes invalidate all quality gates and contradictory test edits are rejected", async (t) => {
  const project = await createProject(t);
  const started = await startOrchestration({ projectRoot: project, request: "Orquesta normal add greeting",
    intention: intention() });
  await reachTester(project, started);
  const contradictory = testerCompleted();
  contradictory.payload.changedTests = true;
  contradictory.payload.productionCorrect = true;
  contradictory.payload.testContradiction = true;
  const retry = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: contradictory });
  assert.equal(retry.status, "protocol_retry");
  assert.match(retry.brief.protocolErrors.join(" "), /may not silently change a contradiction/);
  const changed = testerCompleted();
  changed.payload.changedTests = true;
  changed.payload.productionCorrect = true;
  const refactor = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: changed });
  assert.equal(refactor.role.name, "Refactor");
  assert.equal(refactor.brief.invalidatedBy, "tests");
  assert.equal(refactor.reworkCount, 0);
});

test("Documentador retries once and persistent failure completes with warnings without retrabajo", async (t) => {
  const project = await createProject(t);
  const started = await startOrchestration({ projectRoot: project, request: "Orquesta normal add greeting",
    intention: intention() });
  await reachTester(project, started);
  await submitHandoff({ projectRoot: project, runId: started.runId, handoff: testerCompleted() });
  const failed = { schemaVersion: 1, status: "failed", summary: "Documentation tool unavailable",
    payload: { findings: [{ impact: "blocking", category: "documentation", evidence: "writer unavailable" }] } };
  const retry = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: failed });
  assert.equal(retry.role.name, "Documentador");
  assert.equal(retry.reworkCount, 0);
  const warned = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: failed });
  assert.equal(warned.status, "completed_with_warnings");
  assert.equal(warned.reworkCount, 0);
});
