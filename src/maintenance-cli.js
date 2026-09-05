import { createInterface } from "node:readline/promises";
import {
  formatMaintenanceResult,
  writeCommandResult,
} from "./cli-output.js";
import { doctorInstallation } from "./doctor.js";
import { initialize, uninstallInstallation, updateInstallation } from "./init.js";
import { getVersion } from "./version.js";
import { runInstallationCli } from "./installation/cli.js";

const HELP = `Usage:
  agentic-core init [directory] [--replace-conflicts] [--dry-run]
  agentic-core update [directory] [--force] [--dry-run]
  agentic-core uninstall [directory] [--dry-run] [--force]
  agentic-core doctor [directory] [--repair] [--dry-run]
  agentic-core --version
  agentic-core --help`;

export async function runMaintenanceCli(args, io = process) {
  const result = await runInstallationCli(args, io);
  return result ?? runLegacyMaintenanceCli(args, io);
}

export async function runLegacyMaintenanceCli(args, io = process) {
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
      if (option !== "--replace-conflicts" && option !== "--dry-run") {
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

  io.stderr.write(`Unknown command: ${args[0]}\n`);
  return 2;
}
