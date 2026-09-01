import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const pythonHelper = fileURLToPath(new URL("python-helper.py", import.meta.url));
const executionOptions = (projectRoot, timeout, env = process.env) => ({
  cwd: projectRoot, env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout, windowsHide: true,
});
function normalized(filePath) { return path.resolve(filePath).toLowerCase(); }
function recordedCommand(runtime, args, replacements) {
  return {
    executable: runtime.executable,
    version: runtime.version,
    args,
    recordedArgs: args.map((argument) => replacements.reduce(
      (value, [actual, token]) => value.replaceAll(actual, token),
      argument,
    )),
  };
}
async function succeeds(executable, args, options) {
  try { await execFileAsync(executable, args, options); return true; } catch { return false; }
}

export async function findPython(projectRoot, { timeout = 10_000 } = {}) {
  const configured = process.env.AGENTIC_CORE_PYTHON;
  const candidates = configured ? [[configured]]
    : process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
  for (const [executable, ...prefix] of candidates) {
    try {
      const { stdout } = await execFileAsync(executable, [...prefix, "-c",
        "import json,sys; print(json.dumps(list(sys.version_info[:3])))"], executionOptions(projectRoot, timeout));
      const version = JSON.parse(stdout.trim());
      if (version[0] > 3 || (version[0] === 3 && version[1] >= 10)) return { executable, prefix, version };
    } catch {}
  }
  return undefined;
}

export async function analyzePythonSource(runtime, projectRoot, filePath, { timeout = 10_000 } = {}) {
  const { stdout } = await execFileAsync(runtime.executable,
    [...runtime.prefix, pythonHelper, "analyze", filePath], executionOptions(projectRoot, timeout));
  return JSON.parse(stdout);
}

export async function generatePythonMutants(runtime, projectRoot, filePath, logicalPath, selectedSymbols,
  { timeout = 10_000 } = {}) {
  const { stdout } = await execFileAsync(runtime.executable, [
    ...runtime.prefix, pythonHelper, "mutants", filePath, "--logical-path", logicalPath,
    "--symbols", JSON.stringify([...selectedSymbols ?? []]),
  ], executionOptions(projectRoot, timeout));
  return JSON.parse(stdout);
}

async function hasFile(projectRoot, relativePath) {
  try { await access(path.join(projectRoot, relativePath)); return true; } catch { return false; }
}
async function pythonTests(projectRoot) {
  const found = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if ([".git", ".agentic-core", ".venv", "venv", "node_modules", "__pycache__"].includes(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && /^(?:test.*|.*_test)\.py$/i.test(entry.name)) found.push(child);
    }
  }
  await visit(projectRoot);
  return found;
}
export async function choosePythonRunner(runtime, projectRoot, timeout = 10_000) {
  const tests = await pythonTests(projectRoot);
  const explicitPytest = await hasFile(projectRoot, "pytest.ini") || await hasFile(projectRoot, "conftest.py")
    || (await Promise.all(tests.map(async (file) => /(?:^|\n)\s*(?:import pytest|from pytest\s+import)\b/.test(await readFile(file, "utf8"))))).some(Boolean);
  if (explicitPytest) {
    if (await succeeds(runtime.executable, [...runtime.prefix, "-c", "import pytest"], executionOptions(projectRoot, timeout))) return "pytest";
    const error = new Error("Python pytest runner is unavailable: No module named pytest");
    error.unsupportedEnvironment = true;
    throw error;
  }
  return "unittest";
}
async function coverageInvocation(runtime, projectRoot, dataFile, runner) {
  const unittestRoot = await hasFile(projectRoot, "tests") ? "tests" : ".";
  const runnerArgs = runner === "pytest" ? ["pytest", "-q"] : ["unittest", "discover", "-s", unittestRoot, "-p", "test*.py"];
  return [...runtime.prefix, "-m", "coverage", "run", `--data-file=${dataFile}`, "-m", ...runnerArgs];
}
function testFailure(error) {
  const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
  return new Error(`Test command failed${detail ? `:\n${detail}` : ""}`);
}
function resultFromTrace(document, files) {
  const attributable = new Set((document.attributable ?? []).map(normalized));
  const coveredByFile = new Map();
  for (const file of files) {
    const key = normalized(file.path);
    const entry = Object.entries(document.covered ?? {}).find(([candidate]) => normalized(candidate) === key);
    if (entry) coveredByFile.set(key, new Set(entry[1]));
  }
  return { attributable, coveredByFile };
}
function resultFromCoverage(document, files, projectRoot) {
  const attributable = new Set();
  const coveredByFile = new Map();
  for (const [reportedPath, coverage] of Object.entries(document.files ?? {})) {
    const key = normalized(path.isAbsolute(reportedPath) ? reportedPath : path.resolve(projectRoot, reportedPath));
    if (!files.some((file) => normalized(file.path) === key)) continue;
    attributable.add(key);
    coveredByFile.set(key, new Set(coverage.executed_lines ?? []));
  }
  return { attributable, coveredByFile };
}

