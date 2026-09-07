import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { distributedRuntime, embeddedRuntimeSource, inspectPersistedRuntime, validateRuntimeOwnership } from "../runtime.js";
import { HOST_RESOURCE_SPECS } from "../runtime-layout.js";
import { hashDirectory, writeTransaction } from "../transaction.js";
import { getVersion } from "../version.js";
import { CONFIG_SCHEMA, InstallationError, defaultConfiguration, validateConfiguration } from "./config.js";
import { PYTHON_TOOLS, inspectTools, installTools, privatePython, resolvePython } from "./python.js";
import { captureProjectInputs, publicCheckpoint } from "../quality/project-inputs.js";

const PRODUCT = "@kroxidev/agentic-core";
const START = "<!-- AGENTIC_CORE_START -->";
const END = "<!-- AGENTIC_CORE_END -->";
const BLOCK = `${START}
## agentic-core

Antes de atender la tarea, lee y aplica \`.agentic-core/golden-rules.md\`.
Esta instalacion integra Codex y una unidad Python 3.11+; consulta su configuracion con
\`node .agentic-core/runtime-launcher.mjs agentic-core doctor\`.

### Seleccion de modo

- Sin \`Orquesta\`, \`/orquestar\` o \`$orquestar\` al comienzo de la solicitud, usa Directo.
  Una mencion posterior o un ejemplo citado no activa la orquestacion.
- Con cualquiera de esos tres activadores al comienzo, reconoce el modo explicito que le sigue:
  Directo, Light, Normal o Full (sin distinguir mayusculas); si se omite el modo, usa Normal.
- Respeta el modo elegido por el usuario durante toda la tarea: no lo cuestiones,
  no recomiendes sustituirlo ni lo cambies ante dificultades.

### Directo

Resuelve el encargo con un unico agente, las Golden Rules y las comprobaciones pertinentes.
Directo no despacha subagentes ni impone baseline, preparacion de calidad, flujo orquestado
o recibo \`QUALITY_OK\`.

Nunca declares un cambio ejecutable orquestado completo sin un \`QUALITY_OK\` vigente de
\`agentic-quality verify\`.

### Light

Light esta habilitado para Codex y ejecuta exactamente Implementador -> Tester.
El coordinador no cuenta como rol base ni modifica produccion. El Tester puede corregir
unicamente tests dentro del alcance; nunca modifica produccion. Un rechazo agrupa las causas,
abre una nueva pareja Implementador -> Tester y consume una ronda adicional compartida.
Se permiten como maximo dos rondas adicionales; al agotarlas la tarea queda pendiente,
sin aprobacion ni cambio automatico de modo.

### Normal y Full

Normal y Full continuan pendientes de integracion en #52 y #53. No se despachan roles
genericos ni se usa el flujo legacy del esquema 2 como sustituto.

${END}`;
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const CONFIG_VERSION = 3;
const QUALITY_DIRECTORY = ".agentic-core/quality";
const CORE_RESOURCE_PATHS = [
  ".agentic-core/config.json",
  ".agentic-core/config.schema.json",
  ".agentic-core/golden-rules.md",
  ".agentic-core/runtime-launcher.mjs",
  ".agentic-core/.gitignore",
];
const LIGHT_RESOURCE_SPECS = [
  { source: "adapters/codex/agents/agentic-production.toml", target: ".codex/agents/agentic-production.toml" },
  { source: "adapters/codex/agents/agentic-tests.toml", target: ".codex/agents/agentic-tests.toml" },
  { source: "skills/orquestar/SKILL.md", target: ".agents/skills/orquestar/SKILL.md" },
  { source: "skills/agentic-tdd/SKILL.md", target: ".agents/skills/agentic-tdd/SKILL.md" },
];
const SCHEMA3_RESOURCE_PATHS = [
  ...CORE_RESOURCE_PATHS,
  ...LIGHT_RESOURCE_SPECS.map(({ target }) => target),
];
const OWNED_DIRECTORIES = [QUALITY_DIRECTORY, ".codex/agents", ".agents/skills/orquestar", ".agents/skills/agentic-tdd"];
const LEGACY_CONFIG_VERSIONS = new Set([1, 2]);
const LEGACY_RESOURCE_PATHS = new Set([
  ...SCHEMA3_RESOURCE_PATHS,
  ".agentic-core/claude-read-command-guard.mjs",
  ...HOST_RESOURCE_SPECS.map(({ target }) => target),
]);
const LEGACY_MANAGED_BLOCK_PATHS = new Set(["AGENTS.md", "CLAUDE.md"]);
const LEGACY_OWNED_DIRECTORY_PATHS = new Set([
  ".agentic-core/runs",
  ".agentic-core/reports",
  ".agentic-core/workers",
  ".agentic-core/transactions",
  QUALITY_DIRECTORY,
  ".agents/skills/orquestar",
  ".agents/skills/agentic-tdd",
  ".agents/skills/agentic-grilling",
  ".claude/skills/orquestar",
  ".claude/skills/agentic-tdd",
  ".claude/skills/agentic-grilling",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function maintenanceError(code, message, exitCode = 4, cause) {
  return new InstallationError(code, message, exitCode, cause === undefined ? undefined : { cause });
}

function safeRelativePath(relative) {
  return typeof relative === "string" && relative.length > 0
    && !path.posix.isAbsolute(relative) && !path.win32.isAbsolute(relative)
    && !/^[a-z]:/iu.test(relative) && !relative.includes("\\") && !relative.includes("\0")
    && !relative.split("/").some((part) => part === "" || part === "." || part === "..");
}

function projectTarget(project, relative, action) {
  if (!safeRelativePath(relative)) {
    throw maintenanceError("invalid_ownership", `No se puede ${action}: la ruta registrada no es segura`);
  }
  return path.join(project, ...relative.split("/"));
}

function unique(items) {
  return [...new Set(items)];
}

function resourceAction(action, relative, extra = {}) {
  return { action, path: relative, ...extra };
}

const plannedAction = resourceAction;

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
  try { return JSON.parse(await readFile(file, "utf8")).configVersion === CONFIG_VERSION; }
  catch { return false; }
}

export async function installationConfigVersion(project) {
  const file = path.join(path.resolve(project), ".agentic-core", "ownership.json");
  if (await kind(file) !== "file") return undefined;
  try { return JSON.parse(await readFile(file, "utf8")).configVersion; }
  catch { return undefined; }
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
    ...LIGHT_RESOURCE_SPECS.map(({ source, target }) => ({
      path: target,
      content: resource(`resources/${source}`),
    })),
  ];
  const exclusive = [...resources.map((file) => file.path), ".agentic-core/runtime", ".agentic-core/tools", ".agentic-core/ownership.json", QUALITY_DIRECTORY];
  const conflicts = [];
  for (const relative of [...exclusive, "AGENTS.md"]) {
    await safeParents(project, relative);
    const type = await kind(path.join(project, relative));
    if (relative === "AGENTS.md" ? !["file", "missing"].includes(type) : type !== "missing") conflicts.push(relative);
  }
  const agentsPath = path.join(project, "AGENTS.md");
  const agentsKind = await kind(agentsPath);
  const previous = agentsKind === "file" ? await readFile(agentsPath) : Buffer.alloc(0);
  if (previous.includes(START) || previous.includes(END)) conflicts.push("AGENTS.md#agentic-core");
  const hostContent = Buffer.concat([previous, Buffer.from(`${previous.length ? "\n\n" : ""}${BLOCK}\n`)]);
  const plan = { command: "init", status: conflicts.length ? "blocked" : "ready", projectRoot: project,
    provider: "codex", languages: ["python"], python, limits: config.limits, tools: PYTHON_TOOLS,
    runtime: runtime.manifest, actions: [...exclusive, "AGENTS.md#agentic-core"], conflicts,
    verification: "NO_VERIFICADO", message: "La instalación no acredita calidad ni modos orquestados; la sintaxis y las herramientas se validan con la versión efectiva" };
  if (options.dryRun) return { ...plan, dryRun: true, exitCode: conflicts.length ? 4 : 0 };
  if (conflicts.length) throw new InstallationError("installation_conflict", `Hay conflictos; conserve los recursos y revise init --dry-run: ${conflicts.join(", ")}`);
  const version = await getVersion();
  const prepared = await prepareTools(project, python, runtime);
  const owner = { schemaVersion: 1, product: PRODUCT, version, configVersion: CONFIG_VERSION, installationId: randomUUID(),
    resources: resources.map((file) => ({ path: file.path, sha256: hash(file.content) })),
    managedBlocks: [{ path: "AGENTS.md", startMarker: START, endMarker: END, sha256: hash(BLOCK) }],
    runtime: runtime.manifest, tools: { path: ".agentic-core/tools", versions: PYTHON_TOOLS, treeSha256: prepared.treeSha256, effective: prepared.effective },
    ownedDirectories: OWNED_DIRECTORIES };
  const toolsOperation = {
    path: path.join(project, owner.tools.path),
    type: "replace_directory",
    sourcePath: prepared.sourcePath,
    sourceSha256: prepared.treeSha256,
    expectedTreeSha256: null,
  };
  const operations = [
    ...resources.map((file) => ({ ...file, path: path.join(project, file.path), expectedContent: null })),
    { path: agentsPath, content: hostContent, expectedContent: agentsKind === "file" ? previous : null },
    { path: path.join(project, runtime.manifest.path), type: "replace_directory", files: runtime.files,
      sourceSha256: runtime.manifest.treeSha256, expectedTreeSha256: null },
    toolsOperation,
    // Serialize after tool preparation so the receipt describes the effective private environment.
    { path: path.join(project, ".agentic-core/ownership.json"), get content() { return json(owner); }, expectedContent: null },
  ];
  try {
    await writeTransaction(project, operations, { failAfterWrite: process.env.NODE_ENV === "test" ? Number(process.env.AGENTIC_CORE_TEST_FAIL_AFTER_WRITE) : undefined });
  } catch (error) {
    if (error instanceof InstallationError) throw error;
    if (error.code === "ERR_RESTORATION_FAILED") {
      throw new InstallationError("restoration_failed", `La restauración quedó incompleta (${error.message}); conserve los recursos y revise el respaldo: ${error.backupPath ?? "no disponible"}`, 5, { cause: error });
    }
    throw new InstallationError("installation_transaction_failed", "La instalación falló; revise la restauración antes de reintentar", 5, { cause: error });
  } finally {
    await rm(prepared.temporaryRoot, { recursive: true, force: true });
  }
  return { ...plan, status: "installed", tools: owner.tools.effective, dryRun: false, exitCode: 0 };
}

