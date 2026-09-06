import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfiguration } from "../installation/install.js";
import { privatePython } from "../installation/python.js";
import { writeTransaction } from "../transaction.js";
import { commandBudget, executeCommand, IntegrationError } from "./command.js";
import { captureProjectInputs, inputHash, matchesInput, publicCheckpoint } from "./project-inputs.js";
import { projectTestIdentity, runProjectTests } from "./python-project.js";

const adapter = fileURLToPath(new URL("agentic_crap.py", import.meta.url));
const reference = ".agentic-core/quality/crap.json";
const hash = (value) => inputHash(JSON.stringify(value));
const otherLanguage = /\.(?:[cm]?[jt]sx?|go|rs|java|c|cc|cpp|cs|rb|php|swift|kt)$/iu;
const causes = {
  coverage_not_loaded: "El comando real no cargó este archivo",
  coverage_attribution_missing: "Falta cobertura atribuible para este comportamiento",
  coverage_attribution_ambiguous: "La cabecera y el cuerpo comparten una línea sin atribución independiente",
  unsupported_syntax: "La sintaxis no se pudo analizar",
  unsupported_language: "El lenguaje está fuera de la integración Python",
  unsupported_construct: "El adaptador no puede atribuir por separado el cuerpo de una lambda",
  crap_analysis_failed: "El analizador no pudo medir esta parte",
  crap_limit_exceeded: "El valor supera el límite configurado",
  no_executable_code: "El AST no contiene comportamiento ejecutable que medir",
};

async function saveReport(root, result) {
  for (const relative of [".agentic-core", ".agentic-core/quality"]) {
    try {
      const info = await lstat(path.join(root, relative));
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe");
    } catch (error) {
      if (error.code === "ENOENT" && relative.endsWith("/quality")) await mkdir(path.join(root, relative));
      else throw new IntegrationError("quality_report_unsafe", "La ubicación del informe no es un directorio propio seguro");
    }
  }
  const target = path.join(root, reference);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe");
    const previous = JSON.parse(await readFile(target, "utf8"));
    if (previous.kind !== "crap" || previous.sha256 !== hash(previous.result)) throw new Error("foreign");
  } catch (error) {
    if (error.code !== "ENOENT") throw new IntegrationError("quality_report_conflict", "El informe existente es ajeno o divergente; se conserva sin reemplazarlo");
  }
  await writeTransaction(root, [{ path: target,
    content: Buffer.from(`${JSON.stringify({ kind: "crap", sha256: hash(result), result })}\n`) }]);
}

