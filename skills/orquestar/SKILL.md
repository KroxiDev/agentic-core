---
name: orquestar
description: Run agentic-core only for requests explicitly beginning with Orquesta, /orquestar, or $orquestar; never activate for ordinary requests.
---

# Orquestar

1. Accept only the grammar `^(Orquesta|\/orquestar|\$orquestar)(?:\s+|$)`. Requests outside it remain direct and create no coordinator or agent.
2. Ask for missing goal, reason, or acceptance criteria before starting the runtime. Load `agentic-grilling` only for that clarification, or when a Planificador brief explicitly lists it for a real HOW decision.
3. Start or resume the agentic-core runtime and use the role supplied by the runtime. Never choose, reorder, or reuse a role yourself.
4. Map that role to the installed `agentic-read`, `agentic-production`, `agentic-tests`, or `agentic-docs` native profile and create a real host subagent with the native Agent/subagent tool.
5. Send the complete brief JSON as the subagent prompt without any prefix, suffix, summary, or surrounding fence.
6. Load only the skills listed by the brief. `agentic-tdd` is valid only for an Implementador changing executable behavior; `agentic-grilling` is valid only for clarification or a Planificador facing a real HOW decision.
7. Treat only the agent's final response as the hand-off JSON. Reject prose, fences, intermediate messages, and multiple JSON values, then submit the raw object to the runtime.
8. Read Golden Rules only from `.agentic-core/golden-rules.md`; do not reproduce them in this skill, profiles, briefs, or adapters.
