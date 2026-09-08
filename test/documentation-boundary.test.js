import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pythonProject } from "./support/python-project.mjs";

test("README links resolve locally and development documents stay outside installed consumers", async (t) => {
  const readme = await readFile("README.md", "utf8");
  assert.deepEqual([...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ["Requisitos", "Instalación", "Actualización", "Desinstalación", "Modos", "Controles"]);
  for (const match of readme.matchAll(/https:\/\/github.com\/KroxiDev\/agentic-core\/blob\/main\/([^\s)]+)/g)) {
    const [file, anchor] = decodeURI(match[1]).split("#");
    const document = await readFile(file, "utf8");
    if (anchor) assert.ok(document.toLowerCase().includes(`## ${anchor}`), match[1]);
  }
  const { root } = await pythonProject(t);
  const check = async () => {
    const files = await readdir(root, { recursive: true });
    assert.equal(files.some((file) => /(?:^|[/\\])(?:CONTEXT\.md|domain-modeling|technical-reference\.md|agentic-core-spec\.md)$/.test(file)), false);
    for (const file of [".agentic-core/runtime-launcher.mjs", ".agentic-core/golden-rules.md",
      ".codex/agents/agentic-read.toml", ".codex/agents/agentic-production.toml",
      ".codex/agents/agentic-tests.toml", ".codex/agents/agentic-docs.toml",
      ".agents/skills/orquestar/SKILL.md", ".agents/skills/agentic-tdd/SKILL.md"]) {
      await access(path.join(root, file));
    }
    const payload = JSON.parse(await readFile(path.join(root, ".agentic-core/ownership.json"), "utf8"));
    assert.doesNotMatch(JSON.stringify(payload), /CONTEXT\.md|domain-modeling|technical-reference\.md|agentic-core-spec\.md/);
  };
  await check();
  await promisify(execFile)(process.execPath, [path.resolve("bin/agentic-core.js"), "update", root],
    { cwd: root, windowsHide: true, timeout: 120000 });
  await check();
});
