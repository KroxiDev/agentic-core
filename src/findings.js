export const FINDING_CATEGORIES = new Set([
  "specification",
  "tests",
  "crap",
  "mutation",
  "golden_rules",
  "required_validation",
  "documentation",
]);
const ADVISORY_ONLY = new Set([
  "future_extensibility",
  "unsupported_input",
  "hypothetical_scenario",
  "preexisting_debt",
  "style_preference",
  "alternative_design",
  "unmeasured_optimization",
  "out_of_scope",
]);
const MATERIAL_SCOPES = new Set([
  "changed",
  "direct_dependency",
]);
const EVIDENCE_KINDS = new Set([
  "reproduction",
  "static_proof",
]);

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function authorityIsConcrete(authority) {
  if (!authority || typeof authority !== "object") return false;
  const criterionIds = authority.criterionIds;
  return (
    Array.isArray(criterionIds)
    && criterionIds.length > 0
    && criterionIds.every(text)
  ) || text(authority.restriction)
    || text(authority.goldenRule)
    || text(authority.requiredGate);
}
function evidenceIsConcrete(evidence) {
  if (!evidence || typeof evidence !== "object") return false;
  if (!EVIDENCE_KINDS.has(evidence.kind) || !text(evidence.detail)) {
    return false;
  }
  if (evidence.kind === "static_proof") {
    return text(evidence.location);
  }
  return true;
}
export function materialFinding(finding) {
  return finding?.impact === "blocking"
    && FINDING_CATEGORIES.has(finding.category)
    && !ADVISORY_ONLY.has(finding.advisoryReason)
    && authorityIsConcrete(finding.authority)
    && MATERIAL_SCOPES.has(finding.scope)
    && evidenceIsConcrete(finding.evidence)
    && text(finding.materialImpact)
    && text(finding.minimalFix);
}
export function classifyFindings(findings) {
  if (!Array.isArray(findings)) return [];
  return findings.map((finding) => {
    if (finding?.impact !== "blocking" || materialFinding(finding)) {
      return finding;
    }
    return {
      ...finding,
      impact: "advisory",
      degradedFrom: "blocking",
      degradationReason:
        "Finding does not satisfy every material blocking condition.",
    };
  });
}
export function hasMaterialBlocker(findings) {
  return classifyFindings(findings).some((finding) =>
    materialFinding(finding));
}
export function validAdvisory(finding) {
  return finding?.impact === "advisory"
    && FINDING_CATEGORIES.has(finding.category);
}
