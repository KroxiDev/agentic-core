import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  appendManagedBlock,
  installationDefinition,
  managedBlock,
  replaceManagedBlock,
  validateOwnership,
} from "./init.js";
import { analyzeSource } from "./quality/ast.js";
import { analyzePythonSource, choosePythonRunner, findPython } from "./quality/python.js";
import { writeTransaction } from "./transaction.js";

const execFileAsync = promisify(execFile);
const PROBLEM_STATUSES = new Set(["error", "blocked"]);
const SOURCE_EXCLUSIONS = new Set([
  ".agentic-core", ".git", ".venv", "__pycache__", "build", "coverage", "dist", "node_modules", "venv",
]);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fileKind(filePath) {
  try {
    const details = await lstat(filePath);
    if (details.isFile()) return "file";
    if (details.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function unsafePathParent(projectRoot, targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { path: targetPath, kind: "outside_project" };
  }
  const parts = relative.split(path.sep);
  let current = projectRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) return { path: projectPath(projectRoot, current), kind: "symbolic_link" };
      if (!details.isDirectory()) return { path: projectPath(projectRoot, current), kind: "not_directory" };
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }
  return undefined;
}

function projectPath(projectRoot, targetPath) {
  return path.relative(projectRoot, targetPath).replaceAll("\\", "/");
}

function check({ id, component, status, message, evidence = {}, remediation, repair }) {
  return {
    id,
    component,
    status,
    message,
    evidence,
    ...(remediation ? { remediation } : {}),
    repair: repair ?? { available: false },
  };
}

function summarize(checks) {
  const counts = { ok: 0, error: 0, blocked: 0, not_applicable: 0 };
  for (const item of checks) counts[item.status] = (counts[item.status] ?? 0) + 1;
  const problems = counts.error + counts.blocked;
  return {
    status: problems === 0 ? "healthy" : "unhealthy",
    summary: {
      ...counts,
      problems,
      repairable: checks.filter((item) => item.repair.available).length,
    },
    checks,
  };
}

function configurationErrors(value) {
  if (!plainObject(value)) return ["configuration must be an object"];
  const errors = [];
  const exactKeys = (candidate, expected, label) => {
    if (!plainObject(candidate)) {
      errors.push(`${label} must be an object`);
      return false;
    }
    const actual = Object.keys(candidate);
    const unknown = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !Object.hasOwn(candidate, key));
    if (unknown.length > 0) errors.push(`${label} has unknown keys: ${unknown.join(", ")}`);
    if (missing.length > 0) errors.push(`${label} is missing keys: ${missing.join(", ")}`);
    return unknown.length === 0 && missing.length === 0;
  };

  exactKeys(value, ["$schema", "schemaVersion", "orchestration", "quality"], "configuration");
  if (value.$schema !== "./config.schema.json") errors.push("configuration.$schema must be ./config.schema.json");
  if (value.schemaVersion !== 1) errors.push("configuration.schemaVersion must be 1");

  if (exactKeys(value.orchestration,
    ["explicitActivationOnly", "defaultMode", "briefMaxBytes", "handoffMaxBytes"], "orchestration")) {
    if (value.orchestration.explicitActivationOnly !== true) {
      errors.push("orchestration.explicitActivationOnly must be true");
    }
    if (value.orchestration.defaultMode !== "normal") errors.push("orchestration.defaultMode must be normal");
    if (!Number.isInteger(value.orchestration.briefMaxBytes)
      || value.orchestration.briefMaxBytes < 1 || value.orchestration.briefMaxBytes > 16_384) {
      errors.push("orchestration.briefMaxBytes must be an integer from 1 through 16384");
    }
    if (!Number.isInteger(value.orchestration.handoffMaxBytes)
      || value.orchestration.handoffMaxBytes < 1 || value.orchestration.handoffMaxBytes > 32_768) {
      errors.push("orchestration.handoffMaxBytes must be an integer from 1 through 32768");
    }
  }

  if (exactKeys(value.quality, ["crapThreshold", "mutationWorkers"], "quality")) {
    if (typeof value.quality.crapThreshold !== "number" || !Number.isFinite(value.quality.crapThreshold)
      || value.quality.crapThreshold < 0) {
      errors.push("quality.crapThreshold must be a finite non-negative number");
    }
    if (!Number.isInteger(value.quality.mutationWorkers)
      || value.quality.mutationWorkers < 1 || value.quality.mutationWorkers > 4) {
      errors.push("quality.mutationWorkers must be an integer from 1 through 4");
    }
  }
  return errors;
}

