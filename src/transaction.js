import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function inspect(targetPath) {
  try {
    const details = await lstat(targetPath);
    if (details.isDirectory()) return { kind: "directory" };
    if (!details.isFile()) return { kind: "other" };
    return { kind: "file", content: await readFile(targetPath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedFileTreeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Runtime file inventory must be a non-empty array");
  }
  const seen = new Set();
  const normalized = files.map((file) => {
    if (file === null || typeof file !== "object" || Array.isArray(file)
      || typeof file.path !== "string" || file.path.length === 0 || !Buffer.isBuffer(file.content)) {
      throw new Error("Runtime file inventory contains an invalid entry");
    }
    const parts = file.path.split("/");
    if (path.isAbsolute(file.path) || file.path.includes("\\")
      || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Runtime file path is unsafe: ${file.path}`);
    }
    if (seen.has(file.path)) throw new Error(`Runtime file path is duplicated: ${file.path}`);
    seen.add(file.path);
    return { path: file.path, content: file.content };
  });
  const paths = new Set(normalized.map(({ path: filePath }) => filePath));
  for (const { path: filePath } of normalized) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      if (paths.has(parent)) throw new Error(`Runtime file path conflicts with a directory: ${parent}`);
    }
  }
  return normalized.sort((left, right) => compareNames(left.path, right.path));
}

export function hashFileTree(files) {
  const normalized = normalizedFileTreeFiles(files);
  const directories = new Set([""]);
  const byDirectory = new Map();
  for (const file of normalized) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
    const directory = parts.slice(0, -1).join("/");
    const entries = byDirectory.get(directory) ?? [];
    entries.push({ kind: "file", name: parts.at(-1), file });
    byDirectory.set(directory, entries);
  }
  for (const directory of directories) {
    if (directory === "") continue;
    const parts = directory.split("/");
    const parent = parts.slice(0, -1).join("/");
    const entries = byDirectory.get(parent) ?? [];
    if (!entries.some((entry) => entry.kind === "directory" && entry.name === parts.at(-1))) {
      entries.push({ kind: "directory", name: parts.at(-1), path: directory });
    }
    byDirectory.set(parent, entries);
  }

  const hash = createHash("sha256");
  const visit = (relative) => {
    hash.update(`directory\0${relative}\0`);
    const entries = (byDirectory.get(relative) ?? []).sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      if (entry.kind === "directory") {
        visit(entry.path);
      } else {
        hash.update(`file\0${entry.file.path}\0${entry.file.content.byteLength}\0`);
        hash.update(entry.file.content);
      }
    }
  };
  visit("");
  return hash.digest("hex");
}

export async function hashDirectory(directory) {
  const root = path.resolve(directory);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error(`Runtime source is not a safe directory: ${root}`);
  }
  const hash = createHash("sha256");
  const visit = async (current, relative) => {
    hash.update(`directory\0${relative.replaceAll("\\", "/")}\0`);
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const logicalPath = childRelative.replaceAll("\\", "/");
      const details = await lstat(child);
      if (details.isSymbolicLink()) throw new Error(`Runtime source contains a symbolic link: ${logicalPath}`);
      if (details.isDirectory()) {
        await visit(child, childRelative);
      } else if (details.isFile()) {
        const content = await readFile(child);
        hash.update(`file\0${logicalPath}\0${content.byteLength}\0`);
        hash.update(content);
      } else {
        throw new Error(`Runtime source contains an unsupported entry: ${logicalPath}`);
      }
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

function assertInsideProject(projectRoot, targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Transaction target is outside the project: ${targetPath}`);
  }
}

function pathsOverlap(leftPath, rightPath) {
  const leftToRight = path.relative(leftPath, rightPath);
  const rightToLeft = path.relative(rightPath, leftPath);
  const contained = (relative) => relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
  return contained(leftToRight) || contained(rightToLeft);
}

async function missingParentDirectories(projectRoot, operations) {
  const candidates = new Set();
  for (const { path: targetPath } of operations) {
    let parent = path.dirname(targetPath);
    while (parent !== projectRoot) {
      candidates.add(parent);
      const next = path.dirname(parent);
      if (next === parent) throw new Error(`Cannot resolve transaction parent for ${targetPath}`);
      parent = next;
    }
  }

  const missing = [];
  for (const candidate of candidates) {
    try {
      const details = await lstat(candidate);
      if (!details.isDirectory()) throw new Error(`Transaction parent is not a directory: ${candidate}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing.push(candidate);
    }
  }
  return missing.sort((left, right) => left.length - right.length);
}

export async function writeTransaction(projectDirectory, operations, {
  failAfterWrite,
  temporaryRoot = tmpdir(),
} = {}) {
  const projectRoot = path.resolve(projectDirectory);
  const seen = new Set();
  for (const operation of operations) {
    operation.path = path.resolve(operation.path);
    assertInsideProject(projectRoot, operation.path);
    if (seen.has(operation.path)) throw new Error(`Duplicate transaction target: ${operation.path}`);
    seen.add(operation.path);
  }

  const snapshots = new Map();
  for (const operation of operations) {
    const snapshot = await inspect(operation.path);
    if (operation.type === "create_directory" && snapshot.kind !== "missing") {
      throw new Error(`El destino ya existe: ${operation.path}`);
    }
    if (snapshot.kind === "other"
      || (snapshot.kind === "directory" && !["delete", "replace_directory"].includes(operation.type))) {
      throw new Error(`Transaction target is not compatible with the operation: ${operation.path}`);
    }
    if (operation.type === "replace_directory") {
      const usesFiles = operation.files !== undefined;
      if (usesFiles === (operation.sourcePath !== undefined)) {
        throw new Error(`Directory transaction requires exactly one source: ${operation.path}`);
      }
      let actualSourceHash;
      if (usesFiles) {
        operation.files = normalizedFileTreeFiles(operation.files);
        actualSourceHash = hashFileTree(operation.files);
      } else {
        operation.sourcePath = path.resolve(operation.sourcePath);
        if (pathsOverlap(operation.sourcePath, operation.path)) {
          throw new Error(`Directory transaction source and destination overlap: ${operation.path}`);
        }
        actualSourceHash = await hashDirectory(operation.sourcePath);
      }
      if (actualSourceHash !== operation.sourceSha256) {
        throw new Error(`Runtime source changed before the transaction: ${operation.sourcePath ?? operation.path}`);
      }
    }
    snapshots.set(operation.path, snapshot);
  }
  const missingDirectories = await missingParentDirectories(projectRoot, operations);
  await mkdir(temporaryRoot, { recursive: true });
  const backupRoot = await mkdtemp(path.join(temporaryRoot, "agentic-core-transaction-"));
  const temporaryPaths = new Set();

  try {
    let backupIndex = 0;
    for (const [targetPath, snapshot] of snapshots) {
      if (snapshot.kind === "file") {
        snapshot.backupPath = path.join(backupRoot, `${backupIndex}.bin`);
        await writeFile(snapshot.backupPath, snapshot.content);
        backupIndex += 1;
      } else if (snapshot.kind === "directory") {
        snapshot.backupPath = path.join(backupRoot, `${backupIndex}.dir`);
        await cp(targetPath, snapshot.backupPath, { recursive: true, errorOnExist: true });
        backupIndex += 1;
      }
    }

    let writeCount = 0;
    for (const operation of operations) {
      if (operation.type === "create_directory") {
        await mkdir(operation.path, { recursive: true });
        await operation.prepare(operation.path);
        writeCount += 1;
        if (failAfterWrite === writeCount) throw new Error("Simulated transaction failure");
        continue;
      }
      if (operation.type === "delete") {
        await rm(operation.path, { recursive: true, force: true });
        writeCount += 1;
        if (failAfterWrite === writeCount) throw new Error("Simulated transaction failure");
        continue;
      }
      if (operation.type === "replace_directory") {
        await mkdir(path.dirname(operation.path), { recursive: true });
        const temporaryPath = `${operation.path}.agentic-core-${randomUUID()}.tmp`;
        temporaryPaths.add(temporaryPath);
        if (operation.files) {
          await mkdir(temporaryPath);
          for (const file of operation.files) {
            const targetPath = path.join(temporaryPath, ...file.path.split("/"));
            await mkdir(path.dirname(targetPath), { recursive: true });
            await writeFile(targetPath, file.content, { flag: "wx" });
          }
        } else {
          await cp(operation.sourcePath, temporaryPath, { recursive: true, errorOnExist: true, dereference: false });
        }
        if (await hashDirectory(temporaryPath) !== operation.sourceSha256) {
          throw new Error(`Runtime source changed while it was copied: ${operation.sourcePath ?? operation.path}`);
        }
        if (["directory", "file"].includes(snapshots.get(operation.path).kind)) {
          await rm(operation.path, { recursive: true, force: true });
        }
        await rename(temporaryPath, operation.path);
        temporaryPaths.delete(temporaryPath);
        writeCount += 1;
        if (failAfterWrite === writeCount) throw new Error("Simulated transaction failure");
        continue;
      }
      await mkdir(path.dirname(operation.path), { recursive: true });
      const temporaryPath = `${operation.path}.agentic-core-${randomUUID()}.tmp`;
      temporaryPaths.add(temporaryPath);
      await writeFile(temporaryPath, operation.content, { flag: "wx" });
      if (snapshots.get(operation.path).kind === "file") await rm(operation.path);
      await rename(temporaryPath, operation.path);
      temporaryPaths.delete(temporaryPath);
      writeCount += 1;
      if (failAfterWrite === writeCount) throw new Error("Simulated transaction failure");
    }

    await rm(backupRoot, { recursive: true, force: true });
  } catch (error) {
    const restorationErrors = [];
    for (const temporaryPath of temporaryPaths) {
      try {
        await rm(temporaryPath, { recursive: true, force: true });
      } catch (restorationError) {
        restorationErrors.push(restorationError);
      }
    }
    for (const operation of [...operations].reverse()) {
      const snapshot = snapshots.get(operation.path);
      try {
        await rm(operation.path, { recursive: true, force: true });
        if (snapshot.kind === "file") {
          await mkdir(path.dirname(operation.path), { recursive: true });
          await cp(snapshot.backupPath, operation.path);
        } else if (snapshot.kind === "directory") {
          await mkdir(path.dirname(operation.path), { recursive: true });
          await cp(snapshot.backupPath, operation.path, { recursive: true, errorOnExist: true });
        }
      } catch (restorationError) {
        restorationErrors.push(restorationError);
      }
    }
    let backupPreserved = true;
    if (restorationErrors.length === 0) {
      try {
        await rm(backupRoot, { recursive: true, force: true });
        backupPreserved = false;
      } catch (restorationError) {
        restorationErrors.push(restorationError);
      }
    }
    if (restorationErrors.length === 0) {
      for (const directory of [...missingDirectories].sort((left, right) => right.length - left.length)) {
        try {
          await rmdir(directory);
        } catch (restorationError) {
          if (restorationError?.code !== "ENOENT") restorationErrors.push(restorationError);
        }
      }
    }

    if (restorationErrors.length > 0) {
      const backup = backupPreserved ? ` Backup preserved at ${backupRoot}` : "";
      const failure = new Error(`Installation failed and restoration was incomplete.${backup}`, { cause: error });
      failure.code = "ERR_RESTORATION_FAILED";
      failure.backupPath = backupPreserved ? backupRoot : undefined;
      throw failure;
    }
    throw error;
  }
}
