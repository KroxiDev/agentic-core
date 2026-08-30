import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import {
  formatMaintenanceResult,
  formatOrchestrationResult,
  writeCommandResult,
} from "./cli-output.js";
import { doctorInstallation } from "./doctor.js";
import { initialize, uninstallInstallation, updateInstallation } from "./init.js";
import {
  approveModeChange,
  resumeOrchestration,
  startOrchestration,
  submitRawHandoff,
} from "./orchestration.js";
import { getVersion } from "./version.js";

const HELP = `Usage:
  agentic-core init [directory] [--yes] [--replace-conflicts] [--dry-run]
  agentic-core update [directory] [--force] [--dry-run]
  agentic-core uninstall [directory] [--dry-run] [--force]
  agentic-core doctor [directory] [--repair] [--dry-run]
  agentic-core start [--input <path>]
  agentic-core resume [--run <id>]
  agentic-core approve-mode-change --run <id> --to <normal|full>
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
    const optionArguments = args.slice(1).filter((argument) => argument.startsWith("-"));
    const options = new Set(optionArguments);
    if (options.size !== optionArguments.length) {
      io.stderr.write("An option was specified more than once\n");
      return 2;
    }
    for (const option of options) {
      if (option !== "--yes" && option !== "--replace-conflicts" && option !== "--dry-run") {
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
      dryRun: options.has("--dry-run"),
      replaceConflicts: options.has("--replace-conflicts"),
    });
    if (result.dryRun) {
      writeCommandResult(
        io,
        () => formatMaintenanceResult("init", result),
        `${JSON.stringify(result.plan, null, 2)}\n`,
      );
      return result.exitCode;
    }
    writeCommandResult(
      io,
      () => formatMaintenanceResult("init", result),
      `Installed agentic-core ${result.version} in ${result.projectRoot}\n`,
    );
    return 0;
  }

  if (args[0] === "update") {
    const optionArguments = args.slice(1).filter((argument) => argument.startsWith("-"));
    const options = new Set(optionArguments);
    if (options.size !== optionArguments.length) {
      io.stderr.write("An option was specified more than once\n");
      return 2;
    }
    for (const option of options) {
      if (option !== "--force" && option !== "--dry-run") {
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
      dryRun: options.has("--dry-run"),
      force: options.has("--force"),
    });
    if (result.dryRun) {
      writeCommandResult(
        io,
        () => formatMaintenanceResult("update", result),
        `${JSON.stringify(result.plan, null, 2)}\n`,
      );
      return result.exitCode;
    }
    writeCommandResult(
      io,
      () => formatMaintenanceResult("update", result),
      `Updated agentic-core ${result.version} in ${result.projectRoot}\n`,
    );
    return 0;
  }

  if (args[0] === "uninstall") {
    const optionArguments = args.slice(1).filter((argument) => argument.startsWith("-"));
    const options = new Set(optionArguments);
    if (options.size !== optionArguments.length) {
      io.stderr.write("An option was specified more than once\n");
      return 2;
    }
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
      const structuredOutput = [
        ...result.actions.map((action) => `${prefix} ${action}`),
        ...result.preserved.map((item) => `Preserved ${item}`),
      ];
      writeCommandResult(
        io,
        () => formatMaintenanceResult("uninstall", result),
        structuredOutput.length > 0 ? `${structuredOutput.join("\n")}\n` : "",
      );
      return 0;
    } finally {
      prompt?.close();
    }
  }

  if (args[0] === "doctor") {
    const optionArguments = args.slice(1).filter((argument) => argument.startsWith("-"));
    const options = new Set(optionArguments);
    if (options.size !== optionArguments.length) {
      io.stderr.write("An option was specified more than once\n");
      return 2;
    }
    for (const option of options) {
      if (option !== "--repair" && option !== "--dry-run") {
        io.stderr.write(`Unknown option: ${option}\n`);
        return 2;
      }
    }
    const directories = args.slice(1).filter((argument) => !argument.startsWith("-"));
    if (directories.length > 1) {
      io.stderr.write("doctor accepts at most one directory\n");
      return 2;
    }
    const result = await doctorInstallation(directories[0] ?? process.cwd(), {
      dryRun: options.has("--dry-run"),
      repair: options.has("--repair"),
    });
    writeCommandResult(
      io,
      () => formatMaintenanceResult("doctor", result),
      `${JSON.stringify(result.report, null, 2)}\n`,
    );
    return result.exitCode;
  }

  if (args[0] === "start") {
    const inputIndex = args.indexOf("--input");
    if ((inputIndex === -1 && args.length !== 1)
      || (inputIndex !== -1 && (inputIndex !== 1 || !args[2] || args.length !== 3))) {
      io.stderr.write("Usage: agentic-core start [--input <path>]\n");
      return 2;
    }
    const input = inputIndex === -1 ? await readAll(io.stdin) : await readFile(args[2]);
    const payload = JSON.parse(decodeUtf8(input));
    if (!plainObject(payload)) throw new TypeError("Start input must be a JSON object");
    for (const field of ["changesExecutableBehavior", "planningNeedsHowDecision"]) {
      if (payload[field] !== undefined && typeof payload[field] !== "boolean") {
        throw new TypeError(`${field} must be a boolean when provided`);
      }
    }
    const result = await startOrchestration({
      projectRoot: process.cwd(),
      request: payload.request,
      intention: payload.intention,
      changesExecutableBehavior: payload.changesExecutableBehavior,
      planningNeedsHowDecision: payload.planningNeedsHowDecision,
    });
    writeCommandResult(
      io,
      () => formatOrchestrationResult("start", result),
      `${JSON.stringify(result)}\n`,
    );
    return 0;
  }

  if (args[0] === "resume") {
    if (args.length !== 1 && (args.length !== 3 || args[1] !== "--run" || !args[2])) {
      io.stderr.write("Usage: agentic-core resume [--run <id>]\n");
      return 2;
    }
    const result = await resumeOrchestration({
      projectRoot: process.cwd(),
      runId: args[2],
    });
    writeCommandResult(
      io,
      () => formatOrchestrationResult("resume", result),
      `${JSON.stringify(result)}\n`,
    );
    return 0;
  }

  if (args[0] === "approve-mode-change") {
    if (args.length !== 5 || args[1] !== "--run" || !args[2]
      || args[3] !== "--to" || !["normal", "full"].includes(args[4])) {
      io.stderr.write("Usage: agentic-core approve-mode-change --run <id> --to <normal|full>\n");
      return 2;
    }
    const result = await approveModeChange({
      projectRoot: process.cwd(),
      runId: args[2],
      targetMode: args[4],
      approved: true,
    });
    writeCommandResult(
      io,
      () => formatOrchestrationResult("approve-mode-change", result),
      `${JSON.stringify(result)}\n`,
    );
    return 0;
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
    const response = inputIndex === -1 ? await readAll(io.stdin) : await readFile(args[4]);
    const result = await submitRawHandoff({ projectRoot: process.cwd(), runId: args[2], response });
    writeCommandResult(
      io,
      () => formatOrchestrationResult("submit-handoff", result),
      `${JSON.stringify(result)}\n`,
    );
    return result.status === "failed" ? 1 : 0;
  }

  io.stderr.write(`Unknown command: ${args[0]}\n`);
  return 2;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function decodeUtf8(content) {
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
