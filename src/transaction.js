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
    if (snapshot.kind === "other"
      || (snapshot.kind === "directory" && !["delete", "replace_directory"].includes(operation.type))) {
      throw new Error(`Transaction target is not compatible with the operation: ${operation.path}`);
    }
    if (operation.type === "replace_directory") {
      operation.sourcePath = path.resolve(operation.sourcePath);
      if (pathsOverlap(operation.sourcePath, operation.path)) {
        throw new Error(`Directory transaction source and destination overlap: ${operation.path}`);
      }
      const actualSourceHash = await hashDirectory(operation.sourcePath);
      if (actualSourceHash !== operation.sourceSha256) {
        throw new Error(`Runtime source changed before the transaction: ${operation.sourcePath}`);
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
        await cp(operation.sourcePath, temporaryPath, { recursive: true, errorOnExist: true, dereference: false });
        if (await hashDirectory(temporaryPath) !== operation.sourceSha256) {
          throw new Error(`Runtime source changed while it was copied: ${operation.sourcePath}`);
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
      throw new Error(`Installation failed and restoration was incomplete.${backup}`, { cause: error });
    }
    throw error;
  }
}
