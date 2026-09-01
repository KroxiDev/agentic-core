import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { hashFileTree } from "../src/transaction.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const qualityCli = path.join(repositoryRoot, "bin", "agentic-quality.js");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agentic quality session "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`);
  await writeFile(path.join(root, "src", "subject.js"), `
export function classify(value) {
  return value > 0 ? "positive" : "other";
}
`);
  await writeFile(path.join(root, "test", "subject.test.js"), `
import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "../src/subject.js";
test("classifies both outcomes", () => {
  assert.equal(classify(1), "positive");
  assert.equal(classify(0), "other");
});
`);
  return root;
}

async function run(args, cwd, output = "human", extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, AGENTIC_CORE_OUTPUT: output };
  try {
    const result = await execFileAsync(process.execPath, [qualityCli, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

async function prepare(root, mode = "normal", scopes = ["src/subject.js"], output = "human") {
  const args = ["prepare", "--mode", mode];
  for (const scope of scopes) args.push("--scope", scope);
  const result = await run(args, root, output);
  if (output === "json") return { result, body: JSON.parse(result.stdout) };
  return { result, id: result.stdout.match(/id=(q_[a-f0-9]+)/)?.[1] };
}

async function recursiveFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await recursiveFiles(directory, child));
    else files.push(child.split(path.sep).join("/"));
  }
  return files.sort();
}

test("prepare creates one idempotent baseline session through the public CLI", async (t) => {
  const root = await fixture(t);

  const first = await run([
    "prepare", "--mode", "normal", "--scope", "src/subject.js",
  ], root);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.match(first.stdout, /^QUALITY_SESSION id=(q_[a-f0-9]+) mode=normal baseline=([a-f0-9]{64})\n$/);
  const [, sessionId] = first.stdout.match(/id=(q_[a-f0-9]+)/);

  const sessionRoot = path.join(root, ".agentic-core", "quality", sessionId);
  const session = JSON.parse(await readFile(path.join(sessionRoot, "session.json"), "utf8"));
  assert.equal(session.id, sessionId);
  assert.equal(session.mode, "normal");
  assert.deepEqual(session.scopes, ["src/subject.js"]);
  assert.equal(session.status, "prepared");

  const second = await run([
    "prepare", "--mode", "normal", "--scope", "src/subject.js",
  ], root);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(await readdir(path.join(root, ".agentic-core", "quality")), [sessionId]);
});

test("invalid prepare arguments return usage without partial quality state", async (t) => {
  const root = await fixture(t);
  const cases = [
    ["prepare", "--scope", "src/subject.js"],
    ["prepare", "--mode", "slow", "--scope", "src/subject.js"],
    ["prepare", "--mode", "normal"],
    ["prepare", "--mode", "normal", "--scope", "../outside.js"],
    ["prepare", "--mode", "normal", "--scope", path.resolve(root, "src/subject.js")],
    ["prepare", "--mode", "normal", "--scope", "src/subject.js", "{}"],
  ];

  for (const args of cases) {
    const result = await run(args, root);
    assert.equal(result.code, 4, `${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  await assert.rejects(readdir(path.join(root, ".agentic-core", "quality")), { code: "ENOENT" });
});

