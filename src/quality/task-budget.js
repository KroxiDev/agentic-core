import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readConfiguration } from "../installation/install.js";
import { writeTransaction } from "../transaction.js";
import { inputHash } from "./project-inputs.js";
import { IntegrationError, verificationBudget } from "./command.js";
import { readActiveTask } from "./task-baseline.js";

const reference = ".agentic-core/quality/budget.json";
const hash = (value) => inputHash(JSON.stringify(value));
const failure = (code, message) => new IntegrationError(code, message, 2);

function validLedger(ledger) {
  return ledger?.schemaVersion === 1 && typeof ledger.task === "string"
    && Number.isSafeInteger(ledger.consumedMs) && ledger.consumedMs >= 0
    && Number.isSafeInteger(ledger.commands) && ledger.commands >= 0
    && Number.isSafeInteger(ledger.reservedMs) && ledger.reservedMs >= 0;
}

async function safeDirectory(root) {
  for (const relative of [".agentic-core", ".agentic-core/quality"]) {
    const directory = path.join(root, relative);
    try { await mkdir(directory); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw failure("budget_unsafe", "El directorio de presupuesto no es seguro; se conserva");
    }
  }
}

async function readLedger(root) {
  const file = path.join(root, reference);
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("type");
    const content = await readFile(file);
    const { ledger, sha256 } = JSON.parse(content);
    if (sha256 !== hash(ledger) || !validLedger(ledger)
      || ledger.pending !== undefined && (!validLedger(ledger.pending) || ledger.pending.pending !== undefined)) throw new Error("identity");
    return { ledger, content };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw failure("budget_invalid", "El presupuesto está corrupto o es ajeno; no se reinicia");
  }
}

export function budgetSummary() {
  return verificationBudget.getStore()?.summary();
}

export function formatBudget(budget) {
  return budget ? `Presupuesto: ${budget.consumedMs ?? "desconocido"}/${budget.totalBudgetMs ?? "desconocido"} ms; timeout por comando: ${budget.commandTimeoutMs ?? "desconocido"} ms; concurrencia máxima: ${budget.workers ?? "desconocida"}${budget.reference ? `; informe: ${budget.reference}` : ""}\n` : "";
}

export async function readTaskBudget(root, taskId) {
  const stored = await readLedger(root);
  const ledger = stored?.ledger.task === taskId ? stored.ledger : stored?.ledger.pending?.task === taskId ? stored.ledger.pending : null;
  if (!ledger) return { status: "NO_VERIFICADO", code: "budget_missing", reference };
  const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
  const { pending: _pending, ...current } = ledger;
  return { ...config.limits.operation, ...current, reference,
    remainingMs: Math.max(0, config.limits.operation.totalBudgetMs - ledger.consumedMs - ledger.reservedMs) };
}

export async function withCurrentTaskBudget(root, operation) {
  const current = verificationBudget.getStore();
  if (current) {
    if (current.root !== path.resolve(root)) throw failure("budget_context_conflict", "No se comparte presupuesto entre instalaciones");
    return operation();
  }
  const loaded = await readActiveTask(root);
  const { rejectFull } = await import("./full-deprecation.js");
  rejectFull(loaded?.task.mode);
  return withTaskBudget(root, loaded?.task.id ?? null, async () => {
    const result = await operation();
    return { ...result, budget: budgetSummary() };
  });
}

