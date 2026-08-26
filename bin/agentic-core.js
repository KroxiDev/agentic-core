#!/usr/bin/env node

import { runMaintenanceCli } from "../src/maintenance-cli.js";

try {
  process.exitCode = await runMaintenanceCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
