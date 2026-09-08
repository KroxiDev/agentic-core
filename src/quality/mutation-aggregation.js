const noVerification = "NO_VERIFICADO";

function meetsMutationThreshold(detected, denominator, threshold) {
  // Compare integer counts with the configured decimal value, without an
  // intermediate floating-point percentage or a tolerance below the minimum.
  const [mantissa, exponent = "0"] = String(threshold).split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = fraction.length - Number(exponent);
  const minimum = BigInt(whole + fraction);
  const numerator = BigInt(detected) * 100n;
  return scale >= 0
    ? numerator * 10n ** BigInt(scale) >= minimum * BigInt(denominator)
    : numerator >= minimum * 10n ** BigInt(-scale) * BigInt(denominator);
}

export function aggregateMutation(report, threshold) {
  const selection = report?.selection;
  const required = Array.isArray(selection?.required) ? selection.required : [];
  const preexisting = Array.isArray(selection?.preexisting) ? selection.preexisting : [];
  const equivalent = Array.isArray(selection?.equivalent) ? selection.equivalent : [];
  const details = Array.isArray(report?.details) ? report.details : [];
  const requiredIds = new Set(required.map((mutant) => mutant.id));
  const requiredDetails = details.filter((detail) => requiredIds.has(detail.id));
  const detailIds = new Set(requiredDetails.map((detail) => detail.id));
  const missing = required.filter((mutant) => !detailIds.has(mutant.id));
  const count = (status) => requiredDetails.filter((detail) => detail.status === status).length;
  const killed = count("killed");
  const survived = count("survived");
  const uncovered = count("uncovered");
  const timeout = count("timeout");
  const errors = count("error");
  const interrupted = count("interrupted");
  const invalid = requiredDetails.filter((detail) => !["killed", "survived", "uncovered", "timeout", "error", "interrupted"].includes(detail.status)).length;
  const pending = Math.max(Number.isInteger(report?.pending) ? report.pending : 0, missing.length);
  const inconclusive = timeout + errors + interrupted + invalid + pending;
  const denominator = required.length;
  const exactPercentage = denominator === 0 ? null : (killed / denominator) * 100;
  const percentage = exactPercentage === null ? null : Number(exactPercentage.toFixed(2));
  const score = {
    detected: killed,
    denominator,
    percentage,
    threshold,
    survived,
    uncovered,
    inconclusive,
    equivalent: equivalent.length,
  };
  const inventory = {
    generated: selection?.counts?.generated ?? report?.generated ?? 0,
    required: denominator,
    preexisting: preexisting.length,
    equivalent: equivalent.length,
  };
  const summary = {
    ...(report?.summary ?? {}),
    killed,
    survived,
    uncovered,
    timeout,
    error: errors,
    interrupted,
    invalid,
    pending,
    inconclusive,
    denominator,
    preexisting: preexisting.length,
    equivalent: equivalent.length,
  };
  const executable = Boolean(selection);
  const complete = report?.complete === true && report?.code === "mutation_execution_complete"
    && report?.integrity?.status === "preserved"
    && missing.length === 0 && inconclusive === 0;
  const base = {
    ...report,
    command: "mutation",
    required: true,
    executed: Boolean(report?.generated !== undefined || details.length > 0),
    selection,
    score,
    mutationScore: percentage,
    inventory,
    summary,
  };
  if (!executable) {
    return {
      ...base,
      status: noVerification,
      code: report?.code ?? "mutation_selection_missing",
      message: report?.message ?? "No se pudo obtener un inventario verificable de mutantes",
      exitCode: report?.exitCode ?? 2,
    };
  }
  if (!complete) {
    return {
      ...base,
      status: noVerification,
      code: report?.code === "mutation_execution_complete" ? "mutation_inconclusive" : report?.code ?? "mutation_inconclusive",
      message: report?.code !== "mutation_execution_complete" && report?.message
        ? report.message : "La evidencia de mutación contiene mutantes requeridos inconclusos o incompletos",
      exitCode: report?.exitCode ?? 2,
    };
  }
  if (denominator === 0) {
    return {
      ...base,
      status: "NO_APLICA",
      code: selection.method === "current_state" ? "no_mutants" : "no_incremental_mutants",
      message: "El inventario no contiene mutantes exigibles; no se asigna un score automático de 100",
      exitCode: 0,
    };
  }
  if (meetsMutationThreshold(killed, denominator, threshold)) {
    return {
      ...base,
      status: "approved",
      code: "mutation_score_approved",
      message: `Mutation score ${percentage}% cumple el mínimo configurado de ${threshold}%`,
      exitCode: 0,
    };
  }
  return {
    ...base,
    status: "rejected",
    code: "mutation_score_below_limit",
    message: `Mutation score ${percentage}% no alcanza el mínimo configurado de ${threshold}%`,
    exitCode: 1,
  };
}
