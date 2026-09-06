import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configurePythonProject, pythonProject, runPythonProject } from "./support/python-project.mjs";

async function crap(root) {
  const result = await runPythonProject(root, ["crap"]);
  assert.equal(result.stderr, "");
  return { ...result, report: JSON.parse(result.stdout) };
}

test("installed crap4py uses authoritative coverage, the configured boundary and reproducible identities", async (t) => {
  const { root } = await pythonProject(t);
  const file = path.join(root, "work dir/src/subject.py");
  const original = await readFile(file);
  const first = await crap(root);
  assert.equal(first.code, 0, first.stdout);
  assert.equal(first.report.status, "approved");
  assert.equal(first.report.engine.version, "0.1.1");
  assert.equal(first.report.execution.suite.status, "passed");
  const row = first.report.details.find((entry) => entry.name === "classify");
  assert.equal(row.complexity, 2);
  assert.equal(row.coverage.fraction, 1);
  assert.equal(row.value, 2);
  assert.equal(row.limit, 7);
  assert.equal(first.report.details.length, 1, "function-only declarations are not scored twice as a module");
  assert.ok(!first.stdout.includes(root));
  const repeated = await crap(root);
  assert.deepEqual(repeated.report.details, first.report.details);
  assert.equal(repeated.report.identity, first.report.identity);
  await configurePythonProject(root, (config) => { config.limits.crap = 2; });
  assert.equal((await crap(root)).code, 0, "a value at the configured limit is accepted");
  await configurePythonProject(root, (config) => { config.limits.crap = 1.5; });
  const strict = await crap(root);
  assert.equal(strict.code, 1, strict.stdout);
  assert.equal(strict.report.details[0].limit, 1.5);
  assert.notEqual(strict.report.identity, first.report.identity);
  const human = await runPythonProject(root, ["crap"], { AGENTIC_CORE_OUTPUT: "text" });
  assert.equal(human.code, 1);
  assert.match(human.stdout, /work dir\/src\/subject.py:1 classify: 2; límite 1.5/u);
  assert.match(human.stdout, /Informe íntegro: \.agentic-core\/quality\/crap.json/u);
  assert.ok(human.stdout.split("\n").length <= 5);
  const saved = await readFile(path.join(root, strict.report.reference));
  await configurePythonProject(root, (config) => { config.limits.crap = -1; });
  const invalid = await crap(root);
  assert.equal(invalid.code, 4);
  assert.equal(invalid.report.code, "invalid_configuration");
  assert.deepEqual(await readFile(path.join(root, strict.report.reference)), saved);
  assert.deepEqual(await readFile(file), original);
});

