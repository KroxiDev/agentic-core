import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { distributedRuntime, inspectPersistedRuntime } from "../runtime.js";
import { hashDirectory, writeTransaction } from "../transaction.js";
import { getVersion } from "../version.js";
import { CONFIG_SCHEMA, InstallationError, defaultConfiguration, validateConfiguration } from "./config.js";
import { PYTHON_TOOLS, inspectTools, installTools, resolvePython } from "./python.js";
import { captureProjectInputs, publicCheckpoint } from "../quality/project-inputs.js";

const PRODUCT = "@kroxidev/agentic-core";
const START = "<!-- AGENTIC_CORE_START -->";
const END = "<!-- AGENTIC_CORE_END -->";
const BLOCK = `${START}
## agentic-core

Antes de atender la tarea, lee y aplica \`.agentic-core/golden-rules.md\`.
Esta instalación integra Codex y una unidad Python 3.11+; consulta su configuración con
\`node .agentic-core/runtime-launcher.mjs agentic-core doctor\`.

### Selección de modo

- Sin \`Orquesta\`, \`/orquestar\` o \`$orquestar\` al comienzo de la solicitud, usa Directo.
  Una mención posterior o un ejemplo citado no activa la orquestación.
- Con cualquiera de esos tres activadores al comienzo, reconoce el modo explícito que le sigue:
  Directo, Light, Normal o Full (sin distinguir mayúsculas); si se omite el modo, usa Normal.
- Respeta el modo elegido por el usuario durante toda la tarea: no lo cuestiones,
  no recomiendes sustituirlo ni lo cambies ante dificultades.

### Directo

Resuelve el encargo con un único agente, las Golden Rules y las comprobaciones pertinentes
de la tarea. Directo no despacha subagentes ni impone baseline, preparación de calidad,
flujo orquestado o recibo \`QUALITY_OK\`. Informa el resultado y las verificaciones realmente
ejecutadas; identifica cualquier comprobación pendiente sin inventar un aprobado.

Una petición ordinaria de documentación también se resuelve en Directo. La ausencia de
Documentador no agrega trabajo documental a otro encargo; puedes recomendarlo en el cierre
si corresponde y el usuario decide. Documentador requiere petición expresa y, en un flujo
orquestado, es siempre el último subagente, después del trabajo técnico y sus correcciones.

### Light, Normal y Full

Conserva el modo seleccionado e informa que su secuencia y verificación están pendientes
de integración en #51 (Light), #52 (Normal) y #53 (Full). Esta entrega no las ejecuta ni
las presenta como validadas: no despaches roles genéricos, no uses el flujo legacy del
esquema 2 ni prepares calidad para suplirlas. La integración continuará en esta superficie
nativa de Codex, sin otro proveedor ni un protocolo externo de coordinación.
${END}`;
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hash = (value) => createHash("sha256").update(value).digest("hex");

export async function kind(target) {
  try {
    const info = await lstat(target);
    return info.isSymbolicLink() ? "link" : info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
  } catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
}

async function safeParents(project, relative) {
  let current = project;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    if (!["missing", "directory"].includes(await kind(current))) {
      throw new InstallationError("unsafe_path", "Un destino de instalación tiene un padre incompatible o un enlace", 4);
    }
  }
}

