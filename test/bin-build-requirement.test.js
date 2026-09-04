import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function cloneWithoutRuntime(t) {
  const cloneRoot = await mkdtemp(path.join(tmpdir(), "agentic-core-unbuilt-clone-"));
  t.after(() => rm(cloneRoot, { recursive: true, force: true }));
  await cp(path.join(repositoryRoot, "bin"), path.join(cloneRoot, "bin"), { recursive: true });
  await writeFile(path.join(cloneRoot, "package.json"), '{"type":"module"}\n');
  return cloneRoot;
}

async function runCloneBinary(cloneRoot, binary) {
  return execFileAsync(process.execPath, [path.join(cloneRoot, "bin", binary), "--version"], {
    cwd: cloneRoot,
    encoding: "utf8",
  });
}

test("CLI binaries explain how to build a missing generated runtime", async (t) => {
  const cloneRoot = await cloneWithoutRuntime(t);

  for (const binary of ["agentic-core.js", "agentic-quality.js"]) {
    await assert.rejects(
      runCloneBinary(cloneRoot, binary),
      (error) => {
        assert.equal(error.code, 1, binary);
        assert.equal(error.stdout, "", binary);
        assert.match(error.stderr, /generated runtime is missing/i, binary);
        assert.match(error.stderr, /npm install/, binary);
        assert.doesNotMatch(error.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/i, binary);
        return true;
      },
    );
  }
});

test("CLI binaries preserve failures inside an existing generated runtime", async (t) => {
  const cloneRoot = await cloneWithoutRuntime(t);
  const runtimeDirectory = path.join(cloneRoot, "dist", "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(
    path.join(runtimeDirectory, "agentic-core.mjs"),
    'await import("./missing-transitive-module.mjs");\n',
  );

  for (const binary of ["agentic-core.js", "agentic-quality.js"]) {
    await assert.rejects(runCloneBinary(cloneRoot, binary), (error) => {
      assert.equal(error.code, 1, binary);
      assert.equal(error.stdout, "", binary);
      assert.match(error.stderr, /ERR_MODULE_NOT_FOUND/, binary);
      assert.match(error.stderr, /missing-transitive-module\.mjs/, binary);
      assert.doesNotMatch(error.stderr, /generated runtime is missing/i, binary);
      return true;
    });
  }
});
