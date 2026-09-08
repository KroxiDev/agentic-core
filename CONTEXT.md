# Trabajo asistido y calidad

Lenguaje de agentic-core para distinguir la coordinación del trabajo, los controles elegidos y la evidencia que permite evaluarlo.

## Lenguaje

**Modo**: Forma de coordinar una tarea: Directo, Light o Normal. La elección de controles es independiente del modo.
_Evitar_: nivel de calidad.

**Orquestación**: Coordinación de los roles de una tarea según la secuencia y las responsabilidades del modo elegido. Es independiente de la selección de controles opcionales.

**Directo**: Modo en el que un único agente resuelve el encargo.

**Light**: Modo con Implementador y Tester, en ese orden.

**Normal**: Modo con Planificador, Implementador, Tester y Evaluador, en ese orden.

**Full**: Modo histórico retirado del producto activo y conservado como archivo recuperable.

**Tarea**: Encargo con objetivo y alcance propios, que conserva su identidad durante las correcciones.

**Test funcional de tarea**: Comprobación del comportamiento requerido por el encargo. Su aprobación no equivale a la aprobación de un control opcional.

**Control opcional**: Comprobación DRY, C.R.A.P. o de mutación elegida expresamente para una tarea o ejecución.
_Evitar_: obligación del modo.

**DRY**: Control de duplicación que identifica candidatos y sus resoluciones dentro del alcance elegido.

**C.R.A.P.**: Control que combina complejidad y cobertura para evaluar el riesgo del código medido.

**Mutación**: Control de eficacia de los tests frente a alteraciones del código; distingue mutantes detectados, supervivientes y resultados inconclusos.

**Alcance de código**: Archivos o carpetas sobre los que se mide el control.

**Selección de tests**: Pruebas elegidas para una ejecución. Es distinta del alcance del código medido.

**Referencia inicial**: Estado real conservado antes de implementar el encargo, incluidos los cambios que ya existían.
_Evitar_: estado actual como inicio, última aprobación.

**Delta de tarea**: Diferencia entre la referencia inicial y el estado que se evalúa.

**Análisis independiente**: Evaluación del estado actual del alcance elegido, sin afirmar cómo cambió durante una implementación.

**Comparación de implementación**: Evaluación del resultado frente a la referencia inicial para distinguir deuda previa de problemas nuevos o empeorados.

**Deuda preexistente**: Problema presente al inicio del encargo. Su existencia sin empeoramiento es contexto de la comparación.

**Evidencia vigente**: Resultado comprobable que corresponde a los inputs, selección y condiciones de la evaluación actual.
_Evitar_: último resultado como sinónimo de resultado vigente.

**Veredicto**: Conclusión de una evaluación sobre el alcance solicitado, sustentada en la evidencia disponible y sus límites. Puede expresar aprobación, rechazo o imposibilidad de verificar.
_Evitar_: recibo de calidad como sinónimo de la conclusión.

**Recibo de calidad**: Constancia de una verificación asociada a su tarea, alcance y evidencia.

**NO_SOLICITADO**: Control que no forma parte de la evaluación pedida; no significa aprobado.

**NO_APLICA**: Control evaluado para el que no existen elementos exigibles; no implica una puntuación perfecta.

**NO_VERIFICADO**: Evaluación sin evidencia suficiente o vigente para sostener una conclusión.

**Consumidor**: Proyecto que recibe la instalación de agentic-core para su propio trabajo.

**Documentador**: Rol adicional solicitado expresamente para documentar el resultado técnico definitivo.