function repairPlan() {
  const operations = [];
  const actions = [];
  const targets = new Set();
  const addOperation = (operation, action) => {
    const target = path.resolve(operation.path);
    if (targets.has(target)) throw new Error(`Duplicate doctor repair target: ${target}`);
    targets.add(target);
    operations.push({ ...operation, path: target });
    actions.push(action);
  };
  return {
    operations,
    actions,
    addWrite(targetPath, content, action) {
      addOperation({ path: targetPath, content }, action);
    },
    addDelete(targetPath, action) {
      addOperation({ path: targetPath, type: "delete" }, action);
    },
    addAction(action) {
      actions.push(action);
    },
  };
}

async function inspectConfiguration(projectRoot) {
  const targetPath = path.join(projectRoot, ".agentic-core", "config.json");
  const unsafeParent = await unsafePathParent(projectRoot, targetPath);
  if (unsafeParent) {
    return { path: targetPath, kind: "unsafe_parent", unsafeParent, valid: false,
      errors: [`configuration parent ${unsafeParent.path} is ${unsafeParent.kind}`] };
  }
  const kind = await fileKind(targetPath);
  if (kind !== "file") {
    return { path: targetPath, kind, valid: false, errors: [`configuration path is ${kind}`] };
  }
  const content = await readFile(targetPath);
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch (error) {
    return { path: targetPath, kind, content, valid: false, errors: [`configuration is not valid JSON: ${error.message}`] };
  }
  const errors = configurationErrors(value);
  return { path: targetPath, kind, content, value, valid: errors.length === 0, errors };
}

function recordedResourceCheck({ expected, recorded, actualKind, actualHash, expectedHash, currentVersion, unsafeParent,
  configInspection }) {
  const evidence = {
    path: expected.path,
    kind: actualKind,
    recordedSha256: recorded.sha256,
    actualSha256: actualHash ?? null,
    expectedSha256: currentVersion ? expectedHash : null,
    ...(unsafeParent ? { unsafeParent } : {}),
  };
  if (expected.path === ".agentic-core/config.json") {
    if (!configInspection.valid) {
      return {
        healthy: false,
        repairable: currentVersion && ["file", "missing"].includes(actualKind),
        message: "The owned configuration is missing or invalid",
        evidence: { ...evidence, schemaErrors: configInspection.errors },
        action: "restore the canonical configuration",
      };
    }
    if (actualHash === recorded.sha256) {
      return { healthy: true, evidence, message: "The configuration hash matches the ownership manifest" };
    }
    return {
      healthy: false,
      repairable: currentVersion,
      message: "The valid configuration differs from its recorded ownership hash",
      evidence,
      action: "record the valid user configuration hash without replacing its content",
    };
  }

  if (actualKind !== "file") {
    return {
      healthy: false,
      repairable: currentVersion && actualKind === "missing",
      message: `The owned resource is ${actualKind}`,
      evidence,
      action: "restore the packaged resource",
    };
  }
  if (!currentVersion) {
    if (actualHash === recorded.sha256) {
      return { healthy: true, evidence, message: "The installed resource matches its recorded hash" };
    }
    return {
      healthy: false,
      repairable: false,
      message: "The resource diverges and this package cannot reconstruct another installed version",
      evidence,
    };
  }
  if (actualHash === expectedHash && recorded.sha256 === expectedHash) {
    return { healthy: true, evidence, message: "The resource matches the current package and manifest" };
  }
  return {
    healthy: false,
    repairable: true,
    message: actualHash === expectedHash
      ? "The resource is correct but its ownership hash is incoherent"
      : "The owned resource differs from the current packaged resource",
    evidence,
    action: actualHash === expectedHash ? "repair the ownership hash" : "restore the packaged resource",
  };
}

