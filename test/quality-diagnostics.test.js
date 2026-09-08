import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pythonProject, runPythonProject, configurePythonProject } from "./support/python-project.mjs";
import { runExplainCli } from "../src/quality/diagnostics.js";

test("installed diagnosis explains current, stale and corrupt evidence without invoking the suite", async (t) => {
  const { root } = await pythonProject(t);
  const counter = `${root}-invocations.txt`;
  t.after(() => rm(counter, { force: true }));
  const wrapper = path.join(root, "work dir/wrapper space.py");
  await writeFile(wrapper, `import os\nfrom pathlib import Path\np = Path(os.environ['DIAGNOSTIC_COUNTER'])\np.write_text(str(int(p.read_text()) + 1) if p.exists() else '1')\n${await readFile(wrapper, "utf8")}`);
  await writeFile(path.join(root, ".env"), "API_KEY=synthetic-private-value");
  await writeFile(path.join(root, "work dir/private-input.txt"), "password=synthetic-private-value");
  const resource = path.join(root, "work dir/notes.txt");
  await writeFile(resource, "public notes\n");
  const env = { DIAGNOSTIC_COUNTER: counter };
  const run = (args, extra = {}) => runPythonProject(root, args, { ...env, ...extra });
  const count = async () => Number(await readFile(counter, "utf8"));
  const missing = await run(["explain", "--json"]);
  assert.equal(missing.code, 4, missing.stdout + missing.stderr);
  assert.equal(JSON.parse(missing.stdout).code, "task_missing");
  assert.equal((await run(["prepare", "--task", "diagnosis", "--mode", "normal", "--objective", "issue:56"])).code, 0);
  const verified = await run(["verify"]);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  assert.equal(await count(), 2);
  const reportPath = path.join(root, ".agentic-core/quality/verification.json");
  const activePath = path.join(root, ".agentic-core/quality/active-task.json");
  const report = await readFile(reportPath, "utf8");
  const active = await readFile(activePath, "utf8");
  const budgetPath = path.join(root, ".agentic-core/quality/budget.json");
  const budget = await readFile(budgetPath, "utf8");
  const explained = await run(["explain", "--json"], { AGENTIC_CORE_OUTPUT: "" });
  const data = JSON.parse(explained.stdout);
  assert.equal(explained.code, verified.code, explained.stdout);
  assert.equal(data.status, JSON.parse(verified.stdout).status);
  assert.equal(data.evidence.current, true);
  assert.equal(data.testsExecuted, false);
  for (const name of ["dry", "crap", "mutation"]) {
    assert.equal(data.controls[name].status, "NO_SOLICITADO");
    assert.ok(!data.causes.some((item) => item.control === name));
  }
  assert.equal(data.integration.command.args[0], "wrapper space.py");
  assert.equal(data.limits.crap, 7);
  assert.ok(data.inputs.exclusions.private >= 2);
  const pipe = await run(["explain"], { AGENTIC_CORE_OUTPUT: "" });
  assert.match(pipe.stdout, /Informe completo: node \.agentic-core\/runtime-launcher.mjs agentic-quality explain --json/);
  assert.ok(pipe.stdout.split("\n").length < 20);
  assert.doesNotMatch(pipe.stdout, /^\{/);
  for (const output of [explained.stdout, pipe.stdout]) {
    assert.ok(!output.includes(root));
    assert.doesNotMatch(output, /synthetic-private-value|private-input\.txt|API_KEY/);
  }
  // The terminal path uses the same public command with a TTY output surface.
  const previousCwd = process.cwd();
  const previousCounter = process.env.DIAGNOSTIC_COUNTER;
  let terminal = "";
  try {
    process.chdir(root);
    process.env.DIAGNOSTIC_COUNTER = counter;
    await runExplainCli([], { env: { AGENTIC_CORE_OUTPUT: "" }, stdout: { isTTY: true, write: (value) => { terminal += value; } } });
  } finally {
    process.chdir(previousCwd);
    if (previousCounter === undefined) delete process.env.DIAGNOSTIC_COUNTER;
    else process.env.DIAGNOSTIC_COUNTER = previousCounter;
  }
  assert.match(terminal, /diagnóstico sin ejecutar pruebas/);
  assert.match(terminal, /Informe completo: node \.agentic-core\/runtime-launcher.mjs agentic-quality explain --json/);
  const source = path.join(root, "work dir/src/subject.py");
  const original = await readFile(source, "utf8");
  await writeFile(source, `${original}\n# relevant input change\n`);
  const stale = JSON.parse((await run(["explain"])).stdout);
  assert.equal(stale.status, "NO_VERIFICADO");
  assert.equal(stale.code, "quality_inputs_changed");
  assert.equal(stale.evidence.current, false);
  assert.deepEqual(stale.changedInputs, ["work dir/src/subject.py"]);
  await rm(source);
  const removed = JSON.parse((await run(["explain", "--json"])).stdout);
  assert.equal(removed.status, "NO_VERIFICADO");
  assert.equal(removed.code, "quality_inputs_changed");
  assert.equal(removed.evidence.current, false);
  assert.deepEqual(removed.changedInputs, ["work dir/src/subject.py"]);
  assert.equal(removed.testsExecuted, false);
  assert.equal(await count(), 2);
  await writeFile(source, original);
  await writeFile(resource, "password=synthetic-private-value");
  const newlyPrivate = await run(["explain", "--json"]);
  assert.equal(JSON.parse(newlyPrivate.stdout).status, "NO_VERIFICADO");
  assert.deepEqual(JSON.parse(newlyPrivate.stdout).changedInputs, []);
  assert.doesNotMatch(newlyPrivate.stdout, /notes\.txt|synthetic-private-value/);
  await writeFile(resource, "public notes\n");
  const configPath = path.join(root, ".agentic-core/config.json");
  const originalConfig = await readFile(configPath, "utf8");
  await configurePythonProject(root, (config) => { config.limits.crap = 8; });
  assert.equal(JSON.parse((await run(["explain"])).stdout).code, "quality_conditions_changed");
  await writeFile(configPath, originalConfig);
  await writeFile(reportPath, "corrupt");
  assert.equal(JSON.parse((await run(["explain"])).stdout).code, "quality_report_conflict");
  assert.equal(await readFile(reportPath, "utf8"), "corrupt");
  await writeFile(reportPath, report);
  await writeFile(activePath, "corrupt baseline");
  assert.equal(JSON.parse((await run(["explain"])).stdout).code, "task_evidence_invalid");
  assert.equal(await readFile(activePath, "utf8"), "corrupt baseline");
  await writeFile(activePath, active);
  assert.equal(await readFile(activePath, "utf8"), active);
  assert.equal(await readFile(budgetPath, "utf8"), budget);
  assert.equal(await count(), 2);
  await writeFile(source, original.replace("return 'positive'", "return 'broken'"));
  const rejected = await run(["verify"], { AGENTIC_CORE_OUTPUT: "" });
  assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stdout, /tests_failed:.*work dir\/python checks\/check_subject.py/);
  const diagnosis = await run(["explain"]);
  assert.equal(diagnosis.code, 1, diagnosis.stdout);
  assert.equal(JSON.parse(diagnosis.stdout).code, "tests_failed");
  assert.ok(JSON.parse(diagnosis.stdout).causes.some((item) => item.control === "tests"
    && item.file === "work dir/python checks/check_subject.py"));
  assert.equal(await count(), 3);
});

