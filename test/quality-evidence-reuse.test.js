import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { pythonProject, runPythonProject } from "./support/python-project.mjs";
import { runTaskQualityCli } from "../src/quality/task-baseline.js";

const prepare = (id = "first", mode = "normal") => [
  "prepare", "--task", id, "--mode", mode, "--objective", "issue:47",
];
const parse = (result) => JSON.parse(result.stdout);

test("task publication preserves a concurrent task after the transaction snapshot", async (t) => {
  const { root } = await pythonProject(t);
  assert.equal((await runPythonProject(root, prepare())).code, 0);
  const activePath = path.join(root, ".agentic-core/quality/active-task.json");
  const external = JSON.parse(await readFile(activePath, "utf8"));
  external.task.id = "external";
  external.sha256 = createHash("sha256").update(JSON.stringify(external.task)).digest("hex");
  const foreign = JSON.stringify(external);
  const originalRead = fs.readFile;
  const cwd = process.cwd();
  let injected = false;
  try {
    // Interleave an external writer after the transaction has read its snapshot.
    fs.readFile = async (file, ...args) => {
      const content = await originalRead(file, ...args);
      if (!injected && path.resolve(String(file)) === activePath && args.length === 0) {
        await writeFile(activePath, foreign);
        injected = true;
      }
      return content;
    };
    syncBuiltinESMExports();
    process.chdir(root);
    let stdout = "";
    const exitCode = await runTaskQualityCli(prepare("second"), {
      env: { AGENTIC_CORE_OUTPUT: "json" }, stdout: { write: (value) => { stdout += value; } },
    });
    assert.equal(injected, true);
    assert.equal(exitCode, 2, stdout);
    assert.equal(JSON.parse(stdout).code, "task_evidence_cleanup_failed");
    assert.equal(await originalRead(activePath, "utf8"), foreign);
  } finally {
    fs.readFile = originalRead;
    syncBuiltinESMExports();
    process.chdir(cwd);
  }
});

async function countedProject(t) {
  const project = await pythonProject(t);
  // Sibling files are outside the project's input inventory and copied suite.
  const counter = `${project.root}-calls.txt`;
  const trigger = `${project.root}-replace.txt`;
  t.after(async () => {
    await rm(counter, { force: true });
    await rm(trigger, { force: true });
  });
  const wrapper = path.join(project.root, "work dir/wrapper space.py");
  const original = await readFile(wrapper, "utf8");
  await writeFile(wrapper, `import os\nfrom pathlib import Path
counter = Path(os.environ['REUSE_COUNTER'])
counter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else '1')
trigger = Path(os.environ['REUSE_TRIGGER'])
if trigger.exists():
    target = Path(os.environ['REUSE_RESOLUTIONS'])
    target.unlink()
    if trigger.read_text() == 'directory':
        target.mkdir()
        (target / 'foreign.txt').write_text('foreign content')
    else:
        target.write_text('foreign content')
${original}`);
  const resolutions = path.join(project.root, ".agentic-core/quality/dry-resolutions.json");
  const env = { REUSE_COUNTER: counter, REUSE_TRIGGER: trigger, REUSE_RESOLUTIONS: resolutions };
  return { ...project, trigger, resolutions,
    run: (args) => runPythonProject(project.root, args, env),
    count: async () => Number(await readFile(counter, "utf8")),
  };
}

for (const replacement of ["content", "directory"]) {
  test(`new task preserves evidence replaced with foreign ${replacement} during capture`, async (t) => {
    const project = await countedProject(t);
    assert.equal((await project.run(prepare())).code, 0);
    assert.equal((await project.run(["verify"])).code, 0);
    const activePath = path.join(project.root, ".agentic-core/quality/active-task.json");
    const verdictPath = path.join(project.root, ".agentic-core/quality/verification.json");
    const active = await readFile(activePath, "utf8");
    const verdict = await readFile(verdictPath, "utf8");
    await writeFile(project.resolutions, JSON.stringify({ schemaVersion: 1, resolutions: [] }));
    await writeFile(project.trigger, replacement);
    const result = await project.run(prepare("second"));
    assert.equal(parse(result).code, "task_evidence_cleanup_failed", result.stdout + result.stderr);
    assert.equal(await readFile(activePath, "utf8"), active);
    assert.equal(await readFile(verdictPath, "utf8"), verdict);
    const foreign = replacement === "directory" ? path.join(project.resolutions, "foreign.txt") : project.resolutions;
    assert.equal(await readFile(foreign, "utf8"), "foreign content");
  });
}

