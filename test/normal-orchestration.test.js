import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize } from "../src/init.js";
import { listOrchestrations, resumeOrchestration, startOrchestration, submitHandoff } from "../src/orchestration.js";
import { qualityInputInventory } from "../src/quality/inputs.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic core normal "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "greeting.js"), "export const greeting = 'hello';\n");
  return root;
}
const intention = () => ({
  objective: "Add a greeting", constraints: ["Keep compatibility"],
  criteria: ["Print the greeting", "Preserve compatibility"],
});
const plan = (overrides = {}) => ({
  schemaVersion: 1, approach: "Use the existing seam",
  criteria: [
    { id: "C1", text: "Print greeting", sourceCriteria: ["Print the greeting"] },
    { id: "C2", text: "Keep callers", sourceCriteria: ["Preserve compatibility"] },
  ],
  steps: [{ id: "S1", objective: "Implement", criteria: ["C1", "C2"],
    validation: "Run integration tests", qualitySurfaces: ["src/greeting.js#greeting"] }],
  qualitySurfaces: ["src/greeting.js#greeting"], documentationSuggestion: "Evaluate README", ...overrides,
});
const plannerDone = (current = plan()) => ({
  schemaVersion: 1, status: "completed", summary: "Plan ready",
  payload: { findings: [], plan: current },
});
const implementerDone = () => ({
  schemaVersion: 1, status: "completed", summary: "Implemented",
  payload: { findings: [], qualityTargets: ["src/greeting.js"],
    evidence: { red: "failed first", green: "passed", refactor: "stayed green" } },
});
const blocker = (summary, extra = {}) => ({
  schemaVersion: 1, status: "changes_required", summary, payload: {
    findings: [{ impact: "blocking", category: "tests", authority: { criterionIds: ["C1"] },
      scope: "changed", evidence: { kind: "static_proof", detail: "localized", location: "src/greeting.js:1" },
      materialImpact: "The changed behavior fails acceptance.", minimalFix: "Correct the localized implementation." }],
    ...extra,
  },
});
async function report(root, runId, refreshInputs = false) {
  const runRoot = path.join(root, ".agentic-core", "runs", runId);
  const state = JSON.parse(await readFile(path.join(runRoot, "state.json"), "utf8"));
  await mkdir(path.join(runRoot, "artifacts"), { recursive: true });
  const inventory = refreshInputs
    ? await qualityInputInventory(root, [path.join(root, "src", "greeting.js")], null, [])
    : null;
  const content = `${JSON.stringify({
    $schema: "https://kroxidev.dev/agentic-core/quality-report.schema.json",
    schemaVersion: 1, tool: "crap", status: "approved",
    hashes: { inputs: inventory?.hashes ?? state.baseline.hashes,
      configuration: hash(JSON.stringify({ crapThreshold: 7 })) },
  })}\n`;
  await writeFile(path.join(runRoot, "artifacts", "crap.json"), content);
  return { path: "artifacts/crap.json", sha256: hash(content) };
}
const verifierDone = (crap, extra = {}) => ({
  schemaVersion: 1, status: "completed", summary: "Verified", payload: {
    findings: [],
    criteria: [
      { criterionId: "C1", status: "passed", evidence: "output observed" },
      { criterionId: "C2", status: "passed", evidence: "compatibility passed" },
    ],
    tests: { status: "passed", evidence: "node --test" },
    goldenRules: { status: "passed", evidence: "policy reviewed" },
    structure: { status: "passed", evidence: "boundaries reviewed" },
    crap, ...extra,
  },
});
async function toVerifier(root, started) {
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  return submitHandoff({ projectRoot: root, runId: started.runId, handoff: implementerDone() });
}
async function toDocumenter(root, started, extra = {}) {
  await toVerifier(root, started);
  return submitHandoff({ projectRoot: root, runId: started.runId,
    handoff: verifierDone(await report(root, started.runId), extra) });
}

test("normal starts with Planificador and preserves criteria", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({ projectRoot: root, request: "Orquesta normal greeting",
    intention: intention(), planningNeedsHowDecision: true, changesExecutableBehavior: true });
  assert.equal(started.role.name, "Planificador");
  assert.deepEqual(started.brief.skills, ["agentic-grilling"]);
  const invalid = plan({ criteria: [{ id: "C1", text: "Something", sourceCriteria: ["Print the greeting"] }] });
  const retry = await submitHandoff({ projectRoot: root, runId: started.runId,
    handoff: plannerDone(invalid) });
  assert.equal(retry.status, "protocol_retry");
  assert.deepEqual(retry.brief.skills, ["agentic-grilling"]);
  const next = await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  assert.equal(next.role.name, "Implementador");
  assert.deepEqual(next.brief.skills, ["agentic-tdd"]);
});

test("a missing reason remains not_specified and does not activate agentic-grilling", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta normal greeting without a stated reason",
    intention: intention(),
  });
  assert.equal(started.brief.intention.reason, "not_specified");
  assert.deepEqual(started.brief.skills, []);
});

