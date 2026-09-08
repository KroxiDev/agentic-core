# Aceptación Linux pendiente — issue #59

Estado al 2026-09-08: **NO_VERIFICADO**. Este documento registra el bloqueo y
el recorrido que falta ejecutar; no acredita soporte Linux.

Contrato: [#59](https://github.com/KroxiDev/agentic-core/issues/59) y decisiones
D08, D09, D15, D17, D19 y D20 de la
[especificación #38](https://github.com/KroxiDev/agentic-core/issues/38).
Las dependencias #54, #55, #56 y #57 están cerradas e integradas en la base
inspeccionada, `6da0d92320e729b0f2dd4ae36e8792cbc565c4e3`.

## Comprobaciones realizadas

La sesión disponible es Windows/PowerShell. Se consultó el host en modo de solo
lectura, fuera del sandbox, para distinguir restricciones de acceso de ausencia
de entorno:

| Comprobación | Resultado observado | Alcance de la evidencia |
| --- | --- | --- |
| `wsl --list --verbose` | Solo `docker-desktop`, `Stopped`, WSL 2 | No hay una distribución de trabajo preparada |
| `docker version --format '{{json .Server}}'` | Servidor `null`; falta el pipe `dockerDesktopLinuxEngine` | No se dispone de un motor Docker accesible |
| Entorno Linux con Codex | No disponible para esta sesión | No se ejecutaron perfiles nativos |

El primer intento de enumerar WSL dentro del sandbox devolvió
`Wsl/EnumerateDistros/Service/E_ACCESSDENIED`; la consulta fuera del sandbox
permitió obtener el inventario anterior. Ese error inicial no demuestra una
incompatibilidad del producto.

No se instalaron distribuciones ni se iniciaron servicios. No se transfirieron
entornos, configuración activa, sesiones ni evidencia de Windows. No se ejecutó
orquestación Full, reservada para la comprobación manual del usuario.

## Entorno de referencia para retomar

Referencia propuesta, **todavía no provisionada ni ejecutada**: Ubuntu 24.04 LTS,
x86_64, filesystem ext4 sensible a mayúsculas y usuario sin privilegios de root.
Registrar la distribución efectiva, kernel, filesystem, Node.js 20+, Python
3.11+, pytest, versión del paquete, SHA del código y SHA-256 del tarball al
comenzar. Si se utiliza otra referencia, declararla antes de medir.

Crear dos consumidores desechables A y B en Linux, con rutas que contengan
espacios, entornos Python separados y configuración creada allí. Mantener el
clon de construcción y el bootstrap separados de ambos consumidores. Construir
con `npm ci` y `npm pack` desde el lockfile; conservar los bytes del paquete y
su hash. Usar `npm` en Linux, no `npm.cmd`.

## Recorrido pendiente y evidencia necesaria

Todos los pasos siguientes están **NO_VERIFICADOS en Linux**. Ejecutarlos desde
el paquete distribuible y los launchers instalados. Las suites existentes son
regresiones reutilizables, no sustituyen el recorrido instalado ni Codex real.

1. **Instalación y autonomía.** Instalar A y B desde el mismo tarball mediante
   `agentic-core init`, primero con `--dry-run`, con Codex y Python explícitos.
   Comprobar que la previsualización no escribe y que los identificadores,
   herramientas privadas y entornos son independientes. Retirar únicamente el
   bootstrap descartable de A y ejecutar su launcher. Comparar manifests,
   lockfiles, intérprete, dependencias y ejecución del consumidor antes y después.
   Reutilizar [python-install.test.js](../test/python-install.test.js).
2. **Intérprete, argumentos e inputs.** Ejecutar el pytest autoritativo con su
   wrapper, configuración, directorio y argumentos literales con espacios.
   Crear `Case.txt` y `case.txt` con contenido distinto y hacer que los tests
   requieran ambos. Añadir un helper con shebang y permiso ejecutable, invocado
   directamente como proceso por los tests. Exigir su ejecución también en las
   copias de cobertura y mutación; comparar contenido y bits de permiso con el
   original. Un helper Python importado no prueba permisos de ejecución.
   Extender solo lo necesario de
   [quality-project-copy.test.js](../test/quality-project-copy.test.js) y
   [python-project.mjs](../test/support/python-project.mjs).
3. **Calidad.** Preparar una tarea antes del cambio y ejecutar pruebas, DRY y
   C.R.A.P. con controles positivos y negativos conocidos. Ejecutar mutación con
   el corpus existente y contrastar inventario completo, detectados,
   supervivientes, no cubiertos, equivalentes e inconclusos. Un timeout o error
   no cuenta como detectado; un denominador vacío no es 100 %.
   Reutilizar [quality-python-verification.test.js](../test/quality-python-verification.test.js)
   y [quality-python-mutation.test.js](../test/quality-python-mutation.test.js).
   La ejecución determinista de mutación y el despacho de roles Full son
   evidencias distintas; la orquestación Full queda para el usuario.
4. **Otra tarea y diagnóstico.** Iniciar una segunda tarea en A. Comprobar que
   se retira solo evidencia interna propia de la anterior, se preservan archivos
   ajenos y resultados exportados por petición, y B permanece intacta.
   Verificar mediante contador que el diagnóstico no relanza pytest. Reutilizar
   [quality-evidence-reuse.test.js](../test/quality-evidence-reuse.test.js),
   [quality-result-export.test.js](../test/quality-result-export.test.js) y
   [quality-diagnostics.test.js](../test/quality-diagnostics.test.js).
5. **Mantenimiento y rollback.** Actualizar A desde el paquete, comprobar la
   previsualización y ejecutar la desinstalación desde el launcher instalado.
   En fixtures descartables separadas, reutilizar la inyección de fallos
   transaccionales existente. Comparar hashes y permisos antes y después del
   rollback; ejecutar el consumidor y B después de cada operación. Conservar
   recursos desconocidos y divergentes dentro de directorios propios. Reutilizar
   [installation-maintenance.test.js](../test/installation-maintenance.test.js)
   y [transaction.test.js](../test/transaction.test.js).
6. **Codex real.** Desde una instalación Linux nueva, registrar versión del host,
   perfil efectivamente recibido por cada instancia, rol, capacidades observadas,
   orden, handoff y resultado. Contrastar los roles con #38 y #54; inspeccionar
   TOML o aprobar una suite local no acredita selección nativa ni aislamiento.
   Mantener la comprobación manual Full pendiente hasta recibir evidencia del
   usuario. No copiar sesiones ni credenciales de Windows para simular continuidad.

## Condición de cierre

Para cada paso, conservar comando, código de salida, resultado observado y
referencia verificable a evidencia sin secretos ni rutas privadas. Distinguir
ejecución instalada, regresión local, fallo inyectado y ejecución nativa de Codex.
Una prueba omitida, fixture ausente o resultado simulado queda NO_VERIFICADO.

El issue #59 permanece abierto como continuación prioritaria hasta completar el
recorrido y acreditar los perfiles en Linux. Esta limitación no bloquea #58.
Si aparecen incompatibilidades, corregir únicamente las concretas del recorrido
y añadir su regresión puntual; no ampliar a macOS, sincronización, proveedores
ni nuevas métricas generales.
