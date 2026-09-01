import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { uninstallInstallation } from "../src/init.js";
import { hashDirectory } from "../src/transaction.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const maintenanceCli = path.join(repositoryRoot, "bin", "agentic-core.js");

async function createProject(t) {
  const project = await mkdtemp(path.join(tmpdir(), "agentic core project "));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(project, { recursive: true, force: true }));
  });
  return project;
}

async function createNpxRuntime(t, options = {}) {
  const runtime = await mkdtemp(path.join(tmpdir(), "agentic core npx runtime "));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(runtime, { recursive: true, force: true }));
  });
  const packageRoot = path.join(runtime, "node_modules", "@kroxidev", "agentic-core");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  const commit = options.commit ?? "348942743d01227c60ba707e22f5c3976fe6e4e7";
  await writeFile(path.join(runtime, "package.json"), `${JSON.stringify({
    dependencies: { "@kroxidev/agentic-core": "github:KroxiDev/agentic-core" },
    _npx: { packages: ["github:KroxiDev/agentic-core"] },
  }, null, 2)}\n`);
  await writeFile(path.join(runtime, "package-lock.json"), `${JSON.stringify({
    name: "agentic-core-npx-runtime",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@kroxidev/agentic-core": "github:KroxiDev/agentic-core" } },
      "node_modules/@kroxidev/agentic-core": {
        name: "@kroxidev/agentic-core",
        version: "0.2.0",
        resolved: `git+ssh://git@github.com/KroxiDev/agentic-core.git#${commit}`,
        bin: { "agentic-core": "bin/agentic-core.js", "agentic-quality": "bin/agentic-quality.js" },
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
    name: "@kroxidev/agentic-core",
    version: "0.2.0",
    type: "module",
    bin: { "agentic-core": "bin/agentic-core.js", "agentic-quality": "bin/agentic-quality.js" },
  }, null, 2)}\n`);
  await writeFile(path.join(packageRoot, "bin", "agentic-core.js"),
    "if (process.argv.includes('--version')) process.stdout.write('0.2.0\\n');\n");
  await writeFile(path.join(packageRoot, "bin", "agentic-quality.js"),
    "if (process.argv.includes('--help')) process.stdout.write('agentic-quality test help\\n');\n");
  await cp(path.join(repositoryRoot, "dist", "runtime"), path.join(packageRoot, "dist", "runtime"), {
    recursive: true,
    errorOnExist: true,
  });
  await writeFile(path.join(packageRoot, "REVISION"), `${commit}\n`);
  return { runtime, commit };
}

async function runCore(args, options = {}) {
  return execFileAsync(process.execPath, [maintenanceCli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function snapshotFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = new Map();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    const logicalPath = childRelative.replaceAll("\\", "/");
    const details = await lstat(path.join(root, childRelative));
    if (entry.isDirectory()) {
      snapshot.set(logicalPath, { kind: "directory", mode: details.mode });
      const children = await snapshotFiles(root, childRelative);
      for (const [filePath, content] of children) snapshot.set(filePath, content);
    } else {
      snapshot.set(logicalPath, {
        kind: details.isFile() ? "file" : "other",
        mode: details.mode,
        content: details.isFile() ? await readFile(path.join(root, childRelative)) : undefined,
      });
    }
  }
  return snapshot;
}

function assertSameSnapshot(actual, expected) {
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  for (const [filePath, content] of expected) assert.deepEqual(actual.get(filePath), content, filePath);
}

test("init installs the canonical direct-mode configuration and records ownership", async (t) => {
  const project = await createProject(t);

  const result = await runCore(["init", project, "--yes"]);

  assert.match(result.stdout, /Installed agentic-core 0\.2\.0/);

  const sourceRules = await readFile(path.join(repositoryRoot, "golden-rules.md"));
  const installedRules = await readFile(path.join(project, ".agentic-core", "golden-rules.md"));
  assert.deepEqual(installedRules, sourceRules);

  const config = JSON.parse(await readFile(path.join(project, ".agentic-core", "config.json"), "utf8"));
  assert.deepEqual(config, {
    $schema: "./config.schema.json",
    schemaVersion: 2,
    coordination: {
      explicitActivationOnly: true,
      defaultMode: "normal",
    },
    quality: { crapThreshold: 7, mutationWorkers: 4 },
  });

  const schema = JSON.parse(await readFile(path.join(project, ".agentic-core", "config.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.coordination.additionalProperties, false);
  assert.equal(schema.properties.quality.additionalProperties, false);

  const agents = await readFile(path.join(project, "AGENTS.md"), "utf8");
  const claude = await readFile(path.join(project, "CLAUDE.md"), "utf8");
  for (const hostInstructions of [agents, claude]) {
    assert.match(hostInstructions, /<!-- AGENTIC_CORE_START -->/);
    assert.match(hostInstructions, /If a request begins with `Orquesta`, `\/orquestar`, or `\$orquestar`, load and follow `.agents\/skills\/orquestar\/SKILL\.md`/);
    assert.match(hostInstructions, /QUALITY_OK/);
    assert.match(hostInstructions, /Requests without one of those activators run directly/);
  }

  await assert.rejects(stat(path.join(project, ".agentic-core", "runs")), { code: "ENOENT" });

  const manifest = JSON.parse(await readFile(path.join(project, ".agentic-core", "ownership.json"), "utf8"));
  assert.equal(manifest.product, "@kroxidev/agentic-core");
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.configVersion, 2);
  assert.match(manifest.installationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(manifest.resources.map(({ path: resourcePath }) => resourcePath), [
    ".agentic-core/.gitignore",
    ".agentic-core/config.json",
    ".agentic-core/config.schema.json",
    ".agentic-core/golden-rules.md",
    ".agentic-core/runtime-launcher.mjs",
    ".codex/agents/agentic-read.toml",
    ".claude/agents/agentic-read.md",
    ".codex/agents/agentic-production.toml",
    ".claude/agents/agentic-production.md",
    ".codex/agents/agentic-tests.toml",
    ".claude/agents/agentic-tests.md",
    ".codex/agents/agentic-docs.toml",
    ".claude/agents/agentic-docs.md",
    ".agents/skills/orquestar/SKILL.md",
    ".claude/skills/orquestar/SKILL.md",
    ".agents/skills/agentic-tdd/SKILL.md",
    ".claude/skills/agentic-tdd/SKILL.md",
    ".agents/skills/agentic-grilling/SKILL.md",
    ".claude/skills/agentic-grilling/SKILL.md",
  ]);
  for (const resource of manifest.resources) {
    const content = await readFile(path.join(project, ...resource.path.split("/")));
    assert.equal(resource.sha256, sha256(content));
  }
  assert.deepEqual(manifest.managedBlocks.map(({ path: blockPath }) => blockPath), ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(manifest.ownedDirectories, [
    ".agentic-core/quality",
    ".agents/skills/orquestar",
    ".agents/skills/agentic-tdd",
    ".agents/skills/agentic-grilling",
    ".claude/skills/orquestar",
    ".claude/skills/agentic-tdd",
    ".claude/skills/agentic-grilling",
  ]);
});

test("init keeps generated QualitySession evidence out of Git", async (t) => {
  const project = await createProject(t);
  await execFileAsync("git", ["init", "--quiet"], { cwd: project, encoding: "utf8" });

  await runCore(["init", project, "--yes"]);

  assert.equal(
    await readFile(path.join(project, ".agentic-core", ".gitignore"), "utf8"),
    "/quality/\n",
  );
  const sessionPath = ".agentic-core/quality/q_000000000000000000000000/session.json";
  await mkdir(path.dirname(path.join(project, sessionPath)), { recursive: true });
  await writeFile(path.join(project, sessionPath), "{}\n");
  const ignored = await execFileAsync(
    "git",
    ["check-ignore", "--verbose", "--no-index", sessionPath],
    { cwd: project, encoding: "utf8" },
  );
  assert.match(ignored.stdout, /^\.agentic-core\/\.gitignore:1:\/quality\//);
  await assert.rejects(
    execFileAsync(
      "git",
      ["check-ignore", "--no-index", ".agentic-core/config.json"],
      { cwd: project, encoding: "utf8" },
    ),
    { code: 1 },
  );
});

test("init never claims a pre-existing quality directory without ownership", async (t) => {
  const project = await createProject(t);
  const qualityPath = path.join(project, ".agentic-core", "quality");
  await mkdir(qualityPath, { recursive: true });
  await writeFile(path.join(qualityPath, "foreign-evidence.txt"), "preserve me\n");

  await assert.rejects(
    runCore(["init", project, "--yes", "--replace-conflicts"]),
    /quality.*without proven ownership/i,
  );
  assert.equal(await readFile(path.join(qualityPath, "foreign-evidence.txt"), "utf8"), "preserve me\n");
  await assert.rejects(stat(path.join(project, ".agentic-core", "ownership.json")), { code: "ENOENT" });
});

test("init --dry-run reports its complete write plan without changing the destination", async (t) => {
  const project = await createProject(t);
  await writeFile(path.join(project, ".hidden-input"), Buffer.from([0x00, 0x0d, 0x0a, 0xff]));
  await writeFile(path.join(project, "AGENTS.md"), "# Existing instructions\r\n");
  const before = await snapshotFiles(project);

  const result = await runCore(["init", project, "--yes", "--dry-run"]);
  const plan = JSON.parse(result.stdout);
  const repeatedPlan = JSON.parse((await runCore(["init", project, "--yes", "--dry-run"])).stdout);

  assert.equal(plan.command, "init");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.status, "ready");
  assert.equal(plan.manifest.product, "@kroxidev/agentic-core");
  assert.deepEqual(plan.actions.map(({ path: actionPath }) => actionPath), [
    ".agentic-core/.gitignore",
    ".agentic-core/config.json",
    ".agentic-core/config.schema.json",
    ".agentic-core/golden-rules.md",
    ".agentic-core/runtime-launcher.mjs",
    ".codex/agents/agentic-read.toml",
    ".claude/agents/agentic-read.md",
    ".codex/agents/agentic-production.toml",
    ".claude/agents/agentic-production.md",
    ".codex/agents/agentic-tests.toml",
    ".claude/agents/agentic-tests.md",
    ".codex/agents/agentic-docs.toml",
    ".claude/agents/agentic-docs.md",
    ".agents/skills/orquestar/SKILL.md",
    ".claude/skills/orquestar/SKILL.md",
    ".agents/skills/agentic-tdd/SKILL.md",
    ".claude/skills/agentic-tdd/SKILL.md",
    ".agents/skills/agentic-grilling/SKILL.md",
    ".claude/skills/agentic-grilling/SKILL.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".agentic-core/ownership.json",
  ]);
  assert.deepEqual(repeatedPlan, plan);
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("the GitHub npx bootstrap previews and transactionally persists the exact runtime seams", async (t) => {
  const project = await createProject(t);
  const { runtime, commit } = await createNpxRuntime(t);
  await writeFile(path.join(project, ".hidden-input"), Buffer.from([0x00, 0xff]));
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_RUNTIME_ROOT: runtime,
  };
  const before = await snapshotFiles(project);

  const previewResult = await runCore(["init", project, "--yes", "--dry-run"], { env: environment });
  const preview = JSON.parse(previewResult.stdout);

  assert.deepEqual(preview.runtime, {
    path: ".agentic-core/runtime",
    format: "self-contained-v1",
    manifest: "runtime-manifest.json",
    source: `github:KroxiDev/agentic-core#${commit}`,
    commit,
    treeSha256: preview.runtime.treeSha256,
    bins: ["agentic-core", "agentic-quality"],
  });
  assert.match(preview.runtime.treeSha256, /^[0-9a-f]{64}$/);
  assert.ok(preview.actions.some((action) => action.action === "persist_runtime"
    && action.path === ".agentic-core/runtime"));
  assertSameSnapshot(await snapshotFiles(project), before);

  await runCore(["init", project, "--yes"], { env: environment });
  const manifest = JSON.parse(await readFile(path.join(project, ".agentic-core", "ownership.json"), "utf8"));
  assert.deepEqual(manifest.runtime, preview.runtime);
  for (const action of preview.actions) {
    if (!["write_resource", "append_managed_block", "replace_managed_block", "write_manifest"].includes(action.action)) {
      continue;
    }
    const content = await readFile(path.join(project, ...action.path.split("/")));
    assert.equal(sha256(content), action.sha256, `${action.action} ${action.path}`);
  }
  const launcher = path.join(project, ".agentic-core", "runtime-launcher.mjs");
  const installedSkill = await readFile(path.join(project, ".agents", "skills", "orquestar", "SKILL.md"), "utf8");
  assert.match(installedSkill, /agentic-quality prepare/);
  assert.match(installedSkill, /agentic-quality verify/);
  assert.doesNotMatch(installedSkill, /agentic-core (?:start|submit-handoff)/);
  const core = await execFileAsync(process.execPath, [launcher, "agentic-core", "--version"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(core.stdout.trim(), "0.2.0");
  const quality = await execFileAsync(process.execPath, [launcher, "agentic-quality", "--help"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.match(quality.stdout, /agentic-quality scan/);
  const persistedRuntime = path.join(project, ".agentic-core", "runtime");
  for (const forbidden of ["node_modules", "_npx", "package.json", "package-lock.json", "payload-manifest.json"]) {
    await assert.rejects(lstat(path.join(persistedRuntime, forbidden)), { code: "ENOENT" });
  }
  const runtimeManifest = JSON.parse(await readFile(path.join(persistedRuntime, "runtime-manifest.json"), "utf8"));
  assert.equal(runtimeManifest.format, "self-contained-v1");
  assert.equal(runtimeManifest.commit, commit);
  assert.deepEqual(runtimeManifest.bins, {
    "agentic-core": "agentic-core.mjs",
    "agentic-quality": "agentic-core.mjs",
  });
  const update = await execFileAsync(process.execPath, [launcher, "agentic-core", "update", ".", "--dry-run"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(update.stdout).status, "ready");
  await writeFile(path.join(persistedRuntime, "agentic-core.mjs"), "// divergent runtime\n");
  await assert.rejects(execFileAsync(process.execPath, [launcher, "agentic-core", "--version"], {
    cwd: project,
    encoding: "utf8",
  }), (error) => {
    assert.match(error.stderr, /does not match its ownership hash/i);
    return true;
  });
});

test("init --dry-run rejects an overlapping ephemeral runtime boundary without writing", async (t) => {
  const { runtime } = await createNpxRuntime(t);
  const before = await snapshotFiles(runtime);

  await assert.rejects(runCore(["init", runtime, "--yes", "--dry-run"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AGENTIC_CORE_TEST_RUNTIME_ROOT: runtime,
    },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /runtime source and destination overlap/i);
    return true;
  });
  assertSameSnapshot(await snapshotFiles(runtime), before);
});

test("init --dry-run rejects non-canonical runtime binary paths without writing", async (t) => {
  const project = await createProject(t);
  const { runtime } = await createNpxRuntime(t);
  const packagePath = path.join(runtime, "node_modules", "@kroxidev", "agentic-core", "package.json");
  const packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
  packageManifest.bin["agentic-core"] = "../../../../package.json";
  await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`);
  const before = await snapshotFiles(project);

  await assert.rejects(runCore(["init", project, "--yes", "--dry-run"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AGENTIC_CORE_TEST_RUNTIME_ROOT: runtime,
    },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /canonical binary paths/i);
    return true;
  });
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("init --dry-run rejects a packaged runtime payload that fails integrity", async (t) => {
  const project = await createProject(t);
  const { runtime } = await createNpxRuntime(t);
  const artifact = path.join(
    runtime,
    "node_modules",
    "@kroxidev",
    "agentic-core",
    "dist",
    "runtime",
    "agentic-core.mjs",
  );
  await writeFile(artifact, "// tampered payload\n");
  const before = await snapshotFiles(project);

  await assert.rejects(runCore(["init", project, "--yes", "--dry-run"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AGENTIC_CORE_TEST_RUNTIME_ROOT: runtime,
    },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /payload failed integrity validation/i);
    return true;
  });
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("update --dry-run previews the exact next GitHub runtime and real update persists the same tree", async (t) => {
  const project = await createProject(t);
  const first = await createNpxRuntime(t);
  const second = await createNpxRuntime(t, { commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
  const environment = (runtime) => ({
    ...process.env,
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_RUNTIME_ROOT: runtime,
  });
  await runCore(["init", project, "--yes"], { env: environment(first.runtime) });
  const before = await snapshotFiles(project);

  const previewResult = await runCore(["update", project, "--dry-run"], { env: environment(second.runtime) });
  const preview = JSON.parse(previewResult.stdout);

  assert.equal(preview.runtime.commit, second.commit);
  assert.equal(preview.manifest.runtime.treeSha256, preview.runtime.treeSha256);
  assert.ok(preview.actions.some((action) => action.action === "persist_runtime"
    && action.source === `github:KroxiDev/agentic-core#${second.commit}`));
  assertSameSnapshot(await snapshotFiles(project), before);

  await runCore(["update", project], { env: environment(second.runtime) });
  const manifest = JSON.parse(await readFile(path.join(project, ".agentic-core", "ownership.json"), "utf8"));
  assert.deepEqual(manifest.runtime, preview.runtime);
  for (const action of preview.actions) {
    if (!["write_resource", "replace_managed_block", "write_manifest"].includes(action.action)) continue;
    const content = await readFile(path.join(project, ...action.path.split("/")));
    assert.equal(sha256(content), action.sha256, `${action.action} ${action.path}`);
  }
  const runtimeManifest = JSON.parse(await readFile(path.join(
    project,
    ".agentic-core",
    "runtime",
    "runtime-manifest.json",
  ), "utf8"));
  assert.equal(runtimeManifest.commit, second.commit);
});

test("update --dry-run requires a GitHub runtime source before replacing a divergent persisted runtime", async (t) => {
  const project = await createProject(t);
  const source = await createNpxRuntime(t);
  await runCore(["init", project, "--yes"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AGENTIC_CORE_TEST_RUNTIME_ROOT: source.runtime,
    },
  });
  await writeFile(path.join(project, ".agentic-core", "runtime", "agentic-core.mjs"), "divergent runtime\n");
  const before = await snapshotFiles(project);

  await assert.rejects(runCore(["update", project, "--force", "--dry-run"]), (error) => {
    assert.equal(error.code, 1);
    const plan = JSON.parse(error.stdout);
    assert.equal(plan.status, "blocked");
    assert.equal(plan.error.code, "runtime_source_required");
    assert.deepEqual(plan.divergences, [".agentic-core/runtime"]);
    return true;
  });
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("maintenance rejects an inconsistent self-contained runtime manifest even with retagged ownership", async (t) => {
  const project = await createProject(t);
  const source = await createNpxRuntime(t);
  await runCore(["init", project, "--yes"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AGENTIC_CORE_TEST_RUNTIME_ROOT: source.runtime,
    },
  });
  const productRoot = path.join(project, ".agentic-core");
  const runtimeRoot = path.join(productRoot, "runtime");
  const runtimeManifestPath = path.join(runtimeRoot, "runtime-manifest.json");
  const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
  runtimeManifest.commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  const ownershipPath = path.join(productRoot, "ownership.json");
  const owner = JSON.parse(await readFile(ownershipPath, "utf8"));
  owner.runtime.treeSha256 = await hashDirectory(runtimeRoot);
  await writeFile(ownershipPath, `${JSON.stringify(owner, null, 2)}\n`);
  const before = await snapshotFiles(project);

  await assert.rejects(runCore(["doctor", project]), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.status, "unhealthy");
    const runtimeCheck = report.diagnosis.checks.find(({ id }) => id === "runtime.persistence");
    assert.equal(runtimeCheck.status, "error");
    assert.match(runtimeCheck.evidence.error, /runtime manifest is invalid/i);
    return true;
  });
  await assert.rejects(runCore(["update", project, "--dry-run"]), (error) => {
    assert.equal(error.code, 1);
    const plan = JSON.parse(error.stdout);
    assert.equal(plan.status, "blocked");
    assert.equal(plan.error.code, "runtime_source_required");
    assert.deepEqual(plan.divergences, [".agentic-core/runtime"]);
    return true;
  });
  const uninstall = await runCore(["uninstall", project, "--dry-run"]);
  assert.match(uninstall.stdout, /Preserved divergent runtime: \.agentic-core\/runtime/);
  assert.doesNotMatch(uninstall.stdout, /Would remove runtime:/);
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("update migrates legacy orchestration ownership, removes its guard, and preserves runs", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  const productRoot = path.join(project, ".agentic-core");
  const manifestPath = path.join(productRoot, "ownership.json");
  const legacy = JSON.parse(await readFile(manifestPath, "utf8"));
  const legacyConfig = {
    $schema: "./config.schema.json",
    schemaVersion: 1,
    orchestration: {
      explicitActivationOnly: true,
      defaultMode: "normal",
      briefMaxBytes: 16_384,
      handoffMaxBytes: 32_768,
    },
    quality: { crapThreshold: 6, mutationWorkers: 4 },
  };
  const configContent = Buffer.from(`${JSON.stringify(legacyConfig, null, 2)}\n`);
  await writeFile(path.join(productRoot, "config.json"), configContent);
  legacy.resources.find(({ path: resourcePath }) => resourcePath === ".agentic-core/config.json").sha256 = sha256(configContent);
  legacy.resources = legacy.resources.filter(({ path: resourcePath }) => (
    ![".agentic-core/.gitignore", ".agentic-core/runtime-launcher.mjs"].includes(resourcePath)
  ));
  await rm(path.join(productRoot, ".gitignore"));
  const guardContent = Buffer.from("legacy guard\n");
  legacy.resources.splice(3, 0, {
    path: ".agentic-core/claude-read-command-guard.mjs",
    sha256: sha256(guardContent),
  });
  await writeFile(path.join(productRoot, "claude-read-command-guard.mjs"), guardContent);
  legacy.configVersion = 1;
  legacy.ownedDirectories = [
    ".agentic-core/runs",
    ".agentic-core/reports",
    ".agentic-core/workers",
    ".agentic-core/transactions",
    ".agents/skills/orquestar",
    ".agents/skills/agentic-tdd",
    ".agents/skills/agentic-grilling",
    ".claude/skills/orquestar",
    ".claude/skills/agentic-tdd",
    ".claude/skills/agentic-grilling",
  ];
  delete legacy.runtime;
  await writeFile(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`);
  await import("node:fs/promises").then(({ rm }) => rm(path.join(productRoot, "runtime-launcher.mjs")));
  const runsPath = path.join(productRoot, "runs");
  await mkdir(runsPath);
  await writeFile(path.join(runsPath, "legacy.json"), "preserve me\n");
  const next = await createNpxRuntime(t);
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_RUNTIME_ROOT: next.runtime,
  };

  const preview = JSON.parse((await runCore(["update", project, "--dry-run"], { env: environment })).stdout);
  assert.equal(preview.status, "ready");
  assert.ok(preview.actions.some((action) => action.path === ".agentic-core/runtime-launcher.mjs"));
  assert.ok(preview.actions.some((action) => action.path === ".agentic-core/runtime"));
  assert.ok(preview.actions.some((action) => action.action === "remove_retired_resource"
    && action.path === ".agentic-core/claude-read-command-guard.mjs"));
  assert.ok(preview.actions.some((action) => action.action === "preserve_legacy_state"
    && action.path === ".agentic-core/runs"));

  await runCore(["update", project], { env: environment });
  const migrated = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(migrated.configVersion, 2);
  assert.equal(migrated.resources.some(({ path: resourcePath }) =>
    resourcePath === ".agentic-core/claude-read-command-guard.mjs"), false);
  assert.ok(migrated.resources.some(({ path: resourcePath }) =>
    resourcePath === ".agentic-core/runtime-launcher.mjs"));
  assert.deepEqual(JSON.parse(await readFile(path.join(productRoot, "config.json"), "utf8")).quality,
    { crapThreshold: 6, mutationWorkers: 4 });
  assert.equal(await readFile(path.join(runsPath, "legacy.json"), "utf8"), "preserve me\n");
  await assert.rejects(stat(path.join(productRoot, "claude-read-command-guard.mjs")), { code: "ENOENT" });
  assert.deepEqual(migrated.runtime, preview.runtime);
});

test("init installs native Codex and Claude agents plus canonical skills byte for byte", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  const mappings = [
    ["src/runtime-launcher.mjs", ".agentic-core/runtime-launcher.mjs"],
    ...["read", "production", "tests", "docs"].flatMap((profile) => [
      [`adapters/codex/agents/agentic-${profile}.toml`, `.codex/agents/agentic-${profile}.toml`],
      [`adapters/claude/agents/agentic-${profile}.md`, `.claude/agents/agentic-${profile}.md`],
    ]),
    ...["orquestar", "agentic-tdd", "agentic-grilling"].flatMap((skill) => [
      [`skills/${skill}/SKILL.md`, `.agents/skills/${skill}/SKILL.md`],
      [`adapters/claude/skills/${skill}/SKILL.md`, `.claude/skills/${skill}/SKILL.md`],
    ]),
  ];
  for (const [source, target] of mappings) {
    assert.deepEqual(
      await readFile(path.join(project, ...target.split("/"))),
      await readFile(path.join(repositoryRoot, ...source.split("/"))),
      target,
    );
  }
  const manifest = JSON.parse(await readFile(path.join(project, ".agentic-core", "ownership.json"), "utf8"));
  for (const [, target] of mappings) {
    assert.ok(manifest.resources.some((resource) => resource.path === target), `${target} is not owned`);
  }
});

test("update transactionally restores every host profile, canonical skill, and Claude shim", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  const mappings = [
    ["src/runtime-launcher.mjs", ".agentic-core/runtime-launcher.mjs"],
    ...["read", "production", "tests", "docs"].flatMap((profile) => [
      [`adapters/codex/agents/agentic-${profile}.toml`, `.codex/agents/agentic-${profile}.toml`],
      [`adapters/claude/agents/agentic-${profile}.md`, `.claude/agents/agentic-${profile}.md`],
    ]),
    ...["orquestar", "agentic-tdd", "agentic-grilling"].flatMap((skill) => [
      [`skills/${skill}/SKILL.md`, `.agents/skills/${skill}/SKILL.md`],
      [`adapters/claude/skills/${skill}/SKILL.md`, `.claude/skills/${skill}/SKILL.md`],
    ]),
  ];
  for (const [, target] of mappings) {
    await writeFile(path.join(project, ...target.split("/")), `locally diverged ${target}\n`);
  }

  await runCore(["update", project, "--force"]);

  const manifest = JSON.parse(await readFile(path.join(project, ".agentic-core", "ownership.json"), "utf8"));
  for (const [source, target] of mappings) {
    const installed = await readFile(path.join(project, ...target.split("/")));
    assert.deepEqual(installed, await readFile(path.join(repositoryRoot, ...source.split("/"))), target);
    assert.equal(manifest.resources.find((resource) => resource.path === target)?.sha256, sha256(installed), target);
  }
});

test("--yes does not replace an isolated conflict without explicit authorization", async (t) => {
  const project = await createProject(t);
  const productRoot = path.join(project, ".agentic-core");
  await mkdir(productRoot);
  const conflictingConfig = Buffer.from("configuration owned by another tool\r\n");
  await writeFile(path.join(productRoot, "config.json"), conflictingConfig);

  await assert.rejects(
    runCore(["init", project, "--yes"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /isolated conflict/i);
      assert.match(error.stderr, /--replace-conflicts/);
      return true;
    },
  );

  assert.deepEqual(await readFile(path.join(productRoot, "config.json")), conflictingConfig);
  assert.deepEqual(await readdir(productRoot), ["config.json"]);

  const installed = await runCore(["init", project, "--yes", "--replace-conflicts"]);
  assert.match(installed.stdout, /Installed agentic-core 0\.2\.0/);
  assert.notDeepEqual(await readFile(path.join(productRoot, "config.json")), conflictingConfig);
});

test("init --dry-run returns a complete blocked plan for resource and managed-block conflicts", async (t) => {
  const project = await createProject(t);
  const productRoot = path.join(project, ".agentic-core");
  await mkdir(productRoot);
  await writeFile(path.join(productRoot, "config.json"), "foreign configuration\r\n");
  await writeFile(path.join(project, "AGENTS.md"),
    "<!-- AGENTIC_CORE_START -->\r\nforeign block\r\n<!-- AGENTIC_CORE_END -->\r\n");
  const before = await snapshotFiles(project);

  await assert.rejects(
    runCore(["init", project, "--yes", "--dry-run"]),
    (error) => {
      assert.equal(error.code, 1);
      const plan = JSON.parse(error.stdout);
      assert.equal(plan.status, "blocked");
      assert.equal(plan.error.code, "authorization_required");
      assert.deepEqual(plan.conflicts.map(({ path: conflictPath }) => conflictPath), [
        ".agentic-core/config.json",
        "AGENTS.md",
      ]);
      assert.ok(plan.actions.some((action) => action.path === ".agentic-core/ownership.json"));
      return true;
    },
  );
  assertSameSnapshot(await snapshotFiles(project), before);

  const authorized = JSON.parse((await runCore([
    "init", project, "--yes", "--replace-conflicts", "--dry-run",
  ])).stdout);
  assert.equal(authorized.status, "ready");
  assert.deepEqual(authorized.conflicts.map(({ authorized: isAuthorized }) => isAuthorized), [true, true]);
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("init --dry-run never presents an ambiguous managed block as authorizable", async (t) => {
  const project = await createProject(t);
  await writeFile(path.join(project, "AGENTS.md"), [
    "<!-- AGENTIC_CORE_START -->",
    "foreign block without a matching end marker",
  ].join("\r\n"));
  const before = await snapshotFiles(project);

  await assert.rejects(
    runCore(["init", project, "--yes", "--replace-conflicts", "--dry-run"]),
    (error) => {
      assert.equal(error.code, 1);
      const plan = JSON.parse(error.stdout);
      assert.equal(plan.status, "blocked");
      assert.equal(plan.error.code, "unsafe_conflict");
      assert.doesNotMatch(plan.error.message, /re-run with --replace-conflicts/i);
      assert.deepEqual(plan.conflicts.filter(({ authorized }) => !authorized), [{
        path: "AGENTS.md",
        kind: "ambiguous_managed_block",
        authorized: false,
      }]);
      return true;
    },
  );
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("init stops when another product owns a complete installation", async (t) => {
  const project = await createProject(t);
  const productRoot = path.join(project, ".agentic-core");
  await mkdir(productRoot);
  const foreignManifest = Buffer.from('{"product":"another-agent-layer","version":"9.0.0"}\r\n');
  await writeFile(path.join(productRoot, "ownership.json"), foreignManifest);
  await writeFile(path.join(productRoot, "foreign-resource.txt"), "must stay unchanged\r\n");
  const before = await snapshotFiles(project);

  for (const extra of [["--dry-run"], []]) {
    await assert.rejects(
      runCore(["init", project, "--yes", "--replace-conflicts", ...extra]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /foreign installation/i);
        return true;
      },
    );
    assertSameSnapshot(await snapshotFiles(project), before);
  }

  assert.deepEqual(await readFile(path.join(productRoot, "ownership.json")), foreignManifest);
  assert.equal(await readFile(path.join(productRoot, "foreign-resource.txt"), "utf8"), "must stay unchanged\r\n");
  assert.deepEqual((await readdir(productRoot)).sort(), ["foreign-resource.txt", "ownership.json"]);
});

test("a failure after any installation write restores the prior project byte for byte", async (t) => {
  for (const failAfterWrite of Array.from({ length: 21 }, (_, index) => index + 1)) {
    await t.test(`write ${failAfterWrite}`, async (subtest) => {
      const project = await createProject(subtest);
      const productRoot = path.join(project, ".agentic-core");
      await mkdir(productRoot);
      await writeFile(path.join(productRoot, "config.json"), Buffer.from([0x00, 0x0d, 0x0a, 0xff]));
      await writeFile(path.join(productRoot, "unknown.txt"), "foreign file\r\n");
      await writeFile(path.join(project, "AGENTS.md"), "# Existing instructions\r\nKeep these bytes.");
      const before = await snapshotFiles(project);

      await assert.rejects(
        runCore(["init", project, "--replace-conflicts"], {
          env: {
            ...process.env,
            NODE_ENV: "test",
            AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: String(failAfterWrite),
          },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /simulated transaction failure/i);
          return true;
        },
      );

      assertSameSnapshot(await snapshotFiles(project), before);
    });
  }
});

test("a complete unowned footprint is not treated as replaceable isolated conflicts", async (t) => {
  const project = await createProject(t);
  const productRoot = path.join(project, ".agentic-core");
  await mkdir(productRoot);
  await writeFile(path.join(productRoot, "config.json"), "foreign config\r\n");
  await writeFile(path.join(productRoot, "config.schema.json"), "foreign schema\r\n");
  await writeFile(path.join(productRoot, "golden-rules.md"), "foreign policy\r\n");
  const before = await snapshotFiles(project);

  await assert.rejects(
    runCore(["init", project, "--replace-conflicts"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /foreign installation/i);
      return true;
    },
  );

  assertSameSnapshot(await snapshotFiles(project), before);
});

test("a conflicting managed block is replaced only when explicitly authorized", async (t) => {
  const project = await createProject(t);
  const prefix = Buffer.from("# Existing instructions\r\n\r\n");
  const staleBlock = Buffer.from("<!-- AGENTIC_CORE_START -->\r\nstale foreign instructions\r\n<!-- AGENTIC_CORE_END -->");
  const suffix = Buffer.from("\r\n\r\n# Keep this suffix without a final newline");
  const original = Buffer.concat([prefix, staleBlock, suffix]);
  await writeFile(path.join(project, "AGENTS.md"), original);

  await assert.rejects(runCore(["init", project, "--yes"]), /Command failed/);
  assert.deepEqual(await readFile(path.join(project, "AGENTS.md")), original);

  await runCore(["init", project, "--replace-conflicts"]);
  const replaced = await readFile(path.join(project, "AGENTS.md"));
  assert.deepEqual(replaced.subarray(0, prefix.length), prefix);
  assert.deepEqual(replaced.subarray(replaced.length - suffix.length), suffix);
  assert.equal((replaced.toString("utf8").match(/AGENTIC_CORE_START/g) ?? []).length, 1);
  assert.match(replaced.toString("utf8"), /load and follow `.agents\/skills\/orquestar\/SKILL\.md`/);
});

test("update adds the managed quality ignore to an existing 0.2.0 installation", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  const productRoot = path.join(project, ".agentic-core");
  const ignorePath = path.join(productRoot, ".gitignore");
  const ownershipPath = path.join(productRoot, "ownership.json");
  const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  ownership.resources = ownership.resources.filter(({ path: resourcePath }) => (
    resourcePath !== ".agentic-core/.gitignore"
  ));
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
  await rm(ignorePath);
  const evidencePath = path.join(productRoot, "quality", "q_existing", "report.json");
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, "preserve historical evidence\n");

  await runCore(["update", project]);

  assert.equal(await readFile(ignorePath, "utf8"), "/quality/\n");
  assert.equal(await readFile(evidencePath, "utf8"), "preserve historical evidence\n");
  const updated = JSON.parse(await readFile(ownershipPath, "utf8"));
  assert.ok(updated.resources.some(({ path: resourcePath }) => (
    resourcePath === ".agentic-core/.gitignore"
  )));
});

test("update preserves quality configuration and legacy runs", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);

  const configPath = path.join(project, ".agentic-core", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.quality.crapThreshold = 5;
  delete config.quality.mutationWorkers;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const runsPath = path.join(project, ".agentic-core", "runs");
  await mkdir(runsPath);
  await writeFile(path.join(runsPath, "stale.json"), "stale run\r\n");
  const qualityPath = path.join(project, ".agentic-core", "quality", "preserved-session");
  await mkdir(qualityPath, { recursive: true });
  await writeFile(path.join(qualityPath, "evidence.json"), "preserve quality evidence\r\n");
  const oldManifest = JSON.parse(await readFile(path.join(project, ".agentic-core", "ownership.json"), "utf8"));

  const result = await runCore(["update", project, "--force"]);

  assert.match(result.stdout, /Updated agentic-core 0\.2\.0/);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    ...config,
    quality: { crapThreshold: 5, mutationWorkers: 4 },
  });
  assert.equal(await readFile(path.join(runsPath, "stale.json"), "utf8"), "stale run\r\n");
  assert.equal(await readFile(path.join(qualityPath, "evidence.json"), "utf8"), "preserve quality evidence\r\n");
  const newManifest = JSON.parse(await readFile(path.join(project, ".agentic-core", "ownership.json"), "utf8"));
  assert.equal(newManifest.installationId, oldManifest.installationId);
  assert.notDeepEqual(newManifest.resources, oldManifest.resources);
});

test("update previews and real execution reject uncertain or foreign ownership even with force", async (t) => {
  for (const [name, manifest] of [
    ["foreign", { schemaVersion: 1, product: "another-product" }],
    ["uncertain", { schemaVersion: 1, product: "@kroxidev/agentic-core", resources: [] }],
  ]) {
    await t.test(name, async (subtest) => {
      const project = await createProject(subtest);
      const productRoot = path.join(project, ".agentic-core");
      await mkdir(productRoot);
      await writeFile(path.join(productRoot, "ownership.json"), `${JSON.stringify(manifest)}\r\n`);
      await writeFile(path.join(productRoot, "foreign.txt"), "do not replace\r\n");
      const before = await snapshotFiles(project);

      for (const extra of [["--dry-run"], []]) {
        await assert.rejects(runCore(["update", project, "--force", ...extra]), (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /ownership manifest/i);
          return true;
        });
        assertSameSnapshot(await snapshotFiles(project), before);
      }
    });
  }
});

test("update --dry-run rejects invalid configuration without changing the installation", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  const configPath = path.join(project, ".agentic-core", "config.json");
  await writeFile(configPath, "{invalid configuration\r\n");
  const before = await snapshotFiles(project);

  await assert.rejects(runCore(["update", project, "--force", "--dry-run"]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /configuration is invalid/i);
    return true;
  });
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("update enumerates divergences and force replaces only owned boundaries", async (t) => {
  const project = await createProject(t);
  await writeFile(path.join(project, "AGENTS.md"), "# Foreign prefix\r\n");
  await runCore(["init", project, "--yes"]);
  const productRoot = path.join(project, ".agentic-core");
  await writeFile(path.join(productRoot, "golden-rules.md"), "locally changed rules\r\n");
  const agentsPath = path.join(project, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8");
  await writeFile(agentsPath, `${agents.replace("## agentic-core", "## locally changed core")}\r\n# Foreign suffix`);
  await writeFile(path.join(productRoot, "unknown.txt"), "foreign product data\r\n");
  const beforeRejectedUpdate = await snapshotFiles(project);

  await assert.rejects(runCore(["update", project]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /\.agentic-core\/golden-rules\.md/);
    assert.match(error.stderr, /AGENTS\.md/);
    assert.match(error.stderr, /--force/);
    return true;
  });
  assertSameSnapshot(await snapshotFiles(project), beforeRejectedUpdate);

  await runCore(["update", project, "--force"]);
  assert.equal(await readFile(path.join(productRoot, "unknown.txt"), "utf8"), "foreign product data\r\n");
  const updatedAgents = await readFile(agentsPath, "utf8");
  assert.match(updatedAgents, /^# Foreign prefix\r?\n/);
  assert.match(updatedAgents, /# Foreign suffix$/);
  assert.match(updatedAgents, /## agentic-core/);
  assert.doesNotMatch(updatedAgents, /locally changed core/);
});

test("update without divergences does not require force", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  const result = await runCore(["update", project]);
  assert.match(result.stdout, /Updated agentic-core 0\.2\.0/);
});

test("update --dry-run reports forced replacements and legacy preservation without changing any byte", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  const productRoot = path.join(project, ".agentic-core");
  await writeFile(path.join(productRoot, "golden-rules.md"), "locally changed rules\r\n");
  const runsPath = path.join(productRoot, "runs");
  await mkdir(runsPath);
  await writeFile(path.join(runsPath, ".hidden-state"), Buffer.from([0x00, 0xff]));
  const before = await snapshotFiles(project);

  const result = await runCore(["update", project, "--force", "--dry-run"]);
  const plan = JSON.parse(result.stdout);

  assert.equal(plan.command, "update");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.divergences, [".agentic-core/golden-rules.md"]);
  assert.ok(plan.actions.some((action) => action.action === "preserve_legacy_state"
    && action.path === ".agentic-core/runs"));
  assert.ok(plan.actions.some((action) => action.action === "write_manifest"
    && action.path === ".agentic-core/ownership.json"));
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("update --dry-run returns a blocked plan for divergences until --force is explicit", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  await writeFile(path.join(project, ".agentic-core", "golden-rules.md"), "divergent rules\r\n");
  const before = await snapshotFiles(project);

  await assert.rejects(runCore(["update", project, "--dry-run"]), (error) => {
    assert.equal(error.code, 1);
    const plan = JSON.parse(error.stdout);
    assert.equal(plan.status, "blocked");
    assert.deepEqual(plan.divergences, [".agentic-core/golden-rules.md"]);
    assert.equal(plan.error.code, "force_required");
    return true;
  });
  assertSameSnapshot(await snapshotFiles(project), before);

  const forced = JSON.parse((await runCore(["update", project, "--force", "--dry-run"])).stdout);
  assert.equal(forced.status, "ready");
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("a failure after any update mutation restores the installation byte for byte", async (t) => {
  for (const failAfterWrite of Array.from({ length: 22 }, (_, index) => index + 1)) {
    await t.test(`mutation ${failAfterWrite}`, async (subtest) => {
      const project = await createProject(subtest);
      await writeFile(path.join(project, "AGENTS.md"), "# Existing instructions\r\n");
      await runCore(["init", project, "--yes"]);
      const productRoot = path.join(project, ".agentic-core");
      const runsPath = path.join(productRoot, "runs", "nested");
      await mkdir(runsPath, { recursive: true });
      await writeFile(path.join(runsPath, "state.bin"), Buffer.from([0x00, 0x0d, 0x0a, 0xff]));
      await writeFile(path.join(productRoot, "unknown.txt"), "foreign file\r\n");
      const before = await snapshotFiles(project);

      await assert.rejects(
        runCore(["update", project], {
          env: {
            ...process.env,
            NODE_ENV: "test",
            AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: String(failAfterWrite),
          },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /simulated transaction failure/i);
          return true;
        },
      );
      assertSameSnapshot(await snapshotFiles(project), before);
    });
  }
});

test("uninstall dry-run reports exact owned resources and blocks without changing the project", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  const before = await snapshotFiles(project);

  const result = await runCore(["uninstall", project, "--dry-run"]);

  assert.deepEqual(result.stdout.trim().split("\n"), [
    "Would remove resource: .agentic-core/.gitignore",
    "Would remove resource: .agentic-core/config.json",
    "Would remove resource: .agentic-core/config.schema.json",
    "Would remove resource: .agentic-core/golden-rules.md",
    "Would remove resource: .agentic-core/runtime-launcher.mjs",
    "Would remove resource: .codex/agents/agentic-read.toml",
    "Would remove resource: .claude/agents/agentic-read.md",
    "Would remove resource: .codex/agents/agentic-production.toml",
    "Would remove resource: .claude/agents/agentic-production.md",
    "Would remove resource: .codex/agents/agentic-tests.toml",
    "Would remove resource: .claude/agents/agentic-tests.md",
    "Would remove resource: .codex/agents/agentic-docs.toml",
    "Would remove resource: .claude/agents/agentic-docs.md",
    "Would remove resource: .agents/skills/orquestar/SKILL.md",
    "Would remove resource: .claude/skills/orquestar/SKILL.md",
    "Would remove resource: .agents/skills/agentic-tdd/SKILL.md",
    "Would remove resource: .claude/skills/agentic-tdd/SKILL.md",
    "Would remove resource: .agents/skills/agentic-grilling/SKILL.md",
    "Would remove resource: .claude/skills/agentic-grilling/SKILL.md",
    "Would remove managed block: AGENTS.md#agentic-core",
    "Would remove managed block: CLAUDE.md#agentic-core",
    "Would remove owned directory: .agents/skills/orquestar",
    "Would remove owned directory: .agents/skills/agentic-tdd",
    "Would remove owned directory: .agents/skills/agentic-grilling",
    "Would remove owned directory: .claude/skills/orquestar",
    "Would remove owned directory: .claude/skills/agentic-tdd",
    "Would remove owned directory: .claude/skills/agentic-grilling",
    "Would remove manifest: .agentic-core/ownership.json",
  ]);
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("uninstall dry-run includes the hash-proven runtime and matches the real removal plan", async (t) => {
  const project = await createProject(t);
  const source = await createNpxRuntime(t);
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_RUNTIME_ROOT: source.runtime,
  };
  await runCore(["init", project, "--yes"], { env: environment });
  const before = await snapshotFiles(project);

  const preview = await runCore(["uninstall", project, "--dry-run"]);

  assert.match(preview.stdout, /Would remove runtime: \.agentic-core\/runtime/);
  assertSameSnapshot(await snapshotFiles(project), before);
  const removed = await runCore(["uninstall", project]);
  assert.deepEqual(
    removed.stdout.trim().split("\n").map((line) => line.replace(/^Removed /, "Would remove ")),
    preview.stdout.trim().split("\n"),
  );
  await assert.rejects(stat(path.join(project, ".agentic-core", "runtime")), { code: "ENOENT" });
});

test("uninstall --dry-run preserves a divergent runtime unless --force explicitly authorizes its owned path", async (t) => {
  const project = await createProject(t);
  const source = await createNpxRuntime(t);
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_RUNTIME_ROOT: source.runtime,
  };
  await runCore(["init", project, "--yes"], { env: environment });
  const artifact = path.join(project, ".agentic-core", "runtime", "agentic-core.mjs");
  await writeFile(artifact, "divergent runtime\r\n");
  const before = await snapshotFiles(project);

  const conservative = await runCore(["uninstall", project, "--dry-run"]);
  assert.match(conservative.stdout, /Preserved divergent runtime: \.agentic-core\/runtime/);
  assert.doesNotMatch(conservative.stdout, /Would remove runtime:/);
  assertSameSnapshot(await snapshotFiles(project), before);

  const forced = await runCore(["uninstall", project, "--dry-run", "--force"]);
  assert.match(forced.stdout, /Would remove runtime: \.agentic-core\/runtime/);
  assertSameSnapshot(await snapshotFiles(project), before);
});

test("runtime directory writes and removals roll back byte for byte at the transaction boundary", async (t) => {
  const first = await createNpxRuntime(t);
  const second = await createNpxRuntime(t, { commit: "cccccccccccccccccccccccccccccccccccccccc" });
  const environment = (runtime, failAfterWrite) => ({
    ...process.env,
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_RUNTIME_ROOT: runtime,
    ...(failAfterWrite ? { AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: String(failAfterWrite) } : {}),
  });

  await t.test("init runtime copy", async (subtest) => {
    const project = await createProject(subtest);
    await writeFile(path.join(project, ".hidden-input"), Buffer.from([0x00, 0xff]));
    const before = await snapshotFiles(project);
    await assert.rejects(
      runCore(["init", project, "--yes"], { env: environment(first.runtime, 22) }),
      /simulated transaction failure/i,
    );
    assertSameSnapshot(await snapshotFiles(project), before);
  });

  await t.test("update runtime replacement", async (subtest) => {
    const project = await createProject(subtest);
    await runCore(["init", project, "--yes"], { env: environment(first.runtime) });
    const before = await snapshotFiles(project);
    await assert.rejects(
      runCore(["update", project], { env: environment(second.runtime, 22) }),
      /simulated transaction failure/i,
    );
    assertSameSnapshot(await snapshotFiles(project), before);
  });

  await t.test("uninstall runtime removal", async (subtest) => {
    const project = await createProject(subtest);
    await runCore(["init", project, "--yes"], { env: environment(first.runtime) });
    const before = await snapshotFiles(project);
    await assert.rejects(
      runCore(["uninstall", project], { env: environment(first.runtime, 22) }),
      /simulated transaction failure/i,
    );
    assertSameSnapshot(await snapshotFiles(project), before);
  });
});

test("uninstall removes owned state and keeps unknown resources and text", async (t) => {
  const project = await createProject(t);
  await writeFile(path.join(project, "AGENTS.md"), "# Keep prefix\r\n");
  await runCore(["init", project, "--yes"]);
  const productRoot = path.join(project, ".agentic-core");
  const qualityRoot = path.join(productRoot, "quality", "nested");
  await mkdir(qualityRoot, { recursive: true });
  await writeFile(path.join(qualityRoot, "owned.bin"), Buffer.from([0x00, 0xff]));
  const legacyRunRoot = path.join(productRoot, "runs", "nested");
  await mkdir(legacyRunRoot, { recursive: true });
  await writeFile(path.join(legacyRunRoot, "legacy.bin"), Buffer.from([0x01, 0xfe]));
  await writeFile(path.join(productRoot, "unknown.txt"), "keep product-adjacent data\r\n");
  await writeFile(path.join(project, "AGENTS.md"), `${await readFile(path.join(project, "AGENTS.md"), "utf8")}# Keep suffix`);
  const unrelatedRoot = path.join(project, ".agents", "skills", "other-skill");
  await mkdir(unrelatedRoot, { recursive: true });
  await writeFile(path.join(unrelatedRoot, "SKILL.md"), "keep skill\r\n");

  const result = await runCore(["uninstall", project]);

  assert.match(result.stdout, /Removed owned directory: \.agentic-core\/quality/);
  assert.match(result.stdout, /Preserved legacy directory: \.agentic-core\/runs/);
  for (const ownedPath of [".gitignore", "config.json", "config.schema.json", "golden-rules.md", "ownership.json", "quality"]) {
    await assert.rejects(stat(path.join(productRoot, ownedPath)), { code: "ENOENT" });
  }
  assert.deepEqual(await readFile(path.join(legacyRunRoot, "legacy.bin")), Buffer.from([0x01, 0xfe]));
  assert.equal(await readFile(path.join(productRoot, "unknown.txt"), "utf8"), "keep product-adjacent data\r\n");
  assert.equal(await readFile(path.join(unrelatedRoot, "SKILL.md"), "utf8"), "keep skill\r\n");
  const agents = await readFile(path.join(project, "AGENTS.md"), "utf8");
  assert.match(agents, /^# Keep prefix\r?\n/);
  assert.match(agents, /# Keep suffix$/);
  assert.doesNotMatch(agents, /AGENTIC_CORE_START/);
});

test("non-interactive uninstall preserves and reports divergent owned resources", async (t) => {
  const project = await createProject(t);
  await runCore(["init", project, "--yes"]);
  const configPath = path.join(project, ".agentic-core", "config.json");
  await writeFile(configPath, "locally edited configuration\r\n");

  const result = await runCore(["uninstall", project]);

  assert.match(result.stdout, /Preserved divergent resource: \.agentic-core\/config\.json/);
  assert.equal(await readFile(configPath, "utf8"), "locally edited configuration\r\n");
  await assert.rejects(stat(path.join(project, ".agentic-core", "ownership.json")), { code: "ENOENT" });
});

test("force and interactive confirmation remove only manifest-owned divergences", async (t) => {
  await t.test("force", async (subtest) => {
    const project = await createProject(subtest);
    await runCore(["init", project, "--yes"]);
    const configPath = path.join(project, ".agentic-core", "config.json");
    await writeFile(configPath, "locally edited configuration\r\n");
    await writeFile(path.join(project, ".agentic-core", "unknown.txt"), "keep unknown\r\n");
    await runCore(["uninstall", project, "--force"]);
    await assert.rejects(stat(configPath), { code: "ENOENT" });
    assert.equal(await readFile(path.join(project, ".agentic-core", "unknown.txt"), "utf8"), "keep unknown\r\n");
  });

  await t.test("interactive confirmation seam", async (subtest) => {
    const project = await createProject(subtest);
    await runCore(["init", project, "--yes"]);
    const configPath = path.join(project, ".agentic-core", "config.json");
    await writeFile(configPath, "locally edited configuration\r\n");
    const prompted = [];
    await uninstallInstallation(project, {
      confirmDivergence: async (item) => {
        prompted.push(item);
        return true;
      },
    });
    assert.deepEqual(prompted, [{ kind: "resource", path: ".agentic-core/config.json" }]);
    await assert.rejects(stat(configPath), { code: "ENOENT" });
  });
});

test("uninstall never changes an installation owned by another product", async (t) => {
  const project = await createProject(t);
  const productRoot = path.join(project, ".agentic-core");
  await mkdir(productRoot);
  await writeFile(path.join(productRoot, "ownership.json"), '{"product":"another-product"}\r\n');
  await writeFile(path.join(productRoot, "foreign.txt"), "keep all\r\n");
  const before = await snapshotFiles(project);
  for (const extra of [["--dry-run"], []]) {
    await assert.rejects(runCore(["uninstall", project, "--force", ...extra]), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /ownership manifest/i);
      return true;
    });
    assertSameSnapshot(await snapshotFiles(project), before);
  }
});

test("a failure after any uninstall mutation restores the project byte for byte", async (t) => {
  for (const failAfterWrite of Array.from({ length: 29 }, (_, index) => index + 1)) {
    await t.test(`mutation ${failAfterWrite}`, async (subtest) => {
      const project = await createProject(subtest);
      await writeFile(path.join(project, "AGENTS.md"), "# Existing instructions\r\n");
      await runCore(["init", project, "--yes"]);
      const productRoot = path.join(project, ".agentic-core");
      for (const directory of ["quality", "runs"]) {
        const ownedRoot = path.join(productRoot, directory);
        await mkdir(ownedRoot);
        await writeFile(path.join(ownedRoot, "state.bin"), Buffer.from([0x00, 0x0d, 0x0a, 0xff]));
      }
      const before = await snapshotFiles(project);
      await assert.rejects(
        runCore(["uninstall", project], {
          env: {
            ...process.env,
            NODE_ENV: "test",
            AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: String(failAfterWrite),
          },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /simulated transaction failure/i);
          return true;
        },
      );
      assertSameSnapshot(await snapshotFiles(project), before);
    });
  }
});
