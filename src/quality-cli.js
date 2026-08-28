import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeQuality } from "./quality/crap.js";
import { analyzeMutation } from "./quality/mutation.js";
import { getVersion } from "./version.js";

const HELP = `Usage:
  agentic-quality scan (--run <id> | --target <path>)
  agentic-quality crap (--run <id> | --target <path>)
  agentic-quality mutate (--run <id> | --target <path>)
  agentic-quality mutation (--run <id> | --target <path>)  alias for mutate
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
  if (args.length !== 2 || !["--run", "--target"].includes(args[0]) || !args[1] || args[1].startsWith("-")) {
    throw new Error("Exactly one source is required: --run <id> or --target <path>");
  }
  return { kind: args[0].slice(2), value: args[1] };
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
  try {
    const source = parseSource(args.slice(1));
    const resolved = await resolveSource(process.cwd(), source);
    const report = command === "mutate"
      ? await analyzeMutation({ projectRoot: process.cwd(), ...resolved })
      : await analyzeQuality({ projectRoot: process.cwd(), ...resolved, tool: command });
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT[report.status] ?? 5;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError || /required|must|not found|does not declare|resolved no/i.test(error.message)) {
      io.stderr.write(`${error.message}\n`);
      return 4;
    }
    throw error;
  }
}
