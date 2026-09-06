import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readConfiguration } from "../installation/install.js";
import { writeTransaction } from "../transaction.js";
import { IntegrationError } from "./command.js";
import { captureProjectInputs, inputHash, privateInputContent, publicCheckpoint } from "./project-inputs.js";
import { dependencyFingerprint } from "./project-copy.js";
import { projectTestIdentity, runProjectTests } from "./python-project.js";
import {
  capturePythonQualityBaseline,
  readVerificationReport,
  verificationReference,
  verifyPythonTask,
} from "./python-verification.js";

const reference = ".agentic-core/quality/active-task.json";
const qualityDirectory = ".agentic-core/quality";
const verificationReports = [
  { relative: `${qualityDirectory}/crap.json`, kind: "crap" },
  { relative: `${qualityDirectory}/dry.json`, kind: "dry" },
];
const resolutionReference = `${qualityDirectory}/dry-resolutions.json`;
const hash = (value) => inputHash(JSON.stringify(value));
const modes = new Set(["light", "normal", "full"]);
const reusableStatuses = new Set(["approved", "rejected", "NO_APLICA"]);

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

function sameTask(left, right) {
  return left?.id === right?.id && left?.mode === right?.mode
    && left?.objective === right?.objective
    && JSON.stringify(left?.scope) === JSON.stringify(right?.scope);
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
  if (privateInputContent(content)) return false;
  try {
    const parsed = JSON.parse(content.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || parsed.schemaVersion !== 1 || !Array.isArray(parsed.resolutions)) return false;
    const seen = new Set();
    return parsed.resolutions.every((entry) => {
      const candidate = entry?.candidate ?? entry?.candidateId;
      const valid = entry && typeof entry === "object" && !Array.isArray(entry)
        && typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate)
        && !seen.has(candidate) && entry.decision === "keep"
        && typeof entry.reason === "string" && entry.reason.trim().length >= 3
        && entry.reason.length <= 500 && !/[\r\n]/u.test(entry.reason);
      if (valid) seen.add(candidate);
      return valid;
    });
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
  if (validate) {
    let content;
    try { content = await readFile(file); }
    catch { throw cleanupError(`No se pudo leer ${relative} para demostrar ownership; se conserva`, 2); }
    if (!validate(content)) {
      throw cleanupError(`No se puede limpiar ${relative}: la evidencia no demuestra ownership y se conserva`, 2);
    }
  }
  return file;
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
  if (verification) operations.push({ type: "delete", path: path.join(root, verificationReference) });
  for (const report of verificationReports) {
    const file = await cleanupFile(root, report.relative, (content) => ownedReport(content, report.kind));
    if (file) operations.push({ type: "delete", path: file });
  }
  const resolutions = await cleanupFile(root, resolutionReference, ownedResolutions);
  if (resolutions) operations.push({ type: "delete", path: resolutions });
  return operations;
}

async function resolutionHash(root) {
  try {
    const file = path.join(root, resolutionReference);
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) return undefined;
    return inputHash(await readFile(file));
  } catch (error) {
    return error?.code === "ENOENT" ? null : undefined;
  }
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
        || !["captured", "NO_VERIFICADO"].includes(task.initial.quality.status)
        || !task.initial.quality.crap || !task.initial.quality.dry)) throw new Error("identity");
    return { task, sha256 };
  } catch {
    throw new IntegrationError("task_evidence_invalid", "La evidencia inicial está corrupta; no se reemplaza ni se usa para aprobar", 2);
  }
}

