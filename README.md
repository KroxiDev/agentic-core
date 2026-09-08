# agentic-core 0.2.0

`@kroxidev/agentic-core` instala una capa autónoma para Codex y una unidad Python 3.11+ (esquema 3), con runtime y herramientas privados. Directo aplica las Golden Rules y las comprobaciones pertinentes del encargo. La verificación agregada de tareas Light y Normal exige suite, DRY y C.R.A.P. y puede emitir `QUALITY_OK`; Full integra Mutation Testing incremental. Las secciones de coordinación y `QualitySession` del esquema 2 se conservan para instalaciones anteriores.

## Requisitos y soporte

- Node.js 20 o posterior.
- Las instalaciones nuevas admiten solo Codex y Python 3.11 o superior; el runner declarado es pytest.
- Las herramientas privadas son dry4python 0.1.0, crap4py 0.1.1 y mutate4py 0.1.4. La versión efectiva se comprueba; no se garantiza toda sintaxis futura.
- CodeGraph y Engram son integraciones opcionales de descubrimiento y memoria; no son requisitos del runtime.

| Plataforma | Nivel de soporte |
| --- | --- |
| Windows 10/11 | Plataforma inicial; aceptación integrada y límites en `acceptance/windows-codex.md`. |
| Linux | Aceptación automática en Ubuntu 24.04; perfiles nativos de Codex pendientes de prueba manual. |

La entrega de #58 queda lista para usar y testear resultados reales. La aceptación
nativa completa de Codex sigue `NO_VERIFICADO`: el usuario realizará después
Directo, Light, Normal y Full, incluidos perfiles, correcciones, espera y Documentador
final. El checklist de `acceptance/windows-codex.md` conserva esos pendientes;
el cierre de #58 no certifica los 26 escenarios de #38.

