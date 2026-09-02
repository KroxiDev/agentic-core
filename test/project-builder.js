import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function invalidProjectPath(relativePath) {
  const error = new TypeError(`Project file path must be a safe relative path: ${JSON.stringify(relativePath)}`);
  error.code = "ERR_INVALID_PROJECT_PATH";
  return error;
}

function resolveProjectPath(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === ""
    || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
    || /^[A-Za-z]:/.test(relativePath)) {
    throw invalidProjectPath(relativePath);
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.includes("..")) throw invalidProjectPath(relativePath);
  const target = path.resolve(root, ...segments);
  const fromRoot = path.relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(fromRoot)) {
    throw invalidProjectPath(relativePath);
  }
  return target;
}

async function findPython(root) {
  const candidates = process.platform === "win32"
    ? [["py", "-3"], ["python"], ["python3"]]
    : [["python3"], ["python"]];
  for (const [executable, ...prefix] of candidates) {
    try {
      await execFileAsync(executable, [
        ...prefix,
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)",
      ], { cwd: root, timeout: 10_000, windowsHide: true });
      return { executable, prefix };
    } catch {}
  }
  const error = new Error("Python is unavailable; cannot create a virtual environment");
  error.code = "ERR_PYTHON_UNAVAILABLE";
  throw error;
}

export async function createTestProject(t, { files = {}, manifest, pythonVenv = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic core test project "));
  const cleanup = () => rm(root, { recursive: true, force: true });

  try {
    t.after(cleanup);
    const entries = Object.entries(files).map(([relativePath, contents]) => [
      resolveProjectPath(root, relativePath),
      contents,
    ]);
    for (const [target, contents] of entries) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    if (manifest !== undefined) {
      await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
    }
    if (pythonVenv) {
      const { executable, prefix } = await findPython(root);
      await execFileAsync(executable, [
        ...prefix,
        "-m",
        "venv",
        "--without-pip",
        path.join(root, ".venv"),
      ], { cwd: root, timeout: 30_000, windowsHide: true });
    }
    return root;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
