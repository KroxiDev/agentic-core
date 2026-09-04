import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function createFixtureRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic-core-origin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function copyRunnablePackage(packageRoot) {
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    cp(path.join(repositoryRoot, "package.json"), path.join(packageRoot, "package.json")),
    cp(path.join(repositoryRoot, "bin"), path.join(packageRoot, "bin"), { recursive: true }),
    cp(path.join(repositoryRoot, "dist", "runtime"), path.join(packageRoot, "dist", "runtime"), {
      recursive: true,
    }),
  ]);
}

function isolatedEnvironment() {
  const environment = { ...process.env, NODE_ENV: "production" };
  delete environment.AGENTIC_CORE_TEST_RUNTIME_ROOT;
  return environment;
}

async function runPackage(packageRoot, args, cwd) {
  return execFileAsync(process.execPath, [
    path.join(packageRoot, "bin", "agentic-core.js"),
    ...args,
  ], {
    cwd,
    encoding: "utf8",
    env: isolatedEnvironment(),
    windowsHide: true,
  });
}

async function runInstalled(project, command, args) {
  try {
    const result = await execFileAsync(process.execPath, [
      path.join(project, ".agentic-core", "runtime-launcher.mjs"),
      command,
      ...args,
    ], {
      cwd: project,
      encoding: "utf8",
      env: isolatedEnvironment(),
      windowsHide: true,
    });
    return { ...result, code: 0 };
  } catch (error) {
    return {
      code: error.code,
      stderr: error.stderr ?? "",
      stdout: error.stdout ?? "",
    };
  }
}

function assertModeIsUnreported(...evidence) {
  const serialized = evidence.map((value) => (
    typeof value === "string" ? value : JSON.stringify(value)
  )).join("\n");
  assert.doesNotMatch(serialized, /runtimeMode|runtimeStrategy|self-contained|project-local/iu);
}

async function assertCompletePublishedOwnership(project, ownership) {
  assert.ok(ownership.resources.length > 0);
  for (const resource of ownership.resources) {
    const details = await stat(path.join(project, ...resource.path.split("/")));
    assert.equal(details.isFile(), true, resource.path);
  }
  for (const managedBlock of ownership.managedBlocks) {
    const details = await stat(path.join(project, managedBlock.path));
    assert.equal(details.isFile(), true, managedBlock.path);
  }
}

function assertRawMissingFileFailure(result, missingBinary) {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^ENOENT: no such file or directory, lstat /u);
  assert.equal(result.stderr.includes(missingBinary), true, result.stderr);
  assert.doesNotMatch(
    result.stderr,
    /runtime mode|self-contained|project-local|re-?run|install (?:the )?dependency/iu,
  );
}

// These fixtures characterize PR-10. When MJ-12 closes, invert their central
// assertions: a non-canonical self-contained init must fail immediately with an
// actionable diagnosis, while an accepted project-local install must name and
// validate that runtime mode in both its plan and ownership manifest.
test("PR-10: a non-canonical ephemeral source succeeds before prepare fails without guidance", async (t) => {
  const root = await createFixtureRoot(t);
  const bootstrap = path.join(root, "fork-bootstrap");
  const packageRoot = path.join(bootstrap, "node_modules", "@kroxidev", "agentic-core");
  const project = path.join(root, "project");
  await Promise.all([mkdir(bootstrap), mkdir(project)]);
  await writeFile(path.join(bootstrap, "package.json"), `${JSON.stringify({
    private: true,
    dependencies: { "@kroxidev/agentic-core": "github:example/agentic-core" },
    _npx: { packages: ["github:example/agentic-core"] },
  }, null, 2)}\n`);
  await copyRunnablePackage(packageRoot);

  const previewResult = await runPackage(packageRoot, [
    "init", project, "--yes", "--dry-run",
  ], bootstrap);
  const preview = JSON.parse(previewResult.stdout);
  assert.equal(preview.status, "ready");
  assert.equal(Object.hasOwn(preview, "runtime"), false);
  assert.equal(Object.hasOwn(preview.manifest, "runtime"), false);

  const installed = await runPackage(packageRoot, ["init", project, "--yes"], bootstrap);
  assert.match(installed.stdout, /Installed agentic-core 0\.2\.0/u);
  assert.equal(installed.stderr, "");

  const ownership = JSON.parse(await readFile(
    path.join(project, ".agentic-core", "ownership.json"),
    "utf8",
  ));
  await assertCompletePublishedOwnership(project, ownership);
  assert.equal(Object.hasOwn(ownership, "runtime"), false);
  await assert.rejects(lstat(path.join(project, ".agentic-core", "runtime")), { code: "ENOENT" });
  assertModeIsUnreported(preview, ownership, installed.stdout, installed.stderr);

  const firstQualityCommand = await runInstalled(project, "agentic-quality", [
    "prepare", "--mode", "light", "--scope", ".",
  ]);
  assertRawMissingFileFailure(firstQualityCommand, path.join(
    project,
    "node_modules",
    "@kroxidev",
    "agentic-core",
    "bin",
    "agentic-quality.js",
  ));
});

test("PR-10: a project-local dependency masks the non-autonomous installation mode", async (t) => {
  const root = await createFixtureRoot(t);
  const project = path.join(root, "project");
  const packageRoot = path.join(project, "node_modules", "@kroxidev", "agentic-core");
  await mkdir(project);
  await writeFile(path.join(project, "package.json"), `${JSON.stringify({
    name: "project-local-runtime-fixture",
    private: true,
    type: "module",
    dependencies: { "@kroxidev/agentic-core": "file:node_modules/@kroxidev/agentic-core" },
  }, null, 2)}\n`);
  await copyRunnablePackage(packageRoot);

  const previewResult = await runPackage(packageRoot, [
    "init", project, "--yes", "--dry-run",
  ], project);
  const preview = JSON.parse(previewResult.stdout);
  assert.equal(preview.status, "ready");
  assert.equal(Object.hasOwn(preview, "runtime"), false);
  assert.equal(Object.hasOwn(preview.manifest, "runtime"), false);

  const installed = await runPackage(packageRoot, ["init", project, "--yes"], project);
  assert.match(installed.stdout, /Installed agentic-core 0\.2\.0/u);
  assert.equal(installed.stderr, "");

  const ownership = JSON.parse(await readFile(
    path.join(project, ".agentic-core", "ownership.json"),
    "utf8",
  ));
  await assertCompletePublishedOwnership(project, ownership);
  assert.equal(Object.hasOwn(ownership, "runtime"), false);
  await assert.rejects(lstat(path.join(project, ".agentic-core", "runtime")), { code: "ENOENT" });
  assertModeIsUnreported(preview, ownership, installed.stdout, installed.stderr);

  const core = await runInstalled(project, "agentic-core", ["--version"]);
  assert.equal(core.code, 0, core.stderr);
  assert.equal(core.stderr, "");
  assert.equal(core.stdout.trim(), "0.2.0");

  const quality = await runInstalled(project, "agentic-quality", ["--help"]);
  assert.equal(quality.code, 0, quality.stderr);
  assert.equal(quality.stderr, "");
  assert.match(quality.stdout, /agentic-quality scan/u);

  await rm(packageRoot, { recursive: true, force: true });
  const withoutDependency = await runInstalled(project, "agentic-quality", ["--help"]);
  assertRawMissingFileFailure(withoutDependency, path.join(
    packageRoot,
    "bin",
    "agentic-quality.js",
  ));
});
