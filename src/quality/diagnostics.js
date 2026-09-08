import path from "node:path";
import { lstat } from "node:fs/promises";
import { readConfiguration } from "../installation/install.js";
import { PYTHON_TOOLS } from "../installation/python.js";
import { getVersion } from "../version.js";
import { IntegrationError } from "./command.js";
import { captureProjectInputs, inputHash, matchesInput, publicCheckpoint } from "./project-inputs.js";
import { dependencyFingerprint, publicArgument, publicArguments } from "./project-copy.js";
import { projectTestIdentity } from "./python-project.js";
import { readActiveTask } from "./task-baseline.js";
import { compareCodeUnits } from "./order.js";
import { inspectVerificationEvidence, readVerificationReport, verificationExit, verificationReference } from "./python-verification.js";

const fullReport = "node .agentic-core/runtime-launcher.mjs agentic-quality explain --json";
const actions = {
  invalid_usage: "Use agentic-quality explain [--json].",
  invalid_configuration: "Corrija el valor indicado en .agentic-core/config.json conforme a config.schema.json.",
  unknown_configuration_key: "Quite la clave no admitida del objeto indicado en .agentic-core/config.json.",
  unsupported_python: "Seleccione Python 3.11 o superior en config.json o AGENTIC_CORE_PYTHON.",
  python_unavailable: "Revise el intérprete configurado y sus permisos.",
  pytest_unavailable: "Instale pytest en el entorno del proyecto.",
  command_unavailable: "Revise el ejecutable, el directorio de trabajo y los permisos de la integración.",
  task_missing: "Prepare una tarea con prepare --task <id> --mode <modo> --objective <referencia> antes de verificar.",
  evidence_missing: "Ejecute agentic-quality verify para obtener el veredicto de la tarea activa.",
  quality_inputs_changed: "Revise los inputs modificados y ejecute agentic-quality verify para medir el estado actual.",
  quality_conditions_changed: "Revise el comando, la configuración y el entorno; restaure las condiciones iniciales o prepare otra tarea si el cambio es intencional.",
  quality_tools_changed: "Revise las herramientas privadas con agentic-core doctor antes de verificar.",
  dry_resolutions_changed: "Revise dry-resolutions.json y ejecute agentic-quality verify para actualizar DRY.",
  task_evidence_invalid: "Conserve la evidencia corrupta y recupere un baseline íntegro antes de continuar.",
  task_evidence_unsafe: "Revise el tipo y ownership de la evidencia activa; no se modifica automáticamente.",
  quality_report_conflict: "Conserve el informe divergente y recupere evidencia íntegra de la tarea activa.",
  input_checkpoint_incompatible: "Revise los inputs requeridos y las exclusiones; no incluya secretos para completar una copia.",
  baseline_invalid: "Revise la causa del baseline; recupere evidencia inicial válida antes de continuar.",
  quality_approved: "Puede citar la evidencia vigente; no es necesario repetir las pruebas.",
  quality_not_applicable: "Cite la razón de NO_APLICA del informe de verificación.",
  no_executable_code: "Cite la razón de NO_APLICA del informe de verificación.",
  crap_limit_exceeded: "Corrija los símbolos señalados: el código nuevo debe respetar el límite y el existente no debe degradarse.",
  dry_candidates_unresolved: "Revise los pares señalados y elimine la duplicación o registre una resolución concreta en dry-resolutions.json.",
  tests_failed: "Corrija los fallos señalados y ejecute agentic-quality verify para comprobar la suite final.",
};

function actionFor(code) {
  return actions[code] ?? "Revise el control indicado en el informe completo y resuelva su causa antes de ejecutar agentic-quality verify.";
}

function cause(code, message, extra = {}) {
  return { code, message, action: actionFor(code), ...extra };
}

