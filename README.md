# agentic-core 0.1.0

`@kroxidev/agentic-core` instala orquestación explícita y determinista para Codex y Claude Code, junto con controles independientes de C.R.A.P. y Mutation Testing para JavaScript, TypeScript y Python.

## Requisitos y soporte

- Node.js 20 o superior.
- Git accesible para npm y acceso de red a GitHub durante instalación y actualización.
- Windows 10 y Windows 11 son las únicas plataformas con soporte oficial en `0.1.0`.
- Python 3.10 o superior solo es necesario cuando el proyecto contiene objetivos Python. `coverage.py` es opcional; si no está disponible se usa el tracer de la biblioteca estándar.
- CodeGraph y Engram son integraciones opcionales. No participan en preflight, contratos, estado, aceptación ni recuperación.
- No se declara soporte oficial para otros sistemas o lenguajes, ni mejoras de rendimiento sin mediciones.

## Formato de salida

Cuando `stdout` está conectado a una terminal interactiva, todos los comandos operativos presentan la información en secciones breves y consistentes: una cabecera propia del comando —por ejemplo `PLAN (sin escrituras)`, `ACCIONES`, `DIAGNÓSTICO`, `RESULTADO` o `ANÁLISIS DE CALIDAD`— seguida por `LISTO`, `ADVERTENCIAS` y `ACCIONES MANUALES PENDIENTES`. Los conflictos, divergencias, ejecuciones disponibles y hallazgos aparecen en secciones adicionales solo cuando existen.

```text
PLAN (sin escrituras)

- copiar: .agentic-core/config.json
- actualizar: AGENTS.md
- persistir runtime: .agentic-core/runtime

LISTO

- Plan completo calculado sin escrituras.

ADVERTENCIAS

- Ninguna.

ACCIONES MANUALES PENDIENTES

- Ninguna.
```

El cambio es únicamente de presentación. Códigos de salida, transacciones, archivos, hashes y estados mantienen sus contratos. Cuando la salida se captura, canaliza o redirige, se conserva la representación anterior consumible por herramientas: JSON para previews de `init`/`update`, `doctor`, los seams de orquestación y los reportes de calidad; `uninstall` conserva sus líneas contractuales. El launcher gestionado fuerza además esa salida estructurada para la skill, incluso si el host ejecuta sus seams dentro de una PTY. `--help` y `--version` mantienen su formato convencional.

## Instalación

En PowerShell, desde la raíz del proyecto, previsualiza primero la instalación:

```powershell
npx.cmd --yes github:KroxiDev/agentic-core init . --yes --dry-run
```

Si el plan es correcto, instala con una sola invocación:

```powershell
npx.cmd --yes github:KroxiDev/agentic-core init . --yes
```

`init --dry-run` presenta el plan legible en una terminal y conserva el plan JSON completo al capturarlo —recursos, conflictos, bloques gestionados, manifiesto y runtime— sin crear archivos, directorios, dependencias ni estado. La ejecución real instala configuración, Golden Rules, perfiles nativos y skills para ambos hosts, y añade un bloque gestionado a `AGENTS.md` y `CLAUDE.md`. Un conflicto aislado requiere `--replace-conflicts`; una instalación completa ajena o un límite ambiguo siempre detienen la operación.

La invocación resuelve una revisión de `KroxiDev/agentic-core` una sola vez, valida su origen, versión y commit, y ensambla directamente `.agentic-core/runtime` desde el artefacto de producción y los recursos dinámicos empaquetados. No persiste el entorno efímero de npm: el runtime final no contiene `_npx`, `node_modules`, `package.json` ni lockfile. Su manifiesto mínimo registra versión, origen, commit, inventario, hashes por archivo y hash del árbol; la skill usa `.agentic-core/runtime-launcher.mjs` para mantener disponibles los seams `agentic-core` y `agentic-quality` después de que finaliza `npx`.

El tarball incluye el artefacto ya construido. Una instalación directa desde GitHub ejecuta `prepare` antes del bootstrap y usa `esbuild`, fijado como dependencia de desarrollo, para producir el mismo payload; `init` nunca construye ni descarga calidad de forma diferida. `agentic-core` no necesita estar publicado en npm.

El bootstrap no instala comandos globales ni modifica `PATH`: los comandos de la skill pasan por el launcher gestionado. La operación es transaccional y restaura el árbol previo ante un fallo; el cache efímero de `npx` queda fuera del proyecto y continúa bajo gestión de npm.

## Actualización

Previsualiza la revisión GitHub y todos los recursos que cambiarían:

```powershell
npx.cmd --yes github:KroxiDev/agentic-core update . --dry-run
```