test("diagnosis preserves typed configuration and environment failures and redacts private arguments", async (t) => {
  const { root } = await pythonProject(t);
  const run = (args) => runPythonProject(root, args);
  const configPath = path.join(root, ".agentic-core/config.json");
  const original = await readFile(configPath, "utf8");
  await configurePythonProject(root, (config) => { config.limits['secret-key-value'] = true; });
  const unknown = await run(["explain"]);
  assert.equal(unknown.code, 4);
  const data = JSON.parse(unknown.stdout);
  assert.equal(data.code, "unknown_configuration_key");
  assert.equal(data.causes[0].location, "config.limits");
  assert.doesNotMatch(unknown.stdout, /secret-key-value/);
  await writeFile(configPath, original);
  await configurePythonProject(root, (config) => {
    config.integration.python.command.args.push("--access-token", "synthetic-sensitive-value");
    config.integration.python.command.args.push("--cache=C:\\private-customer\\records.json");
    config.integration.python.interpreter = "nonexistent-python-for-diagnosis";
  });
  const unavailable = await run(["explain"]);
  assert.equal(unavailable.code, 2, unavailable.stdout);
  assert.equal(JSON.parse(unavailable.stdout).code, "command_unavailable");
  assert.doesNotMatch(unavailable.stdout, /synthetic-sensitive-value/);
  assert.doesNotMatch(unavailable.stdout, /private-customer/);
  assert.equal((await run(["explain", "--unknown"])).code, 4);
});
