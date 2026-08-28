import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { analyzeSource } from "./ast.js";
import { executeCoverage } from "./coverage.js";
import { qualityInputInventory } from "./inputs.js";
import {
  analyzePythonSource,
  executePythonCoverage,
  findPython,
} from "./python.js";

const JS = new Set([
  ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx", ".mts", ".cts",
]);
const EXTENSIONS = new Set([...JS, ".py"]);
const IGNORED = new Set([
  "node_modules", "coverage", "dist", "build",
  ".git", ".agentic-core",
]);
const DIFFERENTIAL_THRESHOLD = 7;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function logicalPath(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}
function crap(complexity, coverage) {
  return complexity ** 2 * (1 - coverage / 100) ** 3 + complexity;
}
async function sourceFiles(targetPath) {
  const details = await lstat(targetPath);
  if (details.isFile()) {
    return EXTENSIONS.has(path.extname(targetPath).toLowerCase())
      ? [targetPath]
      : [];
  }
  if (!details.isDirectory()) return [];
  const files = [];
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
    const child = path.join(targetPath, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (entry.isFile()
      && EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      && !entry.name.endsWith(".d.ts")) files.push(child);
  }
  return files;
}
async function configuration(projectRoot) {
  try {
    const configPath = path.join(
      projectRoot,
      ".agentic-core",
      "config.json",
    );
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    const threshold = parsed.quality?.crapThreshold;
    if (typeof threshold !== "number" || threshold < 0) {
      throw new Error(
        "quality.crapThreshold must be a non-negative number",
      );
    }
    return { crapThreshold: threshold };
  } catch (error) {
    if (error?.code === "ENOENT") return { crapThreshold: 7 };
    throw error;
  }
}
export function identityFor(file, symbol) {
  const identity = {
    file,
    qualifiedName: symbol.qualifiedName ?? symbol.name,
    container: symbol.container ?? "<module>",
    declarationKind: symbol.declarationKind ?? "function",
    disambiguator: symbol.disambiguator ?? "default",
  };
  return {
    ...identity,
    stableId: sha256(JSON.stringify(identity)),
  };
}
function baselineDetail(baseline, stableId) {
  return baseline?.details?.find((detail) =>
    detail.stableId === stableId
    && typeof (detail.current?.crap ?? detail.crap) === "number");
}
function baselineHasFile(baseline, file) {
  return baseline?.inputInventory?.entries?.some((entry) =>
    entry.kind === "target_code" && entry.path === file);
}
function differential(current, prior, baseline, file) {
  if (!baseline) {
    return {
      baseline: { status: "not_requested" },
      delta: null,
      approved: current.crap <= current.threshold,
      rule: "absolute_audit",
    };
  }
  if (prior) {
    const priorCrap = prior.current?.crap ?? prior.crap;
    const limit = priorCrap <= DIFFERENTIAL_THRESHOLD
      ? DIFFERENTIAL_THRESHOLD
      : priorCrap;
    return {
      baseline: {
        status: "attributed",
        crap: priorCrap,
        version: prior.versions?.current ?? {
          location: prior.location,
          astHash: prior.astHash,
        },
      },
      delta: Number((current.crap - priorCrap).toFixed(4)),
      approved: current.crap <= limit,
      rule: priorCrap <= DIFFERENTIAL_THRESHOLD
        ? "existing_at_or_below_seven"
        : "existing_above_seven_must_not_worsen",
    };
  }
  if (baselineHasFile(baseline, file)) {
    return {
      baseline: { status: "new_symbol" },
      delta: null,
      approved: current.crap <= DIFFERENTIAL_THRESHOLD,
      rule: "new_symbol_at_or_below_seven",
    };
  }
  return {
    baseline: {
      status: "not_attributable",
      warning: "No immutable prior value is attributable to this symbol.",
    },
    delta: null,
    approved: true,
    rule: "non_blocking_missing_baseline",
  };
}
function selected(selection, file, symbol, stableId) {
  const requested = selection?.get(file);
  if (!requested?.size) return true;
  return requested.has(symbol.name)
    || requested.has(symbol.qualifiedName)
    || requested.has(stableId);
}