Aplica la actualización con una sola invocación:

```powershell
npx.cmd --yes github:KroxiDev/agentic-core update .
```

Cada invocación fija una sola revisión GitHub. El preview no modifica configuración, recursos, manifiestos, dependencias, package.json, lockfiles ni runs. La ejecución real conserva una configuración válida, completa claves nuevas y reemplaza transaccionalmente tanto los recursos como el runtime persistido con la revisión resuelta por esa misma invocación. Si un recurso propio diverge, enumera el conflicto y exige añadir `--force`; no reemplaza instalaciones ajenas. Las ejecuciones persistidas incompatibles con el grafo instalado se eliminan sin migración silenciosa.

## Diagnóstico

```powershell
npx.cmd --yes github:KroxiDev/agentic-core doctor .
npx.cmd --yes github:KroxiDev/agentic-core doctor . --dry-run
npx.cmd --yes github:KroxiDev/agentic-core doctor . --repair
npx.cmd --yes github:KroxiDev/agentic-core doctor . --repair --dry-run
```

`doctor` presenta un diagnóstico accionable por secciones en una terminal y conserva el reporte JSON completo cuando la salida se captura. Incluye manifiesto, hashes, configuración, bloques gestionados, adapters, runtimes requeridos, runs incompletos, workers, transacciones y backends de calidad. `doctor --dry-run` calcula el mismo plan que `--repair --dry-run` sin escribir; conserva un código de salida no cero mientras existan errores. `--repair` actúa únicamente cuando la propiedad y la forma esperada del recurso son demostrables, y aplica toda reparación en una transacción. No repara archivos ajenos, no reemplaza un runtime divergente ni retira otra capa.

## Desinstalación

Previsualiza primero el alcance:

```powershell
npx.cmd --yes github:KroxiDev/agentic-core uninstall . --dry-run
npx.cmd --yes github:KroxiDev/agentic-core uninstall .
```

El preview enumera exactamente lo que retiraría y no modifica el proyecto. La desinstalación real elimina recursos registrados, el runtime persistido cuyo hash coincide, estado operativo y directorios propios que queden vacíos. Conserva archivos desconocidos, otras skills, otros adapters, texto exterior a los bloques gestionados y recursos propios divergentes sin autorización. `--force` autoriza retirar únicamente divergencias que el manifiesto demuestra como propias.

## Activación explícita y modo directo

La orquestación solo se activa cuando la solicitud comienza exactamente con `Orquesta`, `/orquestar` o `$orquestar`.

```text
Orquesta light corrige el cálculo y conserva la API
Orquesta corrige el cálculo y conserva la API
Orquesta normal corrige el cálculo y conserva la API
Orquesta full corrige el cálculo y conserva la API
```

El nombre del modo debe estar delimitado por espacio: `Orquesta light tarea` selecciona `light`; `Orquesta light. tarea` no reconoce `light.` como modo y usa el `defaultMode` configurado.

`Orquesta` sin modo selecciona `normal`. `direct` no es un modo invocable. Una solicitud sin activador sigue en ejecución directa: no crea coordinador, run, estado ni subagentes, y carga únicamente las Golden Rules instaladas.

## Grafos y presupuestos

| Ejecución | Grafo canónico | Ciclos de retrabajo | Mutation Testing automático |
| --- | --- | ---: | --- |
| `direct` | Sin grafo ni agentes de agentic-core | 0 | No |
| `light` | Implementador → Tester | 1; el segundo `changes_required` bloquea | No |
| `normal` | Planificador → Implementador → Verificador → Documentador | 2; el tercero bloquea | No |
| `full` | Explorador → Planificador → Implementador → Refactor → Tester → Evaluador → Documentador | 2; el tercero bloquea | Sí, únicamente en Evaluador |

Varios blockers materiales del mismo hand-off consumen un solo ciclo. Preguntas, contexto faltante, cambios de modo, reportes obsoletos y retries de protocolo no consumen retrabajo. No existe un presupuesto global adicional de duración, cantidad de agentes, gates o invocaciones.

El Documentador siempre se crea como agente nuevo en `normal` y `full`, incluso cuando concluye que no hacen falta cambios. Solo puede modificar documentación, no abre retrabajo, no cambia de modo y no invalida producción aceptada. Si falla de forma persistente después de un reintento, el run termina como `completed_with_warnings`.

## Roles y permisos