function options(args) {
  const result = { repairTests: [] };
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--task", "--mode", "--objective", "--repair-test"].includes(option) || !value || value.startsWith("--")) {
      throw new IntegrationError("invalid_usage", "Use prepare --task <id> --mode <light|normal|full> --objective <referencia breve> [--repair-test <ruta relativa>]", 4);
    }
    const key = { "--task": "id", "--mode": "mode", "--objective": "objective" }[option];
    if (key && result[key] !== undefined) throw new IntegrationError("invalid_usage", "No repita opciones únicas de preparación", 4);
    if (key) result[key] = value;
    else result.repairTests.push(value.replaceAll("\\", "/"));
  }
  if (result.id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(result.id)
    || result.mode && !modes.has(result.mode)
    || result.objective && (result.objective.length > 500 || privateInputContent(Buffer.from(result.objective)))) {
    throw new IntegrationError("invalid_usage", "Use un identificador y objetivo breves sin datos privados; Directo no requiere preparación", 4);
  }
  return result;
}

function taskSummary(loaded) {
  const { task, sha256 } = loaded;
  const quality = task.initial.quality;
  return { id: task.id, mode: task.mode, objective: task.objective, scope: task.scope,
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
  const toolsKnown = task.initial.environment?.qualityTools !== undefined;
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

function reusableVerification(report, task, freshness, resolutions) {
  if (!reusableStatuses.has(report?.status) || typeof freshness.qualityTools !== "string" || !sameTask(report.task, task)
    || report.freshness?.status !== "compared" || freshness.status !== "compared"
    || report.freshness?.checkpoint?.digest !== freshness.checkpoint.digest
    || report.freshness.inputsChanged !== freshness.inputsChanged
    || report.freshness.conditionsChanged !== freshness.conditionsChanged
    || report.evidence?.inputs?.current !== freshness.checkpoint.digest
    || report.evidence?.configuration?.current !== freshness.configurationHash
    || report.environment?.current?.configurationHash !== freshness.configurationHash
    || report.environment?.current?.executionIdentity !== freshness.executionIdentity
    || report.environment?.current?.qualityTools !== freshness.qualityTools
    || report.tests?.status === "NO_VERIFICADO"
    || report.tests?.executionIdentity !== freshness.executionIdentity
    || report.tests?.configurationHash !== freshness.configurationHash
    || report.dry?.hashes?.inputs !== freshness.checkpoint.digest
    || report.dry?.hashes?.configuration !== freshness.configurationHash
    || report.dry?.hashes?.resolutions !== resolutions
    || report.crap?.inputs?.digest !== freshness.checkpoint.digest
    || report.crap?.execution?.configurationHash !== freshness.configurationHash
    || report.crap?.execution?.executionIdentity !== freshness.executionIdentity) return false;
  return true;
}

function cachedVerification(loaded, stored, freshness) {
  const { report, sha256 } = stored;
  const status = report.status;
  const receiptStatus = status === "approved" || status === "NO_APLICA" ? "QUALITY_OK" : "QUALITY_FAILED";
  return {
    command: "verify",
    status,
    code: report.code,
    exitCode: status === "approved" || status === "NO_APLICA" ? 0 : 1,
    message: report.message,
    task: loaded.task,
    freshness,
    result: report.tests,
    verification: report,
    report: verificationReference,
    sha256,
    receipt: `${receiptStatus} task=${loaded.task.id} mode=${loaded.task.mode} tests=${report.tests.status} dry=${report.dry.status} crap=${report.crap.status} mutation=${report.mutation.status} report=${verificationReference} sha256=${sha256}`,
    reused: true,
  };
}

async function prepare(root, args) {
  const requested = options(args);
  const loaded = await readActiveTask(root);
  if (loaded) {
    const continues = (!requested.id || requested.id === loaded.task.id)
      && (!requested.mode || requested.mode === loaded.task.mode)
      && (!requested.objective || requested.objective === loaded.task.objective)
      && (!requested.repairTests.length || hash(requested.repairTests) === hash(loaded.task.repairTests));
    if (continues) {
      return { command: "prepare", status: loaded.task.initial.valid ? "prepared" : "NO_VERIFICADO",
        code: "baseline_preserved", message: "Se conserva el inicio de la tarea; consulte baseline para comparar los inputs actuales",
        exitCode: loaded.task.initial.valid ? 0 : 2, reused: true, task: taskSummary(loaded) };
    }
  }
  if (!requested.id || !requested.mode || !requested.objective) {
    throw new IntegrationError("invalid_usage", "La primera preparación requiere --task, --mode y --objective", 4);
  }
  const cleanup = await cleanupInternalEvidence(root, loaded?.task);
  const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
  const before = await captureProjectInputs(root, config.integration.python);
  for (const repairTest of requested.repairTests) {
    if (!before.inventory.some((entry) => entry.path === repairTest)) {
      throw new IntegrationError("invalid_repair_test", "Cada --repair-test debe identificar un input público capturado", 4);
    }
  }
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
  const quality = await capturePythonQualityBaseline(root, { checkpoint: before, execution: result });
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
      { path: activePath, content: Buffer.from(`${JSON.stringify(enriched)}\n`) },
    ]);
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw cleanupError("No se pudo retirar la evidencia interna anterior sin afectar la nueva tarea; se conserva el estado previo", 5);
  }
  // A partial quality baseline is useful evidence even when it cannot support
  // approval yet; the final verifier will keep that control unverified.
  const prepared = valid;
  return { command: "prepare", status: prepared ? "prepared" : "NO_VERIFICADO",
    code: !valid ? result.code : prepared ? result.code === "tests_failed" ? "baseline_tests_failed" : "baseline_ready" : quality.code,
    message: prepared ? "Inicio y mediciones de calidad capturados; los fallos iniciales se conservan y la suite final debe aprobar. Los fallos ajenos no amplían el alcance"
      : !valid ? "No se obtuvo un baseline válido; se conserva el punto inicial y la causa sin fabricar una aprobación"
        : "El inicio se conserva, pero una medición de calidad quedó incompleta; no se fabrica evidencia de aprobación",
    exitCode: prepared ? 0 : 2, reused: false, replaced: Boolean(loaded), task: taskSummary(enriched) };
}

