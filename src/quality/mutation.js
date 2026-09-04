import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { analyzeSource } from "./ast.js";
import { executeCoverage, executeTests, testTimeout } from "./coverage.js";
import {
  captureQualityCheckpoint,
  qualityContentIsBinary,
  qualityPathIsExcluded,
} from "./inputs.js";
import { compareCodeUnits } from "./order.js";
import { executePythonCoverage, executePythonTests, findPython, generatePythonMutants } from "./python.js";

const EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "coverage", "dist", "build", "generated", ".git", ".agentic-core",
  ".venv", "venv", "__pycache__", ".pytest_cache"]);
const TEST_FILE = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/i;
const PYTHON_TEST_FILE = /^(?:test.*|.*_test)\.py$/i;
const GENERATED_FILE = /(?:^|[._-])generated(?:[._-]|$)/i;
const MANIFEST_FILE = /^(?:setup\.py)$/i;
function excludedFile(filePath) {
  const name = path.basename(filePath);
  return TEST_FILE.test(name) || PYTHON_TEST_FILE.test(name) || GENERATED_FILE.test(name) || MANIFEST_FILE.test(name)
    || filePath.endsWith(".d.ts");
}
const BINARY_MUTATIONS = new Map([
  [ts.SyntaxKind.EqualsEqualsToken, ["!="]],
  [ts.SyntaxKind.ExclamationEqualsToken, ["=="]],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, ["!=="]],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, ["==="]],
  [ts.SyntaxKind.GreaterThanToken, [">="]],
  [ts.SyntaxKind.GreaterThanEqualsToken, [">"]],
  [ts.SyntaxKind.LessThanToken, ["<="]],
  [ts.SyntaxKind.LessThanEqualsToken, ["<"]],
  [ts.SyntaxKind.AmpersandAmpersandToken, ["||"]],
  [ts.SyntaxKind.BarBarToken, ["&&"]],
  [ts.SyntaxKind.QuestionQuestionToken, ["||"]],
  [ts.SyntaxKind.PlusToken, ["-"]],
  [ts.SyntaxKind.MinusToken, ["+"]],
  [ts.SyntaxKind.AsteriskToken, ["/"]],
  [ts.SyntaxKind.SlashToken, ["*"]],
  [ts.SyntaxKind.PercentToken, ["*"]],
]);

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function logicalPath(root, filePath) { return path.relative(root, filePath).split(path.sep).join("/"); }
function scriptKind(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if ([".ts", ".mts", ".cts"].includes(extension)) return ts.ScriptKind.TS;
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}
function isTypeOnly(node) {
  return ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
    || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
    || (ts.isExportDeclaration(node) && node.isTypeOnly)
    || (ts.isVariableStatement(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0);
}
function enclosingSymbol(node, symbols, sourceFile) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return symbols.filter((symbol) => symbol.startLine <= line && line <= symbol.endLine)
    .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0];
}
function binaryCategory(kind) {
  if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(kind)) return "logical";
  if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken].includes(kind)) return "arithmetic";
  if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(kind)) return "equality";
  return "comparison";
}
function replacements(node, sourceFile) {
  if (ts.isBinaryExpression(node)) {
    const candidates = BINARY_MUTATIONS.get(node.operatorToken.kind);
    if (candidates) return candidates.map((text) => ({ start: node.operatorToken.getStart(sourceFile),
      end: node.operatorToken.end, text, category: binaryCategory(node.operatorToken.kind) }));
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return [{ start: node.getStart(sourceFile), end: node.end,
      text: node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true", category: "boolean" }];
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return [{ start: node.getStart(sourceFile), end: node.end, text: "undefined", category: "null" }];
  }
  if (ts.isNumericLiteral(node)) {
    return [{ start: node.getStart(sourceFile), end: node.end, text: Number(node.text) === 0 ? "1" : "0", category: "constant" }];
  }
  if (ts.isStringLiteral(node) && node.text.length > 0) {
    return [{ start: node.getStart(sourceFile), end: node.end, text: JSON.stringify(""), category: "constant" }];
  }
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      return [{ start: node.getStart(sourceFile), end: node.end, text: `(${node.operand.getText(sourceFile)})`, category: "unary" }];
    }
    if (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken) {
      return [{ start: node.getStart(sourceFile), end: node.getStart(sourceFile) + 1,
        text: node.operator === ts.SyntaxKind.PlusToken ? "-" : "+", category: "unary" }];
    }
  }
  return [];
}