async function addResourceChecks({ checks, definition, owner, projectRoot, currentVersion, plan, updatedOwner }) {
  const configInspection = await inspectConfiguration(projectRoot);
  const configurationRepairable = currentVersion && ["file", "missing"].includes(configInspection.kind);
  checks.push(check(configInspection.valid ? {
    id: "configuration.schema",
    component: "configuration",
    status: "ok",
    message: "Configuration satisfies schema version 1",
    evidence: { path: ".agentic-core/config.json", schemaVersion: configInspection.value.schemaVersion },
  } : {
    id: "configuration.schema",
    component: "configuration",
    status: "error",
    message: "Configuration does not satisfy schema version 1",
    evidence: { path: ".agentic-core/config.json", kind: configInspection.kind, errors: configInspection.errors },
    remediation: configurationRepairable
      ? "Run agentic-core doctor --repair to restore the canonical configuration."
      : "Run agentic-core update with the matching package version or resolve the incompatible path manually.",
    repair: configurationRepairable
      ? { available: true, action: "restore canonical configuration" }
      : { available: false },
  }));

  for (let index = 0; index < definition.resources.length; index += 1) {
    const expected = definition.resources[index];
    const recorded = owner.resources[index];
    const targetPath = path.join(projectRoot, ...expected.path.split("/"));
    const unsafeParent = expected.path === ".agentic-core/config.json"
      ? configInspection.unsafeParent : await unsafePathParent(projectRoot, targetPath);
    const actualKind = expected.path === ".agentic-core/config.json"
      ? configInspection.kind : unsafeParent ? "unsafe_parent" : await fileKind(targetPath);
    const actualContent = actualKind === "file"
      ? (expected.path === ".agentic-core/config.json" ? configInspection.content : await readFile(targetPath))
      : undefined;
    const actualHash = actualContent === undefined ? undefined : sha256(actualContent);
    const expectedHash = sha256(expected.content);
    const result = recordedResourceCheck({
      expected, recorded, actualKind, actualHash, expectedHash, currentVersion, unsafeParent, configInspection,
    });
    const id = `resource:${expected.path}`;
    if (result.healthy) {
      checks.push(check({
        id, component: "resource", status: "ok", message: result.message, evidence: result.evidence,
      }));
      continue;
    }

    checks.push(check({
      id,
      component: "resource",
      status: "error",
      message: result.message,
      evidence: result.evidence,
      remediation: result.repairable
        ? `Run agentic-core doctor --repair to ${result.action}.`
        : "Do not replace this path automatically; use the matching package version or resolve its type or ownership.",
      repair: result.repairable ? { available: true, action: result.action } : { available: false },
    }));
    if (!result.repairable) continue;

    if (expected.path === ".agentic-core/config.json" && configInspection.valid) {
      updatedOwner.resources[index].sha256 = actualHash;
      plan.addAction({ checkId: id, action: "record_hash", path: expected.path });
      continue;
    }
    if (actualHash !== expectedHash) {
      plan.addWrite(targetPath, expected.content, { checkId: id, action: "restore_resource", path: expected.path });
    } else {
      plan.addAction({ checkId: id, action: "record_hash", path: expected.path });
    }
    updatedOwner.resources[index].sha256 = expectedHash;
  }
}

