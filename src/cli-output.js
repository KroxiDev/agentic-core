const EMPTY_ITEM = "Ninguna.";

const STATUS_LABELS = new Map([
  ["approved", "aprobado"],
  ["blocked", "bloqueado"],
  ["error", "error"],
  ["failed", "fallido"],
  ["healthy", "saludable"],
  ["not_applicable", "no aplicable"],
  ["partially_repaired", "reparado parcialmente"],
  ["ready", "listo"],
  ["repair_blocked", "reparación bloqueada"],
  ["repair_failed", "reparación fallida"],
  ["repair_preview", "vista previa de reparación"],
  ["repaired", "reparado"],
  ["unsupported_environment", "entorno no soportado"],
  ["unsupported_language", "lenguaje no soportado"],
  ["unhealthy", "no saludable"],
  ["baseline_failed", "baseline fallido"],
  ["restoration_failure", "fallo de restauración"],
]);

const DOCTOR_ACTION_LABELS = new Map([
  ["publish_repaired_hashes", "actualizar hashes reparados"],
  ["restore_managed_block", "restaurar bloque gestionado"],
  ["restore_resource", "restaurar recurso"],
]);

function cleanText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function unique(items) {
  return [...new Set(items.filter(Boolean).map(cleanText))];
}

function statusLabel(status) {
  return STATUS_LABELS.get(status) ?? cleanText(status ?? "desconocido").replaceAll("_", " ");
}

function renderSection(title, items, emptyItem = EMPTY_ITEM) {
  const content = unique(items);
  const bullets = content.length > 0 ? content : [emptyItem];
  return `${title}\n\n${bullets.map((item) => `- ${item}`).join("\n")}`;
}

