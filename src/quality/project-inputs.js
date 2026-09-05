import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IntegrationError } from "./command.js";
import { compareCodeUnits } from "./order.js";

const execute = promisify(execFile);
const generated = new Set([".git", ".agentic-core", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const privateName = /^(?:\.?env(?:\..*)?|\.?secrets?(?:[._-].*)?|\.?credentials?(?:[._-].*)?|\.?private(?:[._-].*)?|\.?personal(?:[._-].*)?|\.ssh|\.aws|\.azure|id_rsa|id_ed25519|.*\.(?:pem|key|pfx|p12|jks|keystore|sqlite3?|db))$/iu;
const personalText = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|-----BEGIN [^-]*PRIVATE KEY-----|\b(?:gh[pousr]_[a-z0-9]{20,}|sk-[a-z0-9_-]{20,})\b/iu;
const credentialText = /(?:^|[^\w])["']?(?:password|passwd|api[_-]?key|(?:access[_-]?)?token|(?:client[_-]?)?secret|credential|authorization|ssn|dni|phone|telefono)["']?\s*[:=](?!=)\s*(?:["'][^"'\r\n]+["']|[^\s"'#,\]}]+)/iu;
const testInput = /(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/u;
export const inputHash = (value) => createHash("sha256").update(value).digest("hex");

export function relativeInput(root, file) {
  const relative = path.relative(root, file);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? null : relative.split(path.sep).join("/");
}

export function mandatoryInputExclusion(file) {
  const parts = file.split(/[\\/]/u);
  if (parts.some((part) => privateName.test(part) || personalText.test(part))) return "private";
  if (parts.some((part) => generated.has(part.toLowerCase())) || /\.py[co]$/iu.test(file)) return "generated";
  return null;
}

export function privateInputContent(content) {
  const text = content.toString("utf8");
  // Operational configuration can contain private environment values and absolute paths.
  return personalText.test(text) || credentialText.test(text)
    || /"schemaVersion"\s*:\s*3/u.test(text) && /"integration"\s*:/u.test(text);
}

export function matchesInput(file, pattern) {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (normalized === ".") return true;
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") { expression += "(?:.*/)?"; index += 1; }
      else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${expression}(?:/.*)?$`, "u").test(file);
}

async function gitIgnored(root, enabled) {
  if (!enabled) return new Set();
  try {
    const result = await execute("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      { cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return new Set(result.stdout.split("\0").filter(Boolean));
  } catch (error) {
    // A project without Git is valid. Do not infer other Git errors from stderr text.
    let current = root;
    while (true) {
      try { await lstat(path.join(current, ".git")); break; }
      catch (missing) { if (missing.code !== "ENOENT") break; }
      if (path.dirname(current) === current) return new Set();
      current = path.dirname(current);
    }
    throw new IntegrationError("input_git_unavailable", "No se pudieron resolver las exclusiones de Git; revise Git o configure respectGitIgnore", 2);
  }
}

// Shared checkpoint for execution, diagnosis and the subsequent quality adapters.
// Only entries carry bytes (in memory); public evidence is the sanitized inventory.
export async function captureProjectInputs(projectRoot, unit) {
  const root = await realpath(projectRoot);
  const ignored = await gitIgnored(root, unit.inputs.respectGitIgnore !== false);
  const entries = [];
  const exclusions = { private: 0, generated: 0, configured: 0, git: 0, unselected: 0 };
  const issues = [];
  const selected = (file) => [...unit.scope, ...unit.inputs.include, ...unit.inputs.includeIgnored ?? []].some((p) => matchesInput(file, p));
  const visit = async (directory) => {
    for (const name of (await readdir(directory)).sort(compareCodeUnits)) {
      const absolute = path.join(directory, name);
      const file = relativeInput(root, absolute);
      const mandatory = mandatoryInputExclusion(file);
      if (mandatory) { exclusions[mandatory] += 1; continue; }
      if (unit.inputs.exclude.some((p) => matchesInput(file, p))) { exclusions.configured += 1; continue; }
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) {
        if (selected(file)) issues.push({ code: "input_type_unsupported", phase: "checkpoint" });
        continue;
      }
      if (info.isDirectory()) { await visit(absolute); continue; }
      if (!selected(file)) { exclusions.unselected += 1; continue; }
      if (ignored.has(file) && !(unit.inputs.includeIgnored ?? []).some((p) => matchesInput(file, p))) {
        exclusions.git += 1; continue;
      }
      // Revalidate containment and identity around the read, including parent symlinks.
      if (relativeInput(root, await realpath(absolute)) !== file) {
        issues.push({ code: "input_changed", phase: "checkpoint" }); continue;
      }
      const content = await readFile(absolute);
      const after = await lstat(absolute);
      if (after.isSymbolicLink() || info.ino !== after.ino || info.mtimeMs !== after.mtimeMs
        || relativeInput(root, await realpath(absolute)) !== file) {
        issues.push({ code: "input_changed", phase: "checkpoint" }); continue;
      }
      if (privateInputContent(content)) {
        exclusions.private += 1;
        // Pytest may collect any configured Python filename, not only test_*.py.
        if (/\.py$/iu.test(file)) issues.push({ code: "private_executable_input", phase: "checkpoint" });
        continue;
      }
      const measured = file.endsWith(".py") && !testInput.test(file) && unit.scope.some((p) => matchesInput(file, p));
      entries.push({ path: file, kind: measured ? "measured_code" : "test_input", mode: info.mode & 0o777,
        sha256: inputHash(content), content });
    }
  };
  try { await visit(root); }
  catch { throw new IntegrationError("input_capture_failed", "No se pudo obtener un checkpoint íntegro de los inputs", 2); }
  const inventory = entries.map(({ content: _content, ...entry }) => entry);
  return { root, entries, inventory, exclusions, issues,
    digest: inputHash(JSON.stringify({ inventory, scope: unit.scope, inputs: unit.inputs })),
    policy: { respectGitIgnore: unit.inputs.respectGitIgnore !== false,
      precedence: ["mandatory", "exclude", "includeIgnored", "git", "scope/include"],
      explanation: "Solo el código Python del alcance se mide. Los demás inputs seleccionados permiten ejecutar las pruebas. Las exclusiones privadas son obligatorias y no se publican sus rutas." } };
}

export function publicCheckpoint(checkpoint) {
  return { digest: checkpoint.digest, inventory: checkpoint.inventory, exclusions: checkpoint.exclusions,
    issues: checkpoint.issues, policy: checkpoint.policy };
}
