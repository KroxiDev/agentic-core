import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const read = (file) => readFile(path.join(repositoryRoot, file), "utf8");

test("the README documents the maintained lifecycle and self-contained runtime", async () => {
  const readme = await read("README.md");
  for (const heading of [
    "## Instalación",
    "## Actualización",
    "## Diagnóstico",
    "## Desinstalación",
    "## Formato de salida",
    "## Activación explícita y modo directo",
    "## QualitySession",
    "## Comandos independientes de calidad",
    "## Migración desde el runtime determinista anterior",
  ]) assert.ok(readme.includes(heading), `README is missing ${heading}`);

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
  ]) assert.ok(readme.includes(command), `README is missing ${command}`);

  assert.match(readme, /\.agentic-core\/runtime/);
  assert.match(readme, /inventario final, hashes por archivo y `treeSha256`/);
  assert.match(readme, /no necesita que el paquete esté publicado en npm/i);
  assert.match(readme, /Windows 10 y Windows 11 son las únicas plataformas con soporte oficial/);
});

test("the README fixes semantic routing, roles, and permission boundaries", async () => {
  const readme = await read("README.md");
  for (const activator of ["`Orquesta`", "`/orquestar`", "`$orquestar`"]) {
    assert.ok(readme.includes(activator));
  }
  assert.match(readme, /debe cargar y seguir la skill instalada `\.agents\/skills\/orquestar\/SKILL\.md`/);
  assert.match(readme, /`Orquesta` sin modo significa `normal`/);
  assert.match(readme, /solicitud sin esos activadores se ejecuta directamente/);
  assert.match(readme, /como máximo un agente activo/);
  assert.match(readme, /Planificador solo ante una decisión HOW material/);
  assert.match(readme, /máximo dos ciclos de corrección/);
  assert.match(readme, /Documentador solo si corresponde/);
  assert.match(readme, /Planificador, Verificador y Evaluador solo leen producción/);
  assert.match(readme, /políticas semánticas[\s\S]*no ACLs, sandboxes ni aislamiento técnico demostrado/);
  assert.match(readme, /Operaciones destructivas, commit, push, publicación y cambios remotos requieren autorización explícita/);
});

test("the README documents the complete prepare and verify contract", async () => {
  const readme = await read("README.md");
  for (const command of [
    "agentic-quality prepare --mode normal --scope src --scope test",
    "agentic-quality verify --session q_<id>",
    "agentic-quality scan --target src",
    "agentic-quality crap --target src",
    "agentic-quality mutate --target src",
    "agentic-quality mutation --target src",
  ]) assert.ok(readme.includes(command), `README is missing ${command}`);

  for (const contract of [
    /QUALITY_SESSION id=q_<id> mode=normal baseline=<sha256>/,
    /QUALITY_OK session=q_<id> tests=approved/,
    /antes de modificar producción o tests/,
    /cambios preexistentes y archivos relevantes no trackeados/,
    /Excluye `.env`, secretos, datos personales, caches, binarios/,
    /Repetir entradas idénticas reutiliza de forma segura la misma sesión/,
    /símbolo nuevo debe permanecer en `C\.R\.A\.P\. <= 7`/,
    /deuda heredada `> 7` no puede empeorar/,
    /baseline no atribuible nunca se sustituye por cero/,
    /En `full`[\s\S]*Mutation Testing/,
    /En `light` y `normal`, registra Mutation Testing como `not_applicable` sin ejecutarlo/,
    /`reports\/latest\.json` identifica el único recibo vigente/,
    /Ningún cambio ejecutable orquestado puede declararse completo sin un `QUALITY_OK` vigente/,
  ]) assert.match(readme, contract);

  for (const exitCode of ["`0`", "`1`", "`2`", "`3`", "`4`", "`5`"]) {
    assert.ok(readme.includes(`| ${exitCode} |`));
  }
  assert.match(readme, /AGENTIC_CORE_OUTPUT=json/);
  assert.match(readme, /modelo nunca redacta ni entrega un payload JSON de entrada/);
});

