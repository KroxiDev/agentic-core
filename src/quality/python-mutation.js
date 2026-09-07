import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfiguration } from "../installation/install.js";
import { privatePython, PYTHON_TOOLS } from "../installation/python.js";
import { writeTransaction } from "../transaction.js";
import { executeCommand, IntegrationError } from "./command.js";
import { budgetSummary, formatBudget, withCurrentTaskBudget } from "./task-budget.js";
import { readActiveTask } from "./task-baseline.js";
import { captureProjectInputs, inputHash, publicCheckpoint } from "./project-inputs.js";
import { createProjectCopy, dependencyFingerprint, isolatedCommand, verifyProjectIntegrity } from "./project-copy.js";
import { observeProjectTests, projectTestIdentity } from "./python-project.js";

const adapter = fileURLToPath(new URL("agentic_mutation.py", import.meta.url));
const reference = ".agentic-core/quality/mutation.json";
const hash = (value) => inputHash(JSON.stringify(value));
const fail = (code, message) => new IntegrationError(code, message);
const terminal = new Set(["budget_exhausted", "budget_interrupted", "termination_failed", "command_interrupted", "pytest_interrupted"]);

function classify(result) {
  if (result.code === "tests_passed") return "survived";
  if (result.code === "tests_failed" && result.suite?.failures?.length
    && result.suite.failures.every((failure) => ["assertion", "production_exception"].includes(failure.kind))) return "killed";
  if (result.code === "command_timeout") return "timeout";
  if (terminal.has(result.code)) return "interrupted";
  return "error";
}

async function storedReport(root) {
  for (const relative of [".agentic-core", ".agentic-core/quality"]) {
    const directory = path.join(root, relative);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe");
    } catch (error) {
      if (error.code === "ENOENT" && relative.endsWith("/quality")) await mkdir(directory);
      else throw fail("mutation_report_unsafe", "La ubicación del informe de mutación no es segura");
    }
  }
  try {
    const target = path.join(root, reference);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe");
    const content = await readFile(target);
    const document = JSON.parse(content);
    if (document.kind !== "mutation" || document.result?.command !== "mutation"
      || document.result?.schemaVersion !== 1 || document.result.reference !== reference
      || document.sha256 !== hash(document.result)) throw new Error("foreign");
    return { content, result: document.result };
  } catch (error) {
    if (error.code === "ENOENT") return { content: null };
    throw fail("mutation_report_conflict", "El informe de mutación es ajeno o divergente; se conserva");
  }
}

async function generate(root, checkpoint, copy, timeoutMs) {
  const sources = checkpoint.entries.filter((entry) => entry.kind === "measured_code" && entry.path.endsWith(".py"));
  const request = path.join(copy.temporary, "mutations.json");
  await writeFile(request, JSON.stringify({ sources: sources.map((entry) => ({ ...entry, content: entry.content.toString("base64") })) }));
  const result = await executeCommand({ executable: privatePython(path.join(root, ".agentic-core/tools")), args: ["-I", "-B", adapter, request] },
    { cwd: copy.temporary, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs });
  let document;
  try { document = JSON.parse(result.stdout); } catch { /* Typed failure below. */ }
  if (result.exitCode !== 0 || document?.engine !== "mutate4py" || document.version !== PYTHON_TOOLS.mutate4py || !Array.isArray(document.mutants)) {
    throw fail("mutation_generation_failed", "mutate4py no pudo generar mutantes compatibles con el código del proyecto");
  }
  const ids = new Set();
  for (const mutant of document.mutants) {
    const entry = sources.find((source) => source.path === mutant.file);
    if (!entry || entry.sha256 !== mutant.sourceHash || ids.has(mutant.id)
      || !Number.isInteger(mutant.line) || mutant.line < 1
      || inputHash(Buffer.from(mutant.content, "base64")) !== mutant.mutatedHash) {
      throw fail("invalid_mutation_evidence", "El generador devolvió un mutante sin identidad íntegra");
    }
    ids.add(mutant.id);
  }
  return document.mutants;
}

// Remove only outputs inside our disposable copy; never traverse a generated link.
async function resetOutputs(checkpoint, copyRoot) {
  const files = new Set(checkpoint.inventory.map((entry) => entry.path));
  const visit = async (directory, relative = "") => {
    for (const name of await readdir(directory)) {
      const file = relative ? `${relative}/${name}` : name;
      const target = path.join(directory, name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        if (files.has(file)) throw fail("input_integrity_changed", "Un input de la copia fue reemplazado por un enlace");
        await unlink(target);
      } else if (info.isDirectory()) {
        await visit(target, file);
        if (![...files].some((input) => input.startsWith(`${file}/`))) await rmdir(target);
      } else if (!files.has(file)) await unlink(target);
    }
  };
  await visit(copyRoot);
}

