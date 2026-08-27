import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
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
