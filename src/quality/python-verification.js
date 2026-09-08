import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readConfiguration } from "../installation/install.js";
import { writeTransaction } from "../transaction.js";
import { IntegrationError } from "./command.js";
import { budgetSummary } from "./task-budget.js";
import { compareCodeUnits } from "./order.js";
import { captureProjectInputs, inputHash, publicCheckpoint } from "./project-inputs.js";
import { dependencyFingerprint } from "./project-copy.js";
import { projectTestIdentity, runProjectTests } from "./python-project.js";
import { runPythonCrap } from "./python-crap.js";
import { runPythonDry } from "./python-dry.js";
import { aggregateMutation } from "./mutation-aggregation.js";

export { aggregateMutation } from "./mutation-aggregation.js";

import { taskControl } from "./task-controls.js";
import { resolveTaskSelection } from "./selection.js";

const reference = ".agentic-core/quality/verification.json";
export const verificationReference = reference;
const schema = "https://kroxidev.dev/agentic-core/python-quality-verification.schema.json";
const hash = (value) => inputHash(JSON.stringify(value));
const noVerification = "NO_VERIFICADO";
const acceptedStatuses = new Set(["approved", "rejected", "NO_VERIFICADO", "NO_APLICA"]);
const reusableStatuses = new Set(["approved", "rejected", "NO_APLICA"]);

function isFiniteValue(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function controlFailure(command, error) {
  const typed = typeof error?.code === "string" && Number.isInteger(error.exitCode);
  return {
    command,
    status: noVerification,
    code: typed ? error.code : `${command}_internal_error`,
    message: typed ? error.message : `No se pudo completar la comprobación ${command}`,
    exitCode: typed ? error.exitCode : 5,
  };
}

async function ownDirectory(directory) {
  try {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("unsafe");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new IntegrationError("quality_report_unsafe", "La ubicación del veredicto no es un directorio propio seguro", 2);
    }
    await mkdir(directory, { recursive: true });
  }
}

function sameTask(left, right) {
  return left?.id === right?.id && left?.mode === right?.mode
    && left?.objective === right?.objective
    && JSON.stringify(left?.scope) === JSON.stringify(right?.scope);
}

async function inspectExistingReport(root, taskId, expectedTask) {
  const target = path.join(root, reference);
  let content;
  try {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("unsafe");
    content = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new IntegrationError("quality_report_conflict", "El veredicto existente no es un archivo regular seguro; se conserva sin reemplazarlo", 2);
  }
  let report;
  try { report = JSON.parse(content); }
  catch { throw new IntegrationError("quality_report_conflict", "El veredicto existente está corrupto; se conserva sin reemplazarlo", 2); }
  if (report?.$schema !== schema || report.schemaVersion !== 1
    || taskId !== undefined && report.task?.id !== taskId
    || expectedTask && !sameTask(report.task, expectedTask)
    || typeof report.task?.id !== "string" || !acceptedStatuses.has(report.status)
    || !report.controls || !report.tests || !report.dry || !report.crap || !report.mutation) {
    throw new IntegrationError("quality_report_conflict", "El veredicto existente es ajeno o divergente; se conserva sin reemplazarlo", 2);
  }
  const { integrity, ...evidence } = report;
  if (integrity !== hash(evidence)) {
    throw new IntegrationError("quality_report_conflict", "El veredicto existente está corrupto; se conserva sin reemplazarlo", 2);
  }
  return { report, sha256: inputHash(content), content: Buffer.from(content) };
}

export async function readVerificationReport(root, expectedTask) {
  return inspectExistingReport(root, expectedTask?.id, expectedTask);
}

function compactReport(report) {
  if (!report || typeof report !== "object") return report;
  const { reference: _reference, ...compact } = report;
  return compact;
}

function baselineQuality(task) {
  return task.initial?.quality ?? null;
}

function detailValue(detail) {
  if (isFiniteValue(detail?.value)) return detail.value;
  if (isFiniteValue(detail?.crap)) return detail.crap;
  return null;
}

function detailKey(detail) {
  return detail?.id ?? `${detail?.file ?? ""}\0${detail?.kind ?? ""}\0${detail?.name ?? ""}`;
}

function readableLimitRule(limit, kind) {
  const suffix = limit === 7 ? "seven" : "limit";
  return `${kind}_${suffix}`;
}

