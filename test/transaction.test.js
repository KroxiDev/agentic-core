import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeTransaction } from "../src/transaction.js";

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
