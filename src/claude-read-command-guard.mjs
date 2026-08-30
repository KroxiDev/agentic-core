import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const READ_ROLES = new Set(["Explorador", "Planificador", "Evaluador", "Refactor"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const QUALITY_ARTIFACTS = new Map([
  ["crap", "artifacts/crap.json"],
  ["mutate", "artifacts/mutation.json"],
]);

function sameRole(left, right) {
  return left?.sequence === right?.sequence
    && left?.name === right?.name
    && left?.instanceId === right?.instanceId;
}

function declaredQualityCommand(brief, state, runId) {
  if (brief?.runId !== runId || !sameRole(brief.role, state.currentRole)) return undefined;
  if (!READ_ROLES.has(brief.role.name)) return undefined;
  if (brief.permissions?.read !== true
    || !Array.isArray(brief.permissions.write)
    || brief.permissions.write.length !== 1
    || brief.permissions.write[0] !== "quality_artifacts") return undefined;
  const command = brief.qualityGate?.command;
  if (command?.tool !== "agentic-quality" || !Array.isArray(command.args)) return undefined;
  const [qualityTool, runFlag, commandRunId, outputFlag, outputPath, ...rest] = command.args;
  if (rest.length > 0 || runFlag !== "--run" || commandRunId !== runId || outputFlag !== "--output") {
    return undefined;
  }
  if (QUALITY_ARTIFACTS.get(qualityTool) !== outputPath) return undefined;
  return [command.tool, ...command.args].join(" ");
}

async function transcriptBrief(event) {
  if (typeof event?.transcript_path !== "string") return undefined;
  const lines = (await readFile(event.transcript_path, "utf8")).split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    const entry = JSON.parse(line);
    if (entry?.type !== "user" || entry?.message?.role !== "user"
      || typeof entry.message.content !== "string") continue;
    if (typeof event.agent_id === "string" && entry.agentId !== event.agent_id) return undefined;
    return JSON.parse(entry.message.content);
  }
  return undefined;
}

async function activeQualityCommand(projectRoot, event) {
  const promptBrief = await transcriptBrief(event);
  if (typeof promptBrief?.runId !== "string") return undefined;
  const runRoot = path.join(projectRoot, ".agentic-core", "runs", promptBrief.runId);
  const state = JSON.parse(await readFile(path.join(runRoot, "state.json"), "utf8"));
  if (state?.status !== "running" || !sameRole(promptBrief.role, state.currentRole)) return undefined;
  const entries = await readdir(path.join(runRoot, "briefs"), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const stored = JSON.parse(await readFile(path.join(runRoot, "briefs", entry.name), "utf8"));
    if (JSON.stringify(stored) !== JSON.stringify(promptBrief)) continue;
    return declaredQualityCommand(stored, state, promptBrief.runId);
  }
  return undefined;
}

export async function authorizeClaudeReadCommand(projectRoot, event) {
  if (event?.agent_type !== "agentic-read") {
    return { allowed: false, reason: "command did not originate from agentic-read" };
  }
  if (!SHELL_TOOLS.has(event.tool_name) || typeof event.tool_input?.command !== "string") {
    return { allowed: false, reason: "agentic-read may use only guarded shell commands" };
  }
  const command = event.tool_input.command;
  if (command === "node --version") {
    return { allowed: true, reason: "harmless preflight command" };
  }
  try {
    if (command === await activeQualityCommand(path.resolve(projectRoot), event)) {
      return { allowed: true, reason: "active brief quality-artifact command" };
    }
  } catch {
    return { allowed: false, reason: "agentic-read guard failed closed" };
  }
  return { allowed: false, reason: "command is outside the active agentic-read brief" };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function main() {
  let decision;
  try {
    decision = await authorizeClaudeReadCommand(process.cwd(), JSON.parse(await readStdin()));
  } catch {
    decision = { allowed: false, reason: "agentic-read guard failed closed" };
  }
  if (!decision.allowed) {
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: decision.reason,
    },
  }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
