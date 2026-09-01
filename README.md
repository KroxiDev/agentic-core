# agentic-core 0.2.0

`@kroxidev/agentic-core` instala coordinación semántica explícita para Codex y Claude Code y un módulo determinista `QualitySession` para tests, C.R.A.P. diferencial y Mutation Testing. La coordinación se expresa como instrucciones breves; no es un reducer ni una frontera de seguridad del host.

## Requisitos y soporte

- Node.js 20 o posterior.
- Windows 10 y Windows 11 son las únicas plataformas con soporte oficial inicial.
- JavaScript, TypeScript y Python son los lenguajes soportados por los motores de calidad.
- Python solo es necesario al analizar proyectos Python. `coverage.py` es opcional: sin cobertura atribuible, C.R.A.P. no inventa un baseline cero.
- CodeGraph y Engram son integraciones opcionales de descubrimiento y memoria; no son requisitos del runtime.

## Instalación

Desde la raíz del proyecto destino:

```powershell
npx.cmd --yes github:KroxiDev/agentic-core init . --yes --dry-run
npx.cmd --yes github:KroxiDev/agentic-core init . --yes
```

La invocación resuelve una revisión de `KroxiDev/agentic-core`, valida el runtime y persiste un conjunto autocontenido bajo `.agentic-core/runtime`. El runtime final no conserva `_npx`, `node_modules`, `package.json` ni lockfiles del entorno efímero. Su manifiesto registra el inventario final, hashes por archivo y `treeSha256`; no necesita que el paquete esté publicado en npm.

La instalación añade recursos gestionados para ambos hosts, un bloque breve en `AGENTS.md` y `CLAUDE.md`, y declara `.agentic-core/quality` como directorio propio generado. Una instalación nueva no crea `.agentic-core/runs`.

## Actualización

```powershell
npx.cmd --yes github:KroxiDev/agentic-core update . --dry-run
npx.cmd --yes github:KroxiDev/agentic-core update .
```

`update` comprueba ownership e integridad antes de reemplazar recursos de forma transaccional. `--force` solo autoriza reemplazar recursos propios divergentes; no autoriza cambios ajenos. Al migrar una instalación anterior, elimina el runtime de protocolo que todavía sea reconociblemente propio, instala la política semántica y conserva `.agentic-core/runs` como estado legacy sin interpretarlo ni reclamarlo como estado vigente.

## Diagnóstico

```powershell
npx.cmd --yes github:KroxiDev/agentic-core doctor .
npx.cmd --yes github:KroxiDev/agentic-core doctor . --dry-run
npx.cmd --yes github:KroxiDev/agentic-core doctor . --repair
```

`doctor` valida recursos, bloques gestionados, configuración, runtime autocontenido, ownership, hashes e integridad de `QualitySession`. Las sesiones o recibos corruptos se reportan y preservan; no se reescribe evidencia histórica. Los directorios operativos del runtime anterior se informan como estado legacy preservado.

## Desinstalación

```powershell
npx.cmd --yes github:KroxiDev/agentic-core uninstall . --dry-run
npx.cmd --yes github:KroxiDev/agentic-core uninstall .
```

La desinstalación retira transaccionalmente los recursos propios no divergentes y `.agentic-core/quality`. Conserva archivos ajenos, recursos divergentes no autorizados y `.agentic-core/runs` legacy para revisión manual.

## Formato de salida

Los comandos de mantenimiento conservan su salida humana en terminal y su representación estructurada cuando se capturan. `AGENTIC_CORE_OUTPUT=json` solicita JSON generado por el programa.

`prepare` y `verify` usan por defecto recibos de una línea, estables y aptos para el contexto de un agente. Con `AGENTIC_CORE_OUTPUT=json` devuelven el mismo resultado como objeto JSON; el modelo nunca redacta ni entrega un payload JSON de entrada.

## Activación explícita y modo directo

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

Estas restricciones son políticas semánticas para agentes cooperativos, no ACLs, sandboxes ni aislamiento técnico demostrado. Los adapters Codex y Claude traducen discovery y formato nativos, pero comparten la misma política. Operaciones destructivas, commit, push, publicación y cambios remotos requieren autorización explícita.

## QualitySession

### Preparar el baseline

Después de identificar el alcance y antes de modificar producción o tests:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality prepare --mode normal --scope src --scope test
```

Salida humana:

```text
QUALITY_SESSION id=q_<id> mode=normal baseline=<sha256>
```

`prepare` exige un modo `light`, `normal` o `full` y al menos un scope relativo al proyecto. Los scopes pueden repetirse, ser directorios o señalar archivos todavía inexistentes. El comando:

1. Descubre el runner y ejecuta los tests reales.
2. Calcula un baseline C.R.A.P. atribuible cuando el entorno lo permite.
3. Captura como checkpoint el worktree actual, incluidos cambios preexistentes y archivos relevantes no trackeados.
4. Incluye solo código, tests, configuración de runners, configuración de calidad, manifests y lockfiles relevantes.
5. Excluye `.env`, secretos, datos personales, caches, binarios y datos operativos.
6. Publica transaccionalmente la sesión inmutable bajo `.agentic-core/quality/<sessionId>/`.

El ID depende del modo, scopes normalizados, inventario y entorno. Repetir entradas idénticas reutiliza de forma segura la misma sesión. Argumentos inválidos, entornos no soportados o un baseline de tests fallido no dejan una sesión parcial.

### Verificar el resultado

Después de terminar los cambios:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality verify --session q_<id>
```

Un resultado aprobado emite únicamente un recibo corto:

```text
QUALITY_OK session=q_<id> tests=approved crap_max=5.82 mutation=not_applicable report=.agentic-core/quality/q_<id>/reports/<hash>.json sha256=<hash>
```

`verify` acepta únicamente una sesión íntegra creada por `prepare`. Detecta cambios relevantes dentro y fuera del scope, ejecuta los tests actuales, compara C.R.A.P. con el baseline y publica un reporte completo hasheado. Las reglas diferenciales son:

- un símbolo nuevo debe permanecer en `C.R.A.P. <= 7`;
- un símbolo existente cuyo baseline era `<= 7` debe permanecer en `<= 7`;
- una deuda heredada `> 7` no puede empeorar;
- un baseline no atribuible nunca se sustituye por cero.

En `full`, `verify` ejecuta Mutation Testing en snapshots aislados y comprueba que el worktree relevante no cambió y que los snapshots fueron restaurados. En `light` y `normal`, registra Mutation Testing como `not_applicable` sin ejecutarlo.

El reporte y su SHA-256 son la evidencia verificable. `reports/latest.json` identifica el único recibo vigente para el inventario actual; cualquier cambio posterior en código, tests, configuración, manifests, lockfiles o comandos del runner vuelve obsoleto el recibo anterior. `QUALITY_OK` nunca se emite si fallan tests, C.R.A.P., Mutation Testing, baseline, entorno o restauración. Ningún cambio ejecutable orquestado puede declararse completo sin un `QUALITY_OK` vigente.

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

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality scan --target src
node .agentic-core/runtime-launcher.mjs agentic-quality crap --target src
node .agentic-core/runtime-launcher.mjs agentic-quality mutate --target src
node .agentic-core/runtime-launcher.mjs agentic-quality mutation --target src
```

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
