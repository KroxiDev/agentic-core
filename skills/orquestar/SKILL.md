---
name: orquestar
description: Coordina semánticamente solo solicitudes que comienzan con Orquesta, /orquestar o $orquestar.
---

# Orquestar

1. Activa esta skill únicamente si la solicitud comienza con `Orquesta`, `/orquestar` o `$orquestar`. Sin modo explícito usa `normal`; sin activador, ejecuta directamente.
2. Define objetivo, criterios, modo y alcance en prosa breve. Las restricciones de roles son instrucciones semánticas, no aislamiento técnico demostrado.
3. Mantén como máximo un agente activo. Cada agente devuelve prosa breve con resultado, bloqueantes y evidencia; nunca briefs, handoffs ni protocolo JSON. Si una respuesta es ambigua, aclárala semánticamente.
4. Antes de modificar producción o tests en un cambio ejecutable, ejecuta una sola vez `node .agentic-core/runtime-launcher.mjs agentic-quality prepare --mode <modo> --scope <ruta> [--scope <ruta>...]` después de fijar el alcance. Conserva el ID devuelto.
5. Aplica el modo:
   - `light`: Implementador; TDD cuando corresponda; `verify` obligatorio.
   - `normal`: plan breve del coordinador; Planificador independiente solo si existe una decisión HOW material; Implementador con `agentic-tdd` cuando cambia comportamiento; Verificador independiente; hasta dos ciclos de corrección; Documentador solo si la documentación debe cambiar; `verify` obligatorio.
   - `full`: Planificador con la exploración necesaria; Implementador con TDD cuando corresponda; Evaluador independiente; hasta dos ciclos de corrección; Documentador solo si corresponde; `verify` obligatorio, incluyendo C.R.A.P. y Mutation Testing.
6. Al delegar, selecciona explícitamente el perfil instalado correspondiente:
   - Planificador → `agentic-read`.
   - Evaluador → `agentic-read`.
   - Implementador → `agentic-production`.
   - Verificador → `agentic-tests`.
   - Documentador → `agentic-docs`.
   Conserva las restricciones semánticas: Planificador, Evaluador y Verificador, “solo lee producción; no la modifiques”; Implementador, “modifica únicamente producción y tests dentro del alcance”; Documentador, “solo documentación”.
7. Ejecuta `node .agentic-core/runtime-launcher.mjs agentic-quality verify --session <id>` sobre el worktree final. Nunca declares completado un cambio ejecutable orquestado sin un recibo `QUALITY_OK` vigente.
8. Operaciones destructivas, commit, push, publicación y cambios remotos requieren autorización explícita del usuario.
