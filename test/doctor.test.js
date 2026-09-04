import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { doctorInstallation } from "../src/doctor.js";
import { prepareQualitySession, verifyQualitySession } from "../src/quality/session.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const maintenanceCli = path.join(repositoryRoot, "bin", "agentic-core.js");

async function createProject(t, prefix = "agentic doctor project with spaces ") {
  const project = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

async function runCore(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [maintenanceCli, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      ...options,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

function reportOf(result) {
  assert.ok(result.stdout, `doctor did not produce a report; stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

function findCheck(diagnosis, id) {
  const item = diagnosis.checks.find((candidate) => candidate.id === id);
  assert.ok(item, `missing doctor check ${id}`);
  return item;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function snapshotTree(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = new Map();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    const key = childRelative.replaceAll("\\", "/");
    const targetPath = path.join(root, childRelative);
    const details = await lstat(targetPath);
    if (details.isDirectory()) {
      snapshot.set(key, { kind: "directory", mode: details.mode });
      const children = await snapshotTree(root, childRelative);
      for (const [childKey, value] of children) snapshot.set(childKey, value);
    } else if (details.isFile()) {
      snapshot.set(key, { kind: "file", mode: details.mode, content: await readFile(targetPath) });
    } else {
      snapshot.set(key, { kind: "other", mode: details.mode });
    }
  }
  return snapshot;
}

function assertSameSnapshot(actual, expected) {
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  for (const [targetPath, expectedValue] of expected) {
    assert.deepEqual(actual.get(targetPath), expectedValue, targetPath);
  }
}

test("doctor reports a complete healthy installation with actionable runtime evidence", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);

  const result = await runCore(["doctor", project], {
    env: { ...process.env, AGENTIC_CORE_PYTHON: path.join(project, "missing-python") },
  });
  const report = reportOf(result);

  assert.equal(result.code, 0);
  assert.equal(report.status, "healthy");
  assert.equal(report.diagnosis.summary.problems, 0);
  assert.equal(findCheck(report.diagnosis, "installation.manifest").status, "ok");
  assert.equal(findCheck(report.diagnosis, "configuration.schema").status, "ok");
  assert.equal(findCheck(report.diagnosis, "adapter.codex").status, "ok");
  assert.equal(findCheck(report.diagnosis, "adapter.claude").status, "ok");
  assert.equal(findCheck(report.diagnosis, "runtime.node").evidence.required, ">=20");
  assert.equal(findCheck(report.diagnosis, "backend.javascript").status, "ok");
  assert.equal(findCheck(report.diagnosis, "backend.typescript").status, "ok");
  assert.equal(findCheck(report.diagnosis, "runtime.python").status, "not_applicable");
  assert.equal(findCheck(report.diagnosis, "backend.python").status, "not_applicable");
  assert.equal(report.projectRoot, path.resolve(project));
});

test("doctor reports an outdated canonical skill until update installs the packaged revision", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  const skillRelativePath = ".agents/skills/orquestar/SKILL.md";
  const skillPath = path.join(project, ...skillRelativePath.split("/"));
  const manifestPath = path.join(project, ".agentic-core", "ownership.json");
  const packagedSkill = await readFile(path.join(repositoryRoot, "skills", "orquestar", "SKILL.md"));
  const previousPackagedSkill = Buffer.from("previous packaged orquestar skill\n");
  await writeFile(skillPath, previousPackagedSkill);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const recordedSkill = manifest.resources.find(({ path: resourcePath }) => resourcePath === skillRelativePath);
  assert.ok(recordedSkill);
  recordedSkill.sha256 = sha256(previousPackagedSkill);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const diagnosisResult = await runCore(["doctor", project]);
  const diagnosis = reportOf(diagnosisResult);
  assert.equal(diagnosisResult.code, 1);
  const skillCheck = findCheck(diagnosis.diagnosis, `resource:${skillRelativePath}`);
  assert.equal(skillCheck.status, "error");
  assert.match(skillCheck.message, /differs from the current packaged resource/);
  assert.deepEqual(await readFile(skillPath), previousPackagedSkill);

  assert.equal((await runCore(["update", project])).code, 0);
  assert.deepEqual(await readFile(skillPath), packagedSkill);
  const currentResult = await runCore(["doctor", project]);
  const current = reportOf(currentResult);
  assert.equal(currentResult.code, 0);
  assert.equal(findCheck(current.diagnosis, `resource:${skillRelativePath}`).status, "ok");
});

test("doctor rejects a self-hashed latest report that does not belong to its session", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  await mkdir(path.join(project, "src"));
  await mkdir(path.join(project, "test"));
  await writeFile(path.join(project, "package.json"), `${JSON.stringify({
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`);
  await writeFile(path.join(project, "src", "subject.js"), "export const identity = (value) => value;\n");
  await writeFile(path.join(project, "test", "subject.test.js"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { identity } from "../src/subject.js";',
    'test("identity", () => assert.equal(identity(3), 3));',
    "",
  ].join("\n"));
  const prepared = await prepareQualitySession({
    projectRoot: project,
    mode: "normal",
    scopes: ["src/subject.js"],
  });
  await verifyQualitySession({ projectRoot: project, id: prepared.id });
  const reportsRoot = path.join(project, ".agentic-core", "quality", prepared.id, "reports");
  const latestPath = path.join(reportsRoot, "latest.json");
  const latest = JSON.parse(await readFile(latestPath, "utf8"));
  const validReport = JSON.parse(await readFile(path.join(
    project, ".agentic-core", "quality", prepared.id, ...latest.report.split("/"),
  ), "utf8"));
  validReport.session = "q_000000000000000000000000";
  const forgedContent = Buffer.from(`${JSON.stringify(validReport, null, 2)}\n`);
  const forgedHash = sha256(forgedContent);
  await writeFile(path.join(reportsRoot, `${forgedHash}.json`), forgedContent);
  await writeFile(latestPath, `${JSON.stringify({
    ...latest,
    report: `reports/${forgedHash}.json`,
    sha256: forgedHash,
  }, null, 2)}\n`);

  const result = await doctorInstallation(project);
  assert.equal(result.exitCode, 1);
  const quality = findCheck(result.report.diagnosis, "operations.quality");
  assert.equal(quality.status, "error");
  assert.match(quality.evidence.invalid[0].reason, /report.*session/i);
});

test("doctor repairs only registered resources and block boundaries while preserving foreign content", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  const productRoot = path.join(project, ".agentic-core");
  const configPath = path.join(productRoot, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.quality.crapThreshold = 5;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(productRoot, "golden-rules.md"), "corrupted rules\r\n");
  await rm(path.join(project, ".codex", "agents", "agentic-read.toml"));
  await writeFile(path.join(productRoot, "foreign.txt"), "keep foreign product-adjacent data\r\n");

  const agentsPath = path.join(project, "AGENTS.md");
  const installedAgents = await readFile(agentsPath, "utf8");
  const divergentAgents = `# Keep prefix\r\n${installedAgents.replace("## agentic-core", "## divergent core")}# Keep suffix\r\n`;
  await writeFile(agentsPath, divergentAgents);

  const diagnosisResult = await runCore(["doctor", project]);
  const diagnosis = reportOf(diagnosisResult);
  assert.equal(diagnosisResult.code, 1);
  assert.equal(diagnosis.status, "unhealthy");
  assert.equal(findCheck(diagnosis.diagnosis, "resource:.agentic-core/config.json").repair.available, true);
  assert.equal(findCheck(diagnosis.diagnosis, "resource:.agentic-core/golden-rules.md").status, "error");
  assert.equal(findCheck(diagnosis.diagnosis, "managed-block:AGENTS.md#agentic-core").status, "error");

  const repairedResult = await runCore(["doctor", project, "--repair"]);
  const repaired = reportOf(repairedResult);
  assert.equal(repairedResult.code, 0);
  assert.equal(repaired.status, "repaired");
  assert.equal(repaired.diagnosis.status, "unhealthy");
  assert.equal(repaired.postRepair.status, "healthy");

  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), config);
  const manifest = JSON.parse(await readFile(path.join(productRoot, "ownership.json"), "utf8"));
  const recordedConfig = manifest.resources.find(({ path: resourcePath }) => resourcePath === ".agentic-core/config.json");
  assert.equal(recordedConfig.sha256, sha256(await readFile(configPath)));
  assert.deepEqual(
    await readFile(path.join(productRoot, "golden-rules.md")),
    await readFile(path.join(repositoryRoot, "golden-rules.md")),
  );
  assert.deepEqual(
    await readFile(path.join(project, ".codex", "agents", "agentic-read.toml")),
    await readFile(path.join(repositoryRoot, "adapters", "codex", "agents", "agentic-read.toml")),
  );
  assert.equal(await readFile(path.join(productRoot, "foreign.txt"), "utf8"), "keep foreign product-adjacent data\r\n");
  const agents = await readFile(agentsPath, "utf8");
  assert.match(agents, /^# Keep prefix\r?\n/);
  assert.match(agents, /# Keep suffix\r?\n$/);
  assert.match(agents, /## agentic-core/);
  assert.doesNotMatch(agents, /divergent core/);
});

test("doctor --dry-run and --repair --dry-run return the same repair preview without writing", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  await writeFile(path.join(project, ".agentic-core", "golden-rules.md"), "corrupt rules\r\n");
  await rm(path.join(project, ".codex", "agents", "agentic-read.toml"));
  const before = await snapshotTree(project);

  const previewOnly = await runCore(["doctor", project, "--dry-run"]);
  const repairPreview = await runCore(["doctor", project, "--repair", "--dry-run"]);
  const preview = reportOf(previewOnly);

  assert.equal(previewOnly.code, 1);
  assert.equal(repairPreview.code, 1);
  assert.deepEqual(reportOf(repairPreview), preview);
  assert.equal(preview.status, "repair_preview");
  assert.deepEqual(preview.repair, {
    requested: true,
    dryRun: true,
    status: "preview",
    actions: preview.repair.actions,
  });
  assert.ok(preview.repair.actions.some((action) => action.action === "restore_resource"));
  assertSameSnapshot(await snapshotTree(project), before);

  const appliedResult = await runCore(["doctor", project, "--repair"]);
  const applied = reportOf(appliedResult);
  assert.equal(appliedResult.code, 0);
  assert.deepEqual(applied.repair.actions, preview.repair.actions);
  assert.equal(applied.status, "repaired");
});

test("doctor --dry-run detects a divergent persisted runtime without replacing or deleting it", async (t) => {
  const project = await createProject(t);
  const runtime = await mkdtemp(path.join(tmpdir(), "agentic doctor npx runtime "));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const packageRoot = path.join(runtime, "node_modules", "@kroxidev", "agentic-core");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  const commit = "348942743d01227c60ba707e22f5c3976fe6e4e7";
  await writeFile(path.join(runtime, "package.json"), JSON.stringify({
    dependencies: { "@kroxidev/agentic-core": "github:KroxiDev/agentic-core" },
    _npx: { packages: ["github:KroxiDev/agentic-core"] },
  }));
  await writeFile(path.join(runtime, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/@kroxidev/agentic-core": {
        resolved: `git+ssh://git@github.com/KroxiDev/agentic-core.git#${commit}`,
      },
    },
  }));
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@kroxidev/agentic-core",
    version: "0.2.0",
    bin: { "agentic-core": "bin/agentic-core.js", "agentic-quality": "bin/agentic-quality.js" },
  }));
  await writeFile(path.join(packageRoot, "bin", "agentic-core.js"), "export {};\n");
  await writeFile(path.join(packageRoot, "bin", "agentic-quality.js"), "export {};\n");
  await cp(path.join(repositoryRoot, "dist", "runtime"), path.join(packageRoot, "dist", "runtime"), {
    recursive: true,
    errorOnExist: true,
  });
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_RUNTIME_ROOT: runtime,
  };
  assert.equal((await runCore(["init", project], { env: environment })).code, 0);
  const artifact = path.join(project, ".agentic-core", "runtime", "agentic-core.mjs");
  await writeFile(artifact, "foreign runtime change\r\n");
  const before = await snapshotTree(project);

  const result = await runCore(["doctor", project, "--dry-run"]);
  const report = reportOf(result);

  assert.equal(result.code, 1);
  assert.equal(report.status, "repair_blocked");
  const runtimeCheck = findCheck(report.diagnosis, "runtime.persistence");
  assert.equal(runtimeCheck.status, "error");
  assert.equal(runtimeCheck.repair.available, false);
  assert.match(runtimeCheck.remediation, /update/i);
  assertSameSnapshot(await snapshotTree(project), before);
});

