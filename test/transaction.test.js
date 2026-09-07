import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hashDirectory, hashFileTree, writeTransaction } from "../src/transaction.js";

for (const change of ["content", "directory", "missing"]) {
  test(`guarded cleanup preserves a ${change} change after transaction preflight`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "agentic guarded transaction "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = path.join(root, "evidence.json");
    const previous = Buffer.from("owned evidence");
    await writeFile(target, previous);
    const preparation = path.join(root, "preparation");
    await assert.rejects(writeTransaction(root, [
      { type: "create_directory", path: preparation, prepare: async () => {
        await rm(target);
        if (change === "content") await writeFile(target, "foreign content");
        if (change === "directory") {
          await mkdir(target);
          await writeFile(path.join(target, "foreign.txt"), "foreign content");
        }
      } },
      { type: "delete", path: target, expectedContent: previous },
    ]), { code: "ERR_TRANSACTION_CONFLICT" });
    await assert.rejects(access(preparation), { code: "ENOENT" });
    if (change === "missing") await assert.rejects(access(target), { code: "ENOENT" });
    else assert.equal(await readFile(change === "directory" ? path.join(target, "foreign.txt") : target, "utf8"), "foreign content");
  });
}

test("guarded cleanup restores owned evidence when a later write fails", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic guarded rollback "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "evidence.json");
  const active = path.join(root, "active.json");
  const content = Buffer.from("owned evidence");
  await writeFile(target, content);
  await writeFile(active, "old task");
  await assert.rejects(writeTransaction(root, [
    { type: "delete", path: target, expectedContent: content },
    { path: active, content: Buffer.from("new task") },
  ], { failAfterWrite: 2 }), /Simulated transaction failure/u);
  assert.equal(await readFile(target, "utf8"), "owned evidence");
  assert.equal(await readFile(active, "utf8"), "old task");
});

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
