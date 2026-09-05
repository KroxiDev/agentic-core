import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createTestProject } from "../project-builder.js";
import { defaultConfiguration } from "../../src/installation/config.js";
import { privatePython } from "../../src/installation/python.js";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../..");

export async function runPythonProject(root, args = ["test"], extraEnv = {}) {
  const env = { ...process.env, AGENTIC_CORE_OUTPUT: "json", ...extraEnv };
  if (!Object.hasOwn(extraEnv, "AGENTIC_CORE_PYTHON")) delete env.AGENTIC_CORE_PYTHON;
  try {
    return { ...await execute(process.execPath, [path.join(root, ".agentic-core/runtime-launcher.mjs"), "agentic-quality", ...args],
      { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 60000 }), code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

export async function configurePythonProject(root, update) {
  const configPath = path.join(root, ".agentic-core/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  update(config);
  await writeFile(configPath, JSON.stringify(config));
  return config;
}

export async function pythonProject(t) {
  const root = await createTestProject(t, { files: {
    "work dir/src/subject.py": "def classify(value):\n    if value > 0:\n        return 'positive'\n    return 'other'\n",
    "work dir/config space.ini": "[pytest]\npythonpath = .\npython_files = check_*.py\naddopts = -q\n",
    "work dir/python checks/check_subject.py": `import os, sys, time
from pathlib import Path
from project_only_dependency import VALUE
from src.subject import classify

def test_real_suite():
    assert VALUE == 'project environment'
    assert Path('prepared.txt').read_text() == 'argument with spaces & literal'
    assert os.environ['PROJECT_SETTING'] == 'required value'
    assert Path(sys.prefix).name == '.venv'
    time.sleep(float(os.environ.get('SUITE_DELAY', '0')))
    assert classify(1) == 'positive'
    assert classify(0) == 'other'
    Path('declared-suite-ran.txt').write_text('declared')
`,
    "work dir/tests/test_fallback.py": "raise AssertionError('The substituted suite must never run')\n",
    "work dir/wrapper space.py": `import os, subprocess, sys
from pathlib import Path
Path('prepared.txt').write_text(sys.argv[1])
raise SystemExit(subprocess.call([os.environ['AGENTIC_CORE_PYTHON'], '-m', 'pytest', *sys.argv[2:]]))
`,
  } });
  await execute("python", ["-m", "venv", "--without-pip", path.join(root, ".venv")], { cwd: root, windowsHide: true });
  const python = privatePython(path.join(root, ".venv"));
  // Copy the test host's pytest dependencies into a genuinely separate, pip-free venv.
  // No layer dependency is installed into the consumer, and no test depends on a network.
  await execute("python", ["-c", `import importlib.util, pathlib, shutil, sys
target = pathlib.Path(sys.argv[1])
for name in ['pytest', '_pytest', 'pluggy', 'packaging', 'iniconfig', 'pygments', 'colorama', 'py']:
    spec = importlib.util.find_spec(name)
    if spec is None:
        if name == 'colorama' and sys.platform != 'win32': continue
        raise RuntimeError('Test host requires ' + name)
    source = pathlib.Path(spec.origin)
    if spec.submodule_search_locations:
        shutil.copytree(source.parent, target / source.parent.name)
    else:
        shutil.copy2(source, target / source.name)
(target / 'project_only_dependency.py').write_text("VALUE = 'project environment'\\n")
`, process.platform === "win32" ? path.join(root, ".venv/Lib/site-packages") :
    (await execute(python, ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], { encoding: "utf8" })).stdout.trim()],
  { cwd: root, windowsHide: true });
  const config = defaultConfiguration(python);
  config.integration.python.cwd = "work dir";
  config.integration.python.scope = ["work dir/src"];
  config.integration.python.environment = { PROJECT_SETTING: "required value", PYTHONDONTWRITEBYTECODE: "1" };
  config.integration.python.command = { executable: python,
    args: ["wrapper space.py", "argument with spaces & literal", "-c", "config space.ini", "python checks"] };
  await writeFile(path.join(root, "settings.json"), JSON.stringify(config));
  const result = await execute(process.execPath, [path.join(repository, "bin/agentic-core.js"), "init", root, "--config", path.join(root, "settings.json")],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120000, env: { ...process.env, AGENTIC_CORE_PYTHON: python } });
  assert.match(result.stdout, /INSTALACIÓN COMPLETADA/u);
  const hostPython = (await execute("python", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" })).stdout.trim();
  return { root, python, hostPython, config };
}
