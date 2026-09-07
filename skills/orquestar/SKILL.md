---
name: orquestar
description: Coordina semánticamente solicitudes que comienzan con Orquesta, /orquestar o $orquestar.
---

# Orquestar

1. Activa esta skill únicamente si la solicitud comienza con `Orquesta`, `/orquestar` o `$orquestar`. Sin modo explícito usa `normal`; sin activador, ejecuta directamente.
2. Define objetivo, criterios de aceptación, modo y alcance en prosa breve. Lee y aplica las Golden Rules del proyecto antes de actuar. Las restricciones de roles son instrucciones semánticas, no aislamiento técnico demostrado.
3. Mantén como máximo un agente activo. El coordinador no cuenta como rol base y no implementa producción. Cada instancia recibe un perfil estable y el contexto pertinente en prosa:
   - **Propósito:** qué resultado debe producir.
   - **Responsabilidades:** qué decisiones y acciones le corresponden.
   - **Alcance:** rutas, cambios y límites autorizados.
   - **Entradas:** objetivo, aceptación, decisiones condicionantes, evidencia vigente y defectos agrupados cuando existan.
   - **Criterios de devolución:** resultado, bloqueantes, evidencia y referencias en una entrega breve.
   - **Golden Rules:** la política canónica que debe aplicar.
   - **Contexto pertinente:** solo la información necesaria para esa instancia.
4. Después de fijar el alcance y antes de modificar producción o tests, ejecuta una sola vez `node .agentic-core/runtime-launcher.mjs agentic-quality prepare --task <id> --mode <modo> --objective <referencia> [--repair-test <ruta>]`. Conserva el mismo `task`, modo, objetivo y baseline durante las correcciones; `--repair-test` solo se declara cuando ese permiso forma parte del alcance.
5. Aplica el modo elegido:
   - `light`: ejecuta exactamente dos roles base en este orden: Implementador → Tester. El Implementador usa `agentic-production` y aplica TDD cuando corresponda; el Tester usa `agentic-tests`, ejecuta o solicita la ejecución determinista de tests, DRY y C.R.A.P., interpreta candidatos DRY y exige el recibo vigente de `agentic-quality verify`. El Mutation Testing es `not_applicable`.
   - `normal`: plan breve del coordinador; Planificador independiente solo si existe una decisión HOW material; Implementador con `agentic-production`; Verificador independiente con `agentic-tests`; hasta dos ciclos de corrección; Documentador solo si la documentación debe cambiar; `verify` obligatorio.
   - `full`: Planificador con `agentic-read`; Implementador con `agentic-production`; Evaluador independiente con `agentic-read`; hasta dos ciclos de corrección; Documentador solo si corresponde; `verify` obligatorio, incluyendo C.R.A.P. y Mutation Testing.
6. Selecciona explícitamente el perfil instalado correspondiente: Planificador → `agentic-read`, Evaluador → `agentic-read`, Implementador → `agentic-production`, Tester → `agentic-tests`, Verificador → `agentic-tests`, Documentador → `agentic-docs`. Implementador modifica únicamente producción y tests dentro del alcance. Tester solo lee producción; puede corregir únicamente tests dentro del alcance y nunca producción. Verificador solo lee producción y no modifica tests. Documentador modifica únicamente documentación.
7. En Light, entrega el resultado del Implementador al Tester como prosa breve con objetivo, alcance, aceptación, decisiones condicionantes, resultado, defectos y referencias. El Tester devuelve la misma forma resumida. La entrega nunca incluye toda la conversación, reportes completos ni un objeto JSON; la interpretación del agente no reemplaza la evidencia del recibo vigente.
8. Si el Tester rechaza el resultado, agrupa los defectos y abre una nueva ronda: crea una nueva instancia de Implementador con esos problemas y, después de su entrega, una nueva instancia de Tester. El contador compartido aumenta una vez por rechazo al abrir la ronda y permite como máximo dos rondas adicionales por tarea; cambiar de rol no lo reinicia y nunca hay dos agentes activos. Al agotarlo, quedan causas pendientes sin aprobación ni cambio de modo. La documentación no se agrega sin petición expresa; al cerrar se puede recomendar un Documentador para decisión del usuario.
9. Atiende resultados, intervenciones del usuario y vencimientos con esperas por eventos disponibles en Codex, renovables por hasta 60 segundos. Si pasan 5 minutos sin novedades, comprueba activamente el estado. La lentitud o silencio por sí solos no reinician trabajo: la recuperación exige un fallo o límite aplicable; sin daemon, hooks nuevos ni promesas después de terminar la sesión. El presupuesto acumulado corresponde a comprobaciones, no al tiempo de los agentes.
10. Ejecuta `node .agentic-core/runtime-launcher.mjs agentic-quality verify` sobre el worktree final, después de la última corrección de tests del Tester. Nunca declares completado un cambio ejecutable orquestado sin un recibo `QUALITY_OK` vigente posterior al último cambio. Operaciones destructivas, commit, push, publicación y cambios remotos requieren autorización explícita del usuario.
