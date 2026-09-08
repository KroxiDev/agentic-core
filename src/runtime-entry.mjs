#!/usr/bin/env node

import { runMaintenanceCli } from "./maintenance-cli.js";
import { runQualityCli } from "./quality-cli.js";
import { isPythonInstallation } from "./installation/install.js";
import { runPythonQualityCli } from "./quality/python-project.js";
import { runTaskQualityCli } from "./quality/task-baseline.js";
import { runPythonCrapCli } from "./quality/python-crap.js";
import { runPythonDryCli } from "./quality/python-dry.js";
import { runPythonMutationCli } from "./quality/python-mutation.js";
import { runExplainCli } from "./quality/diagnostics.js";
import { runResultExportCli } from "./quality/result-export.js";

const [seam, ...args] = process.argv.slice(2);

try {
  if (seam === "agentic-core") {
    process.exitCode = await runMaintenanceCli(args);
  } else if (seam === "agentic-quality") {
    if (args.length === 1 && args[0] === "--version") {
      process.exitCode = await runQualityCli(args);
    } else if (args[0] === "explain") {
      process.exitCode = await runExplainCli(args.slice(1));
    } else if (await isPythonInstallation(process.cwd())) {
      process.exitCode = await (args[0] === "export" ? runResultExportCli(args)
        : args[0] === "crap" ? runPythonCrapCli(args)
        : args[0] === "dry" ? runPythonDryCli(args)
        : ["mutate", "mutation"].includes(args[0]) ? runPythonMutationCli(args)
        : ["prepare", "baseline", "verify"].includes(args[0]) ? runTaskQualityCli(args) : runPythonQualityCli(args));
    } else process.exitCode = await runQualityCli(args);
  } else {
    throw new Error(`Unsupported agentic runtime seam: ${String(seam)}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = seam === "agentic-quality" ? 5 : 1;
}