test("installed C.R.A.P. preserves zero coverage and supported metrics without approving unloaded or unsupported parts", async (t) => {
  const { root } = await pythonProject(t);
  const subject = path.join(root, "work dir/src/subject.py");
  await writeFile(subject, `${await readFile(subject, "utf8")}\ndef uncovered(value):\n    if value > 0:\n        return 1\n    if value < 0:\n        return -1\n    return 0\n\ndef branchless():\n    return 42\n\nasync def asynchronous(values):\n    async for value in values:\n        if value:\n            return 1\n    return 0\n`);
  const zero = await crap(root);
  assert.equal(zero.code, 1, zero.stdout);
  const uncovered = zero.report.details.find((row) => row.name === "uncovered");
  assert.equal(uncovered.coverage.status, "zero");
  assert.equal(uncovered.coverage.fraction, 0);
  assert.equal(uncovered.complexity, 3);
  assert.equal(uncovered.value, 12);
  const branchless = zero.report.details.find((row) => row.name === "branchless");
  assert.equal(branchless.coverage.fraction, 0);
  assert.equal(branchless.coverage.basis, "statements");
  assert.equal(branchless.value, 2, "absence of branches does not fabricate complete coverage");
  const asynchronous = zero.report.details.find((row) => row.name === "asynchronous");
  assert.equal(asynchronous.complexity, 3);
  assert.equal(asynchronous.coverage.fraction, 0);
  assert.equal(asynchronous.value, 12);
  await writeFile(path.join(root, "work dir/src/unloaded.py"), "def absent(value):\n    if value:\n        return 1\n    return 0\n");
  await writeFile(path.join(root, "work dir/src/bad.py"), "def broken(:\n    pass\n");
  await writeFile(path.join(root, "work dir/src/foreign.js"), "export const value = 1;\n");
  const partial = await crap(root);
  assert.equal(partial.code, 2, partial.stdout);
  assert.equal(partial.report.status, "NO_VERIFICADO");
  assert.equal(partial.report.details.find((row) => row.name === "classify").value, 2);
  assert.equal(partial.report.details.find((row) => row.name === "uncovered").value, 12);
  const absent = partial.report.details.find((row) => row.name === "absent");
  assert.equal(absent.code, "coverage_not_loaded");
  assert.equal(absent.value, null);
  assert.equal(absent.coverage.fraction, null);
  assert.equal(partial.report.details.find((row) => row.file.endsWith("bad.py")).code, "unsupported_syntax");
  assert.equal(partial.report.details.find((row) => row.file.endsWith("foreign.js")).code, "unsupported_language");
  assert.doesNotMatch(partial.stdout, /QUALITY_OK/);
  await configurePythonProject(root, (config) => { config.integration.python.scope = ["work dir/src/unloaded.py"]; });
  const unloadedScope = await crap(root);
  assert.equal(unloadedScope.code, 2, unloadedScope.stdout);
  assert.equal(unloadedScope.report.details[0].code, "coverage_not_loaded");
  assert.equal(unloadedScope.report.details[0].value, null);
  await configurePythonProject(root, (config) => { config.integration.python.scope = ["work dir/src"]; });
  const wrapper = path.join(root, "work dir/wrapper space.py");
  await writeFile(wrapper, (await readFile(wrapper, "utf8")).replace("raise SystemExit", "os.environ.pop('PYTEST_PLUGINS', None)\nraise SystemExit"));
  const unattributed = await crap(root);
  assert.equal(unattributed.code, 2, unattributed.stdout);
  assert.equal(unattributed.report.execution.code, "pytest_unobserved");
  assert.equal(unattributed.report.details.find((row) => row.name === "classify").code, "coverage_attribution_missing");
  assert.equal(unattributed.report.details.find((row) => row.name === "classify").value, null);
});

test("installed module ownership excludes function bodies and exposes analysis limitations", async (t) => {
  const { root } = await pythonProject(t);
  const subject = path.join(root, "work dir/src/subject.py");
  const source = await readFile(subject, "utf8");
  await writeFile(subject, `${source}\nvalues = [1, 2]\nif values:\n    selected = values[0]\nelse:\n    selected = 0\n`);
  const result = await crap(root);
  assert.equal(result.code, 0, result.stdout);
  const module = result.report.details.find((row) => row.kind === "module");
  const fn = result.report.details.find((row) => row.name === "classify");
  assert.equal(module.complexity, 2);
  assert.equal(module.coverage.fraction, 0.5);
  assert.equal(module.value, 2.5);
  assert.equal(fn.complexity, 2);
  assert.equal(fn.value, 2);
  assert.deepEqual(module.coverage.executedLines.filter((line) => fn.coverage.executedLines.includes(line)), []);
  await writeFile(subject, `${await readFile(subject, "utf8")}\ndeferred = lambda value: 1 if value else 0\n`);
  const limited = await crap(root);
  assert.equal(limited.code, 2, limited.stdout);
  assert.equal(limited.report.details.find((row) => row.kind === "module").code, "unsupported_construct");
  assert.equal(limited.report.details.find((row) => row.name === "classify").value, 2);
  await writeFile(path.join(root, limited.report.reference), "informe ajeno\n");
  const unsaved = await crap(root);
  assert.equal(unsaved.report.code, "quality_report_conflict");
  assert.equal(unsaved.report.details.find((row) => row.name === "classify").value, 2);
  assert.equal(unsaved.report.reference, undefined);
});

