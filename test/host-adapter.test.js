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
  Refactor: "read",
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

test("Refactor remains bound to agentic-read with only the quality artifact exception", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const codex = await readFile(path.join(repositoryRoot, "adapters", "codex", "agents", "agentic-read.toml"), "utf8");
  const claude = await readFile(path.join(repositoryRoot, "adapters", "claude", "agents", "agentic-read.md"), "utf8");
  for (const host of ["codex", "claude"]) assert.equal(profileForRole(host, "Refactor"), "agentic-read");
  assert.match(codex, /refactor/i);
  assert.match(codex, /quality_artifacts/);
  assert.match(codex, /Do not edit production/i);
  assert.match(claude, /refactor/i);
  assert.match(claude, /quality_artifacts/);
  assert.doesNotMatch(claude, /tools:.*(?:Edit|Write)(?:,|$)/i);
});

test("the host-provided invoker receives exactly the complete brief JSON with or without TDD", async () => {
  const response = JSON.stringify({ schemaVersion: 1, status: "completed", summary: "done", payload: {} });
  for (const [host, skills] of [["codex", []], ["claude", ["agentic-tdd"]]]) {
    const brief = {
      schemaVersion: 1,
      runId: `run-${host}`,
      role: { sequence: 2, name: "Implementador", instanceId: `role-${host}` },
      mission: "Implement the approved behavior.",
      skills,
      permissions: { read: true, write: ["production", "tests"] },
    };
    const calls = [];
    const result = await runHostAgent({
      host,
      brief,
      invokeHostAgent: async (request) => {
        calls.push(request);
        return response;
      },
    });
    assert.deepEqual(calls, [{ profile: "agentic-production", prompt: JSON.stringify(brief) }]);
    assert.deepEqual(result, JSON.parse(response));
  }
});

test("agent responses are parsed only as a raw final hand-off JSON object", () => {
  const handoff = { schemaVersion: 1, status: "completed", summary: "done", payload: {} };
  assert.deepEqual(parseAgentHandoff(JSON.stringify(handoff)), handoff);
  assert.throws(() => parseAgentHandoff(` ${JSON.stringify(handoff)}`), /wrapper whitespace/i);
  assert.throws(() => parseAgentHandoff(`${JSON.stringify(handoff)}\n`), /wrapper whitespace/i);
  assert.throws(() => parseAgentHandoff(`Result:\n${JSON.stringify(handoff)}`), /raw JSON/i);
  assert.throws(() => parseAgentHandoff(`\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\``), /raw JSON/i);
  assert.throws(() => parseAgentHandoff(`${JSON.stringify(handoff)}\n${JSON.stringify(handoff)}`), /raw JSON/i);
  assert.throws(() => parseAgentHandoff('{"schemaVersion":1'), /raw JSON/i);
  assert.throws(() => parseAgentHandoff("[]"), /object/i);
  assert.throws(() => parseAgentHandoff('"partial"'), /object/i);
  assert.throws(() => parseAgentHandoff(null), /raw JSON text/i);
});

test("conditional and unknown skills cannot be loaded outside their contract", async () => {
  const invokeHostAgent = async () => "{}";
  await assert.rejects(runHostAgent({
    host: "claude",
    brief: {
      role: { name: "Planificador" },
      skills: ["agentic-tdd"],
      permissions: { read: true, write: [] },
    },
    invokeHostAgent,
  }), /agentic-tdd.*Implementador/i);
  await assert.rejects(runHostAgent({
    host: "claude",
    brief: {
      role: { name: "Implementador" },
      skills: ["agentic-grilling"],
      permissions: { read: true, write: ["production", "tests"] },
    },
    invokeHostAgent,
  }), /agentic-grilling.*Planificador/i);
  await assert.rejects(runHostAgent({
    host: "codex",
    brief: {
      role: { name: "Implementador" },
      skills: ["unknown-skill"],
      permissions: { read: true, write: ["production", "tests"] },
    },
    invokeHostAgent,
  }), /unsupported runtime skill.*unknown-skill/i);
  await assert.rejects(runHostAgent({
    host: "codex",
    brief: {
      role: { name: "Implementador" },
      skills: ["agentic-tdd"],
      permissions: { read: true, write: ["production"] },
    },
    invokeHostAgent,
  }), /agentic-tdd.*production.*tests/i);
});