export function generateMutants(filePath, source, selectedSymbols) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  if (sourceFile.parseDiagnostics.length > 0) return [];
  const symbols = analyzeSource(filePath, source);
  const mutants = [];
  function visit(node) {
    if (isTypeOnly(node)) return;
    const symbol = enclosingSymbol(node, symbols, sourceFile);
    if (symbol && (!selectedSymbols?.size || selectedSymbols.has(symbol.name))) {
      for (const candidate of replacements(node, sourceFile)) {
        const mutated = source.slice(0, candidate.start) + candidate.text + source.slice(candidate.end);
        const validation = ts.createSourceFile(filePath, mutated, ts.ScriptTarget.Latest, true, scriptKind(filePath));
        if (validation.parseDiagnostics.length === 0) {
          const position = sourceFile.getLineAndCharacterOfPosition(candidate.start);
          mutants.push({
            id: sha256(`${filePath}:${candidate.start}:${candidate.end}:${candidate.text}`).slice(0, 16),
            symbol: symbol.name,
            category: candidate.category,
            mutation: `${source.slice(candidate.start, candidate.end)} -> ${candidate.text}`,
            location: { line: position.line + 1, column: position.character + 1 },
            start: candidate.start,
            end: candidate.end,
            replacement: candidate.text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return mutants;
}

async function sourceFiles(targetPath, projectRoot) {
  if (qualityPathIsExcluded(logicalPath(projectRoot, targetPath))) return [];
  let details;
  try {
    details = await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (details.isFile()) {
    if (!EXTENSIONS.has(path.extname(targetPath).toLowerCase()) || excludedFile(targetPath)) return [];
    return qualityContentIsBinary(await readFile(targetPath)) ? [] : [targetPath];
  }
  if (!details.isDirectory()) return [];
  const files = [];
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const child = path.join(targetPath, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child, projectRoot));
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !excludedFile(child)) {
      files.push(...await sourceFiles(child, projectRoot));
    }
  }
  return files;
}
async function configuration(projectRoot) {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectRoot, ".agentic-core", "config.json"), "utf8"));
    const workers = parsed.quality?.mutationWorkers;
    if (!Number.isInteger(workers) || workers < 1 || workers > 4) {
      throw new Error("quality.mutationWorkers must be an integer from 1 to 4");
    }
    return { mutationWorkers: workers };
  } catch (error) {
    if (error?.code === "ENOENT") return { mutationWorkers: 4 };
    throw error;
  }
}
async function copySnapshot(projectRoot, destination, targets) {
  await mkdir(destination, { recursive: true });
  const checkpoint = await captureQualityCheckpoint(projectRoot, targets);
  for (const entry of checkpoint.entries) {
    const target = path.join(destination, ...entry.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.content, { flag: "wx" });
  }
  const dependencies = path.join(projectRoot, "node_modules");
  try {
    if ((await lstat(dependencies)).isDirectory()) {
      await symlink(dependencies, path.join(destination, "node_modules"), "junction");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async (_, workerIndex) => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index, workerIndex);
    }
  }));
  return results;
}
function isCovered(mutant, filePath, coverage) {
  return (coverage.coveredByFile.get(path.resolve(filePath).toLowerCase()) ?? new Set()).has(mutant.location.line);
}
function equivalentEvidence(equivalents, file, mutant) {
  return equivalents?.find((item) => item.file === file && item.symbol === mutant.symbol && item.mutation === mutant.mutation
    && item.location?.line === mutant.location.line && typeof item.reason === "string" && item.reason.trim()
    && typeof item.staticProof === "string" && item.staticProof.trim());
}

function terminalReport({ started, config, files, targets, status, language, backend, error }) {
  return {
    $schema: "https://kroxidev.dev/agentic-core/quality-report.schema.json",
    schemaVersion: 1,
    tool: "mutation",
    status,
    language,
    backend,
    runner: null,
    hashes: {
      inputs: Object.fromEntries(files.map((file) => [file.file, file.hash])),
      configuration: sha256(JSON.stringify(config)),
    },
    targets: targets.map((target) => path.normalize(target).split(path.sep).join("/")),
    summary: { mutants: 0, killed: 0, killedByTimeout: 0, survived: 0, uncovered: 0, equivalent: 0 },
    details: [],
    ...(error ? { error } : {}),
    durationMs: Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3)),
  };
}

