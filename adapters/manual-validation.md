# Validación manual de coordinación semántica y QualitySession

Esta lista complementa las suites automatizadas. No convierte instrucciones de agentes en enforcement de seguridad ni exige demostrar un sandbox del host.

## Límites de evidencia

| Área | Contrato |
| --- | --- |
| `coordination` | `semantic-policy` |
| `host-security` | `not-verified` |
| `model-input` | `program-generated-json-only` |
| `legacy-runs` | `preserve` |

## Preparación común

1. Construir el runtime final con `npm.cmd run build:runtime` y comprobar `runtime-manifest.json`, hashes por archivo y `treeSha256` antes de instalarlo en fixtures limpias.
2. Instalar los mismos bytes en una fixture Codex y otra Claude Code, al menos una con espacios en la ruta.
3. Confirmar que `AGENTS.md` y `CLAUDE.md` contienen routing positivo para `Orquesta`, `/orquestar` y `$orquestar`, que `Orquesta` sin modo usa `normal` y que una solicitud sin activador continúa directa.
4. Confirmar que los adapters conservan los nombres `agentic-read`, `agentic-production`, `agentic-tests` y `agentic-docs`, expresan las mismas responsabilidades semánticas en ambos hosts y dan a Tester capacidad de corregir tests dentro del alcance, nunca producción.
5. No registrar secretos, `.env`, datos personales ni contenido irrelevante en la evidencia.

## Routing visible

En cada host:

1. Iniciar una solicitud con `Orquesta normal` y observar que se carga explícitamente `.agents/skills/orquestar/SKILL.md` antes de elegir roles.
2. Repetir con `/orquestar light` y `$orquestar full`.
3. Iniciar una solicitud sin activador y confirmar que se ejecuta directamente, sin cargar `orquestar`.
4. Confirmar que cada instancia recibe propósito, responsabilidades, alcance, entradas, criterios de devolución, Golden Rules y contexto pertinente, y que las entregas son prosa breve con objetivo, alcance, aceptación, decisiones condicionantes, resultado, defectos y referencias.
5. Confirmar que nunca hay más de un agente activo y que las entregas no contienen la conversación completa, reportes completos ni JSON.

## Matriz semántica

| Host | Modo | Roles esperados | Gate esperado |
| --- | --- | --- | --- |
| Codex | `light` | Implementador → Tester; dos roles base y hasta dos rondas adicionales compartidas | `prepare` + tests/DRY/C.R.A.P. en `verify`; Mutation `not_applicable`. |
| Codex | `normal` | Planificador solo con HOW material → Implementador → Verificador; Documentador solo si corresponde | `prepare` + tests/C.R.A.P. en `verify`; Mutation `not_applicable`. |
| Codex | `full` | Planificador → Implementador → Evaluador; Documentador solo si corresponde | `prepare` + tests/C.R.A.P./Mutation en `verify`. |
| Claude Code | `light` | Implementador → Tester; dos roles base y hasta dos rondas adicionales compartidas | `prepare` + tests/DRY/C.R.A.P. en `verify`; Mutation `not_applicable`. |
| Claude Code | `normal` | Planificador solo con HOW material → Implementador → Verificador; Documentador solo si corresponde | `prepare` + tests/C.R.A.P. en `verify`; Mutation `not_applicable`. |
| Claude Code | `full` | Planificador → Implementador → Evaluador; Documentador solo si corresponde | `prepare` + tests/C.R.A.P./Mutation en `verify`. |

Las frases de permisos son contratos semánticos:

- Planificador y Evaluador: “solo lee producción; no la modifiques”.
- Implementador: “modifica únicamente producción y tests dentro del alcance”.
- Tester: “solo lee producción; puede corregir únicamente tests dentro del alcance; nunca modifica producción”.
- Verificador: “solo lee producción; no modifica tests ni documentación”.
- Documentador: “solo documentación”.

No atribuir a estas frases aislamiento técnico, permisos efectivos ni resistencia frente a un proceso adversarial.

## Light real en Codex

La evidencia nativa debe demostrar el comportamiento del host, no solo la presencia de archivos. En una fixture descartable:

