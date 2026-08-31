import { readFile } from "node:fs/promises";

const packageUrl = new URL("../package.json", import.meta.url);
const bundledVersion = typeof __AGENTIC_CORE_VERSION__ === "string" ? __AGENTIC_CORE_VERSION__ : undefined;

export async function getVersion() {
  if (bundledVersion !== undefined) return bundledVersion;
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  return packageJson.version;
}
