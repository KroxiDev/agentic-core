import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { initialize } from "../src/init.js";
import { analyzeQuality } from "../src/quality/crap.js";
import { findPython } from "../src/quality/python.js";
import { createTestProject } from "./project-builder.js";

const execFileAsync = promisify(execFile);

function normalized(filePath) {
  const value = path.normalize(filePath);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function restoreEnvironment(name, existed, value) {
  if (existed) process.env[name] = value;
  else delete process.env[name];
}

async function runPython(runtime, root, source) {
  return execFileAsync(runtime.executable, [...runtime.prefix, "-c", source], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function pythonPrefix(runtime, root) {
  const { stdout } = await runPython(runtime, root, "import sys; print(sys.prefix)");
  return normalized(stdout.trim());
}

test("PR-09: Python analysis ignores the project virtual environment and declared suite", async (t) => {
  const dependency = `agentic_core_pr09_${randomUUID().replaceAll("-", "_")}`;
  const virtualPythonRelative = process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python";
  const declaredTestCommand = [
    virtualPythonRelative,
    "-m unittest discover -s python_checks -p \"test*.py\"",
  ].join(" ");
  let root;
  try {
    root = await createTestProject(t, {
      pythonVenv: true,
      manifest: {
        name: "python-venv-fixture",
        private: true,
        scripts: { "test:python": declaredTestCommand },
      },
      files: {
        "src/subject.py": `
def classify(value):
    if value > 0:
        return "positive"
    return "other"
`,
        "tests/test_fallback.py": `
import unittest
from pathlib import Path
from src.subject import classify

class FallbackTests(unittest.TestCase):
    def test_classifies_both_outcomes(self):
        Path("fallback-suite-ran.txt").write_text("fallback\\n", encoding="utf-8")
        self.assertEqual(classify(1), "positive")
        self.assertEqual(classify(0), "other")
`,
        "python_checks/test_subject.py": `
import unittest
from pathlib import Path
from ${dependency} import VALUE
from src.subject import classify

class DeclaredTests(unittest.TestCase):
    def test_uses_the_project_environment(self):
        Path("declared-suite-ran.txt").write_text("declared\\n", encoding="utf-8")
        self.assertEqual(VALUE, "venv-only")
        self.assertEqual(classify(1), "positive")
        self.assertEqual(classify(0), "other")
`,
      },
    });
  } catch (error) {
    if (error?.code === "ERR_PYTHON_UNAVAILABLE") {
      return t.skip("Python is unavailable; cannot create the PR-09 virtual environment fixture");
    }
    throw error;
  }

  const virtualPython = path.join(root, ...virtualPythonRelative.split("/"));
  await execFileAsync(virtualPython, ["-c", `
from pathlib import Path
import sysconfig
Path(sysconfig.get_path("purelib"), "${dependency}.py").write_text(
    "VALUE = 'venv-only'\\n", encoding="utf-8"
)
`], { cwd: root, encoding: "utf8", windowsHide: true });

  const virtualRuntime = { executable: virtualPython, prefix: [] };
  const virtualPrefix = normalized(await realpath(path.join(root, ".venv")));
  assert.equal(await pythonPrefix(virtualRuntime, root), virtualPrefix);
  assert.equal(
    (await runPython(virtualRuntime, root, `
import importlib.util
print("present" if importlib.util.find_spec("${dependency}") else "missing")
`)).stdout.trim(),
    "present",
  );
  await execFileAsync(virtualPython, [
    "-m",
    "unittest",
    "discover",
    "-s",
    "python_checks",
    "-p",
    "test*.py",
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  const declaredSuiteMarker = path.join(root, "declared-suite-ran.txt");
  await access(declaredSuiteMarker);
  await rm(declaredSuiteMarker);

  await initialize(root, { runtimeSource: null });
  // PR-09 is demonstrated behaviorally: the project declares its interpreter
  // in scripts["test:python"], initialize preserves it, and analysis still ignores it.
  assert.equal(
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts["test:python"],
    declaredTestCommand,
  );

  const hadPythonOverride = Object.hasOwn(process.env, "AGENTIC_CORE_PYTHON");
  const previousPythonOverride = process.env.AGENTIC_CORE_PYTHON;
  const hadBackendOverride = Object.hasOwn(process.env, "AGENTIC_CORE_PYTHON_BACKEND");
  const previousBackendOverride = process.env.AGENTIC_CORE_PYTHON_BACKEND;
  try {
    delete process.env.AGENTIC_CORE_PYTHON;
    process.env.AGENTIC_CORE_PYTHON_BACKEND = "trace";

    const detectedRuntime = await findPython(root);
    if (!detectedRuntime) {
      return t.skip("Python 3.10 or newer is unavailable for the PR-09 analysis fixture");
    }
    assert.notEqual(await pythonPrefix(detectedRuntime, root), virtualPrefix);
    assert.equal(
      (await runPython(detectedRuntime, root, `
import importlib.util
print("present" if importlib.util.find_spec("${dependency}") else "missing")
`)).stdout.trim(),
      "missing",
    );

    process.env.AGENTIC_CORE_PYTHON = virtualPython;
    const overriddenRuntime = await findPython(root);
    assert.ok(overriddenRuntime);
    assert.equal(await pythonPrefix(overriddenRuntime, root), virtualPrefix);
    delete process.env.AGENTIC_CORE_PYTHON;

    const report = await analyzeQuality({
      projectRoot: root,
      targets: ["src"],
      tool: "crap",
    });

    // The inversion contract for this PR-09 fixture lives in
    // issues/mejoras/mejora03.md; keep that note as the single source of truth.
    assert.equal(report.status, "approved");
    assert.equal(report.language, "python");
    assert.equal(report.backend, "stdlib-trace");
    assert.equal(report.runner, "unittest");
    assert.equal(report.inputInventory.commands.length, 1);
    assert.equal(report.inputInventory.commands[0].executable, detectedRuntime.executable);
    assert.notEqual(normalized(report.inputInventory.commands[0].executable), normalized(virtualPython));
    assert.deepEqual(
      report.inputInventory.entries
        .filter(({ kind }) => kind === "discovered_test")
        .map(({ path: inputPath }) => inputPath),
      ["python_checks/test_subject.py", "tests/test_fallback.py"],
    );
    await access(path.join(root, "fallback-suite-ran.txt"));
    await assert.rejects(
      access(declaredSuiteMarker),
      { code: "ENOENT" },
    );
  } finally {
    restoreEnvironment("AGENTIC_CORE_PYTHON", hadPythonOverride, previousPythonOverride);
    restoreEnvironment("AGENTIC_CORE_PYTHON_BACKEND", hadBackendOverride, previousBackendOverride);
  }
});
