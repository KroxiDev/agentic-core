import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { initialize } from "../src/init.js";
import { createTestProject } from "./project-builder.js";
import { hashDirectory } from "../src/transaction.js";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
const binary = path.join(repository, "bin", "agentic-core.js");
const selection = ["--provider", "codex", "--language", "python"];

async function run(root, args) {
  try {
    return {
      ...await execute(process.execPath, [binary, ...args], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
        env: { ...process.env, AGENTIC_CORE_OUTPUT: "json" },
      }),
      code: 0,
    };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("schema 3 update previews, preserves configuration and replaces only with force", async (t) => {
  const root = await createTestProject(t, { files: {
    "AGENTS.md": "# Host instructions\n",
    "pyproject.toml": "[project]\nname = 'consumer'\n",
    "uv.lock": "consumer lock\n",
    ".venv/sentinel": "consumer environment\n",
  } });
  const installed = await run(root, ["init", root, ...selection]);
  assert.equal(installed.code, 0, installed.stderr);
  const configPath = path.join(root, ".agentic-core", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.limits.crap = 5;
  const customizedConfig = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(configPath, customizedConfig);
  await writeFile(path.join(root, ".agentic-core", "golden-rules.md"), "user revision\n");
  const before = await hashDirectory(root);

  const preview = await run(root, ["update", root, "--dry-run"]);
  assert.equal(preview.code, 4, preview.stderr);
  const previewJson = JSON.parse(preview.stdout);
  assert.equal(previewJson.status, "blocked");
  assert.equal(previewJson.plan.error.code, "force_required");
  assert.equal(await hashDirectory(root), before);

  const updated = await run(root, ["update", root, "--force"]);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).status, "updated");
  assert.equal(await readFile(configPath, "utf8"), customizedConfig);
  assert.equal(await readFile(path.join(root, ".agentic-core", "golden-rules.md"), "utf8"),
    await readFile(path.join(repository, "golden-rules.md"), "utf8"));
  assert.equal(await readFile(path.join(root, "pyproject.toml"), "utf8"), "[project]\nname = 'consumer'\n");
  assert.equal(await readFile(path.join(root, "uv.lock"), "utf8"), "consumer lock\n");
  assert.equal(await readFile(path.join(root, ".venv", "sentinel"), "utf8"), "consumer environment\n");

  const runtimeForeign = path.join(root, ".agentic-core", "runtime", "foreign.txt");
  await writeFile(runtimeForeign, "keep runtime state\n");
  const runtimePreview = await run(root, ["update", root, "--force", "--dry-run"]);
  assert.equal(runtimePreview.code, 4, runtimePreview.stderr);
  assert.equal(JSON.parse(runtimePreview.stdout).plan.error.code, "foreign_state");
  assert.equal(await readFile(runtimeForeign, "utf8"), "keep runtime state\n");
  await rm(runtimeForeign);

  const toolsForeign = path.join(root, ".agentic-core", "tools", "foreign.txt");
  await writeFile(toolsForeign, "keep tools state\n");
  const toolsPreview = await run(root, ["update", root, "--force", "--dry-run"]);
  assert.equal(toolsPreview.code, 4, toolsPreview.stderr);
  assert.equal(JSON.parse(toolsPreview.stdout).plan.error.code, "foreign_state");
  assert.equal(await readFile(toolsForeign, "utf8"), "keep tools state\n");
  await rm(toolsForeign);

  const repeated = await run(root, ["update", root, "--dry-run"]);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).plan.actions.length, 0);
});

