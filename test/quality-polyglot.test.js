import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { analyzeQuality } from "../src/quality/crap.js";
import {
  prepareQualitySession,
  QualitySessionError,
} from "../src/quality/session.js";
import { createTestProject } from "./project-builder.js";

test("PR-01: one Python file makes a JavaScript scope globally unsupported", async (t) => {
  const root = await createTestProject(t, {
    files: {
      "src/subject.js": "export function subject() { return true; }\n",
      "src/python_helper.py": "def python_helper():\n    return True\n",
    },
  });

  // This characterizes PR-01. When MJ-04 closes, invert these assertions to
  // require per-backend results and a QualitySession that opens successfully.
  const report = await analyzeQuality({
    projectRoot: root,
    targets: ["src"],
    tool: "crap",
  });

  assert.equal(report.status, "unsupported_language");
  assert.equal(report.language, "mixed");
  assert.equal(report.summary.symbols, 0);
  assert.deepEqual(report.details, []);
  assert.deepEqual(
    new Set(report.summary.unsupportedFiles),
    new Set(["src/python_helper.py", "src/subject.js"]),
  );

  await assert.rejects(
    prepareQualitySession({
      projectRoot: root,
      mode: "normal",
      scopes: ["src"],
    }),
    (error) => {
      assert.ok(error instanceof QualitySessionError);
      assert.equal(error.exitCode, 2);
      assert.equal(
        error.message,
        "Quality baseline is not attributable in this environment",
      );
      return true;
    },
  );
  await assert.rejects(
    access(path.join(root, ".agentic-core", "quality")),
    { code: "ENOENT" },
  );
});
