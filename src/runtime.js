import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashDirectory } from "./transaction.js";

const PRODUCT = "@kroxidev/agentic-core";
const GITHUB_SPEC = "github:KroxiDev/agentic-core";
const BIN_PATHS = new Map([
  ["agentic-core", "bin/agentic-core.js"],
  ["agentic-quality", "bin/agentic-quality.js"],
]);
const BINS = [...BIN_PATHS.keys()];
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

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
  if (installedPackage.name !== PRODUCT
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
  return {
    root,
    manifest: {
      path: ".agentic-core/runtime",
      source: `${GITHUB_SPEC}#${commit}`,
      commit,
      treeSha256: await hashDirectory(root),
      bins: [...BINS],
    },
  };
}

export async function discoverRuntimeSource() {
  const testRoot = process.env.NODE_ENV === "test" ? process.env.AGENTIC_CORE_TEST_RUNTIME_ROOT : undefined;
  if (testRoot) return inspectRuntimeRoot(testRoot);

  const candidate = path.resolve(packageRoot, "..", "..", "..");
  const candidatePackagePath = path.join(candidate, "package.json");
  let candidatePackage;
  try {
    candidatePackage = JSON.parse(await readFile(candidatePackagePath, "utf8"));
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

export function validateRuntimeOwnership(runtime) {
  if (runtime === undefined) return;
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)
    || runtime.path !== ".agentic-core/runtime"
    || !/^github:KroxiDev\/agentic-core#[0-9a-f]{40}$/u.test(runtime.source)
    || !/^[0-9a-f]{40}$/u.test(runtime.commit)
    || runtime.source !== `${GITHUB_SPEC}#${runtime.commit}`
    || !/^[0-9a-f]{64}$/u.test(runtime.treeSha256)
    || !Array.isArray(runtime.bins)
    || runtime.bins.length !== BINS.length
    || runtime.bins.some((bin, index) => bin !== BINS[index])) {
    throw new Error("Runtime ownership metadata is invalid");
  }
}
