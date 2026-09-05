import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GITHUB_SPEC,
  PRODUCT,
  RUNTIME_BINS,
  RUNTIME_FORMAT,
  RUNTIME_MANIFEST,
  RUNTIME_PAYLOAD_COPIES,
  RUNTIME_PAYLOAD_MANIFEST,
} from "./runtime-layout.js";
import { hashFileTree } from "./transaction.js";

const BIN_PATHS = new Map([
  ["agentic-core", "bin/agentic-core.js"],
  ["agentic-quality", "bin/agentic-quality.js"],
]);
const BINS = [...BIN_PATHS.keys()];
const bundled = typeof __AGENTIC_CORE_BUNDLED_RUNTIME__ === "boolean" && __AGENTIC_CORE_BUNDLED_RUNTIME__;
const packageRoot = fileURLToPath(new URL(bundled ? "../../" : "../", import.meta.url));
const expectedPayloadPaths = [
  ...new Set(Object.values(RUNTIME_BINS)),
  ...RUNTIME_PAYLOAD_COPIES.map(({ target }) => target),
].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function jsonFile(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

function commitFromResolved(resolved) {
  const match = /^git\+(?:ssh:\/\/git@|https:\/\/)github\.com\/KroxiDev\/agentic-core\.git#([0-9a-f]{40})$/u.exec(resolved);
  if (!match) throw new Error("The ephemeral runtime is not pinned to KroxiDev/agentic-core on GitHub");
  return match[1];
}

function validatePayloadManifest(manifest, version) {
  const records = Array.isArray(manifest?.integrity?.files) ? manifest.integrity.files : [];
  const filePaths = records.map((file) => file?.path);
  const binsValid = plainObject(manifest?.bins)
    && BINS.every((bin) => manifest.bins[bin] === RUNTIME_BINS[bin])
    && Object.keys(manifest.bins).length === BINS.length;
  const filesValid = records.length === expectedPayloadPaths.length
    && manifest?.integrity?.algorithm === "sha256"
    && records.every((file, index) => plainObject(file)
      && file.path === expectedPayloadPaths[index]
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0
      && /^[0-9a-f]{64}$/u.test(file.sha256));
  if (!plainObject(manifest) || manifest.schemaVersion !== 1
    || manifest.type !== "agentic-core-runtime-payload" || manifest.product !== PRODUCT
    || manifest.version !== version || manifest.format !== RUNTIME_FORMAT
    || !binsValid || !filesValid || new Set(filePaths).size !== filePaths.length) {
    throw new Error("The packaged runtime payload manifest is invalid");
  }
}

async function readSafeTree(root, label = "The packaged runtime payload") {
  const resolvedRoot = path.resolve(root);
  const rootDetails = await lstat(resolvedRoot);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error(`${label} is not a safe directory`);
  }
  const files = [];
  const visit = async (directory, relative = "") => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const logicalPath = relative ? `${relative}/${entry.name}` : entry.name;
      const details = await lstat(child);
      if (details.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${logicalPath}`);
      if (details.isDirectory()) {
        await visit(child, logicalPath);
      } else if (details.isFile()) {
        files.push({ path: logicalPath, content: await readFile(child) });
      } else {
        throw new Error(`${label} contains an unsupported entry: ${logicalPath}`);
      }
    }
  };
  await visit(resolvedRoot);
  return files;
}

async function assembledRuntime(installedRoot, { root, source, commit, version }) {
  const payloadRoot = path.join(installedRoot, "dist", "runtime");
  const payloadManifest = await jsonFile(
    path.join(payloadRoot, RUNTIME_PAYLOAD_MANIFEST),
    "The packaged runtime payload manifest",
  );
  validatePayloadManifest(payloadManifest, version);
  const payloadTree = await readSafeTree(payloadRoot);
  const actualPaths = payloadTree.map(({ path: filePath }) => filePath);
  const expectedPaths = [...expectedPayloadPaths, RUNTIME_PAYLOAD_MANIFEST]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (actualPaths.length !== expectedPaths.length
    || actualPaths.some((filePath, index) => filePath !== expectedPaths[index])) {
    throw new Error("The packaged runtime payload contains an unexpected file inventory");
  }

  const byPath = new Map(payloadTree.map((file) => [file.path, file]));
  const files = payloadManifest.integrity.files.map((record) => {
    const file = byPath.get(record.path);
    if (file.content.byteLength !== record.bytes || sha256(file.content) !== record.sha256) {
      throw new Error(`The packaged runtime payload failed integrity validation: ${record.path}`);
    }
    return file;
  });
  const runtimeManifest = {
    schemaVersion: 1,
    product: PRODUCT,
    version,
    format: RUNTIME_FORMAT,
    source,
    commit,
    bins: RUNTIME_BINS,
    integrity: payloadManifest.integrity,
  };
  files.push({ path: RUNTIME_MANIFEST, content: Buffer.from(json(runtimeManifest)) });
  const treeSha256 = hashFileTree(files);
  return {
    root,
    files,
    manifest: {
      path: ".agentic-core/runtime",
      format: RUNTIME_FORMAT,
      manifest: RUNTIME_MANIFEST,
      source,
      commit,
      treeSha256,
      bins: [...BINS],
    },
  };
}

async function inspectRuntimeRoot(runtimeRoot) {
  const root = path.resolve(runtimeRoot);
  const rootPackage = await jsonFile(path.join(root, "package.json"), "The ephemeral runtime package manifest");
  if (rootPackage.dependencies?.[PRODUCT] !== GITHUB_SPEC
    || !Array.isArray(rootPackage._npx?.packages)
    || rootPackage._npx.packages.length !== 1
    || rootPackage._npx.packages[0] !== GITHUB_SPEC) {
    throw new Error("The ephemeral runtime does not prove the canonical GitHub npx source");
  }
  const lock = await jsonFile(path.join(root, "package-lock.json"), "The ephemeral runtime lockfile");
  const installed = lock.packages?.[`node_modules/${PRODUCT}`];
  const commit = commitFromResolved(installed?.resolved);
  const installedRoot = path.join(root, "node_modules", "@kroxidev", "agentic-core");
  const installedPackage = await jsonFile(path.join(installedRoot, "package.json"), "The installed runtime package manifest");
  if (installedPackage.name !== PRODUCT || typeof installedPackage.version !== "string"
    || BINS.some((bin) => installedPackage.bin?.[bin] !== BIN_PATHS.get(bin))) {
    throw new Error("The ephemeral runtime does not expose both canonical binary paths");
  }
  for (const bin of BINS) {
    const binaryPath = path.join(installedRoot, ...BIN_PATHS.get(bin).split("/"));
    const details = await lstat(binaryPath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`The ephemeral runtime binary is not a regular file: ${bin}`);
    }
  }
  return assembledRuntime(installedRoot, {
    root,
    source: `${GITHUB_SPEC}#${commit}`,
    commit,
    version: installedPackage.version,
  });
}

