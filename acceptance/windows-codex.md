# Aceptación integrada de Windows y Codex — #58

Estado: **PARCIAL / NO_VERIFICADO para el cierre integral**. El recorrido instalado
de Windows tiene comprobaciones automatizadas; no sustituye la ejecución nativa
de roles. Full queda para la prueba manual del usuario. Linux pertenece a #59.
No se exige medir KPIs, benchmarks ni conveniencia de los modos.

## Identidad y reproducción

Base integrada: `6da0d92320e729b0f2dd4ae36e8792cbc565c4e3` (PR #78), con
#54–#57 cerrados. Ejecución del 2026-09-08 en Windows x64, Node 24.11.1,
Python 3.14.6 y pytest 9.1.1. La edición exacta de Windows no se pudo consultar
por permisos WMI; esta corrida no certifica por separado Windows 10 y 11,
ni todas las versiones Python a partir de 3.11.

1. `npm.cmd ci --no-audit --no-fund` construye el runtime con el lockfile.
2. `node --test test/windows-acceptance.test.js` empaqueta con `npm pack`, instala
   el tarball en un host temporal y usa el constructor compartido
   `test/support/python-project.mjs` / `test/project-builder.js` para dos
   consumidores independientes con rutas con espacios. Imprime el SHA-256 del
   tarball realmente probado. En otro sistema informa un skip, no soporte Windows.
3. `node --test test/semantic-coordination.test.js test/release-documentation.test.js`
   comprueba las superficies y sus contratos escritos; no acredita agentes.
4. `node --test --test-name-pattern="^(mutation (aggregation|score)|verification (consistency|preserves)|C.R.A.P. identity)" test/quality-python-verification.test.js`
   comprueba ocho propiedades deterministas sin ejecutar una orquestación Full.
5. `node --test --test-name-pattern="npm pack contains|both CLI entry" test/package.test.js`
   comprueba inventario exacto y entradas públicas del paquete.
6. `npm.cmd run check` y `git diff --check` comprueban sintaxis y formato.

No se ejecuta la suite global. Los temporales de la prueba automática se retiran
con el constructor compartido. Las fixtures del intento nativo se conservan
separadas para inspección; no se versionan entornos, secretos ni transcripciones.

## Evidencia nueva de integración

El recorrido de paquete comprueba:

- Ausencia de dependencia, manifest o `node_modules` de agentic-core en el
  consumidor. Su runtime sigue operando mientras el paquete de arranque está
  temporalmente inaccesible.
- Python y pytest observados, venv propio y dependencia exclusiva del consumidor;
  wrapper, preparación, cwd y argumentos con espacios; una suite sustituta que
  fallaría si se usara. La aprobación exige una fase `call` real.
- `agentic-quality --version` desde el runtime persistido. La base devolvía
  `invalid_usage` en esquema 3; el despacho de versión ahora precede a la
  selección de comandos Python.
- Baseline Light, tests/DRY/C.R.A.P. y recibo `QUALITY_OK`. Es una prueba de CLI
  y herramientas, no una orquestación Light ejecutada por agentes.
- Repetición de preparación/verificación y diagnóstico sin aumentar el contador
  externo de pytest; salida compacta por pipes y JSON sin el secreto sintético.
- Ejecución completa de los dos mutantes del corpus, ambos `killed`, con
  integridad preservada. `mutate` individual conserva salida 2 / `NO_VERIFICADO`
  y no emite un score de aprobación; esto no se convierte en aceptación Full.
- Ninguna exportación automática; exportación Markdown explícita conservada al
  empezar otra tarea, retirada del veredicto interno y nueva ejecución al
  invalidar un input pertinente.
- Previsualizaciones sin escrituras, actualización repetible y desinstalación;
  comparación de hashes del venv, código y segunda instalación, archivo ajeno
  dentro de `quality` conservado y ejecución real del consumidor tras desinstalar.

## Matriz de los 26 escenarios de #38

**Actual** significa observado en esta entrega en el nivel indicado.
**Reutilizada** identifica evidencia publicada de una entrega integrada, consultada
en esta sesión, sin fingir una nueva ejecución. **Parcial** identifica propiedades
pendientes; una referencia a una suite no implica que se haya ejecutado hoy.
Los resultados antiguos se limitan a su SHA y entorno: no certifican cambios
posteriores ni reemplazan aceptación del host.

| # | Escenario | Evidencia y nivel | Estado y límite |
| --- | --- | --- | --- |
| 1 | Modos y activación | `semantic-coordination.test.js`; intento nativo Directo abajo | Actual de contratos escritos; host NO_VERIFICADO |
| 2 | Perfiles efectivos | TOML instalados; PR #78; intento Codex | NO_VERIFICADO: falta selección y ejecución efectiva |
| 3 | Correcciones | Contratos de retornos en `semantic-coordination.test.js` | Parcial: sin rechazos y nuevas instancias observados en host |
| 4 | Documentación explícita y final | Contratos actuales; PR #78 | Parcial: posición y resultado tras una corrección pendientes en host |
| 5 | Espera por eventos | Contrato actual de 60 segundos / 5 minutos | Parcial: sin espera nativa observada; no se infiere de temporizadores de tests |
| 6 | Presupuesto acumulado | PR #69; `quality-task-budget.test.js`; ocho contratos actuales de agregación | Reutilizada para ejecución y reservas; actual para no aprobar agotamiento agregado |
| 7 | Instalación independiente | Recorrido del tarball con bootstrap inaccesible | Actual, CLI Windows |
| 8 | Selección de integración | Instalación Codex/Python; `python-install.test.js` en PR #78 | Actual positivo; negativos reutilizados, no ejecutados nuevamente |
| 9 | Intérprete y pytest autoritativos | Recorrido del tarball; PR #62 | Actual, Python 3.14.6 / pytest 9.1.1; otras combinaciones no certificadas aquí |
| 10 | Configuración efectiva | Diagnóstico del tarball; contratos exactos de score; PR #65/#66/#71 | Actual parcial; límites específicos de cada motor reutilizados |
| 11 | Baseline real | `quality-task-baseline.test.js`, PR #64/#68 | Reutilizada; el recorrido nuevo no crea una segunda fixture del baseline defectuoso |
| 12 | Fallos iniciales | PR #64; atribución de fallos y entorno | Reutilizada; no se inventa un baseline satisfactorio |
| 13 | Calidad incremental | Recibo y cambio de input actuales; PR #66/#67; identidad de C.R.A.P. | Actual parcial y evidencia anterior de no degradación / resoluciones DRY |
| 14 | Atribución y estados parciales | `quality-python-crap.test.js`, PR #65 | Reutilizada, cobertura cero distinta de desconocida |
| 15 | Código procedural | `quality-procedural-file.test.js`, PR #65; DRY en PR #66 | Reutilizada; no se usa ausencia de funciones como aprobación |
| 16 | Mutación completa | Dos mutantes reales del tarball; ocho contratos actuales; PR #71 | Actual del motor individual; selección, equivalentes y corpus completo de Full reutilizados, sin orquestación Full nueva |
| 17 | Mutación inconclusa | Contratos actuales de timeout/error/presupuesto; ejecuciones instaladas de PR #71 | Actual de agregación; casos reales negativos reutilizados, sin repetir timeouts costosos |
| 18 | Snapshots e inputs | Wrapper del tarball; `quality-project-inputs.test.js` / `quality-project-copy.test.js`, PR #63/#69/#70 | Actual parcial; JSON/SQL/plantillas/helper reutilizados; permisos Linux pendientes |
| 19 | Secretos y rutas | Secreto sintético omitido en diagnóstico actual; PR #63/#76 | Actual parcial; frontera ampliada de privacidad reutilizada |
| 20 | Integridad y recibos | Cambio de input, hashes y nuevo verify; contratos actuales; PR #68/#76 | Actual parcial; corrupción y concurrencia reutilizadas |
| 21 | Retención | Exportación solicitada, segunda tarea, veredicto anterior retirado | Actual, CLI Windows; sin historial |
| 22 | Independencia | Hash completo de segunda instalación y venv original conservados | Actual, dos consumidores Windows separados |
| 23 | Mantenimiento | Update/uninstall del tarball; migración/rollback en PR #78 | Actual positivo; fallos inyectados y migración reutilizados |
| 24 | Salida pública | Pipes/JSON, versión y diagnóstico actuales; PR #76 | Actual; coherencia textual no equivale a ejecución nativa |
| 25 | Plataformas | Ciclo instalado completo en Windows | Actual Windows x64; Linux NO_VERIFICADO / #59 |
| 26 | Reutilización por tarea | Contador externo, misma tarea sin ejecución, input invalidado y segunda tarea | Actual, CLI Windows |

## Reutilización y vigencia

Se consultaron las PR integradas [#62](https://github.com/KroxiDev/agentic-core/pull/62),
[#63](https://github.com/KroxiDev/agentic-core/pull/63),
[#64](https://github.com/KroxiDev/agentic-core/pull/64),
[#65](https://github.com/KroxiDev/agentic-core/pull/65),
[#66](https://github.com/KroxiDev/agentic-core/pull/66),
[#67](https://github.com/KroxiDev/agentic-core/pull/67),
[#68](https://github.com/KroxiDev/agentic-core/pull/68),
[#69](https://github.com/KroxiDev/agentic-core/pull/69),
[#70](https://github.com/KroxiDev/agentic-core/pull/70),
[#71](https://github.com/KroxiDev/agentic-core/pull/71),
[#73](https://github.com/KroxiDev/agentic-core/pull/73),
[#74](https://github.com/KroxiDev/agentic-core/pull/74),
[#76](https://github.com/KroxiDev/agentic-core/pull/76) y
[#78](https://github.com/KroxiDev/agentic-core/pull/78).
Cada una conserva SHA, comandos, resultados y limitaciones de su ejecución.

La base de #58 es el merge de #78, cuya entrega publicó 39/39 pruebas de
instalación, mantenimiento, paquete y superficies. Los módulos de calidad y las
pruebas de diagnóstico/exportación no cambiaron entre el merge de #76
(`594175a`) y esta base: sus cuatro comprobaciones instaladas conjuntas son
evidencia reutilizable de esos controles. #58 no modifica motores, configuración,
presupuesto ni mantenimiento. El único cambio de producción es el despacho de
`--version`, cubierto desde el paquete; el helper mantiene su instalador original
por defecto y permite seleccionar el del tarball.

Las PR anteriores a esa integración son antecedentes de comportamiento,
no una certificación global del SHA actual. En particular, los resultados
incompletos de suites globales en #67/#69/#70 no se convierten en pases globales,
y la aceptación nativa pendiente en #78 continúa pendiente aquí.

## Host Codex y continuación manual

Codex CLI **0.153.4** respondió `DISPONIBLE` a un sondeo efímero de solo lectura.
La primera inicialización restringida falló con `Access is denied`; el sondeo
pudo iniciar fuera de ese sandbox. Esto acredita únicamente disponibilidad.

En un consumidor temporal se intentó Directo con `codex exec --ephemeral
--ignore-user-config --json --sandbox workspace-write --skip-git-repo-check -C
<consumidor>`. El encargo pedía una sola aserción para `classify(-1)` y el comando
autoritativo, sin editar producción ni documentación. El host rechazó por política
la lectura y `node .agentic-core/runtime-launcher.mjs agentic-quality test`.
El agente informó sesión de solo lectura, ningún archivo modificado y ninguna
prueba ejecutada. No se infiere aprobación de su salida 0 ni del mensaje final.
Identificador de sondeo de disponibilidad: `01a080aa-b11f-7ea0-9b3b-bd325c52eb85`.
Intento Directo: `01a080ac-b4e9-7583-9258-cbe66a30f486`.
Los registros crudos permanecen locales por privacidad.

Light y Normal no se ejecutaron después de este bloqueo común. Full no se
ejecutó por instrucción del usuario. No se eludió la política ni se sustituyeron
los perfiles por agentes genéricos. La [documentación oficial de subagentes](https://learn.chatgpt.com/docs/agent-configuration/subagents)
describe perfiles TOML en `.codex/agents/`; esa compatibilidad documental no
demuestra su selección en esta sesión.

1. Repetir Directo en un host autorizado que pueda leer y modificar el consumidor;
   observar el cambio acotado, ejecución real y ausencia de subagentes/baseline impuesto.
2. Continuar Light y Normal con el procedimiento de `adapters/manual-validation.md`:
   perfiles efectivos, secuencias exactas, retornos, contador compartido, espera y
   Documentador explícito final; añadir Normal por defecto sin modo explícito.
3. El usuario ejecutará Full manualmente, incluidas devoluciones de Evaluador y
   Arquitecto y el máximo de dos rondas adicionales. Registrar también la tarea
   corregida antes de Documentador y el caso sin activación documental.
4. Vincular evidencia nueva al paquete/runtime y estado probados. Si cambian
   inputs o implementación pertinente, renovar solo lo afectado. No cerrar #58
   ni anunciar los 26 escenarios aprobados mientras falte evidencia obligatoria.

## Resultado de esta entrega

Resultado final: **28/28 pruebas seleccionadas aprobadas, sin omisiones**:
1 recorrido integrado (97,1 s), 17 de superficies (0,8 s), 8 de contratos
deterministas (0,1 s) y 2 de paquete (24,1 s). Build, sintaxis y `git diff --check`
satisfactorios. SHA-256 del tarball del recorrido final:
`a2b75035100a0ae2e9cb3d4a9091b4d64d7f82b53c4e167cf07f94cf5f4e9b7f`.
Las ejecuciones preliminares corrigieron dos errores del test nuevo: crear
`quality` antes del archivo ajeno y respetar la salida 2 del `mutate` individual.
No se modificó el motor para ocultarlos. La regresión pública de versión se
reprodujo en la base y pasó desde el paquete corregido.

Los resultados se registran también en la PR vinculada a #58. La PR permanece borrador mientras falte la
aceptación nativa; no se hace merge ni se cierra el issue automáticamente.
Linux conserva su aceptación independiente en [#59](https://github.com/KroxiDev/agentic-core/issues/59).