test("brief write permissions incompatible with read, test, or documentation roles are rejected", async () => {
  const cases = [
    ["codex", "Planificador", "production"],
    ["codex", "Planificador", "quality_artifacts"],
    ["claude", "Refactor", "tests"],
    ["claude", "Implementador", "quality_artifacts"],
    ["codex", "Tester", "production"],
    ["claude", "Verificador", "production"],
    ["codex", "Documentador", "production"],
    ["claude", "Documentador", "tests"],
  ];
  for (const [host, role, scope] of cases) {
    let invoked = false;
    await assert.rejects(runHostAgent({
      host,
      brief: {
        role: { name: role },
        skills: [],
        permissions: { read: true, write: [scope] },
      },
      invokeHostAgent: async () => {
        invoked = true;
        return "{}";
      },
    }), new RegExp(`${role}.*${scope}|${scope}.*${role}`, "i"));
    assert.equal(invoked, false);
  }
});

test("the adapter accepts only the documented write responsibility for every role", async () => {
  const cases = [
    ["Explorador", []],
    ["Planificador", []],
    ["Evaluador", ["quality_artifacts"]],
    ["Refactor", ["quality_artifacts"]],
    ["Implementador", ["production", "tests", "documentation"]],
    ["Tester", ["tests_when_production_is_correct", "quality_artifacts"]],
    ["Verificador", ["tests_when_production_is_correct", "quality_artifacts"]],
    ["Documentador", ["documentation"]],
  ];
  for (const [role, write] of cases) {
    const result = await runHostAgent({
      host: "codex",
      brief: { role: { name: role }, skills: [], permissions: { read: true, write } },
      invokeHostAgent: async () => "{}",
    });
    assert.deepEqual(result, {});
  }
});

test("native host profiles expose four distinct least-privilege capabilities", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const expectations = {
    read: { codex: 'sandbox_mode = "workspace-write"', claude: "tools: Read, Grep, Glob, Bash, PowerShell, Skill" },
    production: { codex: 'sandbox_mode = "workspace-write"', claude: "tools: Read, Grep, Glob, Edit, Write, Bash, PowerShell" },
    tests: { codex: 'sandbox_mode = "workspace-write"', claude: "tools: Read, Grep, Glob, Edit, Write, Bash, PowerShell" },
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
      assert.match(content, /brief\.permissions/);
      assert.doesNotMatch(content, /Understanding is K\.E\.Y\./);
      assert.match(content, /only the raw final hand-off JSON/i);
    }
  }
});

test("native profile files use only officially supported host fields and tool names", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const toolsByProfile = {
    read: ["Read", "Grep", "Glob", "Bash", "PowerShell", "Skill"],
    production: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "PowerShell", "Skill"],
    tests: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "PowerShell"],
    docs: ["Read", "Grep", "Glob", "Edit", "Write"],
  };
  for (const [profile, expectedTools] of Object.entries(toolsByProfile)) {
    const codex = await readFile(path.join(repositoryRoot, "adapters", "codex", "agents", `agentic-${profile}.toml`), "utf8");
    const codexKeys = codex.split(/\r?\n/)
      .map((line) => line.match(/^([a-z_]+)\s*=/)?.[1])
      .filter(Boolean);
    assert.deepEqual(codexKeys, ["name", "description", "sandbox_mode", "developer_instructions"]);

    const claude = await readFile(path.join(repositoryRoot, "adapters", "claude", "agents", `agentic-${profile}.md`), "utf8");
    const frontmatter = claude.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    assert.ok(frontmatter, `${profile} has frontmatter`);
    const claudeFields = frontmatter.split(/\r?\n/).map((line) => line.match(/^([A-Za-z][A-Za-z]*):/)?.[1]);
    assert.deepEqual(claudeFields, ["name", "description", "tools", "permissionMode"]);
    const tools = frontmatter.match(/^tools:\s*(.*)$/m)?.[1].split(",").map((tool) => tool.trim());
    assert.deepEqual(tools, expectedTools);
    assert.match(frontmatter, /^permissionMode: acceptEdits$/m);
  }
});

