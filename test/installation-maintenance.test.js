import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const lightResources = [
  ["adapters/codex/agents/agentic-docs.toml", ".codex/agents/agentic-docs.toml"],
  ["adapters/codex/agents/agentic-read.toml", ".codex/agents/agentic-read.toml"],
  ["adapters/codex/agents/agentic-production.toml", ".codex/agents/agentic-production.toml"],
  ["adapters/codex/agents/agentic-tests.toml", ".codex/agents/agentic-tests.toml"],
  ["skills/orquestar/SKILL.md", ".agents/skills/orquestar/SKILL.md"],
  ["skills/agentic-tdd/SKILL.md", ".agents/skills/agentic-tdd/SKILL.md"],
];

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

for (const collision of [false, true]) {
  test(`technical schema 3 gains Documentador and preserves ${collision ? "foreign docs profile" : "existing tools"}`, async (t) => {
    const root = await createTestProject(t);
    assert.equal((await run(root, ["init", root, ...selection])).code, 0);
    const ownerPath = path.join(root, ".agentic-core/ownership.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    const target = ".codex/agents/agentic-docs.toml";
    owner.resources = owner.resources.filter((resource) => resource.path !== target);
    const readTarget = ".codex/agents/agentic-read.toml";
    const previousReadProfile = "Perfil técnico anterior al cierre documental.\n";
    await writeFile(path.join(root, readTarget), previousReadProfile);
    owner.resources.find((resource) => resource.path === readTarget).sha256 =
      createHash("sha256").update(previousReadProfile).digest("hex");
    await writeFile(ownerPath, JSON.stringify(owner));
    await rm(path.join(root, target));
    if (collision) await writeFile(path.join(root, target), "foreign docs profile\n");
    const before = await hashDirectory(root);
    const preview = await run(root, ["update", root, "--dry-run"]);
    assert.equal(preview.code, collision ? 4 : 0, preview.stderr);
    assert.equal(await hashDirectory(root), before);
    const result = await run(root, ["update", root, ...(collision ? ["--force"] : [])]);
    assert.equal(result.code, collision ? 4 : 0, result.stderr);
    if (collision) {
      assert.equal(JSON.parse(preview.stdout).plan.error.code, "unowned_resource");
      assert.equal(await hashDirectory(root), before);
    } else {
      assert.deepEqual(await readFile(path.join(root, target)),
        await readFile(path.join(repository, "adapters/codex/agents/agentic-docs.toml")));
      const expectedReadProfile = await readFile(path.join(repository, "adapters/codex/agents/agentic-read.toml"));
      assert.deepEqual(await readFile(path.join(root, readTarget)), expectedReadProfile);
      const updated = JSON.parse(await readFile(ownerPath, "utf8"));
      assert.equal(updated.resources.find((resource) => resource.path === readTarget).sha256,
        createHash("sha256").update(expectedReadProfile).digest("hex"));
      assert.equal(updated.tools.treeSha256, owner.tools.treeSha256);
      assert.equal((await run(root, ["doctor", root])).code, 0);
      const repeated = await run(root, ["update", root, "--dry-run"]);
      assert.equal(JSON.parse(repeated.stdout).plan.actions.length, 0);
    }
  });
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
  const installedOwner = JSON.parse(await readFile(path.join(root, ".agentic-core/ownership.json"), "utf8"));
  for (const [source, target] of lightResources) {
    const expected = await readFile(path.join(repository, source));
    assert.deepEqual(await readFile(path.join(root, target)), expected);
    assert.equal(installedOwner.resources.find((resource) => resource.path === target).sha256,
      createHash("sha256").update(expected).digest("hex"));
  }
  const configPath = path.join(root, ".agentic-core", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.limits.crap = 5;
  const customizedConfig = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(configPath, customizedConfig);
  await writeFile(path.join(root, ".agentic-core", "golden-rules.md"), "user revision\n");
  await writeFile(path.join(root, ".codex", "agents", "agentic-production.toml"), "user revision\n");
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
  for (const [source, target] of lightResources) {
    assert.deepEqual(await readFile(path.join(root, target)), await readFile(path.join(repository, source)));
  }
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
    ...lightResources.map(([, target]) => target),
  ]) await assert.rejects(lstat(path.join(root, relative)), { code: "ENOENT" }, relative);
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

test("schema 2 migration restores a missing managed AGENTS block without changing host instructions", async (t) => {
  const root = await createTestProject(t);
  await initialize(root);
  const agentsPath = path.join(root, "AGENTS.md");
  const hostInstructions = "# Consumer instructions\n\nKeep this text.\n";
  await writeFile(agentsPath, hostInstructions);

  const migrated = await run(root, ["update", root]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.equal(JSON.parse(migrated.stdout).status, "updated");
  const agents = await readFile(agentsPath, "utf8");
  assert.match(agents, /^# Consumer instructions\n\nKeep this text\.\n/u);
  assert.match(agents, /<!-- AGENTIC_CORE_START -->[\s\S]*<!-- AGENTIC_CORE_END -->/u);

  const doctor = await run(root, ["doctor", root]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).status, "healthy");
});

for (const [scenario, ambiguous] of [
  ["unterminated", "# Consumer instructions\n<!-- AGENTIC_CORE_START -->\nunterminated\n"],
  ["orphan end", "<!-- AGENTIC_CORE_END -->\n"],
  ["end before block", "<!-- AGENTIC_CORE_END -->\n<!-- AGENTIC_CORE_START -->\nmanaged\n<!-- AGENTIC_CORE_END -->\n"],
]) {
  test(`schema 2 migration blocks ${scenario} AGENTS markers before publishing schema 3 ownership`, async (t) => {
    const root = await createTestProject(t);
    await initialize(root);
    const productRoot = path.join(root, ".agentic-core");
    const agentsPath = path.join(root, "AGENTS.md");
    await writeFile(agentsPath, ambiguous);
    const before = await hashDirectory(root);
    const previousManifest = await readFile(path.join(productRoot, "ownership.json"));

    const preview = await run(root, ["update", root, "--dry-run"]);
    assert.equal(preview.code, 4, preview.stderr);
    const result = JSON.parse(preview.stdout);
    assert.equal(result.status, "blocked");
    assert.equal(result.plan.error.code, "ambiguous_managed_block");
    const applied = await run(root, ["update", root, "--force"]);
    assert.notEqual(applied.code, 0, applied.stdout + applied.stderr);
    assert.equal(await hashDirectory(root), before);
    assert.equal(await readFile(agentsPath, "utf8"), ambiguous);
    assert.deepEqual(await readFile(path.join(productRoot, "ownership.json")), previousManifest);
  });
}

for (const collision of [false, true]) {
  test(`pre-Light schema 3 update ${collision ? "preserves unowned profiles" : "installs Light without force"}`, async (t) => {
    const root = await createTestProject(t, { files: { "AGENTS.md": "# User instructions\n" } });
    const installed = await run(root, ["init", root, ...selection]);
    assert.equal(installed.code, 0, installed.stderr);
    const ownerPath = path.join(root, ".agentic-core/ownership.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    const lightPaths = new Set(lightResources.map(([, target]) => target));
    owner.resources = owner.resources.filter(({ path: target }) => !lightPaths.has(target));
    delete owner.ownedDirectories;
    for (const target of lightPaths) await rm(path.join(root, target));
    const oldBlock = "<!-- AGENTIC_CORE_START -->\n## agentic-core\nLight pendiente de integracion.\n<!-- AGENTIC_CORE_END -->";
    owner.managedBlocks[0].sha256 = createHash("sha256").update(oldBlock).digest("hex");
    await writeFile(path.join(root, "AGENTS.md"), `# User instructions\n${oldBlock}\n`);
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
    if (collision) await writeFile(path.join(root, lightResources[0][1]), "user profile\n");
    const before = await hashDirectory(root);
    const preview = await run(root, ["update", root, "--dry-run"]);
    assert.equal(preview.code, collision ? 4 : 0, preview.stderr);
    assert.equal(await hashDirectory(root), before);
    const updated = await run(root, ["update", root, ...(collision ? ["--force"] : [])]);
    assert.equal(updated.code, collision ? 4 : 0, updated.stderr);
    if (collision) {
      assert.equal(JSON.parse(preview.stdout).plan.error.code, "unowned_resource");
      assert.equal(await hashDirectory(root), before);
    } else {
      for (const [source, target] of lightResources) {
        assert.deepEqual(await readFile(path.join(root, target)), await readFile(path.join(repository, source)));
      }
      const nextOwner = JSON.parse(await readFile(ownerPath, "utf8"));
      assert.equal(nextOwner.resources.length, 11);
      assert.equal(nextOwner.tools.treeSha256, owner.tools.treeSha256);
      assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /^# User instructions/);
      assert.equal((await run(root, ["update", root, "--dry-run"])).code, 0);
    }
  });
}


for (const collision of [false, true]) {
  test(`Light installation gains Normal while preserving ${collision ? "a foreign read profile" : "existing resources"}`, async (t) => {
    const root = await createTestProject(t);
    assert.equal((await run(root, ["init", root, ...selection])).code, 0);
    const ownerPath = path.join(root, ".agentic-core/ownership.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    const target = ".codex/agents/agentic-read.toml";
    owner.resources = owner.resources.filter((resource) => resource.path !== target
      && resource.path !== ".codex/agents/agentic-docs.toml");
    await rm(path.join(root, ".codex/agents/agentic-docs.toml"));
    await writeFile(ownerPath, JSON.stringify(owner));
    await rm(path.join(root, target));
    if (collision) await writeFile(path.join(root, target), "foreign read profile\n");
    const before = await hashDirectory(root);
    const result = await run(root, ["update", root]);
    assert.equal(result.code, collision ? 4 : 0, result.stderr);
    if (collision) {
      assert.equal(await hashDirectory(root), before);
    } else {
      assert.deepEqual(await readFile(path.join(root, target)),
        await readFile(path.join(repository, "adapters/codex/agents/agentic-read.toml")));
      const updated = JSON.parse(await readFile(ownerPath, "utf8"));
      assert.equal(updated.tools.treeSha256, owner.tools.treeSha256);
      assert.equal((await run(root, ["doctor", root])).code, 0);
    }
  });
}
