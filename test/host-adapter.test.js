import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseAgentHandoff, profileForRole, runHostAgent } from "../src/host-adapter.js";

const roles = {
  Explorador: "read",
  Planificador: "read",
  Evaluador: "read",
  Implementador: "production",
  Refactor: "production",
  Tester: "tests",
  Verificador: "tests",
  Documentador: "docs",
};

test("both host adapters select the least-privilege profile for every runtime role", () => {
  for (const host of ["codex", "claude"]) {
    for (const [role, profile] of Object.entries(roles)) {
      assert.equal(profileForRole(host, role), `agentic-${profile}`);
    }
  }
});

test("the host adapter creates a real-agent request with the complete unprefixed brief", async () => {
  const brief = {
    schemaVersion: 1,
    runId: "run-1",
    role: { sequence: 2, name: "Implementador", instanceId: "role-2" },
    mission: "Implement the approved behavior.",
    skills: ["agentic-tdd"],
  };
  const calls = [];
  const response = JSON.stringify({ schemaVersion: 1, status: "completed", summary: "done", payload: {} });

  const result = await runHostAgent({
    host: "codex",
    brief,
    spawnAgent: async (request) => {
      calls.push(request);
      return response;
    },
  });

  assert.deepEqual(calls, [{
    agent: "agentic-production",
    prompt: JSON.stringify(brief),
    skills: ["agentic-tdd"],
  }]);
  assert.deepEqual(result, JSON.parse(response));
});

test("agent responses are parsed only as a raw final hand-off JSON object", () => {
  const handoff = { schemaVersion: 1, status: "completed", summary: "done", payload: {} };
  assert.deepEqual(parseAgentHandoff(JSON.stringify(handoff)), handoff);
  assert.throws(() => parseAgentHandoff(`Result:\n${JSON.stringify(handoff)}`), /raw JSON/i);
  assert.throws(() => parseAgentHandoff(`\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\``), /raw JSON/i);
  assert.throws(() => parseAgentHandoff("[]"), /object/i);
});

test("conditional skills cannot be loaded by an unrelated role", async () => {
  const spawnAgent = async () => "{}";
  await assert.rejects(runHostAgent({
    host: "claude",
    brief: { role: { name: "Planificador" }, skills: ["agentic-tdd"] },
    spawnAgent,
  }), /agentic-tdd.*Implementador/i);
  await assert.rejects(runHostAgent({
    host: "claude",
    brief: { role: { name: "Implementador" }, skills: ["agentic-grilling"] },
    spawnAgent,
  }), /agentic-grilling.*Planificador/i);
});

test("native host profiles expose four distinct least-privilege capabilities", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const expectations = {
    read: { codex: 'sandbox_mode = "read-only"', claude: "tools: Read, Grep, Glob" },
    production: { codex: 'sandbox_mode = "workspace-write"', claude: "tools: Read, Grep, Glob, Edit, Write, Bash" },
    tests: { codex: 'sandbox_mode = "workspace-write"', claude: "tools: Read, Grep, Glob, Edit, Write, Bash" },
    docs: { codex: 'sandbox_mode = "workspace-write"', claude: "tools: Read, Grep, Glob, Edit, Write" },
  };
  for (const [profile, expected] of Object.entries(expectations)) {
    const codex = await readFile(path.join(repositoryRoot, "adapters", "codex", "agents", `agentic-${profile}.toml`), "utf8");
    const claude = await readFile(path.join(repositoryRoot, "adapters", "claude", "agents", `agentic-${profile}.md`), "utf8");
    assert.match(codex, new RegExp(expected.codex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(claude, new RegExp(expected.claude));
    assert.match(codex, new RegExp(`Responsibility: ${profile}`));
    assert.match(claude, new RegExp(`Responsibility: ${profile}`));
    for (const content of [codex, claude]) {
      assert.match(content, /\.agentic-core\/golden-rules\.md/);
      assert.doesNotMatch(content, /Understanding is K\.E\.Y\./);
      assert.match(content, /only the raw final hand-off JSON/i);
    }
  }
});

test("orquestar is canonical and Claude discovery files are minimal shims", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const canonical = await readFile(path.join(repositoryRoot, "skills", "orquestar", "SKILL.md"), "utf8");
  assert.match(canonical, /\^\(Orquesta\|\\\/orquestar\|\\\$orquestar\)/);
  assert.match(canonical, /role supplied by the runtime/i);
  assert.match(canonical, /complete brief JSON.*without.*prefix/is);
  assert.match(canonical, /only.*final.*hand-off JSON/is);
  assert.match(canonical, /agentic-tdd.*Implementador/is);
  assert.match(canonical, /agentic-grilling.*Planificador/is);
  assert.doesNotMatch(canonical, /Understanding is K\.E\.Y\./);

  for (const skill of ["orquestar", "agentic-tdd", "agentic-grilling"]) {
    const shim = await readFile(path.join(repositoryRoot, "adapters", "claude", "skills", skill, "SKILL.md"), "utf8");
    assert.match(shim, new RegExp(`\\.agents/skills/${skill}/SKILL\\.md`));
    assert.ok(shim.split("\n").length <= 9, `${skill} shim is not minimal`);
  }
});