1. Construir e instalar los mismos bytes del runtime y comprobar que Codex carga `.agents/skills/orquestar/SKILL.md`, `agentic-production` y `agentic-tests`.
2. Registrar versión de Codex, modelo efectivo, capacidades efectivas de cada perfil y el alcance entregado a cada instancia; no registrar secretos ni contexto personal.
3. Ejecutar una solicitud `Orquesta Light` o `/orquestar light` que cambie producción y tests. Confirmar el orden Implementador → Tester, un solo agente activo, `prepare` antes de editar, tests/DRY/C.R.A.P. deterministas y `QUALITY_OK` vigente con Mutation `not_applicable`.
4. Ejecutar una segunda fixture donde Tester rechace por un defecto reproducible. Confirmar que el coordinador agrupa las causas, crea una nueva instancia de Implementador y después un nuevo Tester, comparte el contador y conserva las causas pendientes al agotarlo.
5. Observar una espera por resultado, intervención o vencimiento. Renovar como máximo 60 segundos por espera, comprobar activamente tras 5 minutos sin novedades y confirmar que la lentitud o el silencio no reinician trabajo.
6. Etiquetar cada artefacto como evidencia nativa, simulación controlada o restricción semántica no demostrada técnicamente. La interpretación del agente no reemplaza el recibo de calidad.

## QualitySession

Usar un proyecto de prueba con código, tests, configuración del runner, manifest, lockfile, un archivo relevante no trackeado, `.env`, un cache y un archivo fuera del scope.

1. Ejecutar antes de editar:

   ```powershell
   node .agentic-core/runtime-launcher.mjs agentic-quality prepare --mode normal --scope src --scope test
   ```

2. Confirmar el recibo `QUALITY_SESSION`, la captura de cambios preexistentes y del archivo relevante no trackeado, y la ausencia de `.env`, caches, binarios y archivos irrelevantes en el checkpoint.
3. Repetir el mismo comando sin cambiar entradas y confirmar que reutiliza el mismo ID.
4. Cambiar producción y tests dentro del scope y ejecutar:

   ```powershell
   node .agentic-core/runtime-launcher.mjs agentic-quality verify --session q_<id>
   ```

5. Confirmar tests reales, C.R.A.P. diferencial, reporte hasheado y `QUALITY_OK` solo cuando todos los gates estén aprobados.
6. Modificar luego código, tests, configuración, manifest, lockfile o comando del runner y confirmar que el recibo anterior ya no es vigente.
7. En `light` y `normal`, confirmar `mutation=not_applicable` sin ejecución. En `full`, confirmar que Mutation Testing se ejecuta, restaura snapshots y no cambia el worktree relevante.
8. Corromper una copia de una sesión y confirmar que `verify` devuelve código 4 y `doctor` preserva y reporta la evidencia sin repararla.

## Interfaces públicas

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality scan --target src
node .agentic-core/runtime-launcher.mjs agentic-quality crap --target src
node .agentic-core/runtime-launcher.mjs agentic-quality mutate --target src
node .agentic-core/runtime-launcher.mjs agentic-quality mutation --target src
node .agentic-core/runtime-launcher.mjs agentic-quality prepare --mode light --scope src
node .agentic-core/runtime-launcher.mjs agentic-quality verify --session q_<id>
```

Confirmar que no se acepta input JSON redactado por el modelo y que los comandos de mantenimiento disponibles son únicamente `init`, `update`, `doctor`, `uninstall`, ayuda y versión.

## Migración y mantenimiento

1. Actualizar una fixture legacy con `.agentic-core/runs` y confirmar que el directorio se preserva sin ser interpretado ni incluido en ownership nuevo.
2. Confirmar que una instalación nueva no crea `runs`, registra `.agentic-core/quality` como directorio propio y lo excluye mediante `.agentic-core/.gitignore` sin ocultar los demás recursos gestionados.
3. Confirmar que `doctor` valida sesiones y recibos de calidad, e informa estado legacy sin borrarlo.
4. Confirmar que `uninstall --dry-run` anuncia la eliminación de `quality` y la preservación de `runs`; la ejecución debe respetar esa decisión.
5. Comprobar rollback inyectando un fallo transaccional en una fixture descartable.

## Gate final

1. `npm.cmd test`
2. `npm.cmd run test:python`
3. `npm.cmd run check`
4. `npm.cmd run build:runtime`
5. `npm.cmd pack --dry-run --json` con cache temporal local si el global falla.
6. `git diff --check`
7. Verificar que el tarball y el runtime contienen únicamente el conjunto canónico y que no quedaron caches, transport files ni artefactos de prueba.
