import { createHash } from "node:crypto";
import { lstat, readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { discoverRuntimeSource, inspectPersistedRuntime, validateRuntimeOwnership } from "./runtime.js";
import { HOST_RESOURCE_SPECS } from "./runtime-layout.js";
import { writeTransaction } from "./transaction.js";
import { getVersion } from "./version.js";

const PRODUCT = "@kroxidev/agentic-core";
const CONFIG_VERSION = 2;
const QUALITY_IGNORE_PATH = ".agentic-core/.gitignore";
const PRE_QUALITY_IGNORE_CORE_RESOURCE_PATHS = [
  ".agentic-core/config.json",
  ".agentic-core/config.schema.json",
  ".agentic-core/golden-rules.md",
];
const CORE_RESOURCE_PATHS = [QUALITY_IGNORE_PATH, ...PRE_QUALITY_IGNORE_CORE_RESOURCE_PATHS];
const EXPECTED_RESOURCE_PATHS = [...CORE_RESOURCE_PATHS, ...HOST_RESOURCE_SPECS.map(({ target }) => target)];
const PRE_QUALITY_IGNORE_EXPECTED_RESOURCE_PATHS = [
  ...PRE_QUALITY_IGNORE_CORE_RESOURCE_PATHS,
  ...HOST_RESOURCE_SPECS.map(({ target }) => target),
];
const LEGACY_EXPECTED_RESOURCE_PATHS = [
  ...PRE_QUALITY_IGNORE_CORE_RESOURCE_PATHS,
  ".agentic-core/claude-read-command-guard.mjs",
  ...HOST_RESOURCE_SPECS.map(({ target }) => target),
];
const EARLY_LEGACY_EXPECTED_RESOURCE_PATHS = LEGACY_EXPECTED_RESOURCE_PATHS
  .filter((resourcePath) => resourcePath !== ".agentic-core/runtime-launcher.mjs");
const OWNED_DIRECTORIES = [
  ".agentic-core/quality",
  ".agents/skills/orquestar",
  ".agents/skills/agentic-tdd",
  ".agents/skills/agentic-grilling",
  ".claude/skills/orquestar",
  ".claude/skills/agentic-tdd",
  ".claude/skills/agentic-grilling",
];
const LEGACY_OWNED_DIRECTORIES = [
  ".agentic-core/runs",
  ".agentic-core/reports",
  ".agentic-core/workers",
  ".agentic-core/transactions",
  ...OWNED_DIRECTORIES.slice(1),
];
const MANAGED_BLOCK = `<!-- AGENTIC_CORE_START -->
## agentic-core

Follow the canonical policy in \`.agentic-core/golden-rules.md\`.

If a request begins with \`Orquesta\`, \`/orquestar\`, or \`$orquestar\`, load and follow \`.agents/skills/orquestar/SKILL.md\`. \`Orquesta\` without a mode means \`normal\`.

Never declare an orchestrated executable change complete without a current \`QUALITY_OK\` receipt from \`agentic-quality verify\`.

Requests without one of those activators run directly.
<!-- AGENTIC_CORE_END -->`;

const CONFIG = {
  $schema: "./config.schema.json",
  schemaVersion: CONFIG_VERSION,
  coordination: {
    explicitActivationOnly: true,
    defaultMode: "normal",
  },
  quality: {
    crapThreshold: 7,
    mutationWorkers: 4,
  },
};

const CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kroxidev.dev/agentic-core/config.schema.json",
  title: "agentic-core configuration",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "schemaVersion", "coordination", "quality"],
  properties: {
    $schema: { const: "./config.schema.json" },
    schemaVersion: { const: CONFIG_VERSION },
    coordination: {
      type: "object",
      additionalProperties: false,
      required: ["explicitActivationOnly", "defaultMode"],
      properties: {
        explicitActivationOnly: { const: true },
        defaultMode: { const: "normal" },
      },
    },
    quality: {
      type: "object",
      additionalProperties: false,
      required: ["crapThreshold", "mutationWorkers"],
      properties: {
        crapThreshold: { type: "number", minimum: 0, default: 7 },
        mutationWorkers: { type: "integer", minimum: 1, maximum: 4, default: 4 },
      },
    },
  },
};

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function containsPath(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function assertRuntimePersistenceBoundary(runtime, runtimePath) {
  if (!runtime) return;
  validateRuntimeOwnership(runtime.manifest);
  if (typeof runtime.root !== "string" || runtime.root.length === 0) {
    throw new Error("The ephemeral runtime source path is invalid");
  }
  if (containsPath(runtime.root, runtimePath) || containsPath(runtimePath, runtime.root)) {
    throw new Error("The ephemeral runtime source and destination overlap");
  }
}

function deterministicInstallationId(projectRoot, version, resources) {
  const digest = sha256(Buffer.from(JSON.stringify({
    product: PRODUCT,
    projectRoot,
    version,
    resources: resources.map(({ path: resourcePath, content }) => ({
      path: resourcePath,
      sha256: sha256(content),
    })),
  })));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function installationResources(config) {
  const bundled = typeof __AGENTIC_CORE_BUNDLED_RUNTIME__ === "boolean" && __AGENTIC_CORE_BUNDLED_RUNTIME__;
  const packagedResource = (source) => new URL(`${bundled ? "./resources/" : "../"}${source}`, import.meta.url);
  const hostResources = await Promise.all(HOST_RESOURCE_SPECS.map(async ({ source, target }) => ({
    path: target,
    content: await readFile(packagedResource(source)),
  })));
  return [
    { path: QUALITY_IGNORE_PATH, content: Buffer.from("/quality/\n") },
    { path: ".agentic-core/config.json", content: config },
    { path: ".agentic-core/config.schema.json", content: Buffer.from(json(CONFIG_SCHEMA)) },
    { path: ".agentic-core/golden-rules.md", content: await readFile(packagedResource("golden-rules.md")) },
    ...hostResources,
  ];
}

async function fileKind(filePath) {
  try {
    const details = await lstat(filePath);
    if (details.isFile()) return "file";
    if (details.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

export function appendManagedBlock(existing) {
  if (existing.length === 0) return Buffer.from(`${MANAGED_BLOCK}\n`);
  const separator = existing.at(-1) === 0x0a ? "\n" : "\n\n";
  return Buffer.concat([existing, Buffer.from(`${separator}${MANAGED_BLOCK}\n`)]);
}

export function replaceManagedBlock(existing, startMarker, endMarker) {
  const start = Buffer.from(startMarker);
  const end = Buffer.from(endMarker);
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end, startIndex + start.length);
  const unambiguous = startIndex >= 0
    && endIndex >= 0
    && existing.lastIndexOf(start) === startIndex
    && existing.lastIndexOf(end) === endIndex;
  if (!unambiguous) return undefined;
  return Buffer.concat([
    existing.subarray(0, startIndex),
    Buffer.from(MANAGED_BLOCK),
    existing.subarray(endIndex + end.length),
  ]);
}

export function managedBlock(existing, startMarker, endMarker) {
  const start = Buffer.from(startMarker);
  const end = Buffer.from(endMarker);
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end, startIndex + start.length);
  const absent = startIndex < 0 && endIndex < 0;
  if (absent) return { kind: "missing" };
  const unambiguous = startIndex >= 0
    && endIndex >= 0
    && existing.lastIndexOf(start) === startIndex
    && existing.lastIndexOf(end) === endIndex;
  if (!unambiguous) return { kind: "ambiguous" };
  return {
    kind: "block",
    content: existing.subarray(startIndex, endIndex + end.length),
  };
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cannot update: ${label} is invalid`);
  }
}

function assertKnownKeys(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`Cannot update: ${label} contains unknown keys: ${unknown.join(", ")}`);
}

function mergeConfig(value) {
  assertObject(value, "configuration");
  assertKnownKeys(value, ["$schema", "schemaVersion", "orchestration", "coordination", "quality"], "configuration");
  if (value.orchestration !== undefined && value.coordination !== undefined) {
    throw new Error("Cannot update: configuration mixes legacy orchestration with coordination");
  }
  if (value.orchestration !== undefined) {
    assertObject(value.orchestration, "legacy orchestration configuration");
    assertKnownKeys(value.orchestration,
      ["explicitActivationOnly", "defaultMode", "briefMaxBytes", "handoffMaxBytes"],
      "legacy orchestration configuration");
  }
  if (value.coordination !== undefined) {
    assertObject(value.coordination, "coordination configuration");
    assertKnownKeys(value.coordination, ["explicitActivationOnly", "defaultMode"], "coordination configuration");
  }
  if (value.quality !== undefined) assertObject(value.quality, "quality configuration");
  if (value.quality !== undefined) {
    assertKnownKeys(value.quality, ["crapThreshold", "mutationWorkers"], "quality configuration");
  }
  const merged = {
    $schema: CONFIG.$schema,
    schemaVersion: CONFIG_VERSION,
    coordination: { ...CONFIG.coordination, ...value.coordination },
    quality: { ...CONFIG.quality, ...value.quality },
  };
  const legacy = value.orchestration;
  const { coordination, quality } = merged;
  if ((legacy?.explicitActivationOnly !== undefined && legacy.explicitActivationOnly !== true)
    || (legacy?.defaultMode !== undefined && legacy.defaultMode !== "normal")
    || coordination.explicitActivationOnly !== true || coordination.defaultMode !== "normal"
    || typeof quality.crapThreshold !== "number" || !Number.isFinite(quality.crapThreshold) || quality.crapThreshold < 0
    || !Number.isInteger(quality.mutationWorkers) || quality.mutationWorkers < 1 || quality.mutationWorkers > 4) {
    throw new Error("Cannot update: configuration does not satisfy the current schema");
  }
  return merged;
}

export function validateOwnership(owner, action = "update") {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) {
    throw new Error(`Cannot ${action}: ownership manifest is invalid`);
  }
  if (owner.schemaVersion !== 1 || owner.product !== PRODUCT || typeof owner.version !== "string"
    || owner.version.length === 0 || typeof owner.installationId !== "string"
    || owner.installationId.length === 0 || ![1, CONFIG_VERSION].includes(owner.configVersion)
    || !Array.isArray(owner.resources) || !Array.isArray(owner.managedBlocks)
    || !Array.isArray(owner.ownedDirectories)) {
    throw new Error(`Cannot ${action}: ownership manifest is not a recognized agentic-core installation`);
  }
  const expectedBlocks = ["AGENTS.md", "CLAUDE.md"];
  const expectedResourceLayouts = owner.configVersion === CONFIG_VERSION
    ? [EXPECTED_RESOURCE_PATHS, PRE_QUALITY_IGNORE_EXPECTED_RESOURCE_PATHS]
    : [LEGACY_EXPECTED_RESOURCE_PATHS, EARLY_LEGACY_EXPECTED_RESOURCE_PATHS];
  const resourcePathsValid = expectedResourceLayouts.some((expectedPaths) => (
    owner.resources.length === expectedPaths.length
      && owner.resources.every((resource, index) => resource?.path === expectedPaths[index]
        && /^[0-9a-f]{64}$/.test(resource?.sha256))
  ));
  const expectedOwnedDirectories = owner.configVersion === CONFIG_VERSION
    ? OWNED_DIRECTORIES
    : LEGACY_OWNED_DIRECTORIES;
  if (!resourcePathsValid
    || owner.managedBlocks.length !== expectedBlocks.length
    || owner.ownedDirectories.length !== expectedOwnedDirectories.length
    || owner.ownedDirectories.some((directory, index) => directory !== expectedOwnedDirectories[index])
    || owner.managedBlocks.some((block, index) => block?.path !== expectedBlocks[index]
      || block?.id !== "agentic-core"
      || block?.startMarker !== "<!-- AGENTIC_CORE_START -->"
      || block?.endMarker !== "<!-- AGENTIC_CORE_END -->"
      || !/^[0-9a-f]{64}$/.test(block?.sha256))) {
    throw new Error(`Cannot ${action}: ownership manifest does not prove the expected resource boundaries`);
  }
  try {
    validateRuntimeOwnership(owner.runtime);
  } catch {
    throw new Error(`Cannot ${action}: ownership manifest has invalid runtime boundaries`);
  }
}

export async function installationDefinition(config = Buffer.from(json(CONFIG))) {
  const configuration = Buffer.from(config);
  return {
    product: PRODUCT,
    version: await getVersion(),
    configVersion: CONFIG_VERSION,
    defaultConfiguration: structuredClone(CONFIG),
    configurationSchema: structuredClone(CONFIG_SCHEMA),
    resources: await installationResources(configuration),
    managedBlocks: ["AGENTS.md", "CLAUDE.md"].map((hostPath) => ({
      path: hostPath,
      id: "agentic-core",
      startMarker: "<!-- AGENTIC_CORE_START -->",
      endMarker: "<!-- AGENTIC_CORE_END -->",
      sha256: sha256(Buffer.from(MANAGED_BLOCK)),
    })),
    managedBlockContent: Buffer.from(MANAGED_BLOCK),
    ownedDirectories: [...OWNED_DIRECTORIES],
  };
}

function removeManagedBlock(existing, startMarker, endMarker) {
  const start = Buffer.from(startMarker);
  const end = Buffer.from(endMarker);
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end, startIndex + start.length);
  return Buffer.concat([
    existing.subarray(0, startIndex),
    existing.subarray(endIndex + end.length),
  ]);
}

export async function initialize(projectDirectory, {
  dryRun = false,
  replaceConflicts = false,
  runtimeSource,
} = {}) {
  const projectRoot = path.resolve(projectDirectory);
  const productRoot = path.join(projectRoot, ".agentic-core");
  const ownershipPath = path.join(productRoot, "ownership.json");
  const version = await getVersion();
  const config = Buffer.from(json(CONFIG));
  const resources = await installationResources(config);
  const runtime = runtimeSource === undefined ? await discoverRuntimeSource() : runtimeSource;
  const hostBlocks = ["AGENTS.md", "CLAUDE.md"].map((hostPath) => ({
    path: hostPath,
    id: "agentic-core",
    startMarker: "<!-- AGENTIC_CORE_START -->",
    endMarker: "<!-- AGENTIC_CORE_END -->",
    sha256: sha256(Buffer.from(MANAGED_BLOCK)),
  }));

  const ownershipKind = await fileKind(ownershipPath);
  if (ownershipKind !== "missing") {
    if (ownershipKind !== "file") throw new Error("Foreign installation detected: ownership manifest is not a file");
    let owner;
    try {
      owner = JSON.parse(await readFile(ownershipPath, "utf8"));
    } catch {
      throw new Error("Foreign installation detected: ownership manifest is invalid");
    }
    if (owner.product !== PRODUCT) {
      throw new Error(`Foreign installation detected: ${String(owner.product ?? "unknown product")} owns .agentic-core`);
    }
    throw new Error("agentic-core is already installed; use agentic-core update");
  }

  if (await fileKind(path.join(productRoot, "quality")) !== "missing") {
    throw new Error("Foreign installation detected: .agentic-core/quality exists without proven ownership");
  }

  const conflicts = [];
  for (const resource of resources) {
    const targetPath = path.join(projectRoot, ...resource.path.split("/"));
    const kind = await fileKind(targetPath);
    if (kind !== "missing") conflicts.push({ path: resource.path, kind, authorized: replaceConflicts });
  }

  const coreFootprints = [CORE_RESOURCE_PATHS, PRE_QUALITY_IGNORE_CORE_RESOURCE_PATHS];
  if (coreFootprints.some((footprint) => footprint.every((resourcePath) => (
    conflicts.some(({ path: conflictPath }) => conflictPath === resourcePath)
  )))) {
    throw new Error("Foreign installation detected: the complete agentic-core footprint exists without a valid ownership manifest");
  }

  if (conflicts.some(({ kind }) => kind !== "file")) {
    throw new Error(`Unsupported isolated conflict: ${conflicts.map(({ path: conflictPath }) => conflictPath).join(", ")}`);
  }
  const runtimePath = path.join(productRoot, "runtime");
  assertRuntimePersistenceBoundary(runtime, runtimePath);
  if (runtime && await fileKind(runtimePath) !== "missing") {
    throw new Error("Foreign installation detected: .agentic-core/runtime exists without proven runtime ownership");
  }

  const hostWrites = [];
  for (const hostBlock of hostBlocks) {
    const targetPath = path.join(projectRoot, hostBlock.path);
    const kind = await fileKind(targetPath);
    if (kind !== "missing" && kind !== "file") throw new Error(`Unsupported isolated conflict: ${hostBlock.path}`);
    const existing = kind === "file" ? await readFile(targetPath) : Buffer.alloc(0);
    if (existing.includes(Buffer.from(hostBlock.startMarker)) || existing.includes(Buffer.from(hostBlock.endMarker))) {
      const replacement = replaceManagedBlock(existing, hostBlock.startMarker, hostBlock.endMarker);
      if (replacement === undefined) {
        conflicts.push({ path: hostBlock.path, kind: "ambiguous_managed_block", authorized: false });
        continue;
      }
      conflicts.push({ path: hostBlock.path, kind: "managed_block", authorized: replaceConflicts });
      hostWrites.push({ path: targetPath, content: replacement, action: "replace_managed_block" });
      continue;
    }
    hostWrites.push({ path: targetPath, content: appendManagedBlock(existing), action: "append_managed_block" });
  }

  const blockers = conflicts.filter(({ authorized }) => !authorized);
  const unsafeBlockers = blockers.filter(({ kind }) => kind === "ambiguous_managed_block");

  const manifest = {
    schemaVersion: 1,
    product: PRODUCT,
    version,
    installationId: deterministicInstallationId(projectRoot, version, resources),
    configVersion: CONFIG_VERSION,
    resources: resources.map(({ path: resourcePath, content }) => ({
      path: resourcePath,
      sha256: sha256(content),
    })),
    managedBlocks: hostBlocks,
    ownedDirectories: OWNED_DIRECTORIES,
    ...(runtime ? { runtime: runtime.manifest } : {}),
  };
  const operations = [
    ...resources.map((resource) => ({
      path: path.join(projectRoot, ...resource.path.split("/")),
      content: resource.content,
    })),
    ...hostWrites,
    ...(runtime ? [{
      path: runtimePath,
      type: "replace_directory",
      files: runtime.files,
      sourceSha256: runtime.manifest.treeSha256,
    }] : []),
    { path: ownershipPath, content: Buffer.from(json(manifest)) },
  ];
  const plan = {
    schemaVersion: 1,
    command: "init",
    dryRun: true,
    projectRoot,
    status: blockers.length === 0 ? "ready" : "blocked",
    options: { replaceConflicts },
    conflicts,
    actions: [
      ...resources.map((resource) => ({
        action: "write_resource",
        path: resource.path,
        sha256: sha256(resource.content),
      })),
      ...hostWrites.map((hostWrite) => ({
        action: hostWrite.action,
        path: path.relative(projectRoot, hostWrite.path).replaceAll("\\", "/"),
        sha256: sha256(hostWrite.content),
      })),
      ...(runtime ? [{
        action: "persist_runtime",
        path: runtime.manifest.path,
        source: runtime.manifest.source,
        treeSha256: runtime.manifest.treeSha256,
      }] : []),
      { action: "write_manifest", path: ".agentic-core/ownership.json", sha256: sha256(Buffer.from(json(manifest))) },
    ],
    manifest,
    ...(runtime ? { runtime: runtime.manifest } : {}),
    ...(blockers.length === 0 ? {} : {
      error: {
        code: unsafeBlockers.length > 0 ? "unsafe_conflict" : "authorization_required",
        message: unsafeBlockers.length > 0
          ? `Ambiguous managed boundaries cannot be replaced safely: ${unsafeBlockers.map(({ path: conflictPath }) => conflictPath).join(", ")}. Restore one complete boundary before retrying.`
          : `Found isolated conflict: ${blockers.map(({ path: conflictPath }) => conflictPath).join(", ")}. Re-run with --replace-conflicts to authorize replacement.`,
      },
    }),
  };
  if (dryRun) return { projectRoot, version, dryRun: true, exitCode: blockers.length === 0 ? 0 : 1, plan };
  if (blockers.length > 0) throw new Error(plan.error.message);
  const requestedFault = process.env.NODE_ENV === "test"
    ? Number.parseInt(process.env.AGENTIC_CORE_TEST_FAIL_AFTER_WRITE ?? "", 10)
    : Number.NaN;
  await writeTransaction(projectRoot, operations, {
    failAfterWrite: Number.isSafeInteger(requestedFault) && requestedFault > 0 ? requestedFault : undefined,
  });

  return { projectRoot, version, dryRun: false, plan };
}

export async function updateInstallation(projectDirectory, {
  dryRun = false,
  force = false,
  runtimeSource,
} = {}) {
  const projectRoot = path.resolve(projectDirectory);
  const productRoot = path.join(projectRoot, ".agentic-core");
  const ownershipPath = path.join(productRoot, "ownership.json");
  if (await fileKind(ownershipPath) !== "file") {
    throw new Error("Cannot update: no valid ownership manifest was found");
  }

  let owner;
  try {
    owner = JSON.parse(await readFile(ownershipPath, "utf8"));
  } catch {
    throw new Error("Cannot update: ownership manifest is invalid");
  }
  validateOwnership(owner);

  if (owner.configVersion === 1
    && await fileKind(path.join(productRoot, "quality")) !== "missing") {
    throw new Error("Cannot update: .agentic-core/quality exists without proven ownership");
  }

  const configPath = path.join(productRoot, "config.json");
  if (await fileKind(configPath) !== "file") throw new Error("Cannot update: configuration is not a file");
  let existingConfig;
  try {
    existingConfig = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error("Cannot update: configuration is invalid");
  }
  const config = Buffer.from(json(mergeConfig(existingConfig)));
  const version = await getVersion();
  const resources = await installationResources(config);
  const runtime = runtimeSource === undefined ? await discoverRuntimeSource() : runtimeSource;
  const divergences = [];
  const recordedResources = new Map(owner.resources.map((resource) => [resource.path, resource]));
  for (const resource of resources) {
    const targetPath = path.join(projectRoot, ...resource.path.split("/"));
    const kind = await fileKind(targetPath);
    const recorded = recordedResources.get(resource.path);
    if (recorded === undefined) {
      if (kind !== "missing") {
        throw new Error(`Cannot update: unowned resource occupies ${resource.path}`);
      }
      continue;
    }
    if (kind !== "file" || sha256(await readFile(targetPath)) !== recorded.sha256) {
      divergences.push(resource.path);
    }
  }
  const currentResourcePaths = new Set(resources.map((resource) => resource.path));
  const retiredResources = [];
  for (const recorded of owner.resources) {
    if (currentResourcePaths.has(recorded.path)) continue;
    const targetPath = path.join(projectRoot, ...recorded.path.split("/"));
    const kind = await fileKind(targetPath);
    if (kind === "missing") continue;
    const matches = kind === "file" && sha256(await readFile(targetPath)) === recorded.sha256;
    if (!matches) divergences.push(recorded.path);
    retiredResources.push({ path: recorded.path, targetPath, matches });
  }

  const hostWrites = [];
  for (const block of owner.managedBlocks) {
    const targetPath = path.join(projectRoot, block.path);
    const kind = await fileKind(targetPath);
    if (kind !== "missing" && kind !== "file") throw new Error(`Cannot update: ${block.path} is not a file`);
    const existing = kind === "file" ? await readFile(targetPath) : Buffer.alloc(0);
    const found = managedBlock(existing, block.startMarker, block.endMarker);
    if (found.kind === "ambiguous") {
      throw new Error(`Cannot update: ownership boundary in ${block.path} is ambiguous`);
    }
    if (found.kind === "missing" || sha256(found.content) !== block.sha256) divergences.push(block.path);
    hostWrites.push({
      path: targetPath,
      content: found.kind === "block"
        ? replaceManagedBlock(existing, block.startMarker, block.endMarker)
        : appendManagedBlock(existing),
    });
  }

  const runtimePath = path.join(productRoot, "runtime");
  assertRuntimePersistenceBoundary(runtime, runtimePath);
  const runtimeKind = await fileKind(runtimePath);
  let runtimeSourceRequired = false;
  if (owner.runtime === undefined) {
    if (runtimeKind !== "missing") {
      throw new Error("Cannot update: .agentic-core/runtime exists without proven runtime ownership");
    }
  } else {
    if (runtimeKind === "other") throw new Error("Cannot update: the persisted runtime has an unsafe path type");
    let runtimeMatches = false;
    if (runtimeKind === "directory") {
      try {
        await inspectPersistedRuntime(runtimePath, owner.runtime, owner.version);
        runtimeMatches = true;
      } catch {
        runtimeMatches = false;
      }
    }
    if (!runtimeMatches) {
      divergences.push(".agentic-core/runtime");
      runtimeSourceRequired = runtime === undefined;
    }
  }

  const blocked = runtimeSourceRequired || (divergences.length > 0 && !force);

  const managedBlocks = owner.managedBlocks.map((block) => ({
    ...block,
    sha256: sha256(Buffer.from(MANAGED_BLOCK)),
  }));
  const manifest = {
    schemaVersion: 1,
    product: PRODUCT,
    version,
    installationId: owner.installationId,
    configVersion: CONFIG_VERSION,
    resources: resources.map((resource) => ({ path: resource.path, sha256: sha256(resource.content) })),
    managedBlocks,
    ownedDirectories: OWNED_DIRECTORIES,
    ...(runtime ? { runtime: runtime.manifest } : owner.runtime ? { runtime: owner.runtime } : {}),
  };
  const legacyState = [];
  for (const legacyDirectory of LEGACY_OWNED_DIRECTORIES.slice(0, 4)) {
    const kind = await fileKind(path.join(projectRoot, ...legacyDirectory.split("/")));
    if (kind !== "missing") legacyState.push({ path: legacyDirectory, kind });
  }
  const operations = [
    ...resources.map((resource) => ({
      path: path.join(projectRoot, ...resource.path.split("/")),
      content: resource.content,
    })),
    ...hostWrites,
    ...retiredResources
      .filter(({ matches }) => matches || force)
      .map(({ targetPath }) => ({ path: targetPath, type: "delete" })),
    ...(runtime ? [{
      path: runtimePath,
      type: "replace_directory",
      files: runtime.files,
      sourceSha256: runtime.manifest.treeSha256,
    }] : []),
    { path: ownershipPath, content: Buffer.from(json(manifest)) },
  ];
  const plan = {
    schemaVersion: 1,
    command: "update",
    dryRun: true,
    projectRoot,
    status: blocked ? "blocked" : "ready",
    options: { force },
    divergences,
    actions: [
      ...resources.map((resource) => ({
        action: "write_resource",
        path: resource.path,
        sha256: sha256(resource.content),
      })),
      ...hostWrites.map((hostWrite) => ({
        action: "replace_managed_block",
        path: path.relative(projectRoot, hostWrite.path).replaceAll("\\", "/"),
        sha256: sha256(hostWrite.content),
      })),
      ...retiredResources
        .filter(({ matches }) => matches || force)
        .map(({ path: resourcePath }) => ({ action: "remove_retired_resource", path: resourcePath })),
      ...legacyState.map(({ path: legacyPath, kind }) => ({
        action: "preserve_legacy_state",
        path: legacyPath,
        kind,
      })),
      ...(runtime ? [{
        action: "persist_runtime",
        path: runtime.manifest.path,
        source: runtime.manifest.source,
        treeSha256: runtime.manifest.treeSha256,
      }] : []),
      { action: "write_manifest", path: ".agentic-core/ownership.json", sha256: sha256(Buffer.from(json(manifest))) },
    ],
    manifest,
    ...(runtime ? { runtime: runtime.manifest } : owner.runtime ? { runtime: owner.runtime } : {}),
    ...(blocked ? {
      error: {
        code: runtimeSourceRequired ? "runtime_source_required" : "force_required",
        message: runtimeSourceRequired
          ? "The persisted runtime diverged, but this invocation has no canonical GitHub runtime source. Re-run update through github:KroxiDev/agentic-core."
          : `Owned resources diverged: ${divergences.join(", ")}. Re-run with --force to authorize replacement.`,
      },
    } : {}),
  };
  if (dryRun) return { projectRoot, version, divergences, dryRun: true, exitCode: blocked ? 1 : 0, plan };
  if (blocked) throw new Error(plan.error.message);
  const requestedFault = process.env.NODE_ENV === "test"
    ? Number.parseInt(process.env.AGENTIC_CORE_TEST_FAIL_AFTER_WRITE ?? "", 10)
    : Number.NaN;
  await writeTransaction(projectRoot, operations, {
    failAfterWrite: Number.isSafeInteger(requestedFault) && requestedFault > 0 ? requestedFault : undefined,
  });
  return { projectRoot, version, divergences, dryRun: false, plan };
}

export async function uninstallInstallation(projectDirectory, {
  dryRun = false,
  force = false,
  confirmDivergence = async () => false,
} = {}) {
  const projectRoot = path.resolve(projectDirectory);
  const productRoot = path.join(projectRoot, ".agentic-core");
  const ownershipPath = path.join(productRoot, "ownership.json");
  if (await fileKind(ownershipPath) !== "file") {
    throw new Error("Cannot uninstall: no valid ownership manifest was found");
  }
  let owner;
  try {
    owner = JSON.parse(await readFile(ownershipPath, "utf8"));
  } catch {
    throw new Error("Cannot uninstall: ownership manifest is invalid");
  }
  validateOwnership(owner, "uninstall");

  const operations = [];
  const actions = [];
  const preserved = [];
  const authorize = async (kind, ownedPath) => force || confirmDivergence({ kind, path: ownedPath });
  for (const resource of owner.resources) {
    const targetPath = path.join(projectRoot, ...resource.path.split("/"));
    const kind = await fileKind(targetPath);
    if (kind === "missing") continue;
    const matches = kind === "file" && sha256(await readFile(targetPath)) === resource.sha256;
    if (!matches && (kind !== "file" || !(await authorize("resource", resource.path)))) {
      preserved.push(`divergent resource: ${resource.path}`);
      continue;
    }
    operations.push({ path: targetPath, type: "delete" });
    actions.push(`resource: ${resource.path}`);
  }

  for (const block of owner.managedBlocks) {
    const targetPath = path.join(projectRoot, block.path);
    const kind = await fileKind(targetPath);
    if (kind === "missing") continue;
    if (kind !== "file") {
      preserved.push(`divergent managed block: ${block.path}#${block.id}`);
      continue;
    }
    const existing = await readFile(targetPath);
    const found = managedBlock(existing, block.startMarker, block.endMarker);
    if (found.kind !== "block") {
      preserved.push(`divergent managed block: ${block.path}#${block.id}`);
      continue;
    }
    const matches = sha256(found.content) === block.sha256;
    if (!matches && !(await authorize("managed block", `${block.path}#${block.id}`))) {
      preserved.push(`divergent managed block: ${block.path}#${block.id}`);
      continue;
    }
    operations.push({
      path: targetPath,
      content: removeManagedBlock(existing, block.startMarker, block.endMarker),
    });
    actions.push(`managed block: ${block.path}#${block.id}`);
  }

  if (owner.runtime) {
    const targetPath = path.join(projectRoot, ...owner.runtime.path.split("/"));
    const kind = await fileKind(targetPath);
    if (kind !== "missing") {
      let matches = false;
      if (kind === "directory") {
        try {
          await inspectPersistedRuntime(targetPath, owner.runtime, owner.version);
          matches = true;
        } catch {
          matches = false;
        }
      }
      if (matches || ((kind === "file" || kind === "directory") && await authorize("runtime", owner.runtime.path))) {
        operations.push({ path: targetPath, type: "delete" });
        actions.push(`runtime: ${owner.runtime.path}`);
      } else {
        preserved.push(`divergent runtime: ${owner.runtime.path}`);
      }
    }
  }

  for (const ownedDirectory of owner.ownedDirectories) {
    if (ownedDirectory === ".agentic-core/runs") {
      if (await fileKind(path.join(projectRoot, ...ownedDirectory.split("/"))) !== "missing") {
        preserved.push(`legacy directory: ${ownedDirectory}`);
      }
      continue;
    }
    const targetPath = path.join(projectRoot, ...ownedDirectory.split("/"));
    const kind = await fileKind(targetPath);
    if (kind === "missing") continue;
    if (kind !== "directory") {
      preserved.push(`unexpected path: ${ownedDirectory}`);
      continue;
    }
    operations.push({ path: targetPath, type: "delete" });
    actions.push(`owned directory: ${ownedDirectory}`);
  }
  if (!owner.ownedDirectories.includes(".agentic-core/runs")
    && await fileKind(path.join(productRoot, "runs")) !== "missing") {
    preserved.push("legacy directory: .agentic-core/runs");
  }
  operations.push({ path: ownershipPath, type: "delete" });
  actions.push("manifest: .agentic-core/ownership.json");

  if (!dryRun) {
    const requestedFault = process.env.NODE_ENV === "test"
      ? Number.parseInt(process.env.AGENTIC_CORE_TEST_FAIL_AFTER_WRITE ?? "", 10)
      : Number.NaN;
    await writeTransaction(projectRoot, operations, {
      failAfterWrite: Number.isSafeInteger(requestedFault) && requestedFault > 0 ? requestedFault : undefined,
    });
    try {
      await rmdir(productRoot);
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
    }
  }
  return { projectRoot, dryRun, actions, preserved };
}
