import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTestProject } from "./project-builder.js";
import { pythonProject, runPythonProject } from "./support/python-project.mjs";
import { hashDirectory } from "../src/transaction.js";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const parse = (result) => {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};
const prepare = (id) => ["prepare", "--task", id, "--mode", "light", "--objective", "issue:58"];

// One integration journey, not a second copy of the individual gate suites.
// This exercises tools on Windows; it does not launch or attest Codex agents.
test("Windows distributed package completes the independent consumer lifecycle", {
  skip: process.platform !== "win32" ? "Windows no ejecutado; Linux tiene aceptación independiente en #59" : false,
  timeout: 300000,
}, async (t) => {
  const packageHost = await createTestProject(t);
  const npm = (args) => execute(process.execPath, [npmCli, ...args,
    "--cache", path.join(packageHost, "cache"), "--no-audit", "--no-fund", "--silent"],
  { cwd: repository, encoding: "utf8", windowsHide: true, timeout: 120000 });
  const [pack] = JSON.parse((await npm([
    "pack", "--ignore-scripts", "--json", "--pack-destination", packageHost,
  ])).stdout);
  const tarball = path.join(packageHost, pack.filename);
  const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
  await npm(["install", tarball, "--prefix", packageHost, "--ignore-scripts"]);
  const installed = path.join(packageHost, "node_modules/@kroxidev/agentic-core");
  const installer = path.join(installed, "bin/agentic-core.js");
  const { root, python } = await pythonProject(t, { installer });
  const second = await pythonProject(t, { installer });
  const secondBefore = await hashDirectory(second.root);
  assert.ok(root.includes(" "));
  for (const file of ["package.json", "package-lock.json", "node_modules", ".claude"]) {
    await assert.rejects(lstat(path.join(root, file)), { code: "ENOENT" });
  }
  const environmentBefore = await hashDirectory(path.join(root, ".venv"));
  const configBefore = await readFile(path.join(root, ".agentic-core/config.json"), "utf8");
  const marker = path.join(root, ".agentic-core/quality/archivo ajeno.txt");
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, "contenido ajeno conservado\n");
  await writeFile(path.join(root, ".env"), "API_KEY=synthetic-acceptance-secret\n");
  const counter = path.join(packageHost, "suite-count.txt");
  const wrapper = path.join(root, "work dir/wrapper space.py");
  await writeFile(wrapper, `import os\nfrom pathlib import Path\ncounter = Path(os.environ['ACCEPTANCE_COUNTER'])\ncounter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else '1')\n${await readFile(wrapper, "utf8")}`);
  const consumerBefore = await hashDirectory(path.join(root, "work dir"));
  const run = (args, env) => runPythonProject(root, args, { ACCEPTANCE_COUNTER: counter, ...env });
  const count = () => readFile(counter, "utf8");
  const maintenance = async (args) => {
    const result = await execute(process.execPath, [path.join(root, ".agentic-core/runtime-launcher.mjs"), "agentic-core", ...args, root], {
      cwd: root, env: { ...process.env, AGENTIC_CORE_OUTPUT: "json" },
      encoding: "utf8", windowsHide: true, timeout: 120000,
    });
    return JSON.parse(result.stdout);
  };

  // Make the bootstrap unavailable while exercising the persisted runtime.
  const hidden = `${installed}-unavailable`;
  await rename(installed, hidden);
  try {
    const version = await run(["--version"]);
    assert.equal(version.code, 0, version.stdout);
    assert.equal(version.stdout.trim(), pack.version);
    const direct = parse(await run(["test"]));
    assert.equal(direct.status, "approved");
    assert.equal(direct.suite.phases.call, 1);
    assert.ok(direct.python.version[1] >= 11);
    assert.ok(direct.python.pytestVersion);
    await assert.rejects(lstat(path.join(root, ".agentic-core/quality/active-task.json")), { code: "ENOENT" });

    const initialFiles = await readdir(root);
    parse(await run(prepare("windows-first")));
    const verified = parse(await run(["verify"]));
    assert.equal(verified.status, "approved");
    assert.match(verified.receipt, /^QUALITY_OK/u);
    assert.equal(verified.verification.tests.suite.phases.call, 1);
    for (const gate of ["tests", "dry", "crap"]) {
      assert.equal(verified.verification.controls[gate].status, "approved");
    }
    assert.deepEqual(await readdir(root), initialFiles, "sin petición no se exporta un resultado");
    const calls = await count();
    assert.equal(parse(await run(prepare("windows-first"))).reused, true);
    const reused = parse(await run(["verify"]));
    for (const control of ["tests", "dry", "crap"])
      assert.equal(reused.verification.reuse[control].reused, true);
    assert.equal(reused.budget.consumedMs, verified.budget.consumedMs);
    const explained = parse(await run(["explain", "--json"]));
    assert.equal(explained.testsExecuted, false);
    assert.equal(explained.evidence.current, true);
    assert.ok(!JSON.stringify(explained).includes(root));
    assert.doesNotMatch(JSON.stringify(explained), /synthetic-acceptance-secret|API_KEY/u);
    const pipe = await run(["explain"], { AGENTIC_CORE_OUTPUT: "" });
    assert.equal(pipe.code, 0, pipe.stdout);
    assert.ok(pipe.stdout.split("\n").length < 20);
    assert.doesNotMatch(pipe.stdout, /^\{/u);
    assert.match(pipe.stdout, /diagnóstico sin ejecutar pruebas/u);
    assert.doesNotMatch(pipe.stdout, /synthetic-acceptance-secret|API_KEY/u);
    assert.equal(await count(), calls, "reutilización y diagnóstico no repiten pytest");

    const mutationRun = await run(["mutate"]);
    const mutation = JSON.parse(mutationRun.stdout);
    assert.equal(mutationRun.code, 2, mutationRun.stdout);
    assert.equal(mutation.code, "mutation_execution_complete");
    assert.equal(mutation.status, "NO_VERIFICADO", "mutate individual no emite aprobación agregada");
    assert.equal(mutation.engine.version, "0.1.4");
    assert.equal(mutation.complete, true);
    assert.equal(mutation.summary.killed, 2);
    assert.equal(mutation.details.length, 2);
    assert.ok(mutation.details.length > 0, "la mutación debe ejecutar un corpus no vacío");
    assert.ok(mutation.details.every((item) => item.status === "killed"));
    assert.equal(mutation.integrity.status, "preserved");

    const mutationCalls = await count();
    const repeatedMutation = await run(["mutate"]);
    assert.equal(repeatedMutation.code, 2);
    assert.equal(JSON.parse(repeatedMutation.stdout).reused, true);
    assert.equal(await count(), mutationCalls);
    assert.deepEqual(await readdir(root), initialFiles, "sin exportación automática");

    const output = path.join(root, "resultado solicitado.md");
    assert.equal(parse(await run(["export", "--output", output])).status, "saved");
    const saved = await readFile(output, "utf8");
    assert.match(saved, /windows-first/u);
    assert.doesNotMatch(saved, /synthetic-acceptance-secret|API_KEY/u);
    assert.equal(await count(), mutationCalls);
    const source = path.join(root, "work dir/src/subject.py");
    const original = await readFile(source, "utf8");
    await writeFile(source, `${original}\n# cambio pertinente para invalidar evidencia\n`);
    const stale = await run(["explain", "--json"]);
    assert.equal(stale.code, 2);
    assert.equal(JSON.parse(stale.stdout).code, "quality_inputs_changed");
    assert.equal(await count(), mutationCalls);
    const refreshed = parse(await run(["verify"]));
    assert.equal(refreshed.verification.reuse.tests.reused, false);
    assert.equal(Number(await count()), Number(mutationCalls) + 1);
    await writeFile(source, original);
    parse(await run(prepare("windows-second")));
    const active = JSON.parse(await readFile(path.join(root, ".agentic-core/quality/active-task.json"), "utf8"));
    assert.equal(active.task.id, "windows-second");
    for (const file of ["verification.json", "mutation.json"])
      await assert.rejects(lstat(path.join(root, ".agentic-core/quality", file)), { code: "ENOENT" });
    assert.equal(await readFile(output, "utf8"), saved);
    assert.equal(await hashDirectory(path.join(root, "work dir")), consumerBefore);
    const beforeUpdate = await hashDirectory(root);
    assert.equal((await maintenance(["update", "--dry-run"])).status, "ready");
    assert.equal(await hashDirectory(root), beforeUpdate);
    assert.equal((await maintenance(["update"])).status, "updated");
    assert.equal((await maintenance(["doctor"])).status, "healthy");
    assert.equal((await maintenance(["update", "--dry-run"])).plan.actions.length, 0);
    assert.equal(await readFile(path.join(root, ".agentic-core/config.json"), "utf8"), configBefore);
    const beforeUninstall = await hashDirectory(root);
    await maintenance(["uninstall", "--dry-run"]);
    assert.equal(await hashDirectory(root), beforeUninstall);
    assert.equal((await maintenance(["uninstall"])).exitCode, 0);
    await assert.rejects(lstat(path.join(root, ".agentic-core/runtime")), { code: "ENOENT" });
    assert.equal(await readFile(output, "utf8"), saved);
    assert.equal(await readFile(marker, "utf8"), "contenido ajeno conservado\n");
    assert.equal(await hashDirectory(path.join(root, ".venv")), environmentBefore);
    assert.equal(await hashDirectory(second.root), secondBefore);
    assert.equal(await hashDirectory(path.join(root, "work dir")), consumerBefore);
    const consumer = await execute(python, ["wrapper space.py", "argument with spaces & literal",
      "-c", "config space.ini", "python checks"], {
      cwd: path.join(root, "work dir"), encoding: "utf8", windowsHide: true,
      env: { ...process.env, AGENTIC_CORE_PYTHON: python, PROJECT_SETTING: "required value",
        PYTHONDONTWRITEBYTECODE: "1", ACCEPTANCE_COUNTER: counter },
    });
    assert.match(consumer.stdout, /1 passed/u);
  } finally {
    await rename(hidden, installed);
  }
  t.diagnostic(`Paquete SHA-256 ${sha256}; Windows ${process.arch}; Node ${process.version}; Python del proyecto ${python.split(path.sep).at(-1)}; host Codex NO_VERIFICADO`);
});