function configurationView(root, config, checkpoint) {
  const unit = config.integration.python;
  const safe = (value) => publicArgument(value, checkpoint, root);
  // Patterns selecting no public input need not disclose an excluded filename.
  const patterns = (values) => values.map((value) => checkpoint.inventory.some((entry) => matchesInput(entry.path, value))
    ? safe(value) : "[sin inputs públicos]");
  const args = publicArguments(unit.command.args, checkpoint, root).map((value) => {
    const assignment = value.indexOf("=");
    if (assignment >= 0 && (path.win32.isAbsolute(value.slice(assignment + 1)) || path.posix.isAbsolute(value.slice(assignment + 1)))) {
      return "[argumento de ruta]";
    }
    if (value.startsWith("[") || value.startsWith("-") || !/[\\/.]/u.test(value)) return value;
    const relative = path.relative(root, path.resolve(root, unit.cwd, value)).split(path.sep).join("/");
    return checkpoint.inventory.some((entry) => entry.path === relative || entry.path.startsWith(`${relative}/`))
      ? value : "[argumento no público]";
  });
  return {
    provider: config.integration.provider, languages: config.integration.languages, runner: unit.runner,
    interpreter: "[Python del proyecto]",
    interpreterSource: process.env.AGENTIC_CORE_PYTHON ? "AGENTIC_CORE_PYTHON" : "config.json",
    command: { executable: unit.command.executable === unit.interpreter ? "[Python del proyecto]" : safe(unit.command.executable),
      args, cwd: safe(unit.cwd) },
    environmentCount: Object.keys(unit.environment).length,
    coverage: { format: unit.coverage.format, path: safe(unit.coverage.path) },
    scope: patterns(unit.scope),
    inputs: { include: patterns(unit.inputs.include), includeIgnored: patterns(unit.inputs.includeIgnored ?? []),
      exclude: unit.inputs.exclude.map(safe), respectGitIgnore: unit.inputs.respectGitIgnore !== false,
      mandatoryExclusions: "Secretos, datos personales y artefactos generados; una inclusión no anula esta protección." },
  };
}

function publicFindings(report, checkpoint, limits) {
  const publicFiles = new Set(checkpoint.inventory.map((entry) => entry.path));
  const findings = [];
  for (const name of ["tests", "dry", "crap", "mutation"]) {
    const control = report[name];
    if (!control || ["approved", "NO_APLICA", "NO_SOLICITADO"].includes(control.status)) continue;
    findings.push(cause(control.code, `El control ${name} tiene estado ${control.status}.`, { control: name }));
    const details = control.details ?? control.suite?.failures ?? [];
    for (const detail of details) {
      const file = detail.path ?? detail.file;
      if (!publicFiles.has(file)) continue;
      if (["approved", "NO_APLICA"].includes(detail.incrementalStatus ?? detail.status)) continue;
      const value = detail.value ?? detail.current?.crap ?? detail.crap;
      findings.push(cause(control.code, `Hallazgo de ${name}.`, { control: name, file,
        ...(Number.isInteger(detail.line ?? detail.startLine) ? { line: detail.line ?? detail.startLine } : {}),
        ...(typeof value === "number" ? { value, limit: detail.threshold ?? detail.limit ?? limits.crap } : {}) }));
    }
    for (const candidate of control.candidates ?? []) {
      if (candidate.status !== "unresolved") continue;
      for (const location of [candidate.left, candidate.right]) {
        if (publicFiles.has(location?.file)) findings.push(cause(control.code, "Par de duplicación sin resolver.",
          { control: name, file: location.file, line: location.startLine, value: candidate.score, limit: candidate.evidence?.similarityLimit }));
      }
    }
    if (control.score) findings.push(cause(control.code, "Resultado de Mutation Testing.",
      { control: name, value: control.score.percentage, limit: control.score.threshold }));
  }
  return findings;
}

async function changedInputPaths(root, previous, inventory) {
  const prior = new Map(previous.map((entry) => [entry.path, entry.sha256]));
  const current = new Set(inventory.map((entry) => entry.path));
  const changed = inventory.filter((entry) => prior.get(entry.path) !== entry.sha256).map((entry) => entry.path);
  for (const file of prior.keys()) {
    if (current.has(file)) continue;
    // An existing input may now be private or excluded; only disclose actual deletions.
    try { await lstat(path.join(root, file)); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      changed.push(file);
    }
  }
  return changed.sort(compareCodeUnits);
}