test("doctor previews and repairs a missing currently owned launcher", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  const productRoot = path.join(project, ".agentic-core");
  await rm(path.join(productRoot, "runtime-launcher.mjs"));
  const before = await snapshotTree(project);

  const previewResult = await runCore(["doctor", project, "--dry-run"]);
  const preview = reportOf(previewResult);

  assert.equal(previewResult.code, 1);
  assert.equal(preview.status, "repair_preview");
  const launcherCheck = findCheck(preview.diagnosis, "resource:.agentic-core/runtime-launcher.mjs");
  assert.equal(launcherCheck.status, "error");
  assert.equal(launcherCheck.repair.available, true);
  assertSameSnapshot(await snapshotTree(project), before);

  const repairedResult = await runCore(["doctor", project, "--repair"]);
  const repaired = reportOf(repairedResult);
  assert.equal(repairedResult.code, 0);
  assert.equal(repaired.status, "repaired");
  assert.equal(findCheck(repaired.postRepair, "resource:.agentic-core/runtime-launcher.mjs").status, "ok");
});

test("doctor restores an invalid owned configuration to the canonical schema", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  const configPath = path.join(project, ".agentic-core", "config.json");
  await writeFile(configPath, "{invalid configuration\r\n");
  const before = await snapshotTree(project);

  const previewResult = await runCore(["doctor", project, "--dry-run"]);
  const preview = reportOf(previewResult);
  assert.equal(previewResult.code, 1);
  assert.equal(preview.status, "repair_preview");
  assert.ok(preview.repair.actions.some((action) => action.action === "restore_resource"
    && action.path === ".agentic-core/config.json"));
  assertSameSnapshot(await snapshotTree(project), before);

  const result = await runCore(["doctor", project, "--repair"]);
  const report = reportOf(result);

  assert.equal(result.code, 0);
  assert.equal(report.status, "repaired");
  assert.deepEqual(report.repair.actions, preview.repair.actions);
  assert.equal(findCheck(report.diagnosis, "configuration.schema").status, "error");
  assert.equal(findCheck(report.postRepair, "configuration.schema").status, "ok");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    $schema: "./config.schema.json",
    schemaVersion: 2,
    coordination: {
      explicitActivationOnly: true,
      defaultMode: "normal",
    },
    quality: { crapThreshold: 7, mutationWorkers: 4 },
  });
});

