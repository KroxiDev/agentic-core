import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTestProject } from "../test/project-builder.js";
import { pythonProject, runPythonProject } from "../test/support/python-project.mjs";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(repository, ".codex-temp/linux-artifacts");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// The consumer may contain normal venv symlinks. Observe their identity without
// following them or weakening the product's stricter managed-tree ownership.
async function fingerprint(root) {
  const records = [];
  async function visit(file, relative) {
    const info = await lstat(file);
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) records.push([relative, mode, "link", await readlink(file)]);
    else if (info.isDirectory()) {
      records.push([relative, mode, "directory"]);
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), `${relative}/${name}`);
    } else {
      assert.ok(info.isFile());
      records.push([relative, mode, sha256(await readFile(file))]);
    }
  }
  await visit(root, ".");
  return sha256(JSON.stringify(records));
}

async function core(root, entry, args, extraEnv = {}, expected = 0) {
  let result;
  try {
    result = { ...await execute(process.execPath, [entry, ...args], {
      cwd: root, encoding: "utf8", timeout: 120000,
      env: { ...process.env, AGENTIC_CORE_OUTPUT: "json", ...extraEnv },
    }), code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  assert.equal(result.code, expected, result.stdout + result.stderr);
  if (expected !== 0) return result;
  return JSON.parse(result.stdout);
}

async function quality(root, args, expected = 0) {
  const result = await runPythonProject(root, args);
  assert.equal(result.code, expected, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test("Linux: paquete autónomo, helper ejecutable, calidad y mantenimiento entre dos instalaciones", async (t) => {
  assert.equal(process.platform, "linux", "Esta aceptación requiere Linux real; no se omite por plataforma");
  assert.notEqual(process.getuid(), 0, "Los permisos deben verificarse con un usuario sin privilegios de root");
  await mkdir(artifacts, { recursive: true });
  const evidence = { status: "NO_VERIFICADO", nativeCodex: "NO_VERIFICADO", steps: [],
    environment: { platform: process.platform, architecture: process.arch, kernel: release(), node: process.version,
      distribution: (await readFile("/etc/os-release", "utf8")).match(/^PRETTY_NAME=(.*)$/m)?.[1],
      python: (await execute("python", ["--version"])).stdout.trim(),
      pytest: (await execute("python", ["-m", "pytest", "--version"])).stdout.trim(),
      commit: (await execute("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim() } };
  async function step(name, action) {
    try { await action(); evidence.steps.push({ name, status: "verified" }); t.diagnostic(name); }
    catch (error) { evidence.steps.push({ name, status: "failed" }); throw error; }
  }
  try {
    const bootstrap = await createTestProject(t);
    const pack = JSON.parse((await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], { cwd: repository })).stdout)[0];
    const tarball = path.join(artifacts, pack.filename);
    evidence.package = { name: pack.name, version: pack.version, sha256: sha256(await readFile(tarball)) };
    await execute("tar", ["-xzf", tarball, "-C", bootstrap]);
    const entry = path.join(bootstrap, "package/bin/agentic-core.js");
    const a = await pythonProject(t, { install: false });
    const b = await pythonProject(t, { install: false });
    const work = path.join(a.root, "work dir");
    evidence.environment.filesystem = (await execute("findmnt", ["--target", work, "--noheadings", "--output", "FSTYPE"])).stdout.trim();
    evidence.environment.unprivileged = true;
    await writeFile(path.join(a.root, "AGENTS.md"), "# Instrucciones del consumidor\n");
    await writeFile(path.join(a.root, "uv.lock"), "synthetic consumer lock\n");
    await writeFile(path.join(work, "Case.txt"), "UPPER");
    await writeFile(path.join(work, "case.txt"), "lower");
    await writeFile(path.join(work, "helper executable"), '#!/bin/sh\nprintf "%s" "$1"\n');
    await chmod(path.join(work, "helper executable"), 0o751);
    const check = path.join(work, "python checks/check_subject.py");
    await writeFile(check, `${await readFile(check, "utf8")}
def test_linux_resources():
    import stat, subprocess
    assert Path('Case.txt').read_text() == 'UPPER'
    assert Path('case.txt').read_text() == 'lower'
    assert stat.S_IMODE(Path('helper executable').stat().st_mode) == 0o751
    assert subprocess.check_output(['./helper executable', 'space & literal'], text=True) == 'space & literal'
`);
    const consumer = { work: await fingerprint(work), environment: await fingerprint(path.join(a.root, ".venv")),
      lock: await readFile(path.join(a.root, "uv.lock"), "utf8") };
    let bInstalled;
    await step("instalación desde tarball, previsualización y rollback", async () => {
      const before = await fingerprint(a.root);
      const args = ["init", a.root, "--config", path.join(a.root, "settings.json")];
      await core(a.root, entry, [...args, "--dry-run"]);
      assert.equal(await fingerprint(a.root), before);
      await core(a.root, entry, args, { NODE_ENV: "test", AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: "6" }, 5);
      assert.equal(await fingerprint(a.root), before);
      for (const project of [a, b]) {
        const installed = await core(project.root, entry, ["init", project.root, "--config", path.join(project.root, "settings.json")]);
        assert.equal(installed.status, "installed");
        assert.ok(installed.python.version[1] >= 11);
        assert.equal(installed.python.executable, project.python);
        assert.ok((await lstat(path.join(project.root, ".agentic-core/tools/lib64"))).isDirectory());
        assert.ok((await lstat(path.join(project.root, ".venv/lib64"))).isSymbolicLink());
      }
      const owner = async (root) => JSON.parse(await readFile(path.join(root, ".agentic-core/ownership.json"), "utf8"));
      assert.notEqual((await owner(a.root)).installationId, (await owner(b.root)).installationId);
      assert.equal(await fingerprint(path.join(a.root, ".venv")), consumer.environment);
      bInstalled = await fingerprint(b.root);
      await rm(bootstrap, { recursive: true });
    });
    const launcher = path.join(a.root, ".agentic-core/runtime-launcher.mjs");
    const maintenance = (args, env, expected) => core(a.root, launcher, ["agentic-core", ...args], env, expected);
    const prepare = (id) => quality(a.root, ["prepare", "--task", id, "--mode", "normal", "--objective", "issue:59"]);
    await step("runtime sin bootstrap, tests funcionales y controles explícitos", async () => {
      assert.equal((await maintenance(["doctor"])).status, "healthy");
      await prepare("linux-first");
      const verified = await quality(a.root, ["verify"]);
      assert.equal(verified.verification.controls.tests.status, "approved");
      assert.equal(verified.result.suite.phases.call, 2);
      for (const name of ["dry", "crap", "mutation"]) {
        assert.equal(verified.verification.controls[name].status, "NO_SOLICITADO");
        assert.equal(verified.verification[name].executed, false);
        await assert.rejects(lstat(path.join(a.root, `.agentic-core/quality/${name}.json`)), { code: "ENOENT" });
      }
      // Keep installed engine coverage through explicit public commands.
      for (const name of ["dry", "crap"]) {
        assert.equal((await quality(a.root, [name])).status, "approved");
      }
    });
    await step("mutación real conserva helper, mayúsculas y consumidor", async () => {
      // Standalone mutation reports execution, not an aggregate quality approval.
      const mutation = await quality(a.root, ["mutate"], 2);
      assert.equal(mutation.code, "mutation_execution_complete");
      assert.equal(mutation.complete, true);
      assert.equal(mutation.generated, 2);
      assert.equal(mutation.selected, 2);
      assert.deepEqual(mutation.summary, { killed: 2, survived: 0, uncovered: 0, timeout: 0, error: 0, interrupted: 0 });
      assert.equal(mutation.integrity.status, "preserved");
      evidence.mutation = mutation.summary;
      assert.equal(await fingerprint(work), consumer.work);
      assert.equal(await fingerprint(path.join(a.root, ".venv")), consumer.environment);
    });
    await step("otra tarea limpia solo evidencia propia y conserva exportación", async () => {
      await quality(a.root, ["verify"]);
      const output = path.join(a.root, "resultado solicitado.md");
      await quality(a.root, ["export", "--output", output]);
      const saved = await readFile(output, "utf8");
      const foreign = path.join(a.root, ".agentic-core/quality/foreign.txt");
      await writeFile(foreign, "keep foreign evidence\n");
      assert.equal((await prepare("linux-second")).task.id, "linux-second");
      await assert.rejects(lstat(path.join(a.root, ".agentic-core/quality/verification.json")), { code: "ENOENT" });
      await assert.rejects(lstat(path.join(a.root, ".agentic-core/quality/mutation.json")), { code: "ENOENT" });
      assert.equal(await readFile(output, "utf8"), saved);
      assert.equal(await readFile(foreign, "utf8"), "keep foreign evidence\n");
      assert.equal(await fingerprint(b.root), bInstalled);
    });
    await step("actualización y rollback preservan bytes y permisos", async () => {
      const profile = path.join(a.root, ".codex/agents/agentic-production.toml");
      const original = await readFile(profile);
      await writeFile(profile, "synthetic older profile\n");
      const before = await fingerprint(a.root);
      await maintenance(["update", "--force", "--dry-run"]);
      assert.equal(await fingerprint(a.root), before);
      await maintenance(["update", "--force"], { NODE_ENV: "test", AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: "1" }, 5);
      assert.equal(await fingerprint(a.root), before);
      assert.equal((await maintenance(["update", "--force"])).status, "updated");
      assert.deepEqual(await readFile(profile), original);
      assert.equal(await fingerprint(b.root), bInstalled);
    });
    await step("desinstalación preserva consumidor y segunda instalación", async () => {
      const foreign = path.join(a.root, ".agentic-core/foreign.txt");
      await writeFile(foreign, "keep foreign\n");
      const before = await fingerprint(a.root);
      await maintenance(["uninstall", "--dry-run"]);
      assert.equal(await fingerprint(a.root), before);
      assert.equal((await maintenance(["uninstall"])).dryRun, false);
      for (const item of ["runtime", "tools", "ownership.json"]) {
        await assert.rejects(lstat(path.join(a.root, ".agentic-core", item)), { code: "ENOENT" }, item);
      }
      assert.equal(await readFile(foreign, "utf8"), "keep foreign\n");
      // Maintenance preserves nonempty directories without per-file ownership.
      // Retirement of owned task evidence was checked at the task switch above.
      assert.equal(await readFile(path.join(a.root, ".agentic-core/quality/foreign.txt"), "utf8"), "keep foreign evidence\n");
      assert.ok((await lstat(path.join(a.root, "resultado solicitado.md"))).isFile());
      assert.equal(await fingerprint(work), consumer.work);
      assert.equal(await fingerprint(path.join(a.root, ".venv")), consumer.environment);
      assert.equal(await readFile(path.join(a.root, "uv.lock"), "utf8"), consumer.lock);
      assert.match(await readFile(path.join(a.root, "AGENTS.md"), "utf8"), /^# Instrucciones del consumidor\n/);
      await execute(a.python, a.config.integration.python.command.args, { cwd: work, encoding: "utf8",
        env: { ...process.env, ...a.config.integration.python.environment, AGENTIC_CORE_PYTHON: a.python } });
      assert.equal(await fingerprint(b.root), bInstalled);
      const second = await quality(b.root, ["test"]);
      assert.equal(second.suite.phases.call, 1);
      assert.equal(await fingerprint(b.root), bInstalled);
    });
    evidence.status = "automatic_verified";
  } finally {
    await writeFile(path.join(artifacts, "acceptance.json"), JSON.stringify(evidence, null, 2) + "\n");
  }
});
