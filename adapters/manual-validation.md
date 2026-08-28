# Native host agent manual validation

The real-agent acceptance criterion remains incomplete until every Codex and Claude Code item below has recorded evidence. Automated invoker doubles do not satisfy this checklist.

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
- [ ] Record result and evidence location: `commit=___ version=___ session=___ evidence=___ result=___`.

## Claude Code session

- [ ] Start a new Claude Code session in the fixture project and explicitly invoke `orquestar`.
- [ ] Capture the native Agent invocation showing the runtime-selected custom subagent profile and a real agent identifier.
- [ ] Capture host evidence that the Agent prompt is exactly `JSON.stringify(brief)`, with no wrapper text or fence.
- [ ] Confirm only the final raw JSON object is submitted as the hand-off; record rejection evidence for a wrapped response if the host permits the check safely.
- [ ] Record result and evidence location: `commit=___ version=___ session=___ evidence=___ result=___`.

## Completion gate

- [ ] Codex evidence is complete and reviewable.
- [ ] Claude Code evidence is complete and reviewable.
- [ ] Only after both host checks pass, update the issue criterion for real agent creation; do not infer completion from automated tests.
