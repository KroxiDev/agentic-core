import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { analyzeQuality } from "./crap.js";
import { captureQualityCheckpoint, normalizeQualityScopes } from "./inputs.js";
import { analyzeMutation } from "./mutation.js";
import { compareCodeUnits } from "./order.js";
import { hashFileTree, writeTransaction } from "../transaction.js";

const MODES = new Set(["light", "normal", "full"]);
const SESSION_ID = /^q_[a-f0-9]{24}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function json(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
function environmentIdentity() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}
function runnerEnvironment(report) {
  const commands = report?.inputInventory?.commands ?? [];
  const executables = [...new Map(commands.map((command) => [
    JSON.stringify([command.executable, command.version ?? null]),
    { executable: command.executable, version: command.version ?? null },
  ])).values()].sort((left, right) => (
    compareCodeUnits(left.executable, right.executable)
      || compareCodeUnits(JSON.stringify(left.version), JSON.stringify(right.version))
  ));
  return {
    backend: report?.backend ?? null,
    runner: report?.inputInventory?.runner ?? null,
    executables,
  };
}
function sessionIdentity({ mode, scopes, checkpoint, environment, baseline }) {
  return `q_${sha256(JSON.stringify({ mode, scopes, checkpoint, environment, baseline })).slice(0, 24)}`;
}
function withoutDuration(report) {
  const { durationMs: _durationMs, ...stable } = report;
  return stable;
}
function safeStoredPath(filePath) {
  return typeof filePath === "string" && filePath.length > 0
    && !path.isAbsolute(filePath) && !filePath.includes("\\")
    && filePath.split("/").every((part) => part && part !== "." && part !== "..");
}

export class QualitySessionError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "QualitySessionError";
    this.exitCode = exitCode;
  }
}

function sessionRoot(projectRoot, id) {
  return path.join(projectRoot, ".agentic-core", "quality", id);
}

async function pathKind(targetPath) {
  try {
    const details = await lstat(targetPath);
    if (details.isSymbolicLink()) return "unsafe";
    if (details.isDirectory()) return "directory";
    if (details.isFile()) return "file";
    return "unsafe";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function immutableFiles(root, relative = "") {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new QualitySessionError(`Quality session contains a symbolic link: ${childRelative}`, 4);
    if (childRelative === "reports" || childRelative.startsWith("reports/")) continue;
    if (entry.isDirectory()) files.push(...await immutableFiles(root, childRelative));
    else if (entry.isFile()) files.push(childRelative);
    else throw new QualitySessionError(`Quality session contains an unsupported entry: ${childRelative}`, 4);
  }
  return files;
}

async function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      throw new QualitySessionError(`${label} is missing or corrupt`, 4);
    }
    throw error;
  }
}

function baselineIsValid(baseline, session) {
  return baseline?.schemaVersion === 1
    && baseline.$schema === "https://kroxidev.dev/agentic-core/quality-report.schema.json"
    && baseline.tool === "crap"
    && ["approved", "failed", "not_applicable"].includes(baseline.status)
    && Array.isArray(baseline.details)
    && baseline.inputInventory !== null
    && typeof baseline.inputInventory === "object"
    && Array.isArray(baseline.inputInventory.entries)
    && Array.isArray(baseline.inputInventory.commands)
    && /^[a-f0-9]{64}$/.test(baseline.inputInventory.digest ?? "")
    && baseline.inputInventory.commands.every((command) =>
      command?.kind === "runner_command"
      && typeof command.id === "string"
      && typeof command.executable === "string"
      && command.executable.length > 0
      && Array.isArray(command.args)
      && command.args.every((argument) => typeof argument === "string"))
    && baseline.hashes?.freshness === baseline.inputInventory.digest
    && Array.isArray(baseline.declaredScopes)
    && baseline.declaredScopes.join("\0") === session.scopes.join("\0")
    && session.baseline?.status === baseline.status
    && session.baseline?.tests === "approved";
}

