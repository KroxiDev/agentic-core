import { access } from "node:fs/promises";

const runtimeUrl = new URL("../dist/runtime/agentic-core.mjs", import.meta.url);

async function generatedRuntimeExists() {
  try {
    await access(runtimeUrl);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function runBinary(command) {
  process.argv.splice(2, 0, command);
  if (!await generatedRuntimeExists()) {
    console.error([
      "agentic-core: generated runtime is missing.",
      'Run "npm install" from the repository root, then try again.',
      'If dependencies are already installed, run "npm run build:runtime".',
    ].join("\n"));
    process.exitCode = 1;
    return;
  }
  await import(runtimeUrl.href);
}
