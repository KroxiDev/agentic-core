import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readConfiguration } from "../installation/install.js";
import { IntegrationError } from "./command.js";
import { captureProjectInputs, inputHash, privateInputContent, publicCheckpoint } from "./project-inputs.js";
import { projectTestIdentity, runProjectTests } from "./python-project.js";

const reference = ".agentic-core/quality/active-task.json";
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

export async function readActiveTask(root) {
  const file = await evidencePath(root);
  if (!file) return null;
  let content;
  try { content = await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const { sha256, task } = JSON.parse(content);
    if (sha256 !== hash(task) || task.schemaVersion !== 1 || !modes.has(task.mode)
      || !task.initial?.inputs || !Array.isArray(task.initial.sources)) throw new Error("identity");
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
  return { id: task.id, mode: task.mode, objective: task.objective, scope: task.scope,
    reference, baseline: { sha256, valid: task.initial.valid, status: task.initial.result.status,
      code: task.initial.result.code, inputs: task.initial.inputs.digest,
      failures: task.initial.failures, suite: task.initial.result.suite,
      integrity: task.initial.result.integrity },
    finalSuiteRequired: "passed" };
}

export async function taskFreshness(root, task) {
  const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
  const checkpoint = await captureProjectInputs(root, config.integration.python);
  const { identity } = await projectTestIdentity(root, config);
  const initial = new Map(task.initial.inputs.inventory.map((entry) => [entry.path, entry]));
  const current = new Map(checkpoint.inventory.map((entry) => [entry.path, entry]));
  const changed = [...new Set([...initial.keys(), ...current.keys()])].filter((file) => hash(initial.get(file) ?? null) !== hash(current.get(file) ?? null));
  return { status: checkpoint.issues.length ? "NO_VERIFICADO" : "compared",
    changed, conditionsChanged: identity !== task.initial.result.executionIdentity,
    inputsChanged: checkpoint.digest !== task.initial.inputs.digest,
    evidenceCurrent: task.initial.valid && !checkpoint.issues.length
      && identity === task.initial.result.executionIdentity && checkpoint.digest === task.initial.inputs.digest,
    baselinePreserved: true, checkpoint: publicCheckpoint(checkpoint) };
}

async function prepare(root, args) {
  const requested = options(args);
  const loaded = await readActiveTask(root);
  if (loaded) {
    if (requested.id && requested.id !== loaded.task.id || requested.mode && requested.mode !== loaded.task.mode
      || requested.objective && requested.objective !== loaded.task.objective
      || requested.repairTests.length && hash(requested.repairTests) !== hash(loaded.task.repairTests)) {
      throw new IntegrationError("task_already_active", "Hay una tarea activa distinta; su punto de partida no se reemplaza durante continuaciones", 4);
    }
    return { command: "prepare", status: loaded.task.initial.valid ? "prepared" : "NO_VERIFICADO",
      code: "baseline_preserved", message: "Se conserva el inicio de la tarea; consulte baseline para comparar los inputs actuales",
      exitCode: loaded.task.initial.valid ? 0 : 2, reused: true, task: taskSummary(loaded) };
  }
  if (!requested.id || !requested.mode || !requested.objective) {
    throw new IntegrationError("invalid_usage", "La primera preparación requiere --task, --mode y --objective", 4);
  }
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
      && result.suite.failures.every((failure) => failure.phase === "call" && failure.path));
  const failures = (result.suite?.failures ?? []).map((failure) => ({ ...failure,
    disposition: requested.repairTests.includes(failure.path) ? "repair_in_task" : "outside_task" }));
  const task = { schemaVersion: 1, ...requested, scope: config.integration.python.scope,
    initial: { valid, inputs: publicCheckpoint(before),
      sources: before.entries.map(({ content, ...entry }) => ({ ...entry, content: content.toString("base64") })), result, failures } };
  const saved = { task, sha256: hash(task) };
  // Exclusive creation prevents a concurrent prepare from overwriting another task.
  await writeFile(await evidencePath(root, true), `${JSON.stringify(saved)}\n`, { flag: "wx" });
  return { command: "prepare", status: valid ? "prepared" : "NO_VERIFICADO",
    code: valid ? result.code === "tests_failed" ? "baseline_tests_failed" : "baseline_ready" : result.code,
    message: valid ? "Inicio capturado; los fallos iniciales se conservan y la suite final debe aprobar. Los fallos ajenos no amplían el alcance"
      : "No se obtuvo un baseline válido; se conserva el punto inicial y la causa sin fabricar una aprobación",
    exitCode: valid ? 0 : 2, reused: false, task: taskSummary(saved) };
}

async function inspect(root, args, verify) {
  if (args.length) throw new IntegrationError("invalid_usage", "baseline y verify no aceptan argumentos adicionales", 4);
  const loaded = await readActiveTask(root);
  if (!loaded) throw new IntegrationError("task_missing", "Prepare la tarea antes de verificar; Directo puede ejecutar test sin preparar", 4);
  const freshness = await taskFreshness(root, loaded.task);
  if (!verify) return { command: "baseline", status: "reported", code: "baseline_preserved", exitCode: 0,
    message: "Comparación contra el inicio real de la tarea; no se ejecutaron pruebas", task: taskSummary(loaded), freshness };
  const result = await runProjectTests(root);
  return { command: "verify", status: result.status === "rejected" ? "rejected" : "NO_VERIFICADO",
    code: result.exitCode ? result.code : !loaded.task.initial.valid ? "baseline_invalid" : "quality_pending",
    exitCode: result.exitCode || 2,
    message: result.exitCode ? "La suite final requerida no aprobó; no se puede cerrar con calidad"
      : "Suite final aprobada; los controles DRY, C.R.A.P. y mutación exigibles aún requieren integración",
    task: taskSummary(loaded), freshness, result };
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
  else io.stdout.write(`${result.status} [${result.code}] ${result.message}\n${result.task ? `Tarea ${result.task.id}; objetivo: ${result.task.objective}; baseline: ${reference}\n` : ""}`);
  return result.exitCode;
}