function changedEntries(initial, current, scopes) {
  const before = new Map((initial ?? []).map((entry) => [entry.path, entry]));
  const after = new Map((current ?? []).map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareCodeUnits);
  return paths.flatMap((file) => {
    const previous = before.get(file);
    const next = after.get(file);
    if (previous?.sha256 === next?.sha256 && previous?.kind === next?.kind) return [];
    const kind = next?.kind ?? previous?.kind;
    const inScope = scopes.some((scope) => scope === "." || file === scope || file.startsWith(`${scope}/`));
    return [{
      path: file,
      kind,
      change: previous === undefined ? "added" : next === undefined ? "deleted" : "modified",
      attribution: kind === "test_input" ? "evidence" : inScope ? "scope" : "outside_scope",
      before: previous?.sha256 ?? null,
      after: next?.sha256 ?? null,
    }];
  });
}

function baselineRows(report) {
  return Array.isArray(report?.details) ? report.details : [];
}

export function compareCrap(current, baseline, limit) {
  const priorRows = baselineRows(baseline);
  const currentRows = current?.details ?? [];
  const currentKeys = new Set(currentRows.map(detailKey));
  const exact = new Map();
  for (const row of priorRows) {
    const key = detailKey(row);
    const entries = exact.get(key) ?? [];
    entries.push(row);
    exact.set(key, entries);
  }
  const used = new Set();
  const comparablePrior = priorRows.filter((row) => detailValue(row) !== null);
  const details = currentRows.map((row) => {
    const key = detailKey(row);
    let prior = (exact.get(key) ?? []).find((candidate) => !used.has(candidate));
    let relation = "same_identity";
    if (!prior && row.fingerprint) {
      const moved = comparablePrior.filter((candidate) => !used.has(candidate)
        && !currentKeys.has(detailKey(candidate))
        && candidate.kind === row.kind && candidate.name === row.name
        && candidate.fingerprint === row.fingerprint);
      const destinations = currentRows.filter((candidate) => !exact.has(detailKey(candidate))
        && candidate.kind === row.kind && candidate.name === row.name
        && candidate.fingerprint === row.fingerprint);
      if (moved.length === 1 && destinations.length === 1) {
        prior = moved[0];
        relation = "relocated_identity";
      }
    }
    if (prior) used.add(prior);

    const value = detailValue(row);
    const common = { ...row, value: row.value ?? value };
    if (row.status === "NO_APLICA") {
      return { ...common, incrementalStatus: "NO_APLICA", rule: "not_applicable" };
    }
    if (row.status === noVerification || value === null) {
      return {
        ...common,
        baseline: prior ? { status: "unverified", value: detailValue(prior) } : { status: "not_attributable" },
        delta: null,
        incrementalStatus: noVerification,
        rule: "current_measurement_unverified",
        status: noVerification,
      };
    }
    if (!prior) {
      const identityCandidates = priorRows.filter((candidate) => !used.has(candidate)
        && !currentKeys.has(detailKey(candidate))
        && candidate.kind === row.kind && candidate.name === row.name);
      if (identityCandidates.length > 0) {
        return {
          ...common,
          baseline: { status: "ambiguous_identity", candidates: identityCandidates.map((candidate) => candidate.id ?? null) },
          delta: null,
          incrementalStatus: noVerification,
          rule: "baseline_identity_ambiguous",
          status: noVerification,
        };
      }
      const approved = value <= limit;
      return {
        ...common,
        baseline: { status: "new_symbol" },
        delta: null,
        incrementalStatus: approved ? "approved" : "rejected",
        rule: readableLimitRule(limit, "new_symbol_at_or_below"),
        status: approved ? "approved" : "rejected",
      };
    }
    const previousValue = detailValue(prior);
    if (previousValue === null || prior.status === noVerification) {
      return {
        ...common,
        baseline: { status: "unverified", value: previousValue },
        delta: null,
        incrementalStatus: noVerification,
        rule: "baseline_measurement_unverified",
        status: noVerification,
      };
    }
    const threshold = previousValue;
    const approved = value <= threshold;
    const rule = previousValue <= limit
      ? "existing_must_not_worsen"
      : "preexisting_debt_must_not_worsen";
    return {
      ...common,
      baseline: {
        status: relation === "relocated_identity" ? "relocated" : "attributed",
        value: previousValue,
        crap: previousValue,
        id: prior.id ?? null,
        sourceHash: prior.sourceHash ?? null,
      },
      delta: Number((value - previousValue).toFixed(4)),
      threshold,
      incrementalStatus: approved ? "approved" : "rejected",
      rule,
      status: approved ? "approved" : "rejected",
    };
  });
  const unverified = details.some((detail) => detail.status === noVerification
    || detail.incrementalStatus === noVerification);
  const rejected = details.some((detail) => detail.status === "rejected"
    || detail.incrementalStatus === "rejected");
  const applicable = details.some((detail) => detail.status !== "NO_APLICA");
  const status = current?.status === noVerification ? noVerification
    : unverified ? noVerification : rejected ? "rejected" : applicable ? "approved" : "NO_APLICA";
  const code = status === noVerification ? current?.status === noVerification ? current.code ?? "crap_measurement_incomplete" : "crap_measurement_incomplete"
    : status === "rejected" ? "crap_limit_exceeded"
      : status === "NO_APLICA" ? "no_executable_code" : "crap_measured";
  return {
    ...current,
    status,
    code,
    exitCode: status === noVerification ? current?.status === noVerification ? current.exitCode ?? 2 : 2
      : status === "rejected" ? 1 : 0,
    details,
    baseline: {
      status: baseline ? baseline.status ?? "captured" : "missing",
      identity: baseline?.identity ?? null,
      inputs: baseline?.inputs?.digest ?? baseline?.execution?.inputs?.digest ?? null,
      configuration: baseline?.execution?.configurationHash ?? null,
    },
    summary: {
      ...(current.summary ?? {}),
      approved: details.filter((detail) => detail.status === "approved").length,
      rejected: details.filter((detail) => detail.status === "rejected").length,
      unverified: details.filter((detail) => detail.status === noVerification).length,
      maximum: details.reduce((maximum, detail) => {
        const value = detailValue(detail);
        return value === null ? maximum : Math.max(maximum ?? value, value);
      }, null),
    },
  };
}

