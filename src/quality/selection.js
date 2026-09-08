import path from "node:path";
import { IntegrationError } from "./command.js";
import { mandatoryInputExclusion, matchesInput, privateInputContent } from "./project-inputs.js";

const invalid = () => new IntegrationError("invalid_selection",
  "Use --scope y --test repetibles con archivos o carpetas relativos al proyecto, presentes en los inputs permitidos", 4);

export function parseTestSelection(args) {
  const selection = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index] === "--scope" ? "code" : args[index] === "--test" ? "tests" : null;
    if (!key || !args[index + 1] || args[index + 1].startsWith("-")) throw invalid();
    (selection[key] ??= []).push(args[index + 1]);
  }
  return normalizeSelection(selection);
}

export function normalizeSelection(selection = {}) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)
    || Object.keys(selection).some((key) => !["code", "tests"].includes(key))) throw invalid();
  const result = {};
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
