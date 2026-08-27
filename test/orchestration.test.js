import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize } from "../src/init.js";
import { startOrchestration } from "../src/orchestration.js";

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
    (error) => error.code === "configuration_invalid" && /automaticClassification/.test(error.message),
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
    (error) => error.code === "context_budget_exceeded" && /1024/.test(error.message),
  );
  await assert.rejects(readdir(path.join(project, ".agentic-core", "runs")), { code: "ENOENT" });
});