test("verify emits a short hashed receipt and records differential evidence", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root);
  assert.equal(prepared.result.code, 0, prepared.result.stderr || prepared.result.stdout);

  await writeFile(path.join(root, "src", "subject.js"), `
export function classify(value) {
  if (value > 0) return "positive";
  if (value === 0) return "zero";
  return "negative";
}
`);
  await writeFile(path.join(root, "test", "subject.test.js"), `
import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "../src/subject.js";
test("classifies all outcomes", () => {
  assert.equal(classify(1), "positive");
  assert.equal(classify(0), "zero");
  assert.equal(classify(-1), "negative");
});
`);

  const verified = await run(["verify", "--session", prepared.id], root);
  assert.equal(verified.code, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, new RegExp(
    `^QUALITY_OK session=${prepared.id} tests=approved crap_max=[^ ]+ mutation=not_applicable `
      + "report=(\\.agentic-core/quality/[^ ]+\\.json) sha256=([a-f0-9]{64})\\n$",
  ));
  const [, reportPath, expectedHash] = verified.stdout.match(/report=([^ ]+) sha256=([a-f0-9]{64})/);
  const content = await readFile(path.join(root, ...reportPath.split("/")));
  assert.equal(createHash("sha256").update(content).digest("hex"), expectedHash);
  const report = JSON.parse(content);
  assert.equal(report.status, "approved");
  assert.equal(report.tests.status, "approved");
  assert.equal(report.mutation.status, "not_applicable");
  assert.equal(report.mutation.executed, false);
  assert.deepEqual(report.changes.map(({ path: file }) => file), [
    "src/subject.js",
    "test/subject.test.js",
  ]);
  assert.equal(report.restoration.status, "approved");
});

test("prepare and verify generate JSON only when explicitly requested", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root, "light", ["src/subject.js"], "json");
  assert.equal(prepared.result.code, 0, prepared.result.stderr || prepared.result.stdout);
  assert.equal(prepared.body.command, "prepare");
  assert.equal(prepared.body.mode, "light");
  assert.match(prepared.body.id, /^q_[a-f0-9]{24}$/);

  const verified = await run(["verify", "--session", prepared.body.id], root, "json");
  assert.equal(verified.code, 0, verified.stderr || verified.stdout);
  const body = JSON.parse(verified.stdout);
  assert.equal(body.command, "verify");
  assert.equal(body.status, "approved");
  assert.equal(body.session, prepared.body.id);
  assert.equal(body.mutation, "not_applicable");
  assert.match(body.sha256, /^[a-f0-9]{64}$/);
});

test("full verify executes mutation testing and restores the worktree", async (t) => {
  const root = await fixture(t);
  const original = await readFile(path.join(root, "src", "subject.js"), "utf8");
  const prepared = await prepare(root, "full");
  assert.equal(prepared.result.code, 0, prepared.result.stderr || prepared.result.stdout);

  const verified = await run(["verify", "--session", prepared.id], root);
  assert.equal(verified.code, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, / mutation=approved /);
  assert.equal(await readFile(path.join(root, "src", "subject.js"), "utf8"), original);

  const [, reportPath] = verified.stdout.match(/report=([^ ]+)/);
  const report = JSON.parse(await readFile(path.join(root, ...reportPath.split("/")), "utf8"));
  assert.equal(report.mutation.executed, true);
  assert.equal(report.mutation.restoration.workingTreeUntouched, true);
  assert.equal(report.restoration.status, "approved");
});

