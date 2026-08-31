import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

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
  "dist/runtime/resources/src/claude-read-command-guard.mjs",
  "dist/runtime/resources/src/runtime-launcher.mjs",
  "dist/runtime/THIRD_PARTY_NOTICES.md",
  "dist/runtime/third_party/@jridgewell/resolve-uri/LICENSE",
  "dist/runtime/third_party/@jridgewell/sourcemap-codec/LICENSE",
  "dist/runtime/third_party/@jridgewell/trace-mapping/LICENSE",
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
  assert.equal(pack.version, "0.1.0");
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
  assert.match(await readFile(path.join(installedRoot, "README.md"), "utf8"), /Implementador → Tester/);
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
    assert.equal(result.stdout.trim(), "0.1.0");
    const help = await execFileAsync(process.execPath, [binaryPath, "--help"], {
      cwd: consumer,
      encoding: "utf8",
    });
    assert.match(help.stdout, helpPattern);
  }

  const maintenanceBinary = path.join(installedRoot, "bin", "agentic-core.js");
  await execFileAsync(process.execPath, [maintenanceBinary, "init", consumer, "--yes"], {
    cwd: consumer,
    encoding: "utf8",
  });
  const doctor = await execFileAsync(process.execPath, [maintenanceBinary, "doctor", consumer], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(doctor.stdout).status, "healthy");
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
  const preview = JSON.parse((await runCandidate(previewProject, ["init", ".", "--yes", "--dry-run"])).stdout);
  assert.equal(preview.status, "ready");
  assert.deepEqual(await readdir(previewProject), [".hidden"]);
  assert.deepEqual(await readFile(path.join(previewProject, ".hidden")), Buffer.from([0x00, 0xff]));

  const project = await temporaryDirectory(t, "agentic core bootstrap consumer ");
  const initialized = await runCandidate(project, ["init", ".", "--yes"]);
  assert.match(initialized.stdout, /Installed agentic-core 0\.1\.0/);
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
  assert.equal(version.stdout.trim(), "0.1.0");
  const help = await execFileAsync(process.execPath, [launcher, "agentic-quality", "--help"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.match(help.stdout, /agentic-quality scan/);
  await writeFile(path.join(project, "quality-smoke.mjs"), "export function identity(value) { return value; }\n");
  await writeFile(path.join(project, "quality-smoke.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { identity } from "./quality-smoke.mjs";',
    'test("identity", () => assert.equal(identity(7), 7));',
    "",
  ].join("\n"));
  const quality = await execFileAsync(process.execPath, [
    launcher,
    "agentic-quality",
    "scan",
    "--target",
    "quality-smoke.mjs",
  ], { cwd: project, encoding: "utf8" });
  const qualityReport = JSON.parse(quality.stdout);
  assert.equal(qualityReport.status, "approved");
  assert.equal(qualityReport.details.length, 1);
});