function ownershipFailure(message) {
  throw maintenanceError("invalid_ownership", message);
}

function validateOwnershipDocument(owner, action = "actualizar") {
  if (!plainObject(owner) || owner.schemaVersion !== 1 || owner.product !== PRODUCT
    || typeof owner.version !== "string" || owner.version.length === 0
    || typeof owner.installationId !== "string" || owner.installationId.length === 0
    || ![...LEGACY_CONFIG_VERSIONS, CONFIG_VERSION].includes(owner.configVersion)) {
    ownershipFailure(`No se puede ${action}: el manifiesto no pertenece a una instalacion reconocida`);
  }
  if (!Array.isArray(owner.resources) || owner.resources.length === 0) {
    ownershipFailure(`No se puede ${action}: el inventario de recursos no es valido`);
  }
  const resourcePaths = new Set();
  for (const resource of owner.resources) {
    if (!plainObject(resource) || !safeRelativePath(resource.path)
      || !/^[0-9a-f]{64}$/u.test(resource.sha256) || resourcePaths.has(resource.path)
      || (owner.configVersion !== CONFIG_VERSION && !LEGACY_RESOURCE_PATHS.has(resource.path))) {
      ownershipFailure(`No se puede ${action}: el inventario contiene una ruta o hash inseguro`);
    }
    resourcePaths.add(resource.path);
  }
  const originalSchema3 = owner.configVersion === CONFIG_VERSION
    && owner.ownedDirectories === undefined
    && owner.resources.length === CORE_RESOURCE_PATHS.length
    && owner.resources.every((resource, index) => resource.path === CORE_RESOURCE_PATHS[index]);
  if (owner.configVersion === CONFIG_VERSION && !originalSchema3
    && (owner.resources.length !== SCHEMA3_RESOURCE_PATHS.length
      || owner.resources.some((resource, index) => resource.path !== SCHEMA3_RESOURCE_PATHS[index]))) {
    ownershipFailure(`No se puede ${action}: el esquema 3 reclama recursos fuera de sus limites`);
  }
  if (!Array.isArray(owner.managedBlocks) || owner.managedBlocks.length === 0) {
    ownershipFailure(`No se puede ${action}: faltan los limites de bloques gestionados`);
  }
  const blockKeys = new Set();
  for (const block of owner.managedBlocks) {
    if (!plainObject(block) || !safeRelativePath(block.path)
      || typeof block.startMarker !== "string" || typeof block.endMarker !== "string"
      || block.startMarker.length === 0 || block.endMarker.length === 0
      || !/^[0-9a-f]{64}$/u.test(block.sha256) || blockKeys.has(`${block.path}\0${block.startMarker}\0${block.endMarker}`)
      || (owner.configVersion !== CONFIG_VERSION
        && (!LEGACY_MANAGED_BLOCK_PATHS.has(block.path) || block.startMarker !== START || block.endMarker !== END))) {
      ownershipFailure(`No se puede ${action}: los limites de bloques gestionados no son seguros`);
    }
    blockKeys.add(`${block.path}\0${block.startMarker}\0${block.endMarker}`);
  }
  if (owner.configVersion === CONFIG_VERSION) {
    const [block] = owner.managedBlocks;
    if (owner.managedBlocks.length !== 1 || block.path !== "AGENTS.md"
      || block.startMarker !== START || block.endMarker !== END) {
      ownershipFailure(`No se puede ${action}: el esquema 3 solo gestiona el bloque AGENTS.md`);
    }
  }
  if (originalSchema3) owner.ownedDirectories = [];
  if (!Array.isArray(owner.ownedDirectories)) {
    ownershipFailure(`No se puede ${action}: los directorios propios no son validos`);
  }
  const ownedDirectories = new Set();
  for (const directory of owner.ownedDirectories) {
    if (!safeRelativePath(directory) || ownedDirectories.has(directory)
      || (owner.configVersion !== CONFIG_VERSION && !LEGACY_OWNED_DIRECTORY_PATHS.has(directory))) {
      ownershipFailure(`No se puede ${action}: un directorio propio tiene una ruta insegura`);
    }
    ownedDirectories.add(directory);
  }
  if (owner.configVersion === CONFIG_VERSION && !originalSchema3
    && (owner.ownedDirectories.length !== OWNED_DIRECTORIES.length
      || owner.ownedDirectories.some((directory, index) => directory !== OWNED_DIRECTORIES[index]))) {
    ownershipFailure(`No se puede ${action}: el esquema 3 reclama directorios fuera de sus limites`);
  }
  if (owner.runtime !== undefined) {
    try { validateRuntimeOwnership(owner.runtime); }
    catch (error) { ownershipFailure(`No se puede ${action}: el runtime registrado no es valido`); }
  }
  if (owner.configVersion === CONFIG_VERSION) {
    if (!plainObject(owner.runtime) || owner.runtime.path !== ".agentic-core/runtime") {
      ownershipFailure(`No se puede ${action}: falta el runtime autocontenido registrado`);
    }
    if (!plainObject(owner.tools) || owner.tools.path !== ".agentic-core/tools"
      || !plainObject(owner.tools.versions)
      || Object.keys(owner.tools.versions).length !== Object.keys(PYTHON_TOOLS).length
      || Object.entries(PYTHON_TOOLS).some(([name, version]) => owner.tools.versions[name] !== version)
      || !/^[0-9a-f]{64}$/u.test(owner.tools.treeSha256)) {
      ownershipFailure(`No se puede ${action}: falta la prueba de integridad del entorno privado`);
    }
  }
}

