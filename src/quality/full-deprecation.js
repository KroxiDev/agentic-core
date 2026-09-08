import { IntegrationError } from "./command.js";

export const fullDeprecationMessage = "Full está deprecado. Su versión histórica se conserva en KroxiDev/agentic-core, rama archive/full, commit a4c173d0093fe3cc44f095fc09be35662af704ed. La evidencia Full se conserva sin ejecutarla ni convertirla. Para continuar, elige Directo, Light o Normal y una nueva tarea en una instalación sin tarea Full activa.";

export function rejectFull(mode) {
  if (typeof mode === "string" && mode.toLowerCase() === "full") {
    throw new IntegrationError("full_deprecated", fullDeprecationMessage, 4);
  }
}
