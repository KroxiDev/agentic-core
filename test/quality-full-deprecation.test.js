import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pythonProject, runPythonProject } from "./support/python-project.mjs";

async function contents(directory) {
  const files = await readdir(directory, { recursive: true, withFileTypes: true });
  return Object.fromEntries(await Promise.all(files.filter((file) => file.isFile()).map(async (file) => {
    const absolute = path.join(file.parentPath, file.name);
    return [path.relative(directory, absolute), (await readFile(absolute)).toString("base64")];
  })));
}

test("installed update preserves historical Full evidence and rejects execution before writes", async (t) => {
  const { root } = await pythonProject(t);
  const invoke = async (...args) => {
    const result = await runPythonProject(root, args);
    return { ...JSON.parse(result.stdout), processCode: result.code };
  };
  const rejected = await invoke("prepare", "--task", "retired", "--mode", "full", "--objective", "issue:94");
  assert.equal(rejected.code, "full_deprecated", JSON.stringify(rejected));
  assert.equal(rejected.processCode, 4);
  assert.match(JSON.stringify(rejected), /archive\/full/);
  const prepared = await invoke("prepare", "--task", "historical", "--mode", "normal", "--objective", "issue:94");
  assert.equal(prepared.processCode, 0, JSON.stringify(prepared));
  // Model the historical schema without executing the archived Full runtime.
  const active = path.join(root, ".agentic-core/quality/active-task.json");
  const record = JSON.parse(await readFile(active, "utf8"));
  record.task.mode = "full";
  record.sha256 = createHash("sha256").update(JSON.stringify(record.task)).digest("hex");
  await writeFile(active, `${JSON.stringify(record)}\n`);
  const quality = path.dirname(active);
  const before = await contents(quality);
  await promisify(execFile)(process.execPath, [path.resolve("bin/agentic-core.js"), "update", root],
    { cwd: root, windowsHide: true, timeout: 120000 });
  assert.deepEqual(await contents(quality), before);
  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /Full devuelve su deprecacion/u);
  assert.doesNotMatch(agents, /Especificador|Arquitecto/);
  for (const args of [["verify"], ["baseline"], ["test"], ["dry"], ["crap"], ["mutate"],
    ["prepare", "--task", "replacement", "--mode", "normal", "--objective", "issue:94"]]) {
    const result = await invoke(...args);
    assert.equal(result.code, "full_deprecated", JSON.stringify(result));
    assert.equal(result.processCode, 4, JSON.stringify(result));
    assert.deepEqual(await contents(quality), before, args.join(" "));
  }
  const explained = await invoke("explain");
  assert.match(JSON.stringify(explained), /full_deprecated/);
  assert.deepEqual(await contents(quality), before);
  const doctor = await promisify(execFile)(process.execPath, [path.resolve("bin/agentic-core.js"), "doctor", root],
    { cwd: root, windowsHide: true, timeout: 120000, env: { ...process.env, AGENTIC_CORE_OUTPUT: "json" } });
  const diagnostic = JSON.parse(doctor.stdout);
  assert.ok(diagnostic.report.diagnosis.checks.some((check) => check.id === "full.deprecated"));
  assert.deepEqual(await contents(quality), before);
});
