import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfiguration } from "../installation/install.js";
import { PYTHON_TOOLS, privatePython } from "../installation/python.js";
import { writeTransaction } from "../transaction.js";
import { commandBudget, executeCommand, IntegrationError } from "./command.js";
import { compareCodeUnits } from "./order.js";
import { captureProjectInputs, inputHash, privateInputContent, publicCheckpoint } from "./project-inputs.js";
import { readActiveTask } from "./task-baseline.js";

const engine = Object.freeze({ name: "dry4python", version: PYTHON_TOOLS.dry4python });
const reportReference = ".agentic-core/quality/dry.json";
const resolutionReference = ".agentic-core/quality/dry-resolutions.json";
const hash = (value) => inputHash(JSON.stringify(value));
const preparationHelper = fileURLToPath(new URL("agentic_dry.py", import.meta.url));

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.includes("\\")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function sourceEntries(checkpoint) {
  return checkpoint.entries
    .filter((entry) => entry.kind === "measured_code" && entry.path.endsWith(".py"))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function validateSourceEntry(entry) {
  if (!plainObject(entry) || !safeRelativePath(entry.path) || !entry.path.endsWith(".py")
    || !Buffer.isBuffer(entry.content) || entry.sha256 !== inputHash(entry.content)
    || privateInputContent(entry.content)) {
    throw new IntegrationError("invalid_dry_inputs", "El checkpoint Python no es íntegro o contiene un input privado", 2);
  }
}

function locationKey(location) {
  return `${location.file}:${location.startLine}-${location.endLine}:${location.qualname}`;
}

function candidateKey(candidate) {
  return [candidate.left.sourceHash, candidate.right.sourceHash].sort().join("\0");
}

function normalizeEnginePath(value) {
  if (typeof value !== "string") return "";
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function normalizeLocation(value, paths) {
  if (!plainObject(value)) throw new IntegrationError("invalid_dry_evidence", "dry4python devolvió una ubicación inválida", 5);
  const sourcePath = paths.get(normalizeEnginePath(value.file));
  const startLine = value.start_line;
  const endLine = value.end_line;
  if (!sourcePath || !Number.isInteger(startLine) || startLine < 1
    || !Number.isInteger(endLine) || endLine < startLine
    || typeof value.qualname !== "string") {
    throw new IntegrationError("invalid_dry_evidence", "dry4python devolvió una ubicación no atribuible", 5);
  }
  return { file: sourcePath, startLine, endLine, qualname: value.qualname };
}

function normalizeCandidate(value, paths, limits) {
  if (!plainObject(value) || !plainObject(value.left) || !plainObject(value.right)
    || !Number.isFinite(value.score) || value.score < 0 || value.score > 1
    || !Number.isInteger(value.left_nodes) || value.left_nodes < limits.minNodes
    || !Number.isInteger(value.right_nodes) || value.right_nodes < limits.minNodes) {
    throw new IntegrationError("invalid_dry_evidence", "dry4python devolvió un candidato inválido", 5);
  }
  const left = normalizeLocation(value.left, paths);
  const right = normalizeLocation(value.right, paths);
  if (left.endLine - left.startLine + 1 < limits.minLines
    || right.endLine - right.startLine + 1 < limits.minLines
    || value.score + Number.EPSILON < limits.similarity) {
    throw new IntegrationError("invalid_dry_evidence", "dry4python ignoró los límites efectivos de detección", 5);
  }
  const ordered = [left, right].sort((a, b) => compareCodeUnits(locationKey(a), locationKey(b)));
  return {
    id: hash({ engine, limits, left: ordered[0], right: ordered[1] }),
    score: Number(value.score.toFixed(6)),
    left,
    right,
    leftNodes: value.left_nodes,
    rightNodes: value.right_nodes,
  };
}

function normalizeGroups(values, paths) {
  if (!Array.isArray(values)) {
    throw new IntegrationError("invalid_dry_evidence", "dry4python no devolvió grupos normalizados", 5);
  }
  return values.map((value) => {
    if (!plainObject(value) || !Number.isFinite(value.score) || value.score < 0 || value.score > 1
      || !Number.isInteger(value.pairs) || value.pairs < 1 || !Array.isArray(value.locations)) {
      throw new IntegrationError("invalid_dry_evidence", "dry4python devolvió un grupo inválido", 5);
    }
    const locations = value.locations.map((location) => normalizeLocation(location, paths))
      .sort((left, right) => compareCodeUnits(locationKey(left), locationKey(right)));
    if (locations.length < 2) throw new IntegrationError("invalid_dry_evidence", "dry4python devolvió un grupo sin pares", 5);
    return {
      id: hash({ locations }),
      score: Number(value.score.toFixed(6)),
      locations,
      pairs: value.pairs,
    };
  });
}

async function materializeSources(root, sources) {
  const directory = path.join(root, "sources");
  await mkdir(directory, { recursive: true });
  const paths = new Map();
  const argumentsList = [];
  for (const [index, source] of sources.entries()) {
    validateSourceEntry(source);
    const enginePath = `sources/${String(index + 1).padStart(6, "0")}.py`;
    const target = path.join(root, ...enginePath.split("/"));
    await writeFile(target, source.content, Number.isInteger(source.mode) ? { mode: source.mode } : undefined);
    paths.set(enginePath, source.path);
    argumentsList.push(enginePath);
  }
  return { paths, argumentsList };
}

async function inspectEngineVersion(root, python, budget) {
  const outcome = await executeCommand({ executable: python, args: [
    "-I", "-B", "-c", "import importlib.metadata as m; print(m.version('dry4python'))",
  ] }, { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: budget() });
  if (outcome.exitCode !== 0 || outcome.stdout.trim() !== engine.version) {
    throw new IntegrationError("dry_tool_version", "La versión efectiva de dry4python no coincide con la fijada", 2);
  }
  return engine;
}

async function runEngine(root, python, sources, limits, budget) {
  const temporary = await mkdtemp(path.join(tmpdir(), "agentic-dry-"));
  try {
    const materialized = await materializeSources(temporary, sources);
    const prepared = await executeCommand({ executable: python, args: [
      "-I", "-B", preparationHelper, String(limits.minLines), String(limits.minNodes), ...materialized.argumentsList,
    ] }, { cwd: temporary, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: budget() });
    if (prepared.exitCode !== 0) throw new IntegrationError("dry_preparation_failed", "No se pudo comprobar la cobertura del detector DRY", 2);
    const metadata = JSON.parse(prepared.stdout);
    if (!Array.isArray(metadata) || metadata.length !== sources.length) {
      throw new IntegrationError("invalid_dry_evidence", "La preparación DRY no cubre los inputs seleccionados", 5);
    }
    const issues = metadata.flatMap((entry) => entry.issues.map((issue) => ({ ...issue, file: materialized.paths.get(entry.file) })));
    const argumentsList = metadata.filter((entry) => entry.scannable).map((entry) => entry.file);
    if (!argumentsList.length) return { candidates: [], groups: [], issues };
    const outcome = await executeCommand({ executable: python, args: [
      "-I", "-B", "-m", "dry4python", "--format", "json",
      "--threshold", String(limits.similarity),
      "--min-lines", String(limits.minLines),
      "--min-nodes", String(limits.minNodes),
      ...argumentsList,
    ] }, { cwd: temporary, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: budget() });
    if (outcome.exitCode !== 0) {
      throw new IntegrationError("dry_engine_failed", "dry4python no pudo completar la detección", 2);
    }
    let parsed;
    try { parsed = JSON.parse(outcome.stdout.replace(/^\uFEFF/u, "")); }
    catch { throw new IntegrationError("invalid_dry_evidence", "dry4python no devolvió evidencia JSON válida", 5); }
    if (!plainObject(parsed) || !Array.isArray(parsed.candidates) || !Array.isArray(parsed.groups)) {
      throw new IntegrationError("invalid_dry_evidence", "dry4python no devolvió el contrato esperado", 5);
    }
    const candidates = parsed.candidates.map((candidate) => {
      const normalized = normalizeCandidate(candidate, materialized.paths, limits);
      for (const side of ["left", "right"]) {
        const location = normalized[side];
        const source = metadata.find((entry) => materialized.paths.get(entry.file) === location.file);
        const body = source?.functions.find((entry) => entry.startLine === location.startLine && entry.endLine === location.endLine);
        if (!body) throw new IntegrationError("invalid_dry_evidence", "No se pudo atribuir el cuerpo del candidato DRY", 5);
        location.sourceHash = body.sha256;
        location.bodyReferences = body.references;
      }
      return normalized;
    });
    const groups = normalizeGroups(parsed.groups, materialized.paths);
    return { candidates, groups, issues };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function sameScope(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && [...left].sort().join("\0") === [...right].sort().join("\0");
}

function invalidBaseline(reason) {
  return { status: "NO_VERIFICADO", reason, sources: [], inventory: [], digest: null };
}

async function loadBaseline(root, config, activeTask) {
  const loaded = activeTask === undefined ? await readActiveTask(root) : activeTask;
  if (!loaded) return { status: "not_requested", reason: null, sources: [], inventory: [], digest: null };
  const task = loaded.task;
  if (!task.initial.valid) return invalidBaseline("baseline_initial_invalid");
  if (!sameScope(task.scope, config.integration.python.scope)) {
    return invalidBaseline("baseline_conditions_changed");
  }
  if (!plainObject(task.initial.inputs) || typeof task.initial.inputs.digest !== "string"
    || !Array.isArray(task.initial.inputs.inventory) || !Array.isArray(task.initial.sources)) {
    return invalidBaseline("baseline_inputs_invalid");
  }
  const inventory = task.initial.inputs.inventory;
  if (task.initial.inputs.digest !== hash({ inventory, scope: config.integration.python.scope,
    inputs: config.integration.python.inputs })) return invalidBaseline("baseline_inputs_invalid");
  const seen = new Set();
  const inventoryByPath = new Map();
  for (const entry of inventory) {
    if (!plainObject(entry) || !safeRelativePath(entry.path) || seen.has(entry.path)
      || !["measured_code", "test_input"].includes(entry.kind)
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
      || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")) return invalidBaseline("baseline_inputs_invalid");
    seen.add(entry.path);
    inventoryByPath.set(entry.path, entry);
  }
  const sourceSeen = new Set();
  const captured = task.initial.sources.map((entry) => {
    if (!plainObject(entry) || !safeRelativePath(entry.path) || sourceSeen.has(entry.path)
      || !["measured_code", "test_input"].includes(entry.kind) || typeof entry.content !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(entry.content)) {
      throw new IntegrationError("task_evidence_invalid", "La evidencia inicial contiene un input inválido", 2);
    }
    sourceSeen.add(entry.path);
    const inventoryEntry = inventoryByPath.get(entry.path);
    const content = Buffer.from(entry.content, "base64");
    if (!inventoryEntry || inventoryEntry.kind !== entry.kind || inventoryEntry.sha256 !== entry.sha256
      || entry.content !== content.toString("base64")) {
      throw new IntegrationError("task_evidence_invalid", "La evidencia inicial no coincide con su inventario", 2);
    }
    if (entry.sha256 !== inputHash(content) || privateInputContent(content)) {
      throw new IntegrationError("task_evidence_invalid", "La evidencia inicial no es íntegra o contiene un input privado", 2);
    }
    return { ...entry, content };
  });
  if (sourceSeen.size !== inventoryByPath.size) {
    throw new IntegrationError("task_evidence_invalid", "La evidencia inicial no cubre todos sus inputs", 2);
  }
  const sources = captured
    .filter((entry) => entry.kind === "measured_code" && entry.path.endsWith(".py"))
    .map((entry) => {
      const content = Buffer.from(entry.content, "base64");
      return { ...entry, content };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { status: "captured", reason: null, sources, inventory,
    digest: task.initial.inputs.digest };
}

async function readResolutions(root, inputsDigest, configurationHash) {
  const file = path.join(root, resolutionReference);
  let content;
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) throw new IntegrationError("dry_resolution_unsafe", "El archivo de resoluciones DRY no es seguro", 2);
    content = await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", entries: [], sha256: null, used: [], unused: [] };
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("dry_resolution_unreadable", "No se pudo leer el archivo de resoluciones DRY", 2);
  }
  if (privateInputContent(content)) throw new IntegrationError("private_dry_resolution", "La resolución DRY contiene datos privados", 4);
  let parsed;
  try { parsed = JSON.parse(content.toString("utf8")); }
  catch { throw new IntegrationError("dry_resolution_invalid", "El archivo de resoluciones DRY no es JSON válido", 4); }
  const entries = parsed?.resolutions;
  if (!plainObject(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(entries)) {
    throw new IntegrationError("dry_resolution_invalid", "El archivo de resoluciones DRY no cumple el esquema", 4);
  }
  const seen = new Set();
  const normalized = entries.map((entry) => {
    const candidate = entry?.candidate ?? entry?.candidateId;
    const decision = entry?.decision;
    const reason = entry?.reason;
    if (!plainObject(entry) || typeof candidate !== "string" || !/^[a-f0-9]{64}$/u.test(candidate)
      || seen.has(candidate) || decision !== "keep" || typeof reason !== "string"
      || reason.trim().length < 3 || reason.length > 500 || /[\r\n]/u.test(reason)) {
      throw new IntegrationError("dry_resolution_invalid", "Cada resolución DRY requiere candidato, decisión keep y justificación breve", 4);
    }
    seen.add(candidate);
    return { candidate, decision, reason: reason.trim() };
  });
  const current = parsed.inputs === inputsDigest && parsed.configuration === configurationHash;
  return {
    status: current ? "current" : "stale",
    entries: current ? normalized : [],
    sha256: inputHash(content),
    used: [],
    unused: normalized.map((entry) => entry.candidate),
  };
}

function concreteReason(resolution, candidate) {
  if (!resolution) return false;
  const reason = resolution.reason;
  const words = new Set(reason.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const names = [candidate.left.qualname, candidate.right.qualname];
  const references = [...candidate.left.bodyReferences, ...candidate.right.bodyReferences];
  const generic = /\b(?:ok(?:ay)?|looks good|no (?:necesita[n]?|requiere[n]?) cambios|est[aá]n? bien|sin (?:problemas|cambios necesarios))\b/iu.test(reason);
  // This checks a source-grounded contract; the Tester still owns the design judgment.
  return !generic && words.size >= 8 && names.every((name) => reason.includes(name))
    && references.some((reference) => reason.includes(reference));
}

function messageFor(status, code) {
  if (status === "NO_VERIFICADO") return "La detección DRY no tiene evidencia completa; revise la causa y conserve los resultados parciales";
  if (status === "rejected") return "Hay candidatos DRY nuevos o modificados sin una resolución concreta";
  if (status === "NO_APLICA") return "No hay código Python medible en el alcance configurado";
  if (code === "no_duplicates") return "No se encontraron candidatos de duplicación pertinentes";
  if (code === "preexisting_only") return "Los candidatos encontrados ya existían en el baseline de la tarea";
  return "Los candidatos DRY están resueltos o no pertenecen al cambio de la tarea";
}

function reportBase({ status, code, exitCode, config, checkpoint, baseline, engineInfo, candidates = [], groups = [], issues = [], resolutions, configurationHash }) {
  const limits = config.limits.dry;
  const baselineCandidates = baseline.scan?.candidates ?? [];
  const baselineKeys = new Map();
  for (const candidate of baselineCandidates) {
    const key = candidateKey(candidate);
    baselineKeys.set(key, (baselineKeys.get(key) ?? 0) + 1);
  }
  const resolutionMap = new Map((resolutions?.entries ?? []).map((entry) => [entry.candidate, entry]));
  const enriched = candidates.map((candidate) => {
    const key = candidateKey(candidate);
    const preexisting = baseline.status === "captured" && baseline.scan?.status === "measured" && baselineKeys.get(key) > 0;
    if (preexisting) baselineKeys.set(key, baselineKeys.get(key) - 1);
    const offeredResolution = resolutionMap.get(candidate.id);
    const resolution = concreteReason(offeredResolution, candidate) ? offeredResolution : undefined;
    const classification = preexisting ? "preexisting" : resolution ? "resolved" : "new_or_changed";
    return {
      ...candidate,
      classification,
      status: preexisting || resolution ? "accepted" : "unresolved",
      evidence: {
        score: candidate.score,
        similarityLimit: limits.similarity,
        nodes: { left: candidate.leftNodes, right: candidate.rightNodes },
        lines: {
          left: [candidate.left.startLine, candidate.left.endLine],
          right: [candidate.right.startLine, candidate.right.endLine],
        },
      },
      ...(resolution ? { resolution: { ...resolution, inputs: checkpoint.digest, configuration: configurationHash } } : {}),
    };
  });
  const unresolved = enriched.filter((candidate) => candidate.status === "unresolved");
  const preexisting = enriched.filter((candidate) => candidate.classification === "preexisting");
  const resolved = enriched.filter((candidate) => candidate.classification === "resolved");
  const used = enriched.filter((candidate) => candidate.classification === "resolved").map((candidate) => candidate.id);
  const unused = (resolutions?.entries ?? []).map((entry) => entry.candidate).filter((id) => !used.includes(id));
  const finalStatus = status ?? (baseline.status !== "not_requested" && baseline.status !== "captured"
    || baseline.scan?.status === "NO_VERIFICADO" || issues.length
    ? "NO_VERIFICADO" : checkpoint.entries.filter((entry) => entry.kind === "measured_code").length === 0
      ? "NO_APLICA" : unresolved.length ? "rejected" : "approved");
  const finalCode = code ?? (finalStatus === "NO_VERIFICADO" ? baseline.reason ?? baseline.scan?.code ?? (issues.length ? "dry_measurement_incomplete" : "dry_incomplete")
    : finalStatus === "NO_APLICA" ? "no_executable_code" : unresolved.length ? "dry_candidates_unresolved"
      : enriched.length === 0 ? "no_duplicates" : preexisting.length === enriched.length ? "preexisting_only" : "dry_resolved");
  const identity = hash({ engine: engineInfo, limits, inputs: checkpoint.digest,
    baseline: baseline.digest, candidates: enriched, groups, issues, resolutions: resolutions?.sha256 ?? null });
  return {
    command: "dry", schemaVersion: 1, status: finalStatus, code: finalCode,
    exitCode: finalStatus === "NO_VERIFICADO" ? exitCode ?? 2 : finalStatus === "rejected" ? 1 : 0,
    message: messageFor(finalStatus, finalCode), engine: engineInfo, limits,
    identity, hashes: { inputs: checkpoint.digest, configuration: configurationHash, baseline: baseline.digest,
      resolutions: resolutions?.sha256 ?? null },
    inputs: publicCheckpoint(checkpoint),
    baseline: { status: baseline.status, reason: baseline.reason, digest: baseline.digest,
      scan: baseline.scan?.status ?? "not_run", candidates: baselineCandidates, issues: baseline.scan?.issues ?? [],
      changedFiles: baseline.changedFiles ?? [] },
    resolutions: { reference: resolutionReference, status: resolutions?.status ?? "not_read",
      inputs: checkpoint.digest, configuration: configurationHash, sha256: resolutions?.sha256 ?? null,
      used, unused },
    groups, candidates: enriched, issues,
    summary: { candidates: enriched.length, unresolved: unresolved.length,
      preexisting: preexisting.length, resolved: resolved.length, groups: groups.length },
    reference: reportReference,
  };
}

async function finishReport(root, { ignoreStoredResolutions = false, ...parameters }) {
  const { config, checkpoint, configurationHash, resolutions } = parameters;
  const after = await captureProjectInputs(root, config.integration.python);
  let code;
  if (after.issues.length) code = "input_checkpoint_incompatible";
  else if (after.digest !== checkpoint.digest) code = "dry_inputs_changed";
  try {
    if (hash(await readConfiguration(path.join(root, ".agentic-core/config.json"))) !== configurationHash) code = "dry_configuration_changed";
  } catch { code = "dry_configuration_changed"; }
  if (!ignoreStoredResolutions) {
    try {
      const finalResolutions = await readResolutions(root, checkpoint.digest, configurationHash);
      if (finalResolutions.sha256 !== resolutions.sha256) code = "dry_resolutions_changed";
    } catch { code = "dry_resolutions_changed"; }
  }
  return reportBase({ ...parameters, ...(code ? { status: "NO_VERIFICADO", code, exitCode: 2 } : {}) });
}

export async function runPythonDry(root, { activeTask, ignoreStoredResolutions = false } = {}) {
  const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
  const configurationHash = hash(config);
  const budget = commandBudget(config.limits.operation);
  const before = await captureProjectInputs(root, config.integration.python);
  const currentSources = sourceEntries(before);
  const baseline = await loadBaseline(root, config, activeTask);
  baseline.changedFiles = baseline.status === "captured"
    ? [...new Set([...baseline.inventory.map((entry) => entry.path), ...before.inventory.map((entry) => entry.path)])]
      .filter((file) => baseline.inventory.find((entry) => entry.path === file)?.sha256
        !== before.inventory.find((entry) => entry.path === file)?.sha256)
      .sort()
    : [];
  const resolutions = ignoreStoredResolutions
    ? { status: "missing", entries: [], sha256: null, used: [], unused: [] }
    : await readResolutions(root, before.digest, configurationHash);
  const engineInfo = engine;
  if (before.issues.length) {
    return reportBase({ status: "NO_VERIFICADO", code: "input_checkpoint_incompatible", config,
      checkpoint: before, baseline, engineInfo, resolutions, configurationHash });
  }
  if (currentSources.length === 0) {
    return finishReport(root, { config, checkpoint: before, baseline, engineInfo, resolutions, configurationHash });
  }
  const python = privatePython(path.join(root, ".agentic-core/tools"));
  await inspectEngineVersion(root, python, budget);
  if (baseline.status === "captured" && baseline.sources.length > 0) {
    try {
      baseline.scan = { status: "measured", ...await runEngine(root, python, baseline.sources, config.limits.dry, budget) };
      if (baseline.scan.issues.length) {
        baseline.scan.status = "NO_VERIFICADO";
        baseline.scan.code = "baseline_dry_incomplete";
      }
    } catch (error) {
      if (["budget_exhausted", "command_timeout", "termination_failed"].includes(error?.code)) throw error;
      baseline.scan = { status: "NO_VERIFICADO", code: error?.code ?? "baseline_dry_failed" };
    }
  } else if (baseline.status === "captured") {
    baseline.scan = { status: "measured", candidates: [], groups: [] };
  }
  let current;
  try { current = await runEngine(root, python, currentSources, config.limits.dry, budget); }
  catch (error) {
    return finishReport(root, { status: "NO_VERIFICADO", code: error?.code ?? "dry_engine_failed", exitCode: error?.exitCode ?? 5,
      config, checkpoint: before, baseline, engineInfo, resolutions, configurationHash });
  }
  return finishReport(root, { config, checkpoint: before, baseline, engineInfo, resolutions, configurationHash,
    ignoreStoredResolutions, ...current });
}

async function saveReport(root, result) {
  for (const relative of [".agentic-core", ".agentic-core/quality"]) {
    const directory = path.join(root, relative);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe");
    } catch (error) {
      if (error?.code === "ENOENT" && relative.endsWith("/quality")) await mkdir(directory);
      else throw new IntegrationError("quality_report_unsafe", "La ubicación del informe DRY no es un directorio propio seguro", 2);
    }
  }
  const target = path.join(root, reportReference);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe");
    const previous = JSON.parse(await readFile(target, "utf8"));
    if (previous.kind !== "dry" || previous.sha256 !== hash(previous.result)) throw new Error("foreign");
  } catch (error) {
    if (error?.code !== "ENOENT") throw new IntegrationError("quality_report_conflict", "El informe DRY existente es ajeno o divergente; se conserva sin reemplazarlo", 2);
  }
  await writeTransaction(root, [{ path: target,
    content: Buffer.from(`${JSON.stringify({ kind: "dry", sha256: hash(result), result })}\n`) }]);
}

function candidateLine(candidate) {
  const left = `${candidate.left.file}:${candidate.left.startLine}-${candidate.left.endLine}`;
  const right = `${candidate.right.file}:${candidate.right.startLine}-${candidate.right.endLine}`;
  const reason = candidate.resolution?.reason ? `; justificación: ${candidate.resolution.reason}` : "; sin resolución";
  return `${left} ↔ ${right}; score ${candidate.score}; ${candidate.classification}${reason}`;
}

export async function runPythonDryCli(args, io = process) {
  let result;
  try {
    if (args.length !== 1 || args[0] !== "dry") {
      throw new IntegrationError("invalid_usage", "Use agentic-quality dry; el alcance y los límites provienen de config.json", 4);
    }
    result = await runPythonDry(process.cwd());
    await saveReport(process.cwd(), result);
  } catch (error) {
    const typed = typeof error?.code === "string" && Number.isInteger(error.exitCode);
    const { reference: _unsaved, ...partial } = result ?? {};
    result = { ...partial, command: "dry", status: "NO_VERIFICADO", code: typed ? error.code : "dry_internal_error",
      message: typed ? error.message : "No se pudo completar o conservar la detección DRY", exitCode: typed ? error.exitCode : 5 };
    // Replace a previous owned success with the current failure; preserve foreign reports.
    if (!_unsaved) {
      try { result.reference = reportReference; await saveReport(process.cwd(), result); }
      catch { delete result.reference; }
    }
  }
  if (io.env?.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    io.stdout.write(`${result.status} [${result.code}] ${result.message}\n`);
    for (const candidate of (result.candidates ?? []).slice(0, 8)) io.stdout.write(`${candidateLine(candidate)}\n`);
    for (const issue of (result.issues ?? []).slice(0, 8)) io.stdout.write(`${issue.file}:${issue.startLine} [${issue.code}]\n`);
    if (result.reference) io.stdout.write(`Informe íntegro: ${result.reference}\n`);
  }
  return result.exitCode;
}
