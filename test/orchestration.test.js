import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize } from "../src/init.js";
import { listOrchestrations, resumeOrchestration, startOrchestration, submitHandoff } from "../src/orchestration.js";

async function createProject(t) {
  const project = await mkdtemp(path.join(tmpdir(), "agentic core light "));
  t.after(() => rm(project, { recursive: true, force: true }));
  await initialize(project);
  return project;
}
function intent(overrides = {}) {
  return {
    objective: "Add an observable greeting",
    constraints: ["Keep the existing CLI compatible"],
    criteria: ["The CLI prints the configured greeting"],
    ...overrides,
  };
}

test("only explicit light activators create a run", async (t) => {
  for (const prefix of ["Orquesta light", "/orquestar light", "$orquestar light"]) {
    await t.test(prefix, async (subtest) => {
      const project = await createProject(subtest);
      const request = `${prefix} implement the greeting`;
      const result = await startOrchestration({ projectRoot: project, request, intention: intent() });
      assert.equal(result.status, "started");
      assert.equal(result.mode, "light");
      assert.equal(result.role.name, "Implementador");
      assert.match(result.role.instanceId, /^[0-9a-f-]{36}$/);
      assert.match(result.summary, /light -> Implementador$/);
      const source = path.join(project, ".agentic-core", "runs", result.runId, "sources", "request.txt");
      assert.equal(await readFile(source, "utf8"), request);
    });
  }
  const project = await createProject(t);
  const direct = await startOrchestration({ projectRoot: project, request: "Please implement it", intention: intent() });
  assert.deepEqual(direct, { status: "direct", mode: "direct", request: "Please implement it" });
  await assert.rejects(readdir(path.join(project, ".agentic-core", "runs")), { code: "ENOENT" });
  await assert.rejects(
    startOrchestration({ projectRoot: project, request: "/orquestar direct do it", intention: intent() }),
    (error) => error.code === "mode_invalid",
  );
});

test("missing criteria requests clarification before creating a role or state", async (t) => {
  const project = await createProject(t);
  const result = await startOrchestration({
    projectRoot: project, request: "Orquesta light change it", intention: intent({ criteria: [] }),
  });
  assert.equal(result.status, "needs_input");
  assert.match(result.question, /verifiable acceptance criteria/i);
  assert.equal(result.runId, undefined);
  await assert.rejects(readdir(path.join(project, ".agentic-core", "runs")), { code: "ENOENT" });
});

test("a light run snapshots configuration and produces an isolated source-backed brief", async (t) => {
  const project = await createProject(t);
  const request = "$orquestar light change executable behavior";
  const result = await startOrchestration({
    projectRoot: project, request, intention: intent(), changesExecutableBehavior: true,
  });
  const runRoot = path.join(project, ".agentic-core", "runs", result.runId);
  const state = JSON.parse(await readFile(path.join(runRoot, "state.json"), "utf8"));
  const persistedIntent = JSON.parse(await readFile(path.join(runRoot, "intention.json"), "utf8"));
  const brief = JSON.parse(await readFile(path.join(runRoot, "briefs", "001-implementador.json"), "utf8"));
  assert.equal(persistedIntent.reason, "not_specified");
  assert.equal(persistedIntent.source.sha256, createHash("sha256").update(request).digest("hex"));
  assert.deepEqual(state.configurationSnapshot, brief.configuration);
  assert.equal("plan" in state, false);
  assert.equal("plan" in brief, false);
  assert.deepEqual(brief.skills, ["agentic-tdd"]);
  assert.equal(brief.role.name, "Implementador");
  assert.match(JSON.stringify(brief), /golden_rules/);
  assert.doesNotMatch(
    JSON.stringify({ role: brief.role, mission: brief.mission, contract: brief.contract }),
    /Planificador|Refactor|Explorador|Evaluador|Documentador|normal|full/,
  );
});

test("agentic-tdd is omitted when executable behavior will not change", async (t) => {
  const project = await createProject(t);
  const result = await startOrchestration({
    projectRoot: project, request: "Orquesta light update documentation", intention: intent(),
  });
  assert.deepEqual(result.brief.skills, []);
});

