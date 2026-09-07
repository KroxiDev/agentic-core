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
  for (const mode of ["light", "normal", "full"]) assert.ok(skill.includes(`\`${mode}\``));
  for (const role of ["Planificador", "Implementador", "Tester", "Verificador", "Evaluador", "Documentador"]) {
    assert.match(skill, new RegExp(role));
  }
  const roleProfiles = new Map([
    ["Planificador", "agentic-read"],
    ["Evaluador", "agentic-read"],
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
    "tests, DRY y C.R.A.P.",
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

test("Claude discovery keeps the shared orquestar skill as its sole canonical source", async () => {
  const shim = await text("adapters/claude/skills/orquestar/SKILL.md");
  assert.match(shim, /Read and follow `.agents\/skills\/orquestar\/SKILL\.md` as the sole canonical skill/);
  assert.doesNotMatch(shim, /Planificador|Implementador|Verificador|Evaluador|Documentador/);
  assert.doesNotMatch(shim, /agentic-(?:read|production|tests|docs)/);
});

test("Codex and Claude profiles share the same semantic responsibilities", async () => {
  const responsibilities = {
    read: ["solo lee producción; no la modifiques", "resultado, bloqueantes y evidencia"],
    production: ["modifica únicamente producción y tests dentro del alcance", "orden rojo-verde"],
    tests: ["solo lee producción; no la modifiques", "Tester", "corregir únicamente tests dentro del alcance"],
    docs: ["solo documentación", "Producción y tests son de solo lectura"],
  };
  for (const [profile, clauses] of Object.entries(responsibilities)) {
    const codex = await text(`adapters/codex/agents/agentic-${profile}.toml`);
    const claude = (await text(`adapters/claude/agents/agentic-${profile}.md`)).replaceAll("`", "");
    for (const clause of clauses) {
      assert.match(codex, new RegExp(clause));
      assert.match(claude, new RegExp(clause));
    }
    for (const content of [codex, claude]) {
      assert.doesNotMatch(content, /sandbox_mode|HOST_SANDBOX|request_permissions|brief\.permissions|handoff|raw final|\.agentic-core\/runs/i);
      assert.match(content, /prosa breve/);
    }
  }
  const claudeTester = await text("adapters/claude/agents/agentic-tests.md");
  assert.match(claudeTester, /tools: Read, Grep, Glob, Edit, Write/);
});

test("agentic-tdd keeps red-green semantic without retrospective duplication", async () => {
  const skill = await text("skills/agentic-tdd/SKILL.md");
  assert.match(skill, /prueba válida que falle/);
  assert.match(skill, /volverla verde/);
  assert.match(skill, /producción y tests dentro del alcance/);
  assert.match(skill, /No exige reproducir retrospectivamente el rojo/);
});
