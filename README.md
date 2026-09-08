# agentic-core

`@kroxidev/agentic-core` instala coordinación para Codex y herramientas de calidad Python. El modo define los roles; tú eliges los controles adicionales.

## Requisitos

- Node.js 20+ y Python 3.11+ con pytest en el entorno del proyecto.
- Codex y una unidad Python por instalación. Windows 10/11 y aceptación automática en Ubuntu 24.04; el uso nativo de los roles lo valida el usuario.
- Las herramientas privadas viajan con el runtime; no se agregan a las dependencias del consumidor.

## Instalación

Desde el proyecto consumidor, en PowerShell (`npx` en Linux):

```powershell
npx.cmd --yes github:KroxiDev/agentic-core init . --provider codex --language python
```

Puedes añadir `--dry-run` para previsualizar, `--python <intérprete>` para seleccionar Python o `--config <archivo>` para declarar la integración del proyecto. [Configuración, recursos y soporte](https://github.com/KroxiDev/agentic-core/blob/main/docs/technical-reference.md).

## Actualización

```powershell
npx.cmd --yes github:KroxiDev/agentic-core update .
```

Conserva la configuración y los archivos ajenos. `--dry-run` muestra el plan; `doctor .` diagnostica sin ejecutar la suite. [Mantenimiento y conflictos](https://github.com/KroxiDev/agentic-core/blob/main/docs/technical-reference.md#actualización).

## Desinstalación

```powershell
npx.cmd --yes github:KroxiDev/agentic-core uninstall .
```

Retira recursos propios y conserva evidencia y archivos ajenos; admite `--dry-run`. [Detalle](https://github.com/KroxiDev/agentic-core/blob/main/docs/technical-reference.md#desinstalación).

## Modos

| Modo | Forma de trabajo |
| --- | --- |
| Directo | Un agente; predeterminado sin activador. |
| Light | Implementador → Tester. |
| Normal | Planificador → Implementador → Tester → Evaluador. |

`Orquesta Light corrige esta función` elige Light. `Orquesta` sin modo elige Normal; también se aceptan `/orquestar` y `$orquestar`. Los tests funcionales pertinentes siguen siendo obligatorios. Pedir controles no cambia roles ni modo. Documentador se añade al final solo por petición explícita.

Full está deprecado: una solicitud explica el retiro y conserva la evidencia antigua sin ejecutarla ni convertirla. Su versión histórica está en [archive/full](https://github.com/KroxiDev/agentic-core/blob/main/docs/full-archive.md).

## Controles

| Control | Qué comprueba y qué ejecuta |
| --- | --- |
| DRY | Duplicación; análisis estático. |
| C.R.A.P. | Complejidad y cobertura; ejecuta los tests necesarios para medirla. |
| Mutación | Eficacia de los tests; ejecuta una referencia y los mutantes exigibles. |

Sin petición, estos controles son `NO_SOLICITADO`. Un test funcional puede aprobar sin cobertura completa; eso no acredita la cobertura requerida por C.R.A.P. o mutación.

Para analizar el estado actual sin preparar una tarea:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality dry --scope src
node .agentic-core/runtime-launcher.mjs agentic-quality crap --scope src/payments.py --test tests/test_payments.py
```

`mutate` admite la misma selección de código y tests. Los análisis informan los hallazgos actuales y no autorizan reparaciones.

Para comparar una implementación, conserva su inicio **antes de editar**:

```powershell
node .agentic-core/runtime-launcher.mjs agentic-quality prepare --task cambio-1 --mode direct --objective issue:123
# Realiza el cambio solicitado.
node .agentic-core/runtime-launcher.mjs agentic-quality verify --control dry --control crap --changes --test tests/test_payments.py
```

También puedes pedirlo conversando: «Exige DRY y C.R.A.P. en este cambio y usa tests/test_payments.py». Los problemas nuevos o empeorados bloquean; la deuda previa es contexto. Sin un inicio válido, la comparación queda `NO_VERIFICADO`.

`--scope` y `--test` aceptan archivos o carpetas y son repetibles; sin selección de tests se conserva el comando del proyecto. `--changes` usa el inicio guardado. Los flags de `verify` reemplazan el conjunto de controles de esa ejecución; `--control none` lo vacía. Cada tarea nueva comienza sin heredar controles.

[Selección, evidencia, límites y comandos](https://github.com/KroxiDev/agentic-core/blob/main/docs/technical-reference.md) · [Glosario del repositorio](https://github.com/KroxiDev/agentic-core/blob/main/CONTEXT.md). La documentación de desarrollo y el glosario no se instalan en consumidores.
