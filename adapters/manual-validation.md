# Validación manual de coordinación semántica y QualitySession

Esta lista complementa las suites automatizadas. No convierte instrucciones de agentes en enforcement de seguridad ni exige demostrar un sandbox del host.

Para el cierre de #58 como entrega lista para usar y testear resultados reales,
el usuario difiere todos los recorridos nativos de Directo, Light y Normal,
incluidos perfiles, secuencias, correcciones, espera y Documentador final. Este
procedimiento se conserva para su ejecución posterior; no es evidencia aprobada
ni un bloqueo de ese cierre. La especificación padre #38 permanece sin cambios.

## Límites de evidencia

| Área | Contrato |
| --- | --- |
| `coordination` | `semantic-policy` |
| `host-security` | `not-verified` |
| `model-input` | `program-generated-json-only` |
| `legacy-runs` | `preserve` |

## Preparación común

1. Construir el runtime final con `npm.cmd run build:runtime` y comprobar `runtime-manifest.json`, hashes por archivo y `treeSha256` antes de instalarlo en fixtures limpias.
2. Instalar los mismos bytes en una fixture Codex, al menos una con espacios en la ruta.
3. Confirmar que `AGENTS.md` contiene routing positivo para `Orquesta`, `/orquestar` y `$orquestar`, que `Orquesta` sin modo usa `normal` y que una solicitud sin activador continúa directa.
4. Confirmar que los recursos instalados conservan `agentic-read`, `agentic-production`, `agentic-tests`, `orquestar` y `agentic-tdd`, y que las responsabilidades de Tester no amplían la escritura a producción.
5. No registrar secretos, `.env`, datos personales ni contenido irrelevante en la evidencia.

## Routing visible

En Codex:

1. Iniciar una solicitud con `Orquesta normal` y observar que se carga explícitamente `.agents/skills/orquestar/SKILL.md` antes de elegir roles.
2. Repetir con `/orquestar light` y `$orquestar full`.
3. Iniciar una solicitud sin activador y confirmar que se ejecuta directamente, sin cargar `orquestar`.
4. Confirmar que cada instancia recibe propósito, responsabilidades, alcance, entradas, criterios de devolución, Golden Rules y contexto pertinente, y que las entregas son prosa breve con objetivo, alcance, aceptación, decisiones condicionantes, resultado, defectos y referencias.
5. Confirmar que nunca hay más de un agente activo y que las entregas no contienen la conversación completa, reportes completos ni JSON.

## Matriz semántica

| Host | Modo | Roles esperados | Gate esperado |
| --- | --- | --- | --- |
| Codex | `light` | Implementador → Tester; dos roles base y hasta dos rondas adicionales compartidas | `prepare` + tests/DRY/C.R.A.P. en `verify`; Mutation `not_applicable`. |
| Codex | `normal` | Planificador → Implementador → Tester → Evaluador; cuatro roles base y hasta dos rondas adicionales compartidas; Documentador solo por petición y al final | `prepare` + tests/DRY/C.R.A.P. en `verify`; Mutation `NO_APLICA`. |

Las frases de permisos son contratos semánticos:

- Planificador y Evaluador: “solo lee producción; no la modifiques”.
- Implementador: “modifica únicamente producción y tests dentro del alcance”.
- Tester: “solo lee producción; puede corregir únicamente tests dentro del alcance; nunca modifica producción”.
- Verificador: “solo lee producción; no modifica tests ni documentación”.
- Documentador: “solo documentación”.
- Especificador: “delimita alcance y aceptación; identifica ambigüedades materiales; solo lectura”.
- Arquitecto: “revisa arquitectura y Golden Rules; ejecuta o solicita Mutation Testing; solo lectura”.

No atribuir a estas frases aislamiento técnico, permisos efectivos ni resistencia frente a un proceso adversarial.

## Light real en Codex

La evidencia nativa debe demostrar el comportamiento del host, no solo la presencia de archivos. En una fixture descartable:

1. Construir e instalar los mismos bytes del runtime y comprobar que Codex carga `.agents/skills/orquestar/SKILL.md`, `agentic-production` y `agentic-tests`.
2. Registrar versión de Codex, modelo efectivo, capacidades efectivas de cada perfil y el alcance entregado a cada instancia; no registrar secretos ni contexto personal.
3. Ejecutar una solicitud `Orquesta Light` o `/orquestar light` que cambie producción y tests. Confirmar el orden Implementador → Tester, un solo agente activo, `prepare` antes de editar, tests/DRY/C.R.A.P. deterministas y `QUALITY_OK` vigente con Mutation `not_applicable`.
4. Ejecutar una segunda fixture donde Tester rechace por un defecto reproducible. Confirmar que el coordinador agrupa las causas, crea una nueva instancia de Implementador y después un nuevo Tester, comparte el contador y conserva las causas pendientes al agotarlo.
5. Observar una espera por resultado, intervención o vencimiento. Renovar como máximo 60 segundos por espera, comprobar activamente tras 5 minutos sin novedades y confirmar que la lentitud o el silencio no reinician trabajo.
6. Etiquetar cada artefacto como evidencia nativa, simulación controlada o restricción semántica no demostrada técnicamente. La interpretación del agente no reemplaza el recibo de calidad.

## Full deprecado

Confirmar que una solicitud Full informa la deprecación y remite a
`KroxiDev/agentic-core:archive/full`, sin despachar roles ni convertir evidencia.
No ejecutar la suite archivada.

## Documentador explícito y final (#54)

