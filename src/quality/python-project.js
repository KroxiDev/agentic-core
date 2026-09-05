import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfiguration } from "../installation/install.js";
import { privatePython } from "../installation/python.js";
import { IntegrationError, commandBudget, executeCommand } from "./command.js";
import { captureProjectInputs, publicCheckpoint } from "./project-inputs.js";
import { createProjectCopy, dependencyFingerprint, isolatedCommand, publicArgument, publicArguments, verifyProjectIntegrity } from "./project-copy.js";

const plugin = fileURLToPath(new URL("agentic_pytest.py", import.meta.url));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function inspectInterpreter(executable, context) {
  const result = await executeCommand({ executable, args: ["-c",
    "import json,sys,sysconfig,importlib.util; print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3]),'dependencies':list(set([sysconfig.get_path('purelib'),sysconfig.get_path('platlib')])),'pytest':importlib.util.find_spec('pytest') is not None}))"] },
  { ...context, timeoutMs: context.budget() });
  if (result.exitCode !== 0) throw new IntegrationError("python_unavailable", "No se pudo inspeccionar el intérprete seleccionado");
  let python;
  try { python = JSON.parse(result.stdout); }
  catch { throw new IntegrationError("python_unavailable", "El intérprete seleccionado no devolvió su identidad Python"); }
  if (!Array.isArray(python.version) || python.version[0] !== 3 || python.version[1] < 11) {
    throw new IntegrationError("unsupported_python", "Se requiere Python 3.11 o superior");
  }
  if (!python.pytest) throw new IntegrationError("pytest_unavailable", "El entorno del proyecto no contiene pytest; instale las dependencias del proyecto");
  return python;
}

async function projectInterpreter(root, unit, context) {
  const explicit = process.env.AGENTIC_CORE_PYTHON || unit.interpreter;
  if (explicit) return inspectInterpreter(explicit, context);
  const local = privatePython(path.join(root, ".venv"));
  try { await access(local); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return inspectInterpreter(process.platform === "win32" ? "python" : "python3", context);
  }
  return inspectInterpreter(local, context);
}

