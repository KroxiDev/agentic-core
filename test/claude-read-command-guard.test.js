import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeClaudeReadCommand } from "../src/claude-read-command-guard.mjs";

async function fixture(t, options = {}) {
  const root = options.root ?? await mkdtemp(path.join(tmpdir(), "agentic read guard "));
  if (options.root === undefined) t.after(() => rm(root, { recursive: true, force: true }));
  const runId = options.runId ?? "12345678-1234-4234-8234-123456789abc";
  const runRoot = path.join(root, ".agentic-core", "runs", runId);
  await mkdir(path.join(runRoot, "briefs"), { recursive: true });
  const role = { sequence: 4, name: "Refactor", instanceId: "role-refactor" };
  await writeFile(path.join(runRoot, "state.json"), JSON.stringify({ status: "running", currentRole: role }));
  const brief = {
    runId,
    role,
    permissions: { read: true, write: ["quality_artifacts"] },
    qualityGate: {
      command: {
        tool: "agentic-quality",
        args: ["crap", "--run", runId, "--output", "artifacts/crap.json"],
      },
    },
  };
  await writeFile(path.join(runRoot, "briefs", "004-refactor.json"), JSON.stringify(brief));
  const transcriptPath = path.join(root, `${runId}.jsonl`);
  await writeFile(transcriptPath, `${JSON.stringify({
    isSidechain: true,
    agentId: `agent-${runId}`,
    type: "user",
    message: { role: "user", content: JSON.stringify(brief) },
  })}\n`);
  return { root, runId, transcriptPath, agentId: `agent-${runId}` };
}

function hookEvent(command, overrides = {}) {
  return {
    agent_type: "agentic-read",
    tool_name: "PowerShell",
    tool_input: { command },
    ...overrides,
  };
}

test("the Claude read guard allows only the harmless preflight command without run state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic read preflight "));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await authorizeClaudeReadCommand(root, hookEvent("node --version")), {
    allowed: true,
    reason: "harmless preflight command",
  });
  assert.equal((await authorizeClaudeReadCommand(root, hookEvent("node --version; echo changed"))).allowed, false);
  assert.equal((await authorizeClaudeReadCommand(root, hookEvent("Set-Content changed.txt changed"))).allowed, false);
});

test("the Claude read guard allows only the exact quality command declared by the child's active brief", async (t) => {
  const { root, runId, transcriptPath, agentId } = await fixture(t);
  const exact = `agentic-quality crap --run ${runId} --output artifacts/crap.json`;
  const event = hookEvent(exact, { transcript_path: transcriptPath, agent_id: agentId });

  assert.deepEqual(await authorizeClaudeReadCommand(root, event), {
    allowed: true,
    reason: "active brief quality-artifact command",
  });
  for (const command of [
    `${exact} `,
    `${exact}; Set-Content changed.txt changed`,
    `agentic-quality crap --run ${runId} --output ../changed.json`,
  ]) {
    assert.equal((await authorizeClaudeReadCommand(root, { ...event, tool_input: { command } })).allowed, false, command);
  }
});

test("the Claude read guard fails closed for the wrong profile, shell, permission, or terminal run", async (t) => {
  const { root, runId, transcriptPath, agentId } = await fixture(t);
  const exact = `agentic-quality crap --run ${runId} --output artifacts/crap.json`;
  const event = hookEvent(exact, { transcript_path: transcriptPath, agent_id: agentId });
  assert.equal((await authorizeClaudeReadCommand(root, { ...event, agent_type: "agentic-tests" })).allowed, false);
  assert.equal((await authorizeClaudeReadCommand(root, { ...event, tool_name: "Edit" })).allowed, false);

  const statePath = path.join(root, ".agentic-core", "runs", runId, "state.json");
  await writeFile(statePath, JSON.stringify({
    status: "completed",
    currentRole: { sequence: 4, name: "Refactor", instanceId: "role-refactor" },
  }));
  assert.equal((await authorizeClaudeReadCommand(root, event)).allowed, false);
});

test("concurrent Claude read agents cannot use another run's quality command", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, {
    root: first.root,
    runId: "22345678-1234-4234-8234-123456789abc",
  });
  const secondCommand = `agentic-quality crap --run ${second.runId} --output artifacts/crap.json`;
  const firstEvent = hookEvent(secondCommand, {
    transcript_path: first.transcriptPath,
    agent_id: first.agentId,
  });

  assert.equal((await authorizeClaudeReadCommand(first.root, firstEvent)).allowed, false);
});