export async function loadQualitySession(projectDirectory, id) {
  const projectRoot = path.resolve(projectDirectory);
  if (!SESSION_ID.test(id ?? "")) throw new QualitySessionError("Quality session id is invalid", 4);
  const root = sessionRoot(projectRoot, id);
  if (await pathKind(root) !== "directory") throw new QualitySessionError(`Quality session not found: ${id}`, 4);

  const session = await parseJsonFile(path.join(root, "session.json"), "Quality session metadata");
  const integrity = await parseJsonFile(path.join(root, "integrity.json"), "Quality session integrity");
  const inventory = await parseJsonFile(path.join(root, "checkpoint", "inventory.json"), "Quality checkpoint inventory");
  const baseline = await parseJsonFile(path.join(root, "baseline", "crap.json"), "Quality baseline");
  if (session.schemaVersion !== 1 || session.id !== id || session.status !== "prepared"
    || !MODES.has(session.mode) || !Array.isArray(session.scopes)
    || integrity.schemaVersion !== 1 || !Array.isArray(integrity.files)
    || integrity.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(integrity.payloadSha256 ?? "")
    || inventory.schemaVersion !== 1 || !Array.isArray(inventory.entries)
    || !/^[a-f0-9]{64}$/.test(session.checkpoint?.sha256 ?? "")
    || !Number.isSafeInteger(session.checkpoint?.files) || session.checkpoint.files < 0
    || !/^[a-f0-9]{64}$/.test(session.baseline?.sha256 ?? "")
    || session.environment === null || typeof session.environment !== "object"
    || Array.isArray(session.environment)
    || JSON.stringify(Object.keys(session.environment).sort(compareCodeUnits)) !== JSON.stringify(["arch", "node", "platform"])
    || typeof session.environment.node !== "string"
    || typeof session.environment.platform !== "string"
    || typeof session.environment.arch !== "string") {
    throw new QualitySessionError("Quality session metadata is invalid", 4);
  }
  let normalizedScopes;
  try {
    normalizedScopes = normalizeQualityScopes(projectRoot, session.scopes);
  } catch {
    throw new QualitySessionError("Quality session scopes are invalid", 4);
  }
  if (normalizedScopes.join("\0") !== session.scopes.join("\0")
    || !baselineIsValid(baseline, session)) {
    throw new QualitySessionError("Quality session baseline is invalid", 4);
  }

  const actualPaths = await immutableFiles(root);
  const expectedPaths = [...integrity.files.map(({ path: filePath }) => filePath), "integrity.json"]
    .sort(compareCodeUnits);
  if (expectedPaths.some((filePath) => !safeStoredPath(filePath))
    || JSON.stringify(actualPaths.sort(compareCodeUnits)) !== JSON.stringify(expectedPaths)) {
    throw new QualitySessionError("Quality session immutable inventory is corrupt", 4);
  }
  const payload = [];
  for (const entry of integrity.files) {
    const content = await readFile(path.join(root, ...entry.path.split("/")));
    if (sha256(content) !== entry.sha256) {
      throw new QualitySessionError(`Quality session hash mismatch: ${entry.path}`, 4);
    }
    payload.push({ path: entry.path, content });
  }
  if (hashFileTree(payload) !== integrity.payloadSha256
    || sha256(json(withoutDuration(baseline))) !== session.baseline.sha256
    || inventory.digest !== session.checkpoint.sha256
    || inventory.scopes?.join("\0") !== session.scopes.join("\0")) {
    throw new QualitySessionError("Quality session baseline integrity is invalid", 4);
  }
  const allowedKinds = new Set([
    "target_code", "support_code", "test", "runner_configuration",
    "quality_configuration", "manifest", "lockfile",
  ]);
  const inventoryPaths = new Set();
  for (const entry of inventory.entries) {
    if (!safeStoredPath(entry.path) || !allowedKinds.has(entry.kind)
      || inventoryPaths.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      throw new QualitySessionError("Quality checkpoint inventory is invalid", 4);
    }
    inventoryPaths.add(entry.path);
    const content = await readFile(path.join(root, "checkpoint", "files", ...entry.path.split("/")));
    if (sha256(content) !== entry.sha256) {
      throw new QualitySessionError(`Quality checkpoint hash mismatch: ${entry.path}`, 4);
    }
  }
  const normalizedInventory = [...inventory.entries]
    .sort((left, right) => compareCodeUnits(left.path, right.path)
      || compareCodeUnits(left.kind, right.kind));
  if (JSON.stringify(normalizedInventory) !== JSON.stringify(inventory.entries)
    || sha256(JSON.stringify({ scopes: inventory.scopes, entries: inventory.entries })) !== inventory.digest
    || session.checkpoint.files !== inventory.entries.length
    || sessionIdentity({
      mode: session.mode,
      scopes: session.scopes,
      checkpoint: session.checkpoint.sha256,
      environment: session.environment,
      baseline: session.baseline.sha256,
    }) !== id) {
    throw new QualitySessionError("Quality checkpoint identity is invalid", 4);
  }
  const expectedImmutablePayload = [
    "baseline/crap.json",
    "checkpoint/inventory.json",
    "session.json",
    ...inventory.entries.map((entry) => `checkpoint/files/${entry.path}`),
  ].sort(compareCodeUnits);
  const actualImmutablePayload = integrity.files.map((entry) => entry.path).sort(compareCodeUnits);
  if (JSON.stringify(expectedImmutablePayload) !== JSON.stringify(actualImmutablePayload)) {
    throw new QualitySessionError("Quality session contains unowned immutable evidence", 4);
  }
  return { projectRoot, root, session, integrity, inventory, baseline };
}

