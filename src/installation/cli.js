import { createInterface } from "node:readline/promises";
import { InstallationError } from "./config.js";
import { diagnosePythonProject, installPythonProject, isPythonInstallation } from "./install.js";

const HELP = `Uso:
  agentic-core init [directorio] [--provider <proveedor>] [--language <lenguaje>] [--python <intérprete>] [--config <archivo>] [--dry-run]
  agentic-core doctor [directorio] [--repair] [--dry-run]
  agentic-core update [directorio] [--force] [--dry-run]
  agentic-core uninstall [directorio] [--force] [--dry-run]
  agentic-core --version

Sin proveedor y lenguaje explícitos, init pregunta en una terminal interactiva.
Solo se admite una unidad Python y pytest. AGENTIC_CORE_PYTHON tiene prioridad sobre --python y la configuración.
El entorno de herramientas es privado y requiere Python 3.11 o superior.
La migración y el mantenimiento del esquema 3 están pendientes de #57.
--repair y --force solo están disponibles para el mantenimiento del esquema 2.
Use AGENTIC_CORE_OUTPUT=json para salida estructurada.
Códigos: 0 instalación o diagnóstico satisfactorio; 2 entorno no soportado; 4 uso o configuración inválidos; 5 fallo interno o de restauración.`;

function parse(args, command) {
  const valued = command === "init" ? new Set(["--provider", "--language", "--python", "--config"]) : new Set();
  const options = {};
  let directory;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) {
      if (directory !== undefined) throw new InstallationError("invalid_usage", "Solo se admite un directorio y una unidad Python");
      directory = arg;
    } else {
      const key = arg === "--dry-run" ? "dryRun" : arg.slice(2);
      if (Object.hasOwn(options, key)) throw new InstallationError("invalid_usage", `Opción repetida: ${arg}`);
      if (arg === "--dry-run") options[key] = true;
      else if (valued.has(arg) && args[index + 1] && !args[index + 1].startsWith("-")) options[key] = args[++index];
      else throw new InstallationError("invalid_usage", `Opción desconocida o sin valor: ${arg}`);
    }
  }
  return { directory: directory ?? process.cwd(), options };
}

function output(io, result) {
  if (process.env.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    io.stdout.write(`${result.dryRun ? "PLAN (sin escrituras)" : result.command === "doctor" ? "DIAGNÓSTICO" : "INSTALACIÓN COMPLETADA"}: Codex / Python ${result.python.version.join(".")}\n`);
    io.stdout.write(`${result.message}\n`);
    io.stdout.write(`Límites: C.R.A.P. ${result.limits.crap}; mutación ${result.limits.mutationScore} %.\n`);
    if (result.dryRun) io.stdout.write(`Recursos: ${result.actions.join(", ")}\nConflictos: ${result.conflicts.join(", ") || "ninguno"}\n`);
    else io.stdout.write("Herramientas: dry4python 0.1.0; crap4py 0.1.1; mutate4py 0.1.4; coverage.py 7.13.4.\n");
  }
}

export async function runInstallationCli(args, io = process) {
  if (!args.length || args.includes("--help") || args.includes("-h")) { io.stdout.write(`${HELP}\n`); return 0; }
  const command = args[0];
  if (!["init", "doctor", "update", "uninstall"].includes(command)) return undefined;
  // Existing installations retain their maintenance implementation until the migration ticket.
  if (command !== "init") {
    const candidate = args.slice(1).find((arg) => !arg.startsWith("-")) ?? process.cwd();
    if (!await isPythonInstallation(candidate)) return undefined;
  }
  try {
    const { directory, options } = parse(args.slice(1), command);
    if (command === "update" || command === "uninstall") {
      throw new InstallationError("maintenance_pending", "El mantenimiento del esquema 3 se entrega en #57; se conservaron los recursos", 2);
    }
    if (command === "init" && !options.config && (!options.provider || !options.language)) {
      if (!io.stdin?.isTTY || !io.stdout?.isTTY) {
        throw new InstallationError("selection_required", "Indique --provider codex --language python o use una terminal interactiva");
      }
      const prompt = createInterface({ input: io.stdin, output: io.stdout });
      try {
        options.provider ??= (await prompt.question("Proveedor (solo codex disponible): ")).trim().toLowerCase();
        options.language ??= (await prompt.question("Lenguaje (solo python; una unidad): ")).trim().toLowerCase();
      } finally { prompt.close(); }
      if (!options.provider || !options.language) throw new InstallationError("selection_required", "Debe seleccionar proveedor y lenguaje");
    }
    const result = command === "init" ? await installPythonProject(directory, options) : await diagnosePythonProject(directory);
    output(io, result);
    return result.exitCode;
  } catch (error) {
    if (!(error instanceof InstallationError)) {
      io.stderr.write("internal_error: no se pudo completar la operación de instalación o diagnóstico\n");
      return 5;
    }
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.exitCode;
  }
}