async function addManagedBlockChecks({ checks, definition, owner, projectRoot, currentVersion, plan, updatedOwner }) {
  for (let index = 0; index < definition.managedBlocks.length; index += 1) {
    const expected = definition.managedBlocks[index];
    const recorded = owner.managedBlocks[index];
    const targetPath = path.join(projectRoot, expected.path);
    const unsafeParent = await unsafePathParent(projectRoot, targetPath);
    const kind = unsafeParent ? "unsafe_parent" : await fileKind(targetPath);
    const id = `managed-block:${expected.path}#${expected.id}`;
    const evidence = { path: expected.path, id: expected.id, kind, recordedSha256: recorded.sha256,
      ...(unsafeParent ? { unsafeParent } : {}) };
    if (kind !== "missing" && kind !== "file") {
      checks.push(check({
        id, component: "managed_block", status: "error",
        message: `The managed-block host path is ${kind}`,
        evidence,
        remediation: "Resolve the incompatible host path manually; doctor will not replace a foreign path type.",
      }));
      continue;
    }

    const existing = kind === "file" ? await readFile(targetPath) : Buffer.alloc(0);
    const found = managedBlock(existing, recorded.startMarker, recorded.endMarker);
    if (found.kind === "ambiguous") {
      checks.push(check({
        id, component: "managed_block", status: "error",
        message: "The ownership markers are duplicated or ambiguous",
        evidence: { ...evidence, boundary: "ambiguous" },
        remediation: "Resolve the duplicate markers manually; doctor will not guess which block it owns.",
      }));
      continue;
    }

    const actualHash = found.kind === "block" ? sha256(found.content) : undefined;
    const expectedHash = expected.sha256;
    const healthy = found.kind === "block" && (currentVersion
      ? actualHash === expectedHash && recorded.sha256 === expectedHash
      : actualHash === recorded.sha256);
    if (healthy) {
      checks.push(check({
        id, component: "managed_block", status: "ok",
        message: "The managed block has one coherent ownership boundary",
        evidence: { ...evidence, boundary: "unambiguous", actualSha256: actualHash,
          expectedSha256: currentVersion ? expectedHash : null },
      }));
      continue;
    }

    const repairable = currentVersion;
    checks.push(check({
      id, component: "managed_block", status: "error",
      message: found.kind === "missing" ? "The managed block is missing" : "The managed block content or hash diverges",
      evidence: { ...evidence, boundary: found.kind, actualSha256: actualHash ?? null,
        expectedSha256: currentVersion ? expectedHash : null },
      remediation: repairable
        ? "Run agentic-core doctor --repair to restore only the registered block boundary."
        : "Use the package version recorded by the manifest or run agentic-core update.",
      repair: repairable ? { available: true, action: "restore registered managed block" } : { available: false },
    }));
    if (!repairable) continue;

    if (found.kind === "block" && actualHash === expectedHash) {
      plan.addAction({ checkId: id, action: "record_hash", path: expected.path });
    } else {
      const replacement = found.kind === "block"
        ? replaceManagedBlock(existing, recorded.startMarker, recorded.endMarker)
        : appendManagedBlock(existing);
      plan.addWrite(targetPath, replacement, { checkId: id, action: "restore_managed_block", path: expected.path });
    }
    updatedOwner.managedBlocks[index].sha256 = expectedHash;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function addRunCheck(checks, projectRoot) {
  const runsPath = path.join(projectRoot, ".agentic-core", "runs");
  const kind = await fileKind(runsPath);
  if (kind === "missing") {
    checks.push(check({ id: "operations.runs", component: "operations", status: "ok",
      message: "No persisted runs are present", evidence: { path: ".agentic-core/runs", count: 0 } }));
    return;
  }
  if (kind !== "directory") {
    checks.push(check({
      id: "operations.runs", component: "operations", status: "error",
      message: `The persisted-runs path is ${kind}`,
      evidence: { path: ".agentic-core/runs", kind },
      remediation: "Resolve the incompatible path manually; doctor will not delete it.",
    }));
    return;
  }
  const entries = await readdir(runsPath, { withFileTypes: true });
  const runs = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const runPath = path.join(runsPath, entry.name);
    const statePath = path.join(runPath, "state.json");
    const record = { runId: entry.name, kind: entry.isDirectory() ? "directory" : "unexpected" };
    if (entry.isDirectory() && await fileKind(statePath) === "file") {
      try {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        record.status = typeof state.status === "string" ? state.status : "invalid";
        record.mode = typeof state.mode === "string" ? state.mode : null;
        record.currentRole = typeof state.currentRole?.name === "string" ? state.currentRole.name : null;
      } catch (error) {
        record.status = "invalid";
        record.error = error.message;
      }
    } else if (entry.isDirectory()) {
      record.status = "missing_state";
    }
    runs.push(record);
  }
  const incomplete = runs.filter((run) => !["failed", "blocked"].includes(run.status));
  const terminal = runs.filter((run) => ["failed", "blocked"].includes(run.status));
  checks.push(check(incomplete.length === 0 ? {
    id: "operations.runs", component: "operations", status: "ok",
    message: terminal.length === 0 ? "No persisted runs are present" : "No incomplete run is present; terminal evidence is retained",
    evidence: { path: ".agentic-core/runs", incomplete, terminal },
  } : {
    id: "operations.runs", component: "operations", status: "error",
    message: "Persisted incomplete runs require an explicit resume or cleanup decision",
    evidence: { path: ".agentic-core/runs", incomplete, terminal },
    remediation: "Resume the intended run explicitly or remove it only after deciding its persisted evidence is no longer needed.",
  }));
}

async function workerRecord(workerPath) {
  if (await fileKind(workerPath) !== "directory") return undefined;
  const metadataPath = path.join(workerPath, "worker.json");
  if (await fileKind(metadataPath) !== "file") return undefined;
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (!plainObject(metadata) || metadata.schemaVersion !== 1 || !Number.isInteger(metadata.pid) || metadata.pid <= 0
      || typeof metadata.runId !== "string" || metadata.runId.length === 0) return undefined;
    return metadata;
  } catch {
    return undefined;
  }
}

async function workerRunIsActive(projectRoot, runId) {
  const statePath = path.join(projectRoot, ".agentic-core", "runs", runId, "state.json");
  if (await fileKind(statePath) !== "file") return false;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return state?.id === runId && state?.status === "running";
  } catch {
    return false;
  }
}