export async function analyzeMutation({
  projectRoot,
  targets,
  selection,
  equivalents = [],
  temporaryRoot = tmpdir(),
}) {
  const started = process.hrtime.bigint();
  await mkdir(temporaryRoot, { recursive: true });
  const config = await configuration(projectRoot);
  const paths = [...new Set((await Promise.all(targets.map((target) =>
    sourceFiles(path.resolve(projectRoot, target), projectRoot)))).flat())].sort(compareCodeUnits);
  const languages = new Set(paths.map((filePath) => path.extname(filePath).toLowerCase() === ".py"
    ? "python" : "javascript-typescript"));
  const language = languages.size > 1 ? "mixed" : languages.values().next().value ?? "javascript-typescript";
  const runtime = language === "python" ? await findPython(projectRoot) : undefined;
  const files = await Promise.all(paths.map(async (filePath) => {
    const source = await readFile(filePath, "utf8");
    const file = logicalPath(projectRoot, filePath);
    return { path: filePath, file, source, hash: sha256(source),
      mutants: language === "python" && runtime
        ? await generatePythonMutants(runtime, projectRoot, filePath, file, selection?.get(file))
        : language === "javascript-typescript" ? generateMutants(file, source, selection?.get(file)) : [] };
  }));
  if (language === "mixed") return terminalReport({ started, config, files, targets, status: "unsupported_language",
    language, backend: "unavailable", error: "Mutation targets must use a single supported language" });
  if (language === "python" && !runtime) return terminalReport({ started, config, files, targets, status: "unsupported_environment",
    language, backend: "unavailable", error: "Python 3.10 or newer is unavailable" });
  let coverage;
  try {
    const timeout = testTimeout("AGENTIC_CORE_TEST_BASELINE_TIMEOUT_MS", 30_000);
    coverage = language === "python"
      ? await executePythonCoverage(runtime, projectRoot, files, { timeout, temporaryRoot })
      : await executeCoverage(projectRoot, files, { timeout, temporaryRoot });
  } catch (error) {
    return terminalReport({ started, config, files, targets,
      status: error?.unsupportedEnvironment ? "unsupported_environment" : "baseline_failed",
      language, backend: language === "python" ? "python-ast" : "typescript-v8", error: error.message });
  }
  const allDetails = [];
  let restorationFailure;
  let snapshotBaselineFailure;
  let evidencePath;
  let workingTreeUntouched = true;
  let snapshotEnvironmentValidated = false;
  for (const file of files) {
    const coveredMutants = [];
    for (const mutant of file.mutants) {
      const evidence = equivalentEvidence(equivalents, file.file, mutant);
      if (evidence) {
        allDetails.push({ ...mutant, file: file.file, status: "equivalent",
          evidence: { reason: evidence.reason, staticProof: evidence.staticProof } });
      } else if (!isCovered(mutant, file.path, coverage)) {
        allDetails.push({ ...mutant, file: file.file, status: "uncovered" });
      } else {
        coveredMutants.push(mutant);
      }
    }
    if (coveredMutants.length === 0) continue;
    const snapshotRoot = await mkdtemp(path.join(temporaryRoot, "agentic-core-mutants-"));
    const snapshots = [];
    let preserveEvidence = false;
    try {
      for (let index = 0; index < Math.min(config.mutationWorkers, coveredMutants.length); index += 1) {
        const snapshot = path.join(snapshotRoot, `worker-${index}`);
        await copySnapshot(projectRoot, snapshot, targets);
        snapshots.push(snapshot);
      }
      if (!snapshotEnvironmentValidated) {
        const timeout = testTimeout("AGENTIC_CORE_TEST_BASELINE_TIMEOUT_MS", 30_000);
        try {
          if (language === "python") {
            await executePythonTests(runtime, snapshots[0], { runner: coverage.runner, timeout });
          } else {
            await executeTests(snapshots[0], { timeout });
          }
          snapshotEnvironmentValidated = true;
        } catch (error) {
          snapshotBaselineFailure = new Error(`Mutation snapshot baseline failed: ${error.message}`);
          break;
        }
      }
      const results = await mapLimit(coveredMutants, snapshots.length, async (mutant, _index, workerIndex) => {
        const snapshot = snapshots[workerIndex];
        const snapshotFile = path.join(snapshot, ...file.file.split("/"));
        const original = await readFile(snapshotFile, "utf8");
        if (sha256(original) !== file.hash) throw new Error(`Snapshot hash mismatch before mutation: ${file.file}`);
        const mutated = original.slice(0, mutant.start) + mutant.replacement + original.slice(mutant.end);
        await writeFile(snapshotFile, mutated);
        let status;
        const mutantTimeout = testTimeout("AGENTIC_CORE_TEST_MUTANT_TIMEOUT_MS", 10_000);
        const testStarted = Date.now();
        try {
          if (language === "python") await executePythonTests(runtime, snapshot, { runner: coverage.runner, timeout: mutantTimeout });
          else await executeTests(snapshot, { timeout: mutantTimeout });
          status = "survived";
        } catch (error) {
          status = error?.killed || error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT"
            || Date.now() - testStarted >= mutantTimeout ? "killedByTimeout" : "killed";
        }
        if (process.env.NODE_ENV === "test" && process.env.AGENTIC_CORE_TEST_FAIL_MUTANT_RESTORE === "1") {
          throw new Error(`Injected snapshot restoration failure: ${file.file}`);
        }
        await writeFile(snapshotFile, original);
        if (sha256(await readFile(snapshotFile)) !== file.hash) throw new Error(`Snapshot restoration failed: ${file.file}`);
        return { ...mutant, file: file.file, status };
      });
      allDetails.push(...results);
    } catch (error) {
      restorationFailure = error;
      preserveEvidence = true;
      evidencePath = snapshotRoot;
      break;
    } finally {
      if (!preserveEvidence) {
        try { await rm(snapshotRoot, { recursive: true, force: true }); }
        catch (error) { restorationFailure ??= error; }
      }
    }
  }
  for (const file of files) {
    if (sha256(await readFile(file.path)) !== file.hash) {
      workingTreeUntouched = false;
      restorationFailure ??= new Error(`Working tree changed during mutation analysis: ${file.file}`);
    }
  }
  allDetails.sort((left, right) => compareCodeUnits(left.file, right.file)
    || left.location.line - right.location.line
    || left.location.column - right.location.column
    || compareCodeUnits(left.id, right.id));
  const count = (status) => allDetails.filter((item) => item.status === status).length;
  const summary = {
    mutants: allDetails.length,
    killed: count("killed"),
    killedByTimeout: count("killedByTimeout"),
    survived: count("survived"),
    uncovered: count("uncovered"),
    equivalent: count("equivalent"),
  };
  const status = restorationFailure ? "restoration_failure"
    : snapshotBaselineFailure ? "baseline_failed"
    : summary.survived > 0 || summary.uncovered > 0 ? "failed"
      : summary.mutants === 0 ? "not_applicable" : "approved";
  return {
    $schema: "https://kroxidev.dev/agentic-core/quality-report.schema.json",
    schemaVersion: 1,
    tool: "mutation",
    status,
    language,
    backend: language === "python" ? `python-ast-${coverage.backend}` : "typescript-v8",
    runner: coverage.runner,
    hashes: {
      inputs: Object.fromEntries(files.map((file) => [file.file, file.hash])),
      configuration: sha256(JSON.stringify(config)),
      baseline: sha256(JSON.stringify({ inputs: files.map((file) => file.hash), runner: coverage.runner })),
    },
    targets: targets.map((target) => path.normalize(target).split(path.sep).join("/")),
    summary,
    details: allDetails,
    restoration: {
      workingTreeUntouched,
      snapshotsVerified: !restorationFailure && !snapshotBaselineFailure,
      evidencePreserved: Boolean(restorationFailure),
      ...(evidencePath ? { evidencePath } : {}),
    },
    ...(restorationFailure || snapshotBaselineFailure
      ? { error: (restorationFailure ?? snapshotBaselineFailure).message }
      : {}),
    durationMs: Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3)),
  };
}