function qualityBaselineControl(task) {
  const quality = baselineQuality(task);
  const stored = quality?.crap;
  if (stored && Array.isArray(stored.details)) {
    if (stored.status === noVerification) {
      return { status: noVerification, code: "baseline_quality_incomplete", report: stored };
    }
    return { status: "approved", code: "baseline_captured", report: stored };
  }
  return { status: noVerification, code: "baseline_quality_missing" };
}

function controlStatus(control) {
  return { status: control.status, code: control.code ?? null };
}

function freshnessControl(value) {
  if (value.status === noVerification) return { status: noVerification, code: "current_inputs_incomplete" };
  if (value.conditionsChanged) return { status: noVerification, code: "quality_conditions_changed" };
  return { status: "approved", code: "conditions_preserved" };
}

export function verificationConsistency({ inputs, configurations, identities }) {
  const differs = (values) => values.some((value) => value !== values[0]);
  if (differs(inputs)) return { status: noVerification, code: "quality_inputs_changed" };
  if (differs(configurations) || differs(identities)) {
    return { status: noVerification, code: "quality_conditions_changed" };
  }
  return { status: "approved", code: "conditions_preserved" };
}

export function verificationExit(status, code, controls) {
  if (status === "approved" || status === "NO_APLICA") return 0;
  const cause = controls.find((control) => control.code === code);
  return cause?.exitCode ?? (status === "rejected" ? 1 : 2);
}

function aggregateStatus({ baseline, evidence, tests, dry, crap, mutation }) {
  const controls = [baseline, evidence, tests, dry, crap, mutation];
  if (controls.some((control) => control.status === noVerification)) return noVerification;
  if (controls.some((control) => control.status === "rejected")) return "rejected";
  if (tests.status !== "approved") return noVerification;
  if ([dry, crap].every((control) => control.status === "NO_APLICA")) return "NO_APLICA";
  return "approved";
}

function aggregateCode(status, { baseline, evidence, tests, dry, crap, mutation }) {
  const limit = [tests, dry, crap, mutation].find((control) =>
    ["budget_exhausted", "command_timeout", "concurrency_limit", "budget_interrupted", "termination_failed"].includes(control.code));
  if (limit) return limit.code;
  if (baseline.status === noVerification && baseline.code === "baseline_invalid") return baseline.code;
  if (tests.status === "rejected") return tests.code;
  if (evidence.status === noVerification) return evidence.code;
  if (baseline.status === noVerification) return baseline.code;
  if (status === noVerification) {
    return [evidence, tests, dry, crap, mutation].find((control) => control.status === noVerification)?.code
      ?? "quality_measurement_incomplete";
  }
  if (status === "rejected") {
    return [tests, dry, crap, mutation].find((control) => control.status === "rejected")?.code
      ?? "quality_gate_failed";
  }
  if (status === "NO_APLICA") return "no_executable_code";
  return "quality_approved";
}

function aggregateMessage(status, code, mode, mutation) {
  if (status === "approved") {
    return mode === "full"
      ? mutation?.status === "NO_APLICA"
        ? "Suite, DRY y C.R.A.P. cumplen; no hay mutantes incrementales exigibles"
        : "Suite, DRY, C.R.A.P. y Mutation Testing cumplen los controles de la tarea"
      : "Suite, DRY y C.R.A.P. cumplen los controles de la tarea";
  }
  if (status === "NO_APLICA") return "La tarea no contiene código Python ejecutable en el alcance";
  if (status === "rejected") return `La verificación rechazó la tarea por ${code}`;
  return `La verificación no tiene evidencia completa por ${code}`;
}