async function loadOwnership(projectDirectory, action) {
  const project = path.resolve(projectDirectory);
  if (await kind(project) !== "directory") {
    throw maintenanceError("invalid_project", "El proyecto debe ser un directorio existente y seguro", 4);
  }
  const ownershipPath = projectTarget(project, ".agentic-core/ownership.json", action);
  await safeParents(project, ".agentic-core/ownership.json");
  if (await kind(ownershipPath) !== "file") {
    throw maintenanceError("installation_not_found", `No se encontro un manifiesto para ${action}`, 4);
  }
  let content;
  let owner;
  try {
    content = await readFile(ownershipPath);
    owner = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw maintenanceError("invalid_ownership", `No se pudo leer el manifiesto para ${action}`, 4, error);
  }
  validateOwnershipDocument(owner, action);
  return { project, owner, content, path: ownershipPath };
}

async function inspectState(target) {
  const currentKind = await kind(target);
  if (currentKind === "file") return { kind: currentKind, content: await readFile(target) };
  if (currentKind === "directory") {
    try { return { kind: currentKind, treeSha256: await hashDirectory(target) }; }
    catch (error) { return { kind: "unsafe", error }; }
  }
  return { kind: currentKind };
}

async function safeTreeEntries(root) {
  const entriesFound = [];
  const visit = async (directory, relative = "") => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const logical = relative ? `${relative}/${entry.name}` : entry.name;
      const details = await lstat(child);
      if (details.isSymbolicLink()) throw new Error(`El arbol contiene un enlace: ${logical}`);
      if (details.isDirectory()) {
        entriesFound.push({ kind: "directory", path: logical });
        await visit(child, logical);
      } else if (details.isFile()) entriesFound.push({ kind: "file", path: logical });
      else throw new Error(`El arbol contiene una entrada incompatible: ${logical}`);
    }
  };
  await visit(root);
  return entriesFound;
}

async function runtimeDivergenceSafety(target, runtime) {
  if (runtime.format !== "self-contained-v1" || typeof runtime.manifest !== "string") return false;
  try {
    const manifestPath = path.join(target, ...runtime.manifest.split("/"));
    const persisted = JSON.parse((await readFile(manifestPath, "utf8")));
    const records = persisted.integrity?.files;
    if (persisted.format !== "self-contained-v1" || persisted.product !== PRODUCT
      || persisted.source !== runtime.source || persisted.commit !== runtime.commit
      || !Array.isArray(records) || records.length === 0
      || records.some((file) => !plainObject(file) || !safeRelativePath(file.path)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/u.test(file.sha256))) return false;
    const known = new Set([runtime.manifest, ...records.map((file) => file.path)]);
    if (known.size !== records.length + 1) return false;
    const actual = await safeTreeEntries(target);
    const actualPaths = new Set(actual.map(({ path: relative }) => relative));
    if (!actualPaths.has(runtime.manifest)) return false;
    for (const record of records) {
      if (!actualPaths.has(record.path)) return false;
      const content = await readFile(path.join(target, ...record.path.split("/")));
      if (content.byteLength !== record.bytes || hash(content) !== record.sha256) return false;
    }
    const knownWithParents = new Set(known);
    for (const relative of known) {
      const parts = relative.split("/");
      for (let index = 1; index < parts.length; index += 1) knownWithParents.add(parts.slice(0, index).join("/"));
    }
    return actual.every(({ path: relative }) => knownWithParents.has(relative));
  } catch {
    return false;
  }
}

function expectedFile(state) {
  return state.kind === "file" ? state.content : state.kind === "missing" ? null : undefined;
}

function expectedDirectory(state) {
  return state.kind === "directory" ? state.treeSha256 : state.kind === "missing" ? null : undefined;
}

function managedState(existing, startMarker = START, endMarker = END) {
  const start = Buffer.from(startMarker);
  const end = Buffer.from(endMarker);
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end);
  if (startIndex < 0 && endIndex < 0) return { kind: "missing" };
  const unambiguous = startIndex >= 0 && endIndex >= startIndex + start.length
    && existing.lastIndexOf(start) === startIndex && existing.lastIndexOf(end) === endIndex;
  if (!unambiguous) return { kind: "ambiguous" };
  return { kind: "block", content: existing.subarray(startIndex, endIndex + end.length) };
}

function appendManaged(existing) {
  if (existing.length === 0) return Buffer.from(`${BLOCK}\n`);
  const separator = existing.at(-1) === 0x0a ? "\n" : "\n\n";
  return Buffer.concat([existing, Buffer.from(`${separator}${BLOCK}\n`)]);
}

function replaceManaged(existing, startMarker = START, endMarker = END) {
  const found = managedState(existing, startMarker, endMarker);
  if (found.kind !== "block") return undefined;
  const startIndex = existing.indexOf(Buffer.from(startMarker));
  const endIndex = existing.indexOf(Buffer.from(endMarker), startIndex + startMarker.length);
  return Buffer.concat([existing.subarray(0, startIndex), Buffer.from(BLOCK), existing.subarray(endIndex + endMarker.length)]);
}

function removeManaged(existing, startMarker = START, endMarker = END) {
  const found = managedState(existing, startMarker, endMarker);
  if (found.kind !== "block") return undefined;
  const startIndex = existing.indexOf(Buffer.from(startMarker));
  const endIndex = existing.indexOf(Buffer.from(endMarker), startIndex + startMarker.length);
  return Buffer.concat([existing.subarray(0, startIndex), existing.subarray(endIndex + endMarker.length)]);
}

function resourceFromRuntime(runtime, source) {
  const file = runtime.files.find(({ path: relative }) => relative === source);
  if (!file) throw maintenanceError("invalid_runtime", `El runtime no contiene el recurso ${source}`, 2);
  return file.content;
}

function currentResources(runtime, configContent) {
  return [
    { path: CORE_RESOURCE_PATHS[0], content: Buffer.from(configContent) },
    { path: CORE_RESOURCE_PATHS[1], content: json(CONFIG_SCHEMA) },
    { path: CORE_RESOURCE_PATHS[2], content: resourceFromRuntime(runtime, "resources/golden-rules.md") },
    { path: CORE_RESOURCE_PATHS[3], content: resourceFromRuntime(runtime, "resources/src/runtime-launcher.mjs") },
    { path: CORE_RESOURCE_PATHS[4], content: Buffer.from("/quality/\n/tools/\n") },
    ...LIGHT_RESOURCE_SPECS.map(({ source, target }) => ({
      path: target,
      content: resourceFromRuntime(runtime, `resources/${source}`),
    })),
  ];
}

function transactionOptions() {
  const requested = process.env.NODE_ENV === "test"
    ? Number.parseInt(process.env.AGENTIC_CORE_TEST_FAIL_AFTER_WRITE ?? "", 10)
    : Number.NaN;
  return { failAfterWrite: Number.isSafeInteger(requested) && requested > 0 ? requested : undefined };
}