async function addWorkerCheck({ checks, projectRoot, plan }) {
  const workersPath = path.join(projectRoot, ".agentic-core", "workers");
  const kind = await fileKind(workersPath);
  if (kind === "missing") {
    checks.push(check({ id: "operations.workers", component: "operations", status: "ok",
      message: "No worker records are present", evidence: { path: ".agentic-core/workers", active: [], abandoned: [] } }));
    return;
  }
  if (kind !== "directory") {
    checks.push(check({
      id: "operations.workers", component: "operations", status: "error",
      message: `The owned workers path is ${kind}`,
      evidence: { path: ".agentic-core/workers", kind },
      remediation: "Resolve the incompatible path manually; doctor will not replace it.",
    }));
    return;
  }
  const entries = await readdir(workersPath, { withFileTypes: true });
  const active = [];
  const abandoned = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const targetPath = path.join(workersPath, entry.name);
    const targetKind = await fileKind(targetPath);
    const metadata = await workerRecord(targetPath);
    if (metadata && await workerRunIsActive(projectRoot, metadata.runId) && processIsAlive(metadata.pid)) {
      active.push({ name: entry.name, pid: metadata.pid, runId: metadata.runId ?? null });
      continue;
    }
    const record = { name: entry.name, kind: targetKind, pid: metadata?.pid ?? null, runId: metadata?.runId ?? null };
    abandoned.push(record);
    if (targetKind === "file" || targetKind === "directory") {
      plan.addDelete(targetPath, {
        checkId: "operations.workers", action: "remove_abandoned_worker", path: projectPath(projectRoot, targetPath),
      });
    }
  }
  checks.push(check(abandoned.length === 0 ? {
    id: "operations.workers", component: "operations", status: "ok",
    message: active.length === 0 ? "No worker records are present" : "All recorded workers have live processes",
    evidence: { path: ".agentic-core/workers", active, abandoned },
  } : {
    id: "operations.workers", component: "operations", status: "error",
    message: "Abandoned worker records were detected",
    evidence: { path: ".agentic-core/workers", active, abandoned },
    remediation: "Run agentic-core doctor --repair to remove only abandoned entries in the manifest-owned workers directory.",
    repair: abandoned.some((item) => item.kind === "file" || item.kind === "directory")
      ? { available: true, action: "remove abandoned owned worker records" } : { available: false },
  }));
}

async function addTransactionCheck(checks, projectRoot) {
  const transactionsPath = path.join(projectRoot, ".agentic-core", "transactions");
  const kind = await fileKind(transactionsPath);
  if (kind === "missing") {
    checks.push(check({ id: "operations.transactions", component: "operations", status: "ok",
      message: "No pending transaction records are present",
      evidence: { path: ".agentic-core/transactions", pending: [] } }));
    return;
  }
  if (kind !== "directory") {
    checks.push(check({
      id: "operations.transactions", component: "operations", status: "error",
      message: `The owned transactions path is ${kind}`,
      evidence: { path: ".agentic-core/transactions", kind },
      remediation: "Resolve the incompatible path manually; doctor will not replace it.",
    }));
    return;
  }
  const entries = await readdir(transactionsPath, { withFileTypes: true });
  const pending = entries.sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
  checks.push(check(pending.length === 0 ? {
    id: "operations.transactions", component: "operations", status: "ok",
    message: "No pending transaction records are present",
    evidence: { path: ".agentic-core/transactions", pending },
  } : {
    id: "operations.transactions", component: "operations", status: "error",
    message: "Pending transaction evidence requires explicit recovery",
    evidence: { path: ".agentic-core/transactions", pending },
    remediation: "Inspect or recover the recorded transaction; doctor will not discard recovery evidence automatically.",
  }));
}

async function findPythonSource(projectRoot) {
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && SOURCE_EXCLUSIONS.has(entry.name)) continue;
      const targetPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await visit(targetPath);
        if (found) return found;
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".py") {
        return targetPath;
      }
    }
    return undefined;
  }
  return visit(projectRoot);
}

