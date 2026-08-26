import { readFile } from "node:fs/promises";

const packageUrl = new URL("../package.json", import.meta.url);

export async function getVersion() {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  return packageJson.version;
}
