# Especificación arquitectónica de agentic-core 0.2.0

## Problema

La coordinación anterior mezclaba decisiones semánticas de agentes con un reducer determinista, estado de runs, briefs y handoffs JSON, validación de protocolo y afirmaciones de permisos efectivos que los hosts no siempre podían demostrar. A la vez, tests, cobertura, C.R.A.P. y Mutation Testing sí necesitan ejecución, persistencia e integridad deterministas.

## Decisión

Separar dos responsabilidades:

1. Coordinación semántica: activación, roles, alcance, permisos, retrabajo y documentación mediante instrucciones breves para agentes cooperativos.
2. `QualitySession`: baseline previo, tests reales, C.R.A.P. diferencial, Mutation Testing en `full`, inventarios, snapshots, hashes, restauración, vigencia y recibos verificables.

No existe un port nuevo de host. Codex y Claude comparten la misma política y sus adapters solo traducen formato y discovery nativos.

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
- `prepare --mode <light|normal|full> --scope <ruta> [--scope <ruta>...]`
- `verify --session <id>`

No existe entrada JSON de coordinación o calidad redactada por el modelo.

## Coordinación semántica

### Activación

Los activadores admitidos al comienzo de la solicitud son `Orquesta`, `/orquestar` y `$orquestar`. Sin modo explícito se usa `normal`. Sin activador, la solicitud se ejecuta directamente.

Los bloques gestionados de `AGENTS.md` y `CLAUDE.md` ordenan positivamente cargar `.agents/skills/orquestar/SKILL.md` para los tres activadores y prohíben completar un cambio ejecutable orquestado sin un `QUALITY_OK` vigente.

### Modos

- `light`: Implementador; `prepare` antes de editar si cambia comportamiento; TDD cuando corresponde; `verify` obligatorio.
- `normal`: plan breve del coordinador; Planificador solo ante una decisión HOW material; `prepare`; Implementador con TDD si cambia comportamiento; Verificador independiente; máximo dos ciclos de corrección; `verify`; Documentador solo si corresponde.
- `full`: Planificador con la exploración necesaria; `prepare`; Implementador con TDD cuando corresponde; Evaluador independiente; máximo dos ciclos de corrección; `verify` con C.R.A.P. y Mutation Testing; Documentador solo si corresponde.

Solo puede haber un agente activo. Los agentes responden en prosa breve con resultado, bloqueantes y evidencia. La ambigüedad se aclara semánticamente y no crea un retry de protocolo.

### Permisos

- Planificador, Evaluador y Verificador: solo leen producción y no la modifican.
- Implementador: modifica únicamente producción y tests dentro del alcance.
- Documentador: solo documentación.
- Operaciones destructivas, commit, push, publicación y cambios remotos requieren autorización explícita.

Son restricciones semánticas, no enforcement de filesystem ni prueba de aislamiento del host.

## QualitySession

### `prepare`

1. Valida un modo y uno o más scopes relativos y contenidos en el proyecto.
2. Normaliza scopes repetidos y admite directorios o archivos inexistentes.
3. Descubre el runner y su evidencia relevante.
4. Captura el worktree actual como checkpoint, incluidos cambios preexistentes y archivos relevantes no trackeados.
5. Excluye secretos, `.env`, datos personales, caches, binarios y datos operativos.
6. Ejecuta los tests y obtiene C.R.A.P. atribuible cuando el entorno lo soporta.
7. Deriva el ID de modo, scopes, inventario y entorno.
8. Publica transaccionalmente una sesión inmutable en `.agentic-core/quality/<sessionId>/` o reutiliza una sesión idéntica e íntegra.

Un fallo de argumentos, entorno, baseline o persistencia no publica estado parcial ni modifica producción, tests o documentación.

### `verify`

1. Carga y valida hashes de una sesión creada por `prepare`.
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