export async function analyzeQuality({
  projectRoot,
  targets,
  tool,
  selection,
  baseline,
}) {
  const started = process.hrtime.bigint();
  const config = await configuration(projectRoot);
  const paths = [
    ...new Set((
      await Promise.all(targets.map((target) =>
        sourceFiles(path.resolve(projectRoot, target))))
    ).flat()),
  ].sort();
  const languages = new Set(paths.map((filePath) =>
    path.extname(filePath).toLowerCase() === ".py"
      ? "python"
      : "javascript-typescript"));
  const language = languages.size > 1
    ? "mixed"
    : languages.values().next().value ?? "javascript-typescript";
  const runtime = language === "python"
    ? await findPython(projectRoot)
    : undefined;
  const files = await Promise.all(paths.map(async (filePath) => {
    const source = await readFile(filePath, "utf8");
    const file = logicalPath(projectRoot, filePath);
    const symbols = language === "python" && runtime
      ? await analyzePythonSource(runtime, projectRoot, filePath)
      : language === "javascript-typescript"
        ? analyzeSource(file, source)
        : [];
    return {
      path: filePath,
      file,
      source,
      symbols,
    };
  }));
  let resolvedSelections = 0;
  for (const file of files) {
    for (const symbol of file.symbols) {
      const { stableId } = identityFor(file.file, symbol);
      if (selected(selection, file.file, symbol, stableId)) {
        resolvedSelections += 1;
      }
    }
  }
  if (selection?.size && resolvedSelections === 0) {
    const error = new Error(
      "Explicit symbol selection resolved no quality targets",
    );
    error.code = "selection_empty";
    throw error;
  }
  const coverage = language === "python" && runtime
    ? await executePythonCoverage(runtime, projectRoot, files)
    : language === "javascript-typescript"
      ? await executeCoverage(projectRoot, files)
      : {
        attributable: new Set(),
        coveredByFile: new Map(),
        backend: "unavailable",
        runner: null,
        commands: [],
      };
  const inputInventory = await qualityInputInventory(
    projectRoot,
    paths,
    coverage.runner,
    coverage.commands ?? [],
  );
  const details = [];
  const unsupported = [];
  for (const file of files) {
    const key = path.resolve(file.path).toLowerCase();
    if (!coverage.attributable.has(key)) {
      unsupported.push(file.file);
      continue;
    }
    const coveredLines = coverage.coveredByFile.get(key) ?? new Set();
    for (const symbol of file.symbols) {
      const identity = identityFor(file.file, symbol);
      if (!selected(selection, file.file, symbol, identity.stableId)) {
        continue;
      }
      const covered = symbol.executableLines.filter((line) =>
        coveredLines.has(line)).length;
      const percentage = symbol.executableLines.length === 0
        ? 100
        : covered / symbol.executableLines.length * 100;
      const score = Number(
        crap(symbol.complexity, percentage).toFixed(4),
      );
      const current = {
        crap: score,
        complexity: symbol.complexity,
        coverage: {
          coveredLines: covered,
          executableLines: symbol.executableLines.length,
          percentage: Number(percentage.toFixed(2)),
        },
      };
      const comparison = differential(
        { ...current, threshold: config.crapThreshold },
        baselineDetail(baseline, identity.stableId),
        baseline,
        file.file,
      );
      details.push({
        file: file.file,
        symbol: symbol.name,
        ...identity,
        versions: {
          current: {
            location: {
              startLine: symbol.startLine,
              endLine: symbol.endLine,
            },
            astHash: sha256(symbol.ast),
          },
        },
        location: {
          startLine: symbol.startLine,
          endLine: symbol.endLine,
        },
        astHash: sha256(symbol.ast),
        complexity: current.complexity,
        coverage: current.coverage,
        crap: current.crap,
        current,
        threshold: comparison.rule === "absolute_audit"
          ? config.crapThreshold
          : DIFFERENTIAL_THRESHOLD,
        baseline: comparison.baseline,
        delta: comparison.delta,
        rule: comparison.rule,
        status: comparison.approved ? "approved" : "failed",
      });
    }
  }
  const status = language === "mixed"
    ? "unsupported_language"
    : unsupported.length > 0
      ? "unsupported_environment"
      : details.some((detail) => detail.status === "failed")
        ? "failed"
        : details.length === 0
          ? "not_applicable"
          : "approved";
  return {
    $schema: "https://kroxidev.dev/agentic-core/quality-report.schema.json",
    schemaVersion: 1,
    tool,
    status,
    language,
    backend: coverage.backend ?? "v8",
    runner: coverage.runner,
    hashes: {
      inputs: inputInventory.hashes,
      freshness: inputInventory.digest,
      configuration: sha256(JSON.stringify(config)),
    },
    inputInventory,
    targets: targets.map((target) =>
      path.normalize(target).split(path.sep).join("/")),
    summary: {
      symbols: details.length,
      approved: details.filter((item) =>
        item.status === "approved").length,
      failed: details.filter((item) =>
        item.status === "failed").length,
      maximumCrap: details.length
        ? Math.max(...details.map((item) => item.crap))
        : null,
      unsupportedFiles: unsupported,
      baselineWarnings: details.filter((item) =>
        item.baseline.status === "not_attributable").length,
    },
    details,
    durationMs: Number((
      Number(process.hrtime.bigint() - started) / 1_000_000
    ).toFixed(3)),
  };
}