Linux dispone de un recorrido automático de aceptación en Ubuntu 24.04 mediante
GitHub Actions. La comprobación manual de perfiles en Codex queda a cargo del
usuario y no bloquea el cierre de [#59](https://github.com/KroxiDev/agentic-core/issues/59); el soporte integral
permanece **NO_VERIFICADO**. Consulte el
[alcance automático y la aceptación manual pendiente](https://github.com/KroxiDev/agentic-core/blob/main/adapters/linux-acceptance.md).

## Desarrollo desde un clon

Después de clonar este repositorio, ejecuta el siguiente paso obligatorio desde la raíz antes de invocar los binarios de `bin/`:

```powershell
npm install
```

La instalación ejecuta `prepare` y construye `dist/runtime/agentic-core.mjs`. Si las dependencias ya están instaladas y solo falta regenerar el runtime, ejecuta `npm run build:runtime`.

`dist/runtime/` permanece deliberadamente sin versionar porque es un artefacto reproducible derivado de `src/` y de las dependencias bloqueadas. Reconstruirlo evita duplicar código fuente y acumular diffs generados obsoletos; los paquetes preparados para consumo sí incluyen el runtime construido.

## Instalación

### `agentic-core init`

Desde la raíz del proyecto destino:

```powershell
npx.cmd --yes github:KroxiDev/agentic-core init . --provider codex --language python --dry-run
npx.cmd --yes github:KroxiDev/agentic-core init . --provider codex --language python
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--dry-run` | — | No | No |
| `--provider` | <proveedor> | No | No |
| `--language` | <lenguaje> | No | No |
| `--python` | <intérprete> | No | No |
| `--config` | <archivo> | No | No |

Sin selección explícita, una terminal interactiva pregunta proveedor y lenguaje. En pipes se requieren las opciones o un archivo completo mediante `--config`. El esquema cerrado se instala en `.agentic-core/config.schema.json`. `AGENTIC_CORE_PYTHON` prevalece sobre `--python`, la configuración y la autodetección de `.venv` y PATH.

El payload se valida por origen declarado, inventario y hashes, independientemente del bootstrap. El runtime queda en `.agentic-core/runtime` y las herramientas en `.agentic-core/tools`, sin modificar dependencias, manifests, lockfiles ni el entorno del consumidor. Los wheels y licencias viajan con el paquete; instalar no requiere red. La operación rechaza conflictos y revierte sus escrituras ante fallos.

La integración añade un bloque de Codex a `AGENTS.md` y los perfiles de los modos actuales
(`.codex/agents/agentic-read.toml`, `.codex/agents/agentic-production.toml`,
`.codex/agents/agentic-tests.toml`, `.codex/agents/agentic-docs.toml`,
`.agents/skills/orquestar/SKILL.md` y `.agents/skills/agentic-tdd/SKILL.md`). Conserva el
contenido previo y la política canónica en `.agentic-core/golden-rules.md`. El ignore local
excluye `/quality/` y `/tools/`.

## Tests funcionales con alcance por invocación

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality test --scope src/payments.py --test tests/test_payments.py
```

`--scope` selecciona el código medido y `--test` los tests que se ejecutan. Ambas opciones admiten archivos o carpetas relativos a la raíz del consumidor y pueden repetirse. No admiten globs, rutas externas ni selección por función. Sin `--scope` se usa el alcance configurado; sin `--test` se conserva la selección del comando del proyecto. Los flags son transitorios: no modifican `config.json` ni activan DRY, C.R.A.P. o mutación.

Se conserva el intérprete, wrapper, directorio, configuración y opciones de pytest del proyecto, incluidos filtros como `-k`. El observador privado sustituye las rutas de colección dentro de pytest; no reescribe los argumentos del wrapper. La selección por rutas no admite `--pyargs`. Los inputs auxiliares permitidos siguen en la copia controlada, aunque no formen parte del código medido. Las exclusiones e integridad siguen vigentes.

La salida muestra el alcance y los archivos de tests ejecutados. `AGENTIC_CORE_OUTPUT=json` añade `selection`, inventario, identidad de ejecución, cobertura y `suite.executed` (ruta, identificador opaco y resultado por test, sin publicar parámetros). Cambiar código o tests seleccionados cambia la identidad de evidencia; esta ejecución no publica un recibo `QUALITY_OK` ni reemplaza aprobaciones de tareas. Fallos reales se rechazan; falta de ejecución, cobertura no atribuible o parcial del alcance explícito, límites o cambios de inputs impiden aprobar. La selección por cambios de tarea queda para T6 (#89).

## Baseline de tarea Python (esquema 3)

Antes de editar en Light, Normal o Full, prepare el estado real del worktree con el alcance e inputs de `config.json`:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality prepare --task arreglo-43 --mode normal --objective issue:43 --repair-test tests/test_subject.py
node .agentic-core/runtime-launcher.mjs agentic-quality baseline
node .agentic-core/runtime-launcher.mjs agentic-quality verify
```

`--repair-test` es opcional y repetible: identifica archivos de pruebas cuyos fallos iniciales pertenecen al encargo. Los demás fallos se informan como ajenos y no amplían el alcance. El baseline conserva código, inputs no versionados, cobertura y evidencia de fallos sin usar el diff contra HEAD para atribuir autoría. Los fallos de comprobación y los defectos atribuibles al código medido pueden conservarse como baseline fallido válido aunque se detecten en fixtures. Los grupos anidados requieren atribución de cada excepción interna. Los errores de importación o dependencias producen `NO_VERIFICADO` incluso desde código medido; también lo producen los errores de integridad, de preparación sin atribución o los grupos con errores no atribuibles. Declarar `--repair-test` no valida esa evidencia.

La referencia breve `.agentic-core/quality/active-task.json` contiene el objetivo, alcance e inicio inmutable de la tarea. Repetir `prepare` conserva ese inicio, incluso después de cambios; `baseline` compara inputs y condiciones actuales sin ejecutar pytest. Un cambio de pruebas, comando, configuración, runtime, dependencias o recursos vuelve obsoleta la evidencia afectada. `verify` exige la suite final aprobada y compara DRY y C.R.A.P. contra ese baseline; Light y Normal emiten `QUALITY_OK` solo con evidencia vigente y completa. Full integra Mutation Testing incremental sobre el baseline real y solo emite `QUALITY_OK` cuando todos los mutantes exigibles tienen un resultado concluyente. Directo puede usar `test` sin preparar una tarea.

Una continuación conserva el mismo `--task`; cambiar su modo, objetivo o `--repair-test` se rechaza con `task_metadata_conflict` sin reemplazar el baseline. `verify` comprueba la vigencia por control y registra en el informe cuáles reutiliza y la causa de cada nueva ejecución. Cambiar solo las resoluciones DRY conserva las pruebas y C.R.A.P. vigentes; Full también aprovecha los controles válidos y vuelve a medir la mutación solo cuando cambia su identidad de evidencia. Al preparar una tarea distinta se retiran únicamente los artefactos internos reconocibles de la tarea anterior y se conserva cualquier archivo desconocido o externo, sin historial ni caché entre tareas. Si un archivo previsto para limpieza cambia durante la captura, la operación se aborta conservando la tarea anterior y el contenido divergente.

### Presupuesto acumulado de comprobaciones

Para explicar una configuración dudosa o una verificación fallida, use `node .agentic-core/runtime-launcher.mjs agentic-quality explain`. Muestra la integración efectiva, versión Python, comando, alcance público, exclusiones, límites, causas y siguiente acción. Comprueba hashes e identidad del entorno sin ejecutar la suite ni los analizadores, sin reparar ni escribir evidencia. `agentic-core doctor` conserva el diagnóstico de integridad de la instalación.

La salida de `explain` es breve en terminal y por pipes. `explain --json` (o `AGENTIC_CORE_OUTPUT=json`) entrega el informe estructurado completo, con inventario público, vigencia por control y referencia a `verification.json` cuando existe. Se conservan los estados y códigos de la verificación vigente; evidencia obsoleta o corrupta produce `NO_VERIFICADO`, nunca un nuevo `QUALITY_OK`. Las rutas privadas y valores de entorno se omiten; los argumentos no públicos se redactan. Citar el comando de diagnóstico o la referencia del veredicto basta para un handoff sin registros extensos.

`limits.operation` configura `commandTimeoutMs` (120000 ms inicialmente), `totalBudgetMs` (600000 ms) y `workers` (4). Los tiempos son enteros entre 1 y 2147483647 ms; la concurrencia admite de 1 a 4 comandos. Ajuste estos valores para la suite real del proyecto: no se selecciona una suite sustituta ni se cambia de modo.

El acumulado de `.agentic-core/quality/budget.json` suma el tiempo efectivo de los comandos de pruebas y analizadores, incluidos sus pasos previos dentro del wrapper, el baseline y los reintentos. Excluye razonamiento, implementación, esperas entre operaciones, preparación de copias e inspección de identidad para decidir reutilización. Cada comando queda reservado antes de iniciarse y se liquida cuando termina su árbol de procesos. Los comandos concurrentes suman sus tiempos individuales; las reservas impiden exceder el saldo disponible. `workers` es un máximo, no obliga a paralelizar controles dependientes.

`prepare`, `test`, `dry`, `crap` y `verify` comparten el consumo de la tarea activa. Repetir preparación, cambiar de rol o modificar límites no lo reinicia; solo una tarea distinta comienza otro acumulado. Sin tarea preparada, Directo aplica el mismo contabilizador a todos los comandos de cada operación, en memoria y sin crear estado de tarea. La evidencia reutilizada no vuelve a cobrar su ejecución histórica. Consola y JSON muestran consumo y límites; `baseline` permite consultarlos sin ejecutar pruebas.

`command_timeout` identifica el límite individual y `budget_exhausted` el total; ambos producen `NO_VERIFICADO` cuando falta evidencia requerida, con salida 6 en la ejecución afectada. Un rechazo comprobado conserva su salida 1. El veredicto conserva los controles parciales en `verification.json` y no emite `QUALITY_OK` con comprobaciones requeridas inconclusas. Aumentar un límite conserva el consumo previo e invalida la evidencia cuya configuración cambió.

Una sola operación puede poseer `budget.lock`; otra devuelve `budget_busy`. Tras una interrupción del controlador, confirme que sus procesos terminaron antes de retirar ese bloqueo. Una reserva pendiente, un presupuesto corrupto o ausente en una tarea anterior a esta versión no se convierten en consumo cero: requieren iniciar una tarea distinta. No se recupera automáticamente un proceso cuya terminación no se puede demostrar.

La mutación integrada de Full (#49–#50) usa `withCurrentTaskBudget` y `executeCommand` dentro del mismo contexto de ejecución. Este contrato reserva, contabiliza y aplica concurrencia y límites a cada comando sin crear otro presupuesto por worker o por mutante.

### C.R.A.P. de Python

Análisis autónomo con código y tests seleccionados, sin preparar una tarea:

```sh
node .agentic-core/runtime-launcher.mjs agentic-quality crap --scope src/payments.py --test tests/test_payments.py
```

`--scope` y `--test` usan la misma selección transitoria de archivos o carpetas que `test` y pueden repetirse. Sin opciones conservan los valores del proyecto. Solo se ejecutan C.R.A.P. y los tests necesarios mediante el comando autoritativo; no se invocan DRY ni mutación ni se reparan archivos. El informe identifica selección, tests efectivamente ejecutados y estado actual (`analysis: current`), incluidos incumplimientos preexistentes aunque haya una tarea activa. No representa una comparación con el inicio. La identidad incorpora código y tests seleccionados; una cobertura incompatible no puede reutilizarse. Cada invocación autónoma mide de nuevo y conserva los límites y el presupuesto aplicables.

`node .agentic-core/runtime-launcher.mjs agentic-quality crap` ejecuta el pytest autoritativo en su copia controlada y mide mediante `crap4py==0.1.1` del entorno privado. Usa `limits.crap` (7 inicialmente, inclusive), muestra valor, límite y ubicación, y conserva el informe íntegro en `.agentic-core/quality/crap.json`. `AGENTIC_CORE_OUTPUT=json` expone los datos normalizados, identidades y causas para automatización. Esta medición no emite `QUALITY_OK`.

El adaptador conserva el cálculo de complejidad y C.R.A.P. del motor; delimita funciones y comportamiento de módulo sin contar dos veces sus cuerpos. Usa ramas atribuibles y, cuando no hay ramas, sentencias observadas para no convertir un cuerpo sin ejecutar en cobertura completa. La cobertura cero tiene un valor numérico; código no cargado, atribución ausente o ambigua, sintaxis no analizable y otros lenguajes incluidos en el alcance quedan `NO_VERIFICADO`, con resultados válidos de las demás partes. Las lambdas sin atribución separada también se informan como limitación. Un ámbito que contiene una expresión generadora queda `generator_coverage_unsupported`, con valor y cobertura desconocidos: las líneas no separan su creación de la ejecución diferida, incluso si los tests la consumen; las métricas de otros ámbitos soportados se conservan. Las anotaciones de parámetros, retorno y variables de módulo/clase, los valores de alias de tipo y los límites, restricciones y defaults de parámetros de tipo conservan filas `annotation_coverage_unsupported`, con valor y cobertura desconocidos: ejecutar la declaración no demuestra su evaluación independiente. Las asignaciones y cuerpos conservan sus métricas sin volver a contar esas expresiones. La limitación incluye anotaciones simples y stringizadas; su modalidad usa la versión observada de pytest y queda desconocida si no se pudo observar. Las anotaciones locales que Python nunca evalúa no añaden comportamiento ejecutable. `NO_APLICA` exige ausencia comprobada de comportamiento ejecutable en el alcance. Un informe ajeno o divergente se conserva y produce un conflicto explícito.

### DRY de Python

`node .agentic-core/runtime-launcher.mjs agentic-quality dry` ejecuta `dry4python==0.1.0` en un directorio temporal con el código Python medido por la política de inputs vigente. Usa `limits.dry.similarity`, `limits.dry.minLines` y `limits.dry.minNodes`; el motor recibe los tres límites y sus candidatos se normalizan con ubicación, rango de líneas, símbolo, score y nodos. El código de salida del motor no decide por sí solo si hay duplicaciones ni si la comprobación está aprobada.

El resultado queda en `.agentic-core/quality/dry.json`. Un candidato nuevo o modificado produce `rejected` hasta que se corrija o se registre una justificación concreta en `.agentic-core/quality/dry-resolutions.json`, asociada al ID del candidato, al digest de inputs y a la configuración actual:

```json
{
  "schemaVersion": 1,
  "inputs": "<hash del informe DRY>",
  "configuration": "<hash de config.json>",
  "resolutions": [
    {
      "candidate": "<id del candidato>",
      "decision": "keep",
      "reason": "first conserva el orden de entrada; second usa result.reverse() para entregar la secuencia invertida requerida por su consumidor."
    }
  ]
}
```

La razón debe mencionar ambos símbolos del candidato y un fragmento de sus cuerpos ofrecido en `bodyReferences`, con al menos ocho palabras distintas y sin fórmulas de aprobación vacía como «ok», «están bien» o «no necesitan cambios». Ese contrato exige una explicación ligada al código; el Tester sigue siendo responsable de valorar el diseño. Una razón que no cumple ese contrato o una resolución retirada durante la medición no aprueba el candidato.

Cuando existe `active-task.json`, la detección analiza sus fuentes originales con los límites actuales. Compara las identidades de los cuerpos duplicados, sin atribuir a la tarea cambios ajenos en el archivo o traslados identificables; cada par previo puede justificar un único par actual, de modo que nuevas copias siguen pendientes. Cambiar un límite renueva la detección sin reemplazar el baseline. Si cambian los inputs o los límites, las resoluciones previas quedan obsoletas.

Los pragmas `dry4python: ignore` e `ignore-file` se neutralizan únicamente en las copias de análisis. El motor fijado mide funciones y métodos: el código procedural de módulo o clase que alcanza los tamaños mínimos configurados queda `NO_VERIFICADO`, con ubicaciones y los candidatos válidos de las demás partes. También se conservan resultados parciales ante errores sintácticos, sin publicar el texto fuente en el diagnóstico. `NO_VERIFICADO` diferencia errores de herramienta, integridad o medición de `no_duplicates`; esta comprobación tampoco emite `QUALITY_OK`.

### Veredicto incremental y `QUALITY_OK`

`agentic-quality verify` reúne el resultado de la suite final, DRY y C.R.A.P. en `.agentic-core/quality/verification.json`. El informe vincula el modo, alcance, inventarios y hashes de inputs, comando efectivo, configuración, versiones, entorno, baseline y resultados actuales. `QUALITY_OK` solo aparece en el campo `receipt` del JSON cuando todos los controles exigibles están aprobados; una ejecución incompleta, una evidencia corrupta o un cambio de configuración produce `NO_VERIFICADO` y no reutiliza un aprobado anterior.

El diferencial de C.R.A.P. aplica `limits.crap` al código nuevo y exige que los símbolos existentes dentro del alcance no empeoren respecto de su valor inicial. La deuda heredada por encima del límite se conserva como contexto y solo debe no empeorar. Un traslado se atribuye únicamente con una identidad de símbolo y fingerprint únicos; si no puede establecerse la correspondencia, el resultado queda sin verificar. DRY conserva candidatos nuevos o modificados como rechazados hasta que exista una resolución concreta ligada al ID, inputs y configuración actuales.

Light y Normal pueden cerrar con `approved` y `QUALITY_OK`; sus controles de mutación son `NO_APLICA`. Full selecciona, sin muestreo, los mutantes de líneas añadidas o modificadas respecto de las fuentes reales del baseline. Los mutantes fuera del delta se informan como preexistentes y los equivalentes solo se excluyen con una prueba estática de identidad de bytes o de identidad estructural del AST de Python, ligada a los hashes de ambas fuentes. El denominador incluye los mutantes sin cobertura y el mínimo configurable es `limits.mutationScore` (90 inicialmente); cualquier timeout, error, interrupción o pendiente deja el control en `NO_VERIFICADO`. Un denominador vacío produce `NO_APLICA` con explicación y no un score automático de 100. `approved`, `rejected`, `NO_VERIFICADO` y `NO_APLICA` incluyen códigos de causa, y el estado agregado nunca convierte una medición ausente en un aprobado.

### Ejecución individual de mutantes Python

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality mutate
```

`mutation` es alias de `mutate`. En esquema 3 se usa el alcance de `config.json`, sin `--target`. mutate4py 0.1.4 genera las modificaciones y el adaptador ejecuta el comando autoritativo completo, incluidos wrapper, argumentos, entorno, configuración y preparación. No instala herramientas en el entorno del proyecto.

El informe `.agentic-core/quality/mutation.json` distingue `killed`, `survived`, `uncovered` conocido, `timeout`, `error` e `interrupted`. Solo los fallos atribuidos a las pruebas cuentan como detección. Los tres últimos estados son inconclusos; no se calcula un score ni se emite `QUALITY_OK` desde esta ejecución individual. `verify` Full reutiliza este motor con selección incremental contra las fuentes del baseline, agrega el score configurado y conserva el inventario completo en `verification.json`.

Una referencia aprobada determina el timeout solicitado por mutante: tres veces su duración, con un mínimo de 1000 ms, limitado por `limits.operation.commandTimeoutMs` y el presupuesto restante de la tarea. El informe muestra el límite efectivo y conserva resultados parciales cuando se agota el presupuesto. La ejecución usa un worker, dentro del máximo configurado, y reutiliza una copia para todos los archivos; verifica inputs, permisos y dependencias, restaura cada mutación y retira los outputs entre pruebas. Nunca restaura archivos del proyecto original sobre cambios ajenos.

Con tarea activa se reutiliza un informe completo y concluyente únicamente si sus inputs, comando, configuración y entorno siguen vigentes. Los resultados inconclusos se vuelven a comprobar dentro del presupuesto restante. Una tarea distinta retira solo informes internos íntegros y propios.

## Actualización

### `agentic-core update`

```powershell
npx.cmd --yes github:KroxiDev/agentic-core update . --dry-run
npx.cmd --yes github:KroxiDev/agentic-core update .
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--dry-run` | — | No | No |
| `--force` | — | No | No |

En el esquema 3, `update` actualiza transaccionalmente los recursos Codex de Light, el bloque gestionado, el runtime y las herramientas privadas cuando su ownership es demostrable, y migra esquemas 1 y 2. `--dry-run` muestra el plan sin escribir; `--force` autoriza reemplazar recursos propios divergentes. La configuración válida conserva sus valores y se normaliza al esquema cerrado 3.

`update` comprueba ownership e integridad antes de reemplazar recursos de forma transaccional. `--force` solo autoriza reemplazar recursos propios divergentes; no autoriza cambios ajenos. Al migrar una instalación anterior, elimina el runtime de protocolo que todavía sea reconociblemente propio, instala la política semántica y conserva `.agentic-core/runs` como estado legacy sin interpretarlo ni reclamarlo como estado vigente.

## Diagnóstico

### `agentic-core doctor`

```powershell
npx.cmd --yes github:KroxiDev/agentic-core doctor .
npx.cmd --yes github:KroxiDev/agentic-core doctor . --dry-run
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--dry-run` | — | No | No |

En el esquema 3, `doctor` explica configuración, límites, intérpretes y versiones, y comprueba la integridad del runtime, los recursos Codex de Light y las herramientas sin ejecutar la suite del consumidor. Los problemas se reportan con causa y recuperación sugerida; la operación no repara automáticamente ni presenta una instalación incompleta como satisfactoria.

En el esquema 2, `doctor` valida recursos, bloques gestionados, configuración, runtime autocontenido, ownership, hashes e integridad de `QualitySession`. Las sesiones o recibos corruptos se reportan y preservan; no se reescribe evidencia histórica. Los directorios operativos del runtime anterior se informan como estado legacy preservado.

## Desinstalación

### `agentic-core uninstall`

```powershell
npx.cmd --yes github:KroxiDev/agentic-core uninstall . --dry-run
npx.cmd --yes github:KroxiDev/agentic-core uninstall .
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--dry-run` | — | No | No |
| `--force` | — | No | No |

En el esquema 3, la desinstalación muestra el plan y retira transaccionalmente solo archivos y directorios cuya integridad coincide con el manifiesto. Conserva archivos ajenos, recursos divergentes, contenido dentro de `.agentic-core/quality` y `.agentic-core/runs` legacy; tampoco elimina un directorio padre que conserve algo.

Las operaciones de mantenimiento guardan el estado esperado de cada recurso en la previsualización y vuelven a comprobarlo al aplicar. Si el proyecto cambia durante la operación, se informa el conflicto y no se presenta una restauración incompleta como exitosa.

## Formato de salida

Las instalaciones del esquema 3 usan español neutro y salida breve tanto en terminal como en pipes. El esquema 2 conserva su representación estructurada al capturar la salida. `AGENTIC_CORE_OUTPUT=json` solicita JSON generado por el programa.

`prepare` y `verify` usan por defecto recibos de una línea, estables y aptos para el contexto de un agente. Con `AGENTIC_CORE_OUTPUT=json` devuelven el mismo resultado como objeto JSON; el modelo nunca redacta ni entrega un payload JSON de entrada.

## Activación explícita y modo directo

### Instalaciones nuevas (esquema 3)

El bloque instalado en `AGENTS.md` selecciona Directo para solicitudes sin activador al comienzo.
`Orquesta`, `/orquestar` y `$orquestar` reconocen Directo, Light, Normal y Full como modo
explícito inmediatamente posterior, sin distinguir mayúsculas en el modo. Sin modo explícito,
seleccionan Normal. Las menciones posteriores y los ejemplos citados no activan la orquestación.
El usuario elige el modo; la capa lo conserva sin cuestionarlo ni recomendar otro.

Directo resuelve el encargo con un único agente, conserva las Golden Rules y permite las
comprobaciones pertinentes sin imponer baseline, preparación de calidad o `QUALITY_OK`.
Por ejemplo, `Corrige esta función` y `Orquesta Directo corrige esta función` usan Directo;
`/orquestar` selecciona Normal y conserva su secuencia de cuatro roles.

Una solicitud ordinaria de documentación también es un encargo directo. La ausencia de
Documentador no añade documentación a otras tareas; puede recomendarse al cerrar el encargo.
En un flujo orquestado, “y documéntalo”, “usa un documentador” o una petición equivalente
activa el perfil instalado `agentic-docs`. Actúa después del Tester en Light, del Evaluador
en Normal o del Arquitecto en Full, una vez cerradas las correcciones y sobre el resultado
técnico definitivo. Agrega un rol a la secuencia base y es siempre el último subagente.
El coordinador comprueba su entrega sin otro Evaluador. El tamaño del cambio, sugerencias
de otros roles, reglas generales de documentación y exportar calidad no lo activan.

Light ejecuta Implementador → Tester con los perfiles instalados, un contador compartido y hasta
dos rondas adicionales; Normal conserva su secuencia documentada y Full ejecuta sus seis roles con el mismo límite.
El gate local de calidad exige `prepare` antes de editar y `verify` antes de completar; en Light Mutation
Testing es `not_applicable`. No se ejecuta el flujo del esquema 2 como sustituto. Esta selección
vive en la superficie nativa de Codex y no incorpora otro proveedor ni un protocolo externo.
La verificación de archivos instalados no acredita por sí sola el comportamiento en Codex real;
la validación nativa debe distinguir evidencia del host, simulación y restricciones semánticas.

### Instalaciones anteriores (esquema 2)

Una solicitud que comienza con `Orquesta`, `/orquestar` o `$orquestar` debe cargar y seguir la skill instalada `.agents/skills/orquestar/SKILL.md`. `Orquesta` sin modo significa `normal`. En esta entrega, la garantía positiva vive en el bloque gestionado de `AGENTS.md`, de modo que `Orquesta normal` no se resuelve con agentes genéricos sin cargar la skill.

Una solicitud sin esos activadores se ejecuta directamente: no activa coordinación, no crea una sesión de calidad por sí sola y no crea agentes.

La coordinación mantiene como máximo un agente activo. Los roles reciben alcance y responsabilidad en prosa y devuelven resultado, bloqueantes y evidencia en prosa breve. Una respuesta ambigua se aclara semánticamente; no existe protocolo raw ni retry de formato.

## Modos y roles

| Modo | Coordinación semántica | Gate determinista |
| --- | --- | --- |
| `light` | Implementador → Tester; TDD cuando corresponda; hasta dos rondas adicionales compartidas. | `prepare` antes de editar y `verify` antes de completar; Mutation Testing `not_applicable`. |
| `normal` | Planificador → Implementador → Tester → Evaluador; hasta dos rondas adicionales compartidas; Documentador solo por petición y siempre al final. | `prepare` antes de editar y `verify` antes de completar; tests, DRY y C.R.A.P.; Mutation Testing `NO_APLICA`. |
| `full` | Especificador → Planificador → Implementador → Tester → Evaluador → Arquitecto; hasta dos rondas adicionales compartidas; Documentador solo por petición y siempre al final. | `prepare` antes de editar y `verify` antes de completar; tests, DRY, C.R.A.P. y Mutation Testing completos y vigentes. |

Documentador agrega un rol únicamente por petición expresa, después del cierre técnico y sus correcciones, siempre como último subagente.

El Implementador usa `agentic-tdd` cuando cambia comportamiento y modifica únicamente producción y tests dentro del alcance. Tester usa `agentic-tests`, solo lee producción y puede corregir únicamente tests dentro del alcance; Especificador, Planificador, Evaluador y Arquitecto solo leen producción y evidencia y no la modifican. El Documentador modifica únicamente documentación.

Estas restricciones son políticas semánticas para agentes cooperativos, no ACLs, sandboxes ni aislamiento técnico demostrado. Esta entrega instala únicamente Codex y Python/pytest; otros proveedores, lenguajes y runners están fuera de alcance. La aceptación nativa requiere observaciones del host, registradas por separado en `acceptance/windows-codex.md`.

Cada instancia recibe propósito, responsabilidades, alcance, entradas, criterios de devolución, Golden Rules y contexto pertinente. En Light, las entregas entre Implementador y Tester son prosa breve con objetivo, alcance, aceptación, decisiones condicionantes, resultado, defectos y referencias; no incluyen la conversación completa, reportes completos ni JSON. Un rechazo agrupa los defectos y crea una nueva instancia de Implementador seguida de un nuevo Tester, con dos rondas adicionales como límite compartido. El Tester puede corregir tests dentro del alcance, pero nunca producción.

La máquina semántica de Light tiene una ronda inicial `Implementador → Tester`; cada rechazo abre una única ronda adicional y conserva el contador al cambiar de rol. Al alcanzar dos rondas adicionales, la tarea queda pendiente con sus causas, sin aprobación ni cambio automático de modo.

Las esperas atienden resultados, intervenciones del usuario y vencimientos mediante eventos disponibles en Codex, renovables hasta 60 segundos. Tras 5 minutos sin novedades se comprueba activamente el estado; la lentitud o el silencio por sí solos no reinician trabajo. No se dejan daemon, hooks nuevos ni promesas posteriores a la sesión, y el presupuesto acumulado cuenta comprobaciones, no tiempo de agentes.

El mapping rol → perfil vive en la skill canónica instalada `.agents/skills/orquestar/SKILL.md`; las instalaciones nuevas distribuyen `agentic-read`, `agentic-production`, `agentic-tests`, `agentic-docs` y la dependencia directa `agentic-tdd`. Especificador, Planificador, Evaluador y Arquitecto usan instrucciones estables del perfil de lectura. Si alguno diverge, `doctor` informa la divergencia y `agentic-core update` puede restaurarlo transaccionalmente con ownership demostrado.

### Límites de permisos

Las operaciones marcadas requieren autorización explícita del usuario; la coordinación no las ejecuta por iniciativa propia.

| Operación | Requiere autorización explícita |
| --- | --- |
| Lectura y análisis | No |
| Edición dentro del alcance | No |
| Operaciones destructivas | Sí |
| `commit` | Sí |
| `push` | Sí |
| Publicación | Sí |
| Cambios remotos | Sí |

## QualitySession

Estas opciones pertenecen únicamente a instalaciones anteriores. Las instalaciones nuevas de esquema 3 usan el baseline de tarea documentado arriba.

### `agentic-quality prepare` — Preparar la QualitySession legacy

Después de identificar el alcance y antes de modificar producción o tests:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality prepare --mode normal --scope src --scope test
```

Salida humana:

```text
QUALITY_SESSION id=q_<id> mode=normal baseline=<sha256>
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--mode` | `<light\|normal\|full>` | Sí | No |
| `--scope` | `<path>` | Sí | Sí |

`prepare` exige un modo `light`, `normal` o `full` y al menos un scope relativo al proyecto. Los scopes pueden repetirse, ser directorios o señalar archivos todavía inexistentes. El comando:

1. Descubre el runner y ejecuta los tests reales.
2. Calcula un baseline C.R.A.P. atribuible cuando el entorno lo permite.
3. Captura como checkpoint el worktree actual, incluidos cambios preexistentes y archivos relevantes no trackeados.
4. Incluye solo código, tests, configuración de runners, configuración de calidad, manifests y lockfiles relevantes.
5. Excluye `.env`, secretos, datos personales, caches, binarios y datos operativos.
6. Publica transaccionalmente la sesión inmutable bajo `.agentic-core/quality/<sessionId>/`.

El ID depende del modo, scopes normalizados, inventario y entorno. Repetir entradas idénticas reutiliza de forma segura la misma sesión. Argumentos inválidos, entornos no soportados o un baseline de tests fallido no dejan una sesión parcial.

### `agentic-quality verify` — Verificar el resultado

Después de terminar los cambios:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality verify --session q_<id>
```

Un resultado aprobado emite únicamente un recibo corto:

```text
QUALITY_OK session=q_<id> tests=approved crap_max=5.82 mutation=not_applicable report=.agentic-core/quality/q_<id>/reports/<hash>.json sha256=<hash>
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--session` | `<id>` | Sí | No |

`verify` acepta únicamente una sesión íntegra creada por `prepare`. Detecta cambios relevantes dentro y fuera del scope, ejecuta los tests actuales, compara C.R.A.P. con el baseline y publica un reporte completo hasheado. Las reglas diferenciales son:

- un símbolo nuevo debe permanecer en `C.R.A.P. <= 7`;
- un símbolo existente cuyo baseline era `<= 7` debe permanecer en `<= 7`;
- una deuda heredada `> 7` no puede empeorar;
- un baseline no atribuible nunca se sustituye por cero.

En `full`, `verify` ejecuta Mutation Testing en snapshots aislados y comprueba que el worktree relevante no cambió y que los snapshots fueron restaurados. En `light` y `normal`, registra Mutation Testing como `not_applicable` sin ejecutarlo.

El reporte y su SHA-256 son la evidencia verificable. `reports/latest.json` identifica el único recibo vigente para el inventario actual; cualquier cambio posterior en código, tests, configuración, manifests, lockfiles o comandos del runner vuelve obsoleto el recibo anterior. `QUALITY_OK` nunca se emite si fallan tests, C.R.A.P., Mutation Testing, baseline, entorno o restauración. Ningún cambio ejecutable orquestado puede declararse completo sin un `QUALITY_OK` vigente.

Las sesiones se conservan como evidencia local y permanecen ignoradas por Git. Una sesión pasada puede eliminarse manualmente como directorio completo cuando ya no se necesita auditar su baseline o recibo; borrar solo parte de su contenido deja evidencia corrupta.

### Códigos de salida

| Código | Significado |
| --- | --- |
| `0` | Aprobado o no aplicable. |
| `1` | Gate de calidad fallido. |
| `2` | Entorno o lenguaje no soportado. |
| `3` | Baseline de tests fallido. |
| `4` | Uso, scope o sesión inválidos. |
| `5` | Fallo interno o de restauración. |

## Comandos independientes de calidad

Esta sección conserva exclusivamente la referencia del esquema 2, fuera del soporte funcional de la entrega actual. No use `--target` ni `scan` en una instalación Python de esquema 3: allí se usan `test`, `dry`, `crap`, `mutate`, `prepare --task`, `baseline`, `verify`, `explain` y `export`, con el alcance de `config.json` descrito arriba. La presencia de código legado en el payload permite mantenimiento y no anuncia soporte adicional ni historial de tareas.

Los análisis independientes anteriores se conservan y no requieren una sesión:

### `agentic-quality scan`

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality scan --target src
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--target` | `<path>` | Sí | No |

### `agentic-quality crap`

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality crap --target src
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--target` | `<path>` | Sí | No |

### `agentic-quality mutate`

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality mutate --target src
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--target` | `<path>` | Sí | No |

### `agentic-quality mutation`

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality mutation --target src
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--target` | `<path>` | Sí | No |

`mutation` es alias de `mutate`. Estos comandos aceptan exactamente un `--target`; los detalles de discovery, cobertura, inventario, snapshots, hashes, caché y runners permanecen detrás de la interfaz pública.

## Migración desde el runtime determinista anterior

La coordinación ya no ofrece `agentic-core start`, `agentic-core resume`, `agentic-core approve-mode-change` ni `agentic-core submit-handoff`. También se retiraron intención JSON, briefs y handoffs JSON, reducer de runs, `protocol_retry`, selección determinista de roles, replay y reanudación.

La pérdida de replay, reanudación y aislamiento técnico es deliberada: la coordinación actual depende de instrucciones semánticas visibles y el estado determinista se concentra en `QualitySession`. Los adapters no afirman permisos efectivos que el host no pueda demostrar. Los `runs` existentes se preservan como evidencia legacy durante update y uninstall, pero no se cargan ni se crean en instalaciones nuevas.

Se conservan `init`, `update`, `doctor`, `uninstall`, transacciones y rollback, ownership e integridad, runtime autocontenido, C.R.A.P., Mutation Testing y las skills TDD y grilling.

## Verificación de la versión

```powershell
node .agentic-core/runtime-launcher.mjs agentic-core --version
node .agentic-core/runtime-launcher.mjs agentic-quality --version
```

## Licencia

MIT. Las licencias de dependencias incluidas en el runtime se detallan en `THIRD_PARTY_NOTICES.md`.
