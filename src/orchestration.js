import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { hasMaterialBlocker } from "./findings.js";
import { preImplementationInventory, qualityInputInventory } from "./quality/inputs.js";
import { writeTransaction } from "./transaction.js";

const MODES = new Set(["light", "normal", "full"]);
const CONFIG_KEYS = new Set(["$schema", "schemaVersion", "orchestration", "quality"]);
const ORCHESTRATION_KEYS = new Set(["explicitActivationOnly", "defaultMode", "briefMaxBytes", "handoffMaxBytes"]);
const QUALITY_KEYS = new Set(["crapThreshold", "mutationWorkers"]);
const ACTIVATION = /^(Orquesta|\/orquestar|\$orquestar)(?:\s+|$)/u;
const LIGHT_CONTRACT = {
  input: "Use only the supplied intention and source references as authority.",
  output: "Return one JSON hand-off that conforms to the installed hand-off contract.",
  boundaries: ["Establish the HOW before editing.", "Do not weaken acceptance criteria.", "Do not select the next role."],
};
const NORMAL_CONTRACT = {
  input: "Use only the current plan, the actionable hand-off and canonical source references as authority.",
  output: "Return one JSON hand-off that conforms to the normal-mode contract for this role.",
  boundaries: ["Do not weaken acceptance criteria.", "Do not select the next role.", "Report only actionable blockers."],
};
const REVIEW_POLICY = {
  blocking: "Block only material defects tied to concrete authority, changed scope or a direct dependency, reproducible evidence, material impact and a minimal in-scope fix.",
  scope: "Do not expand criteria, modules, surfaces or neighboring dependencies without evidence that they are directly necessary.",
  advisory: "Future extensibility, unsupported inputs, hypothetical paths, unchanged debt, style, alternatives, unmeasured optimizations and out-of-scope concerns are advisory.",
};
const NORMAL_ROLES = new Set(["Planificador", "Implementador", "Refactor", "Tester", "Documentador"]);

