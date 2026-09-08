import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfiguration } from "../installation/install.js";
import { privatePython } from "../installation/python.js";
import { IntegrationError, commandBudget, executeCommand } from "./command.js";
import { formatBudget, withCurrentTaskBudget } from "./task-budget.js";
import { captureProjectInputs, publicCheckpoint } from "./project-inputs.js";
import { createProjectCopy, dependencyFingerprint, isolatedCommand, publicArgument, publicArguments, verifyProjectIntegrity } from "./project-copy.js";
import { normalizeSelection, parseTestSelection, resolveSelection, resolveTaskSelection } from "./selection.js";

const plugin = fileURLToPath(new URL("agentic_pytest.py", import.meta.url));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function projectTestIdentity(root, config, selection) {
  const unit = config.integration.python;
  const env = { ...process.env, ...unit.environment, PYTHONDONTWRITEBYTECODE: "1" };
  const context = { cwd: path.resolve(root, unit.cwd), env, budget: commandBudget(config.limits.operation) };
  const python = await projectInterpreter(root, unit, context);
  const protectedPaths = [python.executable, ...python.dependencies, path.join(root, ".agentic-core/config.json"),
    path.join(root, ".agentic-core/runtime")];
  const dependencies = await dependencyFingerprint(protectedPaths);
  const environment = Object.fromEntries(Object.entries(env).filter(([key]) => key !== "AGENTIC_CORE_OUTPUT").sort());
  return { context, python, protectedPaths, dependencies,
    identity: digest({ configuration: config, dependencies, environment, node: process.version, platform: process.platform, arch: process.arch,
      ...(selection ? { selection } : {}) }) };
}

