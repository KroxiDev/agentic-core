import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { analyzeSource } from "./ast.js";
import { executeCoverage } from "./coverage.js";
import { analyzePythonSource, executePythonCoverage, findPython } from "./python.js";

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const EXTENSIONS = new Set([...JAVASCRIPT_EXTENSIONS, ".py"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "coverage", "dist", "build", ".git", ".agentic-core"]);
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function sourceFiles(targetPath) {
  const details = await lstat(targetPath);
  if (details.isFile()) return EXTENSIONS.has(path.extname(targetPath).toLowerCase()) ? [targetPath] : [];
  if (!details.isDirectory()) return [];
  const files = [];
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const child = path.join(targetPath, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !entry.name.endsWith(".d.ts")) files.push(child);
  }
  return files;
}
async function configuration(projectRoot) {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectRoot, ".agentic-core", "config.json"), "utf8"));
    const threshold = parsed.quality?.crapThreshold;
    if (typeof threshold !== "number" || threshold < 0) throw new Error("quality.crapThreshold must be a non-negative number");
    return { crapThreshold: threshold };
  } catch (error) { if (error?.code === "ENOENT") return { crapThreshold: 7 }; throw error; }
}
function logicalPath(projectRoot, filePath) { return path.relative(projectRoot, filePath).split(path.sep).join("/"); }
function crap(complexity, coverage) { return complexity ** 2 * (1 - coverage / 100) ** 3 + complexity; }
export async function analyzeQuality({ projectRoot, targets, tool, selection }) {
  const started = process.hrtime.bigint();
  const config = await configuration(projectRoot);
  const paths = [...new Set((await Promise.all(targets.map((target) => sourceFiles(path.resolve(projectRoot, target))))).flat())].sort();
  const languages = new Set(paths.map((filePath) => path.extname(filePath).toLowerCase() === ".py" ? "python" : "javascript-typescript"));
  const language = languages.size > 1 ? "mixed" : languages.values().next().value ?? "javascript-typescript";
  const runtime = language === "python" ? await findPython(projectRoot) : undefined;
  const files = await Promise.all(paths.map(async (filePath) => {
    const source = await readFile(filePath, "utf8");
    const symbols = language === "python" && runtime ? await analyzePythonSource(runtime, projectRoot, filePath)
      : language === "javascript-typescript" ? analyzeSource(filePath, source) : [];
    return { path: filePath, source, hash: sha256(source), symbols };
  }));
  const coverage = language === "python" && runtime ? await executePythonCoverage(runtime, projectRoot, files)
    : language === "javascript-typescript" ? await executeCoverage(projectRoot, files)
      : { attributable: new Set(), coveredByFile: new Map(), backend: "unavailable", runner: null };
  const details = [];
  const unsupported = [];
  for (const file of files) {
    const key = path.resolve(file.path).toLowerCase();
    if (!coverage.attributable.has(key)) { unsupported.push(logicalPath(projectRoot, file.path)); continue; }
    const coveredLines = coverage.coveredByFile.get(key) ?? new Set();
    for (const symbol of file.symbols) {
      const requested = selection?.get(logicalPath(projectRoot, file.path));
      if (requested?.size > 0 && !requested.has(symbol.name)) continue;
      const covered = symbol.executableLines.filter((line) => coveredLines.has(line)).length;
      const coveragePercentage = symbol.executableLines.length === 0 ? 100 : covered / symbol.executableLines.length * 100;
      const score = crap(symbol.complexity, coveragePercentage);
      details.push({ file: logicalPath(projectRoot, file.path), symbol: symbol.name,
        location: { startLine: symbol.startLine, endLine: symbol.endLine }, astHash: sha256(symbol.ast), complexity: symbol.complexity,
        coverage: { coveredLines: covered, executableLines: symbol.executableLines.length, percentage: Number(coveragePercentage.toFixed(2)) },
        crap: Number(score.toFixed(4)), threshold: config.crapThreshold, status: score <= config.crapThreshold ? "approved" : "failed" });
    }
  }
  const status = language === "mixed" ? "unsupported_language" : unsupported.length > 0 ? "unsupported_environment"
    : details.some((detail) => detail.status === "failed") ? "failed" : details.length === 0 ? "not_applicable" : "approved";
  return { $schema: "https://kroxidev.dev/agentic-core/quality-report.schema.json", schemaVersion: 1, tool, status,
    language, backend: coverage.backend ?? "v8", runner: coverage.runner,
    hashes: { inputs: Object.fromEntries(files.map((file) => [logicalPath(projectRoot, file.path), file.hash])), configuration: sha256(JSON.stringify(config)) },
    targets: targets.map((target) => path.normalize(target).split(path.sep).join("/")),
    summary: { symbols: details.length, approved: details.filter((item) => item.status === "approved").length,
      failed: details.filter((item) => item.status === "failed").length,
      maximumCrap: details.length ? Math.max(...details.map((item) => item.crap)) : null, unsupportedFiles: unsupported },
    details, durationMs: Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3)) };
}