async function observe(root, config, python, context, temporary) {
  const unit = config.integration.python;
  const coverageWheel = path.join(root, ".agentic-core/runtime/third_party/python/coverage-7.13.4-py3-none-any.whl");
  try { await access(coverageWheel); }
  catch { throw new IntegrationError("coverage_unavailable", "Falta el wheel privado de cobertura; actualice la instalación"); }
  const settingsPath = path.join(temporary, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    temporary, interpreter: python.executable, coverageWheel, lcovPath: unit.coverage.path,
    projectRoot: context.copyRoot,
    measured: context.checkpoint.inventory.filter((entry) => entry.kind === "measured_code").map((entry) => entry.path),
    inputs: context.checkpoint.inventory.map((entry) => entry.path),
  }));
  const env = { ...context.env,
    AGENTIC_CORE_PYTHON: python.executable, AGENTIC_CORE_TEST_SETTINGS: settingsPath,
    PYTHONPATH: [path.dirname(plugin), context.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    PYTEST_PLUGINS: [context.env.PYTEST_PLUGINS, "agentic_pytest"].filter(Boolean).join(","),
  };
  const command = context.command;
  const timeoutMs = context.budget();
  const effective = { executable: command.executable === python.executable ? "[Python del proyecto]" : publicArgument(command.executable, context.checkpoint, context.copyRoot),
    args: publicArguments(command.args, context.checkpoint, context.copyRoot),
    cwd: unit.cwd, location: "controlled_copy", timeoutMs,
    environmentCount: Object.keys(unit.environment).length, environmentHash: digest(context.env),
    instrumentation: "private-pytest-plugin" };
  let execution;
  let executionError;
  try { execution = await executeCommand(command, { cwd: context.cwd, env, timeoutMs }); }
  catch (error) { error.effectiveCommand = effective; executionError = error; }
  const reports = (await readdir(temporary)).filter((name) => /^pytest-[a-f0-9]+\.json$/u.test(name));
  if (reports.length !== 1) {
    if (executionError) return integrationFailure(executionError);
    return { effectiveCommand: effective, suite: { status: "NO_VERIFICADO", commandExitCode: execution.exitCode },
      coverage: { status: "unknown", files: null }, code: "pytest_unobserved", exitCode: 2,
      message: "Se requiere una ejecución observable de pytest; revise que el wrapper conserve el entorno del plugin privado" };
  }
  let observed;
  try { observed = JSON.parse(await readFile(path.join(temporary, reports[0]), "utf8")); }
  catch { throw new IntegrationError("invalid_test_evidence", "La evidencia de pytest es ilegible", 5); }
  const suite = { ...observed.suite, commandExitCode: execution?.exitCode ?? null };
  const common = { effectiveCommand: effective, python: { executable: "[Python del proyecto]", version: observed.version, pytestVersion: observed.pytestVersion }, suite, coverage: observed.coverage };
  if (executionError) return { ...integrationFailure(executionError), ...common };
  if (observed.error) return { ...common, code: observed.error, exitCode: 2, message: "El intérprete o la cobertura efectiva no cumple la integración declarada" };
  if (suite.exitCode === undefined && [3, 4].includes(execution.exitCode)) {
    return { ...common, code: execution.exitCode === 4 ? "pytest_invalid_usage" : "pytest_internal_error",
      exitCode: execution.exitCode === 4 ? 4 : 5, message: "Pytest no pudo completar su inicialización" };
  }
  const pytestCodes = { 1: ["tests_failed", 1], 2: ["pytest_interrupted", 6], 3: ["pytest_internal_error", 5], 4: ["pytest_invalid_usage", 4], 5: ["no_tests_collected", 2] };
  if (suite.exitCode !== 0) {
    const [code, exitCode] = pytestCodes[suite.exitCode] ?? ["pytest_incomplete", 2];
    return { ...common, code, exitCode, message: "La ejecución de pytest no aprobó; consulte el estado y código de la suite" };
  }
  if (execution.exitCode !== 0) return { ...common, code: "command_failed", exitCode: 1, message: "El wrapper terminó con un fallo después de pytest" };
  if (suite.status !== "passed" || !Number.isInteger(suite.phases?.call) || suite.phases.call <= 0) {
    return { ...common, code: "tests_not_executed", exitCode: 2,
      message: "Pytest terminó sin evidencia de ejecución de tests; la recolección y la preparación no permiten aprobar" };
  }
  if (observed.coverage.status !== "measured" || !Object.keys(observed.coverage.files ?? {}).length) {
    return { ...common, code: "coverage_failed", exitCode: 2, message: "La suite terminó, pero falta cobertura atribuible; no se asume cobertura cero" };
  }
  return { ...common, code: "tests_passed", exitCode: 0, message: "Suite aprobada y cobertura obtenida; esto no acredita los demás controles de calidad" };
}

