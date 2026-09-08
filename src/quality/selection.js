import path from "node:path";
import { IntegrationError } from "./command.js";
import { mandatoryInputExclusion, matchesInput, privateInputContent } from "./project-inputs.js";

const invalid = () => new IntegrationError("invalid_selection",
  "Use --scope y --test repetibles con archivos o carpetas relativos al proyecto, presentes en los inputs permitidos", 4);

export function parseTestSelection(args) {
  const selection = {};
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === "--changes") {
      if (selection.changes) throw invalid();
      selection.changes = true;
      index -= 1;
      continue;
    }
    const key = args[index] === "--scope" ? "code" : args[index] === "--test" ? "tests" : null;
    if (!key || !args[index + 1] || args[index + 1].startsWith("-")) throw invalid();
    (selection[key] ??= []).push(args[index + 1]);
  }
  return normalizeSelection(selection);
}

export function normalizeSelection(selection = {}) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)
    || Object.keys(selection).some((key) => !["code", "tests", "changes"].includes(key))) throw invalid();
  if (selection.changes !== undefined && selection.changes !== true || selection.changes && selection.code) throw invalid();
  const result = selection.changes ? { changes: true } : {};
  for (const key of ["code", "tests"]) {
    if (selection[key] === undefined) continue;
    if (!Array.isArray(selection[key]) || !selection[key].length) throw invalid();
    result[key] = [...new Set(selection[key].map((value) => {
      if (typeof value !== "string" || !value.trim() || /[\0*?:\[\]]/u.test(value)
        || value.startsWith("-") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
        || value.split(/[\\/]/u).includes("..")) throw invalid();
      const relative = path.posix.normalize(value.replaceAll("\\", "/")).replace(/\/$/u, "") || ".";
      if (mandatoryInputExclusion(relative) || privateInputContent(Buffer.from(relative))) throw invalid();
      return relative;
    }))].sort();
  }
  return Object.keys(result).length ? result : undefined;
}

export function resolveSelection(checkpoint, unit, selection) {
  for (const key of ["code", "tests"]) {
    for (const requested of selection?.[key] ?? []) {
      if (!checkpoint.inventory.some((entry) => matchesInput(entry.path, requested)
        && (key === "code" ? entry.kind === "measured_code" : entry.path.endsWith(".py")))) throw invalid();
    }
  }
  return { code: selection?.code ?? unit.scope, tests: selection?.tests ?? null,
    measuredFiles: checkpoint.inventory.filter((entry) => entry.kind === "measured_code").map((entry) => entry.path),
    testSelection: selection?.tests ? "explicit" : "project_command" };
}

// Resolve against saved bytes, never against Git HEAD or the current tree alone.
export async function resolveTaskSelection(root, requested, task) {
  if (!requested?.changes) return { selection: requested };
  const { readActiveTask } = await import("./task-baseline.js");
  const { readConfiguration } = await import("../installation/install.js");
  const { captureProjectInputs, inputHash } = await import("./project-inputs.js");
  task ??= (await readActiveTask(root))?.task;
  if (!task?.initial?.valid) throw new IntegrationError("baseline_invalid", "--changes requiere un inicio real válido", 2);
  const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
  const current = await captureProjectInputs(root, config.integration.python);
  if (current.issues.length) throw new IntegrationError("current_inputs_incomplete", "No se puede reconstruir el delta con inputs incompletos", 2);
  const initial = new Map(task.initial.inputs.inventory.map((entry) => [entry.path, entry]));
  const now = new Map(current.inventory.map((entry) => [entry.path, entry]));
  const changed = [...new Set([...initial.keys(), ...now.keys()])].sort().filter((file) =>
    initial.get(file)?.sha256 !== now.get(file)?.sha256 || initial.get(file)?.kind !== now.get(file)?.kind);
  const code = changed.filter((file) => now.get(file)?.kind === "measured_code");
  if (!code.length) throw new IntegrationError("delta_without_code",
    "El delta no contiene código medible actual; seleccione --scope y los tests pertinentes explícitamente", 2);
  return { selection: normalizeSelection({ code, ...(requested.tests ? { tests: requested.tests } : {}) }),
    delta: { task: task.id, baseline: inputHash(JSON.stringify(task)), checkpoint: current.digest, changed,
      deleted: changed.filter((file) => !now.has(file)), testSelection: requested.tests ? "explicit" : "project_command" } };
}