test("installed C.R.A.P. explains a documentation-only scope and preserves a foreign report", async (t) => {
  const { root } = await pythonProject(t);
  await writeFile(path.join(root, "guide.md"), "# Guía del proyecto\n");
  await configurePythonProject(root, (config) => { config.integration.python.scope = ["guide.md"]; });
  const result = await crap(root);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.status, "NO_APLICA");
  assert.equal(result.report.code, "no_executable_code");
  assert.deepEqual(result.report.details, []);
  const reportFile = path.join(root, result.report.reference);
  await writeFile(reportFile, "contenido ajeno\n");
  const conflict = await crap(root);
  assert.equal(conflict.code, 2);
  assert.equal(conflict.report.code, "quality_report_conflict");
  assert.equal(await readFile(reportFile, "utf8"), "contenido ajeno\n");
});

test("installed C.R.A.P. blocks unknown scoped languages while retaining Python and resource controls", async (t) => {
  const { root } = await pythonProject(t);
  const foreignFiles = ["policy.scala", "policy.unrecognized", "policy"];
  for (const file of foreignFiles) {
    await writeFile(path.join(root, "work dir/src", file),
      'object Policy { def classify(value: Int): String = if (value > 0) "positive" else "other" }\n');
  }
  await writeFile(path.join(root, "work dir/src/guide.md"), "# Guía del proyecto\n");
  await writeFile(path.join(root, "work dir/src/options.json"), '{"label":"example"}\n');
  const mixed = await crap(root);
  assert.equal(mixed.report.execution.suite.status, "passed");
  assert.equal(mixed.code, 2, mixed.stdout);
  assert.equal(mixed.report.status, "NO_VERIFICADO");
  assert.equal(mixed.report.details.find((row) => row.name === "classify").value, 2);
  for (const file of foreignFiles) {
    const row = mixed.report.details.find((entry) => entry.file.endsWith(`/${file}`));
    assert.equal(row.status, "NO_VERIFICADO");
    assert.equal(row.code, "unsupported_language");
    assert.equal(row.value, null);
  }
  assert.equal(mixed.report.details.length, 4, "known documents and data are inputs, not unsupported code");
  await configurePythonProject(root, (config) => { config.integration.python.scope = ["work dir/src/policy.scala"]; });
  const explicit = await crap(root);
  assert.equal(explicit.report.execution.suite.status, "passed");
  assert.equal(explicit.code, 2, explicit.stdout);
  assert.equal(explicit.report.status, "NO_VERIFICADO");
  assert.equal(explicit.report.details.length, 1);
  assert.equal(explicit.report.details[0].code, "unsupported_language");
  for (const file of foreignFiles) await rm(path.join(root, "work dir/src", file));
  await configurePythonProject(root, (config) => { config.integration.python.scope = ["work dir/src"]; });
  const supported = await crap(root);
  assert.equal(supported.code, 0, supported.stdout);
  assert.equal(supported.report.details.length, 1);
  await configurePythonProject(root, (config) => { config.integration.python.scope = ["work dir/src/guide.md", "work dir/src/options.json"]; });
  const resources = await crap(root);
  assert.equal(resources.code, 0, resources.stdout);
  assert.equal(resources.report.status, "NO_APLICA");
  assert.equal(resources.report.code, "no_executable_code");
});