test("Claude command-capable profiles allow both supported shell tool names", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const toolsFor = async (profile) => {
    const content = await readFile(
      path.join(repositoryRoot, "adapters", "claude", "agents", `agentic-${profile}.md`),
      "utf8",
    );
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    assert.ok(frontmatter, `${profile} has frontmatter`);
    return frontmatter.match(/^tools:\s*(.*)$/m)?.[1].split(",").map((tool) => tool.trim());
  };

  for (const profile of ["read", "production", "tests"]) {
    const tools = await toolsFor(profile);
    assert.ok(tools.includes("Bash"), `${profile} allows Bash`);
    assert.ok(tools.includes("PowerShell"), `${profile} allows PowerShell`);
  }

  const docsTools = await toolsFor("docs");
  assert.equal(docsTools.includes("Bash"), false);
  assert.equal(docsTools.includes("PowerShell"), false);
});

test("production profiles authorize Implementador tests independently of optional TDD", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  for (const profilePath of [
    path.join(repositoryRoot, "adapters", "codex", "agents", "agentic-production.toml"),
    path.join(repositoryRoot, "adapters", "claude", "agents", "agentic-production.md"),
  ]) {
    const profile = await readFile(profilePath, "utf8");
    assert.match(profile, /production code and tests.*brief\.permissions/is);
    assert.match(profile, /agentic-tdd.*not required.*tests/is);
    assert.match(profile, /documentation.*explicitly.*behavior.*permissions/is);
    assert.doesNotMatch(profile, /do not edit tests/i);
  }
});

test("orquestar is canonical and Claude discovery files are minimal shims", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const canonical = await readFile(path.join(repositoryRoot, "skills", "orquestar", "SKILL.md"), "utf8");
  assert.match(canonical, /\^\(Orquesta\|\\\/orquestar\|\\\$orquestar\)/);
  assert.match(canonical, /role supplied by the runtime/i);
  assert.match(canonical, /JSON\.stringify\(brief\).*exactly.*without.*prefix/is);
  assert.match(canonical, /exact complete final response.*public seam/is);
  assert.match(canonical, /Never parse.*extract.*trim.*repair/is);
  assert.match(canonical, /agentic-tdd.*Implementador/is);
  assert.match(canonical, /agentic-grilling.*Planificador/is);
  assert.match(canonical, /ask.*only.*objective.*verifiable.*criteria/is);
  assert.match(canonical, /reason.*not_specified/is);
  assert.match(canonical, /agentic-grilling.*not.*reason.*missing/is);
  assert.doesNotMatch(canonical, /missing goal, reason, or acceptance criteria/i);
  assert.doesNotMatch(canonical, /Understanding is K\.E\.Y\./);

  for (const skill of ["agentic-tdd", "agentic-grilling"]) {
    const content = await readFile(path.join(repositoryRoot, "skills", skill, "SKILL.md"), "utf8");
    assert.match(content, /\.agentic-core\/golden-rules\.md/);
    assert.doesNotMatch(content, /Understanding is K\.E\.Y\./);
  }

  for (const skill of ["orquestar", "agentic-tdd", "agentic-grilling"]) {
    const shim = await readFile(path.join(repositoryRoot, "adapters", "claude", "skills", skill, "SKILL.md"), "utf8");
    assert.match(shim, new RegExp(`\\.agents/skills/${skill}/SKILL\\.md`));
    assert.ok(shim.split("\n").length <= 9, `${skill} shim is not minimal`);
    assert.doesNotMatch(shim, /Understanding is K\.E\.Y\./);
  }
});
