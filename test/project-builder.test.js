import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTestProject } from "./project-builder.js";

const execFileAsync = promisify(execFile);

test("creates arbitrary nested mixed-language and binary file trees", async (t) => {
  const binary = Uint8Array.from([0, 255, 16, 128]);
  const root = await createTestProject(t, {
    files: {
      "src/javascript/subject.js": "export const language = \"javascript\";\n",
      "src/python/subject.py": "language = \"python\"\n",
      "checks/custom/nested/test_subject.py": "def test_subject(): pass\n",
      "resources/payload.bin": binary,
    },
  });
  const relativeToTemporaryRoot = path.relative(await realpath(tmpdir()), await realpath(root));

  assert.notEqual(relativeToTemporaryRoot, "");
  assert.equal(relativeToTemporaryRoot.startsWith(`..${path.sep}`), false);
  assert.equal(path.isAbsolute(relativeToTemporaryRoot), false);
  assert.equal(
    await readFile(path.join(root, "src", "javascript", "subject.js"), "utf8"),
    "export const language = \"javascript\";\n",
  );
  assert.equal(
    await readFile(path.join(root, "src", "python", "subject.py"), "utf8"),
    "language = \"python\"\n",
  );
  assert.equal(
    await readFile(path.join(root, "checks", "custom", "nested", "test_subject.py"), "utf8"),
    "def test_subject(): pass\n",
  );
  assert.deepEqual(
    await readFile(path.join(root, "resources", "payload.bin")),
    Buffer.from(binary),
  );
});

test("writes the declared manifest without changing compound scripts", async (t) => {
  const manifest = {
    name: "mixed-project",
    type: "module",
    scripts: {
      test: "node --test test/unit/*.test.js && python -m unittest discover -s checks -p \"test_*.py\"",
      verify: "node --check src/index.js || python -m compileall src",
    },
  };
  const root = await createTestProject(t, { files: {}, manifest });

  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")),
    manifest,
  );
});

test("rejects every path that could escape or target the project root", async (t) => {
  const outside = path.join(tmpdir(), `agentic-core-outside-${randomUUID()}.txt`);
  t.after(() => rm(outside, { force: true }));
  const unsafePaths = [
    outside,
    "",
    "../outside.txt",
    "..\\outside.txt",
    "nested/../../outside.txt",
    "C:outside.txt",
    ".",
  ];

  for (const unsafePath of unsafePaths) {
    await assert.rejects(
      createTestProject(t, { files: { [unsafePath]: "unsafe" } }),
      (error) => error instanceof TypeError && error.code === "ERR_INVALID_PROJECT_PATH",
    );
  }
  await assert.rejects(access(outside), { code: "ENOENT" });
});

test("creates a minimal real Python virtual environment when Python is available", async (t) => {
  let root;
  try {
    root = await createTestProject(t, {
      files: { "custom-tests/test_subject.py": "def test_subject(): pass\n" },
      pythonVenv: true,
    });
  } catch (error) {
    if (error?.code === "ERR_PYTHON_UNAVAILABLE") {
      return t.skip("Python is unavailable; cannot create a real virtual environment");
    }
    throw error;
  }

  const virtualPython = process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
  const { stdout } = await execFileAsync(virtualPython, [
    "-c",
    "import os,sys; print(os.path.normcase(os.path.realpath(sys.prefix)))",
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  const expectedPrefix = path.normalize(await realpath(path.join(root, ".venv")));
  assert.equal(
    stdout.trim(),
    process.platform === "win32" ? expectedPrefix.toLowerCase() : expectedPrefix,
  );
});

test("registers and performs cleanup when the owning test finishes", async (t) => {
  let root;
  await t.test("owns one temporary project", async (projectTest) => {
    let cleanupRegistered = false;
    const context = {
      after(cleanup) {
        cleanupRegistered = true;
        projectTest.after(cleanup);
      },
    };
    const files = new Proxy({}, {
      ownKeys() {
        assert.equal(cleanupRegistered, true);
        return [];
      },
    });
    root = await createTestProject(context, { files });
    await access(root);
  });

  await assert.rejects(access(root), { code: "ENOENT" });
});

test("removes the temporary project when preparation fails", async (t) => {
  let failedPath;
  await assert.rejects(
    createTestProject(t, {
      files: {
        collision: "regular file",
        "collision/nested.txt": "cannot be written below a regular file",
      },
    }),
    (error) => {
      failedPath = error.path;
      return typeof failedPath === "string";
    },
  );

  await assert.rejects(access(path.dirname(failedPath)), { code: "ENOENT" });
});
