import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { initialize, uninstallInstallation, updateInstallation } from "./init.js";
import { submitRawHandoff } from "./orchestration.js";
import { getVersion } from "./version.js";

const HELP = `Usage:
  agentic-core init [directory] [--yes] [--replace-conflicts]
  agentic-core update [directory] [--force]
  agentic-core uninstall [directory] [--dry-run] [--force]
  agentic-core doctor [directory]
  agentic-core submit-handoff --run <id> [--input <path>]
  agentic-core --version
  agentic-core --help`;

export async function runMaintenanceCli(args, io = process) {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (args.includes("--version") || args.includes("-v")) {
    io.stdout.write(`${await getVersion()}\n`);
    return 0;
  }

  if (args[0] === "init") {
    const options = new Set(args.slice(1).filter((argument) => argument.startsWith("-")));
    for (const option of options) {
      if (option !== "--yes" && option !== "--replace-conflicts") {
        io.stderr.write(`Unknown option: ${option}\n`);
        return 2;
      }
    }
    const directories = args.slice(1).filter((argument) => !argument.startsWith("-"));
    if (directories.length > 1) {
      io.stderr.write("init accepts at most one directory\n");
      return 2;
    }
    const result = await initialize(directories[0] ?? process.cwd(), {
      replaceConflicts: options.has("--replace-conflicts"),
    });
    io.stdout.write(`Installed agentic-core ${result.version} in ${result.projectRoot}\n`);
    return 0;
  }

  if (args[0] === "update") {
    const options = new Set(args.slice(1).filter((argument) => argument.startsWith("-")));
    for (const option of options) {
      if (option !== "--force") {
        io.stderr.write(`Unknown option: ${option}\n`);
        return 2;
      }
    }
    const directories = args.slice(1).filter((argument) => !argument.startsWith("-"));
    if (directories.length > 1) {
      io.stderr.write("update accepts at most one directory\n");
      return 2;
    }
    const result = await updateInstallation(directories[0] ?? process.cwd(), {
      force: options.has("--force"),
    });
    io.stdout.write(`Updated agentic-core ${result.version} in ${result.projectRoot}\n`);
    return 0;
  }

  if (args[0] === "uninstall") {
    const options = new Set(args.slice(1).filter((argument) => argument.startsWith("-")));
    for (const option of options) {
      if (option !== "--dry-run" && option !== "--force") {
        io.stderr.write(`Unknown option: ${option}\n`);
        return 2;
      }
    }
    const directories = args.slice(1).filter((argument) => !argument.startsWith("-"));
    if (directories.length > 1) {
      io.stderr.write("uninstall accepts at most one directory\n");
      return 2;
    }
    const interactive = io.stdin?.isTTY === true && io.stdout?.isTTY === true && !options.has("--dry-run");
    let prompt;
    try {
      const result = await uninstallInstallation(directories[0] ?? process.cwd(), {
        dryRun: options.has("--dry-run"),
        force: options.has("--force"),
        confirmDivergence: async ({ kind, path: ownedPath }) => {
          if (!interactive) return false;
          prompt ??= createInterface({ input: io.stdin, output: io.stdout });
          const answer = await prompt.question(`Remove divergent ${kind} ${ownedPath}? [y/N] `);
          return /^(?:y|yes)$/i.test(answer.trim());
        },
      });
      const prefix = result.dryRun ? "Would remove" : "Removed";
      for (const action of result.actions) io.stdout.write(`${prefix} ${action}\n`);
      for (const item of result.preserved) io.stdout.write(`Preserved ${item}\n`);
      return 0;
    } finally {
      prompt?.close();
    }
  }

  if (args[0] === "submit-handoff") {
    const runIndex = args.indexOf("--run");
    const inputIndex = args.indexOf("--input");
    const expectedLength = inputIndex === -1 ? 3 : 5;
    if (runIndex !== 1 || !args[2] || args.length !== expectedLength
      || (inputIndex !== -1 && (inputIndex !== 3 || !args[4]))) {
      io.stderr.write("Usage: agentic-core submit-handoff --run <id> [--input <path>]\n");
      return 2;
    }
    const response = inputIndex === -1 ? await readAll(io.stdin) : await readFile(args[4], "utf8");
    const result = await submitRawHandoff({ projectRoot: process.cwd(), runId: args[2], response });
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "failed" ? 1 : 0;
  }

  io.stderr.write(`Unknown command: ${args[0]}\n`);
  return 2;
}

async function readAll(stream) {
  let content = "";
  stream.setEncoding?.("utf8");
  for await (const chunk of stream) content += chunk;
  return content;
}
