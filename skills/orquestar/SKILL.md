---
name: orquestar
description: Run agentic-core only for requests explicitly beginning with Orquesta, /orquestar, or $orquestar; never activate for ordinary requests.
---

# Orquestar

1. Accept only the grammar `^(Orquesta|\/orquestar|\$orquestar)(?:\s+|$)`. Requests outside it remain direct and create no coordinator or agent.
2. Ask before starting only when the objective is missing or there are no verifiable acceptance criteria. If reason is absent, preserve the runtime value `not_specified` and do not ask for one.
3. Invoke `agentic-core start` through the installed public seam exactly once, passing a JSON object with the literal activated `request`, the `intention`, `changesExecutableBehavior`, and `planningNeedsHowDecision` through stdin or an exact `--input` file. Never import or call `startOrchestration`; only the public seam may start the runtime.
4. Use the role supplied by the runtime result together with its brief. Never choose, reorder, construct, or reuse a role or brief yourself.
5. Map that role to the installed `agentic-read`, `agentic-production`, `agentic-tests`, or `agentic-docs` native profile and invoke it directly with the host's native Agent/subagent tool. Never use a simulated or fallback product path. Before invoking `agentic-read`, require the host's actual read restriction plus its narrowly reviewed exact `quality_artifacts` exception; stop as blocked if the host exposes only instruction-level restraint.
6. Pass `JSON.stringify(brief)` exactly as the native agent prompt, without any prefix, suffix, summary, whitespace wrapper, or surrounding fence.
7. Load only the skills listed by the brief. `agentic-tdd` is valid only for an Implementador changing executable behavior, but its absence never removes test permissions granted by the brief. Use `agentic-grilling` only for a material ambiguity in the intention or when a Planificador faces a real HOW decision, not because reason is missing or `not_specified`.
8. After native invocation completes, forward the exact complete final response without inspecting or changing it through the installed public seam: `agentic-core submit-handoff --run <runId>` with the response bytes on stdin, or `--input <path>` when the host provides an exact response file. Never parse, locate `{`, extract a substring, trim, remove a prefix, reconstruct, repair, or submit an object yourself. The seam alone validates the raw response and routes invalid responses through the runtime's single `protocol_retry` budget.
9. Treat the result returned by `submit-handoff` as the only next runtime decision. Continue only with its returned role and brief after `continued` or `protocol_retry`; stop on terminal status or request the missing input when instructed. An observing harness must never run this loop.
10. Read Golden Rules only from `.agentic-core/golden-rules.md`; do not reproduce them in this skill, profiles, briefs, or adapters.
