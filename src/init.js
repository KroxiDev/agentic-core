import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { writeTransaction } from "./transaction.js";
import { getVersion } from "./version.js";

const PRODUCT = "@kroxidev/agentic-core";
const CONFIG_VERSION = 1;
const CORE_RESOURCE_PATHS = [
  ".agentic-core/config.json",
  ".agentic-core/config.schema.json",
  ".agentic-core/golden-rules.md",
];
const HOST_RESOURCE_SPECS = [
  ...["read", "production", "tests", "docs"].flatMap((profile) => [
    { source: `adapters/codex/agents/agentic-${profile}.toml`, target: `.codex/agents/agentic-${profile}.toml` },
    { source: `adapters/claude/agents/agentic-${profile}.md`, target: `.claude/agents/agentic-${profile}.md` },
  ]),
  ...["orquestar", "agentic-tdd", "agentic-grilling"].flatMap((skill) => [
    { source: `skills/${skill}/SKILL.md`, target: `.agents/skills/${skill}/SKILL.md` },
    { source: `adapters/claude/skills/${skill}/SKILL.md`, target: `.claude/skills/${skill}/SKILL.md` },
  ]),
];
const EXPECTED_RESOURCE_PATHS = [...CORE_RESOURCE_PATHS, ...HOST_RESOURCE_SPECS.map(({ target }) => target)];
const OWNED_DIRECTORIES = [
  ".agentic-core/runs",
  ".agentic-core/reports",
  ".agentic-core/workers",
  ".agentic-core/transactions",
  ".agents/skills/orquestar",
  ".agents/skills/agentic-tdd",
  ".agents/skills/agentic-grilling",
  ".claude/skills/orquestar",
  ".claude/skills/agentic-tdd",
  ".claude/skills/agentic-grilling",
];
const MANAGED_BLOCK = `<!-- AGENTIC_CORE_START -->
## agentic-core

Follow the canonical policy in \`.agentic-core/golden-rules.md\`.

Requests without an explicit \`Orquesta\`, \`/orquestar\`, or \`$orquestar\` trigger run directly. In direct execution, no coordinator, run state, or subagents are used; load only \`.agentic-core/golden-rules.md\` as agentic-core policy.
<!-- AGENTIC_CORE_END -->`;