export async function inspectLatestQualityReceipt(loaded) {
  const reportsRoot = path.join(loaded.root, "reports");
  const reportsKind = await pathKind(reportsRoot);
  if (reportsKind === "missing") return null;
  if (reportsKind !== "directory") {
    throw new QualitySessionError("Quality session reports path is unsafe", 4);
  }
  const latestPath = path.join(reportsRoot, "latest.json");
  const latestKind = await pathKind(latestPath);
  if (latestKind === "missing") return null;
  if (latestKind !== "file") {
    throw new QualitySessionError("Quality session latest receipt path is unsafe", 4);
  }
  let receipt;
  try {
    receipt = JSON.parse(await readFile(latestPath, "utf8"));
  } catch {
    throw new QualitySessionError("Quality session latest receipt is invalid", 4);
  }
  if (receipt?.schemaVersion !== 1 || receipt.session !== loaded.session.id
    || !/^[a-f0-9]{64}$/.test(receipt.current ?? "")
    || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "")
    || receipt.report !== `reports/${receipt.sha256}.json`
    || !["approved", "failed", "unsupported_environment", "baseline_failed", "restoration_failure"]
      .includes(receipt.status)) {
    throw new QualitySessionError("Quality session latest receipt metadata is invalid", 4);
  }
  const reportPath = path.join(loaded.root, ...receipt.report.split("/"));
  if (await pathKind(reportPath) !== "file") {
    throw new QualitySessionError("Quality session latest receipt report is invalid", 4);
  }
  const reportContent = await readFile(reportPath);
  if (sha256(reportContent) !== receipt.sha256) {
    throw new QualitySessionError("Quality session latest receipt report hash is invalid", 4);
  }
  let report;
  try {
    report = JSON.parse(reportContent);
  } catch {
    throw new QualitySessionError("Quality session latest receipt report is invalid", 4);
  }
  if (report?.schemaVersion !== 1
    || report.$schema !== "https://kroxidev.dev/agentic-core/quality-verification.schema.json"
    || report.session !== loaded.session.id
    || report.mode !== loaded.session.mode
    || report.status !== receipt.status
    || report.current?.sha256 !== receipt.current
    || report.baseline?.sha256 !== loaded.session.baseline.sha256
    || report.baseline?.checkpoint !== loaded.session.checkpoint.sha256
    || report.scopes?.join("\0") !== loaded.session.scopes.join("\0")) {
    throw new QualitySessionError("Quality session latest report does not belong to its session", 4);
  }
  return { receipt, report, reportContent };
}

function preparedResult(loaded, reused) {
  return {
    command: "prepare",
    status: "prepared",
    id: loaded.session.id,
    mode: loaded.session.mode,
    scopes: loaded.session.scopes,
    baseline: loaded.session.baseline.sha256,
    checkpoint: loaded.session.checkpoint.sha256,
    reused,
  };
}

