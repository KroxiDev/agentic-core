import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMutation } from "../src/quality/mutation-aggregation.js";

test("mutation aggregation preserves an exhausted budget as inconclusive", () => {
  const report = aggregateMutation({
    command: "mutation",
    code: "budget_exhausted",
    complete: false,
    integrity: { status: "preserved" },
    selection: {
      counts: { generated: 1 },
      required: [{ id: "budget" }],
      preexisting: [],
      equivalent: [],
    },
    details: [],
    pending: 1,
    exitCode: 6,
  }, 10);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "budget_exhausted");
  assert.equal(report.exitCode, 6);
  assert.equal(report.score.inconclusive, 1);
  assert.equal(report.summary.pending, 1);
});

test("mutation score compares the exact ratio and rounds only its presentation", () => {
  const buildReport = () => ({
    command: "mutation",
    code: "mutation_execution_complete",
    complete: true,
    integrity: { status: "preserved" },
    selection: {
      counts: { generated: 3 },
      required: [{ id: "killed-1" }, { id: "killed-2" }, { id: "survived-1" }],
      preexisting: [],
      equivalent: [],
    },
    details: [
      { id: "killed-1", status: "killed" },
      { id: "killed-2", status: "killed" },
      { id: "survived-1", status: "survived" },
    ],
  });

  const below = aggregateMutation(buildReport(), 66.67);
  assert.equal(below.score.percentage, 66.67);
  assert.equal(below.status, "rejected");
  assert.equal(below.code, "mutation_score_below_limit");

  const exact = aggregateMutation(buildReport(), (2 / 3) * 100);
  assert.equal(exact.score.percentage, 66.67);
  assert.equal(exact.status, "approved");
  assert.equal(exact.code, "mutation_score_approved");
});

test("mutation score never approves an inconclusive required mutant", () => {
  const report = aggregateMutation({
    command: "mutation",
    code: "mutation_execution_complete",
    complete: true,
    integrity: { status: "preserved" },
    selection: {
      counts: { generated: 5 },
      required: [
        { id: "killed-1" }, { id: "killed-2" }, { id: "timeout-1" },
        { id: "error-1" }, { id: "interrupted-1" },
      ],
      preexisting: [],
      equivalent: [],
    },
    details: [
      { id: "killed-1", status: "killed" },
      { id: "killed-2", status: "killed" },
      { id: "timeout-1", status: "timeout" },
      { id: "error-1", status: "error" },
      { id: "interrupted-1", status: "interrupted" },
    ],
  }, 40);
  assert.equal(report.score.percentage, 40);
  assert.equal(report.status, "NO_VERIFICADO");
  assert.equal(report.code, "mutation_inconclusive");
  assert.equal(report.score.inconclusive, 3);
  assert.equal(report.summary.timeout, 1);
  assert.equal(report.summary.error, 1);
  assert.equal(report.summary.interrupted, 1);
});

test("mutation score accepts literal decimal equality without accepting a higher minimum", () => {
  for (const [detected, denominator, threshold] of [[29, 100, 29], [57, 100, 57], [58, 100, 58], [29, 200, 14.5]]) {
    const required = Array.from({ length: denominator }, (_, id) => ({ id: String(id) }));
    const report = { code: "mutation_execution_complete", complete: true, integrity: { status: "preserved" },
      selection: { required, preexisting: [], equivalent: [] },
      details: required.map((item, index) => ({ ...item, status: index < detected ? "killed" : "survived" })) };
    assert.equal(aggregateMutation(report, threshold).status, "approved", `${detected}/${denominator} = ${threshold}%`);
    assert.equal(aggregateMutation(report, threshold + 1e-12).status, "rejected");
    assert.equal(aggregateMutation(report, threshold - 1e-12).status, "approved");
  }
});

test("mutation aggregation preserves an operational failure after all mutants finish", () => {
  const result = aggregateMutation({ code: "mutation_cleanup_failed", message: "No se pudo limpiar la copia", exitCode: 5, complete: true,
    integrity: { status: "preserved" }, selection: { required: [{ id: "one" }], preexisting: [], equivalent: [] },
    details: [{ id: "one", status: "killed" }], pending: 0 }, 90);
  assert.equal(result.status, "NO_VERIFICADO");
  assert.equal(result.code, "mutation_cleanup_failed");
  assert.equal(result.message, "No se pudo limpiar la copia");
  assert.equal(result.exitCode, 5);
});
