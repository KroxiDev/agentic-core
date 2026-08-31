import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hashDirectory, hashFileTree, writeTransaction } from "../src/transaction.js";

test("rollback removes an in-project temporary root that did not exist before the transaction", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic transaction "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temporaryRoot = path.join(root, "artifacts");
  const target = path.join(temporaryRoot, "report.json");

  await assert.rejects(writeTransaction(root, [
    { path: target, content: Buffer.from("report\n") },
  ], { temporaryRoot, failAfterWrite: 1 }), /Simulated transaction failure/);
  await assert.rejects(access(temporaryRoot), { code: "ENOENT" });
});

test("a final runtime inventory is materialized directly and hashes like the resulting directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic runtime transaction "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, ".agentic-core", "runtime");
  const files = [
    { path: "agentic-core.mjs", content: Buffer.from("export {};\n") },
    { path: "resources/profile.txt", content: Buffer.from("profile\n") },
  ];
  const treeSha256 = hashFileTree(files);

  await writeTransaction(root, [{
    path: runtime,
    type: "replace_directory",
    files,
    sourceSha256: treeSha256,
  }]);

  assert.equal(await hashDirectory(runtime), treeSha256);
  assert.equal(await readFile(path.join(runtime, "resources", "profile.txt"), "utf8"), "profile\n");
});

test("a direct runtime inventory rejects traversal before writing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic unsafe runtime transaction "));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(writeTransaction(root, [{
    path: path.join(root, ".agentic-core", "runtime"),
    type: "replace_directory",
    files: [{ path: "../outside.txt", content: Buffer.from("unsafe\n") }],
    sourceSha256: "0".repeat(64),
  }]), /Runtime file path is unsafe/);
  await assert.rejects(access(path.join(root, "outside.txt")), { code: "ENOENT" });
});