test("prepare captures the existing safe worktree while excluding secrets, caches, and binary data", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "support"));
  await mkdir(path.join(root, "src", "Personal"));
  await mkdir(path.join(root, "src", ".cache"));
  await writeFile(path.join(root, "src", "preexisting.js"), "export const preexisting = 1;\n");
  await writeFile(path.join(root, "src", "untracked.js"), "export const untracked = 2;\n");
  await writeFile(path.join(root, "test", "existing-work.test.js"), `
import assert from "node:assert/strict";
import test from "node:test";
import { preexisting } from "../src/preexisting.js";
import { untracked } from "../src/untracked.js";
test("uses the preexisting inputs", () => {
  assert.equal(preexisting + untracked, 3);
});
`);
  await writeFile(path.join(root, "support", "helper.js"), "export const helper = 3;\n");
  await writeFile(path.join(root, "src", ".env"), "TOKEN=do-not-read\n");
  await writeFile(path.join(root, "src", "Personal", "profile.js"), "export const personal = true;\n");
  await writeFile(path.join(root, "src", ".cache", "cached.js"), "export const cached = true;\n");
  await writeFile(path.join(root, "src", "payload.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, "src", "disguised.js"), Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x00, 0xff]));
  await writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  const outsideBefore = await readFile(path.join(root, "support", "helper.js"));

  const prepared = await prepare(root, "normal", ["src"]);
  assert.equal(prepared.result.code, 0, prepared.result.stderr || prepared.result.stdout);
  const checkpointRoot = path.join(root, ".agentic-core", "quality", prepared.id, "checkpoint");
  const inventory = JSON.parse(await readFile(path.join(checkpointRoot, "inventory.json"), "utf8"));
  const paths = inventory.entries.map(({ path: file }) => file);
  assert.ok(paths.includes("src/preexisting.js"));
  assert.ok(paths.includes("src/untracked.js"));
  assert.ok(paths.includes("support/helper.js"));
  assert.ok(paths.includes("test/subject.test.js"));
  assert.ok(paths.includes("package.json"));
  assert.ok(paths.includes("package-lock.json"));
  assert.equal(paths.some((file) => /(?:\.env|Personal|\.cache|payload\.bin|disguised\.js)/i.test(file)), false);
  assert.equal(
    await readFile(path.join(checkpointRoot, "files", "src", "untracked.js"), "utf8"),
    "export const untracked = 2;\n",
  );
  assert.deepEqual(await readFile(path.join(root, "support", "helper.js")), outsideBefore);
  assert.equal((await recursiveFiles(path.join(root, ".agentic-core", "quality", prepared.id)))
    .some((file) => /(?:\.env|Personal|\.cache|payload\.bin|disguised\.js)/i.test(file)), false);
});

test("prepare accepts repeated directory and not-yet-existing file scopes", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root, "light", ["src", "future/new-module.js", "src"]);
  assert.equal(prepared.result.code, 0, prepared.result.stderr || prepared.result.stdout);
  const session = JSON.parse(await readFile(path.join(
    root, ".agentic-core", "quality", prepared.id, "session.json",
  ), "utf8"));
  assert.deepEqual(session.scopes, ["future/new-module.js", "src"]);
});

test("a failing baseline blocks prepare with exit code three and no partial session", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "test", "subject.test.js"), `
import test from "node:test";
test("fails", () => { throw new Error("expected baseline failure"); });
`);
  const result = await run([
    "prepare", "--mode", "normal", "--scope", "src/subject.js",
  ], root);
  assert.equal(result.code, 3, result.stderr || result.stdout);
  assert.match(result.stderr, /Test command failed/);
  await assert.rejects(readdir(path.join(root, ".agentic-core", "quality")), { code: "ENOENT" });
});

test("prepare revalidates the runner environment before reusing a session", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic python quality session "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "subject.py"), [
    "def identity(value):",
    "    return value",
    "",
  ].join("\n"));
  await writeFile(path.join(root, "test_subject.py"), [
    "import unittest",
    "from src.subject import identity",
    "",
    "class SubjectTests(unittest.TestCase):",
    "    def test_identity(self):",
    "        self.assertEqual(identity(7), 7)",
    "",
  ].join("\n"));
  const { stdout: executable } = await execFileAsync("python", [
    "-c", "import sys; print(sys.executable)",
  ], { encoding: "utf8" });
  const first = await run([
    "prepare", "--mode", "normal", "--scope", "src/subject.py",
  ], root, "human", { AGENTIC_CORE_PYTHON: executable.trim() });
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const firstId = first.stdout.match(/id=(q_[a-f0-9]{24})/)[1];
  const baseline = JSON.parse(await readFile(path.join(
    root, ".agentic-core", "quality", firstId, "baseline", "crap.json",
  ), "utf8"));
  assert.ok(baseline.inputInventory.commands.length > 0);
  assert.equal(path.resolve(baseline.inputInventory.commands[0].executable), path.resolve(executable.trim()));
  assert.deepEqual(baseline.inputInventory.commands[0].version, await execFileAsync(
    executable.trim(), ["-c", "import json,sys; print(json.dumps(list(sys.version_info[:3])))"],
    { encoding: "utf8" },
  ).then(({ stdout }) => JSON.parse(stdout.trim())));
  const repeated = await run([
    "prepare", "--mode", "normal", "--scope", "src/subject.py",
  ], root, "human", { AGENTIC_CORE_PYTHON: executable.trim() });
  assert.equal(repeated.code, 0, repeated.stderr || repeated.stdout);
  assert.equal(repeated.stdout, first.stdout);

  const second = await run([
    "prepare", "--mode", "normal", "--scope", "src/subject.py",
  ], root, "human", { AGENTIC_CORE_PYTHON: path.join(root, "missing-python") });
  assert.equal(second.code, 2, second.stderr || second.stdout);
  assert.match(second.stderr, /not attributable|unsupported/i);
  assert.deepEqual(await readdir(path.join(root, ".agentic-core", "quality")), [firstId]);
});

