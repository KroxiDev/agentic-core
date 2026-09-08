import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize } from "../src/init.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function text(relativePath) {
  return readFile(path.join(repositoryRoot, ...relativePath.split("/")), "utf8");
}

test("managed discovery positively routes every activator to orquestar", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentic semantic install "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root, { runtimeSource: null });

  for (const host of ["AGENTS.md", "CLAUDE.md"]) {
    const content = await readFile(path.join(root, host), "utf8");
    assert.match(content, /If a request begins with `Orquesta`, `\/orquestar`, or `\$orquestar`, load and follow `\.agents\/skills\/orquestar\/SKILL\.md`/);
    assert.match(content, /`Orquesta` without a mode means `normal`/);
    assert.match(content, /Never declare an orchestrated executable change complete without a current `QUALITY_OK`/);
    assert.match(content, /Requests without one of those activators run directly/);
  }
  await assert.rejects(stat(path.join(root, ".agentic-core", "runs")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(root, ".agentic-core", "quality")), { code: "ENOENT" });
  const owner = JSON.parse(await readFile(path.join(root, ".agentic-core", "ownership.json"), "utf8"));
  assert.ok(owner.ownedDirectories.includes(".agentic-core/quality"));
  assert.equal(owner.ownedDirectories.includes(".agentic-core/runs"), false);
});

test("orquestar is semantic, mode-complete, and has no retired protocol", async () => {
  const skill = await text("skills/orquestar/SKILL.md");
  for (const activator of ["Orquesta", "/orquestar", "$orquestar"]) assert.match(skill, new RegExp(activator.replace("$", "\\$")));
  for (const mode of ["light", "normal"]) assert.ok(skill.includes(`\`${mode}\``));
  for (const role of ["Especificador", "Planificador", "Implementador", "Tester", "Verificador", "Evaluador", "Arquitecto", "Documentador"]) {
    assert.match(skill, new RegExp(role));
  }
  const roleProfiles = new Map([
    ["Especificador", "agentic-read"],
    ["Planificador", "agentic-read"],
    ["Evaluador", "agentic-read"],
    ["Arquitecto", "agentic-read"],
    ["Implementador", "agentic-production"],
    ["Tester", "agentic-tests"],
    ["Verificador", "agentic-tests"],
    ["Documentador", "agentic-docs"],
  ]);
  const skillLines = skill.split(/\r?\n/u);
  for (const [role, profile] of roleProfiles) {
    assert.ok(
      skillLines.some((line) => line.includes(role) && line.includes(`\`${profile}\``)),
      `${role} must map explicitly to ${profile}`,
    );
  }
  assert.match(skill, /como máximo un agente activo/);
  assert.match(skill, /agentic-quality prepare/);
  assert.match(skill, /agentic-quality verify/);
  assert.match(skill, /hasta dos ciclos de corrección/);
  assert.match(skill, /QUALITY_OK/);
  assert.doesNotMatch(skill, /agentic-core (?:start|resume|approve-mode-change|submit-handoff)/);
  assert.doesNotMatch(skill, /protocol_retry|sandbox_mode|HOST_SANDBOX|request_permissions|raw final/i);
});

test("Light defines the bounded Implementador to Tester loop and native waits", async () => {
  const skill = await text("skills/orquestar/SKILL.md");
  for (const phrase of [
    "Propósito",
    "Responsabilidades",
    "Alcance",
    "Entradas",
    "Criterios de devolución",
    "Golden Rules",
    "Contexto pertinente",
    "Implementador → Tester",
    "dos roles base",
    "El coordinador no cuenta",
    "no implementa producción",
    "nueva instancia de Implementador",
    "contador compartido",
    "dos rondas adicionales",
    "sin aprobación ni cambio de modo",
    "tests funcionales y los controles",
    "recibo vigente",
    "eventos disponibles en Codex",
    "60 segundos",
    "5 minutos",
    "lentitud o silencio por sí solos no reinician",
    "fallo o límite aplicable",
    "sin daemon, hooks nuevos ni promesas",
    "presupuesto acumulado corresponde a comprobaciones",
  ]) {
    assert.ok(skill.includes(phrase), `Light contract is missing: ${phrase}`);
  }
});

test("agentic-tdd keeps red-green semantic without retrospective duplication", async () => {
  const skill = await text("skills/agentic-tdd/SKILL.md");
  assert.match(skill, /prueba válida que falle/);
  assert.match(skill, /volverla verde/);
  assert.match(skill, /producción y tests dentro del alcance/);
  assert.match(skill, /No exige reproducir retrospectivamente el rojo/);
});


test("Normal preserves residual scope, shared retries and final acceptance", async () => {
  const skill = await text("skills/orquestar/SKILL.md");
  for (const phrase of [
    "cuatro roles base: Planificador → Implementador → Tester → Evaluador",
    "incluidos los ya resueltos", "alcance de corrección se transmite por separado",
    "inicialmente 0 de 2", "mismo contador del paso 8",
    "nueva instancia de Planificador con alcance residual",
    "alternar Tester y Evaluador no reinicia el contador",
    "Conserva el mismo task, modo, objetivo original, baseline y presupuesto",
    "Retira una observación únicamente con evidencia de su resolución",
    "evaluación satisfactoria sobre ese mismo estado final",
    "renueva la verificación y la evaluación afectadas",
    "developer_instructions` íntegro", "fork_turns=none",
    "selección semántica explícita", "detén el despacho",
  ]) assert.ok(skill.includes(phrase), `Normal contract is missing: ${phrase}`);
  assert.doesNotMatch(skill, /Planificador independiente solo si|plan breve del coordinador/);
  const profile = await text("adapters/codex/agents/agentic-read.toml");
  for (const phrase of ["Propósito:", "Responsabilidades:", "Alcance:", "Entradas:",
    "Criterios de devolución:", "Golden Rules:", "Planificador:", "Evaluador:",
    "no modifica producción, tests ni documentación", "QUALITY_OK vigente", "NO_VERIFICADO"])
    assert.ok(profile.includes(phrase), `Read profile is missing: ${phrase}`);
});