test("unknown configuration keys fail before a run is created", async (t) => {
  const project = await createProject(t);
  const configPath = path.join(project, ".agentic-core", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.orchestration.automaticClassification = true;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(
    startOrchestration({ projectRoot: project, request: "Orquesta light do it", intention: intent() }),
    (error) => error.code === "configuration_invalid",
  );
  await assert.rejects(readdir(path.join(project, ".agentic-core", "runs")), { code: "ENOENT" });
});

test("an oversized brief fails without writing truncated state", async (t) => {
  const project = await createProject(t);
  const configPath = path.join(project, ".agentic-core", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.orchestration.briefMaxBytes = 1024;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(
    startOrchestration({
      projectRoot: project, request: "Orquesta light make the change",
      intention: intent({ objective: "x".repeat(2_000) }),
    }),
    (error) => error.code === "context_budget_exceeded",
  );
  await assert.rejects(readdir(path.join(project, ".agentic-core", "runs")), { code: "ENOENT" });
});

function implementerHandoff(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "completed",
    summary: "Greeting implemented with test-first evidence",
    payload: {
      findings: [],
      evidence: { red: "test failed", green: "test passed", refactor: "suite remained green" },
      qualityTargets: ["src/greeting.js"],
    },
    ...overrides,
  };
}

test("a valid Implementador hand-off creates a fresh read-only Tester", async (t) => {
  const project = await createProject(t);
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "greeting.js"), "export const greeting = 'hello';\n");
  const started = await startOrchestration({
    projectRoot: project, request: "Orquesta light add greeting", intention: intent(), changesExecutableBehavior: true,
  });
  const result = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: implementerHandoff() });
  assert.equal(result.status, "continued");
  assert.equal(result.role.name, "Tester");
  assert.equal(result.role.sequence, 2);
  assert.notEqual(result.role.instanceId, started.role.instanceId);
  assert.equal(result.brief.permissions.write, false);
  assert.deepEqual(result.brief.previousHandoff, implementerHandoff());
  const requestedWork = { mission: result.brief.mission, quality: result.brief.quality };
  assert.doesNotMatch(JSON.stringify(requestedWork), /mutation/i);
});

function testerChangesRequired(summary = "Greeting lacks the required assertion") {
  return { schemaVersion: 1, status: "changes_required", summary, payload: { findings: [{
    impact: "blocking",
    category: "tests",
    authority: { criterionIds: ["The CLI prints the configured greeting"] },
    scope: "changed",
    evidence: { kind: "reproduction", detail: "node --test misses the configured output assertion" },
    materialImpact: "The required greeting can regress without a failing test.",
    minimalFix: "Add the missing assertion to the changed greeting test.",
  }] } };
}

test("Tester changes_required creates a new Implementador and consumes one global cycle", async (t) => {
  const project = await createProject(t);
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "greeting.js"), "export const greeting = 'hello';\n");
  const started = await startOrchestration({
    projectRoot: project, request: "Orquesta light add greeting", intention: intent(), changesExecutableBehavior: true,
  });
  const tester = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: implementerHandoff() });
  const result = await submitHandoff({
    projectRoot: project, runId: started.runId, handoff: testerChangesRequired(),
  });
  assert.equal(result.status, "continued");
  assert.equal(result.role.name, "Implementador");
  assert.equal(result.role.sequence, 3);
  assert.notEqual(result.role.instanceId, tester.role.instanceId);
  assert.equal(result.brief.reworkCount, 1);
  assert.deepEqual(result.brief.skills, ["agentic-tdd"]);
  const state = JSON.parse(await readFile(path.join(
    project, ".agentic-core", "runs", started.runId, "state.json"), "utf8"));
  assert.equal(state.reworkCount, 1);
});

test("an invalid hand-off gets one fresh-role protocol retry without consuming rework", async (t) => {
  const project = await createProject(t);
  const started = await startOrchestration({
    projectRoot: project, request: "Orquesta light add greeting", intention: intent(),
  });
  const retry = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: "not-json" });
  assert.equal(retry.status, "protocol_retry");
  assert.equal(retry.role.name, "Implementador");
  assert.notEqual(retry.role.instanceId, started.role.instanceId);
  assert.equal(retry.reworkCount, 0);
  const failed = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: {} });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reworkCount, 0);
  const state = JSON.parse(await readFile(path.join(
    project, ".agentic-core", "runs", started.runId, "state.json"), "utf8"));
  assert.equal(state.status, "failed");
});