async function applyMaintenanceTransaction(project, operations) {
  if (operations.length === 0) return;
  try {
    await writeTransaction(project, operations, transactionOptions());
  } catch (error) {
    if (error instanceof InstallationError) throw error;
    if (error.code === "ERR_TRANSACTION_CONFLICT") {
      throw maintenanceError("transaction_conflict", "El proyecto cambio durante la operacion; se preservo el estado nuevo", 5, error);
    }
    if (error.code === "ERR_RESTORATION_FAILED") {
      throw maintenanceError("restoration_failed", `La restauracion quedo incompleta; conserve el respaldo ${error.backupPath ?? "indicado por el error"}`, 5, error);
    }
    throw maintenanceError("maintenance_transaction_failed", "La operacion fallo y debe revisarse su restauracion antes de reintentar", 5, error);
  }
}

async function currentRuntime(options = {}) {
  try {
    if (options.runtimeSource !== undefined) return options.runtimeSource;
    if (process.env.NODE_ENV === "test" && process.env.AGENTIC_CORE_TEST_RUNTIME_ROOT) {
      const { discoverRuntimeSource } = await import("../runtime.js");
      return await discoverRuntimeSource();
    }
    return await embeddedRuntimeSource() ?? await distributedRuntime();
  } catch (error) {
    throw maintenanceError("invalid_runtime", "El runtime distribuido falta o no cumple origen, inventario e integridad", 2, error);
  }
}

async function prepareTools(project, python, runtime) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agentic-core-tools-"));
  try {
    const wheelRoot = path.join(temporaryRoot, "wheels");
    const stagingRoot = path.join(temporaryRoot, "tools");
    const { mkdir, writeFile: writeTemporaryFile } = await import("node:fs/promises");
    await mkdir(wheelRoot, { recursive: true });
    for (const [name, version] of Object.entries(PYTHON_TOOLS)) {
      const file = runtime.files.find(({ path: relative }) => relative === `third_party/python/${name}-${version}-py3-none-any.whl`);
      if (!file) throw maintenanceError("invalid_runtime", `Falta el wheel privado ${name}-${version}`, 2);
      await writeTemporaryFile(path.join(wheelRoot, `${name}-${version}-py3-none-any.whl`), file.content, { flag: "wx" });
    }
    const effective = await installTools(stagingRoot, python.executable, wheelRoot);
    const treeSha256 = await hashDirectory(stagingRoot);
    return {
      temporaryRoot,
      sourcePath: stagingRoot,
      treeSha256,
      effective: { ...effective, executable: privatePython(path.join(project, ".agentic-core/tools")) },
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (error instanceof InstallationError) throw error;
    throw maintenanceError("tool_environment_failed", "No se pudo preparar el entorno privado de herramientas", 2, error);
  }
}

async function retireState(project) {
  const paths = [".agentic-core/runs", ".agentic-core/reports", ".agentic-core/workers", ".agentic-core/transactions"];
  const state = [];
  for (const relative of paths) {
    const currentKind = await kind(projectTarget(project, relative, "inspeccionar"));
    if (currentKind !== "missing") state.push({ path: relative, kind: currentKind });
  }
  return state;
}

function ownerForSchema3({ version, installationId, resources, runtime, tools }) {
  return {
    schemaVersion: 1,
    product: PRODUCT,
    version,
    configVersion: CONFIG_VERSION,
    installationId,
    resources: resources.map(({ path: relative, content }) => ({ path: relative, sha256: hash(content) })),
    managedBlocks: [{ path: "AGENTS.md", startMarker: START, endMarker: END, sha256: hash(Buffer.from(BLOCK)) }],
    runtime: runtime.manifest,
    tools: { path: ".agentic-core/tools", versions: PYTHON_TOOLS, ...tools },
    ownedDirectories: OWNED_DIRECTORIES,
  };
}

function maintenancePlan({ project, command, options, status, actions, manifest, divergences, preserved, error, runtime }) {
  return {
    schemaVersion: 1,
    command,
    dryRun: true,
    projectRoot: project,
    status,
    options,
    actions,
    divergences: unique(divergences),
    preserved: unique(preserved),
    manifest,
    runtime: runtime.manifest,
    ...(error ? { error } : {}),
  };
}

async function readConfigForMaintenance(project, action) {
  const configPath = projectTarget(project, ".agentic-core/config.json", action);
  if (await kind(configPath) !== "file") {
    throw maintenanceError("invalid_configuration", `No se encontro una configuracion valida para ${action}`);
  }
  const content = await readFile(configPath);
  let config;
  try { config = JSON.parse(content.toString("utf8")); }
  catch (error) { throw maintenanceError("invalid_configuration", "La configuracion JSON no es valida", 4, error); }
  validateConfiguration(config);
  return { content, config };
}

function addFileOperation(operations, actions, project, relative, state, content, action) {
  if (state.kind === "file" && state.content.equals(content)) return false;
  const expectedContent = expectedFile(state);
  if (expectedContent === undefined) return false;
  operations.push({ path: projectTarget(project, relative, "actualizar"), content, expectedContent });
  actions.push(plannedAction(action, relative, { sha256: hash(content) }));
  return true;
}

function addDirectoryOperation(operations, actions, project, relative, state, runtime, action) {
  const expectedTreeSha256 = expectedDirectory(state);
  if (expectedTreeSha256 === undefined) return false;
  operations.push({
    path: projectTarget(project, relative, "actualizar"),
    type: "replace_directory",
    files: runtime.files,
    sourceSha256: runtime.manifest.treeSha256,
    expectedTreeSha256,
  });
  actions.push(plannedAction(action, relative, {
    source: runtime.manifest.source,
    treeSha256: runtime.manifest.treeSha256,
  }));
  return true;
}

function addToolDirectoryOperation(operations, actions, project, relative, state, prepared) {
  const expectedTreeSha256 = expectedDirectory(state);
  if (expectedTreeSha256 === undefined) return false;
  operations.push({
    path: projectTarget(project, relative, "actualizar"),
    type: "replace_directory",
    sourcePath: prepared.sourcePath,
    sourceSha256: prepared.treeSha256,
    expectedTreeSha256,
  });
  actions.push(plannedAction("persist_tools", relative, { treeSha256: prepared.treeSha256 }));
  return true;
}

function forceRequired(relative) {
  return {
    code: "force_required",
    message: `El recurso propio ${relative} diverge; repita con --force para reemplazarlo de forma explicita`,
  };
}

function unsafeResource(relative) {
  return {
    code: "unsafe_resource",
    message: `El recurso ${relative} no tiene un tipo o una integridad segura; se conserva y no se reemplaza`,
  };
}

