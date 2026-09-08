# Aceptación integrada de Windows — issue #58

Contrato: [#38](https://github.com/KroxiDev/agentic-core/issues/38), escenarios 1–26.
Dependencias #54, #55, #56 y #57 cerradas e integradas en la base
`6da0d92320e729b0f2dd4ae36e8792cbc565c4e3` (consultado el 8 de septiembre de 2026).
La aceptación permanece **parcial** mientras falte evidencia nativa; una suite verde
no cierra por sí sola el issue. Full nativo queda reservado para la prueba manual
del usuario. No se ejecuta una orquestación Full como parte de estas pruebas.

## Reproducción acotada

1. Desde un checkout propio, instalar las dependencias bloqueadas con `npm.cmd ci`.
   Su paso `prepare` construye el runtime del checkout.
2. Ejecutar `node --test test/windows-acceptance.test.js`. Usa el constructor
   compartido `createTestProject` y la fixture `pythonProject`, con el instalador
   seleccionado desde un tarball real de `npm pack`. No instala agentic-core como
   dependencia del consumidor. Inhabilita la ruta del bootstrap antes de verificar
   el runtime persistido. No necesita publicar un paquete ni cambiar instalaciones
   personales. Cada ejecución produce su SHA-256 del paquete en el diagnóstico.
3. Reutilizar las suites existentes de la matriz según el cambio. Los resultados
   solo son vigentes para los inputs, herramientas y entorno efectivamente usados;
   una referencia a una suite sin ejecutarla no constituye un aprobado.
4. Completar la aceptación del host con el
   [procedimiento nativo](https://github.com/KroxiDev/agentic-core/blob/main/adapters/manual-validation.md),
   registrando versión de Codex, estado del runtime, petición, instancias, perfiles
   efectivos, secuencia, correcciones, espera, recibo final y archivos modificados.
   Distinguir instrucciones semánticas de permisos técnicos observados.

## Evidencia y límites

Referencia de ejecución: Windows, Node.js 24.11.1, Python 3.14.6 y pytest 9.1.1.
Herramientas privadas del paquete: dry4python 0.1.0, crap4py 0.1.1 y mutate4py 0.1.4.
Esto no acredita otras versiones de Python, otras ediciones de Windows ni Linux.

Runtime ejecutado (`dist/runtime/agentic-core.mjs`), SHA-256:
`2d1280c53a26ff128eba273b7d1c098b1c7f890e5de2e7914608d9a19200aff3`.
Los cambios de esta entrega son pruebas y superficies documentales; no modifican
el motor. La matriz se conserva por petición del issue, no como historial automático
de tareas del consumidor.

El recorrido instalado ejecuta el wrapper y pytest declarados, con cwd y argumentos
con espacios y un entorno virtual distinto del de las herramientas. Comprueba DRY,
C.R.A.P., dos mutantes detectados, reutilización sin nuevas invocaciones ni cobro,
invalidación por inputs, diagnóstico compacto y JSON sin ejecutar tests, privacidad,
exportación expresa, sustitución de tarea, actualización, previsualización,
desinstalación y preservación de archivos y entorno por hashes. Finalmente vuelve a
ejecutar pytest desde el consumidor sin la capa. El comando `mutate` individual no
es un recibo Full ni prueba de despacho del Arquitecto.

Las dos pruebas que requieren terminar procesos fallaron inicialmente dentro del
sandbox con `termination_failed` (cuatro fallos contando el padre y sus subcasos).
Al repetir únicamente `installed mutate4py executes…` y
`installed verification consumes real resources…` fuera del sandbox, los siete
casos pasaron. Se observaron los cinco estados del corpus: un detectado, un
superviviente, uno no cubierto, un timeout y un error. El resultado inconcluso se
conservó sin `QUALITY_OK`. Esto verifica el recorrido de Windows con permisos para
terminar sus procesos; no promete que funcione bajo cualquier política del host.

### Comprobaciones ejecutadas el 8 de septiembre de 2026

La selección se hizo con `node --test --test-name-pattern=…`, no con la suite global.
Los nombres se refieren a tests existentes; no se recrearon sus fixtures.

| Grupo | Selección | Resultado |
| --- | --- | --- |
| Paquete completo | `windows-acceptance.test.js` | 1/1; pytest vuelve a pasar después de desinstalar. |
| Superficies | `release-documentation.test.js`, `semantic-coordination.test.js` | 17/17; evidencia local y textual, no nativa. |
| Inventario | `npm pack contains exactly…` en `package.test.js` | 1/1; incluye esta matriz en el distribuible. |
| Reutilización | `normal/full reuses independent controls…` | 2/2; Full cuenta la referencia real de mutación y acredita el delta vacío como `NO_APLICA`. |
| Integración seleccionada | Mantenimiento del paquete; selección de Python; recursos/copias; política de inputs; cero/código no cargado y módulo C.R.A.P.; límites DRY; selección y corpus de mutación; agregación/score; baseline real y presupuesto compartido | 22/22 tras la repetición acotada de los casos con timeout. |
| Incremental y runner | `private tools and installed runtime survive…`, `installed pytest requires…`, `incremental C.R.A.P. rejects…`, `incremental DRY requires…` | 12/12, incluidos ocho subcasos del runner. |
| Mutación y presupuesto | `installed Full applies a configured threshold…`, `installed mutation accounts baseline exhaustion…` | 2/2; motor determinista instalado, sin agentes Full. |
| Chequeos estáticos | `npm.cmd run check`, `node --check test/windows-acceptance.test.js`, `git diff --check` | Aprobados. |

La revisión del paquete también confirmó migración de un consumidor de esquema 2,
rollback con fallo inyectado y preservación de contenido ajeno. No se transfieren
entornos ni evidencia entre instalaciones. Las suites adicionales citadas en la
matriz son puntos de comprobación disponibles; no se afirman ejecutadas completas.

Se intentó Directo real con Codex CLI 0.153.4 autenticado. El primer lanzamiento
falló al iniciar el servidor local por permisos. Al poder iniciar el host, su política
bloqueó tanto la lectura de las Golden Rules como el comando de calidad antes de
ejecutarlos (`blocked by policy`). El agente informó que pytest no se ejecutó.
El proceso Codex terminó con código 0: ese código **no** acredita aceptación.
Directo queda NO_VERIFICADO; Light y Normal no se lanzaron tras ese bloqueo común.
Full no se lanzó por indicación del usuario. No se afirma selección nativa de
perfiles, correcciones, espera ni Documentador a partir de archivos TOML o mocks.

## Matriz de los 26 escenarios

Las rutas de pruebas son relativas al repositorio. **Local** identifica comprobaciones
internas; **herramientas** identifica comandos reales del runtime instalado;
**host** identifica comportamiento nativo de Codex. Una cobertura parcial enumera
lo observado y conserva explícito lo pendiente, sin convertirlo en soporte.

| N.º | Escenario | Evidencia reutilizable o añadida | Capa y límite |
| --- | --- | --- | --- |
| 1 | Modos y activación | `semantic-coordination.test.js`; procedimiento nativo | Local: contrato textual; host NO_VERIFICADO. |
| 2 | Perfiles efectivos | `python-install.test.js`; procedimiento nativo | Instalación de perfiles; selección y límites efectivos NO_VERIFICADO. |
| 3 | Correcciones | `semantic-coordination.test.js`; procedimiento nativo | Host NO_VERIFICADO; no se infieren nuevas instancias de una prueba de texto. |
| 4 | Documentación explícita y final | `installation-maintenance.test.js`; procedimiento nativo | Recursos instalables; secuencia real del Documentador NO_VERIFICADO. |
| 5 | Espera por eventos | Procedimiento nativo | Host NO_VERIFICADO. |
| 6 | Presupuesto | `quality-task-budget.test.js`; `quality-python-mutation.test.js`; `windows-acceptance.test.js` | Herramientas: baseline, verificaciones y reutilización; la selección de mutación incluye el caso negativo de agotamiento. |
| 7 | Instalación autónoma | `windows-acceptance.test.js` | Herramientas/Windows: tarball, ruta con espacios, bootstrap ausente, sin dependencia del consumidor. |
| 8 | Selección cerrada | `python-install.test.js` | Configuración, selección y previsualización; no acredita runtimes Python no disponibles. |
| 9 | Python y pytest autoritativos | `windows-acceptance.test.js`; `quality-pytest-execution.test.js` | Herramientas: intérprete, venv, wrapper, argumentos, cwd, suite observada y controles negativos existentes. |
| 10 | Configuración efectiva | `quality-python-dry.test.js`; `quality-python-crap.test.js`; `quality-python-verification.test.js` | Límites y agregación; distinguir tests internos de aplicación instalada. |
| 11 | Baseline real | `quality-task-baseline.test.js` | Herramientas: cambios previos, inputs no versionados y baseline preservado. |
| 12 | Fallos iniciales | `quality-task-baseline.test.js` | Herramientas: fallos reparables/ajenos y rechazo de evidencia inválida. |
| 13 | Calidad incremental | `quality-python-verification.test.js`; `quality-dry-resolutions.test.js` | Suites existentes de límites y atribución; no supone reparar deuda ajena. |
| 14 | Atribución | `quality-python-crap.test.js` | Herramientas: cero, no cargado, partes no soportadas y métricas parciales. |
| 15 | Código procedural | `quality-python-crap.test.js`; `quality-python-dry.test.js` | Herramientas: cuerpo de módulo y límites; sin aprobación silenciosa. |
| 16 | Mutación completa | `windows-acceptance.test.js`; `quality-python-mutation.test.js`; `quality-python-verification.test.js` | Herramientas: corpus real; local: selección, equivalentes y score. No equivale a Full nativo. |
| 17 | Mutación inconclusa | `quality-python-mutation.test.js`; `quality-python-verification.test.js` | Corpus con timeout/error y agregación local; fallos del host se reportan sin falsear detectados. |
| 18 | Snapshots e inputs | `quality-project-inputs.test.js`; `quality-project-copy.test.js` | Recursos JSON, SQL, plantillas, configuración y helper; permisos Linux pendientes en #59. |
| 19 | Secretos y rutas | `quality-project-copy.test.js`; `windows-acceptance.test.js` | Datos sintéticos, inventarios, diagnóstico y exportación sin secretos ni rutas privadas. |
| 20 | Integridad y recibos | `quality-task-baseline.test.js`; `windows-acceptance.test.js` | Invalidación por input, baseline corrupto y efectos por hashes; demás cambios tienen suites existentes. |
| 21 | Retención | `windows-acceptance.test.js`; `quality-result-export.test.js` | Nueva tarea retira evidencia propia y conserva exportación y contenido ajeno. |
| 22 | Independencia | `python-install.test.js`; `windows-acceptance.test.js` | Hash íntegro de una segunda instalación antes y después de sustituir tarea, actualizar y desinstalar la primera; sincronización excluida del producto. |
| 23 | Mantenimiento | `package.test.js`; `installation-maintenance.test.js`; `windows-acceptance.test.js` | Paquete: previsualización, migración, rollback inyectado, repetición y conservación. |
| 24 | Salida | `release-documentation.test.js`; `quality-diagnostics.test.js`; `windows-acceptance.test.js` | Estructura pública, pipes/JSON, causas y contador; prueba textual no equivale a TTY nativo. |
| 25 | Plataformas | `windows-acceptance.test.js` | Recorrido Windows; Linux NO_VERIFICADO y separado en #59. |
| 26 | Reutilización | `quality-evidence-reuse.test.js`; `windows-acceptance.test.js` | Controles vigentes antes de ejecutar, invalidación y nueva tarea; contador distingue referencia de mutación en Full. |

## Cierre

Registrar el resultado de los comandos seleccionados y sus fallos en la PR. No
repetir toda la suite, benchmarks ni orquestación Full para completar esta matriz.
Las brechas de host mantienen la PR pendiente de aceptación nativa. Linux se sigue
en [#59](https://github.com/KroxiDev/agentic-core/issues/59) y no bloquea Windows.
No hay exportación remota real del producto implícita en crear la PR de esta entrega.
