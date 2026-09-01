# GitHub del repositorio

- La cuenta GitHub exclusiva de este repositorio es `KroxiDev`.
- El repositorio remoto canónico es `KroxiDev/agentic-core`.
- Para operaciones de GitHub que excedan Git local, usa primero el MCP `github_personal`.
- Antes de cualquier escritura remota, verifica que la identidad autenticada sea `KroxiDev` y que el destino pertenezca a `KroxiDev/agentic-core`.
- Si el MCP no está disponible y necesitas usar GitHub CLI, verifica primero que `KroxiDev` sea la cuenta activa. No cambies la cuenta global sin autorización del usuario.

<!-- AGENTIC_CORE_START -->
## agentic-core

Follow the canonical policy in `.agentic-core/golden-rules.md`.

If a request begins with `Orquesta`, `/orquestar`, or `$orquestar`, load and follow `.agents/skills/orquestar/SKILL.md`. `Orquesta` without a mode means `normal`.

Never declare an orchestrated executable change complete without a current `QUALITY_OK` receipt from `agentic-quality verify`.

Requests without one of those activators run directly.
<!-- AGENTIC_CORE_END -->
