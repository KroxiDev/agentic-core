import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const read = (file) => readFile(path.join(repositoryRoot, file), "utf8");

test("the shipped README covers the complete operational lifecycle", async () => {
  const readme = await read("README.md");

  for (const expected of [
    "## Instalación",
    "## Actualización",
    "## Diagnóstico",
    "## Desinstalación",
    "## Activación explícita y modo directo",
    "## Reanudación y escaladas",
    "## Blockers y advisory",
    "## Calidad",
    "## Requisitos y soporte",
    "## Licencia",
    "agentic-core resume",
    "agentic-core approve-mode-change",
  ]) {
    assert.ok(readme.includes(expected), `README is missing ${expected}`);
  }

  assert.match(readme, /Windows 10 y Windows 11 son las únicas plataformas con soporte oficial/);
  assert.match(readme, /CodeGraph y Engram son integraciones opcionales/);
  assert.match(readme, /`coverage\.py` es opcional/);
  assert.match(readme, /solicitud sin activador[\s\S]*no crea coordinador, run, estado ni subagentes/);
});

test("the README documents only the verified one-shot GitHub maintenance flow", async () => {
  const readme = await read("README.md");
  for (const command of [
    "npx.cmd --yes github:KroxiDev/agentic-core init . --yes",
    "npx.cmd --yes github:KroxiDev/agentic-core init . --yes --dry-run",
    "npx.cmd --yes github:KroxiDev/agentic-core update .",
    "npx.cmd --yes github:KroxiDev/agentic-core update . --dry-run",
    "npx.cmd --yes github:KroxiDev/agentic-core doctor .",
    "npx.cmd --yes github:KroxiDev/agentic-core doctor . --dry-run",
    "npx.cmd --yes github:KroxiDev/agentic-core doctor . --repair",
    "npx.cmd --yes github:KroxiDev/agentic-core uninstall . --dry-run",
    "npx.cmd --yes github:KroxiDev/agentic-core uninstall .",
  ]) {
    assert.ok(readme.includes(command), `README is missing ${command}`);
  }
  assert.match(readme, /\.agentic-core\/runtime/);
  assert.match(readme, /no necesita estar publicado en npm/i);
  assert.doesNotMatch(readme, /npm\.cmd install --save-dev github:KroxiDev\/agentic-core/);
  assert.doesNotMatch(readme, /npm\.cmd uninstall @kroxidev\/agentic-core/);
});

test("the documented graphs, budgets and automatic quality gates match the runtime", async () => {
  const readme = await read("README.md");

  const rows = [
    "| `light` | Implementador → Tester | 1; el segundo `changes_required` bloquea | No |",
    "| `normal` | Planificador → Implementador → Verificador → Documentador | 2; el tercero bloquea | No |",
    "| `full` | Explorador → Planificador → Implementador → Refactor → Tester → Evaluador → Documentador | 2; el tercero bloquea | Sí, únicamente en Evaluador |",
  ];
  for (const row of rows) assert.ok(readme.includes(row), `README graph drift: ${row}`);

  assert.match(readme, /Documentador siempre se crea como agente nuevo en `normal` y `full`/);
  assert.match(readme, /No existe un presupuesto global adicional de duración, cantidad de agentes, gates o invocaciones/);
  assert.match(readme, /Mutation Testing es obligatorio únicamente para el Evaluador de `full`/);
  assert.match(readme, /`direct`, `light` y `normal` no lo solicitan ni lo validan/);
});

