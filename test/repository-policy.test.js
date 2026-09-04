import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function repositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("repository GitHub policy is portable and preserves remote-write safety", async () => {
  const [agents, claude, gitignore] = await Promise.all([
    repositoryFile("AGENTS.md"),
    repositoryFile("CLAUDE.md"),
    repositoryFile(".gitignore"),
  ]);
  const managedBlockStart = agents.indexOf("<!-- AGENTIC_CORE_START -->");

  assert.notEqual(managedBlockStart, -1);
  assert.equal(agents.slice(managedBlockStart).trimEnd(), claude.trimEnd());

  const sharedPolicy = agents.slice(0, managedBlockStart);
  assert.doesNotMatch(sharedPolicy, /MCP/);
  assert.match(sharedPolicy, /La cuenta GitHub exclusiva de este repositorio es `KroxiDev`/);
  assert.match(sharedPolicy, /El repositorio remoto canónico es `KroxiDev\/agentic-core`/);
  assert.match(sharedPolicy, /Antes de cualquier escritura remota, verifica que la identidad autenticada sea `KroxiDev`/);
  assert.match(sharedPolicy, /Si necesitas usar GitHub CLI, verifica primero que `KroxiDev` sea la cuenta activa/);
  assert.match(sharedPolicy, /No cambies la cuenta global sin autorización del usuario/);
  assert.match(gitignore, /^CLAUDE\.local\.md$/m);
});