Ejecutar en Codex real con una instalación del paquete actual y proyectos temporales
independientes. Estas instrucciones son un procedimiento, no evidencia de ejecución.

1. Repetir un cambio acotado en Light y Normal con “y documéntalo” o “usa un
   documentador”. Registrar petición, identificadores y orden de instancias, perfil
   efectivo `agentic-docs`, handoff y archivos modificados. Distinguir carga nativa
   del TOML de la entrega semántica íntegra de `developer_instructions`.
2. Provocar una corrección que cambie la solución inicial: comprobar que no hay
   Documentador mientras quedan defectos y que describe solo la solución final.
   Vincular el recibo vigente al estado recibido por el Documentador.
3. Comprobar Tester → Documentador en Light, Evaluador → Documentador en Normal,
   después de completar todas las correcciones.
   En Normal, comprobar que la entrega documental diferida no rechaza el
   cierre técnico ni consume rondas: queda pendiente para Documentador y para la
   comprobación final del coordinador; un defecto técnico sí impide el despacho.
   Confirmar que solo cambió documentación autorizada y que el coordinador comprueba
   la entrega sin otro Evaluador ni subagente posterior.
4. Repetir sin petición documental, incluyendo una sugerencia de otro rol y una
   exportación de calidad solicitada: ninguna debe activar Documentador. Comprobar
   también una solicitud ordinaria de documentación atendida en Directo.
5. Registrar por separado pruebas de instalación, observaciones del host y límites:
   no presentar instrucciones o tests de texto como prueba de despacho, orden o
   aislamiento técnico. Un recorrido no ejecutado queda NO_VERIFICADO.

## QualitySession

Usar un proyecto de prueba con código, tests, configuración del runner, manifest, lockfile, un archivo relevante no trackeado, `.env`, un cache y un archivo fuera del scope.

1. Ejecutar antes de editar:

   ```powershell
   node .agentic-core/runtime-launcher.mjs agentic-quality prepare --task manual-light --mode light --objective manual-validation
   ```

2. Confirmar `baseline_ready`, la captura de cambios preexistentes y del archivo pertinente no versionado en `active-task.json`, y la exclusión de secretos. Un nombre como `cache` o `data` no excluye por sí solo código legítimo.
3. Repetir el mismo comando sin cambiar entradas y confirmar que reutiliza el mismo ID.
4. Cambiar producción y tests dentro del scope y ejecutar:

   ```powershell
   node .agentic-core/runtime-launcher.mjs agentic-quality verify
   ```

5. Confirmar tests reales, C.R.A.P. diferencial, reporte hasheado y `QUALITY_OK` solo cuando todos los gates estén aprobados.
6. Modificar luego código, tests, configuración, manifest, lockfile o comando del runner y confirmar que el recibo anterior ya no es vigente.
7. En `light` y `normal`, confirmar `mutation=not_applicable` sin ejecución. En `full`, confirmar el rechazo por deprecación sin ejecutar ni modificar evidencia.
8. Corromper una copia de la evidencia de tarea y confirmar `NO_VERIFICADO`, sin `QUALITY_OK`; `explain` informa la causa sin ejecutar tests ni reparar evidencia.

## Interfaces públicas

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality test
node .agentic-core/runtime-launcher.mjs agentic-quality dry
node .agentic-core/runtime-launcher.mjs agentic-quality crap
node .agentic-core/runtime-launcher.mjs agentic-quality mutate
node .agentic-core/runtime-launcher.mjs agentic-quality explain --json
node .agentic-core/runtime-launcher.mjs agentic-quality prepare --task manual-light --mode light --objective manual-validation
node .agentic-core/runtime-launcher.mjs agentic-quality verify
```

Confirmar que no se acepta input JSON redactado por el modelo y que los comandos de mantenimiento disponibles son únicamente `init`, `update`, `doctor`, `uninstall`, ayuda y versión.

## Migración y mantenimiento

1. Actualizar una fixture legacy con `.agentic-core/runs` y confirmar que el directorio se preserva sin ser interpretado ni incluido en ownership nuevo.
2. Confirmar que una instalación nueva no crea `runs`, registra `.agentic-core/quality` como directorio propio y lo excluye mediante `.agentic-core/.gitignore` sin ocultar los demás recursos gestionados.
3. Confirmar que `doctor` valida sesiones y recibos de calidad, e informa estado legacy sin borrarlo.
4. Confirmar que `uninstall --dry-run` anuncia la eliminación de `quality` y la preservación de `runs`; la ejecución debe respetar esa decisión.
5. Comprobar rollback inyectando un fallo transaccional en una fixture descartable.

## Gate final

1. Construir con el lockfile (`npm.cmd ci`) y seleccionar las suites pertinentes de la matriz en `acceptance/windows-codex.md`; no repetir suites costosas con evidencia vigente.
2. Ejecutar `node --test test/windows-acceptance.test.js` en Windows y conservar resultado, plataforma y hash del paquete. Un skip no valida otra plataforma.
3. Ejecutar `npm.cmd run check` y `git diff --check`.
4. Completar solo los recorridos nativos autorizados y registrar perfiles efectivos, secuencias y límites. El cierre de #58 difiere Directo, Light y Normal al usuario, sin ejecutarlos ni aprobarlos; Linux conserva su aceptación independiente en #59.
5. Verificar el inventario del paquete y comunicar los escenarios pendientes sin emitir una aceptación global falsa ni exigir KPIs o benchmarks.
