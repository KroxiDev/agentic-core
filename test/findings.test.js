import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFindings,
  hasMaterialBlocker,
  materialFinding,
} from "../src/findings.js";

function blocker(overrides = {}) {
  return {
    impact: "blocking",
    category: "specification",
    authority: { criterionIds: ["C1"] },
    scope: "changed",
    evidence: {
      kind: "reproduction",
      detail: "node --test reproduces the wrong result",
    },
    materialImpact: "The accepted behavior is observably wrong.",
    minimalFix: "Correct the changed conditional.",
    ...overrides,
  };
}

test("a blocker requires every material condition", () => {
  assert.equal(materialFinding(blocker()), true);
  for (const invalid of [
    blocker({ authority: undefined }),
    blocker({ scope: "neighbor" }),
    blocker({ evidence: "a vague claim" }),
    blocker({ materialImpact: "" }),
    blocker({ minimalFix: "" }),
    blocker({ category: "preference" }),
  ]) {
    assert.equal(materialFinding(invalid), false);
    assert.equal(hasMaterialBlocker([invalid]), false);
    const [classified] = classifyFindings([invalid]);
    assert.equal(classified.impact, "advisory");
    assert.equal(classified.degradedFrom, "blocking");
  }
});

test("localized static proof is valid evidence", () => {
  assert.equal(materialFinding(blocker({
    scope: "direct_dependency",
    authority: { goldenRule: "Keep modules deep" },
    evidence: {
      kind: "static_proof",
      detail: "The changed adapter imports the forbidden layer.",
      location: "src/adapter.js:12",
    },
  })), true);
});

test("non-material concern classes are always advisory", () => {
  for (const advisoryReason of [
    "future_extensibility",
    "unsupported_input",
    "hypothetical_scenario",
    "preexisting_debt",
    "style_preference",
    "alternative_design",
    "unmeasured_optimization",
    "out_of_scope",
  ]) {
    const [classified] = classifyFindings([
      blocker({ advisoryReason }),
    ]);
    assert.equal(classified.impact, "advisory");
    assert.equal(hasMaterialBlocker([blocker({ advisoryReason })]), false);
  }
});
