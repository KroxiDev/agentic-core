# Release validation and timeboxed native observations

Issue #16 closes under an explicitly reduced scope. The automated suites and exact package inventory are the final acceptance gate. The six Codex and Claude Code rows below are retained only as timeboxed integration observations: every row was attempted, no row was approved, and none is a `PASS` or a release blocker.

## Durable issue #16 closure record

- Correction: `retryInvalidHandoff` now gives a fresh light-mode role the original `intention`, `sources` and `policy`, plus only the safe allowlisted context already present in the prior brief. The protocol retry preserves configuration, skills and permissions, and does not consume retrabajo. The regression follows an invalid Implementador response through the fresh retry to Tester and terminal completion with `reworkCount: 0`.
- Existing focused validation: 82/82 tests passed.
- Existing complete validation: `npm.cmd run check` passed; the Node suite passed 250/250; the Python suite passed 2/2; `npm.cmd pack --dry-run --json` reported 40 files and 74,518 bytes; `git diff --check` passed.
- Historical corrected candidate: commit `977199cedbafff91380981495de00c284f35b9b8`; tarball SHA-256 `66A909F13A1F79CEE8A61EA7DB6546258C11EAA104F76AF8D1601E46E2C6E3B9`. The earlier `c86aa9b` candidate remains invalid.
- Decision: no further work for #16 will investigate native host permissions, hooks, guards, prompt transport, runners or host limitations. Later real-world use of the agentic layer belongs to the user and is not an issue, task, milestone or acceptance gate.

## Final automated gate

Run one current-tree pass of:

- `npm.cmd run check`
- `npm.cmd test`
- `npm.cmd run test:python`
- `npm.cmd pack --dry-run --json`
- `git diff --check`

All commands must pass, and the package inventory must contain exactly the intended 40 files with no fixtures, caches, run state, native evidence or validation helpers. This automated gate replaces native-row approval for issue #16.

## Native observation reference

The checklist below records what a future optional native investigation would need to prove. It is preserved as useful integration guidance, but its checkboxes and rows do not gate issue #16 or the `0.1.0` closure. If the same candidate commit and tarball SHA-256 are ever evaluated again, the observations must remain distinct from automated acceptance.

- [ ] Create one candidate commit from a clean tracked tree and record its full SHA-1.
- [ ] Run `npm pack` once, record the tarball SHA-256, and install those exact bytes in all six clean fixtures.
- [ ] Use separate Windows 10 or Windows 11 fixture directories for every host/mode pair; include at least one path containing spaces.
- [ ] Record candidate commit, tarball SHA-256, package version, host version, Node version, Python version when applicable, Windows version, date, fixture path, and native session identifier.
- [ ] Confirm the installed ownership manifest, canonical skill, host profiles, Claude discovery shims, command guard, configuration and Golden Rules match the tarball.
- [ ] Record the host's discovered native profiles and effective tool inventory before starting each run.
- [ ] Keep transcripts and host events outside the package candidate. Evidence may live under ignored `.codex-temp/release-validation/` while local, but must be copied to a durable review location before release.

## Shared native contract

For every row:

- [ ] Begin the user request with literal `Orquesta light`, `Orquesta normal`, or `Orquesta full`. The installed skill must call the packaged `agentic-core start` seam; an observer may capture evidence but must not drive transitions.
- [ ] Capture every native Agent/subagent invocation with its runtime-selected profile, real native identifier, fresh `role.instanceId`, and prompt hash.
- [ ] Prove the native prompt bytes are exactly `JSON.stringify(brief)`, without prefix, suffix, fence or wrapper whitespace.
- [ ] Capture the authoritative native final-response field, the exact stdin/file bytes passed to `agentic-core submit-handoff`, and the returned transport receipt. All three SHA-256 values must match.
- [ ] Submit one invalid raw response unchanged and record the real `protocol_retry`; the retry must create a fresh same-role agent and must not consume retrabajo.
- [ ] Confirm briefs stay below 16 KiB, hand-offs below 32 KiB, source hashes remain valid, only one agent is active, and no role chooses its successor.
- [ ] Confirm the final working tree contains only the scenario's intended change and documentation decision; no run state, cache, snapshot, transaction backup or fixture artifact may leak into the product tree.

## Effective least privilege

Native evidence must distinguish host capability boundaries from brief-level responsibility. An obedient model or profile declaration alone is not enforcement evidence.

### Codex

- [ ] Bypass wrappers that change `CODEX_HOME`; record the direct executable, effective version, `config/read` layer origins and `permissionProfile/list` without recording secrets.
- [ ] Capture the runtime-selected custom profile and authoritative child events for every role.
- [ ] For `agentic-read`, begin from an effective read-only parent turn with `request_permissions` available. Grant only `.agentic-core/runs/<runId>/artifacts/` with turn scope when the exact quality command needs it.
- [ ] Prove the exact declared quality command succeeds after that grant and a real write outside the granted subtree fails with the effective policy. A parent `workspace-write` instruction or general escalation is not acceptable evidence.
- [ ] Record any host limitation if custom-agent TOML fields are merely descriptive in the effective client.

If the effective Codex client projects only bounded custom-agent overrides and does not apply `sandbox_mode`, `default_permissions`, or `[permissions.*]` from the agent TOML, the declaration is not enforcement. That native observation row remains blocked unless authoritative child events show the effective read-only policy, the exact quality command succeeds after a `request_permissions` grant limited only to the artifacts subtree with turn scope, and a real write outside that subtree fails.