async function updateCurrentInstallation(projectDirectory, options = {}) {
  const loaded = await loadOwnership(projectDirectory, "actualizar");
  const { project, owner, content: previousManifest } = loaded;
  if (owner.configVersion !== CONFIG_VERSION) return migrateLegacyInstallation(loaded, options);

  const { content: configContent, config } = await readConfigForMaintenance(project, "actualizar");
  const python = await resolvePython(project, config.integration.python.interpreter);
  const runtime = await currentRuntime(options);
  const resources = currentResources(runtime, configContent);
  const recordedResources = new Map(owner.resources.map((resource) => [resource.path, resource]));
  const operations = [];
  const actions = [];
  const divergences = [];
  const preserved = await retireState(project);
  const blockers = [];

  for (const resource of resources) {
    const target = projectTarget(project, resource.path, "actualizar");
    const state = await inspectState(target);
    if (resource.path === ".agentic-core/config.json") {
      if (state.kind === "missing") addFileOperation(operations, actions, project, resource.path, state, resource.content, "write_resource");
      else if (state.kind !== "file") blockers.push(unsafeResource(resource.path));
      continue;
    }
    const recorded = recordedResources.get(resource.path);
    if (recorded === undefined) {
      if (state.kind !== "missing") blockers.push({
        code: "unowned_resource",
        message: `Existe un recurso sin ownership demostrado en ${resource.path}; se conserva`,
      });
      else addFileOperation(operations, actions, project, resource.path, state, resource.content, "write_resource");
      continue;
    }
    if (state.kind === "missing") {
      addFileOperation(operations, actions, project, resource.path, state, resource.content, "write_resource");
    } else if (state.kind === "file") {
      if (state.content.equals(resource.content)) continue;
      divergences.push(resource.path);
      if (hash(state.content) === recorded.sha256 || options.force) {
        addFileOperation(operations, actions, project, resource.path, state, resource.content, "write_resource");
      } else blockers.push(forceRequired(resource.path));
    } else {
      blockers.push(unsafeResource(resource.path));
    }
  }

  const block = owner.managedBlocks[0];
  const agentsPath = projectTarget(project, block.path, "actualizar");
  const agentsState = await inspectState(agentsPath);
  let agentsContent;
  if (agentsState.kind === "missing") {
    agentsContent = appendManaged(Buffer.alloc(0));
  } else if (agentsState.kind !== "file") {
    blockers.push(unsafeResource(block.path));
  } else {
    const found = managedState(agentsState.content, block.startMarker, block.endMarker);
    if (found.kind === "ambiguous") {
      blockers.push({ code: "ambiguous_managed_block", message: `El bloque gestionado de ${block.path} es ambiguo y se conserva` });
    } else if (found.kind === "missing") {
      if (agentsState.content.length === 0) agentsContent = appendManaged(agentsState.content);
      else {
        divergences.push(`${block.path}#agentic-core`);
        if (options.force) agentsContent = appendManaged(agentsState.content);
        else blockers.push(forceRequired(`${block.path}#agentic-core`));
      }
    } else if (found.content.equals(Buffer.from(BLOCK))) {
      agentsContent = agentsState.content;
    } else {
      divergences.push(`${block.path}#agentic-core`);
      if (hash(found.content) === block.sha256 || options.force) agentsContent = replaceManaged(agentsState.content, block.startMarker, block.endMarker);
      else blockers.push(forceRequired(`${block.path}#agentic-core`));
    }
  }
  if (agentsContent !== undefined) {
    addFileOperation(operations, actions, project, block.path, agentsState, agentsContent,
      agentsState.kind === "missing" || managedState(agentsState.content ?? Buffer.alloc(0), block.startMarker, block.endMarker).kind === "missing"
        ? "append_managed_block" : "replace_managed_block");
  }

  const runtimeRelative = owner.runtime.path;
  const runtimeState = await inspectState(projectTarget(project, runtimeRelative, "actualizar"));
  if (runtimeState.kind === "missing") {
    addDirectoryOperation(operations, actions, project, runtimeRelative, runtimeState, runtime, "persist_runtime");
  } else if (runtimeState.kind !== "directory") {
    blockers.push(unsafeResource(runtimeRelative));
  } else if (runtimeState.treeSha256 !== owner.runtime.treeSha256) {
    divergences.push(runtimeRelative);
    if (await runtimeDivergenceSafety(projectTarget(project, runtimeRelative, "actualizar"), owner.runtime)) {
      if (options.force) addDirectoryOperation(operations, actions, project, runtimeRelative, runtimeState, runtime, "persist_runtime");
      else blockers.push(forceRequired(runtimeRelative));
    } else blockers.push({
      code: "foreign_state",
      message: `El runtime ${runtimeRelative} contiene estado no reconocido; se conserva incluso con --force`,
    });
  } else if (runtimeState.treeSha256 !== runtime.manifest.treeSha256) {
    addDirectoryOperation(operations, actions, project, runtimeRelative, runtimeState, runtime, "persist_runtime");
  }

  const toolsRelative = owner.tools.path;
  const toolsState = await inspectState(projectTarget(project, toolsRelative, "actualizar"));
  let toolsNeedReplacement = false;
  if (toolsState.kind === "missing") toolsNeedReplacement = true;
  else if (toolsState.kind === "directory") {
    if (toolsState.treeSha256 !== owner.tools.treeSha256) {
      divergences.push(toolsRelative);
      blockers.push({
        code: "foreign_state",
        message: `El entorno ${toolsRelative} contiene estado divergente; se conserva incluso con --force`,
      });
    }
  } else blockers.push(unsafeResource(toolsRelative));

  let prepared;
  const unsafeBlocker = blockers.some(({ code }) => ["unsafe_resource", "unowned_resource", "foreign_state"].includes(code));
  if (toolsNeedReplacement && !unsafeBlocker) {
    prepared = await prepareTools(project, python, runtime);
    addToolDirectoryOperation(operations, actions, project, toolsRelative, toolsState, prepared);
  }

  const tools = prepared
    ? { treeSha256: prepared.treeSha256, effective: prepared.effective }
    : { treeSha256: owner.tools.treeSha256, ...(owner.tools.effective ? { effective: {
      ...owner.tools.effective, executable: privatePython(projectTarget(project, toolsRelative, "actualizar")),
    } } : {}) };
  const version = await getVersion();
  const manifest = ownerForSchema3({ version, installationId: owner.installationId, resources, runtime, tools });
  const manifestContent = json(manifest);
  if (!previousManifest.equals(manifestContent)) {
    operations.push({ path: loaded.path, content: manifestContent, expectedContent: previousManifest });
    actions.push(plannedAction("write_manifest", ".agentic-core/ownership.json", { sha256: hash(manifestContent) }));
  }
  const firstBlocker = blockers[0];
  const plan = maintenancePlan({
    project,
    command: "update",
    options: { force: Boolean(options.force) },
    status: firstBlocker ? "blocked" : "ready",
    actions,
    manifest,
    divergences,
    preserved: preserved.map(({ path: relative, kind: stateKind }) => `legacy state: ${relative} (${stateKind})`),
    error: firstBlocker,
    runtime,
  });
  const result = {
    command: "update",
    projectRoot: project,
    version,
    python,
    limits: config.limits,
    runtime: runtime.manifest,
    divergences: unique(divergences),
    preserved: plan.preserved,
    plan,
  };
  try {
    if (options.dryRun) return { ...result, status: firstBlocker ? "blocked" : "ready", dryRun: true, exitCode: firstBlocker ? 4 : 0 };
    if (firstBlocker) throw maintenanceError(firstBlocker.code, firstBlocker.message, 4);
    await applyMaintenanceTransaction(project, operations);
    return { ...result, status: "updated", dryRun: false, exitCode: 0 };
  } finally {
    if (prepared) await rm(prepared.temporaryRoot, { recursive: true, force: true });
  }
}

export async function updatePythonProject(projectDirectory, options = {}) {
  return updateCurrentInstallation(projectDirectory, options);
}

