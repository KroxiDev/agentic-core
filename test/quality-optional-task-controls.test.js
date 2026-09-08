import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pythonProject, runPythonProject, configurePythonProject } from "./support/python-project.mjs";

const execute = promisify(execFile);
const source = "work dir/src/subject.py";
const chosen = "work dir/python checks/check_subject.py";
const active = ".agentic-core/quality/active-task.json";

for (const mode of ["light", "normal"]) {
  test(`installed ${mode} task closes without optional engines and preserves its start`, async (t) => {
    const { root } = await pythonProject(t);
    const invoke = async (args) => {
      const result = await runPythonProject(root, args);
      return { ...JSON.parse(result.stdout), processCode: result.code };
    };
    const initialSource = `${await readFile(path.join(root, source), "utf8")}\n# preexisting\n`;
    await writeFile(path.join(root, source), initialSource);
    const beforeConfig = await readFile(path.join(root, ".agentic-core/config.json"));
    if (mode === "light") await rename(path.join(root, ".agentic-core/tools"), path.join(root, ".agentic-core/unavailable-tools"));
    const prepared = await invoke(["prepare", "--task", "optional", "--mode", mode, "--objective", "issue:89"]);
    assert.equal(prepared.processCode, 0, JSON.stringify(prepared));
    const initial = await readFile(path.join(root, active));
    const saved = JSON.parse(initial).task;
    assert.deepEqual(saved.requiredControls, []);
    assert.equal(Buffer.from(saved.initial.sources.find((entry) => entry.path === source).content, "base64").toString(), initialSource);
    assert.equal(saved.initial.result.suite.executed.length, 1);
    assert.equal(saved.initial.quality.dry.executed, false);
    assert.equal(saved.initial.quality.crap.executed, false);
    assert.equal(saved.initial.quality.mutation.executed, false);
    // Exercise update with an active task: its bytes must survive runtime/resource replacement.
    if (mode === "normal") {
      const update = await execute(process.execPath, [path.resolve("bin/agentic-core.js"), "update", root],
        { cwd: root, windowsHide: true, timeout: 120000 });
      assert.match(update.stdout, /ACTUALIZ|updated|COMPLETADA/i);
      assert.deepEqual(await readFile(path.join(root, active)), initial);
    }
    if (mode === "normal") await rename(path.join(root, ".agentic-core/tools"), path.join(root, ".agentic-core/unavailable-tools"));
    // Optional tools are not a functional condition when no engine is required.
    const emptyDelta = await invoke(["test", "--changes"]);
    assert.equal(emptyDelta.code, "delta_without_code");
    assert.equal(emptyDelta.suite?.executed, undefined);
    const invalid = await invoke(["verify", "--control", "unknown"]);
    assert.equal(invalid.processCode, 4);
    const foreign = path.join(root, ".agentic-core/quality/foreign.json");
    await writeFile(foreign, "foreign evidence\n");
    await writeFile(path.join(root, source), `${initialSource}\n# task change\n`);
    const continued = await invoke(["prepare", "--task", "optional"]);
    assert.equal(continued.processCode, 0, JSON.stringify(continued));
    assert.deepEqual(await readFile(path.join(root, active)), initial);
    assert.equal(await readFile(foreign, "utf8"), "foreign evidence\n");
    const delta = await invoke(["test", "--changes", "--test", chosen]);
    assert.equal(delta.processCode, 0, JSON.stringify(delta));
    assert.deepEqual(delta.taskDelta.changed, [source]);
    assert.deepEqual(delta.selection.measuredFiles, [source]);
    assert.deepEqual(delta.suite.executed.map((item) => item.path), [chosen]);
    const verified = await invoke(["verify", "--changes", "--test", chosen]);
    assert.equal(verified.processCode, 0, JSON.stringify(verified));
    assert.match(verified.receipt, /QUALITY_OK.*dry=NO_SOLICITADO crap=NO_SOLICITADO mutation=NO_SOLICITADO/);
    for (const control of ["dry", "crap", "mutation"]) {
      assert.equal(verified.verification[control].executed, false);
      await assert.rejects(access(path.join(root, `.agentic-core/quality/${control}.json`)), { code: "ENOENT" });
    }
    const explanation = await invoke(["explain", "--json"]);
    assert.equal(explanation.processCode, 0, JSON.stringify(explanation));
    assert.equal(explanation.evidence.current, true);
    assert.deepEqual(explanation.causes, []);
    const reused = await invoke(["verify", "--changes", "--test", chosen]);
    assert.equal(reused.reused, true, JSON.stringify(reused));
    const explicit = await invoke(["verify", "--control", "dry", "--control", "crap", "--control", "mutation"]);
    assert.equal(explicit.processCode, 2, JSON.stringify(explicit));
    assert.equal(explicit.code, "task_comparison_pending");
    assert.doesNotMatch(explicit.receipt, /QUALITY_OK/);
    const reset = await invoke(["verify"]);
    assert.equal(reset.processCode, 0, JSON.stringify(reset));
    assert.equal(reset.reused, undefined);
    assert.deepEqual(reset.verification.request.requiredControls, []);
    assert.deepEqual(await readFile(path.join(root, ".agentic-core/config.json")), beforeConfig);
    await writeFile(path.join(root, source), initialSource.replace("return 'positive'", "return 'broken'"));
    const failure = await invoke(["verify"]);
    assert.equal(failure.processCode, 1, JSON.stringify(failure));
    assert.equal(failure.result.suite.failed, 1);
    assert.doesNotMatch(failure.receipt, /QUALITY_OK/);
    await configurePythonProject(root, (config) => config.integration.python.command.args.push("--collect-only"));
    const unexecuted = await invoke(["verify"]);
    assert.notEqual(unexecuted.processCode, 0);
    assert.deepEqual(unexecuted.result.suite.executed, []);
    assert.doesNotMatch(unexecuted.receipt, /QUALITY_OK/);
    assert.deepEqual(await readFile(path.join(root, active)), initial);
    if (mode === "normal") {
      await writeFile(path.join(root, ".agentic-core/config.json"), beforeConfig);
      await writeFile(path.join(root, source), initialSource);
      const next = await invoke(["prepare", "--task", "explicit", "--mode", mode,
        "--objective", "issue:89", "--control", "dry"]);
      assert.equal(next.processCode, 0, JSON.stringify(next));
      assert.deepEqual(next.task.requiredControls, ["dry"]);
      const pending = await invoke(["verify"]);
      assert.equal(pending.code, "task_comparison_pending");
      assert.equal(pending.verification.dry.required, true);
      const without = await invoke(["verify", "--control", "none"]);
      assert.equal(without.processCode, 0, JSON.stringify(without));
      assert.equal(without.verification.dry.status, "NO_SOLICITADO");
      assert.deepEqual(JSON.parse(await readFile(path.join(root, active))).task.requiredControls, ["dry"]);
    }
  });
}
