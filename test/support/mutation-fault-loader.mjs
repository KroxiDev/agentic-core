import assert from "node:assert/strict";

// Node's asynchronous module hooks are available on the supported Node 20 line.
// Change only fault timing; execute every production control without mocks.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/src/quality/python-mutation.js") && !url.endsWith("/src/quality/project-copy.js")) return result;
  let source = result.source.toString();
  if (url.endsWith("/python-mutation.js")) {
    const marker = "export async function runPythonMutation(";
    assert.ok(source.includes(marker));
    source = source.replace(marker, "async function observedMutation(");
    source += `\nexport async function runPythonMutation(...args) {
      await globalThis.mutationFault('before');
      const result = await observedMutation(...args);
      await globalThis.mutationFault('after');
      return result;
    }\n`;
  } else {
    const marker = "dispose: () => rm(temporary, { recursive: true, force: true })";
    assert.ok(source.includes(marker));
    source = source.replace(marker, "dispose: async () => { await rm(temporary, { recursive: true, force: true }); await globalThis.mutationFault('dispose'); }");
  }
  return { ...result, source };
}
