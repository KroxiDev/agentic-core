import assert from "node:assert/strict";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { installTools, inspectTools, PYTHON_TOOLS } from "../src/installation/python.js";
import { hashDirectory } from "../src/transaction.js";
import { createTestProject } from "./project-builder.js";

test("private tools retain their owned bytes after relocation and inspection", async (t) => {
  const root = await createTestProject(t);
  const staged = path.join(root, "staged tools");
  const installed = path.join(root, "installed tools");
  const wheels = path.resolve(import.meta.dirname, "../third_party/python");
  await installTools(staged, "python", wheels);
  const expected = await hashDirectory(staged);
  await cp(staged, installed, { recursive: true });
  await rm(staged, { recursive: true });
  assert.equal(await hashDirectory(installed), expected);
  const report = await inspectTools(installed);
  assert.deepEqual(report.tools, PYTHON_TOOLS);
  assert.equal(await hashDirectory(installed), expected, "inspection must not regenerate bytecode in the owned tree");
});
