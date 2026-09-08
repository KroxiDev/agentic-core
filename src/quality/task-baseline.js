import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readConfiguration } from "../installation/install.js";
import { writeTransaction } from "../transaction.js";
import { IntegrationError } from "./command.js";
import { budgetSummary, formatBudget, readTaskBudget, withTaskBudget } from "./task-budget.js";
import { captureProjectInputs, inputHash, privateInputContent, publicCheckpoint } from "./project-inputs.js";
import { dependencyFingerprint } from "./project-copy.js";
import { projectTestIdentity, runProjectTests } from "./python-project.js";
import { parseDryResolutions } from "./python-dry.js";
import { formatVerificationSummary } from "./diagnostics.js";
import {
  capturePythonQualityBaseline,
  readVerificationReport,
  verificationReference,
  verifyPythonTask,
} from "./python-verification.js";

import { parseControls, taskControl } from "./task-controls.js";
import { parseTestSelection } from "./selection.js";

const reference = ".agentic-core/quality/active-task.json";
const qualityDirectory = ".agentic-core/quality";
const verificationReports = [
  { relative: `${qualityDirectory}/crap.json`, kind: "crap" },
  { relative: `${qualityDirectory}/dry.json`, kind: "dry" },
  { relative: `${qualityDirectory}/mutation.json`, kind: "mutation" },
];
const resolutionReference = `${qualityDirectory}/dry-resolutions.json`;
const hash = (value) => inputHash(JSON.stringify(value));
const modes = new Set(["light", "normal", "full"]);

async function evidencePath(root, create = false) {
  for (const relative of [".agentic-core", ".agentic-core/quality"]) {
    const directory = path.join(root, relative);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("type");
    } catch (error) {
      if (error.code === "ENOENT" && create && relative.endsWith("/quality")) await mkdir(directory);
      else if (error.code === "ENOENT" && !create) return null;
      else throw new IntegrationError("task_evidence_unsafe", "La ubicación de evidencia no es un directorio propio seguro", 2);
    }
  }
  const file = path.join(root, reference);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("type");
  } catch (error) {
    if (error.code !== "ENOENT") throw new IntegrationError("task_evidence_unsafe", "La evidencia activa no es un archivo regular seguro", 2);
  }
  return file;
}

function cleanupError(message, exitCode = 2) {
  return new IntegrationError("task_evidence_cleanup_failed", message, exitCode);
}

async function qualityToolsIdentity(root) {
  try { return await dependencyFingerprint([path.join(root, ".agentic-core/tools")]); }
  catch { return null; }
}

function ownedReport(content, kind) {
  try {
    const parsed = JSON.parse(content.toString("utf8"));
    return parsed?.kind === kind && parsed.result?.command === kind && parsed.result?.schemaVersion === 1
      && parsed.result?.reference === `${qualityDirectory}/${kind}.json`
      && parsed.sha256 === hash(parsed.result);
  } catch { return false; }
}

function ownedResolutions(content) {
  try {
    parseDryResolutions(content);
    return true;
  } catch { return false; }
}

async function cleanupFile(root, relative, validate = undefined) {
  const file = path.join(root, relative);
  let details;
  try { details = await lstat(file); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw cleanupError(`No se pudo inspeccionar ${relative} para iniciar la nueva tarea; se conserva la evidencia existente`, 5);
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw cleanupError(`No se puede limpiar ${relative}: no es un archivo regular seguro y se conserva`, 2);
  }
  let content;
  try { content = await readFile(file); }
  catch { throw cleanupError(`No se pudo leer ${relative} para demostrar ownership; se conserva`, 2); }
  if (validate) {
    if (!validate(content)) {
      throw cleanupError(`No se puede limpiar ${relative}: la evidencia no demuestra ownership y se conserva`, 2);
    }
  }
  return { type: "delete", path: file, expectedContent: content };
}

