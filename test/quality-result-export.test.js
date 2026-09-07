import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderQualityResult } from "../src/quality/result-export.js";
import { inputHash } from "../src/quality/project-inputs.js";
import { pythonProject, runPythonProject } from "./support/python-project.mjs";

const parse = (result) => JSON.parse(result.stdout);
const prepare = (id) => ["prepare", "--task", id, "--mode", "light", "--objective", "issue:55"];
const evidence = (markdown) => JSON.parse(markdown.match(/```json\n([\s\S]*?)\n```/u)[1]);

test("requested Markdown preserves partial results, causes, locations and limits without source or private output", () => {
  const report = {
    task: { id: "example", mode: "full", objective: "issue:55", scope: ["src"] },
    status: "NO_VERIFICADO", code: "command_timeout",
    controls: { tests: { status: "approved" }, mutation: { status: "NO_VERIFICADO", code: "command_timeout" } },
    tests: { status: "approved", suite: { status: "passed", collected: 1, phases: { call: 1 } },
      stdout: "private process output", environment: { VALUE: "hidden environment" } },
    dry: { status: "approved", candidates: [{ id: "pair", left: { file: "src/a.py", startLine: 2 },
      right: { file: "src/b.py", startLine: 4 }, resolution: { reason: "access_token=do-not-export" } }] },
    crap: { status: "rejected", limit: 7, details: [{ file: "src/a.py", line: 2, value: 9, threshold: 7,
      status: "rejected", rule: "new_symbol_at_or_below_seven", source: "private source" }] },
    mutation: { status: "NO_VERIFICADO", code: "command_timeout", required: true, executed: true,
      score: { detected: 1, denominator: 2, threshold: 80, inconclusive: 1 },
      details: [{ id: "m1", file: "C:\\private\\a.py", status: "timeout", replacement: "private replacement" }] },
  };
  const markdown = renderQualityResult(report, "a".repeat(64));
  const saved = evidence(markdown);
  assert.equal(saved.status, "NO_VERIFICADO");
  assert.equal(saved.tests.suite.phases.call, 1);
  assert.equal(saved.crap.details[0].value, 9);
  assert.equal(saved.crap.limit, 7);
  assert.equal(saved.mutation.score.inconclusive, 1);
  assert.equal(saved.dry.candidates[0].left.file, "src/a.py");
  assert.doesNotMatch(markdown, /do-not-export|private process|hidden environment|private source|private replacement|C:\\/u);
  assert.match(markdown, /no es una nueva verificación/u);
  for (const status of ["approved", "rejected", "NO_APLICA"]) {
    assert.equal(evidence(renderQualityResult({ ...report, status }, "hash")).status, status);
  }
});

test("installed export is explicit, survives the next task, and only prepares remote delivery", async (t) => {
  const { root } = await pythonProject(t);
  const counter = `${root}-export-calls.txt`;
  t.after(() => rm(counter, { force: true }));
  const wrapper = path.join(root, "work dir/wrapper space.py");
  await writeFile(wrapper, `import os\nfrom pathlib import Path\ncounter = Path(os.environ['EXPORT_CALL_COUNTER'])\ncounter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else '1')\n${await readFile(wrapper, "utf8")}`);
  const run = (args, env) => runPythonProject(root, args, { EXPORT_CALL_COUNTER: counter, ...env });
  const initialFiles = await readdir(root);
  assert.equal(parse(await run(["export", "--stdout"])).code, "task_missing");
  assert.equal((await run(prepare("first"))).code, 0);
  assert.equal(parse(await run(["export", "--stdout"])).code, "export_result_missing");
  const verified = parse(await run(["verify"]));
  assert.equal(verified.status, "approved");
  assert.equal(verified.verification.tests.suite.phases.call, 1);
  assert.equal(await readFile(counter, "utf8"), "2");
  assert.deepEqual(await readdir(root), initialFiles, "prepare and verify must not create a user export");
  const internal = path.join(root, ".agentic-core/quality/verification.json");
  const before = await readFile(internal, "utf8");
  const output = path.join(root, "resultado solicitado.md");
  const saved = parse(await run(["export", "--output", output]));
  assert.equal(saved.status, "saved");
  const markdown = await readFile(output, "utf8");
  assert.equal(inputHash(markdown), saved.sha256);
  assert.equal(evidence(markdown).task.id, "first");
  assert.equal(evidence(markdown).tests.suite.phases.call, 1);
  assert.equal(await readFile(internal, "utf8"), before, "export must not run or update verification");

  const prepared = parse(await run(["export", "--stdout"]));
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.markdown, markdown);
  assert.equal(prepared.destination, undefined);
  assert.match(prepared.message, /no se ha guardado ni publicado/u);
  assert.equal((await run(["export", "--stdout"], { AGENTIC_CORE_OUTPUT: "text" })).stdout, markdown);
  assert.equal(await readFile(counter, "utf8"), "2", "export must not execute the suite again");

  for (const [args, code] of [
    [[], "invalid_usage"],
    [["--stdout", "--output", output], "invalid_usage"],
    [["--output", output], "export_destination_exists"],
    [["--output", ".agentic-core/quality/export.md"], "export_destination_invalid"],
    [["--output", "missing-directory/result.md"], "export_write_failed"],
  ]) {
    const failure = parse(await run(["export", ...args]));
    assert.equal(failure.code, code);
    assert.equal(failure.status, "NO_VERIFICADO");
  }
  assert.equal(await readFile(output, "utf8"), markdown);
  const instructions = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(instructions, /Esta petición no activa al Documentador/u);
  assert.match(instructions, /respuesta y referencia comprobables del host/u);

  await writeFile(internal, "corrupt evidence");
  assert.equal(parse(await run(["export", "--stdout"])).code, "quality_report_conflict");
  await writeFile(internal, before);
  assert.equal((await run(prepare("second"))).code, 0);
  await assert.rejects(readFile(internal), { code: "ENOENT" });
  assert.equal(await readFile(output, "utf8"), markdown);
  assert.equal(parse(await run(["export", "--stdout"])).code, "export_result_missing");
});
