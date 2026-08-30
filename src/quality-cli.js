import { createHash } from "node:crypto";
import { access, readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { formatQualityResult, writeCommandResult } from "./cli-output.js";
import { analyzeQuality } from "./quality/crap.js";
import { analyzeMutation } from "./quality/mutation.js";
import { getVersion } from "./version.js";
import { writeTransaction } from "./transaction.js";

const HELP = `Usage:
  agentic-quality scan (--run <id> | --target <path>) [--output artifacts/<file>.json]
  agentic-quality crap (--run <id> | --target <path>) [--output artifacts/<file>.json]
  agentic-quality mutate (--run <id> | --target <path>) [--output artifacts/<file>.json]
  agentic-quality mutation (--run <id> | --target <path>) [--output artifacts/<file>.json]  alias for mutate
  agentic-quality --version
  agentic-quality --help

Exit codes:
  0 approved or not applicable
  1 quality gate failed
  2 unsupported environment or language
  3 baseline failed
  4 invalid usage or configuration
  5 internal or restoration error`;

const EXIT = { approved: 0, not_applicable: 0, failed: 1, unsupported_environment: 2, unsupported_language: 2,
  baseline_failed: 3, restoration_failure: 5 };

function parseSource(args) {
  if (args.length < 2 || !["--run", "--target"].includes(args[0]) || !args[1] || args[1].startsWith("-")) {
    throw new Error("Exactly one source is required: --run <id> or --target <path>");
  }
  const remaining = args.slice(2);
  if (remaining.length === 0) return { kind: args[0].slice(2), value: args[1] };
  if (remaining.length !== 2 || remaining[0] !== "--output" || !remaining[1]) {
    throw new Error("Output must be declared once as --output artifacts/<file>.json");
  }
  return { kind: args[0].slice(2), value: args[1], output: remaining[1] };
}
function artifactOutput(projectRoot, source) {
  if (source.output === undefined) return undefined;
  if (source.kind !== "run") throw new Error("--output requires --run <id>");
  const logicalPath = source.output.split("\\").join("/");
  if (!/^artifacts\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(logicalPath)) {
    throw new Error("Output must be a JSON file directly under the run artifacts directory");
  }
  const runRoot = path.join(projectRoot, ".agentic-core", "runs", source.value);
  return { logicalPath, absolutePath: path.join(runRoot, ...logicalPath.split("/")) };
}
function targetsFromState(state) {
  const raw = state.quality?.targets ?? state.qualityTargets ?? state.targets ?? state.plan?.qualityTargets;
  if (!Array.isArray(raw)) throw new Error("Run state does not declare quality targets");
  const equivalents = state.quality?.equivalents ?? state.equivalents ?? [];
  if (!Array.isArray(equivalents)) throw new Error("Run state quality equivalents must be an array");
  const targets = [];
  const selection = new Map();
  for (const item of raw) {
    const file = typeof item === "string" ? item : item.path ?? item.file;
    if (!file) continue;
    targets.push(file);
    const names = typeof item === "object" ? item.symbols ?? (item.symbol ? [item.symbol] : []) : [];
    if (names.length > 0) selection.set(file.split(path.sep).join("/"), new Set(names));
  }
  if (targets.length === 0) throw new Error("Run state does not declare quality targets");
  const baseline = state.quality?.baselineReport ?? state.qualityBaselineReport;
  return { targets, selection, equivalents, baseline };
}
async function resolveSource(projectRoot, source) {
  if (source.kind === "target") {
    const resolvedTarget = path.resolve(projectRoot, source.value);
    const relativeTarget = path.relative(projectRoot, resolvedTarget);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) throw new Error("Target must be inside the project");
    return { targets: [source.value] };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(source.value)) throw new Error("Run id is invalid");
  const candidates = [
    path.join(projectRoot, ".agentic-core", "runs", source.value, "state.json"),
    path.join(projectRoot, ".agentic-core", "runs", `${source.value}.json`),
  ];
  for (const candidate of candidates) {
    try { return targetsFromState(JSON.parse(await readFile(candidate, "utf8"))); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  throw new Error(`Run not found: ${source.value}`);
}
async function exists(targetPath) {
  try { await access(targetPath); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
export async function runQualityCli(args, io = process) {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (args.includes("--version") || args.includes("-v")) {
    io.stdout.write(`${await getVersion()}\n`);
    return 0;
  }
  const command = args[0] === "mutation" ? "mutate" : args[0];
  if (!["scan", "crap", "mutate"].includes(command)) {
    io.stderr.write(`Unknown command: ${command}\n`);
    return 4;
  }
  let temporaryRoot;
  let temporaryRootExisted = true;
  try {
    const source = parseSource(args.slice(1));
    const output = artifactOutput(process.cwd(), source);
    const resolved = await resolveSource(process.cwd(), source);
    temporaryRoot = output ? path.dirname(output.absolutePath) : undefined;
    if (temporaryRoot) temporaryRootExisted = await exists(temporaryRoot);
    const report = command === "mutate"
      ? await analyzeMutation({ projectRoot: process.cwd(), ...resolved, temporaryRoot })
      : await analyzeQuality({ projectRoot: process.cwd(), ...resolved, tool: command, temporaryRoot });
    if (output) {
      const content = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
      await writeTransaction(process.cwd(), [{ path: output.absolutePath, content }], { temporaryRoot });
      const reference = {
        path: output.logicalPath,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
      writeCommandResult(
        io,
        () => formatQualityResult(command, reference),
        `${JSON.stringify(reference)}\n`,
      );
    } else {
      writeCommandResult(
        io,
        () => formatQualityResult(command, report),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    return EXIT[report.status] ?? 5;
  } catch (error) {
    if (temporaryRoot && !temporaryRootExisted) {
      try { await rmdir(temporaryRoot); }
      catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT" && cleanupError?.code !== "ENOTEMPTY") {
          throw new Error(`Quality execution failed and temporary cleanup was incomplete: ${cleanupError.message}`,
            { cause: error });
        }
      }
    }
    if (error?.code === "ENOENT" || error instanceof SyntaxError || /required|must|not found|does not declare|resolved no/i.test(error.message)) {
      io.stderr.write(`${error.message}\n`);
      return 4;
    }
    throw error;
  }
}
