const HOSTS = new Set(["codex", "claude"]);
const PROFILE_BY_ROLE = new Map([
  ["Explorador", "agentic-read"],
  ["Planificador", "agentic-read"],
  ["Evaluador", "agentic-read"],
  ["Implementador", "agentic-production"],
  ["Refactor", "agentic-read"],
  ["Tester", "agentic-tests"],
  ["Verificador", "agentic-tests"],
  ["Documentador", "agentic-docs"],
]);
const WRITE_SCOPES_BY_ROLE = new Map([
  ["Explorador", new Set()],
  ["Planificador", new Set()],
  ["Evaluador", new Set(["quality_artifacts"])],
  ["Refactor", new Set(["quality_artifacts"])],
  ["Implementador", new Set(["production", "tests", "documentation"])],
  ["Tester", new Set(["tests", "tests_when_production_is_correct", "quality_artifacts"])],
  ["Verificador", new Set(["tests", "tests_when_production_is_correct", "quality_artifacts"])],
  ["Documentador", new Set(["documentation"])],
]);
const WRITE_SCOPES_BY_PROFILE = new Map([
  ["agentic-read", new Set(["quality_artifacts"])],
  ["agentic-production", new Set(["production", "tests", "documentation"])],
  ["agentic-tests", new Set(["tests", "tests_when_production_is_correct", "quality_artifacts"])],
  ["agentic-docs", new Set(["documentation"])],
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

function validateSkills(role, skills, permissions) {
  if (!Array.isArray(skills) || skills.some((skill) => typeof skill !== "string")) {
    throw new Error("Runtime brief skills must be a string array");
  }
  for (const skill of skills) {
    if (skill === "agentic-tdd" && role !== "Implementador") {
      throw new Error("agentic-tdd is restricted to the Implementador role");
    }
    if (skill === "agentic-tdd"
      && (!permissions.write.includes("production") || !permissions.write.includes("tests"))) {
      throw new Error("agentic-tdd requires Implementador permissions for production and tests");
    }
    if (skill === "agentic-grilling" && role !== "Planificador") {
      throw new Error("agentic-grilling is restricted to the Planificador role");
    }
    if (skill !== "agentic-tdd" && skill !== "agentic-grilling") {
      throw new Error(`Unsupported runtime skill: ${skill}`);
    }
  }
}

function validatePermissions(role, profile, permissions) {
  if (!plainObject(permissions) || permissions.read !== true || !Array.isArray(permissions.write)) {
    throw new Error("Runtime brief permissions must declare read: true and a write scope array");
  }
  const unknownKeys = Object.keys(permissions).filter((key) => key !== "read" && key !== "write");
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported runtime brief permission key: ${unknownKeys.join(", ")}`);
  }
  if (permissions.write.some((scope) => typeof scope !== "string")) {
    throw new Error("Runtime brief write permissions must be a string array");
  }
  if (new Set(permissions.write).size !== permissions.write.length) {
    throw new Error("Runtime brief write permissions must not contain duplicates");
  }
  const roleScopes = WRITE_SCOPES_BY_ROLE.get(role);
  const profileScopes = WRITE_SCOPES_BY_PROFILE.get(profile);
  for (const scope of permissions.write) {
    if (!roleScopes.has(scope)) {
      throw new Error(`${role} cannot receive ${scope} write permission`);
    }
    if (!profileScopes.has(scope)) {
      throw new Error(`${profile} cannot provide ${scope} write permission`);
    }
  }
}

export function parseAgentHandoff(response) {
  if (typeof response !== "string") throw new Error("Agent hand-off must be raw JSON text");
  if (response.trim() !== response) {
    throw new Error("Agent hand-off must not contain wrapper whitespace");
  }
  let handoff;
  try {
    handoff = JSON.parse(response);
  } catch {
    throw new Error("Agent hand-off must contain only one raw JSON value");
  }
  if (!plainObject(handoff)) throw new Error("Agent hand-off JSON must be an object");
  return handoff;
}

/**
 * Validate and invoke one native host agent. `invokeHostAgent` is transport supplied by
 * Codex or Claude Code and must resolve with only that agent's final response. Tests may
 * inject a transport double to verify this contract; doing so is not evidence of a real spawn.
 */
export async function runHostAgent({ host, brief, invokeHostAgent }) {
  if (!plainObject(brief) || !plainObject(brief.role) || typeof brief.role.name !== "string") {
    throw new Error("Runtime brief must identify a role");
  }
  if (typeof invokeHostAgent !== "function") throw new Error("A host-provided native agent invoker is required");
  const profile = profileForRole(host, brief.role.name);
  validatePermissions(brief.role.name, profile, brief.permissions);
  const skills = brief.skills ?? [];
  validateSkills(brief.role.name, skills, brief.permissions);
  const response = await invokeHostAgent({
    profile,
    prompt: JSON.stringify(brief),
  });
  return parseAgentHandoff(response);
}