export class OrchestrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
  }
}
function sha256(content) { return createHash("sha256").update(content).digest("hex"); }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactObject(value, keys, location) {
  if (!plainObject(value)) {
    throw new OrchestrationError("configuration_invalid", `${location} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length) throw new OrchestrationError("configuration_invalid", `Unknown ${location} key: ${unknown.join(", ")}`);
}
function integerBetween(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}
function validRootConfig(config) {
  return config.$schema === "./config.schema.json" && config.schemaVersion === 1;
}
function validOrchestrationConfig(config) {
  return config.explicitActivationOnly === true && config.defaultMode === "normal"
    && integerBetween(config.briefMaxBytes, 1, 16_384) && integerBetween(config.handoffMaxBytes, 1, 32_768);
}
function validQualityConfig(config) {
  return typeof config.crapThreshold === "number" && Number.isFinite(config.crapThreshold)
    && config.crapThreshold >= 0 && integerBetween(config.mutationWorkers, 1, 4);
}
function validateConfiguration(config) {
  exactObject(config, CONFIG_KEYS, "configuration");
  exactObject(config.orchestration, ORCHESTRATION_KEYS, "orchestration");
  exactObject(config.quality, QUALITY_KEYS, "quality");
  const valid = [
    validRootConfig(config),
    validOrchestrationConfig(config.orchestration),
    validQualityConfig(config.quality),
  ];
  if (!valid.every(Boolean)) throw new OrchestrationError("configuration_invalid", "Configuration violates schema version 1");
  return structuredClone(config);
}

function parseRequest(originalRequest) {
  if (typeof originalRequest !== "string") throw new OrchestrationError("request_invalid", "The original request must be text");
  const activation = originalRequest.match(ACTIVATION);
  if (!activation) return { activated: false, mode: "direct", task: originalRequest };
  const remainder = originalRequest.slice(activation[0].length);
  const [candidate = ""] = remainder.trimStart().split(/\s+/u);
  if (candidate === "direct") throw new OrchestrationError("mode_invalid", "direct is not an invocable orchestration mode");
  const mode = MODES.has(candidate) ? candidate : "normal";
  return { activated: true, mode, task: mode === candidate ? remainder.trimStart().slice(candidate.length).trimStart() : remainder };
}
function textList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new OrchestrationError("intention_invalid", `${name} must contain non-empty text values`);
  }
  return value.map((item) => item.trim());
}
function requiredText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function optionalText(value) {
  return value === undefined || requiredText(value);
}
function assertIntentionShape(value) {
  if (!plainObject(value)) {
    throw new OrchestrationError("intention_invalid", "intention must be an object");
  }
  const allowed = new Set(["objective", "reason", "constraints", "criteria"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new OrchestrationError("intention_invalid", `Unknown intention key: ${unknown.join(", ")}`);
}
function normalizeIntention(value, source, mode = "light") {
  assertIntentionShape(value);
  if (!requiredText(value.objective)) {
    return { clarification: `What objective should this ${mode} execution achieve?` };
  }
  const criteria = textList(value.criteria, "criteria");
  if (!criteria.length) return { clarification: `What verifiable acceptance criteria should the ${mode === "normal" ? "Planificador preserve" : "Implementador satisfy"}?` };
  if (!optionalText(value.reason)) {
    throw new OrchestrationError("intention_invalid", "reason must be non-empty text when specified");
  }
  return { intention: {
    schemaVersion: 1, objective: value.objective.trim(), reason: value.reason?.trim() ?? "not_specified",
    constraints: textList(value.constraints, "constraints"), criteria, source,
  } };
}
async function assertNewRun(runRoot) {
  try {
    await lstat(runRoot);
    throw new OrchestrationError("run_id_collision", `Run already exists: ${path.basename(runRoot)}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
async function installedSources(productRoot) {
  try {
    return await Promise.all([
      readFile(path.join(productRoot, "config.json"), "utf8").then(JSON.parse),
      readFile(path.join(productRoot, "golden-rules.md"), "utf8"),
    ]);
  } catch (error) {
    if (error instanceof SyntaxError) throw new OrchestrationError("configuration_invalid", "Configuration is not valid JSON");
    throw error;
  }
}

export async function startOrchestration({ projectRoot: projectDirectory, request, intention,
  changesExecutableBehavior = false, planningNeedsHowDecision = false }) {
  const parsed = parseRequest(request);
  if (!parsed.activated) return { status: "direct", mode: "direct", request: parsed.task };
  if (parsed.mode === "normal") return startNormalOrchestration({ projectDirectory, request, intention,
    changesExecutableBehavior, planningNeedsHowDecision });
  if (parsed.mode !== "light") throw new OrchestrationError("mode_not_implemented", `Mode ${parsed.mode} is not implemented yet`);
  const projectRoot = path.resolve(projectDirectory);
  const productRoot = path.join(projectRoot, ".agentic-core");
  const [config, goldenRules] = await installedSources(productRoot);
  const configurationSnapshot = validateConfiguration(config);
  const requestContent = Buffer.from(request);
  const requestSource = { kind: "original_request", path: "sources/request.txt", sha256: sha256(requestContent) };
  const normalized = normalizeIntention(intention, requestSource);
  if (normalized.clarification) return { status: "needs_input", mode: "light", question: normalized.clarification };

  const runId = randomUUID();
  const roleInstanceId = randomUUID();
  const runRoot = path.join(productRoot, "runs", runId);
  await assertNewRun(runRoot);
  const policySource = { kind: "golden_rules", path: "../../golden-rules.md", sha256: sha256(goldenRules) };
  const brief = {
    schemaVersion: 1, runId, mode: "light",
    role: { sequence: 1, name: "Implementador", instanceId: roleInstanceId },
    mission: "Establish the HOW, then implement the intention without changing its acceptance criteria.",
    contract: LIGHT_CONTRACT, intention: normalized.intention, sources: [requestSource, policySource],
    policy: policySource, configuration: configurationSnapshot,
    skills: changesExecutableBehavior ? ["agentic-tdd"] : [],
  };
  const briefContent = Buffer.from(json(brief));
  if (briefContent.byteLength > configurationSnapshot.orchestration.briefMaxBytes) {
    throw new OrchestrationError("context_budget_exceeded",
      `Brief requires ${briefContent.byteLength} bytes; limit is ${configurationSnapshot.orchestration.briefMaxBytes}`);
  }
  const preImplementation = await preImplementationInventory(projectRoot);
  const state = {
    schemaVersion: 1, id: runId, mode: "light", status: "running", currentRole: brief.role, reworkCount: 0,
    sourceHashes: { originalRequest: requestSource.sha256, goldenRules: policySource.sha256 },
    preImplementation,
    configurationSnapshot, baseline: null, lastHandoff: null,
    transitions: [{ role: "Implementador", status: "started", summary: "light -> Implementador", at: new Date().toISOString() }],
  };
  await writeTransaction(projectRoot, [
    { path: path.join(runRoot, "sources", "request.txt"), content: requestContent },
    { path: path.join(runRoot, "intention.json"), content: Buffer.from(json(normalized.intention)) },
    { path: path.join(runRoot, "state.json"), content: Buffer.from(json(state)) },
    { path: path.join(runRoot, "briefs", "001-implementador.json"), content: briefContent },
  ]);
  return {
    status: "started", mode: "light", runId, role: structuredClone(brief.role),
    summary: `${runId}: light -> Implementador`, brief,
  };
}

function normalSources(state) {
  const sources = [{ kind: "original_request", path: "sources/request.txt", sha256: state.sourceHashes.originalRequest }];
  if (state.planHash) sources.push({ kind: "current_plan", path: "plan.json", sha256: state.planHash });
  return sources;
}
function normalPermissions(role) {
  if (role === "Implementador") return { read: true, write: ["production", "tests"] };
  if (role === "Tester") return { read: true, write: ["tests_when_production_is_correct"] };
  if (role === "Documentador") return { read: true, write: ["documentation"] };
  return { read: true, write: [] };
}
function normalRole(sequence, name) {
  if (!NORMAL_ROLES.has(name)) throw new OrchestrationError("role_mismatch", `Unknown normal role: ${name}`);
  return { sequence, name, instanceId: randomUUID() };
}
function ensureBriefSize(brief, maximumBytes) {
  const content = Buffer.from(json(brief));
  if (content.byteLength > maximumBytes) {
    throw new OrchestrationError("context_budget_exceeded",
      `Brief requires ${content.byteLength} bytes; limit is ${maximumBytes}`);
  }
  return content;
}
function validateNormalPlan(plan, originalCriteria) {
  const errors = [];
  if (!plainObject(plan)) errors.push("plan must be an object");
  else {
    const allowed = new Set(["schemaVersion", "approach", "criteria", "steps", "qualitySurfaces", "documentationSuggestion"]);
    const unknown = Object.keys(plan).filter((key) => !allowed.has(key));
    if (unknown.length) errors.push(`unknown plan keys: ${unknown.join(", ")}`);
    if (plan.schemaVersion !== 1 || !requiredText(plan.approach) || !requiredText(plan.documentationSuggestion)) {
      errors.push("plan metadata is invalid");
    }
    if (!Array.isArray(plan.qualitySurfaces) || plan.qualitySurfaces.length === 0
      || plan.qualitySurfaces.some((surface) => !requiredText(surface))) errors.push("plan qualitySurfaces are required");
    const criteria = plan.criteria;
    if (!Array.isArray(criteria) || criteria.length === 0 || criteria.some((criterion) => !plainObject(criterion)
      || !requiredText(criterion.id) || !requiredText(criterion.text) || !Array.isArray(criterion.sourceCriteria)
      || criterion.sourceCriteria.length === 0 || criterion.sourceCriteria.some((source) => !originalCriteria.includes(source)))) {
      errors.push("plan criteria must be traceable to original criteria");
    } else {
      const covered = new Set(criteria.flatMap((criterion) => criterion.sourceCriteria));
      if (originalCriteria.some((criterion) => !covered.has(criterion))) errors.push("plan must not weaken original criteria");
      const ids = new Set(criteria.map((criterion) => criterion.id));
      if (ids.size !== criteria.length) errors.push("plan criterion ids must be unique");
      if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.some((step) => !plainObject(step)
        || !requiredText(step.id) || !requiredText(step.objective) || !requiredText(step.validation)
        || !Array.isArray(step.criteria) || step.criteria.length === 0 || step.criteria.some((id) => !ids.has(id))
        || !Array.isArray(step.qualitySurfaces) || step.qualitySurfaces.length === 0
        || step.qualitySurfaces.some((surface) => !plan.qualitySurfaces.includes(surface)))) {
        errors.push("every flat plan step must link criteria, an objective, a validation and quality surfaces");
      } else {
        const linked = new Set(plan.steps.flatMap((step) => step.criteria));
        if ([...ids].some((id) => !linked.has(id))) errors.push("every planned criterion must be linked to a step");
      }
    }
  }
  if (errors.length) throw new OrchestrationError("handoff_invalid", errors.join("; "));
  return structuredClone(plan);
}

async function startNormalOrchestration({ projectDirectory, request, intention, changesExecutableBehavior,
  planningNeedsHowDecision }) {
  const projectRoot = path.resolve(projectDirectory);
  const productRoot = path.join(projectRoot, ".agentic-core");
  const [config, goldenRules] = await installedSources(productRoot);
  const configurationSnapshot = validateConfiguration(config);
  const requestContent = Buffer.from(request);
  const requestSource = { kind: "original_request", path: "sources/request.txt", sha256: sha256(requestContent) };
  const normalized = normalizeIntention(intention, requestSource, "normal");
  if (normalized.clarification) return { status: "needs_input", mode: "normal", question: normalized.clarification };
  const runId = randomUUID();
  const runRoot = path.join(productRoot, "runs", runId);
  await assertNewRun(runRoot);
  const policySource = { kind: "golden_rules", path: "../../golden-rules.md", sha256: sha256(goldenRules) };
  const role = normalRole(1, "Planificador");
  const brief = {
    schemaVersion: 1, runId, mode: "normal", role,
    mission: "Read the original request and produce a flat, traceable plan without weakening any criterion.",
    contract: NORMAL_CONTRACT, intention: normalized.intention, sources: [requestSource], policy: policySource,
    configuration: configurationSnapshot, skills: planningNeedsHowDecision ? ["agentic-grilling"] : [],
    permissions: normalPermissions(role.name),
  };
  const briefContent = ensureBriefSize(brief, configurationSnapshot.orchestration.briefMaxBytes);
  const preImplementation = await preImplementationInventory(projectRoot);
  const state = {
    schemaVersion: 1, id: runId, mode: "normal", status: "running", currentRole: role, reworkCount: 0,
    sourceHashes: { originalRequest: requestSource.sha256, goldenRules: policySource.sha256 },
    preImplementation,
    configurationSnapshot, planHash: null, baseline: null, lastHandoff: null,
    changesExecutableBehavior: Boolean(changesExecutableBehavior), protocolRetryUsed: false, documentationRetryUsed: false,
    transitions: [{ role: "Planificador", status: "started", summary: "normal -> Planificador", at: new Date().toISOString() }],
  };
  await writeTransaction(projectRoot, [
    { path: path.join(runRoot, "sources", "request.txt"), content: requestContent },
    { path: path.join(runRoot, "intention.json"), content: Buffer.from(json(normalized.intention)) },
    { path: path.join(runRoot, "state.json"), content: Buffer.from(json(state)) },
    { path: path.join(runRoot, "briefs", "001-planificador.json"), content: briefContent },
  ]);
  return { status: "started", mode: "normal", runId, role: structuredClone(role),
    summary: `${runId}: normal -> Planificador`, brief };
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)) {
    throw new OrchestrationError("run_invalid", "Run id is invalid");
  }
}
async function readRun(projectRoot, runId) {
  assertRunId(runId);
  const runRoot = path.join(projectRoot, ".agentic-core", "runs", runId);
  try {
    const state = JSON.parse(await readFile(path.join(runRoot, "state.json"), "utf8"));
    return { runRoot, state };
  } catch (error) {
    if (error?.code === "ENOENT") throw new OrchestrationError("run_not_found", `Run not found: ${runId}`);
    throw error;
  }
}
function validateImplementerHandoff(handoff, maximumBytes) {
  const errors = [];
  if (!plainObject(handoff)) errors.push("hand-off must be one JSON object");
  else {
    const allowed = new Set(["schemaVersion", "status", "summary", "payload"]);
    const unknown = Object.keys(handoff).filter((key) => !allowed.has(key));
    if (unknown.length) errors.push(`unknown hand-off keys: ${unknown.join(", ")}`);
    if (handoff.schemaVersion !== 1) errors.push("schemaVersion must be 1");
    if (handoff.status !== "completed") errors.push("Implementador status must be completed");
    if (!requiredText(handoff.summary)) errors.push("summary must be non-empty text");
    if (!plainObject(handoff.payload)) errors.push("payload must be an object");
    else {
      if (!Array.isArray(handoff.payload.findings)) errors.push("payload.findings must be an array");
      else if (handoff.payload.findings.some((finding) => finding?.impact === "blocking")) {
        errors.push("completed prohibits blocking findings");
      }
      const evidence = handoff.payload.evidence;
      if (!plainObject(evidence) || ![evidence?.red, evidence?.green, evidence?.refactor].every(requiredText)) {
        errors.push("Implementador evidence must contain red, green and refactor text");
      }
      if (!Array.isArray(handoff.payload.qualityTargets) || handoff.payload.qualityTargets.length === 0
        || handoff.payload.qualityTargets.some((target) => !requiredText(target))) {
        errors.push("payload.qualityTargets must contain project-relative paths");
      }
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(handoff));
  if (bytes > maximumBytes) errors.push(`hand-off requires ${bytes} bytes; limit is ${maximumBytes}`);
  if (errors.length) throw new OrchestrationError("handoff_invalid", errors.join("; "));
}
async function baselineFor(projectRoot, targets) {
  const paths = [];
  for (const target of targets) {
    const resolved = path.resolve(projectRoot, target);
    const relative = path.relative(projectRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new OrchestrationError("handoff_invalid", `Quality target must be a project-relative file: ${target}`);
    }
    paths.push(resolved);
  }
  const inventory = await qualityInputInventory(projectRoot, paths, null, []);
  return {
    capturedAt: new Date().toISOString(),
    hashes: inventory.hashes,
    inputInventory: inventory.entries,
  };
}

function preChangeBaseline(report, state) {
  if (report === undefined) return undefined;
  if (!plainObject(report)
    || report.$schema !== "https://kroxidev.dev/agentic-core/quality-report.schema.json"
    || report.schemaVersion !== 1
    || !["crap", "scan"].includes(report.tool)
    || !plainObject(report.hashes?.inputs)
    || !Array.isArray(report.details)) {
    throw new OrchestrationError(
      "handoff_invalid",
      "qualityBaselineReport must be a complete C.R.A.P. report",
    );
  }
  const prior = state.preImplementation?.hashes ?? {};
  for (const [input, hash] of Object.entries(report.hashes.inputs)) {
    if (prior[input] !== hash) {
      throw new OrchestrationError(
        "handoff_invalid",
        "qualityBaselineReport was not captured before implementation",
      );
    }
  }
  return structuredClone(report);
}

function validateCompletedHandoff(handoff, role, maximumBytes) {
  const errors = [];
  if (!plainObject(handoff) || handoff.schemaVersion !== 1 || handoff.status !== "completed"
    || !requiredText(handoff.summary) || !plainObject(handoff.payload)) errors.push(`${role} completed hand-off is invalid`);
  else {
    const allowed = new Set(["schemaVersion", "status", "summary", "payload"]);
    if (Object.keys(handoff).some((key) => !allowed.has(key))) errors.push("completed hand-off has unknown keys");
    if (!Array.isArray(handoff.payload.findings)) errors.push("payload.findings must be an array");
    else if (handoff.payload.findings.some((finding) => finding?.impact === "blocking")) {
      errors.push("completed prohibits blocking findings");
    }
  }
  if (Buffer.byteLength(JSON.stringify(handoff)) > maximumBytes) errors.push("hand-off exceeds configured limit");
  if (errors.length) throw new OrchestrationError("handoff_invalid", errors.join("; "));
}
function validateChangesRequired(handoff, role, maximumBytes) {
  const errors = [];
  if (!plainObject(handoff) || handoff.schemaVersion !== 1 || handoff.status !== "changes_required"
    || !requiredText(handoff.summary) || !plainObject(handoff.payload)) errors.push(`${role} changes_required hand-off is invalid`);
  else {
    const findings = handoff.payload.findings;
    if (!Array.isArray(findings) || !hasMaterialBlocker(findings)) {
      errors.push("changes_required requires an actionable typed blocker");
    }
  }
  if (Buffer.byteLength(JSON.stringify(handoff)) > maximumBytes) errors.push("hand-off exceeds configured limit");
  if (errors.length) throw new OrchestrationError("handoff_invalid", errors.join("; "));
}
async function normalPlan(runRoot) {
  try { return JSON.parse(await readFile(path.join(runRoot, "plan.json"), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") throw new OrchestrationError("state_invalid", "Current normal plan is missing");
    throw error;
  }
}
function buildNormalBrief(state, runId, role, mission, plan, previousHandoff, extra = {}) {
  return {
    schemaVersion: 1, runId, mode: "normal", role, mission, contract: NORMAL_CONTRACT,
    plan, previousHandoff: previousHandoff ? structuredClone(previousHandoff) : null,
    sources: normalSources(state),
    policy: { kind: "golden_rules", path: "../../golden-rules.md", sha256: state.sourceHashes.goldenRules },
    reviewPolicy: REVIEW_POLICY,
    configuration: state.configurationSnapshot, permissions: normalPermissions(role.name), ...extra,
  };
}
async function persistNormalRole(projectRoot, runRoot, state, role, brief, transitions, updates = [], stateUpdates = {}) {
  const content = ensureBriefSize(brief, state.configurationSnapshot.orchestration.briefMaxBytes);
  const nextState = { ...state, currentRole: role, protocolRetryUsed: false, ...stateUpdates,
    transitions: [...state.transitions, ...transitions] };
  await writeTransaction(projectRoot, [
    ...updates,
    { path: path.join(runRoot, "state.json"), content: Buffer.from(json(nextState)) },
    { path: path.join(runRoot, "briefs", `${String(role.sequence).padStart(3, "0")}-${role.name.toLowerCase()}.json`),
      content },
  ]);
  return { status: "continued", mode: "normal", runId: state.id, role: structuredClone(role),
    reworkCount: nextState.reworkCount, summary: transitions.at(-1).summary, brief };
}
async function submitNormalPlanner(projectRoot, runRoot, state, runId, handoff) {
  validateCompletedHandoff(handoff, "Planificador", state.configurationSnapshot.orchestration.handoffMaxBytes);
  const intention = JSON.parse(await readFile(path.join(runRoot, "intention.json"), "utf8"));
  const replanning = state.planHash !== null;
  let plan;
  if (replanning) {
    if (!plainObject(handoff.payload.delta) || !plainObject(handoff.payload.delta.replacementPlan)
      || !requiredText(handoff.payload.delta.reason)) {
      throw new OrchestrationError("handoff_invalid", "replanning requires a reasoned delta with replacementPlan");
    }
    plan = validateNormalPlan(handoff.payload.delta.replacementPlan, intention.criteria);
  } else {
    plan = validateNormalPlan(handoff.payload.plan, intention.criteria);
  }
  const planContent = Buffer.from(json(plan));
  const planHash = sha256(planContent);
  const role = normalRole(state.currentRole.sequence + 1, "Implementador");
  const stateWithPlan = { ...state, planHash };
  const brief = buildNormalBrief(stateWithPlan, runId, role,
    "Implement the current plan with test-first evidence and address only actionable blockers.", plan, handoff,
    { skills: state.changesExecutableBehavior ? ["agentic-tdd"] : [] });
  return persistNormalRole(projectRoot, runRoot, state, role, brief, [
    { role: "Planificador", status: "completed", summary: handoff.summary, at: new Date().toISOString() },
    { role: "Implementador", status: "started", summary: "Planificador -> Implementador", at: new Date().toISOString() },
  ], [{ path: path.join(runRoot, "plan.json"), content: planContent }],
  { planHash, baseline: null, lastHandoff: structuredClone(handoff) });
}
async function submitNormalImplementer(projectRoot, runRoot, state, runId, handoff) {
  validateImplementerHandoff(handoff, state.configurationSnapshot.orchestration.handoffMaxBytes);
  const qualityBaselineReport = preChangeBaseline(handoff.payload.qualityBaselineReport, state);
  const baseline = await baselineFor(projectRoot, handoff.payload.qualityTargets);
  const plan = await normalPlan(runRoot);
  const role = normalRole(state.currentRole.sequence + 1, "Refactor");
  const brief = buildNormalBrief(state, runId, role,
    "Read-only review of Golden Rules and structure; run differential C.R.A.P. and Mutation Testing gates.",
    plan, handoff, { quality: { targets: [...handoff.payload.qualityTargets], baseline },
      baselineReport: qualityBaselineReport ?? { status: "not_attributable" },
      permissions: { read: true, write: [] } });
  return persistNormalRole(projectRoot, runRoot, state, role, brief, [
    { role: "Implementador", status: "completed", summary: handoff.summary, at: new Date().toISOString() },
    { role: "Refactor", status: "started", summary: "Implementador -> Refactor", at: new Date().toISOString() },
  ], [], {
    baseline,
    qualityBaselineReport,
    qualityTargets: [...handoff.payload.qualityTargets],
    lastHandoff: structuredClone(handoff),
  });
}
async function readQualityGate(runRoot, reference, tool, baseline, configurationHash) {
  if (!plainObject(reference) || !requiredText(reference.path) || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")) {
    throw new OrchestrationError("handoff_invalid", `${tool} requires an artifact path and SHA-256`);
  }
  const artifactPath = path.resolve(runRoot, ...reference.path.split("/"));
  const relative = path.relative(runRoot, artifactPath).split(path.sep).join("/");
  if (!relative.startsWith("artifacts/") || relative.startsWith("../")) {
    throw new OrchestrationError("handoff_invalid", `${tool} artifact path is invalid`);
  }
  let content;
  try { content = await readFile(artifactPath); }
  catch { throw new OrchestrationError("handoff_invalid", `${tool} artifact is missing`); }
  if (sha256(content) !== reference.sha256) throw new OrchestrationError("handoff_invalid", `${tool} artifact hash does not match`);
  let report;
  try { report = JSON.parse(content.toString("utf8")); }
  catch { throw new OrchestrationError("handoff_invalid", `${tool} artifact is corrupt`); }
  if (report.$schema !== "https://kroxidev.dev/agentic-core/quality-report.schema.json" || report.schemaVersion !== 1
    || report.tool !== tool || !["approved", "not_applicable"].includes(report.status)
    || JSON.stringify(report.hashes?.inputs) !== JSON.stringify(baseline.hashes)
    || report.hashes?.configuration !== configurationHash) {
    throw new OrchestrationError("handoff_invalid", `${tool} report schema, gate status or hashes are stale`);
  }
}
async function requestNormalChanges(projectRoot, runRoot, state, runId, handoff, nextRole, mission, extra = {}) {
  const reworkCount = state.reworkCount + 1;
  if (reworkCount > 3) {
    const blocked = { ...state, status: "blocked", reworkCount, lastHandoff: structuredClone(handoff),
      transitions: [...state.transitions, { role: state.currentRole.name, status: "blocked", summary: handoff.summary,
        at: new Date().toISOString() }] };
    await writeTransaction(projectRoot, [{ path: path.join(runRoot, "state.json"), content: Buffer.from(json(blocked)) }]);
    return { status: "blocked", mode: "normal", runId, reworkCount, summary: handoff.summary };
  }
  const plan = await normalPlan(runRoot);
  const role = normalRole(state.currentRole.sequence + 1, nextRole);
  const brief = buildNormalBrief(state, runId, role, mission, plan, handoff,
    { reworkCount, ...(nextRole === "Implementador" ? { skills: state.changesExecutableBehavior ? ["agentic-tdd"] : [] } : {}),
      ...extra });
  return persistNormalRole(projectRoot, runRoot, state, role, brief, [
    { role: state.currentRole.name, status: "changes_required", summary: handoff.summary, at: new Date().toISOString() },
    { role: nextRole, status: "started", summary: `${state.currentRole.name} -> ${nextRole}`, at: new Date().toISOString() },
  ], [], { reworkCount, lastHandoff: structuredClone(handoff) });
}
async function submitNormalRefactor(projectRoot, runRoot, state, runId, handoff) {
  if (handoff?.status === "changes_required") {
    validateChangesRequired(handoff, "Refactor", state.configurationSnapshot.orchestration.handoffMaxBytes);
    return requestNormalChanges(projectRoot, runRoot, state, runId, handoff, "Implementador",
      "Resolve only the actionable Refactor blockers against the unchanged current plan.");
  }
  validateCompletedHandoff(handoff, "Refactor", state.configurationSnapshot.orchestration.handoffMaxBytes);
  const crapHash = sha256(JSON.stringify({ crapThreshold: state.configurationSnapshot.quality.crapThreshold }));
  const mutationHash = sha256(JSON.stringify({ mutationWorkers: state.configurationSnapshot.quality.mutationWorkers }));
  await readQualityGate(runRoot, handoff.payload.crap, "crap", state.baseline, crapHash);
  await readQualityGate(runRoot, handoff.payload.mutation, "mutation", state.baseline, mutationHash);
  const plan = await normalPlan(runRoot);
  const role = normalRole(state.currentRole.sequence + 1, "Tester");
  const brief = buildNormalBrief(state, runId, role,
    "Verify every current-plan criterion and all invalidated gates; edit tests only when production is already correct.",
    plan, handoff, { quality: { crap: handoff.payload.crap, mutation: handoff.payload.mutation },
      contradictionPolicy: "Never modify a contradictory test silently; report it with concrete evidence." });
  return persistNormalRole(projectRoot, runRoot, state, role, brief, [
    { role: "Refactor", status: "completed", summary: handoff.summary, at: new Date().toISOString() },
    { role: "Tester", status: "started", summary: "Refactor -> Tester", at: new Date().toISOString() },
  ], [], { lastHandoff: structuredClone(handoff), reports: [handoff.payload.crap, handoff.payload.mutation] });
}
function validateNormalTesterCompleted(handoff, plan, maximumBytes) {
  validateCompletedHandoff(handoff, "Tester", maximumBytes);
  const criteria = handoff.payload.criteria;
  if (!Array.isArray(criteria) || plan.criteria.some((expected) => !criteria.some((item) =>
    item?.criterionId === expected.id && item.status === "passed" && requiredText(item.evidence)))) {
    throw new OrchestrationError("handoff_invalid", "every current-plan criterion requires passed evidence");
  }
  if (handoff.payload.tests?.status !== "passed" || !requiredText(handoff.payload.tests?.evidence)
    || handoff.payload.goldenRules?.status !== "passed" || !requiredText(handoff.payload.goldenRules?.evidence)) {
    throw new OrchestrationError("handoff_invalid", "tests and Golden Rules require passed evidence");
  }
}
async function submitNormalTester(projectRoot, runRoot, state, runId, handoff) {
  const plan = await normalPlan(runRoot);
  if (handoff?.status === "changes_required") {
    validateChangesRequired(handoff, "Tester", state.configurationSnapshot.orchestration.handoffMaxBytes);
    const findings = handoff.payload.findings;
    const productionDefect = handoff.payload.productionDefect === true
      || findings.some((finding) => finding.category === "specification" || finding.category === "golden_rules");
    if (productionDefect) return requestNormalChanges(projectRoot, runRoot, state, runId, handoff, "Planificador",
      "Produce a reasoned plan delta for the production defect, preserving every original criterion.",
      { deltaRequired: true, skills: handoff.payload.requiresHowDecision ? ["agentic-grilling"] : [] });
    return requestNormalChanges(projectRoot, runRoot, state, runId, handoff, "Implementador",
      "Resolve the explicit test or validation blocker without silently changing a contradictory test.");
  }
  validateNormalTesterCompleted(handoff, plan, state.configurationSnapshot.orchestration.handoffMaxBytes);
  if (handoff.payload.changedTests === true || handoff.payload.changedConfiguration === true) {
    if (handoff.payload.productionCorrect !== true || handoff.payload.testContradiction === true) {
      throw new OrchestrationError("handoff_invalid",
        "Tester may change tests only after proving production is correct and may not silently change a contradiction");
    }
    const baseline = await baselineFor(projectRoot, state.qualityTargets);
    const role = normalRole(state.currentRole.sequence + 1, "Refactor");
    const brief = buildNormalBrief(state, runId, role,
      "Repeat every invalidated read-only quality gate because tests or configuration changed.",
      plan, handoff, { invalidatedBy: handoff.payload.changedConfiguration ? "configuration" : "tests",
        quality: { targets: [...state.qualityTargets], baseline } });
    return persistNormalRole(projectRoot, runRoot, state, role, brief, [
      { role: "Tester", status: "completed", summary: handoff.summary, at: new Date().toISOString() },
      { role: "Refactor", status: "started", summary: "Tester changes invalidated quality gates",
        at: new Date().toISOString() },
    ], [], { baseline, lastHandoff: structuredClone(handoff),
      reports: (state.reports ?? []).map((report) => ({ ...report, status: "stale" })) });
  }
  const role = normalRole(state.currentRole.sequence + 1, "Documentador");
  const brief = buildNormalBrief(state, runId, role,
    "Update only documentation suggested by the plan; documentation is advisory and cannot open retrabajo.",
    plan, handoff);
  return persistNormalRole(projectRoot, runRoot, state, role, brief, [
    { role: "Tester", status: "completed", summary: handoff.summary, at: new Date().toISOString() },
    { role: "Documentador", status: "started", summary: "Tester -> Documentador", at: new Date().toISOString() },
  ], [], { lastHandoff: structuredClone(handoff) });
}
async function completeNormalDocumentation(projectRoot, runRoot, state, runId, handoff) {
  if (handoff?.status === "completed") {
    validateCompletedHandoff(handoff, "Documentador", state.configurationSnapshot.orchestration.handoffMaxBytes);
    if (handoff.payload.findings.some((finding) => finding?.impact !== "advisory" || finding?.category !== "documentation")) {
      throw new OrchestrationError("handoff_invalid", "Documentador findings may only be advisory documentation findings");
    }
    const result = { status: "completed", mode: "normal", runId, reworkCount: state.reworkCount,
      summary: handoff.summary, handoff: structuredClone(handoff) };
    await rm(runRoot, { recursive: true });
    return result;
  }
  if (!state.documentationRetryUsed) {
    const plan = await normalPlan(runRoot);
    const role = normalRole(state.currentRole.sequence + 1, "Documentador");
    const brief = buildNormalBrief(state, runId, role,
      "Retry the documentation-only mission once; report advisory evidence if it still cannot complete.",
      plan, plainObject(handoff) ? handoff : { status: "failed", summary: "Invalid documentation hand-off" });
    return persistNormalRole(projectRoot, runRoot, state, role, brief, [
      { role: "Documentador", status: "retry", summary: handoff?.summary ?? "Invalid documentation hand-off",
        at: new Date().toISOString() },
    ], [], { documentationRetryUsed: true });
  }
  const result = { status: "completed_with_warnings", mode: "normal", runId, reworkCount: state.reworkCount,
    summary: handoff?.summary ?? "Documentation failed after one retry" };
  await rm(runRoot, { recursive: true });
  return result;
}
async function advanceNormalHandoff(projectRoot, runRoot, state, runId, handoff) {
  if (!NORMAL_ROLES.has(state.currentRole?.name)) throw new OrchestrationError("role_mismatch", "Unknown normal role");
  if (state.currentRole.name === "Documentador") {
    return completeNormalDocumentation(projectRoot, runRoot, state, runId, handoff);
  }
  if (CONTROL_STATUSES.has(handoff?.status)) return handleNormalControlHandoff(projectRoot, runRoot, state, runId, handoff);
  if (TERMINAL_STATUSES.has(handoff?.status)) return handleNormalTerminalHandoff(projectRoot, runRoot, state, runId, handoff);
  if (state.currentRole.name === "Planificador") return submitNormalPlanner(projectRoot, runRoot, state, runId, handoff);
  if (state.currentRole.name === "Implementador") return submitNormalImplementer(projectRoot, runRoot, state, runId, handoff);
  if (state.currentRole.name === "Refactor") return submitNormalRefactor(projectRoot, runRoot, state, runId, handoff);
  return submitNormalTester(projectRoot, runRoot, state, runId, handoff);
}

async function advanceHandoff({ projectRoot: projectDirectory, runId, handoff }) {
  const projectRoot = path.resolve(projectDirectory);
  const { runRoot, state } = await readRun(projectRoot, runId);
  if (state.status !== "running") throw new OrchestrationError("run_not_resumable", `Run is ${state.status}`);
  if (state.mode === "normal") return advanceNormalHandoff(projectRoot, runRoot, state, runId, handoff);
  if (TERMINAL_STATUSES.has(handoff?.status)) return handleTerminalHandoff(projectRoot, runRoot, state, runId, handoff);
  if (CONTROL_STATUSES.has(handoff?.status)) return handleControlHandoff(projectRoot, runRoot, state, runId, handoff);
  if (state.currentRole?.name === "Tester") return submitTesterHandoff(projectRoot, runRoot, state, runId, handoff);
  if (state.currentRole?.name !== "Implementador") throw new OrchestrationError("role_mismatch", "Unknown current role");
  validateImplementerHandoff(handoff, state.configurationSnapshot.orchestration.handoffMaxBytes);
  const qualityBaselineReport = preChangeBaseline(handoff.payload.qualityBaselineReport, state);
  const baseline = await baselineFor(projectRoot, handoff.payload.qualityTargets);
  const intention = JSON.parse(await readFile(path.join(runRoot, "intention.json"), "utf8"));
  const role = { sequence: state.currentRole.sequence + 1, name: "Tester", instanceId: randomUUID() };
  const brief = {
    schemaVersion: 1, runId, mode: "light", role,
    mission: "Independently verify every criterion, tests, C.R.A.P. and the canonical Golden Rules.",
    contract: LIGHT_CONTRACT, intention, previousHandoff: structuredClone(handoff),
    sources: [{ kind: "original_request", path: "sources/request.txt", sha256: state.sourceHashes.originalRequest }],
    policy: { kind: "golden_rules", path: "../../golden-rules.md", sha256: state.sourceHashes.goldenRules },
    quality: { targets: [...handoff.payload.qualityTargets], baseline,
      baselineReport: qualityBaselineReport ?? { status: "not_attributable" } },
    reviewPolicy: REVIEW_POLICY,
    configuration: state.configurationSnapshot, permissions: { read: true, write: false },
  };
  const briefContent = Buffer.from(json(brief));
  if (briefContent.byteLength > state.configurationSnapshot.orchestration.briefMaxBytes) {
    throw new OrchestrationError("context_budget_exceeded",
      `Brief requires ${briefContent.byteLength} bytes; limit is ${state.configurationSnapshot.orchestration.briefMaxBytes}`);
  }
  const nextState = { ...state, currentRole: role, baseline, lastHandoff: structuredClone(handoff),
    qualityBaselineReport,
    qualityTargets: [...handoff.payload.qualityTargets], protocolRetryUsed: false,
    transitions: [...state.transitions, { role: "Implementador", status: "completed", summary: handoff.summary,
      at: new Date().toISOString() }, { role: "Tester", status: "started", summary: "Implementador -> Tester",
      at: new Date().toISOString() }] };
  await writeTransaction(projectRoot, [
    { path: path.join(runRoot, "state.json"), content: Buffer.from(json(nextState)) },
    { path: path.join(runRoot, "briefs", `${String(role.sequence).padStart(3, "0")}-tester.json`), content: briefContent },
  ]);
  return { status: "continued", mode: "light", runId, role: structuredClone(role),
    summary: `${runId}: Implementador -> Tester`, brief };
}

function validateTesterChangesRequired(handoff, maximumBytes) {
  const errors = [];
  if (!plainObject(handoff)) errors.push("hand-off must be one JSON object");
  else {
    const allowed = new Set(["schemaVersion", "status", "summary", "payload"]);
    const unknown = Object.keys(handoff).filter((key) => !allowed.has(key));
    if (unknown.length) errors.push(`unknown hand-off keys: ${unknown.join(", ")}`);
    if (handoff.schemaVersion !== 1) errors.push("schemaVersion must be 1");
    if (handoff.status !== "changes_required") errors.push("Tester status must be changes_required");
    if (!requiredText(handoff.summary)) errors.push("summary must be non-empty text");
    const findings = handoff.payload?.findings;
    if (!Array.isArray(findings) || !hasMaterialBlocker(findings)) {
      errors.push("changes_required requires a blocking finding with category and concrete evidence");
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(handoff));
  if (bytes > maximumBytes) errors.push(`hand-off requires ${bytes} bytes; limit is ${maximumBytes}`);
  if (errors.length) throw new OrchestrationError("handoff_invalid", errors.join("; "));
}

async function submitTesterHandoff(projectRoot, runRoot, state, runId, handoff) {
  if (handoff?.status === "completed") return completedTesterHandoff(projectRoot, runRoot, state, runId, handoff);
  validateTesterChangesRequired(handoff, state.configurationSnapshot.orchestration.handoffMaxBytes);
  const reworkCount = state.reworkCount + 1;
  if (reworkCount > 2) {
    const blocked = { ...state, status: "blocked", reworkCount, lastHandoff: structuredClone(handoff),
      transitions: [...state.transitions, { role: "Tester", status: "blocked", summary: handoff.summary,
        at: new Date().toISOString() }] };
    await writeTransaction(projectRoot, [{ path: path.join(runRoot, "state.json"), content: Buffer.from(json(blocked)) }]);
    return { status: "blocked", mode: "light", runId, reworkCount, summary: handoff.summary };
  }
  const intention = JSON.parse(await readFile(path.join(runRoot, "intention.json"), "utf8"));
  const implementerBrief = await currentBrief(runRoot, 1);
  const role = { sequence: state.currentRole.sequence + 1, name: "Implementador", instanceId: randomUUID() };
  const brief = { schemaVersion: 1, runId, mode: "light", role,
    mission: "Resolve every blocking finding without weakening the acceptance criteria.",
    contract: LIGHT_CONTRACT, intention, previousHandoff: structuredClone(handoff), reworkCount,
    sources: [{ kind: "original_request", path: "sources/request.txt", sha256: state.sourceHashes.originalRequest }],
    policy: { kind: "golden_rules", path: "../../golden-rules.md", sha256: state.sourceHashes.goldenRules },
    configuration: state.configurationSnapshot, skills: implementerBrief.skills ?? [],
    permissions: { read: true, write: true } };
  const content = Buffer.from(json(brief));
  if (content.byteLength > state.configurationSnapshot.orchestration.briefMaxBytes) {
    throw new OrchestrationError("context_budget_exceeded",
      `Brief requires ${content.byteLength} bytes; limit is ${state.configurationSnapshot.orchestration.briefMaxBytes}`);
  }
  const nextState = { ...state, currentRole: role, reworkCount, lastHandoff: structuredClone(handoff),
    protocolRetryUsed: false, transitions: [...state.transitions,
      { role: "Tester", status: "changes_required", summary: handoff.summary, at: new Date().toISOString() },
      { role: "Implementador", status: "started", summary: "Tester -> Implementador", at: new Date().toISOString() }] };
  await writeTransaction(projectRoot, [
    { path: path.join(runRoot, "state.json"), content: Buffer.from(json(nextState)) },
    { path: path.join(runRoot, "briefs", `${String(role.sequence).padStart(3, "0")}-implementador.json`), content },
  ]);
  return { status: "continued", mode: "light", runId, role: structuredClone(role),
    summary: `${runId}: Tester -> Implementador`, brief };
}

async function handleNormalControlHandoff(projectRoot, runRoot, state, runId, handoff) {
  validateControlHandoff(handoff, state.configurationSnapshot.orchestration.handoffMaxBytes);
  if (handoff.status === "needs_mode_change" && handoff.payload.requestedMode !== "full") {
    throw new OrchestrationError("handoff_invalid", "normal mode may only request full mode");
  }
  const plan = state.planHash ? await normalPlan(runRoot) : null;
  const role = normalRole(state.currentRole.sequence + 1, state.currentRole.name);
  const brief = buildNormalBrief(state, runId, role,
    "Continue the same normal-mode responsibility after the control event is resolved.", plan, handoff,
    { skills: state.currentRole.name === "Implementador" && state.changesExecutableBehavior ? ["agentic-tdd"] : [] });
  return persistNormalRole(projectRoot, runRoot, state, role, brief, [
    { role: state.currentRole.name, status: handoff.status, summary: handoff.summary, at: new Date().toISOString() },
  ], [], { lastHandoff: structuredClone(handoff) });
}
async function handleNormalTerminalHandoff(projectRoot, runRoot, state, runId, handoff) {
  const errors = [];
  if (!plainObject(handoff) || handoff.schemaVersion !== 1 || !TERMINAL_STATUSES.has(handoff.status)
    || !requiredText(handoff.summary) || !plainObject(handoff.payload)) errors.push("terminal hand-off has an invalid shape");
  else if (!Array.isArray(handoff.payload.findings) || !hasMaterialBlocker(handoff.payload.findings)) {
    errors.push("terminal hand-off requires typed blocking findings with evidence");
  }
  if (Buffer.byteLength(JSON.stringify(handoff)) > state.configurationSnapshot.orchestration.handoffMaxBytes) {
    errors.push("hand-off exceeds configured limit");
  }
  if (errors.length) throw new OrchestrationError("handoff_invalid", errors.join("; "));
  const terminal = { ...state, status: handoff.status, lastHandoff: structuredClone(handoff),
    transitions: [...state.transitions, { role: state.currentRole.name, status: handoff.status,
      summary: handoff.summary, at: new Date().toISOString() }] };
  await writeTransaction(projectRoot, [{ path: path.join(runRoot, "state.json"), content: Buffer.from(json(terminal)) }]);
  return { status: handoff.status, mode: "normal", runId, reworkCount: state.reworkCount, summary: handoff.summary };
}
async function retryInvalidNormalHandoff(projectRoot, runRoot, state, runId, error) {
  const protocolErrors = error.message.split("; ");
  if (state.currentRole.name === "Documentador") {
    return completeNormalDocumentation(projectRoot, runRoot, state, runId,
      { schemaVersion: 1, status: "failed", summary: protocolErrors.join("; "), payload: { findings: [] } });
  }
  if (state.protocolRetryUsed) {
    const failed = { ...state, status: "failed", transitions: [...state.transitions,
      { role: state.currentRole.name, status: "failed", summary: "Protocol retry failed", at: new Date().toISOString() }] };
    await writeTransaction(projectRoot, [{ path: path.join(runRoot, "state.json"), content: Buffer.from(json(failed)) }]);
    return { status: "failed", mode: "normal", runId, reworkCount: state.reworkCount, protocolErrors };
  }
  const plan = state.planHash ? await normalPlan(runRoot) : null;
  const role = normalRole(state.currentRole.sequence + 1, state.currentRole.name);
  const brief = buildNormalBrief(state, runId, role, "Return a valid hand-off for the same normal-mode role.",
    plan, null, { protocolErrors,
      skills: role.name === "Implementador" && state.changesExecutableBehavior ? ["agentic-tdd"] : [] });
  const result = await persistNormalRole(projectRoot, runRoot, state, role, brief, [
    { role: state.currentRole.name, status: "protocol_retry", summary: protocolErrors.join("; "),
      at: new Date().toISOString() },
  ], [], { protocolRetryUsed: true });
  return { ...result, status: "protocol_retry" };
}

async function retryInvalidHandoff(projectRoot, runId, error) {
  const { runRoot, state } = await readRun(projectRoot, runId);
  if (state.mode === "normal") return retryInvalidNormalHandoff(projectRoot, runRoot, state, runId, error);
  const protocolErrors = error.message.split("; ");
  if (state.protocolRetryUsed) {
    const failed = { ...state, status: "failed",
      transitions: [...state.transitions, { role: state.currentRole.name, status: "failed",
        summary: "Protocol retry failed", at: new Date().toISOString() }] };
    await writeTransaction(projectRoot, [{ path: path.join(runRoot, "state.json"), content: Buffer.from(json(failed)) }]);
    return { status: "failed", mode: "light", runId, reworkCount: state.reworkCount, protocolErrors };
  }
  const role = { sequence: state.currentRole.sequence + 1, name: state.currentRole.name, instanceId: randomUUID() };
  const previousBrief = await currentBrief(runRoot, state.currentRole.sequence);
  const brief = { schemaVersion: 1, runId, mode: "light", role,
    mission: "Return a valid hand-off for the same role.", contract: LIGHT_CONTRACT, protocolErrors,
    configuration: state.configurationSnapshot, skills: role.name === "Implementador" ? previousBrief.skills ?? [] : [],
    permissions: { read: true, write: role.name === "Implementador" } };
  const content = Buffer.from(json(brief));
  if (content.byteLength > state.configurationSnapshot.orchestration.briefMaxBytes) {
    throw new OrchestrationError("context_budget_exceeded",
      `Brief requires ${content.byteLength} bytes; limit is ${state.configurationSnapshot.orchestration.briefMaxBytes}`);
  }
  const nextState = { ...state, currentRole: role, protocolRetryUsed: true,
    transitions: [...state.transitions, { role: state.currentRole.name, status: "protocol_retry",
      summary: protocolErrors.join("; "), at: new Date().toISOString() }] };
  await writeTransaction(projectRoot, [
    { path: path.join(runRoot, "state.json"), content: Buffer.from(json(nextState)) },
    { path: path.join(runRoot, "briefs", `${String(role.sequence).padStart(3, "0")}-${role.name.toLowerCase()}-retry.json`),
      content },
  ]);
  return { status: "protocol_retry", mode: "light", runId, role: structuredClone(role),
    reworkCount: state.reworkCount, brief };
}

export async function submitHandoff(options) {
  const projectRoot = path.resolve(options.projectRoot);
  try {
    return await advanceHandoff({ ...options, projectRoot });
  } catch (error) {
    if (error?.code !== "handoff_invalid") throw error;
    return retryInvalidHandoff(projectRoot, options.runId, error);
  }
}

async function completedTesterHandoff(projectRoot, runRoot, state, runId, handoff) {
  const errors = [];
  if (!plainObject(handoff) || handoff.schemaVersion !== 1 || !requiredText(handoff.summary)
    || !plainObject(handoff.payload)) errors.push("completed Tester hand-off has an invalid shape");
  const findings = handoff.payload?.findings;
  if (!Array.isArray(findings)) errors.push("payload.findings must be an array");
  else if (findings.some((finding) => finding?.impact === "blocking")) errors.push("completed prohibits blocking findings");
  const intention = JSON.parse(await readFile(path.join(runRoot, "intention.json"), "utf8"));
  const criteria = handoff.payload?.criteria;
  if (!Array.isArray(criteria) || intention.criteria.some((expected) => !criteria.some((item) =>
    item?.criterion === expected && item.status === "passed" && requiredText(item.evidence)))) {
    errors.push("every acceptance criterion requires independent passed evidence");
  }
  if (handoff.payload?.tests?.status !== "passed" || !requiredText(handoff.payload?.tests?.evidence)) {
    errors.push("tests require passed evidence");
  }
  if (handoff.payload?.goldenRules?.status !== "passed" || !requiredText(handoff.payload?.goldenRules?.evidence)) {
    errors.push("Golden Rules require passed evidence");
  }
  const reference = handoff.payload?.crap;
  let report;
  if (!plainObject(reference) || !requiredText(reference.path) || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")) {
    errors.push("C.R.A.P. requires an artifact path and SHA-256");
  } else {
    const artifactPath = path.resolve(runRoot, ...reference.path.split("/"));
    const relative = path.relative(runRoot, artifactPath).split(path.sep).join("/");
    if (!relative.startsWith("artifacts/") || relative.startsWith("../")) errors.push("C.R.A.P. artifact path is invalid");
    else {
      try {
        const content = await readFile(artifactPath);
        if (sha256(content) !== reference.sha256) errors.push("C.R.A.P. artifact hash does not match");
        else report = JSON.parse(content.toString("utf8"));
      } catch { errors.push("C.R.A.P. artifact is missing or corrupt"); }
    }
  }
  const expectedConfigurationHash = sha256(JSON.stringify({
    crapThreshold: state.configurationSnapshot.quality.crapThreshold,
  }));
  if (report && (report.$schema !== "https://kroxidev.dev/agentic-core/quality-report.schema.json"
    || report.schemaVersion !== 1 || !["crap", "scan"].includes(report.tool)
    || !["approved", "not_applicable"].includes(report.status)
    || JSON.stringify(report.hashes?.inputs) !== JSON.stringify(state.baseline?.hashes)
    || report.hashes?.configuration !== expectedConfigurationHash)) {
    errors.push("C.R.A.P. report schema, status or input hashes are stale");
  }
  const current = await baselineFor(projectRoot, Object.keys(state.baseline?.hashes ?? {}));
  if (JSON.stringify(current.hashes) !== JSON.stringify(state.baseline?.hashes)) errors.push("quality baseline has diverged");
  const bytes = Buffer.byteLength(JSON.stringify(handoff));
  if (bytes > state.configurationSnapshot.orchestration.handoffMaxBytes) errors.push("hand-off exceeds 32 KiB limit");
  if (errors.length) throw new OrchestrationError("handoff_invalid", errors.join("; "));
  const result = { status: "completed", mode: "light", runId, reworkCount: state.reworkCount,
    summary: handoff.summary, handoff: structuredClone(handoff) };
  await rm(runRoot, { recursive: true });
  return result;
}

function assertPersistedState(state, runId) {
  if (!plainObject(state) || state.schemaVersion !== 1 || state.id !== runId || !new Set(["light", "normal"]).has(state.mode)
    || !plainObject(state.currentRole) || !Array.isArray(state.transitions) || !plainObject(state.sourceHashes)
    || !plainObject(state.configurationSnapshot)) {
    throw new OrchestrationError("state_invalid", `Run state is invalid: ${runId}`);
  }
  if (state.mode === "normal" && (!NORMAL_ROLES.has(state.currentRole.name)
    || !(state.planHash === null || /^[a-f0-9]{64}$/.test(state.planHash)))) {
    throw new OrchestrationError("state_invalid", `Normal run state is invalid: ${runId}`);
  }
  validateConfiguration(state.configurationSnapshot);
}

export async function listOrchestrations(projectDirectory) {
  const projectRoot = path.resolve(projectDirectory);
  const runsRoot = path.join(projectRoot, ".agentic-core", "runs");
  let entries;
  try { entries = await readdir(runsRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name)) continue;
    try {
      const state = JSON.parse(await readFile(path.join(runsRoot, entry.name, "state.json"), "utf8"));
      assertPersistedState(state, entry.name);
      if (state.status === "running") runs.push({ id: state.id, mode: state.mode, status: state.status,
        role: structuredClone(state.currentRole), reworkCount: state.reworkCount });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return runs.sort((left, right) => left.id.localeCompare(right.id));
}

async function currentBrief(runRoot, sequence) {
  const prefix = `${String(sequence).padStart(3, "0")}-`;
  const names = (await readdir(path.join(runRoot, "briefs"))).filter((name) => name.startsWith(prefix));
  if (names.length !== 1) throw new OrchestrationError("state_invalid", "Current role brief is missing or ambiguous");
  return JSON.parse(await readFile(path.join(runRoot, "briefs", names[0]), "utf8"));
}

async function validateRunSources(projectRoot, runRoot, state) {
  const request = await readFile(path.join(runRoot, "sources", "request.txt"));
  const policy = await readFile(path.join(projectRoot, ".agentic-core", "golden-rules.md"));
  if (sha256(request) !== state.sourceHashes.originalRequest || sha256(policy) !== state.sourceHashes.goldenRules) {
    throw new OrchestrationError("source_diverged", "Immutable run sources or canonical policy have diverged");
  }
  if (state.mode === "normal" && state.planHash) {
    const plan = await readFile(path.join(runRoot, "plan.json"));
    if (sha256(plan) !== state.planHash) throw new OrchestrationError("source_diverged", "Current plan has diverged");
  }
}

async function resumeDivergedNormal(projectRoot, runRoot, state, runId, baseline) {
  const plan = await normalPlan(runRoot);
  const role = normalRole(state.currentRole.sequence + 1, "Refactor");
  const brief = buildNormalBrief(state, runId, role,
    "Re-run read-only Golden Rules, structure, C.R.A.P. and Mutation Testing because quality inputs diverged.",
    plan, state.lastHandoff, { divergence: { previous: state.baseline.hashes, current: baseline.hashes } });
  const result = await persistNormalRole(projectRoot, runRoot, state, role, brief, [
    { role: "Refactor", status: "started", summary: "Divergence detected; all affected gates invalidated",
      at: new Date().toISOString() },
  ], [], { baseline, reports: (state.reports ?? []).map((report) => ({ ...report, status: "stale" })) });
  return { ...result, status: "resumed", staleReports: true };
}

async function resumeDivergedTester(projectRoot, runRoot, state, runId, baseline) {
  const intention = JSON.parse(await readFile(path.join(runRoot, "intention.json"), "utf8"));
  const role = { sequence: state.currentRole.sequence + 1, name: "Tester", instanceId: randomUUID() };
  const brief = { schemaVersion: 1, runId, mode: "light", role,
    mission: "Re-run independent validation because quality inputs diverged.", contract: LIGHT_CONTRACT,
    intention, previousHandoff: state.lastHandoff, divergence: { previous: state.baseline.hashes, current: baseline.hashes },
    reviewPolicy: REVIEW_POLICY,
    configuration: state.configurationSnapshot, permissions: { read: true, write: false } };
  const content = Buffer.from(json(brief));
  if (content.byteLength > state.configurationSnapshot.orchestration.briefMaxBytes) {
    throw new OrchestrationError("context_budget_exceeded", "Divergence brief exceeds configured limit");
  }
  const nextState = { ...state, currentRole: role, baseline,
    reports: (state.reports ?? []).map((report) => ({ ...report, status: "stale" })),
    transitions: [...state.transitions, { role: "Tester", status: "started",
      summary: "Divergence detected; reports invalidated", at: new Date().toISOString() }] };
  await writeTransaction(projectRoot, [
    { path: path.join(runRoot, "state.json"), content: Buffer.from(json(nextState)) },
    { path: path.join(runRoot, "briefs", `${String(role.sequence).padStart(3, "0")}-tester.json`), content },
  ]);
  return { status: "resumed", mode: "light", runId, role: structuredClone(role),
    reworkCount: state.reworkCount, staleReports: true, brief };
}

export async function resumeOrchestration({ projectRoot: projectDirectory, runId } = {}) {
  const projectRoot = path.resolve(projectDirectory ?? process.cwd());
  if (runId === undefined) return { status: "selection_required", runs: await listOrchestrations(projectRoot) };
  const { runRoot, state } = await readRun(projectRoot, runId);
  assertPersistedState(state, runId);
  if (state.status !== "running") throw new OrchestrationError("run_not_resumable", `Run is ${state.status}`);
  await validateRunSources(projectRoot, runRoot, state);
  if (state.baseline?.hashes) {
    let current;
    try { current = await baselineFor(projectRoot, Object.keys(state.baseline.hashes)); }
    catch (error) {
      if (error?.code === "ENOENT") return { status: "context_missing", mode: state.mode, runId,
        reworkCount: state.reworkCount, missing: error.path };
      throw error;
    }
    if (JSON.stringify(current.hashes) !== JSON.stringify(state.baseline.hashes)) {
      if (state.mode === "normal") return resumeDivergedNormal(projectRoot, runRoot, state, runId, current);
      return resumeDivergedTester(projectRoot, runRoot, state, runId, current);
    }
  }
  const brief = await currentBrief(runRoot, state.currentRole.sequence);
  return { status: "resumed", mode: state.mode, runId, role: structuredClone(state.currentRole),
    reworkCount: state.reworkCount, staleReports: false, brief };
}

const CONTROL_STATUSES = new Set(["needs_input", "needs_mode_change", "context_missing"]);
function validateControlHandoff(handoff, maximumBytes) {
  const errors = [];
  if (!plainObject(handoff) || handoff.schemaVersion !== 1 || !CONTROL_STATUSES.has(handoff.status)
    || !requiredText(handoff.summary) || !plainObject(handoff.payload)) {
    errors.push("control hand-off has an invalid shape");
  } else {
    const allowed = new Set(["schemaVersion", "status", "summary", "payload"]);
    if (Object.keys(handoff).some((key) => !allowed.has(key))) errors.push("control hand-off has unknown keys");
    if (!Array.isArray(handoff.payload.findings)) errors.push("payload.findings must be an array");
    if (handoff.status === "needs_input" && !requiredText(handoff.payload.question)) errors.push("question is required");
    if (handoff.status === "context_missing" && (!Array.isArray(handoff.payload.missing)
      || handoff.payload.missing.length === 0 || handoff.payload.missing.some((item) => !requiredText(item)))) {
      errors.push("missing context paths are required");
    }
    if (handoff.status === "needs_mode_change" && (!new Set(["normal", "full"]).has(handoff.payload.requestedMode)
      || !requiredText(handoff.payload.reason))) errors.push("requestedMode and reason are required");
  }
  if (Buffer.byteLength(JSON.stringify(handoff)) > maximumBytes) errors.push("hand-off exceeds configured limit");
  if (errors.length) throw new OrchestrationError("handoff_invalid", errors.join("; "));
}

async function handleControlHandoff(projectRoot, runRoot, state, runId, handoff) {
  validateControlHandoff(handoff, state.configurationSnapshot.orchestration.handoffMaxBytes);
  const role = { sequence: state.currentRole.sequence + 1, name: state.currentRole.name, instanceId: randomUUID() };
  const previousBrief = await currentBrief(runRoot, state.currentRole.sequence);
  const brief = { schemaVersion: 1, runId, mode: "light", role,
    mission: "Continue the same responsibility after the control event is resolved.",
    contract: LIGHT_CONTRACT, previousHandoff: structuredClone(handoff),
    configuration: state.configurationSnapshot, skills: role.name === "Implementador" ? previousBrief.skills ?? [] : [],
    permissions: { read: true, write: role.name === "Implementador" } };
  const content = Buffer.from(json(brief));
  if (content.byteLength > state.configurationSnapshot.orchestration.briefMaxBytes) {
    throw new OrchestrationError("context_budget_exceeded", "Control-event brief exceeds configured limit");
  }
  const nextState = { ...state, currentRole: role, lastHandoff: structuredClone(handoff), protocolRetryUsed: false,
    transitions: [...state.transitions, { role: state.currentRole.name, status: handoff.status,
      summary: handoff.summary, at: new Date().toISOString() }] };
  await writeTransaction(projectRoot, [
    { path: path.join(runRoot, "state.json"), content: Buffer.from(json(nextState)) },
    { path: path.join(runRoot, "briefs", `${String(role.sequence).padStart(3, "0")}-${role.name.toLowerCase()}.json`),
      content },
  ]);
  return { status: handoff.status, mode: "light", runId, role: structuredClone(role),
    reworkCount: state.reworkCount, brief };
}

const TERMINAL_STATUSES = new Set(["failed", "blocked"]);
async function handleTerminalHandoff(projectRoot, runRoot, state, runId, handoff) {
  const errors = [];
  if (!plainObject(handoff) || handoff.schemaVersion !== 1 || !TERMINAL_STATUSES.has(handoff.status)
    || !requiredText(handoff.summary) || !plainObject(handoff.payload)) {
    errors.push("terminal hand-off has an invalid shape");
  } else {
    const allowed = new Set(["schemaVersion", "status", "summary", "payload"]);
    if (Object.keys(handoff).some((key) => !allowed.has(key))) errors.push("terminal hand-off has unknown keys");
    const findings = handoff.payload.findings;
    if (!Array.isArray(findings) || !hasMaterialBlocker(findings)) {
      errors.push("terminal hand-off requires typed blocking findings with evidence");
    }
  }
  if (Buffer.byteLength(JSON.stringify(handoff)) > state.configurationSnapshot.orchestration.handoffMaxBytes) {
    errors.push("hand-off exceeds configured limit");
  }
  if (errors.length) throw new OrchestrationError("handoff_invalid", errors.join("; "));
  const terminal = { ...state, status: handoff.status, lastHandoff: structuredClone(handoff),
    transitions: [...state.transitions, { role: state.currentRole.name, status: handoff.status,
      summary: handoff.summary, at: new Date().toISOString() }] };
  await writeTransaction(projectRoot, [{ path: path.join(runRoot, "state.json"), content: Buffer.from(json(terminal)) }]);
  return { status: handoff.status, mode: "light", runId, reworkCount: state.reworkCount, summary: handoff.summary };
}