const CONFIG = {
  $schema: "./config.schema.json",
  schemaVersion: CONFIG_VERSION,
  orchestration: {
    explicitActivationOnly: true,
    defaultMode: "normal",
    briefMaxBytes: 16_384,
    handoffMaxBytes: 32_768,
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
  required: ["$schema", "schemaVersion", "orchestration", "quality"],
  properties: {
    $schema: { const: "./config.schema.json" },
    schemaVersion: { const: CONFIG_VERSION },
    orchestration: {
      type: "object",
      additionalProperties: false,
      required: ["explicitActivationOnly", "defaultMode", "briefMaxBytes", "handoffMaxBytes"],
      properties: {
        explicitActivationOnly: { const: true },
        defaultMode: { const: "normal" },
        briefMaxBytes: { type: "integer", minimum: 1, maximum: 16_384 },
        handoffMaxBytes: { type: "integer", minimum: 1, maximum: 32_768 },
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

async function installationResources(config) {
  const hostResources = await Promise.all(HOST_RESOURCE_SPECS.map(async ({ source, target }) => ({
    path: target,
    content: await readFile(new URL(`../${source}`, import.meta.url)),
  })));
  return [
    { path: ".agentic-core/config.json", content: config },
    { path: ".agentic-core/config.schema.json", content: Buffer.from(json(CONFIG_SCHEMA)) },
    { path: ".agentic-core/golden-rules.md", content: await readFile(new URL("../golden-rules.md", import.meta.url)) },
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

function appendManagedBlock(existing) {
  if (existing.length === 0) return Buffer.from(`${MANAGED_BLOCK}\n`);
  const separator = existing.at(-1) === 0x0a ? "\n" : "\n\n";
  return Buffer.concat([existing, Buffer.from(`${separator}${MANAGED_BLOCK}\n`)]);
}

function replaceManagedBlock(existing, startMarker, endMarker) {
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

function managedBlock(existing, startMarker, endMarker) {
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

function mergeConfig(value) {
  assertObject(value, "configuration");
  if (value.orchestration !== undefined) assertObject(value.orchestration, "orchestration configuration");
  if (value.quality !== undefined) assertObject(value.quality, "quality configuration");
  const merged = {
    ...CONFIG,
    ...value,
    $schema: CONFIG.$schema,
    schemaVersion: CONFIG_VERSION,
    orchestration: { ...CONFIG.orchestration, ...value.orchestration },
    quality: { ...CONFIG.quality, ...value.quality },
  };
  const { orchestration, quality } = merged;
  if (orchestration.explicitActivationOnly !== true || orchestration.defaultMode !== "normal"
    || !Number.isInteger(orchestration.briefMaxBytes) || orchestration.briefMaxBytes < 1 || orchestration.briefMaxBytes > 16_384
    || !Number.isInteger(orchestration.handoffMaxBytes) || orchestration.handoffMaxBytes < 1 || orchestration.handoffMaxBytes > 32_768
    || typeof quality.crapThreshold !== "number" || quality.crapThreshold < 0
    || !Number.isInteger(quality.mutationWorkers) || quality.mutationWorkers < 1 || quality.mutationWorkers > 4) {
    throw new Error("Cannot update: configuration does not satisfy the current schema");
  }
  return merged;
}

function validateOwnership(owner, action = "update") {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) {
    throw new Error(`Cannot ${action}: ownership manifest is invalid`);
  }
  if (owner.schemaVersion !== 1 || owner.product !== PRODUCT || typeof owner.installationId !== "string"
    || !Array.isArray(owner.resources) || !Array.isArray(owner.managedBlocks)
    || !Array.isArray(owner.ownedDirectories)) {
    throw new Error(`Cannot ${action}: ownership manifest is not a recognized agentic-core installation`);
  }
  const expectedBlocks = ["AGENTS.md", "CLAUDE.md"];
  if (owner.resources.length !== EXPECTED_RESOURCE_PATHS.length
    || owner.managedBlocks.length !== expectedBlocks.length
    || owner.ownedDirectories.length !== OWNED_DIRECTORIES.length
    || owner.ownedDirectories.some((directory, index) => directory !== OWNED_DIRECTORIES[index])
    || owner.resources.some((resource, index) => resource?.path !== EXPECTED_RESOURCE_PATHS[index]
      || !/^[0-9a-f]{64}$/.test(resource?.sha256))
    || owner.managedBlocks.some((block, index) => block?.path !== expectedBlocks[index]
      || block?.id !== "agentic-core"
      || block?.startMarker !== "<!-- AGENTIC_CORE_START -->"
      || block?.endMarker !== "<!-- AGENTIC_CORE_END -->"
      || !/^[0-9a-f]{64}$/.test(block?.sha256))) {
    throw new Error(`Cannot ${action}: ownership manifest does not prove the expected resource boundaries`);
  }
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

export async function initialize(projectDirectory, { replaceConflicts = false } = {}) {
  const projectRoot = path.resolve(projectDirectory);
  const productRoot = path.join(projectRoot, ".agentic-core");
  const ownershipPath = path.join(productRoot, "ownership.json");
  const version = await getVersion();
  const config = Buffer.from(json(CONFIG));
  const resources = await installationResources(config);
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

  const conflicts = [];
  for (const resource of resources) {
    const targetPath = path.join(projectRoot, ...resource.path.split("/"));
    const kind = await fileKind(targetPath);
    if (kind !== "missing") conflicts.push({ path: resource.path, kind });
  }

  if (CORE_RESOURCE_PATHS.every((resourcePath) => conflicts.some(({ path: conflictPath }) => conflictPath === resourcePath))) {
    throw new Error("Foreign installation detected: the complete agentic-core footprint exists without a valid ownership manifest");
  }

  if (conflicts.some(({ kind }) => kind !== "file")) {
    throw new Error(`Unsupported isolated conflict: ${conflicts.map(({ path: conflictPath }) => conflictPath).join(", ")}`);
  }
  if (conflicts.length > 0 && !replaceConflicts) {
    throw new Error(`Found isolated conflict: ${conflicts.map(({ path: conflictPath }) => conflictPath).join(", ")}. Re-run with --replace-conflicts to authorize replacement.`);
  }

  const hostWrites = [];
  for (const hostBlock of hostBlocks) {
    const targetPath = path.join(projectRoot, hostBlock.path);
    const kind = await fileKind(targetPath);
    if (kind !== "missing" && kind !== "file") throw new Error(`Unsupported isolated conflict: ${hostBlock.path}`);
    const existing = kind === "file" ? await readFile(targetPath) : Buffer.alloc(0);
    if (existing.includes(Buffer.from(hostBlock.startMarker)) || existing.includes(Buffer.from(hostBlock.endMarker))) {
      if (!replaceConflicts) {
        throw new Error(`Found isolated conflict: ${hostBlock.path}. Re-run with --replace-conflicts to authorize replacement.`);
      }
      const replacement = replaceManagedBlock(existing, hostBlock.startMarker, hostBlock.endMarker);
      if (replacement === undefined) {
        throw new Error(`Cannot safely replace an ambiguous managed block in ${hostBlock.path}`);
      }
      hostWrites.push({ path: targetPath, content: replacement, existed: true });
      continue;
    }
    hostWrites.push({ path: targetPath, content: appendManagedBlock(existing), existed: kind === "file" });
  }

  const manifest = {
    schemaVersion: 1,
    product: PRODUCT,
    version,
    installationId: randomUUID(),
    configVersion: CONFIG_VERSION,
    resources: resources.map(({ path: resourcePath, content }) => ({
      path: resourcePath,
      sha256: sha256(content),
    })),
    managedBlocks: hostBlocks,
    ownedDirectories: OWNED_DIRECTORIES,
  };
  const operations = [
    ...resources.map((resource) => ({
      path: path.join(projectRoot, ...resource.path.split("/")),
      content: resource.content,
    })),
    ...hostWrites,
    { path: ownershipPath, content: Buffer.from(json(manifest)) },
  ];
  const requestedFault = process.env.NODE_ENV === "test"
    ? Number.parseInt(process.env.AGENTIC_CORE_TEST_FAIL_AFTER_WRITE ?? "", 10)
    : Number.NaN;
  await writeTransaction(projectRoot, operations, {
    failAfterWrite: Number.isSafeInteger(requestedFault) && requestedFault > 0 ? requestedFault : undefined,
  });

  return { projectRoot, version };
}

export async function updateInstallation(projectDirectory, { force = false } = {}) {
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
  const divergences = [];
  for (let index = 0; index < resources.length; index += 1) {
    const resource = resources[index];
    const targetPath = path.join(projectRoot, ...resource.path.split("/"));
    const kind = await fileKind(targetPath);
    if (kind !== "file" || sha256(await readFile(targetPath)) !== owner.resources[index].sha256) {
      divergences.push(resource.path);
    }
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

  if (divergences.length > 0 && !force) {
    throw new Error(`Owned resources diverged: ${divergences.join(", ")}. Re-run with --force to authorize replacement.`);
  }

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
  };
  const runsPath = path.join(productRoot, "runs");
  const runsKind = await fileKind(runsPath);
  if (runsKind !== "missing" && runsKind !== "directory") {
    throw new Error("Cannot update: persisted runs path is not a directory");
  }
  const operations = [
    ...resources.map((resource) => ({
      path: path.join(projectRoot, ...resource.path.split("/")),
      content: resource.content,
    })),
    ...hostWrites,
    ...(runsKind === "missing" ? [] : [{ path: runsPath, type: "delete" }]),
    { path: ownershipPath, content: Buffer.from(json(manifest)) },
  ];
  const requestedFault = process.env.NODE_ENV === "test"
    ? Number.parseInt(process.env.AGENTIC_CORE_TEST_FAIL_AFTER_WRITE ?? "", 10)
    : Number.NaN;
  await writeTransaction(projectRoot, operations, {
    failAfterWrite: Number.isSafeInteger(requestedFault) && requestedFault > 0 ? requestedFault : undefined,
  });
  return { projectRoot, version, divergences };
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

  for (const ownedDirectory of owner.ownedDirectories) {
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