test("normal follows the four-role graph and never requests mutation", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({ projectRoot: root, request: "Orquesta greeting", intention: intention() });
  const implementer = await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  const verifier = await submitHandoff({ projectRoot: root, runId: started.runId, handoff: implementerDone() });
  assert.equal(verifier.role.name, "Verificador");
  assert.deepEqual(verifier.brief.permissions.write, ["tests_when_production_is_correct", "quality_artifacts"]);
  assert.deepEqual(verifier.brief.qualityGate.command, { tool: "agentic-quality",
    args: ["crap", "--run", started.runId, "--output", "artifacts/crap.json"] });
  const requestedWork = [started.brief, implementer.brief, verifier.brief].map(({ mission, quality }) => ({ mission, quality }));
  assert.doesNotMatch(JSON.stringify(requestedWork), /mutation/i);
  const documenter = await submitHandoff({ projectRoot: root, runId: started.runId,
    handoff: verifierDone(await report(root, started.runId)) });
  assert.equal(documenter.role.name, "Documentador");
  assert.deepEqual(documenter.brief.permissions.write, ["documentation"]);
  const done = await submitHandoff({ projectRoot: root, runId: started.runId,
    handoff: { schemaVersion: 1, status: "completed", summary: "Docs evaluated", payload: { findings: [] } } });
  assert.equal(done.status, "completed");
});

test("localized rework creates fresh Implementadores and the third request blocks", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({ projectRoot: root, request: "Orquesta greeting", intention: intention() });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  const ids = [];
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await submitHandoff({ projectRoot: root, runId: started.runId, handoff: implementerDone() });
    const result = await submitHandoff({ projectRoot: root, runId: started.runId, handoff: blocker(`cycle ${cycle}`) });
    if (cycle < 3) {
      assert.equal(result.role.name, "Implementador");
      assert.equal(result.reworkCount, cycle);
      ids.push(result.role.instanceId);
    } else {
      assert.equal(result.status, "blocked");
      assert.equal(result.reworkCount, 3);
    }
  }
  assert.equal(new Set(ids).size, 2);
});

test("a real HOW change creates a fresh Planificador and replaces the plan", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({ projectRoot: root, request: "Orquesta greeting", intention: intention() });
  await toVerifier(root, started);
  const planner = await submitHandoff({ projectRoot: root, runId: started.runId,
    handoff: blocker("HOW changed", { requiresHowChange: true }) });
  assert.equal(planner.role.name, "Planificador");
  const replacement = plan({ approach: "Use the configuration adapter" });
  const implementer = await submitHandoff({ projectRoot: root, runId: started.runId,
    handoff: { schemaVersion: 1, status: "completed", summary: "Delta ready",
      payload: { findings: [], delta: { reason: "Old seam cannot satisfy C1", replacementPlan: replacement } } } });
  assert.equal(implementer.role.name, "Implementador");
  assert.deepEqual(JSON.parse(await readFile(
    path.join(root, ".agentic-core", "runs", started.runId, "plan.json"), "utf8")), replacement);
});

test("Verificador repeats invalidated checks after permitted test edits", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({ projectRoot: root, request: "Orquesta greeting", intention: intention() });
  await toVerifier(root, started);
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "test", "greeting.test.js"), "assert greeting output\n");
  const crap = await report(root, started.runId, true);
  const retry = await submitHandoff({ projectRoot: root, runId: started.runId,
    handoff: verifierDone(crap, { changedTests: true, productionCorrect: true }) });
  assert.equal(retry.status, "protocol_retry");
  const documenter = await submitHandoff({ projectRoot: root, runId: started.runId,
    handoff: verifierDone(crap, { changedTests: true, productionCorrect: true,
      testContradiction: false, checksRepeated: true }) });
  assert.equal(documenter.role.name, "Documentador");
  assert.equal(documenter.reworkCount, 0);
});

test("advisory findings proceed directly to Documentador", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({ projectRoot: root, request: "Orquesta greeting", intention: intention() });
  await toVerifier(root, started);
  const result = await submitHandoff({ projectRoot: root, runId: started.runId,
    handoff: verifierDone(await report(root, started.runId), {
      findings: [{ impact: "advisory", category: "style", evidence: "Optional preference" }],
    }) });
  assert.equal(result.role.name, "Documentador");
  assert.equal(result.reworkCount, 0);
});

test("Documentador is fresh, mandatory, non-blocking and retains its retry", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({ projectRoot: root, request: "Orquesta greeting", intention: intention() });
  const first = await toDocumenter(root, started);
  const failed = { schemaVersion: 1, status: "failed", summary: "Writer unavailable",
    payload: { findings: [{ impact: "blocking", category: "documentation", evidence: "unavailable" }] } };
  const retry = await submitHandoff({ projectRoot: root, runId: started.runId, handoff: failed });
  assert.equal(retry.role.name, "Documentador");
  assert.notEqual(retry.role.instanceId, first.role.instanceId);
  assert.equal(retry.reworkCount, 0);
  const warned = await submitHandoff({ projectRoot: root, runId: started.runId, handoff: failed });
  assert.equal(warned.status, "completed_with_warnings");
});

test("old normal graph states fail explicitly", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({ projectRoot: root, request: "Orquesta greeting", intention: intention() });
  const statePath = path.join(root, ".agentic-core", "runs", started.runId, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.normalGraphVersion;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(resumeOrchestration({ projectRoot: root, runId: started.runId }),
    (error) => error?.code === "state_incompatible");
  await assert.rejects(listOrchestrations(root), (error) => error?.code === "state_incompatible");
});