export async function prepareQualitySession({ projectRoot: projectDirectory, mode, scopes }) {
  const projectRoot = path.resolve(projectDirectory);
  if (!MODES.has(mode)) throw new QualitySessionError("Quality mode must be light, normal, or full", 4);
  let before;
  try {
    before = await captureQualityCheckpoint(projectRoot, scopes);
  } catch (error) {
    throw new QualitySessionError(error.message, 4);
  }
  const environment = environmentIdentity();
  let analyzed;
  try {
    analyzed = await analyzeQuality({
      projectRoot,
      targets: before.scopes,
      tool: "crap",
    });
  } catch (error) {
    if (/Test command failed|baseline/i.test(error.message)) {
      throw new QualitySessionError(error.message, 3);
    }
    if (error?.unsupportedEnvironment) throw new QualitySessionError(error.message, 2);
    throw error;
  }
  if (["unsupported_environment", "unsupported_language"].includes(analyzed.status)) {
    throw new QualitySessionError("Quality baseline is not attributable in this environment", 2);
  }
  const baseline = withoutDuration({ ...analyzed, declaredScopes: before.scopes });
  const after = await captureQualityCheckpoint(projectRoot, before.scopes);
  if (after.digest !== before.digest) {
    throw new QualitySessionError("Quality inputs changed while the baseline was running", 3);
  }

  const baselineContent = json(baseline);
  const baselineSha256 = sha256(baselineContent);
  const id = sessionIdentity({
    mode,
    scopes: before.scopes,
    checkpoint: before.digest,
    environment,
    baseline: baselineSha256,
  });
  const root = sessionRoot(projectRoot, id);
  const existingKind = await pathKind(root);
  if (existingKind !== "missing") {
    if (existingKind !== "directory") throw new QualitySessionError(`Quality session path is unsafe: ${id}`, 5);
    return preparedResult(await loadQualitySession(projectRoot, id), true);
  }
  const inventoryDocument = {
    schemaVersion: 1,
    scopes: before.scopes,
    digest: before.digest,
    entries: before.inventory,
  };
  const session = {
    $schema: "https://kroxidev.dev/agentic-core/quality-session.schema.json",
    schemaVersion: 1,
    id,
    status: "prepared",
    mode,
    scopes: before.scopes,
    environment,
    checkpoint: {
      sha256: before.digest,
      files: before.inventory.length,
    },
    baseline: {
      status: baseline.status,
      tests: "approved",
      sha256: baselineSha256,
    },
  };
  const payload = [
    { path: "session.json", content: json(session) },
    { path: "baseline/crap.json", content: baselineContent },
    { path: "checkpoint/inventory.json", content: json(inventoryDocument) },
    ...before.entries.map((entry) => ({
      path: `checkpoint/files/${entry.path}`,
      content: entry.content,
    })),
  ].sort((left, right) => compareCodeUnits(left.path, right.path));
  const integrity = {
    schemaVersion: 1,
    algorithm: "sha256",
    payloadSha256: hashFileTree(payload),
    files: payload.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
  };
  const files = [...payload, { path: "integrity.json", content: json(integrity) }];
  try {
    await writeTransaction(projectRoot, [{
      type: "replace_directory",
      path: root,
      files,
      sourceSha256: hashFileTree(files),
    }]);
  } catch (error) {
    throw new QualitySessionError(`Could not persist quality session: ${error.message}`, 5);
  }
  return preparedResult(await loadQualitySession(projectRoot, id), false);
}

function checkpointChanges(baselineEntries, currentEntries, scopes) {
  const baseline = new Map(baselineEntries.map((entry) => [entry.path, entry]));
  const current = new Map(currentEntries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...baseline.keys(), ...current.keys()])].sort(compareCodeUnits);
  const changes = [];
  for (const file of paths) {
    const before = baseline.get(file);
    const after = current.get(file);
    if (before?.sha256 === after?.sha256 && before?.kind === after?.kind) continue;
    const inDeclaredScope = scopes.some((scope) =>
      scope === "." || file === scope || file.startsWith(`${scope}/`));
    const kind = after?.kind ?? before?.kind;
    changes.push({
      path: file,
      kind,
      change: before === undefined ? "added" : after === undefined ? "deleted" : "modified",
      attribution: inDeclaredScope
        ? "scope"
        : ["test", "runner_configuration", "quality_configuration", "manifest", "lockfile"].includes(kind)
          ? "evidence"
          : "outside_scope",
      before: before?.sha256 ?? null,
      after: after?.sha256 ?? null,
    });
  }
  return changes;
}

