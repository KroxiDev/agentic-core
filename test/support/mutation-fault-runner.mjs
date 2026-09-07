// Exercise the real task CLI and installed Python tools, injecting only the
// timing of concurrent writes or a disposal error. No control result is mocked.
import { readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";

async function main() {
  const root = process.cwd();
  const fault = JSON.parse(await readFile(path.join(root, ".agentic-core/mutation-fault.json"), "utf8"));
  let mutating = false;
  globalThis.mutationFault = async (phase) => {
    if (phase === "before") mutating = true;
    if (fault === `${phase}-configuration` || fault === "transient-configuration" && ["before", "after"].includes(phase)) {
      const file = path.join(root, ".agentic-core/config.json");
      const config = JSON.parse(await readFile(file, "utf8"));
      config.limits.mutationScore = phase === "after" && fault === "transient-configuration" ? 40 : 90;
      await writeFile(file, JSON.stringify(config));
    }
    if (fault === `${phase}-inputs`) {
      const file = path.join(root, "work dir/src/subject.py");
      await writeFile(file, await readFile(file, "utf8") + "\n# concurrent edit\n");
    }
    if (fault === `${phase}-resolutions`) {
      await writeFile(path.join(root, ".agentic-core/quality/dry-resolutions.json"), "{}\n");
    }
    if (fault === "cleanup" && phase === "dispose" && mutating) {
      throw Object.assign(new Error("synthetic disposal failure"), { code: "EACCES" });
    }
  };
  register(new URL("./mutation-fault-loader.mjs", import.meta.url));
  const { runTaskQualityCli } = await import("../../src/quality/task-baseline.js");
  process.exitCode = await runTaskQualityCli(process.argv.slice(2));
}

// Test discovery may import support files without invoking this driver.
if (["prepare", "verify"].includes(process.argv[2])) await main();
