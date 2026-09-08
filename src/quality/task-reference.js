import { IntegrationError } from "./command.js";
import { inputHash, matchesInput, privateInputContent } from "./project-inputs.js";

const hash = (value) => inputHash(JSON.stringify(value));
const invalid = () => new IntegrationError("baseline_inputs_invalid", "El inicio conservado no permite reconstruir una comparación fiel", 2);

// Reconstruct only saved inputs. Current files never fill gaps in the initial tree.
export function taskReferenceCheckpoint(root, task, unit, selection) {
  const initial = task.initial;
  if (!initial?.valid || !Array.isArray(initial.sources) || !Array.isArray(initial.inputs?.inventory)
    || hash(task.scope) !== hash(unit.scope)
    || initial.inputs.digest !== hash({ inventory: initial.inputs.inventory, scope: unit.scope, inputs: unit.inputs })) throw invalid();
  if (selection?.code?.some((file) => !unit.scope.some((scope) => matchesInput(file, scope)))) throw invalid();
  const sources = new Map(initial.sources.map((entry) => [entry.path, entry]));
  if (sources.size !== initial.sources.length || sources.size !== initial.inputs.inventory.length
    || new Set(initial.inputs.inventory.map((entry) => entry.path)).size !== sources.size) throw invalid();
  const entries = initial.inputs.inventory.map((entry) => {
    const saved = sources.get(entry.path);
    if (typeof entry.path !== "string" || entry.path.startsWith("/") || /[\\:]/u.test(entry.path)
      || entry.path.split("/").some((part) => !part || part === "." || part === "..")
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
      || !["measured_code", "test_input"].includes(entry.kind) || typeof saved?.content !== "string") throw invalid();
    const content = Buffer.from(saved.content, "base64");
    if (content.toString("base64") !== saved.content || saved.sha256 !== entry.sha256
      || saved.kind !== entry.kind || inputHash(content) !== entry.sha256 || privateInputContent(content)) throw invalid();
    return { ...entry, content, kind: entry.kind === "measured_code" && selection?.code
      && !selection.code.some((scope) => matchesInput(entry.path, scope)) ? "test_input" : entry.kind };
  });
  for (const requested of selection?.tests ?? []) {
    if (!entries.some((entry) => entry.path.endsWith(".py") && matchesInput(entry.path, requested))) throw invalid();
  }
  const inventory = entries.map(({ content: _content, ...entry }) => entry);
  return { root, entries, inventory, selection, issues: [], exclusions: initial.inputs.exclusions,
    policy: initial.inputs.policy,
    digest: hash({ inventory, scope: unit.scope, inputs: unit.inputs, ...(selection ? { selection } : {}) }) };
}
