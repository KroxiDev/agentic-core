import { createInterface } from "node:readline/promises";
import { formatMaintenanceResult } from "../cli-output.js";
import { InstallationError } from "./config.js";
import {
  diagnosePythonProject,
  installationConfigVersion,
  installPythonProject,
  uninstallPythonProject,
  updatePythonProject,
} from "./install.js";

const HELP = `Uso:
  agentic-core init [directorio] [--provider <proveedor>] [--language <lenguaje>] [--python <intérprete>] [--config <archivo>] [--dry-run]
  agentic-core doctor [directorio] [--dry-run]
  agentic-core update [directorio] [--force] [--dry-run]
  agentic-core uninstall [directorio] [--force] [--dry-run]
  agentic-core --version

Sin proveedor y lenguaje explicitos, init pregunta en una terminal interactiva.
Solo se admite Codex con una unidad Python y pytest. AGENTIC_CORE_PYTHON tiene prioridad sobre --python y la configuracion.
El entorno de herramientas es privado y requiere Python 3.11 o superior.
Update migra configuraciones legacy al esquema 3 y conserva recursos divergentes, estado legacy y contenido ajeno.
--force autoriza el reemplazo de recursos propios divergentes durante update; uninstall siempre conserva divergencias.
Use AGENTIC_CORE_OUTPUT=json para salida estructurada.
Para explicar configuración y vigencia sin ejecutar pruebas: node .agentic-core/runtime-launcher.mjs agentic-quality explain [--json].
Codigos: 0 operacion satisfactoria; 2 entorno no soportado; 4 uso o configuracion invalidos; 5 fallo interno o de restauracion.`;

function parse(args, command) {
  const valued = command === "init" ? new Set(["--provider", "--language", "--python", "--config"]) : new Set();
  const flags = command === "init"
    ? new Set(["--dry-run"])
    : command === "update" || command === "uninstall"
      ? new Set(["--dry-run", "--force"])
      : new Set(["--dry-run"]);
  const options = {};
  let directory;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) {
      if (directory !== undefined) throw new InstallationError("invalid_usage", "Solo se admite un directorio y una unidad Python");
      directory = arg;
      continue;
    }
    const key = arg === "--dry-run" ? "dryRun" : arg.slice(2);
    if (Object.hasOwn(options, key)) throw new InstallationError("invalid_usage", `Opción repetida: ${arg}`);
    if (flags.has(arg)) options[key] = true;
    else if (valued.has(arg) && args[index + 1] && !args[index + 1].startsWith("-")) options[key] = args[++index];
    else throw new InstallationError("invalid_usage", `Opción desconocida o sin valor: ${arg}`);
  }
  return { directory: directory ?? process.cwd(), options };
}

function outputInstall(io, result) {
  if (process.env.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    io.stdout.write(`${result.dryRun ? "PLAN (sin escrituras)" : "INSTALACIÓN COMPLETADA"}: Codex / Python ${result.python.version.join(".")}\n`);
    io.stdout.write(`${result.message}\n`);
    io.stdout.write(`Límites: C.R.A.P. ${result.limits.crap}; mutación ${result.limits.mutationScore} %.\n`);
    if (result.dryRun) io.stdout.write(`Recursos: ${result.actions.join(", ")}\nConflictos: ${result.conflicts.join(", ") || "ninguno"}\n`);
    else io.stdout.write("Herramientas: dry4python 0.1.0; crap4py 0.1.1; mutate4py 0.1.4; coverage.py 7.13.4.\n");
  }
}

function outputMaintenance(io, command, result) {
  const outputMode = io?.env?.AGENTIC_CORE_OUTPUT ?? process.env.AGENTIC_CORE_OUTPUT;
  if (outputMode === "json" || (command === "update" && result.dryRun)) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else io.stdout.write(formatMaintenanceResult(command, result));
}

export async function runInstallationCli(args, io = process) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  const command = args[0];
  if (!["init", "doctor", "update", "uninstall"].includes(command)) return undefined;

  let existingVersion;
  if (command !== "init") {
    const candidate = args.slice(1).find((arg) => !arg.startsWith("-")) ?? process.cwd();
    existingVersion = await installationConfigVersion(candidate);
    const supported = existingVersion === 3 || (command === "update" && [1, 2].includes(existingVersion));
    if (!supported) return undefined;
  }

  try {
    const { directory, options } = parse(args.slice(1), command);
    if (command === "init" && !options.config && (!options.provider || !options.language)) {
      if (!io.stdin?.isTTY || !io.stdout?.isTTY) {
        throw new InstallationError("selection_required", "Indique --provider codex --language python o use una terminal interactiva", 4);
      }
      const prompt = createInterface({ input: io.stdin, output: io.stdout });
      try {
        options.provider ??= (await prompt.question("Proveedor (solo codex disponible): ")).trim().toLowerCase();
        options.language ??= (await prompt.question("Lenguaje (solo python; una unidad): ")).trim().toLowerCase();
      } finally { prompt.close(); }
      if (!options.provider || !options.language) throw new InstallationError("selection_required", "Debe seleccionar proveedor y lenguaje");
    }
    if (command === "init") {
      const result = await installPythonProject(directory, options);
      outputInstall(io, result);
      return result.exitCode;
    }
    const result = command === "update"
      ? await updatePythonProject(directory, options)
      : command === "uninstall"
        ? await uninstallPythonProject(directory, options)
        : await diagnosePythonProject(directory, options);
    outputMaintenance(io, command, result);
    return result.exitCode;
  } catch (error) {
    if (!(error instanceof InstallationError)) {
      io.stderr.write("internal_error: no se pudo completar la operacion de instalacion o mantenimiento\n");
      return 5;
    }
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return error.exitCode;
  }
}