async function cleanupInternalEvidence(root, expectedTask) {
  const operations = [];
  let verification;
  try { verification = await readVerificationReport(root, expectedTask); }
  catch {
    throw cleanupError("No se puede limpiar el veredicto interno: está corrupto, es ajeno o no se puede validar; se conserva", 2);
  }
  if (verification && !expectedTask) {
    throw cleanupError("No se puede limpiar el veredicto interno sin una tarea activa que demuestre ownership; se conserva", 2);
  }
  if (verification) {
    const operation = await cleanupFile(root, verificationReference,
      (content) => inputHash(content) === verification.sha256);
    if (!operation) throw cleanupError("El veredicto cambió durante la planificación de limpieza; se conserva la tarea", 2);
    operations.push(operation);
  }
  for (const report of verificationReports) {
    const file = await cleanupFile(root, report.relative, (content) => ownedReport(content, report.kind));
    if (file) operations.push(file);
  }
  const resolutions = await cleanupFile(root, resolutionReference, ownedResolutions);
  if (resolutions) operations.push(resolutions);
  return operations;
}

export async function readActiveTask(root) {
  const file = await evidencePath(root);
  if (!file) return null;
  let content;
  try { content = await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const { sha256, task } = JSON.parse(content);
    if (sha256 !== hash(task) || task.schemaVersion !== 1 || !modes.has(task.mode)
      || !task.initial?.inputs || !Array.isArray(task.initial.sources) || !task.initial.result
      || task.initial.quality !== undefined && (task.initial.quality?.schemaVersion !== 1
        || !["captured", "NO_VERIFICADO", "NO_SOLICITADO"].includes(task.initial.quality.status)
        || !task.initial.quality.crap || !task.initial.quality.dry)) throw new Error("identity");
    if (task.requiredControls !== undefined && (!Array.isArray(task.requiredControls)
      || hash(parseControls(task.requiredControls)) !== hash(task.requiredControls))) throw new Error("controls");
    return { task, sha256, content: Buffer.from(content) };
  } catch {
    throw new IntegrationError("task_evidence_invalid", "La evidencia inicial está corrupta; no se reemplaza ni se usa para aprobar", 2);
  }
}

function options(args) {
  const result = { repairTests: [] };
  const controls = [];
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--task", "--mode", "--objective", "--repair-test", "--control"].includes(option) || !value || value.startsWith("--")) {
      throw new IntegrationError("invalid_usage", "Use prepare --task <id> --mode <light|normal|full> --objective <referencia breve> [--repair-test <ruta relativa>]", 4);
    }
    const key = { "--task": "id", "--mode": "mode", "--objective": "objective" }[option];
    if (key && result[key] !== undefined) throw new IntegrationError("invalid_usage", "No repita opciones únicas de preparación", 4);
    if (key) result[key] = value;
    else if (option === "--control") controls.push(value);
    else result.repairTests.push(value.replaceAll("\\", "/"));
  }
  if (result.id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(result.id)
    || result.mode && !modes.has(result.mode)
    || result.objective && (result.objective.length > 500 || privateInputContent(Buffer.from(result.objective)))) {
    throw new IntegrationError("invalid_usage", "Use un identificador y objetivo breves sin datos privados; Directo no requiere preparación", 4);
  }
  if (controls.length) result.requiredControls = parseControls(controls);
  return result;
}

function taskSummary(loaded) {
  const { task, sha256 } = loaded;
  const quality = task.initial.quality;
  return { id: task.id, mode: task.mode, objective: task.objective, scope: task.scope,
    requiredControls: task.mode === "full" ? ["dry", "crap", "mutation"] : task.requiredControls ?? [],
    reference, baseline: { sha256, valid: task.initial.valid, status: task.initial.result.status,
      code: task.initial.result.code, inputs: task.initial.inputs.digest,
      failures: task.initial.failures, suite: task.initial.result.suite,
      integrity: task.initial.result.integrity,
      quality: quality ? {
        status: quality.status,
        code: quality.code,
        crap: { status: quality.crap?.status ?? "NO_VERIFICADO", code: quality.crap?.code ?? null,
          identity: quality.crap?.identity ?? null },
        dry: { status: quality.dry?.status ?? "NO_VERIFICADO", code: quality.dry?.code ?? null,
          identity: quality.dry?.identity ?? null },
      } : null },
    finalSuiteRequired: "passed" };
}