function reportStatus({ environment, tests, crap, mutation, restoration }) {
  if (restoration.status !== "approved" || mutation.status === "restoration_failure") return "restoration_failure";
  if (tests.status === "baseline_failed" || mutation.status === "baseline_failed") return "baseline_failed";
  if (environment.status !== "approved"
    || ["unsupported_environment", "unsupported_language"].includes(crap.status)
    || ["unsupported_environment", "unsupported_language"].includes(mutation.status)) {
    return "unsupported_environment";
  }
  if (tests.status !== "approved"
    || !["approved", "not_applicable"].includes(crap.status)
    || !["approved", "not_applicable"].includes(mutation.status)) return "failed";
  return "approved";
}

function verificationExit(status) {
  if (status === "approved") return 0;
  if (status === "unsupported_environment") return 2;
  if (status === "baseline_failed") return 3;
  if (status === "restoration_failure") return 5;
  return 1;
}

async function persistVerification(loaded, document) {
  await inspectLatestQualityReceipt(loaded);
  const content = json(document);
  const reportSha256 = sha256(content);
  const reportName = `${reportSha256}.json`;
  const logicalPath = `.agentic-core/quality/${loaded.session.id}/reports/${reportName}`;
  const reportsRoot = path.join(loaded.root, "reports");
  const reportsKind = await pathKind(reportsRoot);
  if (!["missing", "directory"].includes(reportsKind)) {
    throw new QualitySessionError("Quality session reports path is unsafe", 4);
  }
  const absolutePath = path.join(reportsRoot, reportName);
  for (const target of [absolutePath, path.join(reportsRoot, "latest.json")]) {
    const kind = await pathKind(target);
    if (!["missing", "file"].includes(kind)) {
      throw new QualitySessionError("Quality session report target is unsafe", 4);
    }
  }
  if (await pathKind(absolutePath) === "file"
    && sha256(await readFile(absolutePath)) !== reportSha256) {
    throw new QualitySessionError("Quality session report hash path is corrupt", 4);
  }
  const latest = {
    schemaVersion: 1,
    session: loaded.session.id,
    current: document.current.sha256,
    report: `reports/${reportName}`,
    sha256: reportSha256,
    status: document.status,
  };
  await writeTransaction(loaded.projectRoot, [
    { path: absolutePath, content },
    { path: path.join(loaded.root, "reports", "latest.json"), content: json(latest) },
  ], { temporaryRoot: reportsRoot });
  return { logicalPath, reportSha256 };
}