// One owner per installation. Reservations are persisted before spawn, so a
// crashed controller cannot turn an interrupted command into free verification.
// Future mutation workers must executeCommand inside this same async context.
export async function withTaskBudget(root, taskId, operation, { newTask = false } = {}) {
  const current = verificationBudget.getStore();
  if (current) {
    if (current.root !== path.resolve(root) || current.taskId !== taskId) {
      throw failure("budget_context_conflict", "El contexto pertenece a otra instalación o tarea");
    }
    return operation();
  }
  const config = await readConfiguration(path.join(root, ".agentic-core/config.json"));
  const limits = config.limits.operation;
  if (taskId === null) {
    const ledger = { consumedMs: 0, reservedMs: 0, commands: 0 };
    const budget = executionBudget(root, taskId, limits, ledger, async () => {});
    try { return await verificationBudget.run(budget, operation); }
    catch (error) { error.budget = budget.summary(); throw error; }
  }
  await safeDirectory(root);
  const lockPath = path.join(root, ".agentic-core/quality/budget.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); }
  catch { throw failure("budget_busy", "Otra operación posee el presupuesto; espere su finalización. Si fue interrumpida, compruebe que sus procesos terminaron antes de retirar budget.lock"); }
  const lockContent = Buffer.from(JSON.stringify({ owner: randomUUID(), pid: process.pid }));
  try {
    await lock.writeFile(lockContent);
    let stored = await readLedger(root);
    if (stored?.ledger.pending?.task === taskId && (await readActiveTask(root))?.task.id === taskId) {
      const ledger = stored.ledger.pending;
      const content = Buffer.from(`${JSON.stringify({ ledger, sha256: hash(ledger) })}\n`);
      await writeTransaction(root, [{ path: path.join(root, reference), content, expectedContent: stored.content }]);
      stored = { ledger, content };
    }
    if (stored && stored.ledger.task !== taskId && !newTask) {
      throw failure("budget_task_conflict", "El presupuesto pertenece a otra tarea; no se reinicia");
    }
    if (!stored && !newTask) {
      throw failure("budget_missing", "Falta el presupuesto de la tarea activa; no se inventa consumo cero. Inicie una tarea distinta");
    }
    // A failed task replacement must preserve the old task's budget while
    // retaining the attempted baseline cost for a retry of the pending task.
    let replacing = Boolean(stored && stored.ledger.task !== taskId);
    const previous = stored?.ledger;
    let ledger = replacing && previous.pending?.task === taskId ? { ...previous.pending }
      : !stored || replacing ? { schemaVersion: 1, task: taskId, consumedMs: 0, reservedMs: 0, commands: 0 }
        : { ...stored.ledger };
    if (ledger.reservedMs) {
      throw failure("budget_interrupted", "Hay una reserva de ejecución inconclusa; se conserva el consumo y no se permite aprobación");
    }
    const persist = async () => {
      const record = replacing ? { ...previous, pending: ledger } : ledger;
      const content = Buffer.from(`${JSON.stringify({ ledger: record, sha256: hash(record) })}\n`);
      await writeTransaction(root, [{ path: path.join(root, reference), content, expectedContent: stored?.content ?? null }]);
      stored = { ledger: { ...record }, content };
    };
    await persist();
    const budget = executionBudget(root, taskId, limits, ledger, persist);
    try {
      const result = await verificationBudget.run(budget, operation);
      if (replacing && (await readActiveTask(root))?.task.id === taskId) {
        replacing = false;
        await persist();
      }
      return result;
    }
    catch (error) { error.budget = budget.summary(); throw error; }
  } finally {
    await lock.close();
    try { await writeTransaction(root, [{ type: "delete", path: lockPath, expectedContent: lockContent }]); }
    catch { throw failure("budget_lock_conflict", "El bloqueo cambió durante la operación; se conserva y no se emite aprobación"); }
  }
}

function executionBudget(root, taskId, limits, ledger, persist) {
  let active = 0;
  let interrupted = false;
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  return {
    root: path.resolve(root), taskId,
    summary: () => ({ ...limits, consumedMs: ledger.consumedMs, reservedMs: ledger.reservedMs,
      remainingMs: Math.max(0, limits.totalBudgetMs - ledger.consumedMs - ledger.reservedMs),
      commands: ledger.commands, reference: taskId === null ? null : reference, accounting: "sum_command_elapsed_ms" }),
    reserve: (requested) => serialize(async () => {
      if (interrupted) throw failure("budget_interrupted", "No se confirmó la terminación de un comando; se detienen las comprobaciones");
      if (active >= limits.workers) throw new IntegrationError("concurrency_limit", "Se alcanzó el límite de comandos concurrentes", 6);
      const remaining = limits.totalBudgetMs - ledger.consumedMs - ledger.reservedMs;
      if (remaining <= 0) throw new IntegrationError("budget_exhausted", "Se agotó el presupuesto de comprobaciones", 6);
      const commandLimit = Math.min(requested, limits.commandTimeoutMs, 2147483647);
      const timeoutMs = Math.max(1, Math.floor(Math.min(commandLimit, remaining)));
      ledger.reservedMs += timeoutMs;
      ledger.commands += 1;
      await persist();
      active += 1;
      return { timeoutMs, budgetLimited: remaining <= commandLimit };
    }),
    settle: (reservation, elapsed, terminationFailed = false) => serialize(async () => {
      if (!terminationFailed) ledger.reservedMs -= reservation.timeoutMs;
      else interrupted = true;
      ledger.consumedMs += elapsed;
      active -= 1;
      await persist();
    }),
  };
}