test("doctor previews and repair never change a foreign or unproven installation", async (t) => {
  for (const [name, manifest] of [
    ["foreign", { schemaVersion: 1, product: "another-product" }],
    ["unproven", undefined],
  ]) {
    await t.test(name, async (subtest) => {
      const project = await createProject(subtest, `agentic doctor ${name} `);
      const productRoot = path.join(project, ".agentic-core");
      await mkdir(productRoot);
      if (manifest) await writeFile(path.join(productRoot, "ownership.json"), `${JSON.stringify(manifest)}\r\n`);
      await writeFile(path.join(productRoot, "foreign.txt"), "do not modify\r\n");
      await writeFile(path.join(project, "AGENTS.md"), "foreign instructions\r\n");
      const before = await snapshotTree(project);

      const previewResult = await runCore(["doctor", project, "--dry-run"]);
      const preview = reportOf(previewResult);
      assert.equal(previewResult.code, 1);
      assert.equal(preview.status, "repair_blocked");
      assert.equal(preview.repair.status, "blocked");
      assert.equal(findCheck(preview.diagnosis, "installation.manifest").status, "error");
      assertSameSnapshot(await snapshotTree(project), before);

      const result = await runCore(["doctor", project, "--repair"]);
      const report = reportOf(result);

      assert.equal(result.code, 1);
      assert.equal(report.status, "repair_blocked");
      assert.equal(report.repair.status, "blocked");
      assert.equal(findCheck(report.diagnosis, "installation.manifest").status, "error");
      assert.equal(findCheck(report.diagnosis, "resources.integrity").status, "blocked");
      assertSameSnapshot(await snapshotTree(project), before);
    });
  }
});

