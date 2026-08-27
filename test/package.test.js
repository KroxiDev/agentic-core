import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const expectedInventory = [
  "LICENSE",
  "bin/agentic-core.js",
  "bin/agentic-quality.js",
  "golden-rules.md",
  "package.json",
  "src/init.js",
  "src/maintenance-cli.js",
  "src/quality-cli.js",
  "src/quality/ast.js",
  "src/quality/coverage.js",
  "src/quality/engine.js",
  "src/quality/mutation.js",
  "src/quality/python-helper.py",
  "src/quality/python.js",
  "src/transaction.js",
  "src/version.js",
];

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runNpm(args, options) {
  return execFileAsync(process.execPath, [npmCli, ...args], options);
}

test("npm pack contains exactly the initial product inventory", async () => {
  const { stdout } = await runNpm(["pack", "--dry-run", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const [pack] = JSON.parse(stdout);

  assert.equal(pack.name, "@kroxidev/agentic-core");
  assert.equal(pack.version, "0.1.0");
  assert.deepEqual(pack.files.map(({ path: filePath }) => filePath), expectedInventory);
});

test("both CLI entry points work from an installed package", async (t) => {
  const packDirectory = await temporaryDirectory(t, "agentic-core-pack-");
  const consumer = await temporaryDirectory(t, "agentic core consumer ");
  const { stdout } = await runNpm(
    ["pack", "--json", "--pack-destination", packDirectory],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const [pack] = JSON.parse(stdout);
  const tarball = path.join(packDirectory, pack.filename);
  await runNpm(
    ["install", tarball, "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer, encoding: "utf8" },
  );

  const installedRoot = path.join(consumer, "node_modules", "@kroxidev", "agentic-core");
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  assert.deepEqual(installedPackage.bin, {
    "agentic-core": "bin/agentic-core.js",
    "agentic-quality": "bin/agentic-quality.js",
  });

  for (const [binary, helpPattern] of [
    ["agentic-core.js", /agentic-core init/],
    ["agentic-quality.js", /agentic-quality scan/],
  ]) {
    const binaryPath = path.join(installedRoot, "bin", binary);
    const result = await execFileAsync(process.execPath, [binaryPath, "--version"], {
      cwd: consumer,
      encoding: "utf8",
    });
    assert.equal(result.stdout.trim(), "0.1.0");
    const help = await execFileAsync(process.execPath, [binaryPath, "--help"], {
      cwd: consumer,
      encoding: "utf8",
    });
    assert.match(help.stdout, helpPattern);
  }
});
