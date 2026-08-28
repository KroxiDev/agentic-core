# Native host agent manual validation

The real-agent acceptance criterion remains incomplete until every Codex and Claude Code item below has recorded evidence. Automated invoker doubles do not satisfy this checklist.

## Historical Claude result before the raw-response seam

The Claude Code validation of commit `be95c76233eb43095d9bdfbcb23103e602ab7977` proved real native Agent creation, native profiles and IDs, exact `JSON.stringify(brief)` prompts, successful implementation, and two passing Node tests. Its light run nevertheless ended as `failed`: the coordinator extracted JSON from a narrative-wrapped final response, and the Tester never returned the required persisted C.R.A.P. reference with plain-string Golden Rules evidence before exhausting the single protocol retry. This is retained only as historical failure evidence; it is not a PASS for the corrected contract.

Use a newly initialized fixture for every validation after the correction. Do not reuse the historical run, its state, transcripts, session identifiers, or artifacts.

## Shared preconditions

- [ ] Install the package from the commit under validation in a clean fixture project.
- [ ] Record the package commit, host version, date, and session identifier.
- [ ] Confirm the installed profile, canonical skill, Claude discovery shim, and ownership-manifest hashes match the package.
- [ ] Use a brief whose permissions and skills exercise the selected role without changing unrelated files.

## Codex session

- [ ] Start a new Codex session in the fixture project and explicitly invoke `orquestar`.
- [ ] Capture the native subagent thread showing the runtime-selected custom profile and a real subagent identifier.
- [ ] Capture host evidence that the subagent prompt is exactly `JSON.stringify(brief)`, with no wrapper text or fence.
- [ ] Confirm only the final raw JSON object is submitted as the hand-off; record rejection evidence for a wrapped response if the host permits the check safely.
- [ ] Confirm `agentic-core submit-handoff --run <runId>` receives the complete final response unchanged and a wrapped response produces `protocol_retry` without internal JSON extraction.
- [ ] Confirm the Tester runs the exact `agentic-quality crap --run <runId> --output artifacts/crap.json` command from its brief and returns only `{path, sha256}`.
- [ ] Confirm the referenced report exists, its SHA-256 matches, its tool is `crap`, its status is `approved` or `not_applicable`, and the light run terminates as `completed`.
- [ ] Record result and evidence location: `commit=___ version=___ session=___ evidence=___ result=___`.

## Claude Code session

- [ ] Start a new Claude Code session in the fixture project and explicitly invoke `orquestar`.
- [ ] Capture the native Agent invocation showing the runtime-selected custom subagent profile and a real agent identifier.
- [ ] Capture host evidence that the Agent prompt is exactly `JSON.stringify(brief)`, with no wrapper text or fence.
- [ ] Confirm only the final raw JSON object is submitted as the hand-off; record rejection evidence for a wrapped response if the host permits the check safely.
- [ ] Confirm `agentic-core submit-handoff --run <runId>` receives the complete final response unchanged and a wrapped response produces `protocol_retry` without internal JSON extraction.
- [ ] Confirm the Tester runs the exact `agentic-quality crap --run <runId> --output artifacts/crap.json` command from its brief and returns only `{path, sha256}`.
- [ ] Confirm the referenced report exists, its SHA-256 matches, its tool is `crap`, its status is `approved` or `not_applicable`, and the light run terminates as `completed`.
- [ ] Record result and evidence location: `commit=___ version=___ session=___ evidence=___ result=___`.

## Completion gate

- [ ] Codex evidence is complete and reviewable.
- [ ] Claude Code evidence is complete and reviewable.
- [ ] Only after both host checks pass, update the issue criterion for real agent creation; do not infer completion from automated tests.