test("doctor refuses ambiguous blocks and incompatible owned path types", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  const agentsPath = path.join(project, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8");
  await writeFile(agentsPath, `${agents}${agents}`);
  const rulesPath = path.join(project, ".agentic-core", "golden-rules.md");
  await rm(rulesPath);
  await mkdir(rulesPath);
  await writeFile(path.join(rulesPath, "foreign.txt"), "do not delete\r\n");
  const before = await snapshotTree(project);

  const result = await runCore(["doctor", project, "--repair"]);
  const report = reportOf(result);

  assert.equal(result.code, 1);
  assert.equal(report.status, "repair_blocked");
  assert.equal(findCheck(report.diagnosis, "managed-block:AGENTS.md#agentic-core").repair.available, false);
  assert.equal(findCheck(report.diagnosis, "resource:.agentic-core/golden-rules.md").evidence.kind, "directory");
  assertSameSnapshot(await snapshotTree(project), before);
});

test("doctor gates Python only when needed and preserves legacy orchestration residue", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  const missingPython = path.join(project, "missing-python");
  const environment = { ...process.env, AGENTIC_CORE_PYTHON: missingPython };

  const withoutPython = reportOf(await runCore(["doctor", project], { env: environment }));
  assert.equal(findCheck(withoutPython.diagnosis, "runtime.python").status, "not_applicable");

  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "subject.py"), "def subject():\n    return True\n");
  const runRoot = path.join(project, ".agentic-core", "runs", "incomplete-run");
  await mkdir(runRoot, { recursive: true });
  await writeFile(path.join(runRoot, "state.json"), `${JSON.stringify({ schemaVersion: 1, mode: "light", status: "running" })}\n`);
  const workerRoot = path.join(project, ".agentic-core", "workers", "abandoned-worker");
  await mkdir(workerRoot, { recursive: true });
  await writeFile(path.join(workerRoot, "partial.bin"), "owned worker residue\r\n");
  const transactionRoot = path.join(project, ".agentic-core", "transactions");
  await mkdir(transactionRoot, { recursive: true });
  await writeFile(path.join(transactionRoot, "pending.json"), "transaction recovery evidence\r\n");

  const result = await runCore(["doctor", project], { env: environment });
  const report = reportOf(result);

  assert.equal(result.code, 1);
  assert.equal(report.status, "unhealthy");
  assert.equal(findCheck(report.diagnosis, "runtime.python").status, "error");
  assert.equal(findCheck(report.diagnosis, "backend.python").status, "blocked");
  const legacy = findCheck(report.diagnosis, "operations.legacy_state");
  assert.equal(legacy.status, "not_applicable");
  assert.deepEqual(legacy.evidence.legacy.map(({ path: legacyPath }) => legacyPath), [
    ".agentic-core/runs",
    ".agentic-core/workers",
    ".agentic-core/transactions",
  ]);
  assert.equal(await readFile(path.join(workerRoot, "partial.bin"), "utf8"), "owned worker residue\r\n");
  assert.equal(await readFile(path.join(runRoot, "state.json"), "utf8"),
    `${JSON.stringify({ schemaVersion: 1, mode: "light", status: "running" })}\n`);
  assert.equal(await readFile(path.join(transactionRoot, "pending.json"), "utf8"),
    "transaction recovery evidence\r\n");
});