test("the README explicitly documents the migration boundary", async () => {
  const readme = await read("README.md");
  for (const retired of [
    "agentic-core start",
    "agentic-core resume",
    "agentic-core approve-mode-change",
    "agentic-core submit-handoff",
    "`protocol_retry`",
  ]) assert.ok(readme.includes(retired), `README migration is missing ${retired}`);
  assert.match(readme, /pérdida de replay, reanudación y aislamiento técnico es deliberada/);
  assert.match(readme, /`runs` existentes se preservan como evidencia legacy/);
  assert.match(readme, /no se cargan ni se crean en instalaciones nuevas/);
  assert.match(readme, /Se conservan `init`, `update`, `doctor`, `uninstall`, transacciones y rollback/);
});

test("third-party notices exactly match the bundled runtime dependency inventory", async () => {
  const [lock, notices] = await Promise.all([
    read("package-lock.json").then(JSON.parse),
    read("THIRD_PARTY_NOTICES.md"),
  ]);
  const bundled = new Set([
    "@jridgewell/resolve-uri",
    "@jridgewell/sourcemap-codec",
    "@jridgewell/trace-mapping",
    "typescript",
  ]);
  const expected = Object.entries(lock.packages)
    .filter(([location]) => bundled.has(location.slice("node_modules/".length)))
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
  assert.match(notices, /production artifact bundles the reachable runtime implementation/);
  assert.match(notices, /esbuild` 0\.28\.2 as a development-only dependency/);
  assert.match(notices, /ThirdPartyNoticeText\.txt/);
});

test("manual validation covers both hosts without claiming security enforcement", async () => {
  const checklist = await read("adapters/manual-validation.md");
  for (const host of ["Codex", "Claude Code"]) {
    for (const mode of ["light", "normal", "full"]) {
      assert.ok(checklist.includes(`| ${host} | \`${mode}\` |`), `missing ${host} ${mode}`);
    }
  }
  assert.equal((checklist.match(/\| (?:Codex|Claude Code) \| `(?:light|normal|full)` \|/gu) ?? []).length, 6);
  assert.match(checklist, /`Orquesta normal`[\s\S]*carga explícitamente `\.agents\/skills\/orquestar\/SKILL\.md`/);
  assert.match(checklist, /no se acepta input JSON redactado por el modelo/);
  assert.match(checklist, /No atribuir a estas frases aislamiento técnico, permisos efectivos/);
  assert.match(checklist, /preservación de `runs`/);
  assert.doesNotMatch(checklist, /agentic-core (?:start|resume|approve-mode-change|submit-handoff)/);
});

test("the architecture spec and skills agree on semantic coordination", async () => {
  const [spec, orchestrationSkill, tddSkill] = await Promise.all([
    read("agentic-core-spec.md"),
    read("skills/orquestar/SKILL.md"),
    read("skills/agentic-tdd/SKILL.md"),
  ]);
  assert.match(spec, /Separar dos responsabilidades/);
  assert.match(spec, /`QualitySession`: baseline previo, tests reales, C\.R\.A\.P\. diferencial/);
  assert.match(spec, /No existe un port nuevo de host/);
  assert.match(spec, /runtime distribuido se construye primero como conjunto canónico completo/);
  assert.match(orchestrationSkill, /`light`: Implementador; TDD cuando corresponda; `verify` obligatorio/);
  assert.match(orchestrationSkill, /solo lee producción; no la modifiques/);
  assert.match(orchestrationSkill, /nunca briefs, handoffs ni protocolo JSON/);
  assert.doesNotMatch(orchestrationSkill, /agentic-core (?:start|resume|approve-mode-change|submit-handoff)/);
  assert.match(tddSkill, /No exige reproducir retrospectivamente el rojo/);
});
