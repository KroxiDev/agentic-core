import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { hashDirectory } from "../src/transaction.js";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

const execute = promisify(execFile);

test("installed privacy exclusions cannot approve a reduced pytest suite", async (t) => {
  const { root } = await pythonProject(t);
  const failingTest = path.join(root, "work dir/python checks/check_failure.py");
  const body = "def test_failure():\n    assert False\n";
  await writeFile(failingTest, body);
  const control = await runPythonProject(root);
  assert.equal(control.code, 1, control.stdout + control.stderr);
  assert.equal(JSON.parse(control.stdout).suite.collected, 2);
  assert.equal(JSON.parse(control.stdout).suite.failed, 1);

  await writeFile(failingTest, "password = 'synthetic-only-value'\n" + body);
  const original = await hashDirectory(root);
  const result = await runPythonProject(root);
  const report = JSON.parse(result.stdout);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "input_checkpoint_incompatible");
  assert.ok(report.inputs.issues.some((issue) => issue.code === "private_executable_input"));
  assert.doesNotMatch(result.stdout + result.stderr, /check_failure|synthetic-only-value/u);
  assert.equal(await hashDirectory(root), original);
});

test("installed test and doctor exclude unquoted credentials and numeric personal data", async (t) => {
  const { root } = await pythonProject(t);
  const cwd = path.join(root, "work dir");
  await mkdir(path.join(cwd, "fixtures"));
  for (const [file, content] of Object.entries({
    "connection.yaml": "api_key: synthetic-only-value\n",
    "person.json": '{"dni":12345678}',
    "cases.json": '{"answer":42}',
  })) await writeFile(path.join(cwd, "fixtures", file), content);
  await writeFile(path.join(cwd, "python checks/check_resources.py"), `import json
from pathlib import Path

def test_resources():
    assert not Path('fixtures/connection.yaml').exists()
    assert not Path('fixtures/person.json').exists()
    assert json.loads(Path('fixtures/cases.json').read_text())['answer'] == 42
`);
  await configurePythonProject(root, (config) => {
    config.integration.python.inputs.includeIgnored = ["work dir/fixtures/connection.yaml", "work dir/fixtures/person.json"];
  });
  const original = await hashDirectory(root);
  const result = await runPythonProject(root);
  const report = JSON.parse(result.stdout);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(report.suite.collected, 2);
  assert.equal(report.inputs.exclusions.private >= 2, true);
  const diagnostic = await execute(process.execPath,
    [path.join(root, ".agentic-core/runtime-launcher.mjs"), "agentic-core", "doctor"],
    { cwd: root, windowsHide: true, env: { ...process.env, AGENTIC_CORE_OUTPUT: "json" } });
  assert.deepEqual(JSON.parse(diagnostic.stdout).integration.inputs.inventory, report.inputs.inventory);
  assert.doesNotMatch(result.stdout + result.stderr + diagnostic.stdout + diagnostic.stderr,
    /connection\.yaml|person\.json|synthetic-only-value|12345678/u);
  assert.equal(await hashDirectory(root), original);
});

test("installed command evidence hides compound credential options without changing execution", async (t) => {
  const { root, config } = await pythonProject(t);
  await writeFile(path.join(root, "work dir/sensitive wrapper.py"), `import argparse, os, subprocess
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--access-token')
parser.add_argument('--client-secret')
supplied, remaining = parser.parse_known_args()
assert supplied.access_token == os.environ['EXPECTED_ACCESS']
assert supplied.client_secret == os.environ['EXPECTED_CLIENT']
Path('prepared.txt').write_text(remaining[0])
raise SystemExit(subprocess.call([os.environ['AGENTIC_CORE_PYTHON'], '-m', 'pytest', *remaining[1:]]))
`);
  for (const options of [
    ["--access-token", "synthetic-access", "--client-secret=synthetic-client"],
    ["--access-token=synthetic-access", "--client-secret", "synthetic-client"],
  ]) {
    await t.test(options[0], async () => {
      await configurePythonProject(root, (current) => {
        current.integration.python.environment.EXPECTED_ACCESS = "synthetic-access";
        current.integration.python.environment.EXPECTED_CLIENT = "synthetic-client";
        current.integration.python.command.args = ["sensitive wrapper.py", ...options, ...config.integration.python.command.args.slice(1)];
      });
      const original = await hashDirectory(root);
      const result = await runPythonProject(root);
      const report = JSON.parse(result.stdout);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(report.suite.collected, 1);
      assert.deepEqual(report.effectiveCommand.args,
        ["sensitive wrapper.py", ...options.map(() => "[privado]"), ...config.integration.python.command.args.slice(1)]);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-access|synthetic-client/u);
      assert.equal(await hashDirectory(root), original);
    });
  }
});
