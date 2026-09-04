import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const read = (file) => readFile(path.join(repositoryRoot, file), "utf8");

async function runBinary(relativePath, args) {
  try {
    const result = await execFileAsync(process.execPath, [
      path.join(repositoryRoot, relativePath),
      ...args,
    ], { cwd: repositoryRoot, encoding: "utf8" });
    return { ...result, code: 0 };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function inlineCode(value) {
  return [...value.matchAll(/(?<!`)`([^`\r\n]+)`(?!`)/gu)].map((match) => match[1]);
}

function markdownSections(markdown) {
  const headings = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gmu)].map((match) => ({
    index: match.index,
    length: match[0].length,
    level: match[1].length,
    title: match[2],
  }));
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    return {
      ...heading,
      body: markdown.slice(heading.index + heading.length, next?.index ?? markdown.length),
    };
  });
}

function commandSection(markdown, publicCommand) {
  return markdownSections(markdown).find(({ title }) => inlineCode(title).includes(publicCommand));
}

function tableCells(line) {
  if (!/^\s*\|.*\|\s*$/u.test(line)) return undefined;
  return line.trim().slice(1, -1).split(/(?<!\\)\|/u).map((cell) => cell.trim());
}

function plainCell(cell) {
  return cell.replace(/^`|`$/gu, "").replaceAll("\\|", "|").trim();
}

function markdownTable(section, headers) {
  const lines = section.body.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => {
    const cells = tableCells(line);
    return cells !== undefined && cells.map(plainCell).join("\0") === headers.join("\0");
  });
  const label = inlineCode(section.title)[0] ?? section.title;
  assert.notEqual(headerIndex, -1, `${label} is missing its expected table`);
  const divider = tableCells(lines[headerIndex + 1]);
  assert.ok(divider?.every((cell) => /^:?-{3,}:?$/u.test(cell)), "invalid Markdown table divider");
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    const cells = tableCells(line);
    if (cells === undefined) break;
    rows.push(cells.map(plainCell));
  }
  return rows;
}

function cliSchemas(help, binary) {
  const schemas = new Map();
  for (const rawLine of help.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith(`${binary} `)) continue;
    const usage = line.slice(binary.length + 1);
    const command = usage.match(/^([^\s]+)/u)?.[1];
    if (!command || command.startsWith("-")) continue;
    const options = new Map();
    for (const match of usage.matchAll(/(\[)?(--[a-z][a-z-]*)(?:\s+<([^>]+)>)?(\.\.\.)?(\])?/gu)) {
      const [, optional, option, value, repeatable] = match;
      const prior = options.get(option);
      options.set(option, {
        option,
        value: value ?? null,
        required: (prior?.required ?? false) || optional !== "[",
        repeatable: (prior?.repeatable ?? false) || repeatable === "...",
      });
    }
    schemas.set(`${binary} ${command}`, [...options.values()].sort((left, right) => (
      left.option < right.option ? -1 : left.option > right.option ? 1 : 0
    )));
  }
  return schemas;
}

function documentedSchema(section) {
  return markdownTable(section, ["Opción", "Valor", "Requerida", "Repetible"])
    .map(([option, value, required, repeatable]) => ({
      option,
      value: value === "—" ? null : value.replace(/^<|>$/gu, ""),
      required: required === "Sí",
      repeatable: repeatable === "Sí",
    }))
    .sort((left, right) => (left.option < right.option ? -1 : left.option > right.option ? 1 : 0));
}

function assertDocumentedCliContracts(readme, schemas) {
  for (const [publicCommand, schema] of schemas) {
    const section = commandSection(readme, publicCommand);
    assert.ok(section, `README is missing a section for ${publicCommand}`);
    const examples = [...section.body.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/gu)]
      .flatMap((match) => match[1].split(/\r?\n/u));
    assert.ok(
      examples.some((line) => line.includes(publicCommand)),
      `${publicCommand} is missing an executable example`,
    );
    assert.deepEqual(documentedSchema(section), schema, `${publicCommand} schema differs from --help`);
  }
}

function headingSection(markdown, title) {
  return markdownSections(markdown).find((section) => section.title.replaceAll("`", "") === title);
}

function fencedLines(content) {
  return [...content.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/gu)]
    .flatMap((match) => match[1].split(/\r?\n/u));
}

function assertIncludesEach(actual, expected, label) {
  assert.ok(Array.isArray(actual), `${label ?? "actual"} must be an array`);
  for (const value of expected) assert.ok(actual.includes(value), `${label} is missing ${value}`);
}

function assertContainsEach(haystack, expected, label) {
  assert.equal(typeof haystack, "string", `${label ?? "haystack"} must be a string`);
  for (const value of expected) assert.ok(haystack.includes(value), `${label} is missing ${value}`);
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

let cliDocumentationPromise;
function loadCliDocumentation() {
  cliDocumentationPromise ??= Promise.all([
    read("README.md"),
    runBinary("bin/agentic-core.js", ["--help"]),
    runBinary("bin/agentic-quality.js", ["--help"]),
  ]).then(([readme, maintenanceHelp, qualityHelp]) => {
    assert.equal(maintenanceHelp.code, 0, maintenanceHelp.stderr);
    assert.equal(qualityHelp.code, 0, qualityHelp.stderr);
    return {
      readme,
      schemas: new Map([
        ...cliSchemas(maintenanceHelp.stdout, "agentic-core"),
        ...cliSchemas(qualityHelp.stdout, "agentic-quality"),
      ]),
    };
  });
  return cliDocumentationPromise;
}

function schemaArguments(schema, values) {
  const args = [];
  for (const { option, value, repeatable } of schema) {
    args.push(option);
    if (value !== null) args.push(values[option]);
    if (repeatable) {
      args.push(option);
      if (value !== null) args.push(values[option]);
    }
  }
  return args;
}

function paraphraseEditorialProse(markdown) {
  let fenced = false;
  return markdown.split(/(\r?\n)/u).map((line) => {
    if (/^```/u.test(line.trimStart())) {
      fenced = !fenced;
      return line;
    }
    if (fenced || line.trim() === "" || /^#{1,6}\s/u.test(line) || /^\s*\|/u.test(line)) {
      return line;
    }
    const prefix = line.match(/^\s*(?:(?:[-*+] |\d+\. ))?/u)?.[0] ?? "";
    const identifiers = inlineCode(line).map((value) => `\`${value}\``);
    return `${prefix}Redacción alternativa${identifiers.length === 0 ? "" : `: ${identifiers.join(", ")}`}.`;
  }).join("");
}

function receiptFields(section, receipt) {
  const line = fencedLines(section.body).find((candidate) => candidate.startsWith(`${receipt} `));
  assert.ok(line, `${receipt} schema is missing`);
  return line.trim().split(/\s+/u).slice(1).map((field) => field.split("=")[0]);
}

/*
Literal coverage replaced here remains traceable as follows:
- lifecycle, bootstrap, runtime, and platform wording -> command headings, CLI tables,
  support table, parser probes, plus behavioral coverage in cli/init/package/transaction tests;
- routing, roles, and permission wording -> activation identifiers, mode table, and the
  authorization-boundary table here, plus behavioral coverage in semantic-coordination.test.js;
- QualitySession wording -> command schemas, receipt fields, exit-code table, and
  quality-session.test.js behavior;
- migration wording -> retired/maintained identifier sets here and negative CLI plus
  legacy-state behavior in cli.test.js and init.test.js;
- changelog wording -> Unreleased/Incompatible structure and stable CLI identifiers.
*/

test("every public CLI command has a README section whose option schema matches --help", async () => {
  const { readme, schemas } = await loadCliDocumentation();
  assertDocumentedCliContracts(readme, schemas);
});

test("every option documented for a command is accepted by that command parser", async () => {
  const { schemas } = await loadCliDocumentation();
  await Promise.all([...schemas].map(async ([publicCommand, schema]) => {
    const [binary, command] = publicCommand.split(" ");
    if (binary === "agentic-core") {
      const result = await runBinary("bin/agentic-core.js", [
        command,
        "first-directory",
        "second-directory",
        ...schemaArguments(schema, {}),
      ]);
      assert.equal(result.code, 2, publicCommand);
      assert.equal(result.stderr.trim(), `${command} accepts at most one directory`);
      return;
    }

    const values = { "--mode": "invalid-mode", "--scope": "src", "--session": "invalid", "--target": ".." };
    const result = await runBinary("bin/agentic-quality.js", [
      command,
      ...schemaArguments(schema, values),
    ]);
    assert.equal(result.code, 4, `${publicCommand}: ${result.stderr || result.stdout}`);
    const downstreamErrors = {
      prepare: "Quality mode must be light, normal, or full",
      verify: "Quality session id is invalid",
    };
    assert.equal(
      result.stderr.trim(),
      downstreamErrors[command] ?? "Target must be inside the project",
      publicCommand,
    );
  }));
});

test("rewriting editorial prose does not change the documented CLI contracts", async () => {
  const { readme, schemas } = await loadCliDocumentation();
  assertDocumentedCliContracts(paraphraseEditorialProse(readme), schemas);
});

test("the README keeps lifecycle, support, and runtime commitments as structure", async () => {
  const { readme } = await loadCliDocumentation();
  const topLevelHeadings = markdownSections(readme)
    .filter(({ level }) => level === 2)
    .map(({ title }) => title);
  assertIncludesEach(topLevelHeadings, [
    "Requisitos y soporte",
    "Instalación",
    "Actualización",
    "Diagnóstico",
    "Desinstalación",
    "Formato de salida",
    "Activación explícita y modo directo",
    "QualitySession",
    "Comandos independientes de calidad",
    "Migración desde el runtime determinista anterior",
  ], "README headings");

  const support = headingSection(readme, "Requisitos y soporte");
  assert.deepEqual(markdownTable(support, ["Plataforma", "Nivel de soporte"]), [
    ["Windows 10", "Oficial"],
    ["Windows 11", "Oficial"],
  ]);

  const installation = commandSection(readme, "agentic-core init");
  const identifiers = inlineCode(installation.body);
  assertIncludesEach(identifiers, [
    "--yes",
    "npx",
    "agentic-core init",
    "--replace-conflicts",
    ".agentic-core/runtime",
    "_npx",
    "node_modules",
    "package.json",
    "treeSha256",
  ], "installation contract");
  assert.equal(documentedSchema(installation).some(({ option }) => option === "--yes"), false);
  assert.ok(fencedLines(installation.body).some((line) => (
    line.startsWith("npx.cmd --yes github:KroxiDev/agentic-core init .")
  )));
});

test("the README keeps coordination and QualitySession contracts as identifiers and schemas", async () => {
  const { readme } = await loadCliDocumentation();
  const activation = headingSection(readme, "Activación explícita y modo directo");
  assertIncludesEach(inlineCode(activation.body), [
    "Orquesta",
    "/orquestar",
    "$orquestar",
    ".agents/skills/orquestar/SKILL.md",
    "normal",
  ], "activation contract");

  const modes = headingSection(readme, "Modos y roles");
  const modeRows = markdownTable(modes, ["Modo", "Coordinación semántica", "Gate determinista"]);
  assert.deepEqual(modeRows.map(([mode]) => mode), ["light", "normal", "full"]);
  assertContainsEach(modeRows.flat().join("\n"), [
    "Implementador",
    "Planificador",
    "Verificador",
    "Evaluador",
    "Documentador",
    "prepare",
    "verify",
    "not_applicable",
  ], "mode contract");

  assert.deepEqual(markdownTable(
    headingSection(readme, "Límites de permisos"),
    ["Operación", "Requiere autorización explícita"],
  ), [
    ["Lectura y análisis", "No"],
    ["Edición dentro del alcance", "No"],
    ["Operaciones destructivas", "Sí"],
    ["commit", "Sí"],
    ["push", "Sí"],
    ["Publicación", "Sí"],
    ["Cambios remotos", "Sí"],
  ]);

  const quality = headingSection(readme, "QualitySession");
  assert.deepEqual(receiptFields(quality, "QUALITY_SESSION"), ["id", "mode", "baseline"]);
  assert.deepEqual(receiptFields(quality, "QUALITY_OK"), [
    "session",
    "tests",
    "crap_max",
    "mutation",
    "report",
    "sha256",
  ]);
  assertIncludesEach(inlineCode(quality.body), [
    ".env",
    "C.R.A.P. <= 7",
    "> 7",
    "full",
    "not_applicable",
    "reports/latest.json",
    "QUALITY_OK",
  ], "QualitySession identifiers");
  const exitCodes = markdownTable(
    headingSection(readme, "Códigos de salida"),
    ["Código", "Significado"],
  ).map(([code]) => code);
  assert.deepEqual(exitCodes, ["0", "1", "2", "3", "4", "5"]);
  assertIncludesEach(
    inlineCode(headingSection(readme, "Formato de salida").body),
    ["AGENTIC_CORE_OUTPUT=json"],
    "output contract",
  );
});

test("the README keeps retired and maintained interfaces as explicit identifier sets", async () => {
  const { readme } = await loadCliDocumentation();
  const migration = headingSection(readme, "Migración desde el runtime determinista anterior");
  assertIncludesEach(inlineCode(migration.body), [
    "agentic-core start",
    "agentic-core resume",
    "agentic-core approve-mode-change",
    "agentic-core submit-handoff",
    "protocol_retry",
    "runs",
    "init",
    "update",
    "doctor",
    "uninstall",
  ], "migration contract");
});

test("the changelog records the incompatible CLI change structurally", async () => {
  const changelog = await read("CHANGELOG.md");
  assert.ok(headingSection(changelog, "Unreleased"));
  const incompatible = headingSection(changelog, "Incompatible");
  assertIncludesEach(inlineCode(incompatible.body), [
    "agentic-core init --yes",
    "Unknown option: --yes",
    "--replace-conflicts",
  ], "Unreleased/Incompatible identifiers");
});

test("third-party notices exactly match the bundled runtime dependency inventory", async () => {
  const [packageJson, lock, notices] = await Promise.all([
    read("package.json").then(JSON.parse),
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
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  const documented = [...notices.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| [^|]+ \| `([^`]+)` \|$/gmu)]
    .map(([, name, version, license]) => ({ name, version, license }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));

  assert.deepEqual(documented, expected);
  assert.equal(packageJson.devDependencies.esbuild, "0.28.2");
  assert.equal(documented.some(({ name }) => name === "esbuild"), false);
  assertIncludesEach(inlineCode(notices), [
    "@kroxidev/agentic-core",
    "node_modules",
    "third_party/",
    "esbuild",
    "ThirdPartyNoticeText.txt",
  ], "third-party notice identifiers");
  const noticeHeadings = markdownSections(notices)
    .filter(({ level }) => level === 2)
    .map(({ title }) => title);
  assertIncludesEach(noticeHeadings, [
    "@jridgewell/trace-mapping 0.3.31",
    "@jridgewell/resolve-uri 3.1.2",
    "@jridgewell/sourcemap-codec 1.5.5",
    "TypeScript 6.0.3",
  ], "third-party notice sections");
});

test("manual validation covers both hosts without claiming security enforcement", async () => {
  const checklist = await read("adapters/manual-validation.md");
  const headings = markdownSections(checklist).filter(({ level }) => level === 2).map(({ title }) => title);
  assertIncludesEach(headings, [
    "Límites de evidencia",
    "Preparación común",
    "Routing visible",
    "Matriz semántica",
    "QualitySession",
    "Interfaces públicas",
    "Migración y mantenimiento",
    "Gate final",
  ], "manual validation headings");

  const matrix = markdownTable(
    headingSection(checklist, "Matriz semántica"),
    ["Host", "Modo", "Roles esperados", "Gate esperado"],
  );
  assert.deepEqual(matrix.map(([host, mode]) => `${host}\0${mode}`), [
    "Codex\0light",
    "Codex\0normal",
    "Codex\0full",
    "Claude Code\0light",
    "Claude Code\0normal",
    "Claude Code\0full",
  ]);

  const evidenceLimits = markdownTable(
    headingSection(checklist, "Límites de evidencia"),
    ["Área", "Contrato"],
  );
  assert.deepEqual(evidenceLimits, [
    ["coordination", "semantic-policy"],
    ["host-security", "not-verified"],
    ["model-input", "program-generated-json-only"],
    ["legacy-runs", "preserve"],
  ]);
  assertIncludesEach(inlineCode(headingSection(checklist, "Routing visible").body), [
    "Orquesta normal",
    ".agents/skills/orquestar/SKILL.md",
    "/orquestar light",
    "$orquestar full",
  ], "manual routing identifiers");
  assert.doesNotMatch(checklist, /agentic-core (?:start|resume|approve-mode-change|submit-handoff)/);
});

test("the architecture spec and skills agree on semantic coordination", async () => {
  assert.throws(
    () => assertIncludesEach("highlight", ["light"], "element inclusion"),
    /element inclusion must be an array/u,
  );
  const [spec, orchestrationSkill, tddSkill] = await Promise.all([
    read("agentic-core-spec.md"),
    read("skills/orquestar/SKILL.md"),
    read("skills/agentic-tdd/SKILL.md"),
  ]);
  const specHeadings = markdownSections(spec).map(({ title }) => title.replaceAll("`", ""));
  assertIncludesEach(specHeadings, [
    "Decisión",
    "Superficie pública",
    "Coordinación semántica",
    "QualitySession",
    "Persistencia e integridad",
    "Mantenimiento y migración",
    "Estrategia de testing",
  ], "architecture headings");
  assertIncludesEach(inlineCode(spec), [
    "QualitySession",
    "init",
    "update",
    "doctor",
    "uninstall",
    "prepare",
    "verify",
    "light",
    "normal",
    "full",
    "QUALITY_OK",
    "treeSha256",
  ], "architecture identifiers");
  // These identifiers occur inside complete launcher commands, for example
  // `node .agentic-core/runtime-launcher.mjs agentic-quality prepare --mode <modo>`.
  assertContainsEach(inlineCode(orchestrationSkill).join("\n"), [
    "light",
    "normal",
    "full",
    "agentic-read",
    "agentic-production",
    "agentic-tests",
    "agentic-docs",
    "agentic-quality prepare",
    "agentic-quality verify",
    "QUALITY_OK",
  ], "orchestration identifiers");
  assert.equal(tddSkill.match(/^name:\s*(\S+)\s*$/mu)?.[1], "agentic-tdd");
  assertIncludesEach(inlineCode(tddSkill), [".agentic-core/golden-rules.md"], "TDD identifiers");
  assert.doesNotMatch(orchestrationSkill, /agentic-core (?:start|resume|approve-mode-change|submit-handoff)/);
});
