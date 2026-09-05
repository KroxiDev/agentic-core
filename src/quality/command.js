import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

export class IntegrationError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function commandBudget(limits) {
  const deadline = performance.now() + limits.totalBudgetMs;
  return () => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new IntegrationError("budget_exhausted", "Se agotó el presupuesto de comprobaciones", 6);
    return Math.max(1, Math.min(2147483647, Math.floor(limits.commandTimeoutMs), remaining));
  };
}

async function stopTree(child) {
  if (process.platform === "win32") {
    await promisify(execFile)("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

// No shell parsing. A wrapper is a normal executable, and its children share the deadline.
export function executeCommand(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let failure;
    let stopping;
    const stop = (error) => {
      if (stopping) return;
      failure = error;
      stopping = stopTree(child).catch(() => {
        failure = new IntegrationError("termination_failed", "No se pudo confirmar la terminación del árbol del comando", 5);
        child.kill("SIGKILL");
      });
    };
    const timer = setTimeout(() => stop(new IntegrationError("command_timeout", "El comando superó su límite de tiempo", 6)), timeoutMs);
    for (const [stream, capture] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 10 * 1024 * 1024) stop(new IntegrationError("command_output_limit", "La salida del comando superó el límite de 10 MiB", 5));
        else if (capture) stdout += chunk.toString("utf8");
      });
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new IntegrationError("command_unavailable", "No se pudo iniciar el comando; revise ejecutable, directorio y permisos", error.code === "EINVAL" ? 4 : 2));
    });
    child.on("close", async (exitCode, signal) => {
      clearTimeout(timer);
      await stopping;
      if (failure) reject(failure);
      else if (signal) reject(new IntegrationError("command_interrupted", "El comando fue interrumpido", 6));
      else resolve({ exitCode, stdout });
    });
  });
}
