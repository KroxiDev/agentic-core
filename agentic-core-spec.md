# Especificación arquitectónica de agentic-core 0.2.0

Documento histórico de la arquitectura del esquema 2. Para los modos activos,
los controles a pedido y las tareas Python del esquema 3 prevalecen la
[referencia vigente](docs/technical-reference.md) y la [especificación #83](https://github.com/KroxiDev/agentic-core/issues/83).
Full está deprecado y se conserva en [archive/full](docs/full-archive.md).

## Problema

La coordinación anterior mezclaba decisiones semánticas de agentes con un reducer determinista, estado de runs, briefs y handoffs JSON, validación de protocolo y afirmaciones de permisos efectivos que los hosts no siempre podían demostrar. A la vez, tests, cobertura, C.R.A.P. y Mutation Testing sí necesitan ejecución, persistencia e integridad deterministas.

## Decisión

Separar dos responsabilidades:

1. Coordinación semántica: activación, roles, alcance, permisos, retrabajo y documentación mediante instrucciones breves para agentes cooperativos.
2. `QualitySession`: baseline previo, tests reales, C.R.A.P. diferencial, Mutation Testing en `full`, inventarios, snapshots, hashes, restauración, vigencia y recibos verificables.

Esta entrega instala y valida únicamente la superficie nativa de Codex. La integración y validación de Claude quedan fuera del alcance de Light y se difieren para una entrega posterior.

## Superficie pública

`agentic-core` expone únicamente:

- `init`
- `update`
- `doctor`
- `uninstall`
- ayuda y versión

`agentic-quality` expone:

- `scan --target <ruta>`
- `crap --target <ruta>`
- `mutate --target <ruta>`
- `mutation --target <ruta>` como alias
- `prepare --task <id> --mode <light|normal|full> --objective <referencia> [--repair-test <ruta>]`
- `verify` sin argumentos sobre la tarea activa

No existe entrada JSON de coordinación o calidad redactada por el modelo.

## Coordinación semántica

### Activación

Los activadores admitidos al comienzo de la solicitud son `Orquesta`, `/orquestar` y `$orquestar`. Sin modo explícito se usa `normal`. Sin activador, la solicitud se ejecuta directamente.

El bloque gestionado de `AGENTS.md` ordena positivamente cargar `.agents/skills/orquestar/SKILL.md` para los tres activadores y prohíbe completar un cambio ejecutable orquestado sin un `QUALITY_OK` vigente.

### Modos

- `light`: `prepare` antes de editar; Implementador → Tester con los perfiles `agentic-production` y `agentic-tests`; TDD cuando corresponde; hasta dos rondas adicionales compartidas; `verify` obligatorio.
- `normal`: plan breve del coordinador; Planificador solo ante una decisión HOW material; `prepare`; Implementador con TDD si cambia comportamiento; Verificador independiente; máximo dos ciclos de corrección; `verify`; Documentador solo si corresponde.
- `full`: Planificador con la exploración necesaria; `prepare`; Implementador con TDD cuando corresponde; Evaluador independiente; máximo dos ciclos de corrección; `verify` con C.R.A.P. y Mutation Testing; Documentador solo si corresponde.

Solo puede haber un agente activo. El coordinador no cuenta como rol base ni implementa producción. Cada instancia recibe propósito, responsabilidades, alcance, entradas, criterios de devolución, Golden Rules y contexto pertinente. Las entregas contienen objetivo, alcance, aceptación, decisiones condicionantes, resultado, defectos y referencias en prosa breve; no contienen la conversación completa, reportes completos ni JSON. La ambigüedad se aclara semánticamente y no crea un retry de protocolo.

En Light, un rechazo del Tester agrupa los defectos y crea una nueva instancia de Implementador seguida de un nuevo Tester. El contador se comparte entre roles y permite como máximo dos rondas adicionales; agotarlo deja causas pendientes sin aprobación ni cambio de modo. El Tester puede corregir tests dentro del alcance, pero no producción, y la interpretación del agente no reemplaza el recibo vigente de calidad.

La espera atiende resultados, intervenciones del usuario y vencimientos con eventos disponibles en Codex, renovables hasta 60 segundos. Tras 5 minutos sin novedades se comprueba activamente el estado; la lentitud o el silencio por sí solos no reinician trabajo. No hay daemon, hooks nuevos ni promesas después de terminar la sesión; el presupuesto acumulado corresponde a comprobaciones, no al tiempo de los agentes.

### Permisos

- Planificador y Evaluador: solo leen producción y no la modifican.
- Implementador: modifica únicamente producción y tests dentro del alcance.
- Tester: solo lee producción; puede corregir únicamente tests dentro del alcance y nunca producción.
- Verificador: solo lee producción y no modifica tests.
- Documentador: solo documentación.
- Operaciones destructivas, commit, push, publicación y cambios remotos requieren autorización explícita.

Son restricciones semánticas, no enforcement de filesystem ni prueba de aislamiento del host.

## QualitySession

### `prepare` de tarea Python

1. Valida `task`, modo, objetivo y el alcance de la unidad Python configurada.
2. Conserva el mismo `task`, modo y objetivo en las continuaciones; `--repair-test` solo amplía permisos declarados.
3. Descubre el runner y su evidencia relevante.
4. Captura el worktree actual como checkpoint, incluidos cambios preexistentes y archivos relevantes no trackeados.
5. Excluye secretos, `.env`, datos personales, caches, binarios y datos operativos.
6. Ejecuta los tests y obtiene DRY y C.R.A.P. atribuibles cuando el entorno lo soporta.
7. Publica transaccionalmente la tarea activa en `.agentic-core/quality/active-task.json`.

Un fallo de argumentos, entorno, baseline o persistencia no publica estado parcial ni modifica producción, tests o documentación.

### `verify` de tarea Python

1. Carga y valida hashes de la tarea activa creada por `prepare`, sin aceptar argumentos.
2. Detecta cambios de código, tests, runner, configuración, manifests y lockfiles respecto del checkpoint, incluso evidencia relevante fuera del scope.
3. Ejecuta los tests actuales.
4. Calcula C.R.A.P. diferencial sin inventar cobertura atribuible.
5. Ejecuta Mutation Testing solo en `full`; en `light` y `normal` registra `not_applicable`.
6. Compara el checkpoint antes y después de tests y mutación y verifica restauración de snapshots.
7. Publica transaccionalmente un reporte completo y su puntero `latest.json`.
8. Emite `QUALITY_OK` solo si entorno, baseline, tests, C.R.A.P., Mutation y restauración están aprobados.

Reglas C.R.A.P.:

- símbolo nuevo `<= 7`;
- símbolo existente con baseline `<= 7` permanece `<= 7`;
- deuda heredada `> 7` no empeora;
- baseline no atribuible nunca equivale a cero.

Un recibo identifica sesión, tests, máximo C.R.A.P., estado de mutación, ruta del reporte y SHA-256. El puntero a la verificación actual invalida recibos anteriores cuando cambia cualquier input o comando relevante.

### Códigos de salida

- `0`: aprobado o no aplicable;
- `1`: gate fallido;
- `2`: entorno o lenguaje no soportado;
- `3`: baseline fallido;
- `4`: uso, scope o sesión inválidos;
- `5`: fallo interno o restauración fallida.

## Persistencia e integridad

Cada sesión contiene metadata, baseline C.R.A.P., inventario del checkpoint, copias seguras de inputs e integridad SHA-256. Los reportes son append-by-identity y `latest.json` se reemplaza transaccionalmente. `doctor` valida esta evidencia pero no repara historia corrupta.

El runtime distribuido se construye primero como conjunto canónico completo; después calcula manifest, hashes y `treeSha256`, y por último se publica transaccionalmente. Nunca se poda manualmente un runtime después de calcular integridad.

## Mantenimiento y migración

Se conservan transacciones, rollback, ownership, integridad, runtime autocontenido e interfaces independientes de calidad. `.agentic-core/quality` es un directorio propio generado por la instalación actual.

Se retiran `start`, `resume`, `approve-mode-change`, `submit-handoff`, intención JSON, briefs, handoffs, reducer de runs, `protocol_retry`, replay, selección determinista de roles y validación obligatoria del sandbox efectivo.

Una actualización reconoce instalaciones legacy propias, reemplaza sus recursos canónicos y conserva `.agentic-core/runs` sin interpretarlo ni incorporarlo al ownership actual. Una instalación nueva no crea runs. La desinstalación también preserva ese estado legacy para decisión manual.

## Estrategia de testing

La interfaz CLI pública es el seam principal. Las pruebas ejecutan binarios reales y observan códigos de salida, stdout, stderr, reportes, hashes y filesystem. Cubren parsing exacto, atomicidad, idempotencia, baseline previo, inventario seguro, tests aprobados/fallidos, reglas C.R.A.P., Mutation por modo, restauración, sesiones inválidas, recibos obsoletos, salida humana/JSON, routing positivo, equivalencia de adapters, migración, ownership, runtime y packaging.

Los motores de análisis conservan pruebas focalizadas internas cuando una propiedad algorítmica no puede observarse con precisión razonable desde el CLI.