test("doctor validates the Python analyzer, runner and coverage backend when Python source requires them", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "subject.py"), "def subject():\n    return True\n");

  const result = await runCore(["doctor", project]);
  const report = reportOf(result);

  assert.equal(result.code, 0);
  assert.equal(findCheck(report.diagnosis, "runtime.python").status, "ok");
  const backend = findCheck(report.diagnosis, "backend.python");
  assert.equal(backend.status, "ok");
  assert.equal(backend.evidence.runner, "unittest");
  assert.match(backend.evidence.coverage, /^(?:coverage\.py|stdlib-trace)$/);
});

test("doctor does not follow a linked installation parent outside the selected project", async (t) => {
  const project = await createProject(t, "agentic doctor linked project ");
  const outside = await createProject(t, "agentic doctor linked outside ");
  assert.equal((await runCore(["init", outside])).code, 0);
  const outsideBefore = await snapshotTree(outside);
  await symlink(
    path.join(outside, ".agentic-core"),
    path.join(project, ".agentic-core"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const result = await runCore(["doctor", project, "--repair"]);
  const report = reportOf(result);

  assert.equal(result.code, 1);
  assert.equal(report.status, "repair_blocked");
  const manifest = findCheck(report.diagnosis, "installation.manifest");
  assert.equal(manifest.status, "error");
  assert.equal(manifest.evidence.kind, "unsafe_parent");
  assert.equal(manifest.evidence.unsafeParent.kind, "symbolic_link");
  assertSameSnapshot(await snapshotTree(outside), outsideBefore);
});

test("a failed doctor repair rolls back every mutation and retains the original diagnosis", async (t) => {
  for (const failAfterWrite of [1, 2, 3]) {
    await t.test(`mutation ${failAfterWrite}`, async (subtest) => {
      const project = await createProject(subtest, `agentic doctor rollback ${failAfterWrite} `);
      assert.equal((await runCore(["init", project])).code, 0);
      await writeFile(path.join(project, ".agentic-core", "golden-rules.md"), "corrupt rules\r\n");
      await rm(path.join(project, ".codex", "agents", "agentic-read.toml"));
      const agentsPath = path.join(project, "AGENTS.md");
      await writeFile(agentsPath, (await readFile(agentsPath, "utf8")).replace("## agentic-core", "## corrupt core"));
      const before = await snapshotTree(project);

      const result = await runCore(["doctor", project, "--repair"], {
        env: {
          ...process.env,
          NODE_ENV: "test",
          AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: String(failAfterWrite),
        },
      });
      const report = reportOf(result);

      assert.equal(result.code, 1);
      assert.equal(report.status, "repair_failed");
      assert.equal(report.repair.status, "failed");
      assert.match(report.repair.error.message, /simulated transaction failure/i);
      assert.equal(report.diagnosis.status, "unhealthy");
      assert.equal(findCheck(report.diagnosis, "resource:.agentic-core/golden-rules.md").status, "error");
      assert.equal(findCheck(report.diagnosis, "managed-block:AGENTS.md#agentic-core").status, "error");
      assertSameSnapshot(await snapshotTree(project), before);
    });
  }
});

test("a host-supplied native capability probe is reflected for both real-agent adapters", async (t) => {
  const project = await createProject(t);
  assert.equal((await runCore(["init", project])).code, 0);
  const probed = [];

  const { exitCode, report } = await doctorInstallation(project, {
    hostAgentProbe: async ({ host, projectRoot }) => {
      probed.push({ host, projectRoot });
      return { created: true, evidence: `${host}-native-agent` };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(report.status, "healthy");
  assert.deepEqual(probed, [
    { host: "codex", projectRoot: path.resolve(project) },
    { host: "claude", projectRoot: path.resolve(project) },
  ]);
  assert.equal(findCheck(report.diagnosis, "adapter.codex.agent_creation").status, "ok");
  assert.equal(findCheck(report.diagnosis, "adapter.claude.agent_creation").status, "ok");
});
