# Aceptación Linux — issue #59

El recorrido automático se ejecuta en Linux real mediante GitHub Actions.
La aceptación integral de [#59](https://github.com/KroxiDev/agentic-core/issues/59)
permanece pendiente de los perfiles efectivos en Codex: **NO_VERIFICADO**.
Full está deprecado; no se ejecuta su suite archivada. Véase [archive/full](../docs/full-archive.md).

La primera ejecución automática completa fue
[Actions 34223378372](https://github.com/KroxiDev/agentic-core/actions/runs/34223378372),
el 2026-09-08 sobre `ea96797775b8f8d0498c7622d3b2b14f57e86d91`:
un recorrido instalado, una regresión de herramientas y cinco regresiones
complementarias aprobados, sin fallos ni omisiones. Las comprobaciones del
commit actual se consultan en la [PR #81](https://github.com/KroxiDev/agentic-core/pull/81).

Contrato: decisiones D08, D09, D15, D17, D19 y D20 de
[#38](https://github.com/KroxiDev/agentic-core/issues/38).
Las dependencias #54, #55, #56 y #57 están integradas en la base
`6da0d92320e729b0f2dd4ae36e8792cbc565c4e3`.

## Entorno y reproducción

Referencia: runner `ubuntu-24.04`, x64, Node.js 22 y Python 3.11, con pytest
8.3.5, py 1.11.0 y pygments 2.19.2 para las fixtures. Se exige un usuario sin
privilegios de root. La distribución, kernel, filesystem, versiones efectivas,
commit ejecutado y hash SHA-256 del paquete quedan en `acceptance.json`.

1. Ejecutar el workflow [Aceptación Linux](../.github/workflows/linux-acceptance.yml)
   en la PR. Se comprueba el SHA de su rama, con permisos `contents: read` y
   sin persistir credenciales en el checkout. También admite ejecución manual
   mediante `workflow_dispatch` cuando el workflow esté en la rama predeterminada.
2. El trabajo instala las dependencias de prueba en el runner, ejecuta `npm ci`
   y construye el tarball con `npm pack --ignore-scripts` después del build.
   Instala dos consumidores nuevos desde ese paquete y elimina su bootstrap.
   No transfiere configuración activa, entornos, sesiones ni evidencia de Windows.
3. Consultar los artefactos `linux-acceptance-<run_id>-<attempt>`: contienen
   `acceptance.json`, el tarball y las salidas TAP. Se conservan siete días;
   descargar el paquete y la evidencia si se necesitan después. Los consumidores
   y entornos temporales no se publican.

Para reproducirlo en un clon Linux aislado, preparar las mismas versiones y
ejecutar `npm ci`, `node --test test/python-tools.test.js` y
`node --test scripts/linux-acceptance.mjs`. La selección exacta de las cinco
regresiones complementarias figura en el workflow.

## Qué comprueba la aceptación automática

1. **Instalación y autonomía:** previsualización sin escrituras, fallo inyectado
   y rollback, instalación desde tarball, Python 3.11+, identidades distintas
   entre A y B, herramientas propias y launcher funcional sin bootstrap.
2. **Inputs y calidad:** wrapper pytest autoritativo con argumentos literales
   y rutas con espacios; archivos `Case.txt` y `case.txt` distintos; helper
   invocado directamente como proceso con modo `0751`, también en las copias.
   Pruebas, DRY y C.R.A.P. aprobados mediante los comandos instalados.
3. **Mutación:** dos mutantes generados, seleccionados y detectados en el
   consumidor integrado, con restauración e integridad. El corpus existente
   adicional exige un detectado, un superviviente, un no cubierto, un timeout
   y un error. Los inconclusos conservan `NO_VERIFICADO`; la ejecución individual
   de mutación no se presenta como aprobación Full.
4. **Otra tarea:** cambia el identificador activo, retira los informes internos
   de verificación y mutación anteriores, preserva la exportación solicitada y
   los archivos ajenos, y deja B intacta. Las regresiones de exportación y
   diagnóstico verifican mediante contador que no se relanza pytest.
5. **Mantenimiento:** actualización efectiva de un perfil divergente, preview,
   rollback inyectado y restauración del perfil original. Desinstalación mediante
   el launcher instalado, retiro de runtime/herramientas/ownership y preservación
   de archivos ajenos, lockfile, entorno Python y comportamiento del consumidor.
   Se compara B antes y después y se ejecuta su suite al terminar.
6. **Regresiones acotadas:** traslado e inspección de herramientas sin cambios de
   bytes; rechazo de degradación C.R.A.P. y de duplicación DRY sin resolver;
   corpus de mutación, exportación y diagnóstico ya existentes. El workflow
   propaga los fallos a través de `tee` y exige cinco regresiones aprobadas y
   cero omisiones, para evitar aceptar una selección vacía.

La desinstalación mantiene el comportamiento conservador de #57: conserva los
directorios no vacíos cuyos archivos no tienen propiedad individual registrada,
incluido `quality` con contenido ajeno. No se promete una purga de ese directorio.
La limpieza de evidencia propia está comprobada al iniciar otra tarea.

## Correcciones del recorrido

1. CPython crea `lib64 -> lib` en Linux incluso con `--copies`, como muestra su
   [implementación de venv](https://github.com/python/cpython/blob/3.11/Lib/venv/__init__.py).
   Ese enlace impedía inventariar el entorno privado. La instalación reserva
   `lib64` como directorio real en el entorno nuevo de herramientas; conserva
   el enlace del entorno del consumidor y el rechazo general de enlaces ajenos.
2. La inspección del intérprete usa `-I -B` para no regenerar bytecode después
   del traslado. Sin `-B`, una inspección podía modificar el árbol ya inventariado
   y bloquear la actualización como `foreign_state`.

Los cambios de producción se limitan a [python.js](../src/installation/python.js).
La aceptación reutiliza [python-project.mjs](../test/support/python-project.mjs);
su opción `install: false` solo prepara la fixture antes de instalar el tarball.

## Comprobación manual pendiente

1. Instalar los mismos bytes en un consumidor Linux nuevo y abrirlo en Codex.
   Registrar versión del host y SHA del paquete; no reutilizar sesiones Windows.
2. Comprobar los perfiles efectivamente recibidos, sus capacidades y el orden
   correspondiente al modo elegido según #38. Para Full, observar Especificador,
   Planificador, Implementador, Tester, Evaluador y Arquitecto; Documentador
   únicamente si se solicita y siempre al final, conforme a #54.
3. Registrar el resultado observado y sus límites. Inspeccionar TOML o aprobar
   Actions no acredita despacho nativo ni aislamiento técnico de Codex.

Por decisión del usuario, las pruebas manuales de ejecución directa y de
orquestación Light, Normal y Full quedan a su cargo y no bloquean el merge
ni el cierre de #59. Hasta contar con esa evidencia, Linux no se anuncia
como soporte integral verificado. Esta comprobación no bloquea #58.
