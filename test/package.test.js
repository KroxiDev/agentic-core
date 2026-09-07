import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { initialize } from "../src/init.js";
import { hashDirectory } from "../src/transaction.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const expectedInventory = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "bin/agentic-core.js",
  "bin/agentic-quality.js",
  "bin/runtime-loader.js",
  "dist/runtime/agentic_crap.py",
  "dist/runtime/agentic_dry.py",
  "dist/runtime/agentic_mutation.py",
  "dist/runtime/agentic_pytest.py",
  "dist/runtime/agentic-core.mjs",
  "dist/runtime/LICENSE",
  "dist/runtime/payload-manifest.json",
  "dist/runtime/python-helper.py",
  "dist/runtime/resources/adapters/claude/agents/agentic-docs.md",
  "dist/runtime/resources/adapters/claude/agents/agentic-production.md",
  "dist/runtime/resources/adapters/claude/agents/agentic-read.md",
  "dist/runtime/resources/adapters/claude/agents/agentic-tests.md",
  "dist/runtime/resources/adapters/claude/skills/agentic-grilling/SKILL.md",
  "dist/runtime/resources/adapters/claude/skills/agentic-tdd/SKILL.md",
  "dist/runtime/resources/adapters/claude/skills/orquestar/SKILL.md",
  "dist/runtime/resources/adapters/codex/agents/agentic-docs.toml",
  "dist/runtime/resources/adapters/codex/agents/agentic-production.toml",
  "dist/runtime/resources/adapters/codex/agents/agentic-read.toml",
  "dist/runtime/resources/adapters/codex/agents/agentic-tests.toml",
  "dist/runtime/resources/golden-rules.md",
  "dist/runtime/resources/skills/agentic-grilling/SKILL.md",
  "dist/runtime/resources/skills/agentic-tdd/SKILL.md",
  "dist/runtime/resources/skills/orquestar/SKILL.md",
  "dist/runtime/resources/src/runtime-launcher.mjs",
  "dist/runtime/THIRD_PARTY_NOTICES.md",
  "dist/runtime/third_party/@jridgewell/resolve-uri/LICENSE",
  "dist/runtime/third_party/@jridgewell/sourcemap-codec/LICENSE",
  "dist/runtime/third_party/@jridgewell/trace-mapping/LICENSE",
  "dist/runtime/third_party/python/coverage-7.13.4-py3-none-any.whl",
  "dist/runtime/third_party/python/crap4py-0.1.1-py3-none-any.whl",
  "dist/runtime/third_party/python/dry4python-0.1.0-py3-none-any.whl",
  "dist/runtime/third_party/python/mutate4py-0.1.4-py3-none-any.whl",
  "dist/runtime/third_party/python/NOTICE.md",
  "dist/runtime/third_party/typescript/LICENSE.txt",
  "dist/runtime/third_party/typescript/ThirdPartyNoticeText.txt",
  "package.json",
];

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runNpm(args, { cache, ...options }) {
  return execFileAsync(process.execPath, [npmCli, ...args, "--silent", "--cache", cache], {
    ...options,
  });
}