export async function taskFreshness(root, task) {
  const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
  const checkpoint = await captureProjectInputs(root, config.integration.python);
  const { identity } = await projectTestIdentity(root, config);
  const qualityTools = await qualityToolsIdentity(root);
  const initial = new Map(task.initial.inputs.inventory.map((entry) => [entry.path, entry]));
  const current = new Map(checkpoint.inventory.map((entry) => [entry.path, entry]));
  const changed = [...new Set([...initial.keys(), ...current.keys()])].filter((file) => hash(initial.get(file) ?? null) !== hash(current.get(file) ?? null));
  const configurationHash = hash(config);
  const configurationChanged = configurationHash !== task.initial.result.configurationHash;
  const identityChanged = identity !== task.initial.result.executionIdentity;
  const toolsKnown = task.mode === "full" && task.initial.environment?.qualityTools !== undefined;
  const conditionsChanged = toolsKnown
    ? configurationChanged || identityChanged || qualityTools !== task.initial.environment.qualityTools
    : configurationChanged || identityChanged;
  return { status: checkpoint.issues.length ? "NO_VERIFICADO" : "compared",
    changed, conditionsChanged,
    inputsChanged: checkpoint.digest !== task.initial.inputs.digest,
    evidenceCurrent: task.initial.valid && !checkpoint.issues.length
      && !conditionsChanged && checkpoint.digest === task.initial.inputs.digest,
    baselinePreserved: true, checkpoint: publicCheckpoint(checkpoint), configurationHash,
    executionIdentity: identity, qualityTools };
}

async function prepare(root, args) {
  const requested = options(args);
  const loaded = await readActiveTask(root);
  if (loaded && (!requested.id || requested.id === loaded.task.id)) {
    const continues = (!requested.mode || requested.mode === loaded.task.mode)
      && (!requested.objective || requested.objective === loaded.task.objective)
      && (requested.requiredControls === undefined || hash(requested.requiredControls) === hash(loaded.task.requiredControls ?? []))
      && (!requested.repairTests.length || hash(requested.repairTests) === hash(loaded.task.repairTests));
    if (continues) {
      const initialLimit = [loaded.task.initial.result,
        ...(loaded.task.mode === "full" ? [loaded.task.initial.quality?.crap, loaded.task.initial.quality?.dry] : [])]
        .find((control) => ["budget_exhausted", "command_timeout", "termination_failed", "concurrency_limit"].includes(control?.code));
      const prepared = loaded.task.initial.valid && !initialLimit;
      return { command: "prepare", status: prepared ? "prepared" : "NO_VERIFICADO",
        code: "baseline_preserved", message: "Se conserva el inicio de la tarea; consulte baseline para comparar los inputs actuales",
        exitCode: prepared ? 0 : initialLimit?.exitCode ?? 2, reused: true, task: taskSummary(loaded),
        budget: await readTaskBudget(root, loaded.task.id) };
    }
    throw new IntegrationError("task_metadata_conflict",
      "La metadata no coincide con la tarea activa; conserve sus valores para continuar o use un --task distinto para iniciar otra tarea", 4);
  }
  if (!requested.id || !requested.mode || !requested.objective) {
    throw new IntegrationError("invalid_usage", "La primera preparación requiere --task, --mode y --objective", 4);
  }
  if (requested.mode === "full" && requested.requiredControls !== undefined) {
    throw new IntegrationError("invalid_controls", "Full conserva sus controles históricos; use Light o Normal para selección explícita", 4);
  }
  if (requested.mode !== "full") requested.requiredControls ??= [];
  const cleanup = await cleanupInternalEvidence(root, loaded?.task);
  const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
  const before = await captureProjectInputs(root, config.integration.python);
  for (const repairTest of requested.repairTests) {
    if (!before.inventory.some((entry) => entry.path === repairTest)) {
      throw new IntegrationError("invalid_repair_test", "Cada --repair-test debe identificar un input público capturado", 4);
    }
  }
  return withTaskBudget(root, requested.id,
    () => captureTask(root, { requested, loaded, config, before, cleanup }), { newTask: true });
}