function mutationFor(mode) {
  if (mode === "full") {
    return {
      command: "mutation",
      status: noVerification,
      code: "mutation_selection_incomplete",
      message: "Full requiere un inventario y un score de mutación incrementales verificables",
      required: true,
      executed: false,
    };
  }
  return {
    command: "mutation",
    status: "NO_APLICA",
    code: `mode_${mode}`,
    message: "Mutation Testing no es exigible en este modo",
    required: false,
    executed: false,
  };
}

function initialEnvironment(task) {
  if (task.initial?.environment) return task.initial.environment;
  const result = task.initial?.result ?? {};
  return {
    node: null,
    platform: null,
    arch: null,
    python: result.python ?? null,
    runner: result.effectiveCommand ?? null,
    configurationHash: result.configurationHash ?? null,
    executionIdentity: result.executionIdentity ?? null,
    qualityTools: null,
  };
}

async function currentEnvironment(root, tests, selection) {
  let identity = null;
  let currentConfig;
  let configurationHash = null;
  let qualityTools = null;
  try {
    currentConfig = await readConfiguration(path.join(root, ".agentic-core/config.json"));
    configurationHash = hash(currentConfig);
    identity = (await projectTestIdentity(root, currentConfig)).identity;
  }
  catch { /* The typed test result remains the source of the environment cause. */ }
  try { qualityTools = await dependencyFingerprint([path.join(root, ".agentic-core/tools")]); }
  catch { /* The tool environment cause remains in the typed control result. */ }
  const referenceExecutionIdentity = identity;
  if (selection) identity = (await projectTestIdentity(root, currentConfig, selection)).identity;
  return {
    referenceExecutionIdentity,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    python: tests.python ?? null,
    runner: tests.effectiveCommand ?? null,
    configurationHash,
    executionIdentity: identity,
    qualityTools,
  };
}

async function persistVerification(root, task, document, previous) {
  await ownDirectory(path.join(root, ".agentic-core"));
  await ownDirectory(path.join(root, ".agentic-core", "quality"));
  const existing = await inspectExistingReport(root, task.id, document.task);
  if ((existing?.report.integrity ?? null) !== (previous?.integrity ?? null)) {
    throw new IntegrationError("quality_report_conflict", "El veredicto cambió durante la verificación; se conserva", 2);
  }
  const { readActiveTask } = await import("./task-baseline.js");
  const active = await readActiveTask(root);
  if (active?.sha256 !== hash(task)) {
    throw new IntegrationError("task_evidence_invalid", "La tarea cambió durante la verificación; se conserva", 2);
  }
  document.integrity = hash(document);
  const content = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const target = path.join(root, reference);
  await writeTransaction(root, [
    { path: path.join(root, ".agentic-core/quality/active-task.json"), content: active.content, expectedContent: active.content },
    { path: target, content, expectedContent: existing?.content ?? null },
  ]);
  return { reference, sha256: inputHash(content) };
}

function freshness(task, currentCheckpoint, tests, configHash, qualityTools) {
  const initial = task.initial ?? {};
  const initialInputs = initial.inputs?.inventory ?? [];
  const currentInputs = currentCheckpoint.inventory ?? [];
  const changed = changedEntries(initialInputs, currentInputs, task.scope ?? []);
  const configurationChanged = configHash !== initial.result?.configurationHash;
  const identityKnown = tests.executionIdentity !== undefined && initial.result?.executionIdentity !== undefined;
  const toolsKnown = task.mode === "full" && initial.environment?.qualityTools !== undefined;
  const conditionsChanged = configurationChanged || identityKnown
    && tests.executionIdentity !== initial.result.executionIdentity
    || toolsKnown && qualityTools !== initial.environment.qualityTools;
  return {
    status: currentCheckpoint.issues?.length ? noVerification : "compared",
    changed: changed.map((entry) => entry.path),
    details: changed,
    conditionsChanged,
    inputsChanged: currentCheckpoint.digest !== initial.inputs?.digest,
    evidenceCurrent: initial.valid === true && !currentCheckpoint.issues?.length
      && !conditionsChanged && currentCheckpoint.digest === initial.inputs?.digest,
    baselinePreserved: true,
    checkpoint: publicCheckpoint(currentCheckpoint),
    configurationHash: configHash,
    executionIdentity: tests.executionIdentity ?? null,
    qualityTools,
  };
}

