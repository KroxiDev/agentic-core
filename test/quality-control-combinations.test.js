import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pythonProject, runPythonProject } from "./support/python-project.mjs";

test("installed and updated consumer combines only requested controls with compatible reuse", async (t) => {
  const { root } = await pythonProject(t);
  const agents = path.join(root, "AGENTS.md");
  await writeFile(agents, `Consumer instruction preserved.\n${await readFile(agents, "utf8")}`);
  const foreign = path.join(root, ".agentic-core/consumer-note.txt");
  await writeFile(foreign, "consumer-owned\n");
  await promisify(execFile)(process.execPath, [path.resolve("bin/agentic-core.js"), "update", root],
    { cwd: root, windowsHide: true, timeout: 120000 });
  assert.match(await readFile(agents, "utf8"), /^Consumer instruction preserved\./);
  assert.equal(await readFile(foreign, "utf8"), "consumer-owned\n");
  const invoke = async (...args) => {
    const result = await runPythonProject(root, args);
    return { ...JSON.parse(result.stdout), processCode: result.code };
  };
  const prepared = await invoke("prepare", "--task", "combined", "--mode", "direct", "--objective", "issue:93");
  assert.equal(prepared.processCode, 0, JSON.stringify(prepared));
  const active = path.join(root, ".agentic-core/quality/active-task.json");
  const initial = await readFile(active);
  const source = "work dir/src/subject.py";
  await writeFile(path.join(root, source), `${await readFile(path.join(root, source), "utf8")}\n# implementation\n`);
  const scope = ["--scope", source, "--test", "work dir/python checks/check_subject.py"];
  const dry = await invoke("verify", "--control", "dry", ...scope);
  assert.equal(dry.processCode, 0, JSON.stringify(dry));
  const combined = await invoke("verify", "--control", "dry", "--control", "crap", ...scope);
  assert.equal(combined.processCode, 0, JSON.stringify(combined));
  assert.equal(combined.verification.reuse.tests.reused, true);
  assert.equal(combined.verification.reuse.dry.reused, true);
  assert.equal(combined.verification.reuse.crap.reused, false);
  assert.equal(combined.verification.mutation.executed, false);
  assert.match(combined.receipt, /selection=[a-f0-9]{64}/);
  const all = await invoke("verify", "--control", "dry", "--control", "crap", "--control", "mutation", ...scope);
  assert.equal(all.processCode, 0, JSON.stringify(all));
  assert.equal(all.verification.reuse.dry.reused, true);
  assert.equal(all.verification.reuse.crap.reused, true);
  assert.equal(all.verification.mutation.status, "NO_APLICA");
  const justMutation = await invoke("verify", "--control", "mutation", ...scope);
  assert.equal(justMutation.processCode, 0, JSON.stringify(justMutation));
  assert.equal(justMutation.verification.reuse.mutation.reused, true);
  for (const name of ["dry", "crap"]) {
    assert.equal(justMutation.verification[name].status, "NO_SOLICITADO");
    assert.equal(justMutation.verification[name].executed, false);
  }
  const changed = await invoke("verify", "--control", "dry", "--control", "crap", "--scope", "work dir/src");
  assert.equal(changed.processCode, 0, JSON.stringify(changed));
  assert.equal(changed.verification.reuse.tests.reused, false);
  assert.deepEqual(await readFile(active), initial);
  const none = await invoke("verify", "--control", "none", "--scope", "work dir/src");
  assert.equal(none.processCode, 0, JSON.stringify(none));
  assert.equal(none.reused, true);
  assert.deepEqual(none.verification.request.requiredControls, []);
});
