import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const PRODUCT = "@kroxidev/agentic-core";
const RUNTIME_FORMAT = "self-contained-v1";
const RUNTIME_MANIFEST = "runtime-manifest.json";
const BINS = new Map([
  ["agentic-core", "agentic-core.mjs"],
  ["agentic-quality", "agentic-core.mjs"],
]);
const LEGACY_BINS = new Map([
  ["agentic-core", "bin/agentic-core.js"],
  ["agentic-quality", "bin/agentic-quality.js"],
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function regularFile(filePath, label) {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
}

async function inspectTree(root) {
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error("The persisted runtime is not a safe directory");
  }
  const treeHash = createHash("sha256");
  const files = new Map();
  const visit = async (directory, relative = "") => {
    treeHash.update(`directory\0${relative}\0`);
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const logicalPath = relative ? `${relative}/${entry.name}` : entry.name;
      const details = await lstat(child);
      if (details.isSymbolicLink()) throw new Error(`The persisted runtime contains a symbolic link: ${logicalPath}`);
      if (details.isDirectory()) {
        await visit(child, logicalPath);
      } else if (details.isFile()) {
        const content = await readFile(child);
        treeHash.update(`file\0${logicalPath}\0${content.byteLength}\0`);
        treeHash.update(content);
        files.set(logicalPath, {
          bytes: content.byteLength,
          sha256: sha256(content),
          ...(logicalPath === RUNTIME_MANIFEST ? { content } : {}),
        });
      } else {
        throw new Error(`The persisted runtime contains an unsupported entry: ${logicalPath}`);
      }
    }
  };
  await visit(root);
  return { treeSha256: treeHash.digest("hex"), files };
}

function validateRuntimeManifest(runtimeManifest, ownershipRuntime, ownerVersion, inspected) {
  const binsValid = plainObject(runtimeManifest?.bins)
    && [...BINS].every(([name, filePath]) => runtimeManifest.bins[name] === filePath)
    && Object.keys(runtimeManifest.bins).length === BINS.size;
  const records = runtimeManifest?.integrity?.files;
  if (!plainObject(runtimeManifest) || runtimeManifest.schemaVersion !== 1
    || runtimeManifest.product !== PRODUCT || runtimeManifest.version !== ownerVersion
    || runtimeManifest.format !== RUNTIME_FORMAT || runtimeManifest.source !== ownershipRuntime.source
    || runtimeManifest.commit !== ownershipRuntime.commit || !binsValid
    || runtimeManifest?.integrity?.algorithm !== "sha256" || !Array.isArray(records)) {
    throw new Error("The persisted runtime manifest is invalid");
  }
  const expectedPaths = [...inspected.files.keys()].filter((filePath) => filePath !== RUNTIME_MANIFEST);
  if (records.length !== expectedPaths.length || new Set(records.map((record) => record?.path)).size !== records.length) {
    throw new Error("The persisted runtime manifest has an invalid file inventory");
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const actual = inspected.files.get(expectedPaths[index]);
    if (!plainObject(record) || record.path !== expectedPaths[index]
      || record.bytes !== actual?.bytes || record.sha256 !== actual?.sha256) {
      throw new Error(`The persisted runtime manifest failed integrity validation: ${String(record?.path)}`);
    }
  }
}

async function persistedInvocation(projectRoot, owner, command) {
  const runtime = owner.runtime;
  const binsValid = Array.isArray(runtime?.bins)
    && runtime.bins.length === BINS.size
    && [...BINS.keys()].every((bin, index) => runtime.bins[index] === bin);
  if (!plainObject(runtime) || typeof owner.version !== "string"
    || runtime.path !== ".agentic-core/runtime"
    || (runtime.commit !== undefined && !/^[0-9a-f]{40}$/u.test(runtime.commit))
    || typeof runtime.source !== "string" || !runtime.source.trim() || /[\r\n]/u.test(runtime.source)
    || !/^[0-9a-f]{64}$/u.test(runtime.treeSha256) || !binsValid) {
    throw new Error("The persisted runtime ownership metadata is invalid");
  }
  const runtimeRoot = path.join(projectRoot, ".agentic-core", "runtime");
  const inspected = await inspectTree(runtimeRoot);
  if (inspected.treeSha256 !== runtime.treeSha256) {
    throw new Error("The persisted runtime does not match its ownership hash");
  }

  if (runtime.format === undefined) {
    const binary = path.join(runtimeRoot, "node_modules", "@kroxidev", "agentic-core", ...LEGACY_BINS.get(command).split("/"));
    await regularFile(binary, "The legacy persisted runtime binary");
    return { binary, argsPrefix: [] };
  }
  if (runtime.format !== RUNTIME_FORMAT || runtime.manifest !== RUNTIME_MANIFEST) {
    throw new Error("The persisted runtime format is unsupported");
  }
  const manifestFile = inspected.files.get(RUNTIME_MANIFEST);
  let runtimeManifest;
  try {
    runtimeManifest = JSON.parse(manifestFile?.content?.toString("utf8") ?? "");
  } catch (error) {
    throw new Error(`The persisted runtime manifest is invalid: ${error.message}`);
  }
  validateRuntimeManifest(runtimeManifest, runtime, owner.version, inspected);
  const binary = path.join(runtimeRoot, ...BINS.get(command).split("/"));
  await regularFile(binary, "The persisted runtime binary");
  return { binary, argsPrefix: [command] };
}

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (!BINS.has(command)) throw new Error(`Unsupported agentic runtime seam: ${String(command)}`);
  const projectRoot = path.resolve(process.cwd());
  const productRoot = path.join(projectRoot, ".agentic-core");
  const ownershipPath = path.join(productRoot, "ownership.json");
  const productDetails = await lstat(productRoot);
  if (!productDetails.isDirectory() || productDetails.isSymbolicLink()) {
    throw new Error("The selected agentic-core directory is unsafe");
  }
  await regularFile(ownershipPath, "The agentic-core ownership manifest");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(ownershipPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read agentic-core ownership: ${error.message}`);
  }
  if (manifest.product !== PRODUCT) throw new Error("The selected project is not owned by agentic-core");

  let invocation;
  if (manifest.runtime) {
    invocation = await persistedInvocation(projectRoot, manifest, command);
  } else {
    const binary = path.join(projectRoot, "node_modules", "@kroxidev", "agentic-core", ...LEGACY_BINS.get(command).split("/"));
    await regularFile(binary, "The project-local agentic-core binary");
    invocation = { binary, argsPrefix: [] };
  }
  const child = spawn(process.execPath, [invocation.binary, ...invocation.argsPrefix, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated with signal ${signal}`));
      else {
        process.exitCode = code ?? 1;
        resolve();
      }
    });
  });
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
