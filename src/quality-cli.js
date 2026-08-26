import { getVersion } from "./version.js";

const HELP = `Usage:
  agentic-quality scan (--run <id> | --target <path>)
  agentic-quality crap (--run <id> | --target <path>)
  agentic-quality mutation (--run <id> | --target <path>)
  agentic-quality --version
  agentic-quality --help`;

export async function runQualityCli(args, io = process) {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (args.includes("--version") || args.includes("-v")) {
    io.stdout.write(`${await getVersion()}\n`);
    return 0;
  }

  io.stderr.write(`Unknown command: ${args[0]}\n`);
  return 2;
}