test("the README fixes the closed contracts for materiality, isolation, state and differential CRAP", async () => {
  const readme = await read("README.md");

  for (const state of [
    "completed",
    "completed_with_warnings",
    "changes_required",
    "needs_input",
    "needs_mode_change",
    "context_missing",
    "failed",
    "blocked",
  ]) assert.match(readme, new RegExp(`\\b${state}\\b`));

  for (const contract of [
    /máximo configurable de 16 KiB/,
    /máximo es 32 KiB/,
    /exactamente un objeto JSON UTF-8/,
    /primer hand-off inválido[\s\S]*`protocol_retry`[\s\S]*segundo termina como `failed`/,
    /Autoridad concreta/,
    /Alcance `changed` o `direct_dependency`/,
    /Evidencia reproducible o prueba estática localizada/,
    /Impacto material descrito/,
    /Corrección mínima dentro del alcance/,
    /deuda heredada `> 7` no puede empeorar/,
    /archivo lógico, nombre cualificado, contenedor, tipo de declaración y desambiguador determinista/,
    /tests descubiertos, configuración y comandos del runner, manifests y lockfiles/,
  ]) assert.match(readme, contract);
});

test("third-party notices exactly match the release lock dependency inventory", async () => {
  const [lock, notices] = await Promise.all([
    read("package-lock.json").then(JSON.parse),
    read("THIRD_PARTY_NOTICES.md"),
  ]);
  const expected = Object.entries(lock.packages)
    .filter(([location]) => location.startsWith("node_modules/"))
    .map(([location, metadata]) => ({
      name: location.slice("node_modules/".length),
      version: metadata.version,
      license: metadata.license,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const documented = [...notices.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| [^|]+ \| `([^`]+)` \|$/gmu)]
    .map(([, name, version, license]) => ({ name, version, license }))
    .sort((left, right) => left.name.localeCompare(right.name));

  assert.deepEqual(documented, expected);
  assert.match(notices, /tarball does not bundle third-party packages/);
  assert.match(notices, /ThirdPartyNoticeText\.txt/);
});

test("the native release checklist contains all six host and mode runs", async () => {
  const checklist = await read("adapters/manual-validation.md");
  const expected = [
    ["Codex", "light", "Implementador → Tester"],
    ["Codex", "normal", "Planificador → Implementador → Verificador → Documentador"],
    ["Codex", "full", "Explorador → Planificador → Implementador → Refactor → Tester → Evaluador → Documentador"],
    ["Claude Code", "light", "Implementador → Tester"],
    ["Claude Code", "normal", "Planificador → Implementador → Verificador → Documentador"],
    ["Claude Code", "full", "Explorador → Planificador → Implementador → Refactor → Tester → Evaluador → Documentador"],
  ];

  for (const [host, mode, graph] of expected) {
    assert.ok(
      checklist.includes(`| ${host} | \`${mode}\` | ${graph} |`),
      `manual validation is missing ${host} ${mode}`,
    );
  }
  assert.equal((checklist.match(/\| (?:Codex|Claude Code) \| `(?:light|normal|full)` \|/gu) ?? []).length, 6);
  assert.match(checklist, /same candidate commit and tarball SHA-256/);
});

test("the orchestration skill prevents duplicate runtime transitions and transport leaks", async () => {
  const [skill, readme] = await Promise.all([
    read("skills/orquestar/SKILL.md"),
    read("README.md"),
  ]);

  assert.match(skill, /Capture and use stdout from that same invocation as the runtime result/);
  assert.match(skill, /`intention` is never text/);
  assert.match(skill, /never call `start` as a payload preflight/);
  assert.match(skill, /never call `start` again/);
  assert.match(skill, /never re-invoke the agent or seam/);
  assert.match(skill, /\.agentic-core\/workers\/transport\//);
  assert.match(skill, /delete it immediately after the command/);
  for (const [role, profile] of [
    ["Explorador", "agentic-read"],
    ["Planificador", "agentic-read"],
    ["Implementador", "agentic-production"],
    ["Verificador", "agentic-tests"],
    ["Refactor", "agentic-read"],
    ["Tester", "agentic-tests"],
    ["Evaluador", "agentic-read"],
    ["Documentador", "agentic-docs"],
  ]) {
    assert.match(skill, new RegExp(`\\b${role}\\b[^\\n]*\\b${profile}\\b`));
    assert.ok(readme.includes(`| ${role} | \`${profile}\` |`), `${role} profile mapping is undocumented`);
  }
  assert.match(skill, /Never infer a different profile from the current brief permissions/);
});