### Claude Code

- [ ] Retain independent native preflights for `agentic-read`, `agentic-production`, `agentic-tests` and `agentic-docs`, including native IDs and exact prompts.
- [ ] For command-capable profiles, record the actual `node --version` Bash or PowerShell tool call and result. `agentic-docs` must expose neither Bash nor PowerShell.
- [ ] Prove the installed `PreToolUse` guard ran for `agentic-read`: allow `node --version`, allow only the exact active-brief quality command, and deny a different shell command.
- [ ] Hash `SubagentStop.last_assistant_message`, or an equally direct official final-response field. Do not extract `tool_use_result.content` or repair narrative-wrapped JSON.

The Claude guard is a command boundary for model-initiated tools, not adversarial process-level path confinement. Quality subprocesses are trusted packaged code and must keep temporary work below the run artifact directory. Production, tests and documentation scopes remain runtime contracts rather than host ACLs; evidence must not claim otherwise.

## Light scenario

Use a small executable change with independent acceptance criteria.

- [ ] Observe exactly Implementador → Tester, with fresh native IDs and no other role.
- [ ] Confirm the Implementador receives `agentic-tdd` when executable behavior changes and records red, green and refactor evidence.
- [ ] Confirm the Tester runs exactly `agentic-quality crap --run <runId> --output artifacts/crap.json`.
- [ ] Confirm the returned C.R.A.P. reference contains only `{path, sha256}`, the report hash matches, and its status is `approved` or `not_applicable`.
- [ ] Confirm no mutation command or mutation artifact is requested.
- [ ] Confirm the happy path terminates as `completed` and removes terminal run state.

## Normal scenario

Use a change that benefits from an explicit flat plan and requires the Documentador to make a fresh documentation decision.

- [ ] Observe exactly Planificador → Implementador → Verificador → Documentador.
- [ ] Confirm Planificador reads the original request and produces a criteria-traceable flat plan without weakening it.
- [ ] Confirm Verificador checks every plan criterion, tests, Golden Rules, structure and differential C.R.A.P.
- [ ] Confirm Verificador cannot modify production and may modify tests only when production is correct and evidence is missing; any invalidated checks must be repeated before completion.
- [ ] Confirm no mutation command or mutation artifact is requested.
- [ ] Confirm Documentador is a fresh agent even if it decides no documentation change is needed, and cannot open retrabajo or invalidate accepted production.
- [ ] Confirm the happy path terminates as `completed` and removes terminal run state.

## Full scenario

Use a change with a concrete exploration surface and at least one mutation target.

- [ ] Observe exactly Explorador → Planificador → Implementador → Refactor → Tester → Evaluador → Documentador.
- [ ] Confirm Explorador identifies only sector, symbols and direct dependencies without designing the HOW.
- [ ] Confirm Planificador reads the original request and converts the exploration into a criteria-traceable flat plan.
- [ ] Confirm Refactor keeps production read-only, checks structure and Golden Rules, and runs differential C.R.A.P. without Mutation Testing.
- [ ] Confirm Tester independently verifies criteria, tests and Golden Rules and never silently changes a contradictory test.
- [ ] Confirm Evaluador reads the original request, compares intention, plan, changes and current evidence, then runs `agentic-quality mutate --run <runId> --output artifacts/mutation.json`.
- [ ] Confirm mutation is differential, the report identity/freshness hashes match, and any equivalent has localized static proof. C.R.A.P. is repeated only if its prior report is stale.
- [ ] Confirm Documentador is a fresh, mandatory, non-blocking agent.
- [ ] Confirm the happy path terminates as `completed` and removes terminal run state.

## Result matrix

This is the final timeboxed record. All six rows were attempted and none was approved. Do not reinterpret partial progress as `PASS`.

| Host | Mode | Expected graph | Timeboxed observation | Result |
| --- | --- | --- | --- | --- |
| Codex | `light` | Implementador → Tester | Worked materially, but did not demonstrate effective permissions or exact prompt transport. | ATTEMPTED — NOT APPROVED |
| Codex | `normal` | Planificador → Implementador → Verificador → Documentador | Failed early before completing the graph. | ATTEMPTED — NOT APPROVED |
| Codex | `full` | Explorador → Planificador → Implementador → Refactor → Tester → Evaluador → Documentador | Failed early before completing the graph. | ATTEMPTED — NOT APPROVED |
| Claude Code | `light` | Implementador → Tester | Confirmed the retry correction through a fresh Implementador, but its invalid hand-off did not reach Tester. | ATTEMPTED — NOT APPROVED |
| Claude Code | `normal` | Planificador → Implementador → Verificador → Documentador | Failed early before completing the graph. | ATTEMPTED — NOT APPROVED |
| Claude Code | `full` | Explorador → Planificador → Implementador → Refactor → Tester → Evaluador → Documentador | Remained incomplete because of host limits. | ATTEMPTED — NOT APPROVED |

## Native observation boundary

- None of the six rows is `PASS`.
- Codex light does not prove effective permissions or exact prompts; Codex normal and full failed early.
- Claude light confirms the retry correction but not the full light graph; Claude normal failed early; Claude full is incomplete.
- These observations neither weaken nor overstate what was seen. They are not continued as part of #16.
