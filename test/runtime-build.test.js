import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRuntimePayload } from "../scripts/build-runtime.mjs";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function snapshot(root, relative = "") {
  const files = new Map();
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const logicalPath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [filePath, content] of await snapshot(root, logicalPath)) files.set(filePath, content);
    } else if (entry.isFile()) {
      files.set(logicalPath, await readFile(path.join(root, ...logicalPath.split("/"))));
    } else {
      assert.fail(`unsupported build output: ${logicalPath}`);
    }
  }
  return files;
}

test("the self-contained runtime build is deterministic and contains only the production payload", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agentic-runtime-build-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const firstRoot = path.join(temporaryRoot, "first");
  const secondRoot = path.join(temporaryRoot, "second");

  const firstMetrics = await buildRuntimePayload(firstRoot);
  const secondMetrics = await buildRuntimePayload(secondRoot);
  const first = await snapshot(firstRoot);
  const second = await snapshot(secondRoot);

  assert.deepEqual([...first.keys()], [...second.keys()]);
  for (const [filePath, content] of first) assert.deepEqual(second.get(filePath), content, filePath);
  assert.equal(firstMetrics.files, first.size);
  assert.deepEqual(
    { ...firstMetrics, output: "<output>" },
    { ...secondMetrics, output: "<output>" },
  );
  assert.ok(first.has("agentic-core.mjs"));
  assert.ok(first.has("python-helper.py"));
  assert.ok(first.has("resources/golden-rules.md"));
  assert.ok(first.has("third_party/typescript/LICENSE.txt"));
  assert.ok(first.has("third_party/typescript/ThirdPartyNoticeText.txt"));
  for (const filePath of first.keys()) {
    assert.doesNotMatch(filePath, /(?:^|\/)(?:node_modules|_npx)(?:\/|$)/u);
    assert.doesNotMatch(filePath, /(?:\.map|\.d\.ts|\.tsx?|package-lock\.json)$/u);
  }

  const manifest = JSON.parse(first.get("payload-manifest.json").toString("utf8"));
  assert.equal(manifest.type, "agentic-core-runtime-payload");
  assert.equal(manifest.format, "self-contained-v1");
  assert.deepEqual(manifest.bins, {
    "agentic-core": "agentic-core.mjs",
    "agentic-quality": "agentic-core.mjs",
  });
  assert.deepEqual(
    manifest.integrity.files.map(({ path: filePath }) => filePath),
    [...first.keys()].filter((filePath) => filePath !== "payload-manifest.json"),
  );
  for (const record of manifest.integrity.files) {
    const content = first.get(record.path);
    assert.equal(record.bytes, content.byteLength, record.path);
    assert.equal(record.sha256, sha256(content), record.path);
  }
});