test("verify persists failed tests but never emits QUALITY_OK", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root);
  await writeFile(path.join(root, "test", "subject.test.js"), `
import test from "node:test";
test("fails", () => { throw new Error("expected verification failure"); });
`);
  const verified = await run(["verify", "--session", prepared.id], root);
  assert.equal(verified.code, 1, verified.stderr || verified.stdout);
  assert.doesNotMatch(verified.stdout, /QUALITY_OK/);
  assert.match(verified.stdout, /^QUALITY_FAILED /);
  const [, reportPath, expectedHash] = verified.stdout.match(/report=([^ ]+) sha256=([a-f0-9]{64})/);
  const content = await readFile(path.join(root, ...reportPath.split("/")));
  assert.equal(createHash("sha256").update(content).digest("hex"), expectedHash);
  const report = JSON.parse(content);
  assert.equal(report.status, "failed");
  assert.equal(report.tests.status, "failed");
  assert.equal(report.crap.status, "not_run");
});

test("verify rejects nonexistent, corrupt, and modified baseline sessions", async (t) => {
  const root = await fixture(t);
  const missing = await run(["verify", "--session", "q_000000000000000000000000"], root);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /not found/);

  const prepared = await prepare(root);
  const sessionRoot = path.join(root, ".agentic-core", "quality", prepared.id);
  await writeFile(path.join(sessionRoot, "baseline", "crap.json"), "{}\n");
  const modified = await run(["verify", "--session", prepared.id], root);
  assert.equal(modified.code, 4);
  assert.match(modified.stderr, /baseline is invalid|hash mismatch|integrity/i);
  await assert.rejects(readFile(path.join(sessionRoot, "reports", "latest.json")), { code: "ENOENT" });

  await writeFile(path.join(sessionRoot, "session.json"), "not json\n");
  const corrupt = await run(["verify", "--session", prepared.id], root);
  assert.equal(corrupt.code, 4);
  assert.match(corrupt.stderr, /corrupt/);
});