test("Tester completion validates evidence and cleans the successful run", async (t) => {
  const project = await createProject(t);
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "greeting.js"), "export const greeting = 'hello';\n");
  const started = await startOrchestration({
    projectRoot: project, request: "Orquesta light add greeting", intention: intent(),
  });
  await submitHandoff({ projectRoot: project, runId: started.runId, handoff: implementerHandoff() });
  const runRoot = path.join(project, ".agentic-core", "runs", started.runId);
  const state = JSON.parse(await readFile(path.join(runRoot, "state.json"), "utf8"));
  const report = { $schema: "https://kroxidev.dev/agentic-core/quality-report.schema.json",
    schemaVersion: 1, tool: "crap", status: "approved", hashes: { inputs: state.baseline.hashes,
      configuration: createHash("sha256").update(JSON.stringify({ crapThreshold: 7 })).digest("hex"),
    } };
  const reportContent = `${JSON.stringify(report)}\n`;
  await mkdir(path.join(runRoot, "artifacts"));
  await writeFile(path.join(runRoot, "artifacts", "crap.json"), reportContent);
  const handoff = { schemaVersion: 1, status: "completed", summary: "All independent checks passed", payload: {
    findings: [],
    criteria: [{ criterion: "The CLI prints the configured greeting", status: "passed", evidence: "observed output" }],
    tests: { status: "passed", evidence: "node --test" },
    crap: { path: "artifacts/crap.json", sha256: createHash("sha256").update(reportContent).digest("hex") },
    goldenRules: { status: "passed", evidence: "reviewed canonical policy" },
  } };
  const result = await submitHandoff({ projectRoot: project, runId: started.runId, handoff });
  assert.equal(result.status, "completed");
  assert.equal(result.reworkCount, 0);
  assert.deepEqual(result.handoff, handoff);
  await assert.rejects(readFile(path.join(runRoot, "state.json")), { code: "ENOENT" });
});

test("resume lists choices without auto-selection and returns a divergent run to a fresh Tester", async (t) => {
  const project = await createProject(t);
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "greeting.js"), "export const greeting = 'hello';\n");
  const first = await startOrchestration({
    projectRoot: project, request: "Orquesta light first greeting", intention: intent(),
  });
  const second = await startOrchestration({
    projectRoot: project, request: "Orquesta light second greeting", intention: intent(),
  });
  const selection = await resumeOrchestration({ projectRoot: project });
  assert.equal(selection.status, "selection_required");
  assert.deepEqual(selection.runs.map(({ id }) => id).sort(), [first.runId, second.runId].sort());
  assert.equal(selection.runId, undefined);

  const tester = await submitHandoff({ projectRoot: project, runId: first.runId, handoff: implementerHandoff() });
  await writeFile(path.join(project, "src", "greeting.js"), "export const greeting = 'changed';\n");
  const resumed = await resumeOrchestration({ projectRoot: project, runId: first.runId });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.staleReports, true);
  assert.equal(resumed.role.name, "Tester");
  assert.notEqual(resumed.role.instanceId, tester.role.instanceId);
  assert.equal(resumed.reworkCount, 0);
  const listed = await listOrchestrations(project);
  assert.equal(listed.length, 2);
});

test("the second Tester changes_required blocks light after exactly one rework cycle", async (t) => {
  const project = await createProject(t);
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "greeting.js"), "export const greeting = 'hello';\n");
  const started = await startOrchestration({
    projectRoot: project, request: "Orquesta light add greeting", intention: intent(),
  });
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    await submitHandoff({ projectRoot: project, runId: started.runId, handoff: implementerHandoff() });
    const result = await submitHandoff({
      projectRoot: project, runId: started.runId, handoff: testerChangesRequired(`cycle ${cycle}`),
    });
    if (cycle < 2) {
      assert.equal(result.status, "continued");
      assert.equal(result.reworkCount ?? result.brief.reworkCount, cycle);
    } else {
      assert.equal(result.status, "blocked");
      assert.equal(result.reworkCount, 2);
    }
  }
});