async function captureTask(root, { requested, loaded, config, before, cleanup }) {
  let result = await runProjectTests(root);
  const after = await captureProjectInputs(root, config.integration.python);
  if (before.digest !== after.digest || result.inputs && result.inputs.digest !== before.digest
    || result.configurationHash && result.configurationHash !== hash(config)) {
    result = { ...result, status: "NO_VERIFICADO", code: "baseline_inputs_changed", exitCode: 2,
      message: "Los inputs cambiaron durante la captura inicial; se conserva evidencia no válida con su causa" };
  }
  const valid = !before.issues.length && result.integrity?.status === "preserved"
    && result.coverage?.status === "measured"
    && (result.code === "tests_passed" || result.code === "tests_failed" && result.suite?.failures?.length > 0
      && result.suite.failures.every((failure) => failure.path && (failure.phase === "call" || ["assertion", "production_exception"].includes(failure.kind))));
  const failures = (result.suite?.failures ?? []).map((failure) => ({ ...failure,
    disposition: requested.repairTests.includes(failure.path) ? "repair_in_task" : "outside_task" }));
  const task = { schemaVersion: 1, ...requested, scope: config.integration.python.scope,
    initial: { valid, inputs: publicCheckpoint(before),
      sources: before.entries.map(({ content, ...entry }) => ({ ...entry, content: content.toString("base64") })),
      result, failures,
      environment: { node: process.version, platform: process.platform, arch: process.arch,
        python: result.python ?? null, runner: result.effectiveCommand ?? null,
        configurationHash: result.configurationHash ?? null, executionIdentity: result.executionIdentity ?? null,
        qualityTools: await qualityToolsIdentity(root) } } };
  const quality = requested.mode === "full"
    ? await capturePythonQualityBaseline(root, { checkpoint: before, execution: result })
    : { schemaVersion: 1, status: "NO_SOLICITADO", code: "baseline_reference_captured",
      ...Object.fromEntries(["dry", "crap", "mutation"].map((name) => [name, taskControl(name, requested.requiredControls.includes(name))])) };
  const enrichedTask = { ...task, initial: { ...task.initial, quality } };
  const enriched = { task: enrichedTask, sha256: hash(enrichedTask) };
  const current = await readActiveTask(root);
  if (loaded ? current?.sha256 !== loaded.sha256 : current) {
    throw new IntegrationError("task_already_active", "La tarea activa cambió durante la captura; se conserva la evidencia existente", 4);
  }
  const activePath = await evidencePath(root, true);
  try {
    await writeTransaction(root, [
      ...cleanup,
      { path: activePath, content: Buffer.from(`${JSON.stringify(enriched)}\n`), expectedContent: loaded?.content ?? null },
    ]);
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    if (error.code === "ERR_TRANSACTION_CONFLICT") {
      throw cleanupError("La evidencia cambió durante la captura o limpieza; se conservan la tarea y los archivos divergentes. Revise el cambio antes de reintentar", 2);
    }
    if (error.code === "ERR_RESTORATION_FAILED") {
      throw cleanupError("La restauración quedó incompleta; se conservan los cambios concurrentes y el respaldo de recuperación. Revise la evidencia antes de reintentar", 5);
    }
    throw cleanupError("No se pudo retirar la evidencia interna anterior sin afectar la nueva tarea; se conserva el estado previo", 5);
  }
  // A partial quality baseline is useful evidence even when it cannot support
  // approval yet; the final verifier will keep that control unverified.
  const limitFailure = [result, quality.crap, quality.dry].find((control) =>
    ["budget_exhausted", "command_timeout", "termination_failed", "concurrency_limit"].includes(control?.code));
  const prepared = valid && !limitFailure;
  return { command: "prepare", status: prepared ? "prepared" : "NO_VERIFICADO",
    code: limitFailure?.code ?? (!valid ? result.code : prepared ? result.code === "tests_failed" ? "baseline_tests_failed" : "baseline_ready" : quality.code),
    message: prepared ? "Inicio real y tests funcionales capturados; los fallos iniciales se conservan y la suite final debe aprobar. Los fallos ajenos no amplían el alcance"
      : !valid ? "No se obtuvo un baseline válido; se conserva el punto inicial y la causa sin fabricar una aprobación"
        : "El inicio se conserva, pero una medición de calidad quedó incompleta; no se fabrica evidencia de aprobación",
    exitCode: limitFailure?.exitCode ?? (prepared ? 0 : 2), reused: false, replaced: Boolean(loaded), task: taskSummary(enriched), budget: budgetSummary() };
}