function renderSections(sections) {
  return `${sections.map(({ title, items, emptyItem }) => renderSection(title, items, emptyItem))
    .join("\n\n")}\n`;
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function maintenanceActionLabel(command, action) {
  if (action === "write_resource") return command === "init" ? "copiar" : "actualizar";
  if (action === "append_managed_block" || action === "replace_managed_block") return "actualizar";
  if (action === "persist_runtime") return "persistir runtime";
  if (action === "write_manifest") return command === "init" ? "crear" : "actualizar";
  if (action === "delete_owned_directory") return "eliminar";
  return cleanText(action).replaceAll("_", " ");
}

function formatPlannedAction(command, action) {
  return `${maintenanceActionLabel(command, action.action)}: ${action.path}`;
}

function manualActionForPlan(plan) {
  if (!plan.error) return [];
  if (plan.error.code === "authorization_required") {
    return ["Repetir `init` con `--replace-conflicts` solo si se autoriza reemplazar los conflictos aislados."];
  }
  if (plan.error.code === "force_required") {
    return ["Repetir `update` con `--force` solo si se autoriza reemplazar los recursos propios divergentes."];
  }
  if (plan.error.code === "runtime_source_required") {
    return ["Repetir `update` mediante `npx.cmd --yes github:KroxiDev/agentic-core` para aportar el runtime canónico."];
  }
  return [plan.error.message];
}

function formatInstallOrUpdate(command, result) {
  const plan = result.plan;
  const conflicts = plan.conflicts ?? [];
  const divergences = plan.divergences ?? [];
  const actions = plan.actions.map((action) => formatPlannedAction(command, action));
  actions.push(`validar ${countLabel(plan.manifest.resources.length, "recurso gestionado", "recursos gestionados")}`);
  actions.push(`validar ${countLabel(plan.manifest.managedBlocks.length, "bloque gestionado", "bloques gestionados")}`);

  const ready = result.dryRun
    ? [
      "Plan completo calculado sin escrituras.",
      `Destino: ${result.projectRoot}`,
      `${countLabel(plan.actions.length, "acción planificada", "acciones planificadas")}.`,
    ]
    : [
      `agentic-core ${result.version} ${command === "init" ? "instalado" : "actualizado"} en ${result.projectRoot}.`,
      `${countLabel(plan.actions.length, "acción", "acciones")} aplicada${plan.actions.length === 1 ? "" : "s"} de forma transaccional.`,
    ];
  const warnings = [];
  if (plan.error) warnings.push(plan.error.message);
  if (conflicts.length > 0) {
    const authorized = conflicts.filter((item) => item.authorized).length;
    warnings.push(`${countLabel(conflicts.length, "conflicto detectado", "conflictos detectados")}; ${authorized} autorizado${authorized === 1 ? "" : "s"}.`);
  }
  if (divergences.length > 0) {
    warnings.push(`${countLabel(divergences.length, "recurso propio divergente", "recursos propios divergentes")} detectado${divergences.length === 1 ? "" : "s"}.`);
  }

  const sections = [{
    title: result.dryRun ? "PLAN (sin escrituras)" : "ACCIONES",
    items: actions,
  }];
  if (conflicts.length > 0) {
    sections.push({
      title: "CONFLICTOS",
      items: conflicts.map((item) => `${item.path}: ${cleanText(item.kind).replaceAll("_", " ")} (${item.authorized ? "autorizado" : "no autorizado"})`),
    });
  }
  if (divergences.length > 0) {
    sections.push({ title: "DIVERGENCIAS", items: divergences });
  }
  sections.push(
    { title: "LISTO", items: ready },
    { title: "ADVERTENCIAS", items: warnings },
    { title: "ACCIONES MANUALES PENDIENTES", items: manualActionForPlan(plan) },
  );
  return renderSections(sections);
}

function formatUninstallAction(action) {
  const separator = action.indexOf(":");
  const kind = separator === -1 ? action : action.slice(0, separator);
  const target = separator === -1 ? "" : action.slice(separator + 1).trim();
  const labels = new Map([
    ["managed block", "retirar bloque gestionado"],
    ["manifest", "eliminar manifiesto"],
    ["owned directory", "eliminar directorio propio"],
    ["resource", "eliminar recurso"],
    ["runtime", "eliminar runtime"],
  ]);
  return `${labels.get(kind) ?? cleanText(kind)}${target ? `: ${target}` : ""}`;
}

function formatUninstall(result) {
  const ready = result.dryRun
    ? [
      "Plan completo calculado sin escrituras.",
      `${countLabel(result.actions.length, "elemento")} se retiraría${result.actions.length === 1 ? "" : "n"}.`,
    ]
    : [
      `Desinstalación aplicada en ${result.projectRoot}.`,
      `${countLabel(result.actions.length, "elemento")} retirado${result.actions.length === 1 ? "" : "s"} de forma transaccional.`,
    ];
  const warnings = result.preserved.map((item) => `Conservado: ${item}.`);
  const pending = result.preserved.map((item) => `Revisar manualmente ${item}.`);
  return renderSections([
    {
      title: result.dryRun ? "PLAN (sin escrituras)" : "ACCIONES",
      items: result.actions.map(formatUninstallAction),
    },
    { title: "LISTO", items: ready },
    { title: "ADVERTENCIAS", items: warnings },
    { title: "ACCIONES MANUALES PENDIENTES", items: pending },
  ]);
}

function formatDoctorAction(action) {
  const label = DOCTOR_ACTION_LABELS.get(action.action)
    ?? cleanText(action.action ?? "reparar").replaceAll("_", " ");
  const suffix = action.checkId ? ` (${action.checkId})` : "";
  return `${label}: ${action.path}${suffix}`;
}

function formatDoctor(result) {
  const { report } = result;
  const diagnosis = report.postRepair ?? report.diagnosis;
  const checks = diagnosis.checks.map((item) => (
    `${statusLabel(item.status)}: ${item.id} — ${item.message}`
  ));
  const repairRequested = report.repair.requested;
  const sections = [];
  if (repairRequested) {
    sections.push({
      title: report.repair.dryRun ? "PLAN (sin escrituras)" : "ACCIONES",
      items: report.repair.actions.map(formatDoctorAction),
    });
    sections.push({ title: report.postRepair ? "DIAGNÓSTICO FINAL" : "DIAGNÓSTICO", items: checks });
  } else {
    sections.push({ title: "DIAGNÓSTICO", items: checks });
  }

  const summary = diagnosis.summary;
  const ready = [
    `Estado: ${statusLabel(report.status)}.`,
    `${countLabel(summary.ok, "comprobación correcta", "comprobaciones correctas")}; ${countLabel(summary.problems, "problema")}; ${countLabel(summary.repairable, "reparación disponible", "reparaciones disponibles")}.`,
  ];
  if (report.repair.status === "preview") ready.push("Plan de reparación calculado sin escrituras.");
  if (report.repair.status === "completed") ready.push("La transacción de reparación finalizó.");
  if (report.repair.status === "not_needed") ready.push("No se requieren reparaciones.");

  const problemChecks = diagnosis.checks.filter((item) => ["blocked", "error"].includes(item.status));
  const warnings = problemChecks.map((item) => `${item.id}: ${item.message}`);
  if (report.repair.reason) warnings.push(report.repair.reason);
  if (report.repair.error?.message) warnings.push(report.repair.error.message);

  const pending = problemChecks.map((item) => item.remediation).filter(Boolean);
  if (problemChecks.length > 0 && pending.length === 0) {
    pending.push("Resolver los problemas sin reparación segura antes de continuar.");
  } else if (!repairRequested && summary.repairable > 0) {
    pending.push("Revisar `agentic-core doctor --dry-run` antes de aplicar `agentic-core doctor --repair`.");
  }
  sections.push(
    { title: "LISTO", items: ready },
    { title: "ADVERTENCIAS", items: warnings },
    { title: "ACCIONES MANUALES PENDIENTES", items: pending },
  );
  return renderSections(sections);
}

export function formatMaintenanceResult(command, result) {
  if (command === "init" || command === "update") return formatInstallOrUpdate(command, result);
  if (command === "uninstall") return formatUninstall(result);
  if (command === "doctor") return formatDoctor(result);
  throw new TypeError(`Unsupported maintenance output command: ${command}`);
}

function displayValue(value) {
  if (Array.isArray(value)) return value.length === 0 ? "ninguno" : value.map(displayValue).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (value === null || value === undefined) return "ninguno";
  if (typeof value === "boolean") return value ? "sí" : "no";
  return cleanText(value);
}

function qualityDetail(detail) {
  const identity = detail.symbol ?? detail.qualifiedName ?? detail.path ?? detail.file ?? detail.id ?? "detalle";
  const state = detail.status ?? detail.outcome ?? detail.classification;
  const crap = detail.current?.crap ?? detail.crap;
  return [identity, state ? statusLabel(state) : undefined, crap === undefined ? undefined : `C.R.A.P. ${crap}`]
    .filter(Boolean).join(" — ");
}

export function formatQualityResult(command, result) {
  const overview = [
    `Comando: ${command}.`,
    `Estado: ${statusLabel(result.status)}.`,
    result.tool ? `Herramienta: ${result.tool}.` : undefined,
    result.language ? `Lenguaje: ${result.language}.` : undefined,
    result.backend ? `Backend: ${result.backend}.` : undefined,
    result.runner ? `Runner: ${result.runner}.` : undefined,
    result.durationMs === undefined ? undefined : `Duración: ${result.durationMs} ms.`,
  ];
  const summary = Object.entries(result.summary ?? {}).map(([key, value]) => (
    `${cleanText(key).replaceAll("_", " ")}: ${displayValue(value)}`
  ));
  const problemStates = new Set(["error", "failed", "survived", "uncovered"]);
  const problemDetails = (result.details ?? []).filter((detail) => (
    problemStates.has(detail.status)
      || problemStates.has(detail.outcome)
      || problemStates.has(detail.classification)
      || detail.passed === false
  ));
  const visibleDetails = problemDetails.slice(0, 20).map(qualityDetail);
  if (problemDetails.length > visibleDetails.length) {
    visibleDetails.push(`y ${problemDetails.length - visibleDetails.length} detalles adicionales en la salida JSON completa`);
  }

  const successful = ["approved", "not_applicable"].includes(result.status);
  const warnings = successful ? [] : [`El reporte terminó como ${statusLabel(result.status)}.`];
  const pending = [];
  if (result.status === "failed") pending.push("Revisar los símbolos o mutantes fallidos antes de continuar.");
  if (result.status === "baseline_failed") pending.push("Corregir el baseline de tests y repetir el análisis.");
  if (["unsupported_environment", "unsupported_language"].includes(result.status)) {
    pending.push("Configurar un entorno y lenguaje soportados antes de repetir el análisis.");
  }
  if (result.status === "restoration_failure") pending.push("Preservar la evidencia y restaurar el workspace antes de continuar.");

  const sections = [{ title: "ANÁLISIS DE CALIDAD", items: overview }];
  if (summary.length > 0) sections.push({ title: "RESUMEN", items: summary });
  if (visibleDetails.length > 0) sections.push({ title: "HALLAZGOS", items: visibleDetails });
  sections.push(
    { title: "LISTO", items: ["Reporte de calidad calculado con su código de salida contractual."] },
    { title: "ADVERTENCIAS", items: warnings },
    { title: "ACCIONES MANUALES PENDIENTES", items: pending },
  );
  return renderSections(sections);
}

export function shouldRenderHumanOutput(io) {
  const outputMode = io?.env?.AGENTIC_CORE_OUTPUT ?? process.env.AGENTIC_CORE_OUTPUT;
  return io?.stdout?.isTTY === true && outputMode !== "json";
}

export function writeCommandResult(io, humanOutput, structuredOutput) {
  const output = shouldRenderHumanOutput(io)
    ? (typeof humanOutput === "function" ? humanOutput() : humanOutput)
    : structuredOutput;
  io.stdout.write(output);
}