export async function explainQuality(root) {
  const result = { schemaVersion: 1, command: "explain", status: "NO_VERIFICADO", code: "evidence_missing",
    exitCode: 2, version: await getVersion(), requiredToolVersions: PYTHON_TOOLS, testsExecuted: false, causes: [], fullReport };
  try {
    const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
    result.limits = config.limits;
    const checkpoint = await captureProjectInputs(root, config.integration.python);
    result.integration = configurationView(root, config, checkpoint);
    result.inputs = publicCheckpoint(checkpoint);
    if (checkpoint.issues.length) {
      throw new IntegrationError("input_checkpoint_incompatible", "Los inputs no permiten una comprobación completa", 2);
    }
    const { python, identity } = await projectTestIdentity(root, config);
    result.integration.pythonVersion = python.version;
    const loaded = await readActiveTask(root);
    const environment = { node: process.version, platform: process.platform, arch: process.arch,
      configurationHash: inputHash(JSON.stringify(config)), executionIdentity: identity,
      qualityTools: loaded?.task.mode === "full" ? await dependencyFingerprint([path.join(root, ".agentic-core/tools")]) : null };
    if (!loaded) throw new IntegrationError("task_missing", "No hay una tarea activa; la configuración fue inspeccionada sin ejecutar pruebas", 4);
    result.task = { id: loaded.task.id, mode: loaded.task.mode };
    result.baseline = { valid: loaded.task.initial.valid, status: loaded.task.initial.result.status,
      code: loaded.task.initial.result.code, preserved: true };
    result.baseline.inputsChanged = loaded.task.initial.inputs.digest !== checkpoint.digest;
    result.baseline.conditionsChanged = loaded.task.initial.result.configurationHash !== environment.configurationHash
      || loaded.task.initial.result.executionIdentity !== environment.executionIdentity
      || loaded.task.mode === "full" && loaded.task.initial.environment?.qualityTools !== environment.qualityTools;
    result.baseline.evidenceCurrent = result.baseline.valid && !result.baseline.inputsChanged && !result.baseline.conditionsChanged;
    const stored = await readVerificationReport(root, loaded.task);
    if (!stored) throw new IntegrationError("evidence_missing", "No existe un veredicto de la tarea activa", 2);
    const report = stored.report;
    if (report.request?.requiredControls.includes("dry")) {
      environment.qualityTools = await dependencyFingerprint([path.join(root, ".agentic-core/tools")]);
    }
    result.evidence = { reference: verificationReference, sha256: stored.sha256, status: report.status, current: false };
    result.reuse = await inspectVerificationEvidence(root, loaded.task, checkpoint, environment, report);
    const changes = new Set(Object.values(result.reuse).filter((item) => !item.reused && item.reason !== "control_pending").map((item) => item.reason));
    // Even an inconclusive control must never hide stale inputs or conditions.
    if (report.evidence?.inputs?.current !== checkpoint.digest) changes.add("quality_inputs_changed");
    if (["configurationHash", "executionIdentity", "node", "platform", "arch"]
      .some((key) => (key === "executionIdentity" ? report.environment?.current?.referenceExecutionIdentity ?? report.environment?.current?.executionIdentity : report.environment?.current?.[key]) !== environment[key])) changes.add("quality_conditions_changed");
    if ((loaded.task.mode === "full" || report.request?.requiredControls.includes("dry"))
      && report.environment?.current?.qualityTools !== environment.qualityTools) changes.add("quality_tools_changed");
    if (changes.size) {
      result.code = [...changes][0];
      result.causes = [...changes].map((code) => cause(code, "La evidencia guardada no corresponde a las condiciones actuales."));
      result.changedInputs = await changedInputPaths(root, report.tests.inputs?.inventory ?? [], checkpoint.inventory);
    } else {
      result.evidence.current = true;
      result.status = report.status;
      result.code = report.code;
      result.exitCode = verificationExit(report.status, report.code, [report.baseline, ...["tests", "dry", "crap", "mutation"].map((name) => report[name])]);
      result.causes = publicFindings(report, checkpoint, config.limits);
    }
    result.controls = report.controls;
  } catch (error) {
    const typed = typeof error?.code === "string" && Number.isInteger(error.exitCode);
    result.code = typed ? error.code : "diagnostic_internal_error";
    result.exitCode = typed ? error.exitCode : 5;
    result.causes.push(cause(result.code, typed ? error.message : "No se pudo completar el diagnóstico; no se ejecutaron pruebas.",
      error.location ? { file: ".agentic-core/config.json", location: error.location } : {}));
  }
  result.nextAction = actionFor(result.code);
  return result;
}