test("questions, missing context and mode requests create fresh roles without consuming rework", async (t) => {
  const project = await createProject(t);
  const started = await startOrchestration({
    projectRoot: project, request: "Orquesta light add greeting", intention: intent(),
  });
  let previous = started.role.instanceId;
  for (const handoff of [
    { schemaVersion: 1, status: "needs_input", summary: "Need a value",
      payload: { findings: [], question: "Which greeting?" } },
    { schemaVersion: 1, status: "context_missing", summary: "Missing fixture",
      payload: { findings: [], missing: ["test/fixture.json"] } },
    { schemaVersion: 1, status: "needs_mode_change", summary: "Risk requires planning",
      payload: { findings: [], requestedMode: "normal", reason: "Cross-cutting change" } },
  ]) {
    const result = await submitHandoff({ projectRoot: project, runId: started.runId, handoff });
    assert.equal(result.status, handoff.status);
    assert.equal(result.reworkCount, 0);
    assert.notEqual(result.role.instanceId, previous);
    previous = result.role.instanceId;
  }
});

test("a role can terminate as failed or blocked without consuming rework", async (t) => {
  for (const status of ["failed", "blocked"]) {
    const project = await createProject(t);
    const started = await startOrchestration({
      projectRoot: project, request: "Orquesta light add greeting", intention: intent(),
    });
    const result = await submitHandoff({ projectRoot: project, runId: started.runId, handoff: {
      schemaVersion: 1, status, summary: `Role ended as ${status}`,
      payload: { findings: [{
        impact: "blocking", category: "required_validation",
        authority: { requiredGate: "required validation" },
        scope: "changed",
        evidence: { kind: "reproduction", detail: "required tool is unavailable" },
        materialImpact: "The required validation cannot be completed.",
        minimalFix: "Restore the required tool and rerun the validation.",
      }] },
    } });
    assert.equal(result.status, status);
    assert.equal(result.reworkCount, 0);
  }
});

test("an incomplete blocker is rejected without consuming rework", async (t) => {
  const project = await createProject(t);
  await mkdir(path.join(project, "src"));
  await writeFile(
    path.join(project, "src", "greeting.js"),
    "export const greeting = 'hello';\n",
  );
  const started = await startOrchestration({
    projectRoot: project,
    request: "Orquesta light add greeting",
    intention: intent(),
  });
  await submitHandoff({
    projectRoot: project,
    runId: started.runId,
    handoff: implementerHandoff(),
  });
  const result = await submitHandoff({
    projectRoot: project,
    runId: started.runId,
    handoff: {
      schemaVersion: 1,
      status: "changes_required",
      summary: "Hypothetical concern",
      payload: {
        findings: [{
          impact: "blocking",
          category: "tests",
          evidence: "Maybe an unsupported input exists.",
        }],
      },
    },
  });
  assert.equal(result.status, "protocol_retry");
  assert.equal(result.reworkCount, 0);
});

test("a baseline captured after production changed is rejected", async (t) => {
  const project = await createProject(t);
  await mkdir(path.join(project, "src"));
  const sourcePath = path.join(project, "src", "greeting.js");
  await writeFile(sourcePath, "export const greeting = 'before';\n");
  const started = await startOrchestration({
    projectRoot: project,
    request: "Orquesta light change greeting",
    intention: intent(),
  });
  const changed = "export const greeting = 'after';\n";
  await writeFile(sourcePath, changed);
  const handoff = implementerHandoff();
  handoff.payload.qualityBaselineReport = {
    $schema:
      "https://kroxidev.dev/agentic-core/quality-report.schema.json",
    schemaVersion: 1,
    tool: "crap",
    status: "approved",
    hashes: {
      inputs: {
        "src/greeting.js": createHash("sha256")
          .update(changed)
          .digest("hex"),
      },
    },
    details: [],
  };
  const result = await submitHandoff({
    projectRoot: project,
    runId: started.runId,
    handoff,
  });
  assert.equal(result.status, "protocol_retry");
  assert.equal(result.reworkCount, 0);
});