| Rol | Perfil nativo | Responsabilidad | Escritura permitida por el brief |
| --- | --- | --- | --- |
| Explorador | `agentic-read` | Delimitar sector, símbolos y dependencias sin diseñar la solución | Ninguna |
| Planificador | `agentic-read` | Producir o ajustar un plan plano sin debilitar criterios | Ninguna |
| Implementador | `agentic-production` | Establecer el HOW e implementar con TDD cuando cambia comportamiento ejecutable | Producción y tests |
| Verificador | `agentic-tests` | Verificar criterios, tests, Golden Rules, estructura y C.R.A.P. diferencial en `normal` | Tests solo si producción ya es correcta y falta evidencia; artefactos de calidad |
| Refactor | `agentic-read` | Revisar estructura y Golden Rules y ejecutar C.R.A.P. diferencial en `full` | Solo artefactos de calidad; producción es de solo lectura |
| Tester | `agentic-tests` | Validar aceptación independiente | En `light`, solo artefactos C.R.A.P.; en `full`, tests solo si producción ya es correcta y falta evidencia |
| Evaluador | `agentic-read` | Comparar autoridad original, plan, cambios y evidencia; ejecutar mutación diferencial en `full` | Solo artefactos de calidad |
| Documentador | `agentic-docs` | Decidir de forma fresca si la documentación debe cambiar | Solo documentación |

La tabla anterior es el mapeo obligatorio para ambos hosts; no se infiere otro perfil a partir de los permisos de un brief. Las capacidades del host son límites gruesos; los scopes finos del cuadro son contratos validados por el runtime, no ACLs de filesystem adversariales.

## Contratos, aislamiento y estado

- Hay como máximo un agente activo por run. Los roles son secuenciales, nuevos y reciben únicamente instrucciones de su modo.
- El coordinador es un reducer determinista: transporta referencias, valida contratos, persiste estado mínimo y deriva transiciones. No revisa código, ejecuta gates, interpreta prosa para elegir rutas, administra branches ni usa polling.
- La solicitud original se conserva textualmente e inmutable. La intención cerrada contiene `objective`, `reason`, `constraints` y `criteria`; una razón ausente se guarda como `not_specified`.
- `normal` y `full` usan un plan plano trazable. Planificador y Evaluador leen la solicitud original, no un resumen acumulado.
- Cada brief está respaldado por rutas lógicas y SHA-256, tiene un máximo configurable de 16 KiB y nunca se trunca.
- Cada hand-off es exactamente un objeto JSON UTF-8, sin Markdown, prosa, whitespace envolvente, próximo rol, razonamiento interno, prompts ni datos del coordinador. Su máximo es 32 KiB.
- El primer hand-off inválido crea un agente nuevo del mismo rol con `protocol_retry`; el segundo termina como `failed`.
- El conjunto cerrado de estados es `completed`, `completed_with_warnings`, `changes_required`, `needs_input`, `needs_mode_change`, `context_missing`, `failed` y `blocked`.

La configuración se captura al iniciar el run, por lo que una edición posterior no cambia una ejecución ya iniciada.

## Configuración

`init` crea `.agentic-core/config.json` y su schema estricto:

```json
{
  "$schema": "./config.schema.json",
  "schemaVersion": 1,
  "orchestration": {
    "explicitActivationOnly": true,
    "defaultMode": "normal",
    "briefMaxBytes": 16384,
    "handoffMaxBytes": 32768
  },
  "quality": {
    "crapThreshold": 7,
    "mutationWorkers": 4
  }
}
```

`briefMaxBytes` y `handoffMaxBytes` solo pueden reducir sus límites máximos. `mutationWorkers` acepta de 1 a 4. Las claves desconocidas son inválidas.

## Reanudación y escaladas

Para listar runs reanudables sin seleccionar uno automáticamente:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-core resume
node .agentic-core/runtime-launcher.mjs agentic-core resume --run <runId>
```

La reanudación valida schema, fuentes, rutas y hashes. Una fuente canónica divergente falla; una entrada de calidad divergente vuelve obsoleto el reporte y devuelve el run al primer gate que debe repetirse. Estados de grafos antiguos incompatibles fallan explícitamente.

Solo se permiten `light` → `normal`, `light` → `full` y `normal` → `full`. El hand-off `needs_mode_change` deja la solicitud pendiente; después de obtener aprobación explícita del usuario, la skill usa:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-core approve-mode-change --run <runId> --to <normal|full>
```

La escalada empieza en el primer rol del grafo destino, reinicia solo su presupuesto de retrabajo y conserva solicitud, intención, archivos, tests, plan, blocker accionable y reportes cuyos hashes sigan vigentes.

## Integración de host

La skill instalada conduce normalmente estos seams. Para una integración nativa, `agentic-core start` recibe por stdin o `--input` un único objeto JSON:

