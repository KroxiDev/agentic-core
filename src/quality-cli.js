import path from "node:path";
import { formatQualityResult, writeCommandResult } from "./cli-output.js";
import { analyzeQuality } from "./quality/crap.js";
import { analyzeMutation } from "./quality/mutation.js";
import {
  prepareQualitySession,
  QualitySessionError,
  verifyQualitySession,
} from "./quality/session.js";
import { getVersion } from "./version.js";

const HELP = `Usage:
  agentic-quality scan --target <path>
  agentic-quality crap --target <path>
  agentic-quality mutate --target <path>
  agentic-quality mutation --target <path>  alias for mutate
  agentic-quality prepare --mode <light|normal|full> --scope <path> [--scope <path>...]
  agentic-quality verify --session <id>
  agentic-quality --version
  agentic-quality --help

Exit codes:
  0 approved or not applicable
  1 quality gate failed
  2 unsupported environment or language
  3 baseline failed
  4 invalid usage, scope, or session
  5 internal or restoration error`;

const EXIT = {
  approved: 0,
  not_applicable: 0,
  failed: 1,
  unsupported_environment: 2,
  unsupported_language: 2,
  baseline_failed: 3,
  restoration_failure: 5,
};

function parseTarget(args) {
  if (args.length !== 2 || args[0] !== "--target" || !args[1] || args[1].startsWith("-")) {
    throw new QualitySessionError("Exactly one --target <path> is required", 4);
  }
  return args[1];
}

function resolveTarget(projectRoot, target) {
  const resolved = path.resolve(projectRoot, target);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new QualitySessionError("Target must be inside the project", 4);
  }
  return target;
}

function parsePrepare(args) {
  let mode;
  const scopes = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new QualitySessionError("prepare accepts only --mode <mode> and repeated --scope <path>", 4);
    }
    if (flag === "--mode" && mode === undefined) mode = value;
    else if (flag === "--scope") scopes.push(value);
    else throw new QualitySessionError("prepare accepts only one --mode and repeated --scope values", 4);
  }
  if (mode === undefined) throw new QualitySessionError("prepare requires --mode <light|normal|full>", 4);
  if (scopes.length === 0) throw new QualitySessionError("prepare requires at least one --scope <path>", 4);
  return { mode, scopes };
}

function parseVerify(args) {
  if (args.length !== 2 || args[0] !== "--session" || !args[1] || args[1].startsWith("-")) {
    throw new QualitySessionError("verify requires exactly one --session <id>", 4);
  }
  return args[1];
}

function writeSessionResult(io, result) {
  if (io.env?.AGENTIC_CORE_OUTPUT === "json") {
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.command === "prepare") {
    io.stdout.write(`QUALITY_SESSION id=${result.id} mode=${result.mode} baseline=${result.baseline}\n`);
    return;
  }
  io.stdout.write(`${result.receipt}\n`);
}

async function runIndependentQuality(command, args, io) {
  const target = resolveTarget(process.cwd(), parseTarget(args));
  const report = command === "mutate"
    ? await analyzeMutation({ projectRoot: process.cwd(), targets: [target] })
    : await analyzeQuality({ projectRoot: process.cwd(), targets: [target], tool: command });
  writeCommandResult(
    io,
    () => formatQualityResult(command, report),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return EXIT[report.status] ?? 5;
}

export async function runQualityCli(args, io = process) {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
    io.stdout.write(`${await getVersion()}\n`);
    return 0;
  }
  const command = args[0] === "mutation" ? "mutate" : args[0];
  try {
    if (["scan", "crap", "mutate"].includes(command)) {
      return await runIndependentQuality(command, args.slice(1), io);
    }
    if (command === "prepare") {
      const result = await prepareQualitySession({
        projectRoot: process.cwd(),
        ...parsePrepare(args.slice(1)),
      });
      writeSessionResult(io, result);
      return 0;
    }
    if (command === "verify") {
      const { result, exitCode } = await verifyQualitySession({
        projectRoot: process.cwd(),
        id: parseVerify(args.slice(1)),
      });
      writeSessionResult(io, result);
      return exitCode;
    }
    throw new QualitySessionError(`Unknown command: ${command}`, 4);
  } catch (error) {
    if (error instanceof QualitySessionError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    if (error?.code === "ENOENT" || error instanceof SyntaxError
      || /required|must|not found|resolved no/i.test(error.message)) {
      io.stderr.write(`${error.message}\n`);
      return 4;
    }
    throw error;
  }
}