async function inspect(root, args, verify) {
  if (!verify && args.length) throw new IntegrationError("invalid_usage", "baseline no acepta argumentos adicionales", 4);
  const controlValues = [];
  const selectionArgs = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--control") controlValues.push(args[++index]);
    else selectionArgs.push(args[index]);
  }
  const requiredControls = controlValues.length ? parseControls(controlValues) : undefined;
  const selection = parseTestSelection(selectionArgs, { allowChanges: true });
  const loaded = await readActiveTask(root);
  if (!loaded) throw new IntegrationError("task_missing", "Prepare la tarea antes de verificar; Directo puede ejecutar test sin preparar", 4);
  if (!verify) {
    const freshness = await taskFreshness(root, loaded.task);
    return { command: "baseline", status: "reported", code: "baseline_preserved", exitCode: 0,
      message: "Comparación contra el inicio real de la tarea; no se ejecutaron pruebas", task: taskSummary(loaded), freshness,
      budget: await readTaskBudget(root, loaded.task.id) };
  }
  if (loaded.task.mode === "full" && (requiredControls !== undefined || selection)) {
    throw new IntegrationError("invalid_usage", "Full conserva la selección y controles históricos", 4);
  }
  const stored = await readVerificationReport(root, loaded.task);
  return withTaskBudget(root, loaded.task.id, async () => {
    const result = await verifyPythonTask(root, loaded.task, { previous: stored?.report, requiredControls, selection });
    return { ...result, task: taskSummary(loaded), budget: budgetSummary() };
  });
}

export async function runTaskQualityCli(args, io = process) {
  let result;
  try {
    result = args[0] === "prepare" ? await prepare(process.cwd(), args.slice(1))
      : await inspect(process.cwd(), args.slice(1), args[0] === "verify");
  } catch (error) {
    const typed = typeof error.code === "string" && Number.isInteger(error.exitCode);
    result = { command: args[0], budget: error.budget, status: "NO_VERIFICADO", code: typed ? error.code : "task_internal_error",
      message: typed ? error.message : "No se pudo conservar o consultar la evidencia de tarea", exitCode: typed ? error.exitCode : 5 };
  }
  if (io.env?.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result)}\n`);
  else if (args[0] === "verify") io.stdout.write(formatVerificationSummary(result));
  else io.stdout.write(`${result.status} [${result.code}] ${result.message}\n${result.task ? `Tarea ${result.task.id}; objetivo: ${result.task.objective}; baseline: ${reference}\n` : ""}`);
  if (io.env?.AGENTIC_CORE_OUTPUT !== "json") io.stdout.write(formatBudget(result.budget));
  return result.exitCode;
}
