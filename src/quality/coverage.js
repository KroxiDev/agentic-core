import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { TraceMap, eachMapping } from "@jridgewell/trace-mapping";

const execFileAsync = promisify(execFile);
function normalizeFile(filePath) { return path.resolve(filePath).toLowerCase(); }
function urlToFile(url) { try { return url.startsWith("file:") ? fileURLToPath(url) : undefined; } catch { return undefined; } }
function coverageRanges(functions) { return functions.flatMap(({ ranges }) => ranges); }
function offsetIsCovered(offset, ranges) {
  const containing = ranges.filter(({ startOffset, endOffset }) => startOffset <= offset && offset < endOffset);
  if (containing.length === 0) return false;
  containing.sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset));
  return containing[0].count > 0;
}
function offsetsByLine(source) {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") offsets.push(index + 1);
  return offsets;
}
function directCoverage(entry, source) {
  const ranges = coverageRanges(entry.functions);
  return new Set(offsetsByLine(source).flatMap((offset, index) =>
    offsetIsCovered(offset, ranges) || offsetIsCovered(offset + 1, ranges) ? [index + 1] : []));
}
function mappedCoverage(entry, cacheEntry, targetPath) {
  if (!cacheEntry?.data || !Array.isArray(cacheEntry.lineLengths)) return undefined;
  const map = new TraceMap(cacheEntry.data, entry.url);
  const targetUrl = pathToFileURL(targetPath).href;
  const ranges = coverageRanges(entry.functions);
  const lineOffsets = [];
  let offset = 0;
  for (const length of cacheEntry.lineLengths) {
    lineOffsets.push(offset);
    offset += length + 1;
  }
  const covered = new Set();
  let attributable = false;
  eachMapping(map, (mapping) => {
    if (mapping.originalLine == null || !mapping.source) return;
    let sourceUrl;
    try { sourceUrl = new URL(mapping.source, entry.url).href; } catch { sourceUrl = mapping.source; }
    const sourcePath = urlToFile(sourceUrl);
    if (sourceUrl !== targetUrl && (!sourcePath || normalizeFile(sourcePath) !== normalizeFile(targetPath))) return;
    attributable = true;
    const generatedOffset = (lineOffsets[mapping.generatedLine - 1] ?? 0) + mapping.generatedColumn;
    if (offsetIsCovered(generatedOffset, ranges)) covered.add(mapping.originalLine);
  });
  return attributable ? covered : undefined;
}
export async function collectV8Coverage(coverageDirectory, files) {
  const coveredByFile = new Map();
  const attributable = new Set();
  for (const coverageFile of (await readdir(coverageDirectory)).filter((name) => name.endsWith(".json"))) {
    const document = JSON.parse(await readFile(path.join(coverageDirectory, coverageFile), "utf8"));
    for (const entry of document.result ?? []) {
      const directPath = urlToFile(entry.url);
      for (const file of files) {
        const key = normalizeFile(file.path);
        const covered = directPath && key === normalizeFile(directPath)
          ? directCoverage(entry, file.source)
          : mappedCoverage(entry, document["source-map-cache"]?.[entry.url], file.path);
        if (covered === undefined) continue;
        attributable.add(key);
        const accumulated = coveredByFile.get(key) ?? new Set();
        for (const line of covered) accumulated.add(line);
        coveredByFile.set(key, accumulated);
      }
    }
  }
  return { coveredByFile, attributable };
}
async function nodeTestInvocations(projectRoot) {
  const tests = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) tests.push(child);
    }
  }
  await visit(projectRoot);
  return tests.sort().map((testFile) => [testFile]);
}
export function runnerInvocation(projectRoot, packageJson) {
  const test = packageJson.scripts?.test ?? "";
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (/vitest/i.test(test) || dependencies.vitest) {
    return { runner: "vitest", args: [path.join(projectRoot, "node_modules", "vitest", "vitest.mjs"), "run"] };
  }
  if (/jest/i.test(test) || dependencies.jest) {
    return { runner: "jest", args: [path.join(projectRoot, "node_modules", "jest", "bin", "jest.js"), "--runInBand"] };
  }
  return { runner: "node:test" };
}
export async function executeTests(projectRoot, { timeout = 30_000 } = {}) {
  let packageJson = {};
  try { packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}
  const invocation = runnerInvocation(projectRoot, packageJson);
  const commands = invocation.runner === "node:test" ? await nodeTestInvocations(projectRoot) : [invocation.args];
  for (const args of commands) {
    await execFileAsync(process.execPath, args, {
      cwd: projectRoot,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    });
  }
  return { runner: invocation.runner };
}
export async function executeCoverage(projectRoot, files, { timeout = 30_000 } = {}) {
  const coverageDirectory = await mkdtemp(path.join(tmpdir(), "agentic-core-v8-"));
  try {
    let packageJson = {};
    try { packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}
    const invocation = runnerInvocation(projectRoot, packageJson);
    const commands = invocation.runner === "node:test" ? await nodeTestInvocations(projectRoot) : [invocation.args];
    try {
      for (const args of commands) {
        await execFileAsync(process.execPath, args, { cwd: projectRoot,
          env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory }, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
          timeout });
      }
    } catch (error) {
      const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`Test command failed${detail ? `:\n${detail}` : ""}`);
    }
    return { ...(await collectV8Coverage(coverageDirectory, files)), runner: invocation.runner };
  } finally { await rm(coverageDirectory, { recursive: true, force: true }); }
}
