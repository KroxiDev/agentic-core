// Exercises schema-2 maintenance retained until issue #57. Never used by the distributed CLI.
import { runLegacyMaintenanceCli } from '../../src/maintenance-cli.js';
try { process.exitCode = await runLegacyMaintenanceCli(process.argv.slice(2)); }
catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
