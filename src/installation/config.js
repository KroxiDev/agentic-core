import path from "node:path";

export class InstallationError extends Error {
  constructor(code, message, exitCode = 4, options) {
    super(message, options);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const text = { type: "string", minLength: 1 };
const strings = { type: "array", items: text };
const positive = { type: "number", exclusiveMinimum: 0 };
const object = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
export const CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...object({
    $schema: { const: "./config.schema.json" },
    schemaVersion: { const: 3 },
    integration: object({
      provider: { const: "codex" },
      languages: { type: "array", items: { const: "python" }, minItems: 1, maxItems: 1 },
      python: object({
        interpreter: text,
        runner: { const: "pytest" },
        command: object({ executable: text, args: { type: "array", items: { type: "string" } } }),
        cwd: text,
        environment: { type: "object", additionalProperties: { type: "string" } },
        coverage: object({ format: { const: "lcov" }, path: text }),
        scope: { ...strings, minItems: 1 },
        inputs: { ...object({ include: { ...strings, minItems: 1 }, exclude: strings,
          includeIgnored: strings, respectGitIgnore: { type: "boolean" } }), required: ["include", "exclude"] },
      }),
    }),
    limits: object({
      dry: object({ similarity: { type: "number", minimum: 0, maximum: 1 }, minLines: { type: "integer", minimum: 1 }, minNodes: { type: "integer", minimum: 1 } }),
      crap: { type: "number", minimum: 0 },
      mutationScore: { type: "number", exclusiveMinimum: 0, maximum: 100 },
      operation: object({ commandTimeoutMs: positive, totalBudgetMs: positive, workers: { type: "integer", minimum: 1, maximum: 4 } }),
    }),
  }),
};

function validate(value, schema, location) {
  const fail = () => { throw new InstallationError("invalid_configuration", `Configuración inválida en ${location}`); };
  if (Object.hasOwn(schema, "const") && value !== schema.const) fail();
  if (!schema.type) return;
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type === "integer" ? !Number.isInteger(value) : type !== schema.type) fail();
  if (type === "number" && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity)
    || value > (schema.maximum ?? Infinity) || value <= (schema.exclusiveMinimum ?? -Infinity))) fail();
  if (type === "string" && (value.length < (schema.minLength ?? 0) || value.includes("\0"))) fail();
  if (type === "array") {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail();
    value.forEach((item, index) => validate(item, schema.items, `${location}[${index}]`));
  }
  if (type === "object") {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail();
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : schema.additionalProperties;
      if (!child) throw new InstallationError("unknown_configuration_key", `Clave desconocida en ${location}`);
      validate(item, child, `${location}.${schema.properties ? key : "valor"}`);
    }
  }
}

export function validateConfiguration(config) {
  validate(config, CONFIG_SCHEMA, "config");
  const unit = config.integration.python;
  for (const relative of [unit.cwd, unit.coverage.path, ...unit.scope, ...unit.inputs.include, ...unit.inputs.exclude, ...unit.inputs.includeIgnored ?? []]) {
    if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[a-z]:/iu.test(relative)
      || relative.split(/[\\/]/u).includes("..")) {
      throw new InstallationError("invalid_configuration", "Las rutas de la unidad Python deben permanecer dentro del proyecto");
    }
  }
  return config;
}

export function defaultConfiguration(interpreter = "python") {
  return {
    $schema: "./config.schema.json", schemaVersion: 3,
    integration: { provider: "codex", languages: ["python"], python: {
      interpreter, runner: "pytest", command: { executable: interpreter, args: ["-m", "pytest"] },
      cwd: ".", environment: {}, coverage: { format: "lcov", path: "lcov.info" }, scope: ["."],
      inputs: { include: ["**/*"], exclude: [".git/**", ".agentic-core/**", ".venv/**", "**/.env", "**/.env.*"],
        includeIgnored: [], respectGitIgnore: true },
    } },
    limits: { dry: { similarity: 0.82, minLines: 4, minNodes: 20 }, crap: 7, mutationScore: 90,
      operation: { commandTimeoutMs: 120000, totalBudgetMs: 600000, workers: 4 } },
  };
}