async function pythonCoverageBackend(runtime, projectRoot) {
  if (process.env.AGENTIC_CORE_PYTHON_BACKEND === "trace") return "stdlib-trace";
  try {
    await execFileAsync(runtime.executable, [...runtime.prefix, "-c", "import coverage"], {
      cwd: projectRoot, env: process.env, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    return "coverage.py";
  } catch {
    return "stdlib-trace";
  }
}

async function addBackendChecks(checks, projectRoot) {
  const nodeVersion = process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0], 10);
  checks.push(check(nodeMajor >= 20 ? {
    id: "runtime.node", component: "runtime", status: "ok",
    message: "Node.js satisfies the supported runtime floor",
    evidence: { executable: process.execPath, version: nodeVersion, required: ">=20" },
  } : {
    id: "runtime.node", component: "runtime", status: "error",
    message: "Node.js is below the supported runtime floor",
    evidence: { executable: process.execPath, version: nodeVersion, required: ">=20" },
    remediation: "Run agentic-core with Node.js 20 or newer.",
  }));

  for (const [language, fileName, source] of [
    ["javascript", "agentic-doctor-smoke.js", "export function smoke(value) { return value + 1; }\n"],
    ["typescript", "agentic-doctor-smoke.ts", "export function smoke(value: number): number { return value + 1; }\n"],
  ]) {
    try {
      const symbols = analyzeSource(fileName, source);
      if (symbols.length !== 1 || symbols[0].name !== "smoke") throw new Error("backend returned an incoherent symbol inventory");
      checks.push(check({
        id: `backend.${language}`, component: "quality_backend", status: "ok",
        message: `The ${language} analysis backend parsed a known source`,
        evidence: { language, parser: "typescript", symbol: symbols[0].name },
      }));
    } catch (error) {
      checks.push(check({
        id: `backend.${language}`, component: "quality_backend", status: "error",
        message: `The ${language} analysis backend is unavailable or incoherent`,
        evidence: { language, error: error.message },
        remediation: "Reinstall the current agentic-core package and its declared dependencies.",
      }));
    }
  }

  let pythonSource;
  try {
    pythonSource = await findPythonSource(projectRoot);
  } catch (error) {
    checks.push(check({
      id: "runtime.python", component: "runtime", status: "error",
      message: "Python requirement detection could not inspect the project",
      evidence: { error: error.message },
      remediation: "Make the project tree readable and rerun doctor.",
    }));
    checks.push(check({
      id: "backend.python", component: "quality_backend", status: "blocked",
      message: "Python backend validation is blocked by source detection",
      evidence: { reason: "python_source_detection_failed" },
      remediation: "Resolve the Python source detection error and rerun doctor.",
    }));
    return;
  }

  if (!pythonSource) {
    const evidence = { required: false, pythonSources: 0 };
    checks.push(check({
      id: "runtime.python", component: "runtime", status: "not_applicable",
      message: "Python is not required because no project Python source was found", evidence,
    }));
    checks.push(check({
      id: "backend.python", component: "quality_backend", status: "not_applicable",
      message: "Python backend validation is not required for this project", evidence,
    }));
    return;
  }

  const source = projectPath(projectRoot, pythonSource);
  const runtime = await findPython(projectRoot);
  if (!runtime) {
    checks.push(check({
      id: "runtime.python", component: "runtime", status: "error",
      message: "Python 3.10 or newer is required by project Python analysis but was not found",
      evidence: { required: true, source, configuredExecutable: process.env.AGENTIC_CORE_PYTHON ?? null },
      remediation: "Install Python 3.10 or newer or set AGENTIC_CORE_PYTHON to its executable path.",
    }));
    checks.push(check({
      id: "backend.python", component: "quality_backend", status: "blocked",
      message: "Python backend validation is blocked by the missing interpreter",
      evidence: { required: true, source, reason: "python_runtime_unavailable" },
      remediation: "Provide the required Python runtime and rerun doctor.",
    }));
    return;
  }
  checks.push(check({
    id: "runtime.python", component: "runtime", status: "ok",
    message: "Python satisfies the analysis runtime floor",
    evidence: { required: true, source, executable: runtime.executable, prefix: runtime.prefix, version: runtime.version },
  }));

  try {
    const helperPath = fileURLToPath(new URL("quality/python-helper.py", import.meta.url));
    const symbols = await analyzePythonSource(runtime, projectRoot, helperPath);
    if (!Array.isArray(symbols)) throw new Error("Python analyzer returned a non-array result");
    const runner = await choosePythonRunner(runtime, projectRoot);
    const coverage = await pythonCoverageBackend(runtime, projectRoot);
    checks.push(check({
      id: "backend.python", component: "quality_backend", status: "ok",
      message: "The Python analyzer, runner and coverage backend are coherent",
      evidence: { source, analyzerSymbols: symbols.length, runner, coverage },
    }));
  } catch (error) {
    checks.push(check({
      id: "backend.python", component: "quality_backend", status: "error",
      message: "The Python analysis backend is unavailable or incoherent",
      evidence: { source, error: error.message },
      remediation: "Install the declared project runner or repair the agentic-core Python backend.",
    }));
  }
}

