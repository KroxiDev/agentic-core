import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx", ".mts", ".cts", ".py",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git", ".agentic-core", "node_modules", "coverage", "dist", "build", "generated",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".cache", "cache", "caches", "personal", ".personal", "secrets", "credentials",
  "credential", ".ssh", ".aws", ".azure", "data",
]);
const TEST_DIRECTORY = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const TEST_FILE = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$|^(?:test.*|.*_test)\.py$/i;
const RUNNER_CONFIG = /^(?:tsconfig(?:\.[^.]+)?\.json|jsconfig\.json|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|conftest\.py|\.coveragerc|\.nycrc(?:\.json)?)$/i;
const MANIFEST = /^(?:package\.json|requirements(?:-[^.]+)?\.txt|setup\.py)$/i;
const LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock)$/i;
const SECRET_FILE = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|pfx|p12|jks|keystore|sqlite|sqlite3|db))$/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function logicalPath(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}
function parts(filePath) {
  return filePath.split(/[\\/]/).filter(Boolean);
}
export function qualityPathIsExcluded(filePath) {
  const segments = parts(filePath);
  return segments.some((segment) => IGNORED_DIRECTORIES.has(segment.toLowerCase()))
    || SECRET_FILE.test(segments.at(-1) ?? "");
}
export function qualityContentIsBinary(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (buffer.includes(0)) return true;
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return true;
  }
  return /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(decoded);
}
function isTest(filePath) {
  return TEST_FILE.test(path.basename(filePath))
    || parts(filePath).some((segment) => TEST_DIRECTORY.has(segment.toLowerCase()));
}
function isCode(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    && !filePath.toLowerCase().endsWith(".d.ts");
}

async function projectFiles(directory, projectRoot = directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(directory, entry.name);
    const relative = logicalPath(projectRoot, child);
    if (qualityPathIsExcluded(relative)) continue;
    if (entry.isDirectory()) files.push(...await projectFiles(child, projectRoot));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function inputKind(filePath, targets) {
  const name = path.basename(filePath);
  if (targets.has(filePath)) return "target_code";
  if (isTest(filePath) && isCode(filePath)) return "discovered_test";
  if (RUNNER_CONFIG.test(name)) return "runner_configuration";
  if (MANIFEST.test(name)) return "manifest";
  if (LOCKFILE.test(name)) return "lockfile";
  return undefined;
}

export function normalizeQualityScopes(projectRoot, rawScopes) {
  if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
    throw new Error("At least one --scope <path> is required");
  }
  const root = path.resolve(projectRoot);
  const normalized = rawScopes.map((scope) => {
    if (typeof scope !== "string" || scope.length === 0 || scope.startsWith("-")
      || scope.includes("\0") || path.isAbsolute(scope)) {
      throw new Error("Every quality scope must be a relative project path");
    }
    const resolved = path.resolve(root, scope);
    const relative = path.relative(root, resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("Every quality scope must stay inside the project");
    }
    const logical = (relative || ".").split(path.sep).join("/");
    if (qualityPathIsExcluded(logical)) {
      throw new Error(`Quality scope is excluded from evidence: ${scope}`);
    }
    return logical;
  });
  return [...new Set(normalized)].sort();
}

function inScope(file, scopes) {
  return scopes.some((scope) => scope === "." || file === scope || file.startsWith(`${scope}/`));
}

function checkpointKind(file, scopes) {
  const name = path.basename(file);
  if (isTest(file) && isCode(file)) return "test";
  if (RUNNER_CONFIG.test(name)) return "runner_configuration";
  if (MANIFEST.test(name)) return "manifest";
  if (LOCKFILE.test(name)) return "lockfile";
  if (isCode(file)) return inScope(file, scopes) ? "target_code" : "support_code";
  return undefined;
}

export async function captureQualityCheckpoint(projectRoot, rawScopes) {
  const root = path.resolve(projectRoot);
  const scopes = normalizeQualityScopes(root, rawScopes);
  const candidates = await projectFiles(root, root);
  const qualityConfig = path.join(root, ".agentic-core", "config.json");
  try {
    const details = await lstat(qualityConfig);
    if (details.isFile() && !details.isSymbolicLink()) candidates.push(qualityConfig);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const entries = [];
  for (const filePath of [...new Set(candidates)].sort()) {
    const file = logicalPath(root, filePath);
    const kind = file === ".agentic-core/config.json"
      ? "quality_configuration"
      : checkpointKind(file, scopes);
    if (!kind || qualityPathIsExcluded(file) && file !== ".agentic-core/config.json") continue;
    const content = await readFile(filePath);
    if (qualityContentIsBinary(content)) continue;
    entries.push({ kind, path: file, sha256: sha256(content), content });
  }
  const inventory = entries.map(({ content: _content, ...entry }) => entry);
  return {
    scopes,
    entries,
    inventory,
    digest: sha256(JSON.stringify({ scopes, entries: inventory })),
  };
}

export async function qualityInputInventory(projectRoot, targetPaths, runner, commands = []) {
  const root = path.resolve(projectRoot);
  const resolvedTargets = new Set(targetPaths.map((filePath) => path.resolve(filePath)));
  const candidates = new Set([...resolvedTargets, ...await projectFiles(root, root)]);
  const entries = [];
  for (const filePath of candidates) {
    if (qualityPathIsExcluded(logicalPath(root, filePath))) continue;
    const kind = inputKind(filePath, resolvedTargets);
    if (!kind) continue;
    let content;
    try {
      content = await readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT" && kind === "target_code") continue;
      throw error;
    }
    if (qualityContentIsBinary(content)) continue;
    entries.push({ kind, path: logicalPath(root, filePath), sha256: sha256(content) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  const commandInputs = commands.map((command, index) => {
    const executable = Array.isArray(command) ? process.execPath : command.executable;
    const version = Array.isArray(command) ? process.version : command.version;
    const args = Array.isArray(command) ? command : command.recordedArgs ?? command.args;
    return {
      kind: "runner_command",
      id: String(index + 1),
      executable,
      ...(version === undefined ? {} : { version }),
      args: [...args].map((argument) => {
      const relative = path.relative(root, argument);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? relative.split(path.sep).join("/")
        : argument;
      }),
    };
  });
  return {
    entries,
    commands: commandInputs,
    runner: runner ?? null,
    hashes: Object.fromEntries(entries.map((entry) => [entry.path, entry.sha256])),
    digest: sha256(JSON.stringify({ entries, commands: commandInputs, runner: runner ?? null })),
  };
}
