import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { writeTransaction } from "./transaction.js";
import { getVersion } from "./version.js";

const PRODUCT = "@kroxidev/agentic-core";
const CONFIG_VERSION = 1;
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

function logicalPath(...segments) {
  return segments.join("/");
}

async function fileKind(filePath) {
  try {
    const details = await lstat(filePath);
    return details.isFile() ? "file" : "other";
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

export async function initialize(projectDirectory, { replaceConflicts = false } = {}) {
  const projectRoot = path.resolve(projectDirectory);
  const productRoot = path.join(projectRoot, ".agentic-core");
  const ownershipPath = path.join(productRoot, "ownership.json");
  const version = await getVersion();
  const goldenRules = await readFile(new URL("../golden-rules.md", import.meta.url));
  const config = Buffer.from(json(CONFIG));
  const schema = Buffer.from(json(CONFIG_SCHEMA));
  const resources = [
    { path: logicalPath(".agentic-core", "config.json"), content: config },
    { path: logicalPath(".agentic-core", "config.schema.json"), content: schema },
    { path: logicalPath(".agentic-core", "golden-rules.md"), content: goldenRules },
  ];
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

  if (conflicts.length === resources.length) {
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
    if (kind === "other") throw new Error(`Unsupported isolated conflict: ${hostBlock.path}`);
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