```json
{
  "request": "Orquesta light agrega un saludo",
  "intention": {
    "objective": "Agregar un saludo",
    "reason": "Hacer visible el estado",
    "constraints": ["Conservar la API"],
    "criteria": ["El saludo aparece en stdout"]
  },
  "changesExecutableBehavior": true,
  "planningNeedsHowDecision": false
}
```

El host debe crear el perfil que devuelve el runtime y pasarle exactamente `JSON.stringify(brief)`. Su respuesta final completa se reenvía sin inspección ni reparación:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-core start --input start.json
node .agentic-core/runtime-launcher.mjs agentic-core submit-handoff --run <runId> --input native-response.json
```

Un harness puede observar y recopilar evidencia, pero no sustituir el loop nativo ni simular agentes para una aceptación manual.

## Blockers y advisory

Un finding `blocking` es material únicamente cuando contiene todas estas condiciones:

1. Autoridad concreta: criterio, restricción, Golden Rule o gate obligatorio.
2. Alcance `changed` o `direct_dependency`.
3. Evidencia reproducible o prueba estática localizada.
4. Impacto material descrito.
5. Corrección mínima dentro del alcance.

`changes_required` exige al menos un blocker material completo; `completed` y `completed_with_warnings` los prohíben. Si falta una condición, el finding se rechaza o degrada a `advisory` y nunca cambia la transición ni consume retrabajo.

Son necesariamente advisory la extensibilidad futura no solicitada, inputs no soportados, escenarios hipotéticos sin ruta real, deuda preexistente no empeorada, preferencias de estilo, diseños alternativos, optimizaciones no medidas y problemas fuera del alcance acordado.

## Calidad

Los comandos independientes aceptan exactamente un `--run <id>` o un `--target <path>`:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality scan --target src
node .agentic-core/runtime-launcher.mjs agentic-quality crap --target src
node .agentic-core/runtime-launcher.mjs agentic-quality mutate --target src
node .agentic-core/runtime-launcher.mjs agentic-quality crap --run <runId> --output artifacts/crap.json
node .agentic-core/runtime-launcher.mjs agentic-quality mutate --run <runId> --output artifacts/mutation.json
```

`mutation` es alias de `mutate`. Los códigos de salida son 0 para aprobado/no aplicable, 1 para gate fallido, 2 para entorno o lenguaje no soportado, 3 para baseline fallido, 4 para uso/configuración inválidos y 5 para error interno o de restauración.

### C.R.A.P. diferencial

- Un símbolo nuevo debe quedar en C.R.A.P. `<= 7`.
- Un símbolo existente cuyo baseline era `<= 7` debe permanecer en `<= 7`.
- Una deuda heredada `> 7` no puede empeorar; reducirla por debajo de 7 es advisory salvo que el criterio lo exija.
- Un baseline previo no atribuible nunca se interpreta como cero ni obliga a refactorizar todo el símbolo.
- Un `--target` sin baseline mantiene una auditoría absoluta contra `quality.crapThreshold`.

La identidad estable combina archivo lógico, nombre cualificado, contenedor, tipo de declaración y desambiguador determinista. Ubicación y hash AST son versiones comparables, no parte de la identidad; cambiar solo el cuerpo conserva el ID. Los reportes enumeran código objetivo, tests descubiertos, configuración y comandos del runner, manifests y lockfiles usados para el hash de vigencia. Cualquier cambio relevante vuelve obsoleta la evidencia.

### Mutation Testing

Dentro de la orquestación, Mutation Testing es obligatorio únicamente para el Evaluador de `full`. `direct`, `light` y `normal` no lo solicitan ni lo validan. `agentic-quality mutate` sigue disponible para auditorías independientes en cualquier proyecto compatible.

Los mutantes se ejecutan en snapshots aislados y se clasifican como `killed`, `killedByTimeout`, `survived`, `uncovered` o `equivalent`. Un baseline de tests fallido invalida el análisis; un fallo de restauración conserva la ruta de evidencia.

## Verificación de la versión

Desde una instalación limpia del repositorio:

```powershell
npm.cmd ci --cache .codex-temp\npm-cache
npm.cmd run check
npm.cmd test
npm.cmd run test:python
npm.cmd pack --dry-run --json --cache .codex-temp\npm-cache
```

La suite fija el inventario exacto del tarball y excluye tests, fixtures internos, caches, estado de runs, artefactos y archivos accidentales. La aceptación nativa exige además los seis recorridos descritos en [`adapters/manual-validation.md`](adapters/manual-validation.md): `light`, `normal` y `full` tanto en Codex como en Claude Code sobre Windows 10 u 11.

## Licencia

agentic-core se distribuye bajo licencia MIT; consulta [`LICENSE`](LICENSE). Las dependencias runtime y sus licencias se enumeran en [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