export async function discoverRuntimeSource() {
  const testRoot = process.env.NODE_ENV === "test" ? process.env.AGENTIC_CORE_TEST_RUNTIME_ROOT : undefined;
  if (testRoot) return inspectRuntimeRoot(testRoot);

  let executingPackage;
  try {
    executingPackage = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (executingPackage.name !== PRODUCT) return undefined;
  const candidate = path.resolve(packageRoot, "..", "..", "..");
  let candidatePackage;
  try {
    candidatePackage = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (candidatePackage?._npx?.packages?.[0] !== GITHUB_SPEC) return undefined;
  const expectedPackageRoot = path.join(candidate, "node_modules", "@kroxidev", "agentic-core");
  if (await realpath(expectedPackageRoot) !== await realpath(packageRoot)) {
    throw new Error("The executing package does not match the isolated npx runtime root");
  }
  return inspectRuntimeRoot(candidate);
}

// A distributed payload proves its origin and integrity independently of npm's bootstrap layout.
export async function distributedRuntime() {
  const packageManifest = await jsonFile(path.join(packageRoot, "package.json"), "Manifiesto del paquete");
  if (packageManifest.name !== PRODUCT) throw new Error("El paquete no identifica el producto esperado");
  const manifest = await jsonFile(path.join(packageRoot, "dist", "runtime", RUNTIME_PAYLOAD_MANIFEST), "Payload del runtime");
  if (typeof manifest.source !== "string" || !manifest.source.trim() || /[\r\n]/u.test(manifest.source)) {
    throw new Error("El payload no declara un origen válido");
  }
  const runtime = await assembledRuntime(packageRoot, {
    root: packageRoot, source: manifest.source, version: packageManifest.version,
    commit: manifest.commit,
  });
  validateRuntimeOwnership(runtime.manifest);
  return runtime;
}

export function validateRuntimeOwnership(runtime) {
  if (runtime === undefined) return;
  const baseValid = plainObject(runtime)
    && runtime.path === ".agentic-core/runtime"
    && typeof runtime.source === "string" && runtime.source.trim().length > 0 && !/[\r\n]/u.test(runtime.source)
    && (runtime.commit === undefined || /^[0-9a-f]{40}$/u.test(runtime.commit))
    && /^[0-9a-f]{64}$/u.test(runtime.treeSha256)
    && Array.isArray(runtime.bins)
    && runtime.bins.length === BINS.length
    && runtime.bins.every((bin, index) => bin === BINS[index]);
  const formatValid = runtime?.format === undefined
    || (runtime.format === RUNTIME_FORMAT && runtime.manifest === RUNTIME_MANIFEST);
  if (!baseValid || !formatValid) throw new Error("Runtime ownership metadata is invalid");
}

function validatePersistedRuntimeManifest(manifest, runtime, ownerVersion, files) {
  const binsValid = plainObject(manifest?.bins)
    && BINS.every((bin) => manifest.bins[bin] === RUNTIME_BINS[bin])
    && Object.keys(manifest.bins).length === BINS.length;
  const records = manifest?.integrity?.files;
  if (!plainObject(manifest) || manifest.schemaVersion !== 1
    || manifest.product !== PRODUCT || manifest.version !== ownerVersion
    || manifest.format !== RUNTIME_FORMAT || manifest.source !== runtime.source
    || manifest.commit !== runtime.commit || !binsValid
    || manifest?.integrity?.algorithm !== "sha256" || !Array.isArray(records)) {
    throw new Error("The persisted runtime manifest is invalid");
  }
  const expectedPaths = files.map(({ path: filePath }) => filePath)
    .filter((filePath) => filePath !== RUNTIME_MANIFEST);
  if (records.length !== expectedPaths.length
    || new Set(records.map((record) => record?.path)).size !== records.length) {
    throw new Error("The persisted runtime manifest has an invalid file inventory");
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const actual = byPath.get(expectedPaths[index]);
    if (!plainObject(record) || record.path !== expectedPaths[index]
      || record.bytes !== actual?.content.byteLength || record.sha256 !== sha256(actual?.content)) {
      throw new Error(`The persisted runtime manifest failed integrity validation: ${String(record?.path)}`);
    }
  }
}

export async function inspectPersistedRuntime(runtimeRoot, runtime, ownerVersion) {
  validateRuntimeOwnership(runtime);
  const files = await readSafeTree(runtimeRoot, "The persisted runtime");
  const treeSha256 = hashFileTree(files);
  if (treeSha256 !== runtime.treeSha256) {
    throw new Error("The persisted runtime does not match its ownership hash");
  }
  if (runtime.format === undefined) return { treeSha256 };

  const manifestFile = files.find(({ path: filePath }) => filePath === RUNTIME_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(manifestFile?.content.toString("utf8") ?? "");
  } catch (error) {
    throw new Error(`The persisted runtime manifest is invalid: ${error.message}`);
  }
  validatePersistedRuntimeManifest(manifest, runtime, ownerVersion, files);
  return { treeSha256 };
}