export async function capturePythonQualityBaseline(root, { checkpoint, execution }) {
  let crap;
  let dry;
  try { crap = await runPythonCrap(root, { checkpoint, execution }); }
  catch (error) { crap = controlFailure("crap", error); }
  try { dry = await runPythonDry(root, { activeTask: null, ignoreStoredResolutions: true }); }
  catch (error) { dry = controlFailure("dry", error); }
  const status = [crap, dry].some((control) => control.status === noVerification)
    ? noVerification : "captured";
  return {
    schemaVersion: 1,
    status,
    code: status === noVerification ? "baseline_quality_incomplete" : "baseline_quality_captured",
    crap: compactReport(crap),
    dry: compactReport(dry),
  };
}

async function resolutionHash(root) {
  try {
    const file = path.join(root, ".agentic-core/quality/dry-resolutions.json");
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) return undefined;
    return inputHash(await readFile(file));
  } catch (error) {
    return error?.code === "ENOENT" ? null : undefined;
  }
}

function controlReuse(previous, name, task, checkpoint, environment, resolutions) {
  const result = (reason) => ({ reused: reason === "evidence_current", reason });
  const control = previous?.[name];
  if (!control) return result("evidence_missing");
  if (!sameTask(previous.task, task) || previous.baseline?.checkpoint !== task.initial.inputs.digest) {
    return result("task_evidence_incompatible");
  }
  if (!reusableStatuses.has(control.status)) return result("control_pending");
  const inputs = name === "dry" ? control.hashes?.inputs : control.inputs?.digest;
  if (checkpoint.issues.length || inputs !== checkpoint.digest) return result("quality_inputs_changed");
  const priorEnvironment = previous.environment?.verificationStart ?? previous.environment?.current;
  const configuration = name === "dry" ? control.hashes?.configuration
    : name === "tests" ? control.configurationHash : control.execution?.configurationHash;
  const identity = name === "dry" ? priorEnvironment?.executionIdentity
    : name === "tests" ? control.executionIdentity : control.execution?.executionIdentity;
  if (!environment.executionIdentity || configuration !== environment.configurationHash
    || identity !== environment.executionIdentity
    || ["node", "platform", "arch", "configurationHash", "executionIdentity"]
      .some((key) => priorEnvironment?.[key] !== environment[key])) return result("quality_conditions_changed");
  if (name !== "tests" && (typeof environment.qualityTools !== "string"
    || priorEnvironment?.qualityTools !== environment.qualityTools)) return result("quality_tools_changed");
  if (name === "tests" && control.integrity?.status !== "preserved") return result("control_pending");
  if (name === "dry" && (resolutions === undefined || control.hashes?.resolutions !== resolutions)) {
    return result("dry_resolutions_changed");
  }
  return result("evidence_current");
}

// Read-only counterpart of the verifier: the same reuse rules, without controls.
export async function inspectVerificationEvidence(root, task, checkpoint, environment, previous) {
  if (task.mode !== "full" && previous?.request) {
    const requested = previous.request.delta
      ? { changes: true, ...(previous.request.selection?.tests ? { tests: previous.request.selection.tests } : {}) }
      : previous.request.selection ?? undefined;
    const { selection, delta } = await resolveTaskSelection(root, requested, task);
    const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
    const selected = selection ? await captureProjectInputs(root, config.integration.python, selection) : checkpoint;
    const selectedEnvironment = selection
      ? { ...environment, executionIdentity: (await projectTestIdentity(root, config, selection)).identity } : environment;
    const request = { ...previous.request, selection: selection ?? null, delta: delta ?? null };
    const drySelection = selection?.code ? { code: selection.code } : undefined;
    const dryCheckpoint = drySelection ? await captureProjectInputs(root, config.integration.python, drySelection) : checkpoint;
    const compatible = hash(request) === hash(previous.request);
    return { tests: hash(request) === hash(previous.request)
      ? controlReuse(previous, "tests", task, selected, selectedEnvironment)
      : { reused: false, reason: "quality_inputs_changed" },
      dry: compatible && request.requiredControls.includes("dry")
        ? controlReuse(previous, "dry", task, dryCheckpoint, selectedEnvironment, await resolutionHash(root))
        : { reused: false, reason: "control_pending" },
      crap: compatible && request.requiredControls.includes("crap")
        ? controlReuse(previous, "crap", task, selected, selectedEnvironment)
        : { reused: false, reason: "control_pending" } };
  }
  const resolutions = await resolutionHash(root);
  return Object.fromEntries(["tests", "dry", "crap"].map((name) =>
    [name, controlReuse(previous, name, task, checkpoint, environment, resolutions)]));
}

