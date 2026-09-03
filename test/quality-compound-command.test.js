import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { analyzeQuality } from "../src/quality/crap.js";
import { createTestProject } from "./project-builder.js";

const declaredRunnerArgs = [
  "node_modules/vitest/vitest.mjs",
  "run",
  "--config",
  "vitest.config.mjs",
];
const declaredTestCommand = [
  "node scripts/prepare-tests.js && node",
  ...declaredRunnerArgs,
].join(" ");

test("PR-02: analysis replaces the declared compound test command", async (t) => {
  const root = await createTestProject(t, {
    manifest: {
      type: "module",
      scripts: { test: declaredTestCommand },
    },
    files: {
      "src/subject.js": `
export function classify(value) {
  return value > 0 ? "positive" : "other";
}
`,
      "scripts/prepare-tests.js": `
import { writeFile } from "node:fs/promises";
await writeFile("pretest-ran.txt", "prepared\\n");
`,
      "vitest.config.mjs": `
export default { evidence: "runner-config-ran.txt" };
`,
      "node_modules/vitest/vitest.mjs": `
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classify } from "../../src/subject.js";

const configFlag = process.argv.indexOf("--config");
if (configFlag >= 0) {
  const configPath = path.resolve(process.argv[configFlag + 1]);
  const { default: config } = await import(pathToFileURL(configPath));
  await writeFile(config.evidence, "configured\\n");
}
if (classify(1) !== "positive" || classify(0) !== "other") {
  process.exitCode = 1;
}
`,
    },
  });

  const report = await analyzeQuality({
    projectRoot: root,
    targets: ["src"],
    tool: "crap",
  });

  // This characterizes PR-02. When MJ-03 closes, invert the trace and
  // invocation assertions: the declared pre-step and runner configuration
  // must execute, and the recorded command must match the project contract.
  assert.equal(report.status, "approved");
  assert.equal(
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts.test,
    declaredTestCommand,
  );
  await assert.rejects(
    access(path.join(root, "pretest-ran.txt")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    access(path.join(root, "runner-config-ran.txt")),
    { code: "ENOENT" },
  );

  // The report reduces the declaration to a family label and records a
  // generated invocation without the pre-step or runner configuration.
  assert.equal(report.runner, "vitest");
  assert.equal(report.inputInventory.runner, "vitest");
  assert.equal(report.inputInventory.commands.length, 1);
  assert.equal(report.inputInventory.commands[0].executable, process.execPath);
  assert.deepEqual(report.inputInventory.commands[0].args, [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--exclude",
    "**/.agentic-core/**",
  ]);
  assert.notDeepEqual(report.inputInventory.commands[0].args, declaredRunnerArgs);
  assert.equal(report.inputInventory.commands[0].args.includes("--config"), false);
  assert.equal(report.inputInventory.commands[0].args.includes("vitest.config.mjs"), false);
  assert.equal(report.inputInventory.entries.some(({ kind, path: inputPath }) =>
    kind === "runner_configuration" && inputPath === "vitest.config.mjs"), true);
});
