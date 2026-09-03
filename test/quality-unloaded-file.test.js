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

test("PR-04: one unloaded file makes an attributable JavaScript scope globally unsupported", async (t) => {
  const root = await createTestProject(t, {
    manifest: {
      type: "module",
      scripts: { test: "node --test" },
    },
    files: {
      "src/covered.js": `
export function classify(value) {
  return value > 0 ? "positive" : "other";
}
`,
      "src/unloaded-adapter.js": `
export function adapt(value, fallback) {
  if (value && fallback) return value;
  return fallback;
}
`,
      "test/covered.test.js": `
import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "../src/covered.js";

test("covers both outcomes", () => {
  assert.equal(classify(1), "positive");
  assert.equal(classify(0), "other");
});
`,
    },
  });

  const report = await analyzeQuality({
    projectRoot: root,
    targets: ["src"],
    tool: "crap",
  });

  // This characterizes PR-04. When MJ-04 closes, invert this characterization:
  // the unloaded file must be not_loaded with zero coverage, and it must
  // penalize C.R.A.P. instead of blocking preparation.
  assert.equal(report.status, "unsupported_environment");
  // A language without a backend can produce the same status. Here the
  // JavaScript backend and runner are available; attribution is missing only
  // because the suite never loaded one in-scope file.
  assert.equal(report.language, "javascript-typescript");
  assert.equal(report.backend, "v8");
  assert.equal(report.runner, "node:test");
  assert.equal(report.summary.symbols, 1);
  assert.equal(report.summary.approved, 1);
  assert.equal(report.summary.failed, 0);
  assert.deepEqual(report.summary.unsupportedFiles, [
    "src/unloaded-adapter.js",
  ]);
  assert.equal(
    report.details.some(({ file }) => file === "src/unloaded-adapter.js"),
    false,
  );

  const covered = report.details.find(({ file, symbol }) =>
    file === "src/covered.js" && symbol === "classify");
  assert.ok(covered);
  assert.equal(covered.coverage.percentage, 100);
  assert.equal(covered.status, "approved");

  // The analyzer calculated the covered symbol, but the global unsupported
  // result discards that baseline, so it never becomes an open session result.
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