function migrateLegacyConfiguration(value, python) {
  if (!plainObject(value)) throw maintenanceError("invalid_configuration", "La configuracion legacy no es un objeto");
  const allowed = ["$schema", "schemaVersion", "orchestration", "coordination", "quality"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw maintenanceError("unknown_configuration_key", `Clave desconocida en la configuracion legacy: ${unknown.join(", ")}`);
  if (![1, 2].includes(value.schemaVersion)) {
    throw maintenanceError("invalid_configuration", "La version de la configuracion legacy no coincide con el manifiesto");
  }
  if (value.$schema !== undefined && value.$schema !== "./config.schema.json") {
    throw maintenanceError("invalid_configuration", "La referencia de esquema legacy no es reconocida");
  }
  if (value.orchestration !== undefined && value.coordination !== undefined) {
    throw maintenanceError("configuration_conflict", "La configuracion mezcla orchestration y coordination; resuelva el estado ambiguo antes de migrar");
  }
  const mode = value.orchestration ?? value.coordination;
  if (mode !== undefined) {
    if (!plainObject(mode)) throw maintenanceError("invalid_configuration", "La seleccion de modo legacy no es valida");
    const allowedModeKeys = value.orchestration === undefined
      ? ["explicitActivationOnly", "defaultMode"]
      : ["explicitActivationOnly", "defaultMode", "briefMaxBytes", "handoffMaxBytes"];
    const modeUnknown = Object.keys(mode).filter((key) => !allowedModeKeys.includes(key));
    if (modeUnknown.length > 0) throw maintenanceError("unknown_configuration_key", `Clave desconocida en la configuracion de modo: ${modeUnknown.join(", ")}`);
    if (mode.explicitActivationOnly !== undefined && mode.explicitActivationOnly !== true) {
      throw maintenanceError("invalid_configuration", "La activacion explicita legacy no puede deshabilitarse");
    }
    if (mode.defaultMode !== undefined && mode.defaultMode !== "normal") {
      throw maintenanceError("invalid_configuration", "El modo legacy debe ser normal");
    }
    for (const key of ["briefMaxBytes", "handoffMaxBytes"]) {
      if (mode[key] !== undefined && (!Number.isInteger(mode[key]) || mode[key] < 0)) {
        throw maintenanceError("invalid_configuration", `El limite legacy ${key} no es valido`);
      }
    }
  }
  const quality = value.quality ?? {};
  if (!plainObject(quality)) throw maintenanceError("invalid_configuration", "La configuracion quality legacy no es valida");
  const qualityUnknown = Object.keys(quality).filter((key) => !["crapThreshold", "mutationWorkers"].includes(key));
  if (qualityUnknown.length > 0) throw maintenanceError("unknown_configuration_key", `Clave desconocida en quality legacy: ${qualityUnknown.join(", ")}`);
  if (quality.crapThreshold !== undefined
    && (typeof quality.crapThreshold !== "number" || !Number.isFinite(quality.crapThreshold) || quality.crapThreshold < 0)) {
    throw maintenanceError("invalid_configuration", "crapThreshold debe ser un numero no negativo");
  }
  if (quality.mutationWorkers !== undefined
    && (!Number.isInteger(quality.mutationWorkers) || quality.mutationWorkers < 1 || quality.mutationWorkers > 4)) {
    throw maintenanceError("invalid_configuration", "mutationWorkers debe ser un entero entre 1 y 4");
  }
  const config = defaultConfiguration(python.executable);
  config.limits.crap = quality.crapThreshold ?? config.limits.crap;
  config.limits.operation.workers = quality.mutationWorkers ?? config.limits.operation.workers;
  validateConfiguration(config);
  return { config, content: json(config) };
}

async function migrateLegacyInstallation(loaded, options = {}) {
  const { project, owner, content: previousManifest } = loaded;
  const oldConfigPath = projectTarget(project, ".agentic-core/config.json", "migrar");
  if (await kind(oldConfigPath) !== "file") throw maintenanceError("invalid_configuration", "La configuracion legacy no existe como archivo");
  let oldConfig;
  try { oldConfig = JSON.parse((await readFile(oldConfigPath)).toString("utf8")); }
  catch (error) { throw maintenanceError("invalid_configuration", "La configuracion legacy no es JSON valido", 4, error); }
  const python = await resolvePython(project);
  const migrated = migrateLegacyConfiguration(oldConfig, python);
  const runtime = await currentRuntime(options);
  const resources = currentResources(runtime, migrated.content);
  const recordedResources = new Map(owner.resources.map((resource) => [resource.path, resource]));
  const operations = [];
  const actions = [];
  const divergences = [];
  const preserved = [];
  const blockers = [];

  for (const resource of resources) {
    const state = await inspectState(projectTarget(project, resource.path, "migrar"));
    if (resource.path === ".agentic-core/config.json") {
      if (state.kind === "file") addFileOperation(operations, actions, project, resource.path, state, resource.content, "write_resource");
      else if (state.kind === "missing") addFileOperation(operations, actions, project, resource.path, state, resource.content, "write_resource");
      else blockers.push(unsafeResource(resource.path));
      continue;
    }
    const recorded = recordedResources.get(resource.path);
    if (state.kind === "missing") {
      addFileOperation(operations, actions, project, resource.path, state, resource.content, "write_resource");
    } else if (state.kind === "file") {
      if (state.content.equals(resource.content)) continue;
      if (recorded === undefined) {
        blockers.push({ code: "unowned_resource", message: `Existe un recurso sin ownership demostrado en ${resource.path}; se conserva` });
      } else if (hash(state.content) === recorded.sha256 || options.force) {
        addFileOperation(operations, actions, project, resource.path, state, resource.content, "write_resource");
      } else {
        divergences.push(resource.path);
        blockers.push(forceRequired(resource.path));
      }
    } else blockers.push(unsafeResource(resource.path));
  }

  const currentResourcePaths = new Set(resources.map(({ path: relative }) => relative));
  for (const recorded of owner.resources) {
    if (currentResourcePaths.has(recorded.path)) continue;
    const target = projectTarget(project, recorded.path, "migrar");
    const state = await inspectState(target);
    if (state.kind === "missing") continue;
    if (state.kind === "file" && hash(state.content) === recorded.sha256) {
      operations.push({ path: target, type: "delete", expectedContent: state.content });
      actions.push(plannedAction("remove_retired_resource", recorded.path));
    } else {
      preserved.push(`legacy resource: ${recorded.path}`);
      divergences.push(recorded.path);
    }
  }

  for (const block of owner.managedBlocks) {
    const target = projectTarget(project, block.path, "migrar");
    const state = await inspectState(target);
    if (state.kind === "missing") {
      if (block.path === "AGENTS.md") addFileOperation(operations, actions, project, block.path, state, appendManaged(Buffer.alloc(0)), "append_managed_block");
      continue;
    }
    if (state.kind !== "file") {
      preserved.push(`legacy managed block: ${block.path}`);
      if (block.path === "AGENTS.md") blockers.push(unsafeResource(block.path));
      continue;
    }
    const found = managedState(state.content, block.startMarker, block.endMarker);
    if (found.kind === "ambiguous") {
      preserved.push(`legacy managed block: ${block.path}`);
      if (block.path === "AGENTS.md") blockers.push({
        code: "ambiguous_managed_block",
        message: `El bloque gestionado de ${block.path} es ambiguo y se conserva`,
      });
      continue;
    }
    if (block.path === "AGENTS.md") {
      if (found.kind === "missing") {
        addFileOperation(operations, actions, project, block.path, state, appendManaged(state.content), "append_managed_block");
        continue;
      }
      const replacement = replaceManaged(state.content, block.startMarker, block.endMarker);
      if (replacement && !state.content.equals(replacement)) {
        if (hash(found.content) === block.sha256 || options.force) {
          addFileOperation(operations, actions, project, block.path, state, replacement, "replace_managed_block");
        } else {
          divergences.push(`${block.path}#agentic-core`);
          blockers.push(forceRequired(`${block.path}#agentic-core`));
        }
      }
    } else if (found.kind === "block" && hash(found.content) === block.sha256) {
      const replacement = removeManaged(state.content, block.startMarker, block.endMarker);
      if (replacement !== undefined) {
        operations.push({ path: target, content: replacement, expectedContent: state.content });
        actions.push(plannedAction("remove_managed_block", `${block.path}#${block.id ?? "agentic-core"}`));
      }
    } else preserved.push(`legacy managed block: ${block.path}`);
  }

  const runtimeRelative = ".agentic-core/runtime";
  const runtimeTarget = projectTarget(project, runtimeRelative, "migrar");
  const runtimeState = await inspectState(runtimeTarget);
  if (runtimeState.kind === "missing") {
    addDirectoryOperation(operations, actions, project, runtimeRelative, runtimeState, runtime, "persist_runtime");
  } else if (runtimeState.kind !== "directory") {
    blockers.push(unsafeResource(runtimeRelative));
  } else if (owner.runtime === undefined) {
    blockers.push({ code: "unowned_resource", message: "Existe un runtime legacy sin ownership demostrable; se conserva" });
  } else if (runtimeState.treeSha256 === owner.runtime.treeSha256) {
    if (runtimeState.treeSha256 !== runtime.manifest.treeSha256) {
      addDirectoryOperation(operations, actions, project, runtimeRelative, runtimeState, runtime, "persist_runtime");
    }
  } else {
    divergences.push(runtimeRelative);
    if (await runtimeDivergenceSafety(runtimeTarget, owner.runtime)) {
      if (options.force) addDirectoryOperation(operations, actions, project, runtimeRelative, runtimeState, runtime, "persist_runtime");
      else blockers.push(forceRequired(runtimeRelative));
    } else blockers.push({
      code: "foreign_state",
      message: `El runtime ${runtimeRelative} contiene estado no reconocido; se conserva incluso con --force`,
    });
  }

  const toolsRelative = ".agentic-core/tools";
  const toolsTarget = projectTarget(project, toolsRelative, "migrar");
  const toolsState = await inspectState(toolsTarget);
  let preparePrivateTools = false;
  if (toolsState.kind === "missing") preparePrivateTools = true;
  else if (toolsState.kind === "directory") blockers.push({
    code: "unowned_resource",
    message: "Existe un entorno privado sin ownership demostrable; se conserva",
  });
  else blockers.push(unsafeResource(toolsRelative));

  let prepared;
  if (preparePrivateTools) {
    prepared = await prepareTools(project, python, runtime);
    addToolDirectoryOperation(operations, actions, project, toolsRelative, toolsState, prepared);
  }
  const tools = prepared
    ? { treeSha256: prepared.treeSha256, effective: prepared.effective }
    : owner.tools && owner.tools.treeSha256 ? { treeSha256: owner.tools.treeSha256, ...(owner.tools.effective ? { effective: owner.tools.effective } : {}) } : { treeSha256: "0".repeat(64) };
  for (const state of await retireState(project)) preserved.push(`legacy state: ${state.path} (${state.kind})`);
  const version = await getVersion();
  const manifest = ownerForSchema3({ version, installationId: owner.installationId, resources, runtime, tools });
  const manifestContent = json(manifest);
  if (!previousManifest.equals(manifestContent)) {
    operations.push({ path: loaded.path, content: manifestContent, expectedContent: previousManifest });
    actions.push(plannedAction("write_manifest", ".agentic-core/ownership.json", { sha256: hash(manifestContent) }));
  }
  const firstBlocker = blockers[0];
  const plan = maintenancePlan({
    project,
    command: "update",
    options: { force: Boolean(options.force), migration: true },
    status: firstBlocker ? "blocked" : "ready",
    actions,
    manifest,
    divergences,
    preserved,
    error: firstBlocker,
    runtime,
  });
  const result = {
    command: "update",
    projectRoot: project,
    version,
    python,
    limits: migrated.config.limits,
    runtime: runtime.manifest,
    divergences: unique(divergences),
    preserved: unique(preserved),
    plan,
  };
  try {
    if (options.dryRun) return { ...result, status: firstBlocker ? "blocked" : "ready", dryRun: true, exitCode: firstBlocker ? 4 : 0 };
    if (firstBlocker) throw maintenanceError(firstBlocker.code, firstBlocker.message, 4);
    await applyMaintenanceTransaction(project, operations);
    return { ...result, status: "updated", dryRun: false, exitCode: 0 };
  } finally {
    if (prepared) await rm(prepared.temporaryRoot, { recursive: true, force: true });
  }
}

async function uninstallCurrentInstallation(projectDirectory, options = {}) {
  const loaded = await loadOwnership(projectDirectory, "desinstalar");
  const { project, owner, content: previousManifest } = loaded;
  if (owner.configVersion !== CONFIG_VERSION) {
    throw maintenanceError("legacy_maintenance", "La desinstalacion legacy debe ejecutarse con el mantenedor de esquema 2", 2);
  }
  const operations = [];
  const actions = [];
  const preserved = [];
  for (const resource of owner.resources) {
    const target = projectTarget(project, resource.path, "desinstalar");
    const state = await inspectState(target);
    if (state.kind === "missing") continue;
    if (state.kind === "file" && hash(state.content) === resource.sha256) {
      operations.push({ path: target, type: "delete", expectedContent: state.content });
      actions.push(`resource: ${resource.path}`);
    } else preserved.push(`divergent resource: ${resource.path}`);
  }

  for (const block of owner.managedBlocks) {
    const target = projectTarget(project, block.path, "desinstalar");
    const state = await inspectState(target);
    if (state.kind === "missing") continue;
    if (state.kind !== "file") {
      preserved.push(`divergent managed block: ${block.path}`);
      continue;
    }
    const found = managedState(state.content, block.startMarker, block.endMarker);
    if (found.kind !== "block" || hash(found.content) !== block.sha256) {
      preserved.push(`divergent managed block: ${block.path}#agentic-core`);
      continue;
    }
    const replacement = removeManaged(state.content, block.startMarker, block.endMarker);
    if (replacement === undefined) {
      preserved.push(`divergent managed block: ${block.path}#agentic-core`);
      continue;
    }
    operations.push({ path: target, content: replacement, expectedContent: state.content });
    actions.push(`managed block: ${block.path}#agentic-core`);
  }

  for (const relative of [owner.runtime.path, owner.tools.path]) {
    const target = projectTarget(project, relative, "desinstalar");
    const state = await inspectState(target);
    const expectedHash = relative === owner.runtime.path ? owner.runtime.treeSha256 : owner.tools.treeSha256;
    if (state.kind === "missing") continue;
    if (state.kind === "directory" && state.treeSha256 === expectedHash) {
      operations.push({ path: target, type: "delete", expectedTreeSha256: state.treeSha256 });
      actions.push(`${relative === owner.runtime.path ? "runtime" : "owned directory"}: ${relative}`);
    } else preserved.push(`divergent ${relative === owner.runtime.path ? "runtime" : "tools"}: ${relative}`);
  }

  for (const relative of owner.ownedDirectories) {
    const target = projectTarget(project, relative, "desinstalar");
    const currentKind = await kind(target);
    if (currentKind === "missing") continue;
    if (currentKind !== "directory") {
      preserved.push(`unexpected path: ${relative}`);
      continue;
    }
    let entries;
    try { entries = await readdir(target); }
    catch (error) { preserved.push(`owned directory: ${relative}`); continue; }
    if (entries.length !== 0) {
      preserved.push(`owned directory with user state: ${relative}`);
      continue;
    }
    const state = await inspectState(target);
    if (state.kind === "directory") {
      operations.push({ path: target, type: "delete", expectedTreeSha256: state.treeSha256 });
      actions.push(`owned directory: ${relative}`);
    } else preserved.push(`owned directory: ${relative}`);
  }
  for (const state of await retireState(project)) preserved.push(`legacy state: ${state.path} (${state.kind})`);

  operations.push({ path: loaded.path, type: "delete", expectedContent: previousManifest });
  actions.push("manifest: .agentic-core/ownership.json");
  const result = {
    command: "uninstall",
    projectRoot: project,
    options: { force: Boolean(options.force) },
    actions,
    preserved: unique(preserved),
    dryRun: Boolean(options.dryRun),
    exitCode: 0,
  };
  if (!options.dryRun) {
    await applyMaintenanceTransaction(project, operations);
    try { await rmdir(path.join(project, ".agentic-core")); }
    catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw maintenanceError("maintenance_cleanup_failed", "No se pudo retirar el directorio vacio de la instalacion", 5, error);
    }
  }
  return result;
}