export async function verifyPythonTask(root, task, { previous, requiredControls, selection: requestedSelection } = {}) {
  const historical = task.mode === "full";
  requiredControls = historical ? ["dry", "crap", "mutation"] : requiredControls ?? task.requiredControls ?? [];
  const { selection, delta } = await resolveTaskSelection(root, requestedSelection, task);
  const request = { requiredControls, selection: selection ?? null, delta: delta ?? null };
  const compatibleRequest = Boolean(previous?.request)
    && hash(previous.request.selection) === hash(request.selection)
    && hash(previous.request.delta) === hash(request.delta);
  const config = await readConfiguration(path.join(root, ".agentic-core", "config.json"));
  const before = await captureProjectInputs(root, config.integration.python);
  const startEnvironment = await currentEnvironment(root, previous?.tests ?? {}, selection);
  if (delta && delta.checkpoint !== before.digest) {
    throw new IntegrationError("quality_inputs_changed", "Los inputs cambiaron después de seleccionar el delta", 2);
  }
  const testCheckpoint = selection ? await captureProjectInputs(root, config.integration.python, selection) : before;
  const drySelection = selection?.code ? { code: selection.code } : undefined;
  const dryCheckpoint = drySelection ? await captureProjectInputs(root, config.integration.python, drySelection) : before;
  const reuse = {
    tests: !historical && !compatibleRequest ? { reused: false, reason: "selection_changed" }
      : controlReuse(previous, "tests", task, testCheckpoint, startEnvironment),
  };
  const tests = reuse.tests.reused ? previous.tests : await runProjectTests(root, selection, { requireCoverage: historical });
  reuse.dry = !historical && !compatibleRequest ? { reused: false, reason: "selection_changed" }
    : controlReuse(previous, "dry", task, dryCheckpoint, startEnvironment, await resolutionHash(root));
  reuse.crap = !historical && !compatibleRequest ? { reused: false, reason: "selection_changed" }
    : controlReuse(previous, "crap", task, testCheckpoint, startEnvironment);
  // C.R.A.P. depends on the suite's coverage, so a new execution requires a new measurement.
  if (reuse.crap.reused && !reuse.tests.reused) reuse.crap = { reused: false, reason: "tests_executed" };
  let dry;
  let currentCrap;
  let initialCrap;
  try {
    dry = !requiredControls.includes("dry") ? taskControl("dry", false)
      : reuse.dry.reused ? previous.dry
        : { ...await runPythonDry(root, { activeTask: { task }, selection: drySelection }), required: true, executed: true };
  }
  catch (error) { dry = { ...controlFailure("dry", error), required: true, executed: true }; }
  try {
    currentCrap = !requiredControls.includes("crap") ? taskControl("crap", false)
      : reuse.crap.reused ? previous.crap : await runPythonCrap(root, { execution: tests, selection });
  }
  catch (error) { currentCrap = { ...controlFailure("crap", error), required: true, executed: true }; }
  if (!historical && requiredControls.includes("crap")) {
    try {
      initialCrap = reuse.crap.reused ? previous.crap.initialMeasurement
        : await runPythonCrap(root, { referenceTask: task, selection });
    }
    catch (error) { initialCrap = controlFailure("crap", error); }
  }
  const after = await captureProjectInputs(root, config.integration.python);
  const configHash = hash(config);
  const currentEnvironmentValue = await currentEnvironment(root, tests, selection);
  const taskFreshness = freshness(task, after, { ...tests, executionIdentity: currentEnvironmentValue.referenceExecutionIdentity }, configHash, currentEnvironmentValue.qualityTools);
  let evidence = freshnessControl(taskFreshness);
  if (historical && evidence.status === "approved" && tests.status === "approved"
    && dry.status !== noVerification && currentCrap.status !== noVerification) {
    evidence = verificationConsistency({
      inputs: [before.digest, tests.inputs?.digest, dry.hashes?.inputs, currentCrap.inputs?.digest, after.digest],
      configurations: [configHash, tests.configurationHash, dry.hashes?.configuration,
        currentCrap.execution?.configurationHash, currentEnvironmentValue.configurationHash],
      identities: [tests.executionIdentity, currentCrap.execution?.executionIdentity,
        currentEnvironmentValue.executionIdentity],
    });
  }
  if (!historical && evidence.status === "approved" && tests.status === "approved") {
    const selectedAfter = selection ? await captureProjectInputs(root, config.integration.python, selection) : after;
    evidence = verificationConsistency({
      inputs: [testCheckpoint.digest, tests.inputs?.digest, selectedAfter.digest],
      configurations: [configHash, tests.configurationHash, currentEnvironmentValue.configurationHash],
      identities: [startEnvironment.executionIdentity, tests.executionIdentity, currentEnvironmentValue.executionIdentity],
    });
    if (before.digest !== after.digest) evidence = { status: noVerification, code: "quality_inputs_changed" };
  }
  if ((historical || requiredControls.some((name) => ["dry", "crap"].includes(name)) ? ["configurationHash", "executionIdentity", "qualityTools"] : ["configurationHash", "executionIdentity"])
    .some((key) => startEnvironment[key] !== currentEnvironmentValue[key])) {
    evidence = { status: noVerification, code: "quality_conditions_changed" };
  }
  if (requiredControls.includes("dry") && dry.status !== noVerification && dry.hashes?.resolutions !== await resolutionHash(root)) {
    evidence = { status: noVerification, code: "dry_resolutions_changed" };
  }
  const crapBaseline = qualityBaselineControl(task);
  let crap = currentCrap;
  if (historical) {
    crap = crapBaseline.report ? compareCrap(currentCrap, crapBaseline.report, config.limits.crap)
      : { ...currentCrap, status: noVerification, code: crapBaseline.code,
        baseline: { status: noVerification }, exitCode: 2 };
  } else if (requiredControls.includes("crap")) {
    const comparison = initialCrap && initialCrap.status !== noVerification
      ? compareCrap(currentCrap, initialCrap, config.limits.crap)
      : { ...currentCrap, status: noVerification,
        code: currentCrap.status === noVerification ? currentCrap.code : "baseline_quality_incomplete", exitCode: 2 };
    crap = { ...comparison, required: true, executed: true, initialMeasurement: initialCrap, analysis: "task_comparison" };
  }
  const baselineQualityValue = baselineQuality(task);
  const baselineReady = task.initial?.valid === true && (!historical || baselineQualityValue?.status !== noVerification
    && crapBaseline.status !== noVerification);
  const baseline = {
    status: baselineReady ? "approved" : noVerification,
    code: task.initial?.valid !== true ? "baseline_invalid"
      : baselineReady ? "baseline_captured" : "baseline_quality_incomplete",
    initialTests: {
      status: task.initial?.result?.status ?? noVerification,
      code: task.initial?.result?.code ?? "baseline_unknown",
      valid: task.initial?.valid === true,
    },
    checkpoint: task.initial?.inputs?.digest ?? null,
    quality: {
      status: baselineQualityValue?.status ?? noVerification,
      crap: baselineQualityValue?.crap?.identity ?? null,
      dry: baselineQualityValue?.dry?.identity ?? null,
    },
  };
  let mutation;
  if (!requiredControls.includes("mutation")) {
    mutation = taskControl("mutation", false);
  } else if (tests.status === "approved" && evidence.status === "approved"
    && (!historical || dry.status !== noVerification && crap.status !== noVerification)) {
    try {
      const { runPythonMutation } = await import("./python-mutation.js");
      const rawMutation = await runPythonMutation(root, { incremental: true, selection });
      mutation = aggregateMutation(rawMutation, config.limits.mutationScore);
    } catch (error) {
      mutation = { ...controlFailure("mutation", error), required: true, executed: true };
    }
  } else {
    mutation = {
      ...mutationFor("full"),
      code: "mutation_prerequisites_failed",
      message: "No se ejecutó mutación porque falta evidencia funcional o de integridad aprobada",
    };
  }
  if (requiredControls.includes("mutation") && mutation.executed) {
    // Mutation captures its own checkpoint, including on reuse. Join it with
    // the preceding controls and observe the final state before issuing a receipt.
    try {
      const finalConfig = await readConfiguration(path.join(root, ".agentic-core/config.json"));
      const finalInputs = await captureProjectInputs(root, finalConfig.integration.python, selection);
      const finalEnvironment = await currentEnvironment(root, tests, selection);
      const consistency = verificationConsistency({
        inputs: [testCheckpoint.digest, mutation.inputs?.digest, finalInputs.digest],
        configurations: [configHash, mutation.execution?.configurationHash, hash(finalConfig), finalEnvironment.configurationHash],
        identities: [currentEnvironmentValue.executionIdentity, mutation.execution?.executionIdentity, finalEnvironment.executionIdentity],
      });
      if (evidence.status === "approved" && consistency.status !== "approved") evidence = consistency;
      if (finalInputs.issues.length) evidence = { status: noVerification, code: "quality_inputs_changed" };
      if (mutation.execution?.qualityTools !== currentEnvironmentValue.qualityTools
        || ["node", "platform", "arch", "qualityTools"].some((key) => finalEnvironment[key] !== currentEnvironmentValue[key])) {
        evidence = { status: noVerification, code: "quality_conditions_changed" };
      }
      if (historical && dry.status !== noVerification && dry.hashes?.resolutions !== await resolutionHash(root)) {
        evidence = { status: noVerification, code: "dry_resolutions_changed" };
      }
    } catch (error) {
      evidence = controlFailure("evidence", error);
    }
  }
  if (!historical) {
    for (const name of ["dry", "crap"].filter((name) => !requiredControls.includes(name))) reuse[name] = { reused: false,
      reason: requiredControls.includes(name) ? "task_comparison_pending" : "not_requested" };
  }
  reuse.mutation = { reused: mutation.reused === true,
    reason: mutation.reused ? "evidence_current" : mutation.required ? "control_pending" : "not_required" };
  const controls = {
    baseline: controlStatus(baseline),
    evidence: controlStatus(evidence),
    tests: controlStatus(tests),
    dry: controlStatus(dry),
    crap: controlStatus(crap),
    mutation: controlStatus(mutation),
  };
  const status = aggregateStatus({ baseline, evidence, tests, dry, crap, mutation });
  const code = aggregateCode(status, { baseline, evidence, tests, dry, crap, mutation });
  const changes = changedEntries(task.initial?.inputs?.inventory, after.inventory, task.scope ?? []);
  if (configHash !== task.initial?.result?.configurationHash) {
    changes.push({ path: ".agentic-core/config.json", kind: "quality_configuration", change: "modified",
      attribution: "evidence", before: task.initial?.result?.configurationHash ?? null, after: configHash });
  }
  if (hash(tests.effectiveCommand ?? null) !== hash(task.initial?.result?.effectiveCommand ?? null)) {
    changes.push({ path: ".agentic-core/config.json", kind: "runner_configuration", change: "modified",
      attribution: "evidence", before: hash(task.initial?.result?.effectiveCommand ?? null), after: hash(tests.effectiveCommand ?? null) });
  }
  const document = {
    $schema: schema,
    schemaVersion: 1,
    command: "verify",
    ...(!historical ? { request } : {}),
    budget: budgetSummary(),
    task: { id: task.id, mode: task.mode, objective: task.objective, scope: task.scope },
    mode: task.mode,
    scopes: task.scope,
    status,
    code,
    message: !historical && status === "approved" ? "Tests funcionales verificados; los controles no solicitados no se califican"
      : aggregateMessage(status, code, task.mode, mutation),
    baseline,
    freshness: taskFreshness,
    changes: changes.sort((left, right) => compareCodeUnits(left.path, right.path)
      || compareCodeUnits(left.kind ?? "", right.kind ?? "")),
    environment: {
      baseline: initialEnvironment(task),
      verificationStart: startEnvironment,
      current: currentEnvironmentValue,
      status: tests.status === noVerification ? noVerification : "measured",
    },
    evidence: {
      inputs: { baseline: task.initial?.inputs?.digest ?? null, current: after.digest },
      configuration: { baseline: task.initial?.result?.configurationHash ?? null, current: configHash },
      command: { baseline: task.initial?.result?.effectiveCommand ?? null, current: tests.effectiveCommand ?? null },
      versions: {
        python: tests.python ?? null,
        dry: dry.engine ?? null,
        crap: crap.engine ?? null,
      },
      mutation: {
        identity: mutation.evidenceIdentity ?? null,
        selection: mutation.selection?.version ?? null,
        threshold: mutation.score?.threshold ?? config.limits.mutationScore,
      },
    },
    controls,
    reuse,
    tests,
    dry,
    crap,
    mutation,
  };
  let persisted;
  try { persisted = await persistVerification(root, task, document, previous); }
  catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("quality_report_conflict", "No se pudo conservar el veredicto sin afectar evidencia existente", 2);
  }
  const receiptStatus = status === "approved" || status === "NO_APLICA" ? "QUALITY_OK" : "QUALITY_FAILED";
  const receipt = `${receiptStatus} task=${task.id} mode=${task.mode} tests=${tests.status} dry=${dry.status} crap=${crap.status} mutation=${mutation.status} selection=${hash(request)} report=${reference} sha256=${persisted.sha256}`;
  return {
    command: "verify",
    status,
    code,
    exitCode: verificationExit(status, code, [baseline, evidence, tests, dry, crap, mutation]),
    message: document.message,
    task,
    freshness: taskFreshness,
    result: tests,
    verification: document,
    report: persisted.reference,
    sha256: persisted.sha256,
    receipt,
    ...((historical ? ["tests", "dry", "crap"].every((name) => reuse[name].reused) && !mutation.required
      : reuse.tests.reused && requiredControls.length === 0) ? { reused: true } : {}),
  };
}
