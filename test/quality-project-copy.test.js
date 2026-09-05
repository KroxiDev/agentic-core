import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { hashDirectory } from "../src/transaction.js";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

const execute = promisify(execFile);

test("installed verification consumes real resources and a helper in the copy, preserving the original", async (t) => {
  const { root, config } = await pythonProject(t);
  const cwd = path.join(root, "work dir");
  for (const directory of ["fixtures", "src/data", "src/cache", "credentials", "private"]) await mkdir(path.join(cwd, directory), { recursive: true });
  const resources = {
    "fixtures/cases.json": '[{"value":1,"expected":"positive"},{"value":0,"expected":"other"}]',
    "fixtures/query.sql": "select 42;", "fixtures/message.template": "result={result}",
    "fixtures/options.ini": "[fixture]\nflag=required\n",
    "src/data/Resource.py": "VALUE = 42\n", "src/cache/helper.py": "def render(template, result):\n    return template.format(result=result)\n",
    ".env.synthetic": "SYNTHETIC_SECRET_ONLY=never-copy", "credentials/synthetic.json": '{"password":"synthetic-only"}',
    "private/synthetic-person.txt": "synthetic.person@example.invalid",
  };
  for (const [file, content] of Object.entries(resources)) await writeFile(path.join(cwd, file), content);
  const resourceTests = `
import json
from pathlib import Path
from src.subject import classify
from src.data.Resource import VALUE
from src.cache.helper import render

def test_real_resources():
    for row in json.loads(Path('fixtures/cases.json').read_text()):
        assert classify(row['value']) == row['expected']
    assert Path('fixtures/query.sql').read_text() == 'select 42;'
    assert render(Path('fixtures/message.template').read_text(), VALUE) == 'result=42'
    assert 'flag=required' in Path('fixtures/options.ini').read_text()
    assert not Path('.env.synthetic').exists()
    assert not Path('credentials').exists()
    assert not Path('private').exists()
`;
  await writeFile(path.join(cwd, "python checks/check_resources.py"), resourceTests);
  const original = await hashDirectory(root);
  const result = await runPythonProject(root);
  const report = JSON.parse(result.stdout);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(report.suite.collected, 2);
  assert.equal(report.integrity.status, "preserved");
  assert.equal(report.integrity.dependencies, "preserved");
  assert.equal(await hashDirectory(root), original);
  for (const file of ["fixtures/cases.json", "fixtures/query.sql", "fixtures/message.template", "fixtures/options.ini", "src/data/Resource.py", "src/cache/helper.py"]) {
    assert.ok(report.inputs.inventory.some((entry) => entry.path === `work dir/${file}`), file);
  }
  assert.ok(report.coverage.files["work dir/src/data/Resource.py"]);
  assert.ok(report.coverage.files["work dir/src/cache/helper.py"]);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic|credentials|person@|never-copy/u);
  assert.ok(!result.stdout.includes(root) && !result.stdout.includes(root.replaceAll("\\", "/")));
  const diagnostic = await execute(process.execPath,
    [path.join(root, ".agentic-core/runtime-launcher.mjs"), "agentic-core", "doctor"],
    { cwd: root, windowsHide: true, env: { ...process.env, AGENTIC_CORE_OUTPUT: "json" } });
  const doctor = JSON.parse(diagnostic.stdout);
  assert.deepEqual(doctor.integration.inputs.inventory, report.inputs.inventory);
  assert.doesNotMatch(diagnostic.stdout + diagnostic.stderr, /synthetic|credentials|person@|never-copy/u);
  assert.ok(!diagnostic.stdout.includes(root));
  assert.equal(await hashDirectory(root), original, "doctor must not run tests or change the original");

  await t.test("absolute project arguments map to the same input without changing the suite", async () => {
    await configurePythonProject(root, (c) => { c.integration.python.command.args[0] = path.join(cwd, "wrapper space.py"); });
    const mapped = await runPythonProject(root);
    assert.equal(mapped.code, 0, mapped.stdout);
    assert.equal(JSON.parse(mapped.stdout).effectiveCommand.args[0], "work dir/wrapper space.py");
    assert.equal(JSON.parse(mapped.stdout).suite.collected, 2);
    await configurePythonProject(root, (c) => { c.integration.python.command.args = config.integration.python.command.args; });
  });

  await t.test("protected copy writes retain suite and coverage evidence without a false approval", async () => {
    await writeFile(path.join(cwd, "python checks/check_zz_integrity.py"), "from pathlib import Path\ndef test_write():\n    Path('fixtures/options.ini').write_text('unexpected')\n");
    const before = await hashDirectory(root);
    const changed = await runPythonProject(root);
    const partial = JSON.parse(changed.stdout);
    assert.equal(changed.code, 2, changed.stdout);
    assert.equal(partial.status, "NO_VERIFICADO");
    assert.equal(partial.code, "input_integrity_changed");
    assert.equal(partial.suite.status, "passed");
    assert.equal(partial.coverage.status, "measured");
    assert.equal(partial.integrity.phase, "tests");
    assert.deepEqual(partial.integrity.copy, ["work dir/fixtures/options.ini"]);
    assert.deepEqual(partial.integrity.original, []);
    assert.equal(await hashDirectory(root), before);
    await writeFile(path.join(cwd, "python checks/check_zz_integrity.py"), "def test_ok():\n    assert True\n");
  });

  await t.test("an external wrapper is not substituted or executed against the original", async () => {
    await configurePythonProject(root, (c) => { c.integration.python.command.args[0] = path.join(path.dirname(root), "external private wrapper.py"); });
    const unsupported = await runPythonProject(root);
    assert.equal(unsupported.code, 2, unsupported.stdout);
    assert.equal(JSON.parse(unsupported.stdout).code, "isolation_unsupported");
    assert.doesNotMatch(unsupported.stdout, /external private wrapper/u);
    await assert.rejects(access(path.join(cwd, "declared-suite-ran.txt")), { code: "ENOENT" });
    await configurePythonProject(root, (c) => { c.integration.python.command.args = config.integration.python.command.args; });
  });

  await t.test("a timeout after pytest preserves the completed suite and coverage", async () => {
    const wrapper = await readFile(path.join(cwd, "wrapper space.py"), "utf8");
    await writeFile(path.join(cwd, "after-pytest.py"), wrapper.replace("raise SystemExit(subprocess.call(", "result = subprocess.call(")
      .replace("*sys.argv[2:]]))", "*sys.argv[2:]])\nimport time\ntime.sleep(20)\nraise SystemExit(result)"));
    await configurePythonProject(root, (c) => { c.integration.python.command.args[0] = "after-pytest.py"; c.limits.operation.commandTimeoutMs = 4000; });
    const timedOut = await runPythonProject(root);
    const partial = JSON.parse(timedOut.stdout);
    assert.equal(timedOut.code, 6, timedOut.stdout);
    assert.equal(partial.code, "command_timeout");
    assert.equal(partial.suite.status, "passed");
    assert.equal(partial.coverage.status, "measured");
    assert.equal(partial.integrity.status, "preserved");
    await configurePythonProject(root, (c) => { c.integration.python.command.args = config.integration.python.command.args; c.limits.operation.commandTimeoutMs = config.limits.operation.commandTimeoutMs; });
  });

  await t.test("writes to original inputs are detected and never restored over concurrent work", async () => {
    // Deliberately hostile synthetic wrapper. Real consumer code is never used here.
    const target = path.join(cwd, "fixtures/options.ini");
    const wrapper = await readFile(path.join(cwd, "wrapper space.py"), "utf8");
    await writeFile(path.join(cwd, "wrapper space.py"), `from pathlib import Path\nPath(${JSON.stringify(target)}).write_text('concurrent change')\n${wrapper}`);
    const changed = await runPythonProject(root);
    const partial = JSON.parse(changed.stdout);
    assert.equal(changed.code, 2, changed.stdout);
    assert.equal(partial.code, "input_integrity_changed");
    assert.equal(partial.suite.status, "passed");
    assert.deepEqual(partial.integrity.original, ["work dir/fixtures/options.ini"]);
    assert.equal(partial.integrity.restored, false);
    assert.equal(await readFile(target, "utf8"), "concurrent change");
  });
});
