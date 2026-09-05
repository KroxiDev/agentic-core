import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { InstallationError } from "./config.js";

const execute = promisify(execFile);
export const PYTHON_TOOLS = Object.freeze({ dry4python: "0.1.0", crap4py: "0.1.1", mutate4py: "0.1.4" });
export const privatePython = (root) => path.join(root, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

async function run(executable, args, cwd, timeout = 30000) {
  return execute(executable, args, { cwd, timeout, windowsHide: true, encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" } });
}

export async function inspectPython(executable, cwd) {
  try {
    const { stdout } = await run(executable, ["-I", "-c", "import json,sys; print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3])}))"], cwd);
    const result = JSON.parse(stdout);
    if (result.version[0] !== 3 || result.version[1] < 11) {
      throw new InstallationError("unsupported_python", `Python ${result.version.join(".")} no está soportado; se requiere Python 3.11 o superior`, 2);
    }
    return result;
  } catch (error) {
    if (error instanceof InstallationError) throw error;
    throw new InstallationError("python_unavailable", "No se pudo ejecutar el intérprete Python seleccionado; revise su ruta y permisos", 2, { cause: error });
  }
}

export async function resolvePython(project, explicit) {
  const selected = process.env.AGENTIC_CORE_PYTHON || explicit;
  if (selected) return inspectPython(selected, project);
  const candidates = [privatePython(path.join(project, ".venv")), ...(process.platform === "win32" ? ["python", "python3"] : ["python3", "python"])];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try { await lstat(candidate); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      return inspectPython(candidate, project);
    }
    try { return await inspectPython(candidate, project); } catch (error) {
      if (error.code !== "python_unavailable") throw error;
    }
  }
  throw new InstallationError("python_unavailable", "No se encontró Python 3.11 o superior; use --python o AGENTIC_CORE_PYTHON", 2);
}

export async function inspectTools(root) {
  const executable = privatePython(root);
  const python = await inspectPython(executable, root);
  try {
    const { stdout } = await run(executable, ["-I", "-B", "-c",
      "import json,importlib.metadata as m; import dry4python,crap4py,mutate4py; print(json.dumps({n:m.version(n) for n in ['dry4python','crap4py','mutate4py']}))"], root);
    const versions = JSON.parse(stdout);
    for (const [name, version] of Object.entries(PYTHON_TOOLS)) {
      if (versions[name] !== version) throw new Error("version mismatch");
      await run(executable, ["-I", "-B", "-m", name, "--help"], root);
    }
    return { ...python, tools: versions };
  } catch (error) {
    throw new InstallationError("unsupported_tools", "Las herramientas privadas faltan o son incompatibles con la versión efectiva de Python", 2, { cause: error });
  }
}

export async function installTools(root, interpreter, wheelRoot) {
  try {
    await run(interpreter, ["-I", "-m", "venv", "--copies", root], path.dirname(root), 120000);
    await run(privatePython(root), ["-I", "-m", "pip", "--isolated", "install", "--no-index", "--no-deps", "--no-compile",
      ...Object.entries(PYTHON_TOOLS).map(([name, version]) => path.join(wheelRoot, `${name}-${version}-py3-none-any.whl`))], root, 120000);
    return await inspectTools(root);
  } catch (error) {
    if (error instanceof InstallationError) throw error;
    throw new InstallationError("tool_environment_failed", "No se pudo preparar el entorno privado; compruebe que Python incluye venv y ensurepip", 2, { cause: error });
  }
}