async function executeMutants(root, config, checkpoint, identity, report) {
  const unit = config.integration.python;
  const copy = await createProjectCopy(checkpoint);
  let terminationConfirmed = true;
  report.resources = { copies: 1, workers: 1, maximumWorkers: config.limits.operation.workers };
  let context;
  const integrity = async (phase, expected = checkpoint) => {
    const value = await verifyProjectIntegrity(checkpoint, unit, copy.root, phase, expected);
    value.dependencies = await dependencyFingerprint(identity.protectedPaths) === identity.dependencies ? "preserved" : "changed";
    if (value.dependencies !== "preserved") value.status = "NO_VERIFICADO";
    report.integrity = value;
    if (value.status !== "preserved") throw fail("input_integrity_changed", "Los inputs cambiaron; se preserva el original y se detiene la mutación");
    return value;
  };
  const observe = async (timeoutMs) => {
    const temporary = await mkdtemp(path.join(copy.temporary, "observation-"));
    try { return await observeProjectTests(root, config, identity.python, { ...context, budget: () => timeoutMs }, temporary); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  };
  try {
    context = { ...identity.context, ...isolatedCommand(unit, identity.python, checkpoint, copy.root, process.env), checkpoint, copyRoot: copy.root };
    await integrity("preparation");
    const started = performance.now();
    const baseline = await observe(config.limits.operation.commandTimeoutMs);
    terminationConfirmed = baseline.code !== "termination_failed";
    const referenceMs = Math.max(1, Math.ceil(performance.now() - started));
    report.baseline = { code: baseline.code, suite: baseline.suite, durationMs: referenceMs, effectiveCommand: baseline.effectiveCommand };
    await integrity("baseline");
    if (baseline.code !== "tests_passed") throw new IntegrationError(baseline.code, "La referencia no aprobó el comando autoritativo; no se ejecutaron mutantes", baseline.exitCode || 2);
    await resetOutputs(checkpoint, copy.root);
    report.timeout = { referenceMs, multiplier: 3, minimumMs: 1000,
      requestedMs: Math.min(config.limits.operation.commandTimeoutMs, Math.max(1000, referenceMs * 3)) };
    const mutants = await generate(root, checkpoint, copy, config.limits.operation.commandTimeoutMs);
    report.generated = mutants.length;
    for (const mutant of mutants) {
      const { content, ...detail } = mutant;
      const coverage = baseline.coverage.files?.[mutant.file];
      if (!coverage || !Array.isArray(coverage.executed_lines) || !Array.isArray(coverage.missing_lines)) {
        report.details.push({ ...detail, status: "error", code: "coverage_unattributed" });
        continue;
      }
      if (!coverage.executed_lines.includes(mutant.line) && coverage.missing_lines.includes(mutant.line)) {
        report.details.push({ ...detail, status: "uncovered", code: "known_uncovered" });
        continue;
      }
      await integrity("before_mutant");
      const original = checkpoint.entries.find((entry) => entry.path === mutant.file);
      const mutated = Buffer.from(content, "base64");
      const target = path.join(copy.root, mutant.file);
      await writeTransaction(copy.root, [{ path: target, content: mutated, expectedContent: original.content }]);
      await chmod(target, original.mode);
      const expected = { ...checkpoint, inventory: checkpoint.inventory.map((entry) => entry.path === mutant.file ? { ...entry, sha256: mutant.mutatedHash } : entry) };
      let outcome;
      const testStarted = performance.now();
      try { outcome = await observe(report.timeout.requestedMs); }
      catch (error) { outcome = { code: error.code ?? "mutation_execution_failed" }; }
      if (outcome.code === "pytest_interrupted" && outcome.suite?.collectionErrors > 0) outcome.code = "pytest_collection_failed";
      const item = { ...detail, status: classify(outcome), code: outcome.code, durationMs: Math.ceil(performance.now() - testStarted),
        timeoutMs: outcome.effectiveCommand?.timeoutMs, suite: outcome.suite };
      report.details.push(item);
      if (outcome.code === "termination_failed") {
        terminationConfirmed = false;
        item.restored = false;
        report.integrity = { status: "NO_VERIFICADO", phase: "termination", restored: false };
        throw new IntegrationError(outcome.code, "No se confirmó la terminación; se conserva la copia sin restaurarla ni reutilizarla", 5);
      }
      try {
        await integrity("mutant", expected);
        await writeTransaction(copy.root, [{ path: target, content: original.content, expectedContent: mutated }]);
        await chmod(target, original.mode);
        await integrity("restoration");
        item.restored = true;
        await resetOutputs(checkpoint, copy.root);
      } catch (error) { item.status = "error"; item.code = error.code ?? "mutation_restoration_failed"; throw error; }
      if (terminal.has(outcome.code)) throw new IntegrationError(outcome.code, "La ejecución fue interrumpida; se conservan resultados parciales", 6);
    }
    await integrity("completed");
    report.complete = true;
    report.code = "mutation_execution_complete";
  } finally {
    report.resources.terminationConfirmed = terminationConfirmed;
    report.resources.retained = !terminationConfirmed;
    if (terminationConfirmed) await copy.dispose();
  }
}

export async function runPythonMutation(root) {
  try {
    return await withCurrentTaskBudget(root, async () => {
      const stored = await storedReport(root);
      const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
      const active = await readActiveTask(root);
      const task = active?.task;
      const checkpoint = await captureProjectInputs(root, config.integration.python);
      if (checkpoint.issues.length) throw fail("input_checkpoint_incompatible", "Los inputs no admiten una copia fiel y privada");
      const identity = await projectTestIdentity(root, config);
      identity.protectedPaths.push(path.join(root, ".agentic-core/tools"));
      identity.dependencies = await dependencyFingerprint(identity.protectedPaths);
      const evidenceIdentity = hash({ task, inputs: publicCheckpoint(checkpoint), execution: identity.identity, dependencies: identity.dependencies });
      if (task && stored.result?.evidenceIdentity === evidenceIdentity && stored.result.complete
        && stored.result.integrity?.status === "preserved"
        && stored.result.details.every((item) => ["killed", "survived", "uncovered"].includes(item.status))) {
        return { ...stored.result, reused: true, budget: budgetSummary() };
      }
      const report = { command: "mutation", schemaVersion: 1, reference, status: "NO_VERIFICADO", exitCode: 2,
        code: "mutation_execution_incomplete", message: "Ejecución individual de mutantes; la selección y aprobación Full requieren #50",
        engine: { name: "mutate4py", version: PYTHON_TOOLS.mutate4py }, taskId: task?.id ?? null, evidenceIdentity,
        inputs: publicCheckpoint(checkpoint), complete: false, details: [], reused: false };
      try { await executeMutants(root, config, checkpoint, identity, report); }
      catch (error) {
        report.code = error.code ?? "mutation_internal_error";
        report.exitCode = error.exitCode ?? 5;
        report.message = error instanceof IntegrationError ? error.message : "La mutación no pudo completarse; consulte la integridad y los resultados parciales";
      }
      report.summary = Object.fromEntries(["killed", "survived", "uncovered", "timeout", "error", "interrupted"].map((status) => [status, report.details.filter((item) => item.status === status).length]));
      report.pending = Math.max(0, (report.generated ?? 0) - report.details.length);
      report.budget = budgetSummary();
      if ((await readActiveTask(root))?.sha256 !== active?.sha256) throw fail("task_metadata_conflict", "La tarea cambió durante la mutación; se conserva el informe previo");
      await writeTransaction(root, [{ path: path.join(root, reference), expectedContent: stored.content,
        content: Buffer.from(`${JSON.stringify({ kind: "mutation", sha256: hash(report), result: report })}\n`) }]);
      return report;
    });
  } catch (error) {
    return { command: "mutation", status: "NO_VERIFICADO", code: error.code ?? "mutation_internal_error", exitCode: error.exitCode ?? 5,
      message: error instanceof IntegrationError ? error.message : "No se pudo completar la ejecución de mutación", budget: error.budget };
  }
}

export async function runPythonMutationCli(args, io = process) {
  const result = args.length === 1 ? await runPythonMutation(process.cwd())
    : { status: "NO_VERIFICADO", code: "invalid_usage", exitCode: 4, message: "Use agentic-quality mutate; el alcance se declara en config.json" };
  if (io.env?.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    io.stdout.write(`${result.status} [${result.code}] ${result.message}\n`);
    if (result.summary) io.stdout.write(`Mutantes: ${result.summary.killed} detectados; ${result.summary.survived} supervivientes; ${result.summary.uncovered} sin cobertura; ${result.summary.timeout} timeouts; ${result.summary.error} errores; ${result.summary.interrupted} interrumpidos; ${result.pending} pendientes\n`);
    for (const item of (result.details ?? []).filter((detail) => ["error", "timeout", "interrupted"].includes(detail.status)).slice(0, 3)) {
      io.stdout.write(`${item.file}:${item.line} [${item.code}]\n`);
    }
    io.stdout.write(`${result.reference ? `Informe: ${result.reference}\n` : ""}${formatBudget(result.budget)}`);
  }
  return result.exitCode;
}