export async function uninstallPythonProject(projectDirectory, options = {}) {
  return uninstallCurrentInstallation(projectDirectory, options);
}

function diagnosticCheck(id, status, message, remediation) {
  return { id, status, message, ...(remediation ? { remediation } : {}) };
}

export async function diagnosePythonProject(projectDirectory, options = {}) {
  const loaded = await loadOwnership(projectDirectory, "diagnosticar");
  const { project, owner } = loaded;
  if (owner.configVersion !== CONFIG_VERSION) {
    throw maintenanceError("legacy_maintenance", "El diagnostico legacy debe ejecutarse con el mantenedor de esquema 2", 2);
  }
  const checks = [];
  let config;
  try {
    ({ config } = await readConfigForMaintenance(project, "diagnosticar"));
    checks.push(diagnosticCheck("configuration.file", "ok", "La configuracion cumple el esquema cerrado y sus limites"));
  } catch (error) {
    checks.push(diagnosticCheck("configuration.file", "error", error.message, "Corregir config.json o repetir update --dry-run"));
  }

  const recordedResources = new Map(owner.resources.map((resource) => [resource.path, resource]));
  for (const relative of SCHEMA3_RESOURCE_PATHS.filter((resourcePath) => resourcePath !== ".agentic-core/config.json")) {
    const target = projectTarget(project, relative, "diagnosticar");
    const state = await inspectState(target);
    const recorded = recordedResources.get(relative);
    if (state.kind === "file" && recorded && hash(state.content) === recorded.sha256) {
      checks.push(diagnosticCheck(`resource.${relative}`, "ok", "Recurso propio presente con el hash registrado"));
    } else if (state.kind === "file") {
      checks.push(diagnosticCheck(`resource.${relative}`, "error", "El recurso propio diverge de su inventario", "Repetir update --force despues de revisar la divergencia"));
    } else {
      checks.push(diagnosticCheck(`resource.${relative}`, "error", "Falta el recurso propio o no tiene un tipo seguro", "Repetir update --dry-run y restaurar el recurso"));
    }
  }

  const block = owner.managedBlocks[0];
  const agentsTarget = projectTarget(project, block.path, "diagnosticar");
  const agentsState = await inspectState(agentsTarget);
  if (agentsState.kind === "file") {
    const found = managedState(agentsState.content, block.startMarker, block.endMarker);
    if (found.kind === "block" && found.content.equals(Buffer.from(BLOCK))) {
      checks.push(diagnosticCheck("managed.AGENTS.md", "ok", "El bloque gestionado es unico e integro"));
    } else checks.push(diagnosticCheck("managed.AGENTS.md", "error", "El bloque gestionado falta, diverge o es ambiguo", "Revisar AGENTS.md y repetir update --dry-run"));
  } else checks.push(diagnosticCheck("managed.AGENTS.md", "error", "AGENTS.md no es un archivo seguro", "Restaurar el archivo host sin borrar su contenido ajeno"));

  const runtimeTarget = projectTarget(project, owner.runtime.path, "diagnosticar");
  const runtimeState = await inspectState(runtimeTarget);
  if (runtimeState.kind === "directory" && runtimeState.treeSha256 === owner.runtime.treeSha256) {
    try {
      await inspectPersistedRuntime(runtimeTarget, owner.runtime, owner.version);
      checks.push(diagnosticCheck("runtime.integrity", "ok", "El runtime persistido coincide con su origen, inventario e integridad"));
    } catch (error) {
      checks.push(diagnosticCheck("runtime.integrity", "error", "El runtime persistido no cumple su manifiesto", "Repetir update --force solo despues de revisar la instalacion"));
    }
  } else checks.push(diagnosticCheck("runtime.integrity", "error", "El runtime falta o diverge de su hash de ownership", "Repetir update --dry-run y autorizar el reemplazo si corresponde"));

  const toolsTarget = projectTarget(project, owner.tools.path, "diagnosticar");
  const toolsState = await inspectState(toolsTarget);
  let tools;
  if (toolsState.kind === "directory" && toolsState.treeSha256 === owner.tools.treeSha256) {
    try {
      tools = await inspectTools(toolsTarget);
      checks.push(diagnosticCheck("tools.integrity", "ok", "El entorno privado coincide con su hash y versiones efectivas"));
    } catch (error) {
      checks.push(diagnosticCheck("tools.integrity", "error", "Las herramientas privadas faltan o son incompatibles", "Repetir update --force o reinstalar el runtime"));
    }
  } else checks.push(diagnosticCheck("tools.integrity", "error", "El entorno privado falta o diverge de su hash de ownership", "Repetir update --dry-run y autorizar el reemplazo si corresponde"));

  let python;
  let inputs;
  if (config) {
    try {
      python = await resolvePython(project, config.integration.python.interpreter);
      const checkpoint = await captureProjectInputs(project, config.integration.python);
      inputs = publicCheckpoint(checkpoint);
      checks.push(diagnosticCheck("python.environment", "ok", "El interprete Python seleccionado esta disponible"));
    } catch (error) {
      checks.push(diagnosticCheck("python.environment", "error", error.message, "Configurar Python 3.11+ con --python o AGENTIC_CORE_PYTHON"));
    }
  }
  const legacy = await retireState(project);
  for (const state of legacy) checks.push(diagnosticCheck(`legacy.${state.path}`, "info", "Estado legacy preservado y no interpretado"));

  const problems = checks.filter(({ status }) => ["error", "blocked"].includes(status));
  const ok = checks.filter(({ status }) => status === "ok");
  const repairable = problems.filter(({ remediation }) => remediation).length;
  const status = problems.length === 0 ? "healthy" : "unhealthy";
  const report = {
    command: "doctor",
    projectRoot: project,
    status,
    diagnosis: { status, summary: { ok: ok.length, problems: problems.length, repairable }, checks },
    repair: {
      requested: false,
      dryRun: Boolean(options.dryRun),
      status: problems.length === 0 ? "not_needed" : "blocked",
      actions: [],
    },
  };
  return {
    command: "doctor",
    status,
    projectRoot: project,
    provider: "codex",
    languages: ["python"],
    python: python ? { ...python, executable: "[Python del proyecto]" } : { executable: "[Python no disponible]", version: [] },
    tools: tools ? { ...tools, executable: "[Python privado de herramientas]" } : { executable: "[Python privado no disponible]", version: [] },
    integration: config ? {
      interpreter: "[Python del proyecto]",
      runner: config.integration.python.runner,
      command: { argumentCount: config.integration.python.command.args.length },
      environmentCount: Object.keys(config.integration.python.environment).length,
      inputs,
    } : undefined,
    limits: config?.limits,
    runtime: owner.runtime,
    verification: "NO_VERIFICADO",
    message: problems.length === 0
      ? "Configuracion, recursos propios, runtime y herramientas identificados. No se ejecutaron pruebas del proyecto"
      : "El diagnostico encontro problemas; la instalacion no se presenta como satisfactoria",
    report,
    dryRun: Boolean(options.dryRun),
    exitCode: problems.length === 0 ? 0 : 2,
  };
}

export async function diagnoseLegacyPythonProject(projectDirectory) {
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