test("installed C.R.A.P. reports executed annotations without losing bodies, defaults or decorators", async (t) => {
  const { root } = await pythonProject(t);
  const subject = path.join(root, "work dir/src/subject.py");
  const checks = path.join(root, "work dir/python checks/check_subject.py");
  const source = await readFile(subject, "utf8");
  const suite = await readFile(checks, "utf8");
  const expression = `${"int if len(()) == 0 else (".repeat(8)}str${")".repeat(8)}`;
  await writeFile(subject, source.replace("def classify(value):", `def classify(value: (${expression})):`));
  await writeFile(checks, `${suite}\n    assert classify.__annotations__["value"] is int\n`);
  const annotated = await crap(root);
  assert.equal(annotated.report.execution.suite.status, "passed", annotated.stdout);
  assert.equal(annotated.code, 2, annotated.stdout);
  assert.equal(annotated.report.status, "NO_VERIFICADO");
  const body = annotated.report.details.find((row) => row.kind === "function" && row.name === "classify");
  assert.equal(body.value, 2);
  assert.equal(body.coverage.fraction, 1);
  const annotation = annotated.report.details.find((row) => row.kind === "annotations");
  assert.equal(annotation.code, "annotation_coverage_unsupported");
  assert.equal(annotation.value, null, "line coverage cannot prove independent annotation coverage");
  assert.equal(annotation.coverage.fraction, null);
  assert.equal(annotation.evaluation, annotated.report.execution.python.version[1] >= 14 ? "deferred" : "eager");
  const repeated = await crap(root);
  assert.deepEqual(repeated.report.details, annotated.report.details);
  await writeFile(subject, source.replace("def classify(value):",
    `def classify(value: (${expression}), /, *args: int, key: int = None, **kwargs: int) -> int:`));
  await writeFile(checks, `${suite}\n    assert classify.__annotations__ == dict.fromkeys(['value', 'args', 'key', 'kwargs', 'return'], int)\n`);
  const allAnnotations = await crap(root);
  assert.equal(allAnnotations.report.execution.suite.status, "passed", allAnnotations.stdout);
  assert.equal(allAnnotations.code, 2, allAnnotations.stdout);
  assert.notEqual(allAnnotations.report.details.find((row) => row.kind === "annotations").fingerprint, annotation.fingerprint);
  assert.equal(allAnnotations.report.details.find((row) => row.name === "classify").value, 2);
  await writeFile(subject, source.replace("def classify(value):", `def classify(value = (${expression})):`));
  await writeFile(checks, suite);
  const defaults = await crap(root);
  assert.equal(defaults.code, 1, defaults.stdout);
  assert.equal(defaults.report.details.find((row) => row.kind === "module").complexity, 9);
  assert.equal(defaults.report.details.find((row) => row.kind === "module").value, 9);
  assert.equal(defaults.report.details.find((row) => row.name === "classify").value, 2);
  const decorator = `${"identity if len(()) == 0 else (".repeat(8)}identity${")".repeat(8)}`;
  await writeFile(subject, `def identity(function):\n    return function\n\n@(${decorator})\n${source}`);
  const decorated = await crap(root);
  assert.equal(decorated.code, 1, decorated.stdout);
  assert.equal(decorated.report.details.find((row) => row.kind === "module").complexity, 9);
  assert.equal(decorated.report.details.find((row) => row.kind === "module").value, 9);
  assert.equal(decorated.report.details.find((row) => row.name === "classify").value, 2);
});

test("installed annotation limitations distinguish stringized and unobserved evaluation", async (t) => {
  const { root } = await pythonProject(t);
  const subject = path.join(root, "work dir/src/subject.py");
  const checks = path.join(root, "work dir/python checks/check_subject.py");
  await writeFile(subject, `from __future__ import annotations\n${(await readFile(subject, "utf8"))
    .replace("def classify(value):", "def classify(value: (int if len(()) == 0 else str)) -> int:")}`);
  await writeFile(checks, `${await readFile(checks, "utf8")}\n    from typing import get_type_hints\n    assert isinstance(classify.__annotations__["value"], str)\n    assert get_type_hints(classify)["value"] is int\n`);
  const stringized = await crap(root);
  assert.equal(stringized.report.execution.suite.status, "passed", stringized.stdout);
  assert.equal(stringized.code, 2, stringized.stdout);
  assert.equal(stringized.report.details.find((row) => row.kind === "annotations").evaluation, "stringized");
  assert.equal(stringized.report.details.find((row) => row.name === "classify").value, 2);
  const wrapper = path.join(root, "work dir/wrapper space.py");
  await writeFile(wrapper, (await readFile(wrapper, "utf8"))
    .replace("raise SystemExit", "os.environ.pop('PYTEST_PLUGINS', None)\nraise SystemExit"));
  const unobserved = await crap(root);
  assert.equal(unobserved.code, 2, unobserved.stdout);
  assert.equal(unobserved.report.execution.code, "pytest_unobserved");
  const annotation = unobserved.report.details.find((row) => row.kind === "annotations");
  assert.equal(annotation.evaluation, "unknown", "the private interpreter cannot replace the unobserved project version");
  assert.equal(annotation.code, "annotation_coverage_unsupported");
  assert.equal(annotation.value, null);
  assert.equal(annotation.coverage.fraction, null);
});