test("verify rejects a structurally invalid baseline even when all hashes were recomputed", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root);
  const sessionRoot = path.join(root, ".agentic-core", "quality", prepared.id);
  const sessionPath = path.join(sessionRoot, "session.json");
  const integrityPath = path.join(sessionRoot, "integrity.json");
  const baselinePath = path.join(sessionRoot, "baseline", "crap.json");
  const invalidBaseline = Buffer.from("{}\n");
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  session.baseline.sha256 = createHash("sha256").update(invalidBaseline).digest("hex");
  const sessionContent = Buffer.from(`${JSON.stringify(session, null, 2)}\n`);
  const integrity = JSON.parse(await readFile(integrityPath, "utf8"));
  const payload = await Promise.all(integrity.files.map(async (entry) => ({
    path: entry.path,
    content: entry.path === "baseline/crap.json"
      ? invalidBaseline
      : entry.path === "session.json"
        ? sessionContent
        : await readFile(path.join(sessionRoot, ...entry.path.split("/"))),
  })));
  integrity.files = payload.map((entry) => ({
    path: entry.path,
    sha256: createHash("sha256").update(entry.content).digest("hex"),
  }));
  integrity.payloadSha256 = hashFileTree(payload);
  await writeFile(baselinePath, invalidBaseline);
  await writeFile(sessionPath, sessionContent);
  await writeFile(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`);

  const verified = await run(["verify", "--session", prepared.id], root);
  assert.equal(verified.code, 4, verified.stderr || verified.stdout);
  assert.match(verified.stderr, /baseline.*invalid/i);
  await assert.rejects(readFile(path.join(sessionRoot, "reports", "latest.json")), { code: "ENOENT" });
});

test("verify rejects a reports junction instead of writing evidence outside the session", async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), "agentic quality outside reports "));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const prepared = await prepare(root);
  const reportsPath = path.join(root, ".agentic-core", "quality", prepared.id, "reports");
  await symlink(outside, reportsPath, "junction");

  const verified = await run(["verify", "--session", prepared.id], root);
  assert.equal(verified.code, 4, verified.stderr || verified.stdout);
  assert.match(verified.stderr, /symbolic link|reports path is unsafe/i);
  assert.deepEqual(await readdir(outside), []);
});

test("full mutation failure preserves only a safe isolated snapshot and leaves the worktree unchanged", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "Personal"));
  await mkdir(path.join(root, ".cache"));
  await writeFile(path.join(root, ".env"), "TOKEN=do-not-copy\n");
  await writeFile(path.join(root, "Personal", "profile.js"), "export const privateValue = true;\n");
  await writeFile(path.join(root, ".cache", "cached.js"), "export const cachedValue = true;\n");
  await writeFile(path.join(root, "private.db"), Buffer.from([1, 2, 3]));
  const original = await readFile(path.join(root, "src", "subject.js"));
  const prepared = await prepare(root, "full");

  const verified = await run(["verify", "--session", prepared.id], root, "human", {
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_FAIL_MUTANT_RESTORE: "1",
  });
  assert.equal(verified.code, 5, verified.stderr || verified.stdout);
  assert.doesNotMatch(verified.stdout, /QUALITY_OK/);
  assert.deepEqual(await readFile(path.join(root, "src", "subject.js")), original);
  const [, reportPath] = verified.stdout.match(/report=([^ ]+)/);
  const report = JSON.parse(await readFile(path.join(root, ...reportPath.split("/")), "utf8"));
  assert.equal(report.status, "restoration_failure");
  assert.equal(report.mutation.restoration.workingTreeUntouched, true);
  assert.equal(report.mutation.restoration.evidencePreserved, true);
  const evidencePath = report.mutation.restoration.evidencePath;
  const relativeEvidence = path.relative(
    path.join(root, ".agentic-core", "quality", prepared.id),
    evidencePath,
  );
  assert.equal(relativeEvidence.startsWith("..") || path.isAbsolute(relativeEvidence), false);
  assert.equal((await recursiveFiles(evidencePath))
    .some((file) => /(?:\.env|Personal|\.cache|private\.db)/i.test(file)), false);

  const recovered = await run(["verify", "--session", prepared.id], root);
  assert.equal(recovered.code, 0, recovered.stderr || recovered.stdout);
  assert.equal((await stat(evidencePath)).isDirectory(), true);
});

test("a verification cleanup failure persists restoration_failure and never emits QUALITY_OK", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root);
  const verified = await run(["verify", "--session", prepared.id], root, "human", {
    NODE_ENV: "test",
    AGENTIC_CORE_TEST_FAIL_QUALITY_CLEANUP: "1",
  });
  assert.equal(verified.code, 5, verified.stderr || verified.stdout);
  assert.doesNotMatch(verified.stdout, /QUALITY_OK/);
  assert.match(verified.stdout, /^QUALITY_FAILED /);
  const [, reportPath] = verified.stdout.match(/report=([^ ]+)/);
  const report = JSON.parse(await readFile(path.join(root, ...reportPath.split("/")), "utf8"));
  assert.equal(report.status, "restoration_failure");
  assert.equal(report.restoration.status, "failed");
  assert.match(report.restoration.error, /Injected quality work cleanup failure/);
  const latest = JSON.parse(await readFile(path.join(
    root, ".agentic-core", "quality", prepared.id, "reports", "latest.json",
  ), "utf8"));
  assert.equal(latest.status, "restoration_failure");
});

test("verify approves unchanged inherited CRAP debt but does not lower its baseline", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "src", "subject.js"), `
export function legacy(value) {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (value === 4) return 4;
  if (value === 5) return 5;
  if (value === 6) return 6;
  return 0;
}
`);
  await writeFile(path.join(root, "test", "subject.test.js"), `
import assert from "node:assert/strict";
import test from "node:test";
import { legacy } from "../src/subject.js";
test("loads legacy code", () => assert.equal(typeof legacy, "function"));
`);
  const prepared = await prepare(root);
  assert.equal(prepared.result.code, 0, prepared.result.stderr || prepared.result.stdout);
  const baseline = JSON.parse(await readFile(path.join(
    root, ".agentic-core", "quality", prepared.id, "baseline", "crap.json",
  ), "utf8"));
  const prior = baseline.details.find(({ symbol }) => symbol === "legacy");
  assert.ok(prior.crap > 7);

  const verified = await run(["verify", "--session", prepared.id], root);
  assert.equal(verified.code, 0, verified.stderr || verified.stdout);
  const [, reportPath] = verified.stdout.match(/report=([^ ]+)/);
  const report = JSON.parse(await readFile(path.join(root, ...reportPath.split("/")), "utf8"));
  const current = report.crap.details.find(({ symbol }) => symbol === "legacy");
  assert.equal(current.rule, "existing_above_seven_must_not_worsen");
  assert.equal(current.baseline.crap, prior.crap);
  assert.equal(current.delta, 0);
  assert.equal(current.status, "approved");
});

test("verify rejects regression of a symbol whose baseline was at or below seven", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root);
  await writeFile(path.join(root, "src", "subject.js"), `
export function classify(value) {
  if (value === 1) return "one";
  if (value === 2) return "two";
  if (value === 3) return "three";
  if (value === 4) return "four";
  if (value === 5) return "five";
  if (value === 6) return "six";
  if (value === 7) return "seven";
  if (value === 8) return "eight";
  return "other";
}
`);
  await writeFile(path.join(root, "test", "subject.test.js"), `
import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "../src/subject.js";
test("covers only the fallback", () => assert.equal(classify(99), "other"));
`);
  const verified = await run(["verify", "--session", prepared.id], root);
  assert.equal(verified.code, 1, verified.stderr || verified.stdout);
  assert.doesNotMatch(verified.stdout, /QUALITY_OK/);
  const [, reportPath] = verified.stdout.match(/report=([^ ]+)/);
  const report = JSON.parse(await readFile(path.join(root, ...reportPath.split("/")), "utf8"));
  const detail = report.crap.details.find(({ symbol }) => symbol === "classify");
  assert.equal(detail.rule, "existing_at_or_below_seven");
  assert.ok(detail.crap > 7);
  assert.equal(detail.status, "failed");
});

test("verify applies the at-most-seven rule to new symbols", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root);
  await writeFile(path.join(root, "src", "subject.js"), `
export function classify(value) {
  return value > 0 ? "positive" : "other";
}
export function added(value) {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (value === 4) return 4;
  if (value === 5) return 5;
  if (value === 6) return 6;
  return 0;
}
`);
  const verified = await run(["verify", "--session", prepared.id], root);
  assert.equal(verified.code, 1, verified.stderr || verified.stdout);
  const [, reportPath] = verified.stdout.match(/report=([^ ]+)/);
  const report = JSON.parse(await readFile(path.join(root, ...reportPath.split("/")), "utf8"));
  const added = report.crap.details.find(({ symbol }) => symbol === "added");
  assert.equal(added.rule, "new_symbol_at_or_below_seven");
  assert.equal(added.baseline.status, "new_symbol");
  assert.ok(added.crap > 7);
  assert.equal(added.status, "failed");
});

test("a later relevant change invalidates the previous receipt", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root);
  const first = await run(["verify", "--session", prepared.id], root);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const [, firstPath, firstHash] = first.stdout.match(/report=([^ ]+) sha256=([a-f0-9]{64})/);

  await writeFile(path.join(root, "test", "runner-evidence.test.js"), `
import assert from "node:assert/strict";
import test from "node:test";
test("additional runner evidence", () => assert.equal(2 + 2, 4));
`);
  const second = await run(["verify", "--session", prepared.id], root);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  const [, secondPath, secondHash] = second.stdout.match(/report=([^ ]+) sha256=([a-f0-9]{64})/);
  assert.notEqual(secondPath, firstPath);
  assert.notEqual(secondHash, firstHash);
  const latest = JSON.parse(await readFile(path.join(
    root, ".agentic-core", "quality", prepared.id, "reports", "latest.json",
  ), "utf8"));
  assert.equal(latest.report, secondPath.split(`${prepared.id}/`).at(-1));
  assert.equal(latest.sha256, secondHash);
  assert.notEqual(latest.sha256, firstHash);
  assert.ok(await readFile(path.join(root, ...firstPath.split("/"))));
  const secondReport = JSON.parse(await readFile(path.join(root, ...secondPath.split("/")), "utf8"));
  assert.deepEqual(secondReport.changes.find(({ path: file }) => file === "test/runner-evidence.test.js"), {
    path: "test/runner-evidence.test.js",
    kind: "test",
    change: "added",
    attribution: "evidence",
    before: null,
    after: secondReport.changes.find(({ path: file }) => file === "test/runner-evidence.test.js").after,
  });
});

test("verify reports changed support code outside scope without attributing or overwriting it", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "support"));
  const supportPath = path.join(root, "support", "helper.js");
  await writeFile(supportPath, "export const helper = 1;\n");
  const prepared = await prepare(root, "normal", ["src/subject.js"]);
  await writeFile(supportPath, "export const helper = 2;\n");

  const verified = await run(["verify", "--session", prepared.id], root);
  assert.equal(verified.code, 0, verified.stderr || verified.stdout);
  const [, reportPath] = verified.stdout.match(/report=([^ ]+)/);
  const report = JSON.parse(await readFile(path.join(root, ...reportPath.split("/")), "utf8"));
  assert.equal(report.changes.find(({ path: file }) => file === "support/helper.js").attribution, "outside_scope");
  assert.equal(await readFile(supportPath, "utf8"), "export const helper = 2;\n");
});

test("verify never overwrites a corrupt latest receipt", async (t) => {
  const root = await fixture(t);
  const prepared = await prepare(root);
  const first = await run(["verify", "--session", prepared.id], root);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const [, reportPath] = first.stdout.match(/report=([^ ]+)/);
  const reportBefore = await readFile(path.join(root, ...reportPath.split("/")));
  const latestPath = path.join(
    root, ".agentic-core", "quality", prepared.id, "reports", "latest.json",
  );
  await writeFile(latestPath, "{}\n");

  const second = await run(["verify", "--session", prepared.id], root);
  assert.equal(second.code, 4, second.stderr || second.stdout);
  assert.match(second.stderr, /latest receipt.*invalid/i);
  assert.equal(await readFile(latestPath, "utf8"), "{}\n");
  assert.deepEqual(await readFile(path.join(root, ...reportPath.split("/"))), reportBefore);
});