async function addAdapterChecks({ checks, definition, hostAgentProbe }) {
  const indexed = new Map(checks.map((item) => [item.id, item]));
  for (const host of ["codex", "claude"]) {
    const resourcePaths = definition.resources.map(({ path: resourcePath }) => resourcePath).filter((resourcePath) => (
      host === "codex"
        ? resourcePath.startsWith(".codex/") || resourcePath.startsWith(".agents/")
        : resourcePath.startsWith(".claude/") || resourcePath === ".agentic-core/claude-read-command-guard.mjs"
    ));
    const blockPath = host === "codex" ? "AGENTS.md#agentic-core" : "CLAUDE.md#agentic-core";
    const checkIds = [
      ...resourcePaths.map((resourcePath) => `resource:${resourcePath}`),
      `managed-block:${blockPath}`,
    ];
    const evidence = checkIds.map((id) => ({ id, status: indexed.get(id)?.status ?? "missing_check" }));
    const coherent = evidence.every((item) => item.status === "ok");
    checks.push(check(coherent ? {
      id: `adapter.${host}`, component: "adapter", status: "ok",
      message: `The ${host} adapter resources and discovery boundary are coherent`,
      evidence: { host, checks: evidence },
    } : {
      id: `adapter.${host}`, component: "adapter", status: "error",
      message: `The ${host} adapter is incomplete or incoherent`,
      evidence: { host, checks: evidence },
      remediation: "Repair the listed owned resources before using this adapter.",
    }));

    if (!coherent) {
      checks.push(check({
        id: `adapter.${host}.agent_creation`, component: "adapter_capability", status: "blocked",
        message: `Real ${host} agent creation cannot be checked while its adapter is incoherent`,
        evidence: { host, reason: "adapter_incoherent" },
        remediation: "Repair the adapter and rerun doctor from a host that exposes a native creation probe.",
      }));
      continue;
    }
    if (typeof hostAgentProbe !== "function") {
      checks.push(check({
        id: `adapter.${host}.agent_creation`, component: "adapter_capability", status: "not_applicable",
        message: `This process does not expose a native ${host} agent-creation probe`,
        evidence: { host, detection: "not_exposed_by_host" },
      }));
      continue;
    }
    try {
      const result = await hostAgentProbe({ host });
      const created = result === true || result?.created === true;
      checks.push(check(created ? {
        id: `adapter.${host}.agent_creation`, component: "adapter_capability", status: "ok",
        message: `The active host confirmed real ${host} agent creation`,
        evidence: { host, created: true, detail: result?.evidence ?? null },
      } : {
        id: `adapter.${host}.agent_creation`, component: "adapter_capability", status: "error",
        message: `The active host could not create a real ${host} agent`,
        evidence: { host, created: false, detail: result?.evidence ?? null },
        remediation: "Inspect the native host permissions and adapter profile reported by the probe.",
      }));
    } catch (error) {
      checks.push(check({
        id: `adapter.${host}.agent_creation`, component: "adapter_capability", status: "error",
        message: `The native ${host} agent-creation probe failed`,
        evidence: { host, error: error.message },
        remediation: "Inspect the native host permissions and adapter profile reported by the probe.",
      }));
    }
  }
}

function addOwnershipBlockedChecks(checks) {
  for (const [id, component, message] of [
    ["configuration.schema", "configuration", "Configuration ownership cannot be established"],
    ["resources.integrity", "resource", "Owned resource checks are blocked"],
    ["managed-blocks.integrity", "managed_block", "Managed-block checks are blocked"],
    ["adapter.codex", "adapter", "Codex adapter ownership cannot be established"],
    ["adapter.claude", "adapter", "Claude adapter ownership cannot be established"],
    ["operations.runs", "operations", "Persisted-run ownership cannot be established"],
    ["operations.workers", "operations", "Worker ownership cannot be established"],
    ["operations.transactions", "operations", "Transaction ownership cannot be established"],
  ]) {
    checks.push(check({
      id, component, status: "blocked", message,
      evidence: { reason: "ownership_manifest_invalid" },
      remediation: "Resolve the installation with its owning product; doctor will not infer ownership from paths alone.",
    }));
  }
}

