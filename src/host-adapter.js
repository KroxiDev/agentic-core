const HOSTS = new Set(["codex", "claude"]);
const PROFILE_BY_ROLE = new Map([
  ["Explorador", "agentic-read"],
  ["Planificador", "agentic-read"],
  ["Evaluador", "agentic-read"],
  ["Implementador", "agentic-production"],
  ["Refactor", "agentic-production"],
  ["Tester", "agentic-tests"],
  ["Verificador", "agentic-tests"],
  ["Documentador", "agentic-docs"],
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function profileForRole(host, role) {
  if (!HOSTS.has(host)) throw new Error(`Unsupported agent host: ${String(host)}`);
  const profile = PROFILE_BY_ROLE.get(role);
  if (profile === undefined) throw new Error(`Unsupported runtime role: ${String(role)}`);
  return profile;
}

function validateSkills(role, skills) {
  if (!Array.isArray(skills) || skills.some((skill) => typeof skill !== "string")) {
    throw new Error("Runtime brief skills must be a string array");
  }
  for (const skill of skills) {
    if (skill === "agentic-tdd" && role !== "Implementador") {
      throw new Error("agentic-tdd is restricted to the Implementador role");
    }
    if (skill === "agentic-grilling" && role !== "Planificador") {
      throw new Error("agentic-grilling is restricted to the Planificador role");
    }
    if (skill !== "agentic-tdd" && skill !== "agentic-grilling") {
      throw new Error(`Unsupported runtime skill: ${skill}`);
    }
  }
}

export function parseAgentHandoff(response) {
  if (typeof response !== "string") throw new Error("Agent hand-off must be raw JSON text");
  let handoff;
  try {
    handoff = JSON.parse(response.trim());
  } catch {
    throw new Error("Agent hand-off must contain only one raw JSON value");
  }
  if (!plainObject(handoff)) throw new Error("Agent hand-off JSON must be an object");
  return handoff;
}

export async function runHostAgent({ host, brief, spawnAgent }) {
  if (!plainObject(brief) || !plainObject(brief.role) || typeof brief.role.name !== "string") {
    throw new Error("Runtime brief must identify a role");
  }
  if (typeof spawnAgent !== "function") throw new Error("A real host agent creator is required");
  const skills = brief.skills ?? [];
  validateSkills(brief.role.name, skills);
  const response = await spawnAgent({
    agent: profileForRole(host, brief.role.name),
    prompt: JSON.stringify(brief),
    skills: [...skills],
  });
  return parseAgentHandoff(response);
}
