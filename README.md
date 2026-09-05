# agentic-core 0.2.0

`@kroxidev/agentic-core` instala una capa autónoma para Codex y una unidad Python 3.11+ (esquema 3), con runtime y herramientas privados. Directo aplica las Golden Rules y las comprobaciones pertinentes del encargo. La verificación de calidad y las secuencias Light, Normal y Full del rediseño #38 están pendientes de integración; esta instalación no emite `QUALITY_OK`. Las secciones de coordinación y `QualitySession` del esquema 2 se conservan para instalaciones anteriores.

## Requisitos y soporte

- Node.js 20 o posterior.
- Las instalaciones nuevas admiten solo Codex y Python 3.11 o superior; el runner declarado es pytest.
- Las herramientas privadas son dry4python 0.1.0, crap4py 0.1.1 y mutate4py 0.1.4. La versión efectiva se comprueba; no se garantiza toda sintaxis futura.
- CodeGraph y Engram son integraciones opcionales de descubrimiento y memoria; no son requisitos del runtime.

| Plataforma | Nivel de soporte |
| --- | --- |
| Windows 10 | Oficial |
| Windows 11 | Oficial |

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

La integración añade únicamente un bloque de Codex a `AGENTS.md`, conserva su contenido previo y la política canónica en `.agentic-core/golden-rules.md`. El ignore local excluye `/quality/` y `/tools/`.

## Baseline de tarea Python (esquema 3)

