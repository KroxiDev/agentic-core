// Exercises the schema-2 compatibility surface. Never used by the distributed schema-3 CLI.
import { runLegacyMaintenanceCli } from '../../src/maintenance-cli.js';
try { process.exitCode = await runLegacyMaintenanceCli(process.argv.slice(2)); }
catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
