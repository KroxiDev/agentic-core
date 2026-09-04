import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTestProject } from "./project-builder.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceRuntime = path.join(repositoryRoot, "src", "runtime-entry.mjs");
const excludedModule = "src/data/access-policy.js";
const checkpointOnlyModule = "scripts/checkpoint-only.js";

async function prepare(root) {
  try {
    const result = await execFileAsync(process.execPath, [
      sourceRuntime,
      "agentic-quality",
      "prepare",
      "--mode",
      "normal",
      "--scope",
      "src",
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AGENTIC_CORE_OUTPUT: "json" },
      windowsHide: true,
    });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("PR-08: a production module under src/data disappears silently from a favorable quality session", async (t) => {
  const root = await createTestProject(t, {
    manifest: {
      type: "module",
      scripts: { test: "node --test" },
    },
    files: {
      "src/data.js": `
export function classify(value) {
  return value > 0 ? "positive" : "other";
}
`,
      [excludedModule]: `
export function decideAccess({ administrator, owner, active, blocked }) {
  if (administrator) return "allow";
  if (owner) return "allow";
  if (active && !blocked) return "review";
  return "deny";
}
`,
      "test/data.test.js": `
import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "../src/data.js";
import { decideAccess } from "../${excludedModule}";

test("uses the visible and data-directory modules", () => {
  assert.equal(classify(1), "positive");
  assert.equal(classify(0), "other");
  assert.equal(decideAccess({ administrator: true }), "allow");
});
`,
      [checkpointOnlyModule]: "export const checkpointOnly = true;\n",
    },
  });

  const prepared = await prepare(root);
  assert.equal(prepared.code, 0, prepared.stderr || prepared.stdout);
  assert.equal(prepared.stderr, "");

  const { id } = JSON.parse(prepared.stdout);
  const sessionRoot = path.join(root, ".agentic-core", "quality", id);
  const [checkpoint, baseline] = await Promise.all([
    readFile(path.join(sessionRoot, "checkpoint", "inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(sessionRoot, "baseline", "crap.json"), "utf8").then(JSON.parse),
  ]);
  const checkpointPaths = new Set(checkpoint.entries.map((entry) => entry.path));
  const analyzedFiles = new Set(baseline.details.map((detail) => detail.file));
  const analysisInputPaths = new Set(
    baseline.inputInventory.entries.map((entry) => entry.path),
  );

  // This characterizes PR-08. inputs.js:10, crap.js:22, mutation.js:17 and
  // doctor.js:25 still hold four non-identical exclusion lists, but only
  // doctor's diverges observably: the other two are strict subsets of
  // inputs.js and their walks re-filter every child through
  // qualityPathIsExcluded (crap.js:38, mutation.js:140), so they can only
  // narrow. No checkpoint-versus-analysis divergence is therefore attributable
  // to the lists. The pair below diverges by kind instead: checkpointKind
  // labels out-of-scope code `support_code` while inputKind returns undefined.
  assert.equal(checkpointPaths.has(checkpointOnlyModule), true);
  assert.equal(analysisInputPaths.has(checkpointOnlyModule), false);

  // Merely turning `data` from a filename into a path segment makes legitimate
  // production logic disappear from both evidence paths. It is not reported as
  // unsupported and produces no baseline warning, so the session stays green.
  // The visible twin anchors the analysis: without it the absence assertions
  // below would also hold over an empty report.
  assert.equal(checkpointPaths.has("src/data.js"), true);
  assert.equal(analysisInputPaths.has("src/data.js"), true);
  assert.equal(analyzedFiles.has("src/data.js"), true);
  assert.equal(checkpointPaths.has(excludedModule), false);
  assert.equal(analysisInputPaths.has(excludedModule), false);
  assert.equal(analyzedFiles.has(excludedModule), false);
  assert.equal(JSON.stringify(baseline).includes(excludedModule), false);
  assert.deepEqual(baseline.summary.unsupportedFiles, []);
  assert.equal(baseline.summary.baselineWarnings, 0);
  assert.equal(
    baseline.details.some((detail) => detail.baseline.warning !== undefined),
    false,
  );
  assert.equal(baseline.status, "approved");

  // When MJ-06 closes, invert the excluded-module and favorable-verdict
  // assertions. Unifying the four lists will not move the kind divergence
  // above, so MJ-06 must carry its own check that doctor.js and the gate stop
  // disagreeing. The mandatory secret exclusions remain a separate hard
  // boundary and are deliberately untouched by this characterization.
});