Antes de editar en Light, Normal o Full, prepare el estado real del worktree con el alcance e inputs de `config.json`:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality prepare --task arreglo-43 --mode normal --objective issue:43 --repair-test tests/test_subject.py
node .agentic-core/runtime-launcher.mjs agentic-quality baseline
node .agentic-core/runtime-launcher.mjs agentic-quality verify
```

`--repair-test` es opcional y repetible: identifica archivos de pruebas cuyos fallos iniciales pertenecen al encargo. Los demás fallos se informan como ajenos y no amplían el alcance. El baseline conserva código, inputs no versionados, cobertura y evidencia de fallos sin usar el diff contra HEAD para atribuir autoría. Los fallos de comprobación y los defectos atribuibles al código medido pueden conservarse como baseline fallido válido aunque se detecten en fixtures; los errores de entorno, integridad o preparación sin esa evidencia producen `NO_VERIFICADO`.

La referencia breve `.agentic-core/quality/active-task.json` contiene el objetivo, alcance e inicio inmutable de la tarea. Repetir `prepare` conserva ese inicio, incluso después de cambios; `baseline` compara inputs y condiciones actuales sin ejecutar pytest. Un cambio de pruebas, comando, configuración, runtime, dependencias o recursos vuelve obsoleta la evidencia afectada. `verify` exige la suite final aprobada; los controles agregados posteriores siguen pendientes y todavía no emite `QUALITY_OK`. Directo puede usar `test` sin preparar una tarea. Una tarea distinta no reemplaza automáticamente la evidencia activa.

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

En el esquema 3, actualizar, migrar y desinstalar quedan pendientes de #57; los comandos informan esa limitación sin modificar archivos. El resto de esta sección describe el esquema 2.

`update` comprueba ownership e integridad antes de reemplazar recursos de forma transaccional. `--force` solo autoriza reemplazar recursos propios divergentes; no autoriza cambios ajenos. Al migrar una instalación anterior, elimina el runtime de protocolo que todavía sea reconociblemente propio, instala la política semántica y conserva `.agentic-core/runs` como estado legacy sin interpretarlo ni reclamarlo como estado vigente.

## Diagnóstico

### `agentic-core doctor`

```powershell
npx.cmd --yes github:KroxiDev/agentic-core doctor .
npx.cmd --yes github:KroxiDev/agentic-core doctor . --dry-run
npx.cmd --yes github:KroxiDev/agentic-core doctor . --repair
```

#### Esquema CLI

| Opción | Valor | Requerida | Repetible |
| --- | --- | --- | --- |
| `--dry-run` | — | No | No |
| `--repair` | — | No | No |

En el esquema 3, `doctor` explica configuración, límites, intérpretes y versiones, y comprueba la integridad del runtime y las herramientas sin ejecutar la suite del consumidor. `--repair` queda reservado al esquema 2.

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

En el esquema 2, la desinstalación retira transaccionalmente los recursos propios no divergentes y `.agentic-core/quality`. Conserva archivos ajenos, recursos divergentes no autorizados y `.agentic-core/runs` legacy para revisión manual.

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
`/orquestar` selecciona Normal y comunica que su secuencia sigue pendiente.

Una solicitud ordinaria de documentación también es un encargo directo. La ausencia de
Documentador no añade documentación a otras tareas; puede recomendarse al cerrar el encargo.
En un flujo orquestado, Documentador requiere petición expresa y actúa siempre al final.

Light, Normal y Full se reconocen, pero sus secuencias y verificaciones quedan pendientes
de #51, #52 y #53. No se ejecuta el flujo del esquema 2 como sustituto. Esta selección vive
en la superficie nativa de Codex y no incorpora otro proveedor ni un protocolo externo.
La verificación de archivos instalados no acredita por sí sola el comportamiento en Codex real.

### Instalaciones anteriores (esquema 2)

Una solicitud que comienza con `Orquesta`, `/orquestar` o `$orquestar` debe cargar y seguir la skill instalada `.agents/skills/orquestar/SKILL.md`. `Orquesta` sin modo significa `normal`. Esta garantía positiva vive en los bloques gestionados de `AGENTS.md` y `CLAUDE.md`, de modo que `Orquesta normal` no se resuelve con agentes genéricos sin cargar la skill.

Una solicitud sin esos activadores se ejecuta directamente: no activa coordinación, no crea una sesión de calidad por sí sola y no crea agentes.

La coordinación mantiene como máximo un agente activo. Los roles reciben alcance y responsabilidad en prosa y devuelven resultado, bloqueantes y evidencia en prosa breve. Una respuesta ambigua se aclara semánticamente; no existe protocolo raw ni retry de formato.

## Modos y roles

| Modo | Coordinación semántica | Gate determinista |
| --- | --- | --- |
| `light` | Implementador; TDD cuando corresponda. | `prepare` antes de editar y `verify` antes de completar; Mutation Testing `not_applicable`. |
| `normal` | Plan breve; Planificador solo ante una decisión HOW material; Implementador; Verificador independiente; máximo dos ciclos de corrección; Documentador solo si corresponde. | `prepare` antes de editar y `verify` antes de completar; Mutation Testing `not_applicable`. |
| `full` | Planificador con exploración; Implementador; Evaluador independiente; máximo dos ciclos de corrección; Documentador solo si corresponde. | `prepare` antes de editar y `verify` antes de completar; C.R.A.P. y Mutation Testing obligatorios. |

El Implementador usa `agentic-tdd` cuando cambia comportamiento y modifica únicamente producción y tests dentro del alcance. Planificador, Verificador y Evaluador solo leen producción y no la modifican. El Documentador modifica únicamente documentación.

Estas restricciones son políticas semánticas para agentes cooperativos, no ACLs, sandboxes ni aislamiento técnico demostrado. Los adapters Codex y Claude traducen discovery y formato nativos, pero comparten la misma política.

El mapping rol → perfil vive en la skill canónica `.agents/skills/orquestar/SKILL.md`; el shim de discovery de Claude solo remite a ella. Si el paquete en ejecución contiene una revisión distinta de ese recurso instalado, `doctor` informa la divergencia hasta que `agentic-core update` instala transaccionalmente la revisión del paquete. El perfil `agentic-docs` mantiene “solo documentación” como instrucción semántica, pero todavía no impone una restricción técnica de escritura por ruta; reforzar ese límite queda pendiente.

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

### `agentic-quality prepare` — Preparar el baseline

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

Los análisis independientes se conservan y no requieren una sesión:

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
