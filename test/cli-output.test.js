import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatMaintenanceResult,
  formatQualityResult,
  writeCommandResult,
} from "../src/cli-output.js";
import { runMaintenanceCli } from "../src/maintenance-cli.js";

function capturedStream(isTTY) {
  let content = "";
  return {
    stream: {
      isTTY,
      write(chunk) {
        content += chunk;
      },
    },
    read: () => content,
  };
}

function capturedIo(isTTY = true) {
  const output = capturedStream(isTTY);
  const errors = capturedStream(isTTY);
  return {
    io: { stdin: { isTTY: false }, stdout: output.stream, stderr: errors.stream },
    stdout: output.read,
    stderr: errors.read,
  };
}

test("command output selects human sections only for an interactive terminal", () => {
  const interactive = capturedIo(true);
  writeCommandResult(interactive.io, "LISTO\n", '{"status":"ready"}\n');
  assert.equal(interactive.stdout(), "LISTO\n");

  const captured = capturedIo(false);
  writeCommandResult(captured.io, () => {
    throw new Error("human output must be lazy when stdout is captured");
  }, '{"status":"ready"}\n');
  assert.equal(captured.stdout(), '{"status":"ready"}\n');

  const managedRuntime = capturedIo(true);
  managedRuntime.io.env = { AGENTIC_CORE_OUTPUT: "json" };
  writeCommandResult(managedRuntime.io, "LISTO\n", '{"status":"ready"}\n');
  assert.equal(managedRuntime.stdout(), '{"status":"ready"}\n');
});

test("maintenance plans use the common readable sections without dumping the manifest", () => {
  const output = formatMaintenanceResult("init", {
    projectRoot: "C:\\project",
    version: "0.2.0",
    dryRun: true,
    plan: {
      status: "ready",
      conflicts: [],
      actions: [
        { action: "write_resource", path: ".agentic-core/config.json" },
        { action: "append_managed_block", path: "AGENTS.md" },
        { action: "persist_runtime", path: ".agentic-core/runtime" },
        { action: "write_manifest", path: ".agentic-core/ownership.json" },
      ],
      manifest: { resources: [{}, {}], managedBlocks: [{}, {}] },
    },
  });

  assert.match(output, /^PLAN \(sin escrituras\)\n\n/);
  assert.match(output, /- copiar: \.agentic-core\/config\.json/);
  assert.match(output, /- actualizar: AGENTS\.md/);
  assert.match(output, /- persistir runtime: \.agentic-core\/runtime/);
  assert.match(output, /- validar 2 recursos gestionados/);
  assert.match(output, /- validar 2 bloques gestionados/);
  assert.match(output, /\nLISTO\n\n- Plan completo calculado sin escrituras\./);
  assert.match(output, /\nADVERTENCIAS\n\n- Ninguna\./);
  assert.match(output, /\nACCIONES MANUALES PENDIENTES\n\n- Ninguna\./);
  assert.doesNotMatch(output, /schemaVersion|sha256/);
});

test("maintenance diagnostics and uninstall previews expose warnings and pending work", () => {
  const doctor = formatMaintenanceResult("doctor", {
    exitCode: 1,
    report: {
      status: "repair_preview",
      diagnosis: {
        status: "unhealthy",
        summary: { ok: 1, problems: 1, repairable: 1 },
        checks: [{
          id: "configuration.file",
          status: "error",
          message: "Configuration differs",
          remediation: "Run doctor --repair.",
        }],
      },
      repair: {
        requested: true,
        dryRun: true,
        status: "preview",
        actions: [{ checkId: "configuration.file", action: "restore_resource", path: ".agentic-core/config.json" }],
      },
    },
  });
  assert.match(doctor, /^PLAN \(sin escrituras\)/);
  assert.match(doctor, /DIAGNÓSTICO/);
  assert.match(doctor, /restaurar recurso: \.agentic-core\/config\.json/);
  assert.match(doctor, /ADVERTENCIAS\n\n- configuration\.file: Configuration differs/);
  assert.match(doctor, /ACCIONES MANUALES PENDIENTES\n\n- Run doctor --repair\./);

  const uninstall = formatMaintenanceResult("uninstall", {
    projectRoot: "C:\\project",
    dryRun: true,
    actions: ["resource: .agentic-core/config.json", "manifest: .agentic-core/ownership.json"],
    preserved: ["divergent resource: AGENTS.md"],
  });
  assert.match(uninstall, /eliminar recurso: \.agentic-core\/config\.json/);
  assert.match(uninstall, /Conservado: divergent resource: AGENTS\.md\./);
  assert.match(uninstall, /Revisar manualmente divergent resource: AGENTS\.md\./);
});

test("independent quality results use the common terminal format", () => {
  const quality = formatQualityResult("crap", {
    status: "failed",
    tool: "crap",
    language: "javascript",
    backend: "v8",
    summary: { failed: 1 },
    details: [{ symbol: "choose", status: "failed", current: { crap: 8 } }],
  });
  assert.match(quality, /^ANÁLISIS DE CALIDAD/);
  assert.match(quality, /HALLAZGOS\n\n- choose — fallido — C\.R\.A\.P\. 8/);
  assert.match(quality, /Revisar los símbolos o mutantes fallidos/);
});

test("all maintenance commands render human output while captured JSON remains compatible", async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), "agentic readable cli "));
  t.after(() => rm(project, { recursive: true, force: true }));

  const machinePreview = capturedIo(false);
  assert.equal(await runMaintenanceCli(["init", project, "--dry-run"], machinePreview.io), 0);
  assert.equal(JSON.parse(machinePreview.stdout()).command, "init");

  const initPreview = capturedIo(true);
  assert.equal(await runMaintenanceCli(["init", project, "--dry-run"], initPreview.io), 0);
  assert.match(initPreview.stdout(), /^PLAN \(sin escrituras\)/);

  const init = capturedIo(true);
  assert.equal(await runMaintenanceCli(["init", project], init.io), 0);
  assert.match(init.stdout(), /^ACCIONES/);
  assert.match(init.stdout(), /agentic-core 0\.2\.0 instalado/);

  const update = capturedIo(true);
  assert.equal(await runMaintenanceCli(["update", project, "--dry-run"], update.io), 0);
  assert.match(update.stdout(), /^PLAN \(sin escrituras\)/);

  const doctor = capturedIo(true);
  assert.equal(await runMaintenanceCli(["doctor", project], doctor.io), 0);
  assert.match(doctor.stdout(), /^DIAGNÓSTICO/);

  const uninstallPreview = capturedIo(true);
  assert.equal(await runMaintenanceCli(["uninstall", project, "--dry-run"], uninstallPreview.io), 0);
  assert.match(uninstallPreview.stdout(), /^PLAN \(sin escrituras\)/);

  const uninstall = capturedIo(true);
  assert.equal(await runMaintenanceCli(["uninstall", project, "--force"], uninstall.io), 0);
  assert.match(uninstall.stdout(), /^ACCIONES/);
  assert.match(uninstall.stdout(), /Desinstalación aplicada/);
});
