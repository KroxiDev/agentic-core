import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
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
function normalizeIntention(value, source) {
  assertIntentionShape(value);
  if (!requiredText(value.objective)) {
    return { clarification: "What objective should this light execution achieve?" };
  }
  const criteria = textList(value.criteria, "criteria");
  if (!criteria.length) return { clarification: "What verifiable acceptance criteria should the Implementador satisfy?" };
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

export async function startOrchestration({ projectRoot: projectDirectory, request, intention, changesExecutableBehavior = false }) {
  const parsed = parseRequest(request);
  if (!parsed.activated) return { status: "direct", mode: "direct", request: parsed.task };
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
  const state = {
    schemaVersion: 1, id: runId, mode: "light", status: "running", currentRole: brief.role, reworkCount: 0,
    sourceHashes: { originalRequest: requestSource.sha256, goldenRules: policySource.sha256 },
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
  const hashes = {};
  for (const target of targets) {
    const resolved = path.resolve(projectRoot, target);
    const relative = path.relative(projectRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new OrchestrationError("handoff_invalid", `Quality target must be a project-relative file: ${target}`);
    }
    hashes[target.split(path.sep).join("/")] = sha256(await readFile(resolved));
  }
  return { capturedAt: new Date().toISOString(), hashes };
}

async function advanceHandoff({ projectRoot: projectDirectory, runId, handoff }) {
  const projectRoot = path.resolve(projectDirectory);
  const { runRoot, state } = await readRun(projectRoot, runId);
  if (state.status !== "running") throw new OrchestrationError("run_not_resumable", `Run is ${state.status}`);
  if (TERMINAL_STATUSES.has(handoff?.status)) return handleTerminalHandoff(projectRoot, runRoot, state, runId, handoff);
  if (CONTROL_STATUSES.has(handoff?.status)) return handleControlHandoff(projectRoot, runRoot, state, runId, handoff);
  if (state.currentRole?.name === "Tester") return submitTesterHandoff(projectRoot, runRoot, state, runId, handoff);
  if (state.currentRole?.name !== "Implementador") throw new OrchestrationError("role_mismatch", "Unknown current role");
  validateImplementerHandoff(handoff, state.configurationSnapshot.orchestration.handoffMaxBytes);
  const baseline = await baselineFor(projectRoot, handoff.payload.qualityTargets);
  const intention = JSON.parse(await readFile(path.join(runRoot, "intention.json"), "utf8"));
  const role = { sequence: state.currentRole.sequence + 1, name: "Tester", instanceId: randomUUID() };
  const brief = {
    schemaVersion: 1, runId, mode: "light", role,
    mission: "Independently verify every criterion, tests, C.R.A.P. and the canonical Golden Rules.",
    contract: LIGHT_CONTRACT, intention, previousHandoff: structuredClone(handoff),
    sources: [{ kind: "original_request", path: "sources/request.txt", sha256: state.sourceHashes.originalRequest }],
    policy: { kind: "golden_rules", path: "../../golden-rules.md", sha256: state.sourceHashes.goldenRules },
    configuration: state.configurationSnapshot, permissions: { read: true, write: false },
  };
  const briefContent = Buffer.from(json(brief));
  if (briefContent.byteLength > state.configurationSnapshot.orchestration.briefMaxBytes) {
    throw new OrchestrationError("context_budget_exceeded",
      `Brief requires ${briefContent.byteLength} bytes; limit is ${state.configurationSnapshot.orchestration.briefMaxBytes}`);
  }
  const nextState = { ...state, currentRole: role, baseline, lastHandoff: structuredClone(handoff),
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
    const categories = new Set(["specification", "tests", "crap", "mutation", "golden_rules",
      "required_validation", "documentation"]);
    if (!Array.isArray(findings) || !findings.some((finding) => finding?.impact === "blocking"
      && categories.has(finding.category) && requiredText(finding.evidence))) {
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

async function retryInvalidHandoff(projectRoot, runId, error) {
  const { runRoot, state } = await readRun(projectRoot, runId);
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
  if (!plainObject(state) || state.schemaVersion !== 1 || state.id !== runId || state.mode !== "light"
    || !plainObject(state.currentRole) || !Array.isArray(state.transitions) || !plainObject(state.sourceHashes)
    || !plainObject(state.configurationSnapshot)) {
    throw new OrchestrationError("state_invalid", `Run state is invalid: ${runId}`);
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
}

async function resumeDivergedTester(projectRoot, runRoot, state, runId, baseline) {
  const intention = JSON.parse(await readFile(path.join(runRoot, "intention.json"), "utf8"));
  const role = { sequence: state.currentRole.sequence + 1, name: "Tester", instanceId: randomUUID() };
  const brief = { schemaVersion: 1, runId, mode: "light", role,
    mission: "Re-run independent validation because quality inputs diverged.", contract: LIGHT_CONTRACT,
    intention, previousHandoff: state.lastHandoff, divergence: { previous: state.baseline.hashes, current: baseline.hashes },
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
      if (error?.code === "ENOENT") return { status: "context_missing", mode: "light", runId,
        reworkCount: state.reworkCount, missing: error.path };
      throw error;
    }
    if (JSON.stringify(current.hashes) !== JSON.stringify(state.baseline.hashes)) {
      return resumeDivergedTester(projectRoot, runRoot, state, runId, current);
    }
  }
  const brief = await currentBrief(runRoot, state.currentRole.sequence);
  return { status: "resumed", mode: "light", runId, role: structuredClone(state.currentRole),
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
  const categories = new Set(["specification", "tests", "crap", "mutation", "golden_rules",
    "required_validation", "documentation"]);
  if (!plainObject(handoff) || handoff.schemaVersion !== 1 || !TERMINAL_STATUSES.has(handoff.status)
    || !requiredText(handoff.summary) || !plainObject(handoff.payload)) {
    errors.push("terminal hand-off has an invalid shape");
  } else {
    const allowed = new Set(["schemaVersion", "status", "summary", "payload"]);
    if (Object.keys(handoff).some((key) => !allowed.has(key))) errors.push("terminal hand-off has unknown keys");
    const findings = handoff.payload.findings;
    if (!Array.isArray(findings) || findings.length === 0 || findings.some((finding) =>
      finding?.impact !== "blocking" || !categories.has(finding.category) || !requiredText(finding.evidence))) {
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
