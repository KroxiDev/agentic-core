import assert from "node:assert/strict";
import test from "node:test";
import { parseDryResolutions } from "../src/quality/python-dry.js";

const candidate = "a".repeat(64);
const resolution = { candidate, decision: "keep", reason: "conservar ambos contratos" };
const parse = (resolutions) => parseDryResolutions(Buffer.from(JSON.stringify({ schemaVersion: 1, resolutions })));

test("DRY resolution schema accepts candidate aliases and normalizes reasons", () => {
  assert.deepEqual(parse([]).resolutions, []);
  assert.deepEqual(parse([{ candidateId: candidate, decision: "keep", reason: `  ${resolution.reason}  ` }]).resolutions,
    [resolution]);
});

test("DRY resolution schema rejects ambiguous or malformed ownership", () => {
  for (const entries of [
    [resolution, resolution], [null], [{ ...resolution, candidate: "unknown" }],
    [{ ...resolution, decision: "delete" }], [{ ...resolution, reason: "ok" }],
    [{ ...resolution, reason: "first\nsecond" }], [{ ...resolution, reason: "x".repeat(501) }],
  ]) assert.throws(() => parse(entries), { code: "dry_resolution_invalid" });
  for (const content of ["not JSON", "[]", '{"schemaVersion":2,"resolutions":[]}']) {
    assert.throws(() => parseDryResolutions(Buffer.from(content)), { code: "dry_resolution_invalid" });
  }
});
