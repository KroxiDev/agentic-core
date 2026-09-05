#!/usr/bin/env node

import { runMaintenanceCli } from "./maintenance-cli.js";
import { runQualityCli } from "./quality-cli.js";
import { isPythonInstallation } from "./installation/install.js";

const [seam, ...args] = process.argv.slice(2);

try {
  if (seam === "agentic-core") {
    process.exitCode = await runMaintenanceCli(args);
  } else if (seam === "agentic-quality") {
    if (await isPythonInstallation(process.cwd())) {
      process.stderr.write("NO_VERIFICADO: la verificación de calidad del esquema 3 está pendiente de integración\n");
      process.exitCode = 2;
    } else process.exitCode = await runQualityCli(args);
  } else {
    throw new Error(`Unsupported agentic runtime seam: ${String(seam)}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = seam === "agentic-quality" ? 5 : 1;
}