export function formatVerificationSummary(result) {
  const report = result.verification;
  if (!report) return `${result.status} [${result.code}] ${result.message}\nSiguiente acción: ${actionFor(result.code)}\nInforme completo: ${fullReport}\n`;
  const findings = publicFindings(report, report.freshness.checkpoint, { crap: report.crap.threshold ?? report.crap.limit });
  const lines = [result.receipt, `${result.status} [${result.code}] ${result.message}`];
  for (const item of findings.slice(0, 5)) lines.push(`${item.code}: ${item.message}${item.file ? ` ${item.file}${item.line ? `:${item.line}` : ""}` : ""}${item.value !== undefined ? `; valor ${item.value}, límite ${item.limit}` : ""} ${item.action}`);
  lines.push(`Siguiente acción: ${actionFor(result.code)}`, `Informe completo: ${fullReport}`);
  return `${lines.filter(Boolean).join("\n")}\n`;
}

export function formatExplanation(result) {
  const lines = [`${result.status} [${result.code}] — diagnóstico sin ejecutar pruebas.`];
  if (result.version) lines.push(`agentic-core ${result.version}`);
  const integration = result.integration;
  if (integration) {
    lines.push(`Integración: ${integration.provider} / Python ${(integration.pythonVersion ?? []).join(".")} / ${integration.runner}.`,
      `Comando: ${integration.command.executable} ${integration.command.args.join(" ")}; directorio: ${integration.command.cwd}.`,
      `Alcance: ${integration.scope.join(", ")}; inputs públicos: ${result.inputs.inventory.length}; exclusiones: ${Object.entries(result.inputs.exclusions).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
      `Límites: C.R.A.P. ${result.limits.crap}; mutación ${result.limits.mutationScore} %; DRY ${JSON.stringify(result.limits.dry)}.`,
      `Operación: ${result.limits.operation.commandTimeoutMs} ms/comando; ${result.limits.operation.totalBudgetMs} ms totales; ${result.limits.operation.workers} workers.`);
  }
  if (result.baseline) lines.push(`Baseline: ${result.baseline.valid ? "válido" : "no válido"}, ${result.baseline.evidenceCurrent ? "reutilizable" : "conservado; consulte vigencia en el informe completo"}.`);
  if (result.evidence) lines.push(`Evidencia: ${result.evidence.current ? "vigente" : "no vigente"}; ${result.evidence.reference}.`);
  for (const item of result.causes.slice(0, 5)) {
    lines.push(`${item.code}: ${item.message}${item.file ? ` ${item.file}${item.line ? `:${item.line}` : ""}${item.location ? ` (${item.location})` : ""}` : ""}${item.value !== undefined ? `; valor ${item.value}, límite ${item.limit}` : ""} ${item.action}`);
  }
  lines.push(`Siguiente acción: ${result.nextAction}`, `Informe completo: ${fullReport}`);
  return `${lines.map((line) => line.length > 500 ? `${line.slice(0, 497)}...` : line).join("\n")}\n`;
}

export async function runExplainCli(args, io = process) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    io.stdout.write("Uso: agentic-quality explain [--json]\nExplica configuración, alcance y vigencia sin ejecutar pruebas ni reparar evidencia. Puede inspeccionar el intérprete y los hashes del entorno.\n");
    return 0;
  }
  const result = args.length === 0 || args.length === 1 && args[0] === "--json"
    ? await explainQuality(process.cwd())
    : { command: "explain", status: "NO_VERIFICADO", code: "invalid_usage", exitCode: 4, causes: [], nextAction: actions.invalid_usage };
  if (args.includes("--json") || (io.env?.AGENTIC_CORE_OUTPUT ?? process.env.AGENTIC_CORE_OUTPUT) === "json") io.stdout.write(`${JSON.stringify(result)}\n`);
  else io.stdout.write(formatExplanation(result));
  return result.exitCode;
}
