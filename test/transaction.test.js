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

test("guarded directory cleanup preserves content published after preflight", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic guarded directory transaction "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "evidence");
  await mkdir(target);
  await writeFile(path.join(target, "owned.txt"), "owned evidence");
  const expectedTreeSha256 = await hashDirectory(target);
  const preparation = path.join(root, "preparation");
  await assert.rejects(writeTransaction(root, [
    { type: "create_directory", path: preparation, prepare: async () => {
      await writeFile(path.join(target, "foreign.txt"), "foreign evidence");
    } },
    { type: "delete", path: target, expectedTreeSha256 },
  ]), { code: "ERR_TRANSACTION_CONFLICT" });
  await assert.rejects(access(preparation), { code: "ENOENT" });
  assert.equal(await readFile(path.join(target, "owned.txt"), "utf8"), "owned evidence");
  assert.equal(await readFile(path.join(target, "foreign.txt"), "utf8"), "foreign evidence");
});

test("guarded rollback preserves foreign content recreated after a deletion", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic concurrent rollback "));
  const temporaryRoot = path.join(root, "backups");
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "evidence.json");
  const original = Buffer.from("owned evidence");
  await writeFile(target, original);
  await assert.rejects(writeTransaction(root, [
    { type: "delete", path: target, expectedContent: original },
    { type: "create_directory", path: path.join(root, "next"), prepare: async () => {
      await writeFile(target, "foreign concurrent content");
      throw new Error("later operation failed");
    } },
  ], { temporaryRoot }), (error) => error.code === "ERR_RESTORATION_FAILED" && Boolean(error.backupPath));
  assert.equal(await readFile(target, "utf8"), "foreign concurrent content");
});

test("guarded creation preserves a file published after its missing snapshot", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic concurrent creation "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "active.json");
  await assert.rejects(writeTransaction(root, [
    { type: "create_directory", path: path.join(root, "next"), prepare: async () => {
      await writeFile(target, "foreign task");
    } },
    { path: target, content: Buffer.from("new task"), expectedContent: null },
  ]), { code: "ERR_TRANSACTION_CONFLICT" });
  assert.equal(await readFile(target, "utf8"), "foreign task");
});

for (const existed of [false, true]) {
  test(`guarded publication rollback preserves concurrent task changes (${existed ? "replacement" : "creation"})`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "agentic publication rollback "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = path.join(root, "active.json");
    const previous = existed ? Buffer.from("old task") : null;
    if (existed) await writeFile(target, previous);
    await assert.rejects(writeTransaction(root, [
      { path: target, content: Buffer.from("new task"), expectedContent: previous },
      { type: "create_directory", path: path.join(root, "next"), prepare: async () => {
        await writeFile(target, "foreign task");
        throw new Error("later operation failed");
      } },
    ], { temporaryRoot: path.join(root, "backups") }), { code: "ERR_RESTORATION_FAILED" });
    assert.equal(await readFile(target, "utf8"), "foreign task");
  });
}

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

test("guarded directory replacement restores the original tree after a later failure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic directory rollback "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "runtime");
  await mkdir(target);
  await writeFile(path.join(target, "old.txt"), "old runtime\n");
  const originalTreeSha256 = await hashDirectory(target);
  const files = [{ path: "new.txt", content: Buffer.from("new runtime\n") }];

  await assert.rejects(writeTransaction(root, [{
    path: target,
    type: "replace_directory",
    files,
    sourceSha256: hashFileTree(files),
    expectedTreeSha256: originalTreeSha256,
  }], { failAfterWrite: 1 }), /Simulated transaction failure/u);

  assert.equal(await hashDirectory(target), originalTreeSha256);
  assert.equal(await readFile(path.join(target, "old.txt"), "utf8"), "old runtime\n");
  await assert.rejects(access(path.join(target, "new.txt")), { code: "ENOENT" });
});

test("guarded directory replacement restores the original tree when publication fails", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic directory publication "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "runtime");
  await mkdir(target);
  await writeFile(path.join(target, "old.txt"), "old runtime\n");
  const originalTreeSha256 = await hashDirectory(target);
  const files = [{ path: "new.txt", content: Buffer.from("new runtime\n") }];
  const publicationError = Object.assign(new Error("publication denied"), { code: "EACCES" });

  await assert.rejects(writeTransaction(root, [{
    path: target,
    type: "replace_directory",
    files,
    sourceSha256: hashFileTree(files),
    expectedTreeSha256: originalTreeSha256,
  }], { renameDirectory: async () => { throw publicationError; } }), publicationError);

  assert.equal(await hashDirectory(target), originalTreeSha256);
  assert.equal(await readFile(path.join(target, "old.txt"), "utf8"), "old runtime\n");
});

test("guarded directory replacement preserves foreign content created during preparation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic directory concurrent "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "runtime");
  await mkdir(target);
  await writeFile(path.join(target, "old.txt"), "old runtime\n");
  const originalTreeSha256 = await hashDirectory(target);
  const files = [{ path: "new.txt", content: Buffer.from("new runtime\n") }];

  await assert.rejects(writeTransaction(root, [{
    path: target,
    type: "replace_directory",
    files,
    sourceSha256: hashFileTree(files),
    expectedTreeSha256: originalTreeSha256,
  }], { beforeDirectoryPublish: async () => {
    await writeFile(path.join(target, "foreign.txt"), "foreign runtime\n");
  } }), { code: "ERR_TRANSACTION_CONFLICT" });

  assert.equal(await readFile(path.join(target, "old.txt"), "utf8"), "old runtime\n");
  assert.equal(await readFile(path.join(target, "foreign.txt"), "utf8"), "foreign runtime\n");
  await assert.rejects(access(path.join(target, "new.txt")), { code: "ENOENT" });
});
