import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PRODUCT = "@kroxidev/agentic-core";
const BINARIES = new Map([
  ["agentic-core", "bin/agentic-core.js"],
  ["agentic-quality", "bin/agentic-quality.js"],
]);

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (!BINARIES.has(command)) throw new Error(`Unsupported agentic runtime seam: ${String(command)}`);
  const projectRoot = path.resolve(process.cwd());
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(projectRoot, ".agentic-core", "ownership.json"), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read agentic-core ownership: ${error.message}`);
  }
  if (manifest.product !== PRODUCT) throw new Error("The selected project is not owned by agentic-core");
  const packageDirectory = manifest.runtime?.path === ".agentic-core/runtime"
    ? path.join(projectRoot, ".agentic-core", "runtime", "node_modules", "@kroxidev", "agentic-core")
    : path.join(projectRoot, "node_modules", "@kroxidev", "agentic-core");
  const binary = path.join(packageDirectory, ...BINARIES.get(command).split("/"));
  const child = spawn(process.execPath, [binary, ...args], {
    cwd: projectRoot,
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