export async function verifyQualitySession({ projectRoot: projectDirectory, id }) {
  const loaded = await loadQualitySession(projectDirectory, id);
  await inspectLatestQualityReceipt(loaded);
  const currentEnvironment = environmentIdentity();
  const environment = {
    status: JSON.stringify(currentEnvironment) === JSON.stringify(loaded.session.environment)
      ? "approved"
      : "unsupported_environment",
    baseline: loaded.session.environment,
    current: currentEnvironment,
  };
  const before = await captureQualityCheckpoint(loaded.projectRoot, loaded.session.scopes);
  const changes = checkpointChanges(loaded.inventory.entries, before.inventory, loaded.session.scopes);
  const workParent = path.join(loaded.root, "reports", "work");
  const workKind = await pathKind(workParent);
  if (!["missing", "directory"].includes(workKind)) {
    throw new QualitySessionError("Quality session work path is unsafe", 4);
  }
  await mkdir(workParent, { recursive: true });
  const workRoot = await mkdtemp(path.join(workParent, "verify-"));
  let crap;
  let tests;
  try {
    crap = withoutDuration(await analyzeQuality({
      projectRoot: loaded.projectRoot,
      targets: loaded.session.scopes,
      tool: "crap",
      baseline: loaded.baseline,
      temporaryRoot: workRoot,
    }));
    tests = {
      status: "approved",
      runner: crap.runner,
      commands: crap.inputInventory?.commands ?? [],
    };
    const baselineRunner = runnerEnvironment(loaded.baseline);
    const currentRunner = runnerEnvironment(crap);
    environment.runner = { baseline: baselineRunner, current: currentRunner };
    if (JSON.stringify(baselineRunner) !== JSON.stringify(currentRunner)) {
      environment.status = "unsupported_environment";
    }
  } catch (error) {
    if (!/test command failed/i.test(error.message)) throw error;
    tests = { status: "failed", error: error.message };
    crap = { status: "not_run", reason: "tests_failed" };
  }

  const afterTests = await captureQualityCheckpoint(loaded.projectRoot, loaded.session.scopes);
  let mutation = loaded.session.mode === "full"
    ? { status: "not_run", executed: true }
    : { status: "not_applicable", executed: false, reason: `mode_${loaded.session.mode}` };
  let afterMutation = afterTests;
  if (loaded.session.mode === "full" && tests.status === "approved"
    && ["approved", "not_applicable"].includes(crap.status)) {
    mutation = withoutDuration(await analyzeMutation({
      projectRoot: loaded.projectRoot,
      targets: loaded.session.scopes,
      temporaryRoot: workRoot,
    }));
    mutation.executed = true;
    afterMutation = await captureQualityCheckpoint(loaded.projectRoot, loaded.session.scopes);
  }
  const restoration = {
    status: before.digest === afterTests.digest && before.digest === afterMutation.digest
      && mutation.status !== "restoration_failure"
      && (mutation.executed !== true || mutation.restoration?.workingTreeUntouched !== false)
      ? "approved"
      : "failed",
    checkpointUnchanged: before.digest === afterMutation.digest,
    snapshotsVerified: mutation.executed !== true
      || mutation.restoration?.snapshotsVerified === true
      || mutation.status === "not_applicable",
  };
  if (mutation.status !== "restoration_failure") {
    try {
      if (process.env.NODE_ENV === "test"
        && process.env.AGENTIC_CORE_TEST_FAIL_QUALITY_CLEANUP === "1") {
        throw new Error("Injected quality work cleanup failure");
      }
      await rm(workRoot, { recursive: true, force: true });
      try {
        await rmdir(workParent);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
      }
      restoration.workAreaRemoved = true;
    } catch (error) {
      restoration.status = "failed";
      restoration.workAreaRemoved = false;
      restoration.error = error.message;
    }
  }
  const status = reportStatus({ environment, tests, crap, mutation, restoration });
  const currentSha256 = sha256(JSON.stringify({
    checkpoint: before.digest,
    environment: currentEnvironment,
    runner: crap.inputInventory?.runner ?? null,
    commands: crap.inputInventory?.commands ?? [],
  }));
  const document = {
    $schema: "https://kroxidev.dev/agentic-core/quality-verification.schema.json",
    schemaVersion: 1,
    session: loaded.session.id,
    mode: loaded.session.mode,
    scopes: loaded.session.scopes,
    status,
    baseline: {
      sha256: loaded.session.baseline.sha256,
      checkpoint: loaded.session.checkpoint.sha256,
    },
    current: {
      sha256: currentSha256,
      checkpoint: before.digest,
    },
    changes,
    environment,
    tests,
    crap,
    mutation,
    restoration,
  };
  let persisted;
  try {
    persisted = await persistVerification(loaded, document);
  } catch (error) {
    if (error instanceof QualitySessionError) throw error;
    throw new QualitySessionError(`Could not persist quality verification: ${error.message}`, 5);
  }
  const maximum = crap.summary?.maximumCrap;
  const mutationReceipt = mutation.status;
  const result = {
    command: "verify",
    status,
    session: loaded.session.id,
    tests: tests.status,
    crapMax: maximum ?? "not_applicable",
    mutation: mutationReceipt,
    report: persisted.logicalPath,
    sha256: persisted.reportSha256,
    receipt: status === "approved"
      ? `QUALITY_OK session=${loaded.session.id} tests=approved crap_max=${maximum ?? "not_applicable"} mutation=${mutationReceipt} report=${persisted.logicalPath} sha256=${persisted.reportSha256}`
      : `QUALITY_FAILED session=${loaded.session.id} tests=${tests.status} crap=${crap.status} mutation=${mutationReceipt} report=${persisted.logicalPath} sha256=${persisted.reportSha256}`,
  };
  return { result, exitCode: verificationExit(status) };
}

export function qualitySessionIdIsValid(id) {
  return SESSION_ID.test(id ?? "");
}