export async function runProjectTests(projectRoot) {
  let effectiveCommand;
  let config;
  try {
    config = await readConfiguration(path.join(projectRoot, ".agentic-core/config.json"));
    const unit = config.integration.python;
    const checkpoint = await captureProjectInputs(projectRoot, unit);
    const inputEvidence = publicCheckpoint(checkpoint);
    if (checkpoint.issues.length) return { command: "test", status: "NO_VERIFICADO", code: "input_checkpoint_incompatible",
      message: "Los inputs contienen enlaces, tipos incompatibles o cambios durante el checkpoint", exitCode: 2, inputs: inputEvidence };
    const context = { cwd: path.resolve(projectRoot, unit.cwd), env: { ...process.env, ...unit.environment, PYTHONDONTWRITEBYTECODE: "1" },
      budget: commandBudget(config.limits.operation) };
    const python = await projectInterpreter(projectRoot, unit, context);
    const copy = await createProjectCopy(checkpoint);
    let result;
    try {
      const isolated = isolatedCommand(unit, python, checkpoint, copy.root, process.env);
      const protectedPaths = [python.executable, ...python.dependencies, path.join(projectRoot, ".agentic-core/config.json"),
        path.join(projectRoot, ".agentic-core/runtime/third_party/python/coverage-7.13.4-py3-none-any.whl")];
      const dependencies = await dependencyFingerprint(protectedPaths);
      let integrity = await verifyProjectIntegrity(checkpoint, unit, copy.root, "preparation");
      if (integrity.status !== "preserved") {
        result = { code: "input_integrity_changed", exitCode: 2, message: "Los inputs cambiaron durante la preparación; no se ejecutaron pruebas", integrity };
      } else {
        try { result = await observe(projectRoot, config, python, { ...context, ...isolated, checkpoint, copyRoot: copy.root }, copy.temporary); }
        catch (error) { result = integrationFailure(error); }
        integrity = await verifyProjectIntegrity(checkpoint, unit, copy.root, "tests");
        integrity.dependencies = await dependencyFingerprint(protectedPaths) === dependencies ? "preserved" : "changed";
        if (integrity.dependencies !== "preserved") integrity.status = "NO_VERIFICADO";
        if (integrity.status !== "preserved") result = { ...result, code: "input_integrity_changed", exitCode: 2,
          message: "Se detectaron cambios en inputs protegidos; se conserva la evidencia parcial y no se restauran archivos del original" };
        result.integrity = integrity;
      }
    } catch (error) {
      const failure = integrationFailure(error);
      result = { ...failure, ...result, code: failure.code, exitCode: failure.exitCode, message: failure.message,
        integrity: { status: "NO_VERIFICADO", phase: result ? "tests" : "preparation", restored: false } };
    }
    finally { await copy.dispose(); }
    return { command: "test", ...result, status: result.exitCode === 0 ? "approved" : result.exitCode === 1 ? "rejected" : "NO_VERIFICADO",
      inputs: inputEvidence, configurationHash: digest(config), limits: config.limits.operation };
  } catch (error) {
    effectiveCommand = error.effectiveCommand;
    const typed = error instanceof IntegrationError || (typeof error.code === "string" && Number.isInteger(error.exitCode));
    return { command: "test", status: "NO_VERIFICADO", code: typed ? error.code : "integration_internal_error",
      message: typed ? error.message : "Fallo interno de integración; no se obtuvo evidencia completa",
      exitCode: typed ? error.exitCode : 5, effectiveCommand,
      suite: { status: "NO_VERIFICADO" }, coverage: { status: "unknown", files: null }, limits: config?.limits.operation };
  }
}

function integrationFailure(error) {
  const typed = error instanceof IntegrationError;
  return { code: typed ? error.code : "integration_internal_error", exitCode: typed ? error.exitCode : 5,
    message: typed ? error.message : "Fallo interno de integración; no se obtuvo evidencia completa",
    effectiveCommand: error.effectiveCommand,
    suite: { status: "NO_VERIFICADO" }, coverage: { status: "unknown", files: null } };
}

export async function runPythonQualityCli(args, io = process) {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    io.stdout.write("Uso: agentic-quality test\nEjecuta el comando pytest de config.json en una copia controlada y devuelve cobertura con rutas públicas relativas.\nCódigos: 0 suite aprobada; 1 fallo; 2 aislamiento, integridad, entorno o cobertura no verificados; 4 uso inválido; 5 fallo interno; 6 timeout o interrupción.\n");
    return 0;
  }
  const result = args.length === 1 && args[0] === "test" ? await runProjectTests(process.cwd())
    : { command: args[0], status: "NO_VERIFICADO", code: ["prepare", "verify", "scan", "crap", "mutate", "mutation"].includes(args[0]) ? "quality_pending" : "invalid_usage",
      message: "Use agentic-quality test; los controles agregados del esquema 3 están pendientes de integración",
      exitCode: ["prepare", "verify", "scan", "crap", "mutate", "mutation"].includes(args[0]) ? 2 : 4 };
  if (io.env?.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result)}\n`);
  else io.stdout.write(`${result.status} [${result.code}] ${result.message}\n`);
  return result.exitCode;
}