test("same task rejects incompatible metadata without recapturing its baseline", async (t) => {
  const project = await countedProject(t);
  assert.equal((await project.run(prepare())).code, 0);
  const activePath = path.join(project.root, ".agentic-core/quality/active-task.json");
  const baseline = await readFile(activePath, "utf8");
  for (const metadata of [
    ["--objective", "issue:47 changed wording"],
    ["--mode", "full"],
    ["--repair-test", "work dir/python checks/check_subject.py"],
  ]) {
    const args = prepare();
    const index = args.indexOf(metadata[0]);
    if (index >= 0) args[index + 1] = metadata[1];
    else args.push(...metadata);
    const result = await project.run(args);
    assert.equal(parse(result).code, "task_metadata_conflict", result.stdout + result.stderr);
    assert.equal(await readFile(activePath, "utf8"), baseline);
    assert.equal(await project.count(), 1);
  }
  assert.equal(parse(await project.run(["prepare"])).reused, true);
});

for (const mode of ["normal", "full"]) {
  test(`${mode} reuses independent controls when only DRY resolutions change`, async (t) => {
    const project = await countedProject(t);
    assert.equal((await project.run(prepare("first", mode))).code, 0);
    const initial = parse(await project.run(["verify"]));
    assert.equal(initial.verification.tests.status, "approved");
    assert.equal(await project.count(), 2);
    const repeated = parse(await project.run(["verify"]));
    assert.equal(await project.count(), 2);
    await writeFile(project.resolutions, JSON.stringify({ schemaVersion: 1, resolutions: [] }));
    const changed = parse(await project.run(["verify"]));
    assert.equal(await project.count(), 2);
    assert.equal(repeated.verification.reuse.tests.reused, true);
    assert.equal(repeated.verification.reuse.dry.reused, true);
    assert.equal(repeated.verification.reuse.crap.reused, true);
    assert.equal(changed.verification.reuse.tests.reused, true);
    assert.equal(changed.verification.reuse.crap.reused, true);
    assert.deepEqual(changed.verification.reuse.dry, { reused: false, reason: "dry_resolutions_changed" });
    if (mode === "full") {
      assert.equal(changed.status, "NO_VERIFICADO");
      assert.equal(changed.code, "mutation_not_integrated");
      assert.doesNotMatch(changed.receipt, /QUALITY_OK/u);
    }
    await writeFile(project.resolutions, "invalid JSON");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const partial = parse(await project.run(["verify"]));
      assert.equal(partial.status, "NO_VERIFICADO");
      assert.equal(partial.verification.dry.code, "dry_resolution_invalid");
      assert.equal(partial.verification.reuse.tests.reused, true);
      assert.equal(partial.verification.reuse.crap.reused, true);
      assert.equal(partial.verification.reuse.dry.reused, false);
      assert.equal(await project.count(), 2);
    }
    await writeFile(project.resolutions, JSON.stringify({ schemaVersion: 1, resolutions: [] }));
    const recovered = parse(await project.run(["verify"]));
    assert.equal(recovered.verification.dry.status, "approved");
    assert.equal(recovered.verification.reuse.dry.reason, "control_pending");
    assert.equal(await project.count(), 2);
    const subject = path.join(project.root, "work dir/src/subject.py");
    await writeFile(subject, `${await readFile(subject, "utf8")}\n# changed input\n`);
    const sourceChanged = parse(await project.run(["verify"]));
    assert.equal(await project.count(), 3);
    for (const control of ["tests", "dry", "crap"]) {
      assert.deepEqual(sourceChanged.verification.reuse[control], { reused: false, reason: "quality_inputs_changed" });
    }
  });
}