async function isolatedRuntimeSource(t, tarball, cache) {
  const runtime = await temporaryDirectory(t, "agentic-core-runtime-source-");
  await runNpm(
    ["install", tarball, "--prefix", runtime, "--no-audit", "--no-fund"],
    { cache, cwd: runtime, encoding: "utf8" },
  );
  const spec = "github:KroxiDev/agentic-core";
  const commit = "348942743d01227c60ba707e22f5c3976fe6e4e7";
  await writeFile(path.join(runtime, "package.json"), `${JSON.stringify({
    dependencies: { "@kroxidev/agentic-core": spec },
    _npx: { packages: [spec] },
  }, null, 2)}\n`);
  const lockPath = path.join(runtime, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages[""].dependencies = { "@kroxidev/agentic-core": spec };
  lock.packages["node_modules/@kroxidev/agentic-core"].resolved =
    `git+ssh://git@github.com/KroxiDev/agentic-core.git#${commit}`;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return runtime;
}

test("npm pack contains exactly the production runtime inventory", async (t) => {
  const cache = await temporaryDirectory(t, "agentic-core-npm-cache-");
  const { stdout } = await runNpm(["pack", "--ignore-scripts", "--dry-run", "--json"], {
    cache,
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const [pack] = JSON.parse(stdout);

  assert.equal(pack.name, "@kroxidev/agentic-core");
  assert.equal(pack.version, "0.2.0");
  assert.deepEqual(pack.files.map(({ path: filePath }) => filePath), expectedInventory);
});

test("both CLI entry points work from an installed package", async (t) => {
  const packDirectory = await temporaryDirectory(t, "agentic-core-pack-");
  const consumer = await temporaryDirectory(t, "agentic core consumer ");
  const cache = await temporaryDirectory(t, "agentic-core-npm-cache-");
  const { stdout } = await runNpm(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory],
    { cache, cwd: repositoryRoot, encoding: "utf8" },
  );
  const [pack] = JSON.parse(stdout);
  const tarball = path.join(packDirectory, pack.filename);
  await runNpm(
    ["install", tarball, "--prefix", consumer, "--no-audit", "--no-fund"],
    { cache, cwd: consumer, encoding: "utf8" },
  );

  const installedRoot = path.join(consumer, "node_modules", "@kroxidev", "agentic-core");
  for (const dependencyTree of [
    path.join(consumer, "node_modules", "typescript"),
    path.join(consumer, "node_modules", "@jridgewell"),
    path.join(installedRoot, "node_modules"),
  ]) await assert.rejects(lstat(dependencyTree), { code: "ENOENT" });
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  assert.deepEqual(installedPackage.bin, {
    "agentic-core": "bin/agentic-core.js",
    "agentic-quality": "bin/agentic-quality.js",
  });
  assert.match(await readFile(path.join(installedRoot, "README.md"), "utf8"), /QualitySession/);
  assert.match(await readFile(path.join(installedRoot, "THIRD_PARTY_NOTICES.md"), "utf8"), /typescript/);

  for (const [binary, helpPattern] of [
    ["agentic-core.js", /agentic-core init/],
    ["agentic-quality.js", /agentic-quality scan/],
  ]) {
    const binaryPath = path.join(installedRoot, "bin", binary);
    const result = await execFileAsync(process.execPath, [binaryPath, "--version"], {
      cwd: consumer,
      encoding: "utf8",
    });
    assert.equal(result.stdout.trim(), "0.2.0");
    const help = await execFileAsync(process.execPath, [binaryPath, "--help"], {
      cwd: consumer,
      encoding: "utf8",
    });
    assert.match(help.stdout, helpPattern);
  }

  const maintenanceBinary = path.join(installedRoot, "bin", "agentic-core.js");
  await execFileAsync(process.execPath, [maintenanceBinary, "init", consumer, "--provider", "codex", "--language", "python"], {
    cwd: consumer,
    encoding: "utf8",
  });
  const doctor = await execFileAsync(process.execPath, [maintenanceBinary, "doctor", consumer], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.match(doctor.stdout, /DIAGNÓSTICO/);
});

test("installed package maintains schema 3 and legacy projects transactionally", async (t) => {
  const packDirectory = await temporaryDirectory(t, "agentic-core-maintenance-pack-");
  const packageConsumer = await temporaryDirectory(t, "agentic core package host ");
  const cache = await temporaryDirectory(t, "agentic-core-maintenance-cache-");
  const { stdout } = await runNpm(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory],
    { cache, cwd: repositoryRoot, encoding: "utf8" },
  );
  const [pack] = JSON.parse(stdout);
  await runNpm(
    ["install", path.join(packDirectory, pack.filename), "--prefix", packageConsumer, "--no-audit", "--no-fund"],
    { cache, cwd: packageConsumer, encoding: "utf8" },
  );
  const binary = path.join(packageConsumer, "node_modules", "@kroxidev", "agentic-core", "bin", "agentic-core.js");
  const environment = { ...process.env, AGENTIC_CORE_OUTPUT: "json", NODE_ENV: "test" };
  const runMaintenance = async (root, args, env = environment) => {
    try {
      return { ...await execFileAsync(process.execPath, [binary, ...args], {
        cwd: root,
        encoding: "utf8",
        env,
      }), code: 0 };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  const assertConsumerRuns = async (root, python) => {
    const execution = await execFileAsync(python, ["consumer.py"], { cwd: root, encoding: "utf8" });
    assert.equal(execution.stdout.trim(), "consumer-ok");
  };

  const currentConsumer = await temporaryDirectory(t, "agentic core current package consumer ");
  await writeFile(path.join(currentConsumer, "consumer.py"), "print('consumer-ok')\n");
  const initialized = await runMaintenance(currentConsumer, [
    "init", currentConsumer, "--provider", "codex", "--language", "python",
  ]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const python = JSON.parse(initialized.stdout).python.executable;
  await assertConsumerRuns(currentConsumer, python);

  const rulesPath = path.join(currentConsumer, ".agentic-core", "golden-rules.md");
  await writeFile(rulesPath, "outdated owned rules\n");
  const beforeFailedUpdate = await hashDirectory(currentConsumer);
  const failedUpdate = await runMaintenance(currentConsumer, ["update", currentConsumer, "--force"], {
    ...environment,
    AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: "1",
  });
  assert.equal(failedUpdate.code, 5, failedUpdate.stderr);
  assert.equal(await hashDirectory(currentConsumer), beforeFailedUpdate);
  const updatePreview = await runMaintenance(currentConsumer, ["update", currentConsumer, "--force", "--dry-run"]);
  assert.equal(updatePreview.code, 0, updatePreview.stderr);
  assert.equal(JSON.parse(updatePreview.stdout).status, "ready");
  const updated = await runMaintenance(currentConsumer, ["update", currentConsumer, "--force"]);
  assert.equal(updated.code, 0, updated.stderr);
  const repeated = await runMaintenance(currentConsumer, ["update", currentConsumer, "--dry-run"]);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).plan.actions.length, 0);

  const legacyConsumer = await temporaryDirectory(t, "agentic core legacy package consumer ");
  await writeFile(path.join(legacyConsumer, "consumer.py"), "print('consumer-ok')\n");
  await initialize(legacyConsumer);
  await writeFile(path.join(legacyConsumer, "AGENTS.md"), "# Consumer instructions\n");
  const migrationPreview = await runMaintenance(legacyConsumer, ["update", legacyConsumer, "--dry-run"]);
  assert.equal(migrationPreview.code, 0, migrationPreview.stderr);
  assert.equal(JSON.parse(migrationPreview.stdout).plan.options.migration, true);
  const migrated = await runMaintenance(legacyConsumer, ["update", legacyConsumer]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.match(await readFile(path.join(legacyConsumer, "AGENTS.md"), "utf8"), /AGENTIC_CORE_START/u);
  await assertConsumerRuns(legacyConsumer, python);

  await mkdir(path.join(currentConsumer, ".agentic-core", "quality"), { recursive: true });
  const foreign = path.join(currentConsumer, ".agentic-core", "quality", "foreign.txt");
  await writeFile(foreign, "preserve me\n");
  const uninstallPreview = await runMaintenance(currentConsumer, ["uninstall", currentConsumer, "--dry-run"]);
  assert.equal(uninstallPreview.code, 0, uninstallPreview.stderr);
  const uninstalled = await runMaintenance(currentConsumer, ["uninstall", currentConsumer]);
  assert.equal(uninstalled.code, 0, uninstalled.stderr);
  assert.equal(await readFile(foreign, "utf8"), "preserve me\n");
  await assertConsumerRuns(currentConsumer, python);
});

test("a one-shot npm exec candidate previews cleanly and leaves both persisted runtime seams usable", async (t) => {
  const packDirectory = await temporaryDirectory(t, "agentic-core-bootstrap-pack-");
  const cache = await temporaryDirectory(t, "agentic-core-bootstrap-cache-");
  const { stdout } = await runNpm(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory],
    { cache, cwd: repositoryRoot, encoding: "utf8" },
  );
  const [pack] = JSON.parse(stdout);
  const tarball = path.join(packDirectory, pack.filename);
  const runtime = await isolatedRuntimeSource(t, tarball, cache);
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "npm_config_cache",
    )),
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_RUNTIME_ROOT: runtime,
    NPM_CONFIG_CACHE: cache,
    AGENTIC_CORE_OUTPUT: "json",
  };
  const runCandidate = (cwd, args) => execFileAsync(process.execPath, [
    npmCli,
    "exec",
    "--yes",
    "--package",
    tarball,
    "--",
    "agentic-core",
    ...args,
  ], { cwd, encoding: "utf8", env: environment });

  const previewProject = await temporaryDirectory(t, "agentic core bootstrap preview ");
  await writeFile(path.join(previewProject, ".hidden"), Buffer.from([0x00, 0xff]));
  const preview = JSON.parse((await runCandidate(previewProject, ["init", ".", "--provider", "codex", "--language", "python", "--dry-run"])).stdout);
  assert.equal(preview.status, "ready");
  assert.deepEqual(await readdir(previewProject), [".hidden"]);
  assert.deepEqual(await readFile(path.join(previewProject, ".hidden")), Buffer.from([0x00, 0xff]));

  const project = await temporaryDirectory(t, "agentic core bootstrap consumer ");
  const initialized = await runCandidate(project, ["init", ".", "--provider", "codex", "--language", "python"]);
  assert.equal(JSON.parse(initialized.stdout).status, "installed");
  for (const rootPackageFile of ["package.json", "package-lock.json", "node_modules"]) {
    await assert.rejects(lstat(path.join(project, rootPackageFile)), { code: "ENOENT" });
  }
  const persistedRuntime = path.join(project, ".agentic-core", "runtime");
  for (const forbidden of ["package.json", "package-lock.json", "node_modules", "_npx", "payload-manifest.json"]) {
    await assert.rejects(lstat(path.join(persistedRuntime, forbidden)), { code: "ENOENT" });
  }
  const launcher = path.join(project, ".agentic-core", "runtime-launcher.mjs");
  const version = await execFileAsync(process.execPath, [launcher, "agentic-core", "--version"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(version.stdout.trim(), "0.2.0");
  await assert.rejects(execFileAsync(process.execPath, [launcher, "agentic-quality", "prepare", "--task", "installation", "--mode", "normal", "--objective", "installation"], { cwd: project, encoding: "utf8" }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stdout + error.stderr, /NO_VERIFICADO/);
    assert.doesNotMatch(error.stdout + error.stderr, /QUALITY_OK/);
    return true;
  });
});