async function inspectInterpreter(executable, context) {
  const result = await executeCommand({ executable, args: ["-c",
    "import json,sys,sysconfig,importlib.util; print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3]),'dependencies':list(set([sysconfig.get_path('purelib'),sysconfig.get_path('platlib')])),'pytest':importlib.util.find_spec('pytest') is not None}))"] },
  { ...context, timeoutMs: context.budget(), account: false });
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

export async function observeProjectTests(root, config, python, context, temporary) {
  const unit = config.integration.python;
  const requireCoverage = context.requireCoverage !== false;
  const coverageWheel = path.join(root, ".agentic-core/runtime/third_party/python/coverage-7.13.4-py3-none-any.whl");
  try { await access(coverageWheel); }
  catch { if (requireCoverage) throw new IntegrationError("coverage_unavailable", "Falta el wheel privado de cobertura; actualice la instalación"); }
  const settingsPath = path.join(temporary, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    temporary, interpreter: python.executable, coverageWheel, requireCoverage, lcovPath: unit.coverage.path,
    projectRoot: context.copyRoot,
    measured: context.checkpoint.inventory.filter((entry) => entry.kind === "measured_code").map((entry) => entry.path),
    inputs: context.checkpoint.inventory.map((entry) => entry.path),
    selection: context.checkpoint.selection,
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
  effective.timeoutMs = execution?.timeoutMs ?? executionError?.timeoutMs ?? timeoutMs;
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
  if (context.checkpoint.selection?.tests && JSON.stringify(observed.selection?.tests) !== JSON.stringify(context.checkpoint.selection.tests)) {
    return { ...common, code: "test_selection_unobserved", exitCode: 2, message: "Pytest no confirmó la selección explícita; no se puede aprobar" };
  }
  const pytestCodes = { 1: ["tests_failed", 1], 2: ["pytest_interrupted", 6], 3: ["pytest_internal_error", 5], 4: ["pytest_invalid_usage", 4], 5: ["no_tests_collected", 2] };
  if (suite.exitCode !== 0) {
    if (suite.exitCode === 1 && suite.failures?.some((failure) => failure.kind === "dependency_error")) {
      return { ...common, code: "pytest_dependency_failed", exitCode: 2, message: "Una importación falló en el entorno del proyecto; no se obtuvo una comprobación válida" };
    }
    if (suite.exitCode === 1 && suite.failures?.some((failure) => failure.kind === "unattributed_group")) {
      return { ...common, code: "pytest_failure_unattributed", exitCode: 2, message: "Un grupo de errores contiene fallos sin atribución; no se obtuvo una comprobación válida" };
    }
    if (suite.exitCode === 1 && suite.failures?.some((failure) => failure.phase !== "call" && !["assertion", "production_exception"].includes(failure.kind))) {
      return { ...common, code: "pytest_fixture_failed", exitCode: 2, message: "La preparación o limpieza de una prueba terminó con un error; no se obtuvo una comprobación válida" };
    }
    const [code, exitCode] = pytestCodes[suite.exitCode] ?? ["pytest_incomplete", 2];
    return { ...common, code, exitCode, message: "La ejecución de pytest no aprobó; consulte el estado y código de la suite" };
  }
  if (execution.exitCode !== 0) return { ...common, code: "command_failed", exitCode: 1, message: "El wrapper terminó con un fallo después de pytest" };
  if (suite.status !== "passed" || !Number.isInteger(suite.phases?.call) || suite.phases.call <= 0) {
    return { ...common, code: "tests_not_executed", exitCode: 2,
      message: "Pytest terminó sin evidencia de ejecución de tests; la recolección y la preparación no permiten aprobar" };
  }
  if (requireCoverage && (observed.coverage.status !== "measured" || !Object.keys(observed.coverage.files ?? {}).length)) {
    return { ...common, code: "coverage_failed", exitCode: 2, message: "La suite terminó, pero falta cobertura atribuible; no se asume cobertura cero" };
  }
  if (context.checkpoint.selection) {
    const unmeasuredFiles = context.checkpoint.inventory.filter((entry) => entry.kind === "measured_code"
      && !Object.hasOwn(observed.coverage.files ?? {}, entry.path)).map((entry) => entry.path);
    common.coverage = { ...observed.coverage, unmeasuredFiles };
    if (requireCoverage && unmeasuredFiles.length) return { ...common,
      code: "coverage_incomplete", exitCode: 2, message: "Parte del código seleccionado no tiene cobertura atribuible; se conserva la medición parcial" };
  }
  return { ...common, code: "tests_passed", exitCode: 0, message: "Tests funcionales aprobados; la cobertura se informa por separado y no acredita otros controles" };
}

export async function runProjectTests(projectRoot, selection, { requireCoverage = false, referenceCheckpoint } = {}) {
  try { return await withCurrentTaskBudget(projectRoot, async () => {
    const resolved = await resolveTaskSelection(projectRoot, normalizeSelection(selection));
    const result = await executeProjectTests(projectRoot, resolved.selection, requireCoverage, referenceCheckpoint);
    if (resolved.delta) {
      const config = await readConfiguration(path.join(projectRoot, ".agentic-core/config.json"));
      const current = await captureProjectInputs(projectRoot, config.integration.python);
      if (current.digest !== resolved.delta.checkpoint) return { ...result,
        status: "NO_VERIFICADO", code: "input_integrity_changed", exitCode: 2, taskDelta: resolved.delta };
    }
    return { ...result, ...(resolved.delta ? { taskDelta: resolved.delta } : {}) };
  }); }
  catch (error) { return { command: "test", status: "NO_VERIFICADO", ...integrationFailure(error) }; }
}

async function executeProjectTests(projectRoot, selection, requireCoverage, referenceCheckpoint) {
  let effectiveCommand;
  let config;
  let effectiveSelection;
  try {
    config = await readConfiguration(path.join(projectRoot, ".agentic-core/config.json"));
    const unit = config.integration.python;
    const currentCheckpoint = await captureProjectInputs(projectRoot, unit, selection);
    const checkpoint = referenceCheckpoint ?? currentCheckpoint;
    effectiveSelection = resolveSelection(currentCheckpoint, unit, selection);
    if (referenceCheckpoint) effectiveSelection.measuredFiles = checkpoint.inventory
      .filter((entry) => entry.kind === "measured_code").map((entry) => entry.path);
    const inputEvidence = publicCheckpoint(checkpoint);
    if (checkpoint.issues.length) return { command: "test", status: "NO_VERIFICADO", code: "input_checkpoint_incompatible",
      message: "Los inputs no admiten una copia fiel: revise enlaces, tipos, cambios o código excluido por privacidad", exitCode: 2, inputs: inputEvidence, selection: effectiveSelection };
    const { context, python, protectedPaths, dependencies, identity } = await projectTestIdentity(projectRoot, config, selection);
    const copy = await createProjectCopy(checkpoint);
    let result;
    try {
      const isolated = isolatedCommand(unit, python, checkpoint, copy.root, process.env);
      let integrity = await verifyProjectIntegrity(currentCheckpoint, unit, copy.root, "preparation", checkpoint);
      if (integrity.status !== "preserved") {
        result = { code: "input_integrity_changed", exitCode: 2, message: "Los inputs cambiaron durante la preparación; no se ejecutaron pruebas", integrity };
      } else {
        try { result = await observeProjectTests(projectRoot, config, python, { ...context, ...isolated, checkpoint, copyRoot: copy.root, requireCoverage }, copy.temporary); }
        catch (error) { result = integrationFailure(error); }
        integrity = await verifyProjectIntegrity(currentCheckpoint, unit, copy.root, "tests", checkpoint);
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
      inputs: inputEvidence, selection: effectiveSelection, configurationHash: digest(config), executionIdentity: identity, limits: config.limits.operation };
  } catch (error) {
    effectiveCommand = error.effectiveCommand;
    const typed = error instanceof IntegrationError || (typeof error.code === "string" && Number.isInteger(error.exitCode));
    return { command: "test", status: "NO_VERIFICADO", code: typed ? error.code : "integration_internal_error",
      message: typed ? error.message : "Fallo interno de integración; no se obtuvo evidencia completa",
      exitCode: typed ? error.exitCode : 5, effectiveCommand, selection: effectiveSelection ?? selection,
      suite: { status: "NO_VERIFICADO" }, coverage: { status: "unknown", files: null }, limits: config?.limits.operation };
  }
}

function integrationFailure(error) {
  const typed = error instanceof IntegrationError || (typeof error.code === "string" && Number.isInteger(error.exitCode));
  return { code: typed ? error.code : "integration_internal_error", exitCode: typed ? error.exitCode : 5,
    message: typed ? error.message : "Fallo interno de integración; no se obtuvo evidencia completa",
    effectiveCommand: error.effectiveCommand, budget: error.budget,
    suite: { status: "NO_VERIFICADO" }, coverage: { status: "unknown", files: null } };
}

export async function runPythonQualityCli(args, io = process) {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    io.stdout.write("Tests por invocación: agentic-quality test [--scope <archivo|carpeta>]... [--test <archivo|carpeta>]... Rutas relativas a la raíz del proyecto, sin globs ni funciones. Selecciones transitorias: código medido y tests por separado, sin editar configuración ni ejecutar DRY, C.R.A.P. o mutación. Sin opciones conserva el alcance y comando del proyecto.\n");
    io.stdout.write("Diagnóstico: agentic-quality explain [--json] explica integración, inputs, límites y vigencia sin ejecutar pruebas ni reparar evidencia. La salida habitual es breve también por pipes; AGENTIC_CORE_OUTPUT=json conserva la automatización.\n");
    io.stdout.write("Exportación por petición: agentic-quality export --output <archivo.md> guarda el último veredicto con evidencia resumida; export --stdout prepara Markdown para una entrega autorizada del host, sin confirmar publicación remota. No vuelve a ejecutar pruebas ni activa al Documentador.\n");
    io.stdout.write("Mutación: agentic-quality mutate [--scope <archivo|carpeta>]... [--test <archivo|carpeta>]... ejecuta mutantes de mutate4py con el comando autoritativo en una copia controlada. Informe: .agentic-core/quality/mutation.json. Agrega el score del estado actual sin exigir tarea ni ejecutar DRY o C.R.A.P.; no emite aprobación incremental.\n");
    io.stdout.write("DRY autónomo: agentic-quality dry [--scope <archivo|carpeta>]... analiza el código actual con dry4python fijado, sin baseline ni otros controles. Selección transitoria; sin opciones usa el alcance de config.json. Informa todos los candidatos, incluidos los preexistentes, sin reparar ni aprobar implementaciones; no interpreta el código de salida del motor como aprobación. Informe: .agentic-core/quality/dry.json.\n");
    io.stdout.write("C.R.A.P.: agentic-quality crap [--scope <archivo|carpeta>]... [--test <archivo|carpeta>]... mide el estado actual sin preparar una tarea ni ejecutar DRY o mutación. Selección transitoria y límite de config.json; conserva resultados parciales. Informe: .agentic-core/quality/crap.json.\n");
    io.stdout.write("Uso: agentic-quality test\nEjecuta el comando pytest de config.json en una copia controlada y devuelve cobertura con rutas públicas relativas.\nTareas Directo, Light, Normal y Full: prepare --task <id> --mode <modo> --objective <referencia> [--repair-test <ruta>]; baseline consulta el inicio. Light/Normal: prepare captura la referencia y tests sin motores opcionales; verify exige tests funcionales y solo controles solicitados. --control <dry|crap|mutation> repetible (o none) selecciona por tarea en prepare o por ejecución en verify; las comparaciones incompletas son NO_VERIFICADO, los omitidos NO_SOLICITADO. verify acepta --scope/--test o --changes [--test <ruta>]. test también acepta --changes contra el inicio guardado; sin código medible actual devuelve delta_without_code, sin ampliar el alcance. Full exige además Mutation Testing incremental concluyente. Directo no requiere preparación.\nCódigos: 0 suite aprobada o baseline válido (puede contener fallos); 1 fallo; 2 aislamiento, integridad, entorno, cobertura o calidad no verificados; 4 uso inválido; 5 fallo interno; 6 timeout o interrupción.\n");
    return 0;
  }
  let result;
  try { result = args[0] === "test" ? await runProjectTests(process.cwd(), parseTestSelection(args.slice(1), { allowChanges: true }))
    : { command: args[0], status: "NO_VERIFICADO", code: ["prepare", "verify", "scan", "crap", "mutate", "mutation"].includes(args[0]) ? "quality_pending" : "invalid_usage",
      message: "Use agentic-quality test, dry o los comandos de tarea prepare, baseline y verify",
      exitCode: ["prepare", "verify", "scan", "crap", "mutate", "mutation"].includes(args[0]) ? 2 : 4 };
  } catch (error) { result = { command: args[0], status: "NO_VERIFICADO", ...integrationFailure(error) }; }
  if (io.env?.AGENTIC_CORE_OUTPUT === "json") io.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    io.stdout.write(`${result.status} [${result.code}] ${result.message}\n${formatBudget(result.budget)}`);
    if (result.selection) io.stdout.write(`Código: ${result.selection.measuredFiles?.join(", ") || "sin medición"}\nTests: ${result.selection.tests?.join(", ") ?? "comando del proyecto"}\n`);
    if (result.suite?.executed) io.stdout.write(`Tests ejecutados: ${result.suite.executed.length}; archivos: ${[...new Set(result.suite.executed.map((entry) => entry.path))].join(", ")}\n`);
  }
  return result.exitCode;
}
