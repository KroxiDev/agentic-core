import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize } from "../src/init.js";
import {
  approveModeChange,
  startOrchestration,
  submitHandoff,
} from "../src/orchestration.js";

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic core contracts "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  return root;
}

const intention = () => ({
  objective: "Add a greeting",
  constraints: ["Keep compatibility"],
  criteria: ["Print the greeting"],
});
const modeChange = (requestedMode) => ({
  schemaVersion: 1,
  status: "needs_mode_change",
  summary: "Task needs a stronger graph",
  payload: { findings: [], requestedMode, reason: "Planning authority is required" },
});
const plan = () => ({
  schemaVersion: 1,
  approach: "Use the existing seam",
  criteria: [{ id: "C1", text: "Print greeting", sourceCriteria: ["Print the greeting"] }],
  steps: [{
    id: "S1", objective: "Implement", criteria: ["C1"],
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
    evidence: { red: "failed", green: "passed", refactor: "passed" },
  },
});
const blocker = () => ({
  schemaVersion: 1,
  status: "changes_required",
  summary: "Material compatibility defect",
  payload: {
    findings: [{
      impact: "blocking",
      category: "tests",
      authority: { criterionIds: ["Print the greeting"] },
      scope: "changed",
      evidence: { kind: "static_proof", detail: "localized", location: "src/greeting.js:1" },
      materialImpact: "The required behavior fails.",
      minimalFix: "Correct the changed greeting.",
    }],
  },
});

test("light escalates to normal only after explicit approval and resets the target budget", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta light greeting",
    intention: intention(),
  });
  const pending = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: modeChange("normal"),
  });
  assert.equal(pending.status, "needs_mode_change");
  assert.equal(pending.mode, "light");

  await assert.rejects(
    approveModeChange({
      projectRoot: root,
      runId: started.runId,
      targetMode: "normal",
      approved: false,
    }),
    (error) => error?.code === "approval_required",
  );
  const escalated = await approveModeChange({
    projectRoot: root,
    runId: started.runId,
    targetMode: "normal",
    approved: true,
  });

  assert.equal(escalated.status, "escalated");
  assert.equal(escalated.mode, "normal");
  assert.equal(escalated.role.name, "Planificador");
  assert.equal(escalated.reworkCount, 0);
  assert.deepEqual(escalated.brief.permissions, { read: true, write: [] });
  assert.equal(escalated.brief.escalation.from, "light");
  assert.equal(escalated.brief.escalation.to, "normal");
});

test("light escalates directly to the first full role", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta light greeting",
    intention: intention(),
  });
  await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: modeChange("full"),
  });
  const escalated = await approveModeChange({
    projectRoot: root,
    runId: started.runId,
    targetMode: "full",
    approved: true,
  });

  assert.equal(escalated.runId, started.runId);
  assert.equal(escalated.mode, "full");
  assert.equal(escalated.role.name, "Explorador");
  assert.equal(escalated.reworkCount, 0);
});

test("normal escalates to full while preserving its current plan and immutable sources", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta normal greeting",
    intention: intention(),
  });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: plannerDone() });
  await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: modeChange("full"),
  });
  const escalated = await approveModeChange({
    projectRoot: root,
    runId: started.runId,
    targetMode: "full",
    approved: true,
  });

  assert.equal(escalated.role.name, "Explorador");
  assert.deepEqual(escalated.brief.plan, plan());
  assert.ok(escalated.brief.sources.some((source) => source.kind === "original_request"));
  assert.ok(escalated.brief.sources.some((source) => source.kind === "current_plan"));
});

test("the common hand-off contract rejects role selection, reasoning, prompts and coordination data", async (t) => {
  for (const field of ["nextRole", "nextAgent", "internalReasoning", "fullPrompt", "coordinatorState"]) {
    await t.test(field, async (subtest) => {
      const root = await project(subtest);
      const started = await startOrchestration({
        projectRoot: root,
        request: "Orquesta light greeting",
        intention: intention(),
      });
      const result = await submitHandoff({
        projectRoot: root,
        runId: started.runId,
        handoff: {
          schemaVersion: 1,
          status: "completed",
          summary: "Implemented",
          payload: {
            findings: [],
            qualityTargets: ["src/greeting.js"],
            evidence: { red: "failed", green: "passed", refactor: "passed" },
            [field]: "forbidden",
          },
        },
      });

      assert.equal(result.status, "protocol_retry");
      assert.equal(result.reworkCount, 0);
      assert.match(result.brief.protocolErrors.join(" "), /prohibited coordination field/i);
    });
  }
});

test("escalation preserves the actionable blocker while resetting only the destination budget", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta light greeting",
    intention: intention(),
  });
  await submitHandoff({ projectRoot: root, runId: started.runId, handoff: implementerDone() });
  const rework = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: blocker(),
  });
  assert.equal(rework.status, "continued");
  assert.equal(rework.reworkCount, 1);
  await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: modeChange("full"),
  });
  const escalated = await approveModeChange({
    projectRoot: root,
    runId: started.runId,
    targetMode: "full",
    approved: true,
  });

  assert.equal(escalated.reworkCount, 0);
  assert.equal(escalated.brief.escalation.preservedHandoff.summary, blocker().summary);
});

test("only the Documentador outcome may originate completed_with_warnings", async (t) => {
  const root = await project(t);
  const started = await startOrchestration({
    projectRoot: root,
    request: "Orquesta light greeting",
    intention: intention(),
  });
  const result = await submitHandoff({
    projectRoot: root,
    runId: started.runId,
    handoff: {
      schemaVersion: 1,
      status: "completed_with_warnings",
      summary: "Caller attempted to bypass the graph",
      payload: { findings: [] },
    },
  });

  assert.equal(result.status, "protocol_retry");
  assert.match(result.brief.protocolErrors.join(" "), /status is not allowed/i);
});

test("initial briefs contain only active instructions from their own canonical mode", async (t) => {
  const cases = [
    { mode: "light", forbidden: /Planificador|Verificador|Explorador|Refactor|Evaluador|Documentador|mutation/i },
    { mode: "normal", forbidden: /Tester|Explorador|Refactor|Evaluador|mutation/i },
    { mode: "full", forbidden: /Verificador/i },
  ];
  for (const { mode, forbidden } of cases) {
    await t.test(mode, async (subtest) => {
      const root = await project(subtest);
      const started = await startOrchestration({
        projectRoot: root,
        request: `Orquesta ${mode} greeting`,
        intention: intention(),
      });
      const activeInstructions = JSON.stringify({
        mission: started.brief.mission,
        contract: started.brief.contract,
        skills: started.brief.skills,
        quality: started.brief.quality,
        permissions: started.brief.permissions,
      });
      assert.doesNotMatch(activeInstructions, forbidden);
    });
  }
});