export async function executePythonCoverage(runtime, projectRoot, files, {
  timeout = 30_000,
  temporaryRoot = tmpdir(),
} = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(temporaryRoot, "agentic-core-python-"));
  const dataFile = path.join(temporary, ".coverage");
  const outputFile = path.join(temporary, "coverage.json");
  try {
    const runner = await choosePythonRunner(runtime, projectRoot, timeout);
    const hasCoverage = process.env.AGENTIC_CORE_PYTHON_BACKEND !== "trace"
      && await succeeds(runtime.executable, [...runtime.prefix, "-c", "import coverage"], executionOptions(projectRoot, timeout));
    if (hasCoverage) {
      const runArgs = await coverageInvocation(runtime, projectRoot, dataFile, runner);
      const reportArgs = [...runtime.prefix, "-m", "coverage", "json",
        `--data-file=${dataFile}`, "--fail-under=0", "-o", outputFile];
      try {
        await execFileAsync(runtime.executable, runArgs, executionOptions(projectRoot, timeout));
        await execFileAsync(runtime.executable, reportArgs, executionOptions(projectRoot, timeout));
      } catch (error) { throw testFailure(error); }
      return { ...resultFromCoverage(JSON.parse(await readFile(outputFile, "utf8")), files, projectRoot),
        backend: "coverage.py", runner, commands: [
          recordedCommand(runtime, runArgs, [[dataFile, "<quality-data>"]]),
          recordedCommand(runtime, reportArgs, [
            [dataFile, "<quality-data>"],
            [outputFile, "<quality-report>"],
          ]),
        ] };
    }
    const traceArgs = [...runtime.prefix, pythonHelper, "trace", "--output", outputFile,
      "--runner", runner, "--targets", JSON.stringify(files.map(({ path: filePath }) => filePath))];
    try {
      await execFileAsync(runtime.executable, traceArgs, executionOptions(projectRoot, timeout));
    } catch (error) { throw testFailure(error); }
    return { ...resultFromTrace(JSON.parse(await readFile(outputFile, "utf8")), files), backend: "stdlib-trace", runner,
      commands: [recordedCommand(runtime, traceArgs, [[outputFile, "<quality-report>"]])] };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function executePythonTests(runtime, projectRoot, { runner, timeout = 30_000 } = {}) {
  const selectedRunner = runner ?? await choosePythonRunner(runtime, projectRoot, timeout);
  const unittestRoot = await hasFile(projectRoot, "tests") ? "tests" : ".";
  const args = selectedRunner === "pytest" ? [...runtime.prefix, "-m", "pytest", "-q"]
    : [...runtime.prefix, "-m", "unittest", "discover", "-s", unittestRoot, "-p", "test*.py"];
  await execFileAsync(runtime.executable, args, executionOptions(projectRoot, timeout));
  return { runner: selectedRunner };
}
