import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IntegrationError } from "./command.js";
import { captureProjectInputs, inputHash, mandatoryInputExclusion, privateInputContent, relativeInput } from "./project-inputs.js";

export async function createProjectCopy(checkpoint) {
  const temporary = await mkdtemp(path.join(tmpdir(), "agentic verification "));
  const root = path.join(temporary, "project copy");
  try {
    await mkdir(root);
    for (const entry of checkpoint.entries) {
      const destination = path.join(root, entry.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, entry.content, { flag: "wx", mode: entry.mode });
      await chmod(destination, entry.mode);
    }
    return { root, temporary, dispose: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw new IntegrationError("copy_failed", "No se pudo preparar una copia fiel de los inputs", 2);
  }
}

function remapPath(value, checkpoint, copyRoot) {
  const file = relativeInput(checkpoint.root, value);
  if (file === null || mandatoryInputExclusion(file)
    || file && !checkpoint.inventory.some((entry) => entry.path === file || entry.path.startsWith(`${file}/`))) {
    throw new IntegrationError("isolation_unsupported", "El comando o su entorno requiere una ruta que no admite aislamiento fiel; revise los inputs declarados", 2);
  }
  return path.join(copyRoot, file);
}

export function isolatedCommand(unit, python, checkpoint, copyRoot, inheritedEnv) {
  const executable = unit.command.executable === unit.interpreter ? python.executable : unit.command.executable;
  const mappedExecutable = executable === python.executable ? executable
    : path.isAbsolute(executable) || /[\\/]/u.test(executable)
      ? remapPath(path.resolve(checkpoint.root, unit.cwd, executable), checkpoint, copyRoot) : executable;
  const mapArgument = (value) => {
    const equal = value.startsWith("-") ? value.indexOf("=") : -1;
    const prefix = equal < 0 ? "" : value.slice(0, equal + 1);
    const argument = equal < 0 ? value : value.slice(equal + 1);
    if (path.isAbsolute(argument)) return prefix + remapPath(argument, checkpoint, copyRoot);
    const text = process.platform === "win32" ? argument.toLowerCase() : argument;
    const root = process.platform === "win32" ? checkpoint.root.toLowerCase() : checkpoint.root;
    if (text.includes(root) || text.includes(root.replaceAll("\\", "/"))) {
      throw new IntegrationError("isolation_unsupported", "Un argumento contiene una referencia al original que no puede trasladarse sin reinterpretarlo", 2);
    }
    return value;
  };
  const environment = { ...inheritedEnv, ...unit.environment };
  for (const [key, value] of Object.entries(unit.environment)) {
    if (key !== "PYTHONPATH") environment[key] = mapArgument(value);
  }
  if (environment.PYTHONPATH) {
    environment.PYTHONPATH = environment.PYTHONPATH.split(path.delimiter).map((value) =>
      remapPath(path.resolve(checkpoint.root, unit.cwd, value), checkpoint, copyRoot)).join(path.delimiter);
  }
  // Bytecode is an output, never a dependency change in the authoritative environment.
  environment.PYTHONDONTWRITEBYTECODE = "1";
  return { command: { executable: mappedExecutable, args: unit.command.args.map(mapArgument) },
    cwd: remapPath(path.resolve(checkpoint.root, unit.cwd), checkpoint, copyRoot), env: environment };
}

export function publicArgument(value, checkpoint, copyRoot) {
  if (/^--?(?:password|passwd|token|secret|api[_-]?key|credential|authorization)(?:=|$)/iu.test(value)) return "[privado]";
  if (privateInputContent(Buffer.from(value)) || mandatoryInputExclusion(value)) return "[privado]";
  if (path.isAbsolute(value)) return relativeInput(copyRoot, value) ?? relativeInput(checkpoint.root, value) ?? "[ruta externa]";
  return value.includes(checkpoint.root) || value.includes(copyRoot) ? "[argumento de ruta]" : value;
}

export function publicArguments(values, checkpoint, copyRoot) {
  return values.map((value, index) => index > 0 && /^--?(?:password|passwd|token|secret|api[_-]?key|credential|authorization)$/iu.test(values[index - 1])
    ? "[privado]" : publicArgument(value, checkpoint, copyRoot));
}

async function copyChanges(checkpoint, copyRoot) {
  const changed = [];
  for (const entry of checkpoint.inventory) {
    let current = copyRoot;
    try {
      for (const segment of entry.path.split("/")) {
        current = path.join(current, segment);
        const details = await lstat(current);
        if (details.isSymbolicLink()) throw new Error("link");
      }
      const info = await lstat(current);
      if (!info.isFile() || (info.mode & 0o777) !== entry.mode || inputHash(await readFile(current)) !== entry.sha256) changed.push(entry.path);
    } catch { changed.push(entry.path); }
  }
  return changed;
}

export async function verifyProjectIntegrity(checkpoint, unit, copyRoot, phase) {
  const current = await captureProjectInputs(checkpoint.root, unit);
  const before = new Map(checkpoint.inventory.map((entry) => [entry.path, JSON.stringify(entry)]));
  const after = new Map(current.inventory.map((entry) => [entry.path, JSON.stringify(entry)]));
  const original = [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file));
  const copy = await copyChanges(checkpoint, copyRoot);
  return { status: original.length || copy.length || current.issues.length ? "NO_VERIFICADO" : "preserved", phase,
    original, copy, incompatibleInputs: current.issues.length, restored: false };
}

// Dependencies stay in their authoritative environment. Record only an opaque digest,
// including executable bits and link identity; never publish or copy their paths/bytes.
export async function dependencyFingerprint(paths) {
  const records = [];
  const visit = async (file) => {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      records.push(inputHash(await readlink(file)));
      // Virtualenv interpreter links are common on Linux. Hash the executable too.
      try { records.push(inputHash(await readFile(file))); }
      catch { throw new IntegrationError("dependency_integrity_unsupported", "Una dependencia enlazada no admite una comprobación íntegra", 2); }
      return;
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort()) {
        if (name === "__pycache__" || /\.py[co]$/u.test(name)) continue;
        records.push(inputHash(name));
        await visit(path.join(file, name));
      }
    } else if (info.isFile()) records.push(`${info.mode & 0o777}:${inputHash(await readFile(file))}`);
    else throw new IntegrationError("dependency_integrity_unsupported", "Una dependencia tiene un tipo incompatible con la comprobación de integridad", 2);
  };
  try { for (const file of [...new Set(paths)]) await visit(file); }
  catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("dependency_integrity_failed", "No se pudo comprobar la integridad del entorno, el comando o la configuración", 2);
  }
  return inputHash(JSON.stringify(records));
}
