# Native host agent manual validation

The real-agent acceptance criterion remains incomplete until every Codex and Claude Code item below has recorded evidence. Automated invoker doubles do not satisfy this checklist.

## Historical Claude result before the raw-response seam

The Claude Code validation of commit `be95c76233eb43095d9bdfbcb23103e602ab7977` proved real native Agent creation, native profiles and IDs, exact `JSON.stringify(brief)` prompts, successful implementation, and two passing Node tests. Its light run nevertheless ended as `failed`: the coordinator extracted JSON from a narrative-wrapped final response, and the Tester never returned the required persisted C.R.A.P. reference with plain-string Golden Rules evidence before exhausting the single protocol retry. This is retained only as historical failure evidence; it is not a PASS for the corrected contract.

Use a newly initialized fixture for every validation after the correction. Do not reuse the historical run, its state, transcripts, session identifiers, or artifacts.

## Shared preconditions

- [ ] Create one candidate commit, pack it once, record the tarball SHA-256, and install those same bytes in both clean fixtures.
- [ ] Begin each acceptance run with a literal `Orquesta`, `/orquestar`, or `$orquestar` request so the installed skill calls `agentic-core start`; an external runner may observe but must not run the orchestration loop.
- [ ] Record the package commit, host version, Node version, date, and session identifier.
- [ ] Confirm the installed profile, canonical skill, Claude discovery shim, and ownership-manifest hashes match the package.
- [ ] Record the fixture working directory, discovered native profiles, and the host's effective tool inventory before orchestration.
- [ ] For Claude Code, retain independent native preflights for `agentic-read`, `agentic-production`, and `agentic-tests`; each must record the native ID, exact prompt, actual `node --version` shell tool and result, while `agentic-docs` must expose neither `Bash` nor `PowerShell`.
- [ ] Use a brief whose permissions and skills exercise the selected role without changing unrelated files.

## Effective least-privilege gate

The Claude project agent combines a `Read/Grep/Glob` tool allowlist, `dontAsk`, and an installed `PreToolUse` guard. The guard permits only `node --version` or the exact quality command declared by an active read brief, and fails closed for every other `Bash` or `PowerShell` command. Native evidence must show that the hook actually ran; frontmatter alone is insufficient.

This guard is a command boundary for model-initiated tools, not an adversarial filesystem sandbox for descendants of an allowed process. The quality exception therefore trusts the packaged `agentic-quality` CLI and its own output-path validation. When `--output artifacts/<file>.json` is present, coverage workspaces, mutation snapshots, and transaction backups stay below the same run artifact directory and are removed after success. Record the residual Windows-native limitation; do not describe it as process-level path confinement.

The remaining native profiles use the smallest capability classes exposed by both hosts: production and tests need mutation plus shell execution, while documentation has mutation without shell. Their finer production/test/documentation scopes are brief contracts validated by agentic-core, not host-enforced per-path ACLs. Native evidence must distinguish these capability boundaries from adversarial path confinement and must not claim the latter.

If the effective Codex client projects only bounded custom-agent overrides and does not apply `sandbox_mode`, `default_permissions`, or `[permissions.*]` from the agent TOML, the declaration is not enforcement. Detect that behavior from authoritative child events rather than a version string. Start the relevant parent turn explicitly read-only with `request_permissions` exposed; require the child to request only `.agentic-core/runs/<runId>/artifacts/`, grant only that filesystem entry with turn scope, and retain the App Server request and response. Acceptance remains blocked unless authoritative child events show the effective read-only policy, the exact quality command succeeds after that grant, and a real write outside the granted subtree fails. A parent `workspace-write` instruction, a general escalation, or an obedient model is not evidence.

## Codex session

- [ ] Start a new Codex session in the fixture project and explicitly invoke `orquestar`.
- [ ] Bypass any wrapper that changes `CODEX_HOME`; record `config/read` layer origins, `permissionProfile/list`, the direct executable, and the effective version without recording secrets.
- [ ] Capture the native subagent thread showing the runtime-selected custom profile and a real subagent identifier.
- [ ] For `agentic-read`, capture the effective read-only permission instructions, the exact turn-scoped `request_permissions` grant, a successful artifact write, and an `EPERM` write outside that subtree.
- [ ] Capture host evidence that the subagent prompt is exactly `JSON.stringify(brief)`, with no wrapper text or fence.
- [ ] Hash the native final response, the exact stdin/file bytes and the public seam's transport receipt; require all three SHA-256 values to match.
- [ ] Confirm only the final raw JSON object is submitted as the hand-off; submit one invalid raw response unchanged and record the real `protocol_retry` transition.
- [ ] Confirm the Tester runs the exact `agentic-quality crap --run <runId> --output artifacts/crap.json` command from its brief and returns only `{path, sha256}`.
- [ ] Confirm the referenced report exists, its SHA-256 matches, its tool is `crap`, its status is `approved` or `not_applicable`, and the light run terminates as `completed`.
- [ ] Record result and evidence location: `commit=___ version=___ session=___ evidence=___ result=___`.

## Claude Code session

- [ ] Start a new Claude Code session in the fixture project and explicitly invoke `orquestar`.
- [ ] Capture the native Agent invocation showing the runtime-selected custom subagent profile and a real agent identifier.
- [ ] Capture host evidence that the Agent prompt is exactly `JSON.stringify(brief)`, with no wrapper text or fence.
- [ ] Hash `SubagentStop.last_assistant_message` (or an equally direct official final-response field), the exact stdin/file bytes and the public seam's transport receipt; require all three SHA-256 values to match without extracting `tool_use_result.content`.
- [ ] Confirm only the final raw JSON object is submitted as the hand-off; submit one invalid raw response unchanged and record the real `protocol_retry` transition.
- [ ] Confirm the Tester runs the exact `agentic-quality crap --run <runId> --output artifacts/crap.json` command from its brief and returns only `{path, sha256}`.
- [ ] Confirm the referenced report exists, its SHA-256 matches, its tool is `crap`, its status is `approved` or `not_applicable`, and the light run terminates as `completed`.
- [ ] Record result and evidence location: `commit=___ version=___ session=___ evidence=___ result=___`.

## Completion gate

- [ ] Codex evidence is complete and reviewable.
- [ ] Claude Code evidence is complete and reviewable.
- [ ] Only after both host checks pass, update the issue criterion for real agent creation; do not infer completion from automated tests.