export async function readConfiguration(file) {
  try { return validateConfiguration(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if (error instanceof InstallationError) throw error;
    throw new InstallationError("invalid_configuration", "No se pudo leer la configuración JSON; revise el archivo indicado", 4);
  }
}

export async function isPythonInstallation(project) {
  const file = path.join(project, ".agentic-core", "ownership.json");
  if (await kind(file) !== "file") return false;
  try { return JSON.parse(await readFile(file, "utf8")).configVersion === 3; }
  catch { return false; }
}

export async function installPythonProject(projectDirectory, options = {}) {
  const project = path.resolve(projectDirectory);
  if (await kind(project) !== "directory") throw new InstallationError("invalid_project", "El proyecto debe ser un directorio existente y sin enlaces");
  if ((options.provider && options.provider !== "codex") || (options.language && options.language !== "python")) {
    throw new InstallationError("unsupported_integration", "Esta entrega solo admite Codex y una única unidad Python", 2);
  }
  let config = options.config ? await readConfiguration(path.resolve(options.config)) : undefined;
  const python = await resolvePython(project, options.python || config?.integration.python.interpreter);
  config ??= defaultConfiguration(python.executable);
  if (config.integration.python.command.executable === config.integration.python.interpreter) {
    config.integration.python.command.executable = python.executable;
  }
  config.integration.python.interpreter = python.executable;
  validateConfiguration(config);
  let runtime;
  try { runtime = await distributedRuntime(); }
  catch (error) { throw new InstallationError("invalid_runtime", "El runtime distribuido falta o no cumple su contrato de origen, inventario e integridad; reconstruya o reinstale el paquete", 2, { cause: error }); }
  const runtimeRelative = path.relative(project, runtime.root);
  if (runtimeRelative === "" || (!runtimeRelative.startsWith("..") && !path.isAbsolute(runtimeRelative))) {
    // A package under node_modules is a valid bootstrap; the persisted destination must be disjoint.
    const destination = path.join(project, ".agentic-core", "runtime");
    if (runtime.root === destination || runtime.root.startsWith(`${destination}${path.sep}`)) {
      throw new InstallationError("runtime_overlap", "El origen del runtime coincide con su destino");
    }
  }
  const resource = (name) => {
    const found = runtime.files.find((file) => file.path === name);
    if (!found) throw new InstallationError("invalid_runtime", "El payload carece de un recurso obligatorio", 2);
    return found.content;
  };
  const resources = [
    { path: ".agentic-core/config.json", content: json(config) },
    { path: ".agentic-core/config.schema.json", content: json(CONFIG_SCHEMA) },
    { path: ".agentic-core/golden-rules.md", content: resource("resources/golden-rules.md") },
    { path: ".agentic-core/runtime-launcher.mjs", content: resource("resources/src/runtime-launcher.mjs") },
    { path: ".agentic-core/.gitignore", content: Buffer.from("/quality/\n/tools/\n") },
  ];
  const exclusive = [...resources.map((file) => file.path), ".agentic-core/runtime", ".agentic-core/tools", ".agentic-core/ownership.json"];
  const conflicts = [];
  for (const relative of [...exclusive, "AGENTS.md"]) {
    await safeParents(project, relative);
    const type = await kind(path.join(project, relative));
    if (relative === "AGENTS.md" ? !["file", "missing"].includes(type) : type !== "missing") conflicts.push(relative);
  }
  const agentsPath = path.join(project, "AGENTS.md");
  const previous = await kind(agentsPath) === "file" ? await readFile(agentsPath) : Buffer.alloc(0);
  if (previous.includes(START) || previous.includes(END)) conflicts.push("AGENTS.md#agentic-core");
  const hostContent = Buffer.concat([previous, Buffer.from(`${previous.length ? "\n\n" : ""}${BLOCK}\n`)]);
  const plan = { command: "init", status: conflicts.length ? "blocked" : "ready", projectRoot: project,
    provider: "codex", languages: ["python"], python, limits: config.limits, tools: PYTHON_TOOLS,
    runtime: runtime.manifest, actions: [...exclusive, "AGENTS.md#agentic-core"], conflicts,
    verification: "NO_VERIFICADO", message: "La instalación no acredita calidad ni modos orquestados; la sintaxis y las herramientas se validan con la versión efectiva" };
  if (options.dryRun) return { ...plan, dryRun: true, exitCode: conflicts.length ? 4 : 0 };
  if (conflicts.length) throw new InstallationError("installation_conflict", `Hay conflictos; conserve los recursos y revise init --dry-run: ${conflicts.join(", ")}`);
  const version = await getVersion();
  const owner = { schemaVersion: 1, product: PRODUCT, version, configVersion: 3, installationId: randomUUID(),
    resources: resources.map((file) => ({ path: file.path, sha256: hash(file.content) })),
    managedBlocks: [{ path: "AGENTS.md", startMarker: START, endMarker: END, sha256: hash(BLOCK) }],
    runtime: runtime.manifest, tools: { path: ".agentic-core/tools", versions: PYTHON_TOOLS } };
  const operations = [
    ...resources.map((file) => ({ ...file, path: path.join(project, file.path) })),
    { path: agentsPath, content: hostContent },
    { path: path.join(project, runtime.manifest.path), type: "replace_directory", files: runtime.files, sourceSha256: runtime.manifest.treeSha256 },
    { path: path.join(project, owner.tools.path), type: "create_directory", prepare: async (target) => {
      owner.tools.effective = await installTools(target, python.executable, path.join(project, runtime.manifest.path, "third_party/python"));
      owner.tools.treeSha256 = await hashDirectory(target);
    } },
    // Serialize after tool preparation so the receipt describes the effective private environment.
    { path: path.join(project, ".agentic-core/ownership.json"), get content() { return json(owner); } },
  ];
  try {
    await writeTransaction(project, operations, { failAfterWrite: process.env.NODE_ENV === "test" ? Number(process.env.AGENTIC_CORE_TEST_FAIL_AFTER_WRITE) : undefined });
  } catch (error) {
    if (error instanceof InstallationError) throw error;
    if (error.code === "ERR_RESTORATION_FAILED") {
      throw new InstallationError("restoration_failed", `La restauración quedó incompleta; conserve los recursos y revise el respaldo: ${error.backupPath ?? "no disponible"}`, 5, { cause: error });
    }
    throw new InstallationError("installation_transaction_failed", "La instalación falló; revise la restauración antes de reintentar", 5, { cause: error });
  }
  return { ...plan, status: "installed", tools: owner.tools.effective, dryRun: false, exitCode: 0 };
}

export async function diagnosePythonProject(projectDirectory) {
  const project = path.resolve(projectDirectory);
  await safeParents(project, ".agentic-core/ownership.json");
  const config = await readConfiguration(path.join(project, ".agentic-core/config.json"));
  const owner = JSON.parse(await readFile(path.join(project, ".agentic-core/ownership.json"), "utf8"));
  if (owner.product !== PRODUCT || owner.configVersion !== 3 || owner.tools?.path !== ".agentic-core/tools") {
    throw new InstallationError("invalid_ownership", "El inventario de instalación no es válido", 4);
  }
  const python = await resolvePython(project, config.integration.python.interpreter);
  try {
    await inspectPersistedRuntime(path.join(project, ".agentic-core/runtime"), owner.runtime, owner.version);
    if (await kind(path.join(project, owner.tools.path)) !== "directory"
      || await hashDirectory(path.join(project, owner.tools.path)) !== owner.tools.treeSha256) throw new Error("tools integrity");
  } catch (error) { throw new InstallationError("installation_integrity", "El runtime o el entorno privado diverge de su inventario; revise los recursos de esta instalación", 2, { cause: error }); }
  const tools = await inspectTools(path.join(project, owner.tools.path));
  const unit = config.integration.python;
  const checkpoint = await captureProjectInputs(project, unit);
  return { command: "doctor", status: "installed", provider: "codex", languages: ["python"],
    python: { ...python, executable: "[Python del proyecto]" }, tools: { ...tools, executable: "[Python privado de herramientas]" },
    integration: { interpreter: "[Python del proyecto]", runner: unit.runner,
      command: { argumentCount: unit.command.args.length }, environmentCount: Object.keys(unit.environment).length,
      inputs: publicCheckpoint(checkpoint) },
    limits: config.limits, runtime: owner.runtime, verification: "NO_VERIFICADO",
    message: "Configuración válida y versiones efectivas identificadas. No se ejecutaron pruebas del proyecto. La compatibilidad de sintaxis y la calidad requieren sus verificaciones pendientes", exitCode: 0 };
}
