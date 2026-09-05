import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  PRODUCT,
  RUNTIME_BINS,
  RUNTIME_FORMAT,
  RUNTIME_PAYLOAD_COPIES,
  RUNTIME_PAYLOAD_MANIFEST,
} from "../src/runtime-layout.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDirectory = path.join(repositoryRoot, "dist", "runtime");

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function replaceGeneratedDirectory(stagingDirectory, outputDirectory) {
  const resolvedOutput = path.resolve(outputDirectory);
  const root = path.parse(resolvedOutput).root;
  if (resolvedOutput === root || resolvedOutput === repositoryRoot) {
    throw new Error(`Refusing to replace unsafe build output: ${resolvedOutput}`);
  }
  try {
    const details = await lstat(resolvedOutput);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`Build output is not a safe directory: ${resolvedOutput}`);
    }
    let marker;
    try {
      marker = JSON.parse(await readFile(path.join(resolvedOutput, RUNTIME_PAYLOAD_MANIFEST), "utf8"));
    } catch (error) {
      throw new Error(`Refusing to replace unowned build output: ${resolvedOutput}`, { cause: error });
    }
    if (marker?.type !== "agentic-core-runtime-payload" || marker.product !== PRODUCT) {
      throw new Error(`Refusing to replace unowned build output: ${resolvedOutput}`);
    }
    await rm(resolvedOutput, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename(stagingDirectory, resolvedOutput);
}

function dependencyBytes(metafile) {
  let bytes = 0;
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs)) {
      const logical = input.replaceAll("\\", "/");
      if (logical.startsWith("node_modules/typescript/") || logical.includes("/node_modules/typescript/")
        || logical.startsWith("node_modules/@jridgewell/") || logical.includes("/node_modules/@jridgewell/")) {
        bytes += contribution.bytesInOutput;
      }
    }
  }
  return bytes;
}

export async function buildRuntimePayload(outputDirectory = defaultOutputDirectory) {
  const output = path.resolve(outputDirectory);
  await mkdir(path.dirname(output), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(output), ".agentic-core-runtime-build-"));
  let published = false;
  try {
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
    const result = await build({
      absWorkingDir: repositoryRoot,
      entryPoints: ["src/runtime-entry.mjs"],
      outfile: path.join(staging, RUNTIME_BINS["agentic-core"]),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      minify: true,
      sourcemap: false,
      legalComments: "eof",
      charset: "utf8",
      banner: {
        js: 'import { createRequire as __agenticCoreCreateRequire } from "node:module"; import { dirname as __agenticCoreDirname } from "node:path"; import { fileURLToPath as __agenticCoreFileURLToPath } from "node:url"; const require = __agenticCoreCreateRequire(import.meta.url); const __filename = __agenticCoreFileURLToPath(import.meta.url); const __dirname = __agenticCoreDirname(__filename);',
      },
      metafile: true,
      define: {
        __AGENTIC_CORE_BUNDLED_RUNTIME__: "true",
        __AGENTIC_CORE_VERSION__: JSON.stringify(packageJson.version),
      },
    });

    for (const { source, target } of RUNTIME_PAYLOAD_COPIES) {
      const content = await readFile(path.join(repositoryRoot, ...source.split("/")));
      const targetPath = path.join(staging, ...target.split("/"));
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, { flag: "wx" });
    }

    const payloadPaths = [RUNTIME_BINS["agentic-core"], ...RUNTIME_PAYLOAD_COPIES.map(({ target }) => target)]
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const files = [];
    for (const filePath of payloadPaths) {
      const content = await readFile(path.join(staging, ...filePath.split("/")));
      files.push({ path: filePath, bytes: content.byteLength, sha256: sha256(content) });
    }
    const payloadManifest = {
      schemaVersion: 1,
      type: "agentic-core-runtime-payload",
      product: PRODUCT,
      version: packageJson.version,
      source: `npm:${packageJson.name}@${packageJson.version}`,
      format: RUNTIME_FORMAT,
      bins: RUNTIME_BINS,
      integrity: { algorithm: "sha256", files },
    };
    await writeFile(path.join(staging, RUNTIME_PAYLOAD_MANIFEST), json(payloadManifest), { flag: "wx" });

    const manifestBytes = Buffer.byteLength(json(payloadManifest));
    const bundledDependencyBytes = dependencyBytes(result.metafile);
    const legalDependencyBytes = files
      .filter(({ path: filePath }) => filePath.startsWith("third_party/"))
      .reduce((total, file) => total + file.bytes, 0);
    const metrics = {
      output,
      files: files.length + 1,
      bytes: files.reduce((total, file) => total + file.bytes, manifestBytes),
      dependencyBytes: bundledDependencyBytes + legalDependencyBytes,
      bundleBytes: files.find(({ path: filePath }) => filePath === RUNTIME_BINS["agentic-core"]).bytes,
    };

    await replaceGeneratedDirectory(staging, output);
    published = true;
    return metrics;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

function optionsFromArguments(args) {
  const quiet = args.includes("--quiet");
  const remaining = args.filter((argument) => argument !== "--quiet");
  if (remaining.length === 0) return { output: defaultOutputDirectory, quiet };
  if (remaining.length === 2 && remaining[0] === "--output" && remaining[1]) {
    return { output: path.resolve(remaining[1]), quiet };
  }
  throw new Error("Usage: node scripts/build-runtime.mjs [--output <directory>] [--quiet]");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = optionsFromArguments(process.argv.slice(2));
    const metrics = await buildRuntimePayload(options.output);
    if (!options.quiet) process.stdout.write(json(metrics));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
