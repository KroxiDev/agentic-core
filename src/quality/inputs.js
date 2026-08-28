import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED = new Set([".git", ".agentic-core", "node_modules", "coverage", "dist", "build", ".venv", "venv", "__pycache__"]);
const TEST_FILE = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$|^(?:test.*|.*_test)\.py$/i;
const RUNNER_CONFIG = /^(?:tsconfig(?:\.[^.]+)?\.json|jsconfig\.json|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|conftest\.py|\.coveragerc|\.nycrc(?:\.json)?)$/i;
const MANIFEST = /^(?:package\.json|requirements(?:-[^.]+)?\.txt)$/i;
const LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock)$/i;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function logicalPath(projectRoot, filePath) { return path.relative(projectRoot, filePath).split(path.sep).join("/"); }

async function projectFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await projectFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}
function inputKind(filePath, targets) {
  const name = path.basename(filePath);
  if (targets.has(filePath)) return "target_code";
  if (TEST_FILE.test(name)) return "discovered_test";
  if (RUNNER_CONFIG.test(name)) return "runner_configuration";
  if (MANIFEST.test(name)) return "manifest";
  if (LOCKFILE.test(name)) return "lockfile";
  return undefined;
}

export async function qualityInputInventory(projectRoot, targetPaths, runner, commands = []) {
  const resolvedTargets = new Set(targetPaths.map((filePath) => path.resolve(filePath)));
  const candidates = new Set([...resolvedTargets, ...await projectFiles(projectRoot)]);
  const entries = [];
  for (const filePath of candidates) {
    const kind = inputKind(filePath, resolvedTargets);
    if (!kind) continue;
    let content;
    try { content = await readFile(filePath); }
    catch (error) { if (error?.code === "ENOENT" && kind === "target_code") continue; throw error; }
    entries.push({ kind, path: logicalPath(projectRoot, filePath), sha256: sha256(content) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  const commandInputs = commands.map((args, index) => ({ kind: "runner_command", id: String(index + 1),
    executable: process.execPath, args: [...args] }));
  return {
    entries,
    commands: commandInputs,
    runner: runner ?? null,
    hashes: Object.fromEntries(entries.map((entry) => [entry.path, entry.sha256])),
    digest: sha256(JSON.stringify({ entries, commands: commandInputs, runner: runner ?? null })),
  };
}

export async function preImplementationInventory(projectRoot) {
  const files = await projectFiles(projectRoot);
  const code = files.filter((filePath) => new Set([
    ".js", ".jsx", ".mjs", ".cjs",
    ".ts", ".tsx", ".mts", ".cts", ".py",
  ]).has(path.extname(filePath).toLowerCase()));
  return qualityInputInventory(projectRoot, code, null, []);
}