async function measure(root, config, checkpoint, execution, budget) {
  const sources = checkpoint.entries.filter((entry) => entry.kind === "measured_code"
    || otherLanguage.test(entry.path) && config.integration.python.scope.some((scope) => matchesInput(entry.path, scope)))
    .map(({ content, ...entry }) => ({ ...entry, content: content.toString("base64") }));
  const temporary = await mkdtemp(path.join(tmpdir(), "agentic-crap-"));
  try {
    const request = path.join(temporary, "request.json");
    await writeFile(request, JSON.stringify({ sources, coverage: execution.coverage ?? {}, limit: config.limits.crap }));
    const outcome = await executeCommand({ executable: privatePython(path.join(root, ".agentic-core/tools")),
      args: ["-I", "-B", adapter, request] },
    { cwd: temporary, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: budget() });
    let parsed;
    try { parsed = JSON.parse(outcome.stdout); } catch { throw new IntegrationError("invalid_crap_evidence", "El adaptador no devolvió evidencia válida", 5); }
    if (outcome.exitCode !== 0 || parsed.error) throw new IntegrationError(parsed.error ?? "crap_adapter_failed", "La herramienta privada C.R.A.P. falta o no pudo completar la medición");
    if (!Array.isArray(parsed.details) || parsed.engine?.version !== "0.1.1") throw new IntegrationError("invalid_crap_evidence", "El adaptador no devolvió el contrato esperado", 5);
    return parsed;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function runPythonCrap(root) {
  const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
  const budget = commandBudget(config.limits.operation);
  const before = await captureProjectInputs(root, config.integration.python);
  const execution = await runProjectTests(root);
  const measured = await measure(root, config, before, execution, budget);
  const after = await captureProjectInputs(root, config.integration.python);
  let currentIdentity;
  try { currentIdentity = (await projectTestIdentity(root, config)).identity; }
  catch { /* The execution's typed environment cause remains in the report. */ }
  const changed = before.digest !== after.digest || execution.inputs && execution.inputs.digest !== before.digest
    || execution.configurationHash && execution.configurationHash !== hash(config)
    || execution.executionIdentity && currentIdentity !== execution.executionIdentity;
  const details = measured.details.map((row) => ({ ...row, message: causes[row.code] ?? "Medición dentro del límite configurado" }));
  const incomplete = details.some((row) => row.status === "NO_VERIFICADO");
  const violations = details.some((row) => row.status === "rejected");
  const noCode = details.every((row) => row.status === "NO_APLICA");
  const completed = ["tests_passed", "tests_failed"].includes(execution.code)
    || noCode && execution.code === "coverage_failed" && execution.suite?.status === "passed";
  const unavailable = changed || before.issues.length || after.issues.length || execution.integrity?.status !== "preserved"
    || !completed;
  const status = unavailable || incomplete ? "NO_VERIFICADO" : violations || execution.exitCode === 1 ? "rejected" : noCode ? "NO_APLICA" : "approved";
  const code = changed ? "crap_inputs_changed" : unavailable ? execution.code : incomplete ? "crap_incomplete"
    : violations ? "crap_limit_exceeded" : execution.exitCode === 1 ? "tests_failed" : noCode ? "no_executable_code" : "crap_measured";
  return { command: "crap", schemaVersion: 1, status, code, exitCode: status === "NO_VERIFICADO" ? 2 : status === "rejected" ? 1 : 0,
    message: status === "NO_VERIFICADO" ? "La medición es incompleta; revise las causas y conserve los resultados parciales"
      : status === "rejected" ? "Hay incumplimientos comprobados; revise valores, límite y suite"
        : noCode ? "No hay comportamiento ejecutable medible en el alcance" : "C.R.A.P. medido dentro del límite; los demás controles de calidad son independientes",
    engine: measured.engine, limit: config.limits.crap,
    identity: hash({ inputs: before.digest, execution: execution.executionIdentity, engine: measured.engine, config }),
    inputs: publicCheckpoint(before), execution, details, reference,
    summary: { measured: details.filter((row) => Number.isFinite(row.value)).length,
      rejected: details.filter((row) => row.status === "rejected").length,
      unverified: details.filter((row) => row.status === "NO_VERIFICADO").length } };
}

export async function runPythonCrapCli(args, io = process) {
  let result;
  try {
    if (args.length !== 1) throw new IntegrationError("invalid_usage", "Use agentic-quality crap; alcance y límite provienen de config.json", 4);
    result = await runPythonCrap(process.cwd());
    await saveReport(process.cwd(), result);
  } catch (error) {
    const typed = typeof error.code === "string" && Number.isInteger(error.exitCode);
    const { reference: _unsaved, ...partial } = result ?? {};
    result = { ...partial, command: "crap", status: "NO_VERIFICADO", code: typed ? error.code : "crap_internal_error",
      message: typed ? error.message : "No se pudo completar o conservar la medición C.R.A.P.", exitCode: typed ? error.exitCode : 5 };
  }
  if (io.env?.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    io.stdout.write(`${result.status} [${result.code}] ${result.message}\n`);
    const priority = { NO_VERIFICADO: 0, rejected: 1, approved: 2, NO_APLICA: 3 };
    const rows = [...result.details ?? []].sort((left, right) => priority[left.status] - priority[right.status]);
    for (const row of rows.slice(0, 8)) io.stdout.write(`${row.file}:${row.line} ${row.name ?? ""}: ${row.value ?? "sin medición"}; límite ${row.limit}; ${row.message}\n`);
    if (result.reference) io.stdout.write(`Informe íntegro: ${result.reference}\n`);
  }
  return result.exitCode;
}
