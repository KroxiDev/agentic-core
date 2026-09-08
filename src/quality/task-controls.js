import { IntegrationError } from "./command.js";

export const optionalControls = ["dry", "crap", "mutation"];

export function parseControls(values) {
  if (values.some((value) => ![...optionalControls, "none"].includes(value))
    || values.includes("none") && values.length !== 1) {
    throw new IntegrationError("invalid_controls", "Use --control <dry|crap|mutation> repetible, o --control none", 4);
  }
  return optionalControls.filter((name) => values.includes(name));
}

export function taskControl(name, required) {
  return { command: name, required, executed: false,
    status: required ? "NO_VERIFICADO" : "NO_SOLICITADO",
    code: required ? "task_comparison_pending" : "control_not_requested",
    message: required ? "La comparación solicitada se medirá al verificar contra el inicio conservado" : "Control no solicitado",
    exitCode: required ? 2 : 0 };
}
