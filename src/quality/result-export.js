import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { IntegrationError } from "./command.js";
import { readActiveTask } from "./task-baseline.js";
import { inputHash, mandatoryInputExclusion, privateInputContent } from "./project-inputs.js";
import { readVerificationReport, verificationReference } from "./python-verification.js";

const usage = "Use agentic-quality export --output <archivo.md> o export --stdout, solo por petición expresa";
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined)
  .map((key) => [key, value[key]]));

// Export normalized evidence, never source snapshots, process output or environment values.
function evidenceSummary(report) {
  const control = (value) => pick(value, ["status", "code", "message", "summary", "limit", "limits", "engine"]);
  return {
    task: report.task,
    status: report.status,
    code: report.code,
    message: report.message,
    controls: report.controls,
    baseline: report.baseline,
    changes: report.changes,
    evidence: pick(report.evidence, ["inputs", "configuration", "versions", "mutation"]),
    tests: { ...control(report.tests),
      suite: pick(report.tests.suite, ["status", "exitCode", "commandExitCode", "collected", "phases", "failed", "failures", "collectionErrors"]),
      coverage: pick(report.tests.coverage, ["status", "code", "summary"]),
      integrity: pick(report.tests.integrity, ["status", "code"]),
      inputIssues: report.tests.inputs?.issues,
    },
    dry: { ...control(report.dry), candidates: (report.dry.candidates ?? []).map((candidate) =>
      pick(candidate, ["id", "status", "classification", "left", "right", "evidence", "resolution"])),
    issues: report.dry.issues },
    crap: { ...control(report.crap), details: (report.crap.details ?? []).map((detail) =>
      pick(detail, ["id", "file", "name", "kind", "line", "startLine", "endLine", "status", "code", "message",
        "value", "crap", "complexity", "coverage", "baseline", "delta", "threshold", "rule"])) },
    mutation: { ...control(report.mutation), ...pick(report.mutation, ["required", "executed", "complete", "score", "inventory"]),
      details: (report.mutation.details ?? []).map((detail) =>
        pick(detail, ["id", "file", "line", "status", "code"])) },
    budget: report.budget,
  };
}

function publicValue(value) {
  if (typeof value === "string") {
    if (privateInputContent(Buffer.from(value)) || mandatoryInputExclusion(value) === "private"
      || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)
      || /[A-Za-z]:[\\/]|(?:^|[\s"'(=])(?:\\\\|\/[^\s/]+\/)/u.test(value)) return "[privado]";
    return value;
  }
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, publicValue(entry)]));
  return value;
}

export function renderQualityResult(report, sha256) {
  const summary = publicValue(evidenceSummary(report));
  // Escaping backticks and HTML keeps report strings inert inside the JSON fence.
  const evidence = JSON.stringify(summary, null, 2).replaceAll("`", "\\u0060").replaceAll("<", "\\u003c");
  return `# Resultado de calidad solicitado\n\n`
    + `Estado del último veredicto: ${summary.status} [${summary.code}].\n\n`
    + `Esta copia conserva el resultado de la tarea indicada; no es una nueva verificación ni un recibo vigente para cambios posteriores.\n`
    + `No se ejecutaron pruebas al exportar. Para verificar el estado actual, ejecute agentic-quality verify.\n\n`
    + `Origen interno: ${verificationReference}; SHA-256: ${sha256}.\n`
    + `La evidencia resumida está incluida abajo y se conserva aunque se retire el informe interno al iniciar otra tarea.\n`
    + `Se omiten código fuente, registros de procesos, valores de entorno y datos privados. Los estados NO_VERIFICADO y NO_APLICA no significan una prueba aprobada.\n`
    + `Esta exportación no publica en un servicio remoto ni sincroniza instalaciones.\n\n`
    + `## Causas, evidencia y límites\n\n\`\`\`json\n${evidence}\n\`\`\`\n`;
}

async function destinationPath(root, requested) {
  const target = path.resolve(root, requested);
  const parts = target.split(/[\\/]/u).map((part) => part.toLowerCase());
  if (!target.toLowerCase().endsWith(".md")
    || parts.some((part) => [".agentic-core", ".git", ".codex", ".agents"].includes(part))) {
    throw new IntegrationError("export_destination_invalid", "Elija un archivo .md fuera de los directorios internos de la capa y Git", 4);
  }
  // Do not follow junctions/symlinks into internal evidence or another task's files.
  for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
    const details = await lstat(parent);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new IntegrationError("export_destination_unsafe", "El destino requiere directorios existentes sin enlaces simbólicos", 4);
    }
    if (parent === path.dirname(parent)) break;
  }
  return target;
}

export async function exportQualityResult(root, args) {
  const stdout = args.length === 1 && args[0] === "--stdout";
  if (!stdout && !(args.length === 2 && args[0] === "--output" && args[1] && !args[1].startsWith("--"))) {
    throw new IntegrationError("invalid_usage", usage, 4);
  }
  const loaded = await readActiveTask(root);
  if (!loaded) throw new IntegrationError("task_missing", "No hay una tarea activa cuyo resultado se pueda exportar", 4);
  const stored = await readVerificationReport(root, loaded.task);
  if (!stored) throw new IntegrationError("export_result_missing", "No hay un veredicto guardado; ejecute verify antes de solicitar su exportación", 2);
  const markdown = renderQualityResult(stored.report, stored.sha256);
  const sha256 = inputHash(markdown);
  const result = { command: "export", exitCode: 0, qualityStatus: stored.report.status, sha256 };
  if (stdout) return { ...result, status: "prepared", code: "export_prepared",
    message: "Markdown preparado para el host; no se ha guardado ni publicado en un destino remoto", markdown };
  let target;
  try {
    target = await destinationPath(root, args[1]);
    const file = await open(target, "wx");
    try { await file.writeFile(markdown, "utf8"); await file.sync(); }
    finally { await file.close(); }
    if (inputHash(await readFile(target)) !== sha256) throw new Error("readback");
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    if (error.code === "EEXIST") throw new IntegrationError("export_destination_exists", "El destino ya existe; se conserva sin reemplazarlo. Elija otro archivo", 4);
    throw new IntegrationError("export_write_failed", "No se confirmó el guardado: revise permisos, directorio y cualquier archivo parcial en el destino solicitado", 5);
  }
  return { ...result, status: "saved", code: "export_saved", message: "Resultado guardado y comprobado mediante lectura", destination: target };
}

export async function runResultExportCli(args, io = process) {
  let result;
  try { result = await exportQualityResult(process.cwd(), args.slice(1)); }
  catch (error) {
    const typed = typeof error.code === "string" && Number.isInteger(error.exitCode);
    result = { command: "export", status: "NO_VERIFICADO", code: typed ? error.code : "export_internal_error",
      message: typed ? error.message : "No se pudo preparar el resultado; no se confirmó ninguna entrega", exitCode: typed ? error.exitCode : 5 };
  }
  if (io.env?.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result)}\n`);
  else io.stdout.write(result.markdown ?? `${result.status} [${result.code}] ${result.message}\n`);
  return result.exitCode;
}
