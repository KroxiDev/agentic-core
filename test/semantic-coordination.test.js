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
  for (const role of ["Planificador", "Implementador", "Verificador", "Evaluador", "Documentador"]) {
    assert.match(skill, new RegExp(role));
  }
  assert.match(skill, /como máximo un agente activo/);
  assert.match(skill, /agentic-quality prepare/);
  assert.match(skill, /agentic-quality verify/);
  assert.match(skill, /hasta dos ciclos de corrección/);
  assert.match(skill, /QUALITY_OK/);
  assert.doesNotMatch(skill, /agentic-core (?:start|resume|approve-mode-change|submit-handoff)/);
  assert.doesNotMatch(skill, /protocol_retry|sandbox_mode|HOST_SANDBOX|request_permissions|raw final/i);
});

test("Codex and Claude profiles share the same semantic responsibilities", async () => {
  const responsibilities = {
    read: ["solo lee producción; no la modifiques", "resultado, bloqueantes y evidencia"],
    production: ["modifica únicamente producción y tests dentro del alcance", "orden rojo-verde"],
    tests: ["solo lee producción; no la modifiques", "No modifiques tests ni documentación"],
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
});

test("agentic-tdd keeps red-green semantic without retrospective duplication", async () => {
  const skill = await text("skills/agentic-tdd/SKILL.md");
  assert.match(skill, /prueba válida que falle/);
  assert.match(skill, /volverla verde/);
  assert.match(skill, /producción y tests dentro del alcance/);
  assert.match(skill, /No exige reproducir retrospectivamente el rojo/);
});
