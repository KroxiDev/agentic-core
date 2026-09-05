import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

test("installed pytest requires observed test execution, preserving the authoritative options", async (t) => {
  const { root, config } = await pythonProject(t);
  const cwd = path.join(root, "work dir");
  const iniPath = path.join(cwd, "config space.ini");
  const originalIni = await readFile(iniPath, "utf8");
  const setupMarker = path.join(cwd, "pytest-setup-ran.txt");
  const bodyMarker = path.join(cwd, "declared-suite-ran.txt");
  const fixtures = `import pytest
from pathlib import Path
from src.subject import classify

@pytest.fixture(autouse=True)
def prepare_subject():
    Path('pytest-setup-ran.txt').write_text('setup')
    assert classify(0) == 'other'
`;

  t.beforeEach(async () => {
    await rm(setupMarker, { force: true });
    await rm(bodyMarker, { force: true });
    await writeFile(iniPath, originalIni);
    await writeFile(path.join(cwd, "conftest.py"), fixtures);
    await configurePythonProject(root, (c) => { c.integration.python = structuredClone(config.integration.python); });
  });

  for (const option of ["--collect-only", "--setup-only"]) {
    for (const source of ["arguments", "configuration", "PYTEST_ADDOPTS"]) {
      await t.test(`${option} from ${source} cannot approve without running test bodies`, async () => {
        const configured = await configurePythonProject(root, (c) => {
          if (source === "arguments") c.integration.python.command.args.push(option);
        });
        if (source === "configuration") await writeFile(iniPath, originalIni.replace("addopts = -q", `addopts = -q ${option}`));
        const result = await runPythonProject(root, ["test"], { PYTEST_ADDOPTS: source === "PYTEST_ADDOPTS" ? option : "" });
        const report = JSON.parse(result.stdout);

        await assert.rejects(access(bodyMarker), { code: "ENOENT" });
        if (option === "--setup-only") assert.equal(await readFile(setupMarker, "utf8"), "setup");
        else await assert.rejects(access(setupMarker), { code: "ENOENT" });
        assert.equal(report.suite.exitCode, 0);
        assert.equal(report.suite.collected, 1);
        assert.equal(report.coverage.status, "measured");
        assert.ok(Object.keys(report.coverage.files).length > 0, "imports or fixtures still produce coverage");
        assert.deepEqual(report.effectiveCommand.args, configured.integration.python.command.args);
        assert.equal(result.code, 2, JSON.stringify({ status: report.status, code: report.code, suite: report.suite, coverage: report.coverage.status }));
        assert.equal(report.status, "NO_VERIFICADO");
        assert.equal(report.code, "tests_not_executed");
        assert.equal(report.suite.status, "not_executed");
        assert.deepEqual(report.suite.phases, option === "--collect-only"
          ? { setup: 0, call: 0, teardown: 0 } : { setup: 1, call: 0, teardown: 1 });
      });
    }
  }

  for (const overrideOptions of [false, true]) {
    await t.test(overrideOptions ? "effective project behavior overrides declared non-execution options" : "real execution remains approved", async () => {
      if (overrideOptions) {
        await writeFile(path.join(cwd, "conftest.py"), `${fixtures}\ndef pytest_configure(config):\n    config.option.collectonly = False\n    config.option.setuponly = False\n`);
      }
      const result = await runPythonProject(root, ["test"], { PYTEST_ADDOPTS: overrideOptions ? "--collect-only --setup-only" : "" });
      const report = JSON.parse(result.stdout);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(report.status, "approved");
      assert.equal(report.code, "tests_passed");
      assert.equal(report.suite.status, "passed");
      assert.equal(await readFile(bodyMarker, "utf8"), "declared");
      assert.equal(await readFile(setupMarker, "utf8"), "setup");
      assert.deepEqual(report.effectiveCommand.args, config.integration.python.command.args);
    });
  }
});
