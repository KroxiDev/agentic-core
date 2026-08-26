#!/usr/bin/env node

import { runQualityCli } from "../src/quality-cli.js";

try {
  process.exitCode = await runQualityCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