async function diagnose(projectRoot, definition, hostAgentProbe) {
  const checks = [];
  const plan = repairPlan();
  const ownershipPath = path.join(projectRoot, ".agentic-core", "ownership.json");
  const unsafeOwnershipParent = await unsafePathParent(projectRoot, ownershipPath);
  const ownershipKind = unsafeOwnershipParent ? "unsafe_parent" : await fileKind(ownershipPath);
  let owner;
  let ownershipContent;
  let ownershipError;
  if (ownershipKind === "file") {
    ownershipContent = await readFile(ownershipPath);
    try {
      owner = JSON.parse(ownershipContent.toString("utf8"));
      if (owner?.product !== definition.product) {
        ownershipError = `manifest belongs to ${String(owner?.product ?? "an unknown product")}`;
      } else {
        validateOwnership(owner, "diagnose");
      }
    } catch (error) {
      ownershipError = error.message;
    }
  } else {
    ownershipError = unsafeOwnershipParent
      ? `ownership manifest parent ${unsafeOwnershipParent.path} is ${unsafeOwnershipParent.kind}`
      : `ownership manifest path is ${ownershipKind}`;
  }

  if (ownershipError) {
    checks.push(check({
      id: "installation.manifest", component: "manifest", status: "error",
      message: "A valid agentic-core ownership manifest was not found",
      evidence: { path: ".agentic-core/ownership.json", kind: ownershipKind, error: ownershipError,
        ...(unsafeOwnershipParent ? { unsafeParent: unsafeOwnershipParent } : {}) },
      remediation: "Use the owning product or restore the original manifest; doctor will not repair an unproven installation.",
    }));
    addOwnershipBlockedChecks(checks);
    await addBackendChecks(checks, projectRoot);
    return { diagnosis: summarize(checks), plan };
  }

  checks.push(check({
    id: "installation.manifest", component: "manifest", status: "ok",
    message: "The manifest proves the expected agentic-core ownership boundaries",
    evidence: {
      path: ".agentic-core/ownership.json",
      sha256: sha256(ownershipContent),
      product: owner.product,
      version: owner.version,
      installationId: owner.installationId,
      resources: owner.resources.length,
      managedBlocks: owner.managedBlocks.length,
      ownedDirectories: owner.ownedDirectories.length,
    },
  }));

  const currentVersion = owner.version === definition.version;
  checks.push(check(currentVersion ? {
    id: "installation.version", component: "manifest", status: "ok",
    message: "The installed version matches the running package",
    evidence: { installed: owner.version, running: definition.version },
  } : {
    id: "installation.version", component: "manifest", status: "error",
    message: "The installed version differs from the running package",
    evidence: { installed: owner.version, running: definition.version },
    remediation: "Run agentic-core update with the intended package version; doctor will not perform an implicit update.",
  }));

  const updatedOwner = structuredClone(owner);
  await addResourceChecks({ checks, definition, owner, projectRoot, currentVersion, plan, updatedOwner });
  await addManagedBlockChecks({ checks, definition, owner, projectRoot, currentVersion, plan, updatedOwner });
  await addRunCheck(checks, projectRoot);
  await addWorkerCheck({ checks, projectRoot, plan });
  await addTransactionCheck(checks, projectRoot);
  await addAdapterChecks({ checks, definition, hostAgentProbe });
  await addBackendChecks(checks, projectRoot);

  if (JSON.stringify(updatedOwner) !== JSON.stringify(owner)) {
    plan.addWrite(ownershipPath, Buffer.from(json(updatedOwner)), {
      checkId: "installation.manifest", action: "publish_repaired_hashes", path: ".agentic-core/ownership.json",
    });
  }
  return { diagnosis: summarize(checks), plan };
}

function requestedRepairFault() {
  if (process.env.NODE_ENV !== "test") return undefined;
  const requested = Number.parseInt(process.env.AGENTIC_CORE_TEST_FAIL_AFTER_WRITE ?? "", 10);
  return Number.isSafeInteger(requested) && requested > 0 ? requested : undefined;
}

function cachedHostProbe(probe, projectRoot) {
  if (typeof probe !== "function") return undefined;
  const results = new Map();
  return async ({ host }) => {
    if (!results.has(host)) results.set(host, Promise.resolve().then(() => probe({ host, projectRoot })));
    return results.get(host);
  };
}

async function assertRepairParentsSafe(projectRoot, operations) {
  for (const operation of operations) {
    const unsafeParent = await unsafePathParent(projectRoot, operation.path);
    if (unsafeParent) {
      throw new Error(`Repair target parent ${unsafeParent.path} is ${unsafeParent.kind}`);
    }
  }
}

export async function doctorInstallation(projectDirectory, { repair = false, hostAgentProbe } = {}) {
  const projectRoot = path.resolve(projectDirectory);
  const definition = await installationDefinition();
  const probe = cachedHostProbe(hostAgentProbe, projectRoot);
  const before = await diagnose(projectRoot, definition, probe);
  const report = {
    schemaVersion: 1,
    command: "doctor",
    projectRoot,
    status: before.diagnosis.status,
    diagnosis: before.diagnosis,
    repair: { requested: repair, status: repair ? "pending" : "not_requested", actions: [] },
  };

  if (!repair) return { exitCode: before.diagnosis.status === "healthy" ? 0 : 1, report };
  if (before.diagnosis.status === "healthy") {
    report.repair.status = "not_needed";
    return { exitCode: 0, report };
  }
  report.repair.actions = before.plan.actions;
  if (before.plan.operations.length === 0) {
    report.status = "repair_blocked";
    report.repair.status = "blocked";
    report.repair.reason = "No problem has a safe repair backed by the valid current ownership contract.";
    return { exitCode: 1, report };
  }

  try {
    await assertRepairParentsSafe(projectRoot, before.plan.operations);
    await writeTransaction(projectRoot, before.plan.operations, { failAfterWrite: requestedRepairFault() });
  } catch (error) {
    report.status = "repair_failed";
    report.repair.status = "failed";
    report.repair.error = { message: error.message };
    return { exitCode: 1, report };
  }

  const after = await diagnose(projectRoot, definition, probe);
  report.postRepair = after.diagnosis;
  report.status = after.diagnosis.status === "healthy" ? "repaired" : "partially_repaired";
  report.repair.status = "completed";
  return { exitCode: after.diagnosis.status === "healthy" ? 0 : 1, report };
}