async function inspect(root, args, verify) {
  if (args.length) throw new IntegrationError("invalid_usage", "baseline y verify no aceptan argumentos adicionales", 4);
  const loaded = await readActiveTask(root);
  if (!loaded) throw new IntegrationError("task_missing", "Prepare la tarea antes de verificar; Directo puede ejecutar test sin preparar", 4);
  if (!verify) {
    const freshness = await taskFreshness(root, loaded.task);
    return { command: "baseline", status: "reported", code: "baseline_preserved", exitCode: 0,
      message: "Comparación contra el inicio real de la tarea; no se ejecutaron pruebas", task: taskSummary(loaded), freshness };
  }
  const stored = await readVerificationReport(root, loaded.task);
  if (stored) {
    const freshness = await taskFreshness(root, loaded.task);
    const resolutions = await resolutionHash(root);
    if (reusableVerification(stored.report, loaded.task, freshness, resolutions)) {
      return { ...cachedVerification(loaded, stored, freshness), task: taskSummary(loaded) };
    }
  }
  const result = await verifyPythonTask(root, loaded.task);
  return { ...result, task: taskSummary(loaded) };
}

export async function runTaskQualityCli(args, io = process) {
  let result;
  try {
    result = args[0] === "prepare" ? await prepare(process.cwd(), args.slice(1))
      : await inspect(process.cwd(), args.slice(1), args[0] === "verify");
  } catch (error) {
    const typed = typeof error.code === "string" && Number.isInteger(error.exitCode);
    result = { command: args[0], status: "NO_VERIFICADO", code: typed ? error.code : "task_internal_error",
      message: typed ? error.message : "No se pudo conservar o consultar la evidencia de tarea", exitCode: typed ? error.exitCode : 5 };
  }
  if (io.env?.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.receipt) io.stdout.write(`${result.receipt}\n`);
  else io.stdout.write(`${result.status} [${result.code}] ${result.message}\n${result.task ? `Tarea ${result.task.id}; objetivo: ${result.task.objective}; baseline: ${reference}\n` : ""}`);
  return result.exitCode;
}
