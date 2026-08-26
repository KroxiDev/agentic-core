import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const maintenanceCli = path.join(repositoryRoot, "bin", "agentic-core.js");

async function createProject(t) {
  const project = await mkdtemp(path.join(tmpdir(), "agentic core project "));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(project, { recursive: true, force: true }));
  });
  return project;
}

async function runCore(args, options = {}) {
  return execFileAsync(process.execPath, [maintenanceCli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function snapshotFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = new Map();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      const children = await snapshotFiles(root, childRelative);
      for (const [filePath, content] of children) snapshot.set(filePath, content);
    } else {
      snapshot.set(childRelative.replaceAll("\\", "/"), await readFile(path.join(root, childRelative)));
    }
  }
  return snapshot;
}

function assertSameSnapshot(actual, expected) {
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  for (const [filePath, content] of expected) assert.deepEqual(actual.get(filePath), content, filePath);
}

test("init installs the canonical direct-mode configuration and records ownership", async (t) => {
  const project = await createProject(t);

  const result = await runCore(["init", project, "--yes"]);

  assert.match(result.stdout, /Installed agentic-core 0\.1\.0/);

  const sourceRules = await readFile(path.join(repositoryRoot, "golden-rules.md"));
  const installedRules = await readFile(path.join(project, ".agentic-core", "golden-rules.md"));
  assert.deepEqual(installedRules, sourceRules);

  const config = JSON.parse(await readFile(path.join(project, ".agentic-core", "config.json"), "utf8"));
  assert.deepEqual(config, {
    $schema: "./config.schema.json",
    schemaVersion: 1,
    orchestration: {
      explicitActivationOnly: true,
      defaultMode: "normal",
      briefMaxBytes: 16384,
      handoffMaxBytes: 32768,
    },
    quality: { crapThreshold: 7, mutationWorkers: 4 },
  });

  const schema = JSON.parse(await readFile(path.join(project, ".agentic-core", "config.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.orchestration.additionalProperties, false);
  assert.equal(schema.properties.quality.additionalProperties, false);

  const agents = await readFile(path.join(project, "AGENTS.md"), "utf8");
  const claude = await readFile(path.join(project, "CLAUDE.md"), "utf8");
  for (const hostInstructions of [agents, claude]) {
    assert.match(hostInstructions, /<!-- AGENTIC_CORE_START -->/);
    assert.match(hostInstructions, /Requests without an explicit `Orquesta`, `\/orquestar`, or `\$orquestar` trigger run directly/);
    assert.match(hostInstructions, /load only `.agentic-core\/golden-rules\.md`/);
    assert.doesNotMatch(hostInstructions, /create (?:a )?coordinator/i);
  }

  await assert.rejects(stat(path.join(project, ".agentic-core", "runs")), { code: "ENOENT" });

  const manifest = JSON.parse(await readFile(path.join(project, ".agentic-core", "ownership.json"), "utf8"));
  assert.equal(manifest.product, "@kroxidev/agentic-core");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.configVersion, 1);
  assert.match(manifest.installationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(manifest.resources.map(({ path: resourcePath }) => resourcePath), [
    ".agentic-core/config.json",
    ".agentic-core/config.schema.json",
    ".agentic-core/golden-rules.md",
  ]);
  for (const resource of manifest.resources) {
    const content = await readFile(path.join(project, ...resource.path.split("/")));
    assert.equal(resource.sha256, sha256(content));
  }
  assert.deepEqual(manifest.managedBlocks.map(({ path: blockPath }) => blockPath), ["AGENTS.md", "CLAUDE.md"]);
});

test("--yes does not replace an isolated conflict without explicit authorization", async (t) => {
  const project = await createProject(t);
  const productRoot = path.join(project, ".agentic-core");
  await mkdir(productRoot);
  const conflictingConfig = Buffer.from("configuration owned by another tool\r\n");
  await writeFile(path.join(productRoot, "config.json"), conflictingConfig);

  await assert.rejects(
    runCore(["init", project, "--yes"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /isolated conflict/i);
      assert.match(error.stderr, /--replace-conflicts/);
      return true;
    },
  );

  assert.deepEqual(await readFile(path.join(productRoot, "config.json")), conflictingConfig);
  assert.deepEqual(await readdir(productRoot), ["config.json"]);

  const installed = await runCore(["init", project, "--yes", "--replace-conflicts"]);
  assert.match(installed.stdout, /Installed agentic-core 0\.1\.0/);
  assert.notDeepEqual(await readFile(path.join(productRoot, "config.json")), conflictingConfig);
});

test("init stops when another product owns a complete installation", async (t) => {
  const project = await createProject(t);
  const productRoot = path.join(project, ".agentic-core");
  await mkdir(productRoot);
  const foreignManifest = Buffer.from('{"product":"another-agent-layer","version":"9.0.0"}\r\n');
  await writeFile(path.join(productRoot, "ownership.json"), foreignManifest);
  await writeFile(path.join(productRoot, "foreign-resource.txt"), "must stay unchanged\r\n");

  await assert.rejects(
    runCore(["init", project, "--yes", "--replace-conflicts"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /foreign installation/i);
      return true;
    },
  );

  assert.deepEqual(await readFile(path.join(productRoot, "ownership.json")), foreignManifest);
  assert.equal(await readFile(path.join(productRoot, "foreign-resource.txt"), "utf8"), "must stay unchanged\r\n");
  assert.deepEqual((await readdir(productRoot)).sort(), ["foreign-resource.txt", "ownership.json"]);
});

test("a failure after any installation write restores the prior project byte for byte", async (t) => {
  for (const failAfterWrite of [1, 2, 3, 4, 5, 6]) {
    await t.test(`write ${failAfterWrite}`, async (subtest) => {
      const project = await createProject(subtest);
      const productRoot = path.join(project, ".agentic-core");
      await mkdir(productRoot);
      await writeFile(path.join(productRoot, "config.json"), Buffer.from([0x00, 0x0d, 0x0a, 0xff]));
      await writeFile(path.join(productRoot, "unknown.txt"), "foreign file\r\n");
      await writeFile(path.join(project, "AGENTS.md"), "# Existing instructions\r\nKeep these bytes.");
      const before = await snapshotFiles(project);

      await assert.rejects(
        runCore(["init", project, "--replace-conflicts"], {
          env: {
            ...process.env,
            NODE_ENV: "test",
            AGENTIC_CORE_TEST_FAIL_AFTER_WRITE: String(failAfterWrite),
          },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /simulated transaction failure/i);
          return true;
        },
      );

      assertSameSnapshot(await snapshotFiles(project), before);
    });
  }
});

test("a complete unowned footprint is not treated as replaceable isolated conflicts", async (t) => {
  const project = await createProject(t);
  const productRoot = path.join(project, ".agentic-core");
  await mkdir(productRoot);
  await writeFile(path.join(productRoot, "config.json"), "foreign config\r\n");
  await writeFile(path.join(productRoot, "config.schema.json"), "foreign schema\r\n");
  await writeFile(path.join(productRoot, "golden-rules.md"), "foreign policy\r\n");
  const before = await snapshotFiles(project);

  await assert.rejects(
    runCore(["init", project, "--replace-conflicts"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /foreign installation/i);
      return true;
    },
  );

  assertSameSnapshot(await snapshotFiles(project), before);
});

test("a conflicting managed block is replaced only when explicitly authorized", async (t) => {
  const project = await createProject(t);
  const prefix = Buffer.from("# Existing instructions\r\n\r\n");
  const staleBlock = Buffer.from("<!-- AGENTIC_CORE_START -->\r\nstale foreign instructions\r\n<!-- AGENTIC_CORE_END -->");
  const suffix = Buffer.from("\r\n\r\n# Keep this suffix without a final newline");
  const original = Buffer.concat([prefix, staleBlock, suffix]);
  await writeFile(path.join(project, "AGENTS.md"), original);

  await assert.rejects(runCore(["init", project, "--yes"]), /Command failed/);
  assert.deepEqual(await readFile(path.join(project, "AGENTS.md")), original);

  await runCore(["init", project, "--replace-conflicts"]);
  const replaced = await readFile(path.join(project, "AGENTS.md"));
  assert.deepEqual(replaced.subarray(0, prefix.length), prefix);
  assert.deepEqual(replaced.subarray(replaced.length - suffix.length), suffix);
  assert.equal((replaced.toString("utf8").match(/AGENTIC_CORE_START/g) ?? []).length, 1);
  assert.match(replaced.toString("utf8"), /load only `.agentic-core\/golden-rules\.md`/);
});