test("schema 3 uninstall removes verified resources and preserves foreign state in owned parents", async (t) => {
  const root = await createTestProject(t, { files: { "AGENTS.md": "# Host instructions\n" } });
  const installed = await run(root, ["init", root, ...selection]);
  assert.equal(installed.code, 0, installed.stderr);
  await mkdir(path.join(root, ".agentic-core", "quality"), { recursive: true });
  await writeFile(path.join(root, ".agentic-core", "quality", "foreign.txt"), "keep quality\n");
  await writeFile(path.join(root, ".agentic-core", "foreign.txt"), "keep foreign\n");
  const before = await hashDirectory(root);
  const preview = await run(root, ["uninstall", root, "--dry-run"]);
  assert.equal(preview.code, 0, preview.stderr);
  const previewJson = JSON.parse(preview.stdout);
  assert.ok(previewJson.actions.includes("resource: .agentic-core/config.json"));
  assert.ok(previewJson.preserved.some((item) => item.includes("quality")));
  assert.equal(await hashDirectory(root), before);

  const removed = await run(root, ["uninstall", root]);
  assert.equal(removed.code, 0, removed.stderr);
  const result = JSON.parse(removed.stdout);
  assert.ok(result.actions.includes("manifest: .agentic-core/ownership.json"));
  for (const relative of [
    ".agentic-core/config.json",
    ".agentic-core/config.schema.json",
    ".agentic-core/golden-rules.md",
    ".agentic-core/runtime",
    ".agentic-core/tools",
    ".agentic-core/ownership.json",
  ]) await assert.rejects(lstat(path.join(root, relative)), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, ".agentic-core", "foreign.txt"), "utf8"), "keep foreign\n");
  assert.equal(await readFile(path.join(root, ".agentic-core", "quality", "foreign.txt"), "utf8"), "keep quality\n");
  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /^# Host instructions\n/);
  assert.doesNotMatch(agents, /AGENTIC_CORE_START/);
});

test("schema 2 migration maps compatible limits and preserves legacy runs", async (t) => {
  const root = await createTestProject(t);
  await initialize(root);
  const productRoot = path.join(root, ".agentic-core");
  const configPath = path.join(productRoot, "config.json");
  await writeFile(configPath, `${JSON.stringify({
    $schema: "./config.schema.json",
    schemaVersion: 1,
    orchestration: {
      explicitActivationOnly: true,
      defaultMode: "normal",
      briefMaxBytes: 16_384,
      handoffMaxBytes: 32_768,
    },
    quality: { crapThreshold: 5, mutationWorkers: 2 },
  }, null, 2)}\n`);
  await mkdir(path.join(productRoot, "runs"), { recursive: true });
  await writeFile(path.join(productRoot, "runs", "legacy.json"), "legacy state\n");

  const preview = await run(root, ["update", root, "--dry-run"]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).plan.options.migration, true);
  assert.equal(JSON.parse(await readFile(path.join(productRoot, "ownership.json"), "utf8")).configVersion, 2);

  const migrated = await run(root, ["update", root]);
  assert.equal(migrated.code, 0, migrated.stderr);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const owner = JSON.parse(await readFile(path.join(productRoot, "ownership.json"), "utf8"));
  assert.equal(owner.configVersion, 3);
  assert.equal(config.schemaVersion, 3);
  assert.equal(config.limits.crap, 5);
  assert.equal(config.limits.operation.workers, 2);
  assert.equal(await readFile(path.join(productRoot, "runs", "legacy.json"), "utf8"), "legacy state\n");
});

test("ambiguous legacy configuration is diagnosed before migration writes", async (t) => {
  const root = await createTestProject(t);
  await initialize(root);
  const productRoot = path.join(root, ".agentic-core");
  const configPath = path.join(productRoot, "config.json");
  const ambiguous = `${JSON.stringify({
    $schema: "./config.schema.json",
    schemaVersion: 1,
    orchestration: { explicitActivationOnly: true, defaultMode: "normal" },
    coordination: { explicitActivationOnly: true, defaultMode: "normal" },
    quality: { crapThreshold: 7, mutationWorkers: 4 },
  }, null, 2)}\n`;
  await writeFile(configPath, ambiguous);
  const beforeManifest = await readFile(path.join(productRoot, "ownership.json"));
  const result = await run(root, ["update", root, "--dry-run"]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /configuration_conflict/);
  assert.equal(await readFile(configPath, "utf8"), ambiguous);
  assert.deepEqual(await readFile(path.join(productRoot, "ownership.json")), beforeManifest);
});
