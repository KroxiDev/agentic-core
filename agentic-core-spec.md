## Enunciado del problema

Quien mantiene proyectos asistidos por agentes necesita una forma predecible, explícita y verificable de coordinar trabajo técnico sin depender de heurísticas ocultas, prompts duplicados ni estado efímero imposible de auditar. La solución debe permitir elegir el nivel de orquestación, conservar la intención original, reanudar ejecuciones interrumpidas y exigir evidencia objetiva de calidad, sin que el coordinador se convierta en otro agente que interprete o revise el trabajo.

Además, el usuario necesita instalar, actualizar, diagnosticar y retirar esta capacidad con seguridad. El producto no debe apropiarse de archivos ajenos, mezclar sus contratos con otras capas ni dejar instalaciones parciales. Las comprobaciones de complejidad, cobertura y mutación deben funcionar como herramientas reutilizables, producir resultados explícitos y no alterar el working tree real.

El repositorio parte vacío y no necesita preservar compatibilidad con `agentic-layer`. Esto permite definir un producto independiente y coherente, pero también exige especificar desde el inicio sus contratos públicos, modos, transiciones, límites, comportamiento de calidad, propiedad de recursos y criterios de terminado.

## Solución

Construir `@kroxidev/agentic-core` versión `0.1.0`, un paquete npm con licencia MIT y soporte oficial inicial para Windows 10 y Windows 11. El producto expondrá un CLI de mantenimiento llamado `agentic-core`, un CLI de calidad llamado `agentic-quality` y un runtime local determinista que será conducido por la skill `orquestar`.

La orquestación será exclusivamente explícita y ofrecerá tres modos: `light`, `normal` y `full`. Toda petición que no use el activador se ejecutará en modo directo, sin coordinador ni gates automáticos adicionales. Cada modo tendrá un flujo cerrado de roles, un presupuesto de retrabajo y aislamiento estricto de instrucciones. Los roles serán agentes nuevos, secuenciales y especializados; el coordinador se limitará a transportar contexto, validar contratos, persistir estado y derivar transiciones.

Cada ejecución conservará la solicitud original de forma inmutable, una intención estructurada, el estado mínimo y, cuando corresponda, un plan plano. Los briefs se construirán desde fuentes canónicas con límites estrictos de tamaño. Los hand-offs serán objetos JSON validados contra un contrato cerrado y tendrán un único reintento de protocolo.

El producto incluirá motores propios de C.R.A.P. y Mutation Testing para JavaScript, TypeScript y Python. Los análisis se limitarán a símbolos nuevos, modificados o seleccionados, usarán cobertura atribuible por símbolo y ejecutarán mutantes en snapshots aislados. Los reportes serán reproducibles, verificables por hashes y consumibles tanto por la orquestación como de manera independiente.

La instalación y el mantenimiento serán transaccionales. Un manifiesto de propiedad determinará qué recursos puede modificar o eliminar `agentic-core`; cualquier fallo deberá restaurar el estado anterior. La actualización preservará la configuración del usuario, la desinstalación respetará recursos desconocidos y `doctor` comprobará únicamente los componentes propios del producto.

Las Golden Rules proporcionadas serán la única política canónica del producto. Se referenciarán desde roles y adapters sin copiar su contenido. CodeGraph y Engram serán ayudas opcionales cuando estén disponibles y resulten útiles, nunca precondiciones ni gates de aceptación.

## Historias de usuario

1. Como desarrollador, quiero instalar `agentic-core` en un proyecto, para disponer de orquestación y controles de calidad reproducibles.
2. Como desarrollador, quiero que la instalación sea transaccional, para no quedar con un proyecto parcialmente modificado si ocurre un fallo.
3. Como desarrollador, quiero conocer antes de reemplazar un conflicto aislado, para decidir conscientemente si autorizo el cambio.
4. Como desarrollador, quiero que los conflictos aislados puedan reemplazarse de forma explícita, para completar una instalación compatible.
5. Como desarrollador, quiero que una instalación ajena completa detenga el proceso, para resolverla con su propio producto.
6. Como desarrollador, quiero que `agentic-core` no desinstale otras capas, para conservar el control sobre herramientas independientes.
7. Como desarrollador, quiero actualizar `agentic-core` sin perder mi configuración, para adoptar nuevas versiones con seguridad.
8. Como desarrollador, quiero que una actualización detecte recursos propios modificados, para no sobrescribir personalizaciones silenciosamente.
9. Como desarrollador, quiero autorizar explícitamente el reemplazo de recursos propios divergentes, para controlar cambios difíciles de revertir.
10. Como desarrollador, quiero desinstalar únicamente los recursos propiedad de `agentic-core`, para preservar código, documentación y herramientas ajenas.
11. Como desarrollador, quiero previsualizar una desinstalación, para conocer su alcance antes de ejecutarla.
12. Como desarrollador, quiero que la desinstalación conserve recursos propios divergentes salvo autorización, para evitar pérdida accidental de trabajo.
13. Como desarrollador, quiero ejecutar `doctor`, para comprobar manifiesto, configuración, runtime, adapters y residuos operativos.
14. Como desarrollador, quiero que `doctor` repare solo recursos propios verificables, para no alterar archivos ajenos.
15. Como desarrollador, quiero consultar la versión instalada, para diagnosticar y reproducir el entorno.
16. Como usuario de npm, quiero que el paquete contenga únicamente el inventario previsto, para evitar archivos accidentales o sensibles.
17. Como usuario de Windows, quiero que comandos, rutas con espacios, procesos y timeouts funcionen en Windows 10 y 11, para usar el producto en mi entorno oficial.
18. Como mantenedor, quiero que el diseño interno no dependa innecesariamente de Windows, para facilitar soporte futuro en otros sistemas.
19. Como usuario, quiero activar la orquestación con una gramática explícita, para saber cuándo se crearán roles y estado.
20. Como usuario, quiero omitir el activador para trabajar en modo directo, para resolver tareas sencillas sin sobrecarga de orquestación.
21. Como usuario, quiero que el modo directo no cree coordinador, estado ni subagentes, para mantener una ejecución realmente directa.
22. Como usuario, quiero que el modo directo cargue solo las Golden Rules, para evitar políticas no solicitadas.
23. Como usuario, quiero que no exista clasificación automática por tamaño o riesgo, para que el modo elegido no dependa de heurísticas ocultas.
24. Como usuario, quiero que `Orquesta <tarea>` seleccione `normal`, para disponer de un valor predeterminado explícito y consistente.
25. Como usuario, quiero seleccionar `light`, para obtener implementación y validación con un flujo mínimo.
26. Como usuario, quiero seleccionar `normal`, para incluir planificación, revisión estructural, testing y documentación.
27. Como usuario, quiero seleccionar `full`, para añadir exploración previa y evaluación final independiente.
28. Como usuario, quiero que solo exista el nombre `normal`, para evitar alias ambiguos en contratos y documentación.
29. Como usuario, quiero que `direct` no sea un modo invocable, para que la ejecución directa siga significando ausencia del activador.
30. Como usuario de `light`, quiero que un Implementador establezca el HOW antes de editar, para trabajar con un camino claro.
31. Como usuario de `light`, quiero que el Implementador aplique TDD al comportamiento ejecutable, para obtener evidencia rojo-verde-refactor.
32. Como usuario de `light`, quiero que un Tester de solo lectura verifique criterios independientes, para separar implementación y aceptación.
33. Como usuario de `light`, quiero que el Tester ejecute pruebas, C.R.A.P. y Golden Rules, para recibir una validación objetiva y acotada.
34. Como usuario de `light`, quiero un máximo de dos ciclos de retrabajo, para limitar bucles improductivos.
35. Como usuario de `normal`, quiero que un Planificador lea la solicitud original, para no planificar desde un resumen degradado.
36. Como usuario de `normal`, quiero un plan secuencial, plano y acotado, para que la implementación tenga pasos verificables.
37. Como usuario de `normal`, quiero que el Planificador use grilling solo ante decisiones reales del HOW, para evitar entrevistas innecesarias.
38. Como usuario de `normal`, quiero que el Implementador trabaje solo sobre el plan vigente, para impedir expansión silenciosa del alcance.
39. Como usuario de `normal`, quiero que Refactor revise estructura, Golden Rules, C.R.A.P. y mutación, para detectar defectos antes del testing final.
40. Como usuario de `normal`, quiero que Refactor sea de solo lectura, para que revisión e implementación permanezcan separadas.
41. Como usuario de `normal`, quiero que el Tester pueda mejorar únicamente tests cuando falta evidencia, para cerrar cobertura sin alterar producción correcta.
42. Como usuario de `normal`, quiero que un incumplimiento de producción vuelva al Planificador, para replantear el HOW y no parchear sin diseño.
43. Como usuario de `normal`, quiero que una prueba contradictoria no se cambie silenciosamente, para visibilizar conflictos entre evidencia y especificación.
44. Como usuario de `normal`, quiero que el Documentador se ejecute siempre, para evaluar si la documentación debe acompañar el cambio.
45. Como usuario de `normal`, quiero que el Documentador no pueda bloquear ni abrir retrabajo, para que la documentación no invalide una implementación aceptada.
46. Como usuario de `normal`, quiero un máximo de tres ciclos de retrabajo, para controlar el coste de la ejecución.
47. Como usuario de `full`, quiero que un Explorador identifique archivos, símbolos y dependencias antes de planificar, para acotar correctamente el sector.
48. Como usuario de `full`, quiero que el Explorador sea de solo lectura y no diseñe la solución, para mantener separadas exploración y planificación.
49. Como usuario de `full`, quiero reabrir exploración solo cuando el sector inicial sea demostrablemente insuficiente, para evitar trabajo repetido.
50. Como usuario de `full`, quiero que Refactor ejecute C.R.A.P. sin mutación completa, para distribuir los gates entre fases independientes.
51. Como usuario de `full`, quiero que un Evaluador compare solicitud, criterios, plan, cambios y evidencia, para obtener aceptación final independiente.
52. Como usuario de `full`, quiero que el Evaluador ejecute Mutation Testing diferencial, para detectar pruebas insuficientes en el comportamiento cambiado.
53. Como usuario de `full`, quiero que el Evaluador repita C.R.A.P. solo si el reporte quedó obsoleto, para evitar trabajo redundante.
54. Como usuario de `full`, quiero un máximo de cuatro ciclos de retrabajo, para permitir profundidad sin bucles ilimitados.
55. Como usuario, quiero que varios blockers de un mismo hand-off consuman un solo ciclo, para contabilizar retrabajo por iteración real.
56. Como usuario, quiero que el contador de retrabajo sea global dentro del modo, para que una fase aprobada no reinicie el presupuesto.
57. Como usuario, quiero que agotar el presupuesto termine la ejecución como bloqueada, para recibir un resultado inequívoco.
58. Como usuario, quiero que preguntas, cambios de modo, contexto faltante y retries de protocolo no consuman retrabajo, para no penalizar eventos no correctivos.
59. Como usuario, quiero escalar de `light` a `normal` o `full`, para adaptar una tarea que resultó más exigente.
60. Como usuario, quiero escalar de `normal` a `full`, para añadir exploración y evaluación cuando sean necesarias.
61. Como usuario, quiero aprobar explícitamente cada cambio de modo, para controlar el coste y el alcance.
62. Como usuario, quiero que una escalada reinicie el presupuesto del nuevo modo, para aplicar sus límites completos.
63. Como usuario, quiero conservar archivos, tests, intención, plan y evidencia vigente al escalar, para no perder trabajo válido.
64. Como usuario, quiero que solo haya un agente activo por ejecución, para evitar conflictos sobre el mismo working tree.
65. Como usuario, quiero que cada hand-off cree un agente nuevo, para mantener responsabilidades y contexto aislados.
66. Como usuario, quiero que el coordinador sea un reducer determinista, para que las transiciones dependan de contratos y no de interpretación lingüística.
67. Como usuario, quiero que ningún rol elija al siguiente rol, para conservar el grafo como única autoridad.
68. Como usuario, quiero que el coordinador no revise código ni ejecute gates de calidad, para mantenerlo pequeño y predecible.
69. Como usuario, quiero que el coordinador muestre una línea breve por hand-off, para seguir el progreso sin ruido excesivo.
70. Como usuario, quiero que la solicitud original se conserve textualmente e inmutable, para poder resolver discrepancias posteriores.
71. Como usuario, quiero que la intención registre objetivo, razón, restricciones y criterios verificables, para dar autoridad estable a los roles.
72. Como usuario, quiero que una razón ausente se marque como no especificada, para evitar que el sistema invente motivaciones.
73. Como usuario, quiero que el sistema pregunte antes de iniciar cuando no pueda definir criterios sin adivinar, para preservar la intención real.
74. Como usuario, quiero que los criterios de `light` sean independientes del Implementador, para evitar que quien implementa redefina la aceptación.
75. Como usuario, quiero que Planificador y Evaluador lean obligatoriamente la fuente original, para proteger el objetivo contra resúmenes acumulativos.
76. Como usuario, quiero briefs mínimos respaldados por fuentes y hashes, para reducir contexto duplicado y detectar divergencias.
77. Como usuario, quiero un límite estricto de 16 KiB por brief, para controlar el presupuesto de contexto.
78. Como usuario, quiero que un brief demasiado grande falle explícitamente, para evitar truncamiento silencioso.
79. Como usuario, quiero que cada modo reciba exclusivamente sus propias instrucciones, para impedir contaminación entre responsabilidades.
80. Como usuario, quiero que el orden humano de roles coincida con el grafo ejecutable, para que documentación y runtime no diverjan.
81. Como usuario, quiero que los hand-offs sean JSON sin texto adicional, para validarlos y procesarlos de forma determinista.
82. Como usuario, quiero un contrato común de estados, artefactos, checks, findings y preguntas, para que todos los roles se comuniquen igual.
83. Como usuario, quiero que los findings distingan impacto bloqueante y advisory, para separar retrabajo de recomendaciones.
84. Como usuario, quiero que `changes_required` exija evidencia bloqueante, para impedir retrabajo sin causa concreta.
85. Como usuario, quiero que `completed` rechace findings bloqueantes, para evitar resultados contradictorios.
86. Como usuario, quiero que el hand-off omita razonamiento interno y datos de coordinación, para conservar un contrato mínimo y seguro.
87. Como usuario, quiero un límite estricto de 32 KiB por hand-off, para que la evidencia extensa se almacene fuera del mensaje.
88. Como usuario, quiero un único retry cuando el hand-off viola el protocolo, para recuperarme de errores de formato sin crear bucles.
89. Como usuario, quiero que un segundo fallo de protocolo termine como error, para recibir un estado final objetivo.
90. Como usuario, quiero persistir solo el estado necesario, para reanudar sin mantener telemetría ni historiales innecesarios.
91. Como usuario, quiero que el plan vincule criterios, pasos, objetivos, superficies y validaciones, para rastrear cada cambio a una aceptación.
92. Como usuario, quiero que el retrabajo produzca deltas del plan, para conservar el HOW válido y cambiar solo lo necesario.
93. Como usuario, quiero reanudar una ejecución por su identificador, para continuar después de una interrupción.
94. Como usuario, quiero listar ejecuciones reanudables cuando no indico identificador, para elegir sin selección automática.
95. Como usuario, quiero validar schemas, fuentes y hashes al reanudar, para no continuar con estado corrupto.
96. Como usuario, quiero que evidencia invalidada por cambios se marque obsoleta, para repetir el primer gate necesario.
97. Como usuario, quiero que la invalidación por divergencia no consuma retrabajo, para no penalizar comprobaciones de vigencia.
98. Como usuario, quiero eliminar ejecuciones terminales después de entregar el resultado, para no acumular estado innecesario.
99. Como usuario, quiero una configuración única con schema estricto, para evitar defaults contradictorios.
100. Como usuario, quiero que cada ejecución capture su configuración, para que cambios posteriores no alteren una tarea iniciada.
101. Como usuario, quiero definir comandos de test como argumentos estructurados y sin shell, para evitar ambigüedad e inyección.
102. Como desarrollador, quiero ejecutar C.R.A.P. de manera independiente, para evaluar símbolos sin iniciar una orquestación.
103. Como desarrollador, quiero un umbral único de C.R.A.P. igual a 7, para obtener una regla consistente y configurable.
104. Como desarrollador, quiero analizar solo símbolos nuevos, modificados o seleccionados, para mantener el gate focalizado.
105. Como desarrollador, quiero cobertura de líneas ejecutables por símbolo, para relacionar complejidad y evidencia con precisión.
106. Como desarrollador, quiero que cobertura desconocida produzca un estado no soportado, para no confundir ausencia de medición con cero por ciento.
107. Como desarrollador, quiero complejidad ciclomática consistente para JavaScript, TypeScript y Python, para comparar resultados semánticamente equivalentes.
108. Como desarrollador, quiero ejecutar Mutation Testing de manera independiente, para evaluar la capacidad de los tests de detectar defectos.
109. Como desarrollador, quiero que la ejecución asociada a cambios seleccione mutantes diferencialmente, para reducir coste sin perder relevancia.
110. Como desarrollador, quiero que la selección explícita pruebe todos los mutantes del objetivo, para realizar auditorías focalizadas completas.
111. Como desarrollador, quiero estados diferenciados para mutantes muertos, sobrevivientes, no cubiertos, equivalentes y muertos por timeout, para interpretar el resultado.
112. Como desarrollador, quiero que cualquier mutante sobreviviente o no cubierto falle el gate, para exigir evidencia efectiva.
113. Como desarrollador, quiero que un baseline fallido invalide la mutación completa, para no aceptar resultados obtenidos sobre una suite rota.
114. Como revisor, quiero clasificar un mutante equivalente con evidencia estática localizada, para excluir únicamente casos demostrables.
115. Como desarrollador, quiero hasta cuatro workers configurables y aislados, para acelerar mutación sin tocar el working tree real.
116. Como desarrollador, quiero reutilizar baseline, cobertura y snapshots, para evitar trabajo redundante.
117. Como desarrollador, quiero que cada mutante afecte solo su snapshot y que se verifique la restauración, para proteger el código fuente.
118. Como desarrollador, quiero conservar la ruta de evidencia si falla la limpieza, para poder diagnosticar una restauración incompleta.
119. Como desarrollador de JavaScript o TypeScript, quiero soporte para `node:test`, Jest y Vitest, para usar los runners más habituales.
120. Como desarrollador de JavaScript o TypeScript, quiero atribución de cobertura mediante V8 y source maps, para medir correctamente código transformado.
121. Como desarrollador de Python, quiero usar `coverage.py` cuando esté disponible, para aprovechar un backend estándar.
122. Como desarrollador de Python, quiero un tracer basado en biblioteca estándar como alternativa, para no exigir instalación de dependencias durante la tarea.
123. Como desarrollador de Python, quiero soporte para pytest y unittest, para analizar proyectos con ambos runners.
124. Como integrador, quiero reportes de calidad con schema, hashes, targets, resumen, detalles y duración, para validar vigencia y reproducibilidad.
125. Como integrador, quiero códigos de salida estables para aprobación, gate fallido, entorno no soportado, baseline fallido, uso inválido y error interno, para automatizar decisiones.
126. Como usuario, quiero que el coordinador valide existencia, schema, hashes, vigencia y estado del reporte, para aceptar evidencia sin reinterpretar cada detalle.
127. Como usuario, quiero que el Documentador pregunte ante una contradicción real, para decidir entre documentar lo implementado o registrar la discrepancia.
128. Como usuario, quiero que un fallo persistente del Documentador finalice con advertencias, para no perder una implementación ya aceptada.
129. Como usuario de Codex, quiero adapters con permisos técnicos mínimos, para crear agentes reales según su responsabilidad.
130. Como usuario de Claude Code, quiero adapters equivalentes, para ejecutar los mismos flujos y contratos en ambos hosts.
131. Como usuario, quiero que `agentic-tdd` se cargue solo en Implementadores que cambian comportamiento ejecutable, para evitar instrucciones irrelevantes.
132. Como usuario, quiero que `agentic-grilling` se cargue solo ante ambigüedad real, para no convertir cada tarea en una entrevista.
133. Como usuario, quiero que CodeGraph y Engram sean opcionales, para beneficiarme de ellos sin bloquear proyectos que no los tengan.
134. Como mantenedor, quiero documentación de instalación, modos, roles, calidad, estados, reanudación y limitaciones, para que el producto sea operable sin leer su implementación.
135. Como mantenedor, quiero validar manualmente un flujo `light`, uno `normal` y uno `full` en Codex y Claude Code sobre Windows, para comprobar la integración real antes de publicar.
136. Como mantenedor, quiero una suite determinista que cubra contratos, grafos, reanudación, calidad, mantenimiento y empaquetado, para declarar terminada la versión `0.1.0` con evidencia.

## Decisiones de implementación

1. `agentic-core` será un producto nuevo e independiente de `agentic-layer`; no habrá migración, compatibilidad cruzada ni comando de cambio entre productos.
2. La primera versión será `0.1.0`, se distribuirá como `@kroxidev/agentic-core`, usará licencia MIT y requerirá Node.js 20 o superior.
3. Python 3.10 o superior será necesario únicamente cuando el producto deba analizar código Python.
4. Windows 10 y Windows 11 serán las plataformas oficiales iniciales; las abstracciones internas de procesos, rutas y filesystem evitarán dependencias innecesarias del sistema operativo.
5. El producto expondrá dos binarios: `agentic-core` para mantenimiento y `agentic-quality` para análisis de calidad.
6. La activación de orquestación será exclusivamente explícita mediante `Orquesta`, `/orquestar` o `$orquestar`, con selección opcional de `light`, `normal` o `full`.
7. `normal` será el modo predeterminado cuando el activador no indique modo. No existirán los alias `moderado` ni `direct`.
8. Las peticiones sin activador se ejecutarán directamente y solo estarán gobernadas por las Golden Rules.
9. Las Golden Rules serán una única fuente canónica; roles, skills, adapters y documentación operativa solo podrán referenciarla.
10. CodeGraph y Engram se recomendarán cuando estén disponibles y sean útiles, pero no formarán parte de preflight, contratos, estado, instalación, aceptación ni recuperación.
11. El modo `light` seguirá el flujo Implementador → Tester, con retorno a un Implementador nuevo cuando el Tester solicite cambios y un máximo de dos ciclos.
12. El modo `normal` seguirá el flujo Planificador → Implementador → Refactor → Tester → Documentador. Refactor devolverá cambios a un Implementador nuevo; Tester devolverá defectos de producción a un Planificador nuevo; habrá un máximo de tres ciclos.
13. El modo `full` seguirá el flujo Explorador → Planificador → Implementador → Refactor → Tester → Evaluador → Documentador. Los defectos de Refactor volverán a un Implementador nuevo y los de Tester o Evaluador a un Planificador nuevo; habrá un máximo de cuatro ciclos.
14. Todos los roles, salvo las capacidades explícitas del Tester normal/full y del Documentador, serán de solo lectura o escritura según su responsabilidad declarada. Ningún revisor podrá modificar producción.
15. El Tester normal/full podrá crear o mejorar tests únicamente cuando producción ya cumpla el comportamiento y falte evidencia; cualquier cambio invalidará y repetirá los gates afectados.
16. El Documentador se creará siempre en `normal` y `full`, solo modificará documentación y nunca podrá solicitar retrabajo, bloquear la ejecución ni cambiar el modo.
17. Un fallo persistente del Documentador producirá éxito con advertencias, después de un reintento, sin invalidar la implementación aceptada.
18. El contador de retrabajo será global por ejecución y modo. Solo `changes_required` consumirá un ciclo; varios blockers de un mismo hand-off contarán como un ciclo.
19. Solo se permitirán escaladas `light` → `normal`, `light` → `full` y `normal` → `full`, siempre con aprobación explícita del usuario.
20. Una escalada reiniciará el presupuesto del nuevo modo y conservará fuentes, artefactos, plan, blockers y reportes cuyos hashes sigan vigentes.
21. El coordinador será un reducer determinista y efímero, no un daemon ni un agente. Sus responsabilidades serán crear ejecuciones, preparar briefs, validar hand-offs, derivar transiciones, persistir estado mínimo, reanudar y limpiar.
22. El coordinador no revisará código, ejecutará pruebas, calculará calidad, corregirá reportes, interpretará prosa para decidir rutas, mantendrá telemetría ni gestionará branches, commits o merges.
23. Habrá como máximo un subagente activo por ejecución. Los roles se ejecutarán secuencialmente sobre el mismo working tree y cada hand-off creará un agente nuevo.
24. La solicitud original será una fuente textual inmutable. La intención estructurada contendrá versión de schema, objetivo, razón, restricciones, criterios y referencia verificable a la fuente original.
25. Una razón ausente se representará explícitamente como no especificada. Si no pueden definirse criterios sin adivinar, la ejecución pedirá aclaración antes de comenzar.
26. En `light`, los criterios estructurados serán autoridad independiente del Implementador. En `normal` y `full`, el Planificador podrá precisarlos o dividirlos, pero nunca debilitarlos.
27. Planificador y Evaluador leerán obligatoriamente la solicitud original; los demás roles acudirán a ella cuando detecten discrepancias.
28. Cada brief contendrá el contrato común, la misión del rol, obligaciones del modo, intención pertinente, pasos vigentes, último hand-off accionable, referencias con hashes, política canónica y configuración aplicable.
29. Los briefs tendrán un límite de 16 KiB UTF-8. Un exceso producirá `context_budget_exceeded`; nunca habrá truncamiento silencioso.
30. Cada modo tendrá instrucciones propias y aisladas. Una comprobación de conformidad verificará que un brief no incluya roles ni marcadores de otros modos.
31. La definición ejecutable de los grafos será la autoridad del orden. Los nombres numerados de roles deberán coincidir exactamente con ese orden.
32. El hand-off será un único objeto JSON sin Markdown ni texto adicional, con versión de schema, estado, resumen y payload tipado.
33. Los estados admitidos serán `completed`, `changes_required`, `needs_input`, `needs_mode_change`, `context_missing`, `failed` y `blocked`.
34. Los findings tendrán impacto `blocking` o `advisory` y categorías cerradas para especificación, tests, C.R.A.P., mutación, Golden Rules, validación requerida y documentación.
35. `changes_required` exigirá al menos un finding bloqueante; `completed` lo prohibirá. La documentación solo podrá originar findings advisory.
36. El contrato prohibirá decisiones de próximo rol, razonamiento interno, prompts completos y datos de coordinación que ya pertenezcan al estado.
37. Los hand-offs tendrán un límite de 32 KiB UTF-8. La evidencia extensa se conservará como artefacto con referencia y hash.
38. Un hand-off inválido habilitará un único retry con un agente nuevo del mismo rol y los errores exactos. Un segundo fallo terminará la ejecución como `failed` sin consumir retrabajo.
39. El estado persistente contendrá versión de schema, identificador, modo, estado, rol actual, contador, hashes de fuentes y plan, snapshot de configuración, baseline, último hand-off y una lista mínima de transiciones.
40. Las transiciones almacenarán solo rol, estado, resumen y fecha; no se conservarán prompts completos, razonamiento, respuestas superadas ni reportes completos.
41. `light` no tendrá plan persistente. `normal` y `full` usarán un plan plano con enfoque, criterios, pasos, superficies de calidad y sugerencia documental.
42. El retrabajo de planificación producirá un delta aplicado atómicamente sobre el plan vigente, sin acumular versiones históricas.
43. La reanudación validará schema, rutas lógicas y hashes; marcará como obsoletos los reportes afectados por divergencias y volverá automáticamente al primer rol necesario.
44. Si no se especifica una ejecución al reanudar, el runtime listará opciones reanudables sin elegir una automáticamente.
45. Las ejecuciones exitosas se limpiarán después de entregar el resultado. Las actualizaciones y desinstalaciones eliminarán ejecuciones persistidas porque pueden volver incompatibles sus recursos.
46. Existirá una única configuración con schema estricto. Las claves desconocidas serán errores y cada ejecución conservará un snapshot inmutable de sus valores.
47. Los comandos personalizados de test y cobertura se representarán como ejecutable, argumentos, directorio opcional y entorno opcional, siempre con shell deshabilitado.
48. C.R.A.P. usará la fórmula canónica que combina complejidad ciclomática y cobertura, con un umbral único configurable de aprobación igual a 7.
49. La superficie de calidad incluirá únicamente símbolos ejecutables nuevos, símbolos con AST modificado y objetivos declarados expresamente. No se expandirá automáticamente a dependencias o archivos vecinos.
50. La cobertura será de líneas ejecutables atribuibles por símbolo. Comentarios, líneas vacías y declaraciones puramente de tipos no contarán.
51. Cobertura de cero por ciento será un dato válido. Cobertura no atribuible con confianza producirá `unsupported_environment` y nunca se sustituirá por cero.
52. La complejidad ciclomática comenzará en uno y aplicará decisiones semánticamente equivalentes para Python, JavaScript y TypeScript, incluyendo control de flujo, condiciones lógicas y expresiones pertinentes.
53. Mutation Testing tendrá motores propios para Python, JavaScript y TypeScript. Otros lenguajes ejecutables producirán `unsupported_language`.
54. Los operadores iniciales cubrirán booleanos, igualdad, comparación, lógica, aritmética, constantes, unarios y nulos cuando el reemplazo sea válido.
55. No se mutarán tests, código generado, declaraciones puramente de tipos, manifests ni reemplazos sintácticamente inválidos.
56. El análisis asociado a una ejecución será diferencial; un objetivo explícito evaluará todos sus mutantes. Exactamente una de ambas fuentes será obligatoria.
57. Un gate de mutación aprobará solo cuando no existan mutantes sobrevivientes ni no cubiertos. Un mutante que exceda su timeout contará como muerto por timeout.
58. Un baseline fallido o agotado invalidará la ejecución completa de mutación.
59. Refactor en `normal` y Evaluador en `full` podrán clasificar equivalentes solo con archivo lógico, símbolo, mutación, ubicación, razón y prueba estática localizada. No habrá exclusiones globales.
60. La mutación usará hasta cuatro workers configurables. Ejecutará baseline y cobertura una vez, procesará objetivos de forma secuencial y hasta cuatro mutantes del objetivo actual en paralelo.
61. Cada worker operará sobre un snapshot reutilizable y aislado. El working tree real nunca se mutará; cada restauración se comprobará por hash.
62. Si falla la limpieza, el producto preservará la evidencia y devolverá `restoration_failure`. Dependencias existentes podrán reutilizarse mediante referencias controladas sin copiarlas innecesariamente.
63. C.R.A.P. y mutación no se ejecutarán simultáneamente. No habrá daemon, polling ni benchmark bloqueante en `0.1.0`; cualquier afirmación de rendimiento requerirá medición.
64. JavaScript y TypeScript usarán cobertura V8 como backend predeterminado, TypeScript Compiler API para AST y `@jridgewell/trace-mapping` para source maps, con soporte para `node:test`, Jest y Vitest.
65. Python preferirá `coverage.py`, utilizará un tracer de biblioteca estándar como alternativa y soportará pytest y unittest sin instalar dependencias durante la tarea.
66. Los reportes de calidad tendrán schema común, herramienta, estado, lenguaje, backend, hashes de inputs y configuración, targets, resumen, detalles y duración.
67. Los estados de reporte distinguirán aprobación, fallo, no aplicable, entorno o lenguaje no soportado, baseline fallido y error.
68. Los códigos de salida distinguirán éxito, gate fallido, plataforma no soportada, baseline fallido, configuración inválida y error interno o de restauración.
69. El coordinador validará existencia, schema, hash, vigencia y estado permitido de cada reporte; no reinterpretará mutantes ni recalculará scores.
70. La coordinación no tendrá dependencias externas. Calidad JavaScript/TypeScript dependerá solo de TypeScript y la biblioteca de source maps; Python usará biblioteca estándar y `coverage.py` opcional.
71. Los adapters de Codex y Claude Code definirán perfiles de lectura, escritura, escritura de tests y documentación con permisos mínimos y agentes reales desde el comienzo.
72. La skill `orquestar` conducirá el runtime, entregará briefs completos sin prefijos y aceptará únicamente el JSON final del rol.
73. `agentic-grilling` se cargará al aclarar intención inicial o cuando el Planificador enfrente decisiones reales del HOW; no estará presente en todos los briefs.
74. `agentic-tdd` se cargará exclusivamente en Implementadores orquestados que cambien comportamiento ejecutable y estandarizará seam público, rojo válido, implementación mínima, verde, refactor y nueva validación.
75. El CLI de mantenimiento ofrecerá inicialización, actualización, desinstalación, diagnóstico y versión. El CLI de calidad ofrecerá scan, C.R.A.P. y mutación por ejecución u objetivo explícito.
76. La instalación registrará producto, versión, identificador, recursos gestionados, hashes, bloques gestionados y versión de configuración en un manifiesto de propiedad.
77. Los conflictos aislados podrán reemplazarse solo mediante autorización explícita, con respaldo, validación y restauración ante fallo. Una instalación ajena completa detendrá el proceso.
78. `--yes` solo resolverá decisiones no destructivas; una opción específica autorizará reemplazar conflictos aislados y `--force` se limitará a recursos divergentes que ya pertenezcan al producto.
79. La integración con instrucciones e ignore files se realizará mediante bloques mínimos gestionados, sin duplicar políticas ni contratos.
80. `update` preservará configuración, detectará divergencias, exigirá autorización para reemplazarlas, actualizará transaccionalmente y publicará el nuevo manifiesto solo después del éxito.
81. `uninstall` eliminará únicamente recursos propios registrados, estado operativo y directorios propios vacíos; preservará archivos desconocidos, otras skills, otros adapters y texto ajeno.
82. `doctor` comprobará únicamente manifiesto, hashes, configuración, bloques, adapters, runtimes requeridos, ejecuciones incompletas, workers, transacciones y backends de calidad.
83. La implementación se organizará por fases: scaffold, contratos y grafos, reducer y persistencia, contexto respaldado por fuentes, roles y skills, adapters, núcleo de calidad, calidad por lenguaje, instalador y documentación.
84. La versión estará terminada solo cuando las suites deterministas pasen, el paquete contenga exclusivamente lo previsto y los seis flujos manuales de Codex y Claude Code se hayan validado en Windows.

## Decisiones de testing

1. El seam principal será la interfaz CLI pública. Los tests iniciarán `agentic-core`, `agentic-quality` y el runtime local como procesos reales y observarán únicamente códigos de salida, stdout, stderr, artefactos persistidos y efectos sobre el filesystem.
2. Los tests usarán repositorios y proyectos fixture temporales, con rutas normales y rutas con espacios, para aislar cada caso y verificar el comportamiento externo sin tocar el working tree real.
3. Un buen test describirá comportamiento observable, fallará por la razón correcta, será rápido en su nivel, independiente, repetible, auto-validable y focalizado.
4. No se aceptarán mocks tautológicos, aserciones sobre detalles internos ni pruebas que reproduzcan la implementación en el propio test.
5. Los algoritmos puros con combinatoria extensa —contratos, reducer, hashes, AST, complejidad, selección de mutantes y restauración— podrán tener tests unitarios focalizados a través de sus interfaces de módulo. Estos complementarán, pero no reemplazarán, la aceptación por CLI.
6. El repositorio parte vacío y no existe prior art interno. La primera suite establecerá el patrón canónico de subprocess, fixtures temporales, snapshots verificables y aserciones de filesystem.
7. Los contratos probarán schemas sparse, campos prohibidos, combinaciones de estado y findings, payloads, límites de tamaño y protocol retry.
8. Los grafos probarán todas las transiciones válidas e inválidas de `light`, `normal` y `full`, incluido el requisito de crear agentes nuevos.
9. Los presupuestos probarán exactamente dos, tres y cuatro ciclos, el conteo por hand-off, los eventos que no consumen ciclos y el estado terminal al agotarlos.
10. Los tests del Documentador demostrarán que no puede solicitar retrabajo, bloquear ni cambiar modo, y que un fallo persistente termina con advertencias.
11. Los tests de contexto verificarán inmutabilidad de la solicitud, representación de razón ausente, autoridad de criterios, hashes, selección de cápsulas y rechazo de briefs mayores de 16 KiB sin truncamiento.
12. Los tests de aislamiento inspeccionarán el brief producido para cada rol y demostrarán ausencia de instrucciones, roles y marcadores pertenecientes a otros modos.
13. Los tests de planificación cubrirán planes iniciales, deltas, reemplazo atómico, criterios no debilitados y ausencia de historial innecesario.
14. Los tests de reanudación cubrirán selección explícita, listado sin selección automática, validación de estado, divergencias, reportes obsoletos y retorno al primer rol requerido.
15. Los tests de configuración cubrirán claves desconocidas, snapshots por ejecución, actualización de schema y comandos estructurados ejecutados sin shell.
16. Los tests de C.R.A.P. usarán fixtures semánticamente equivalentes en JavaScript, TypeScript y Python para verificar complejidad, cobertura por símbolo, umbral 7 y distinción entre cero y cobertura desconocida.
17. Los tests de Mutation Testing cubrirán cada operador, selección differential y explicit-all, mutantes killed, killedByTimeout, survived, uncovered y equivalent.
18. Los tests de mutación demostrarán que baseline fallido invalida el resultado, que sobrevivientes o no cubiertos fallan el gate y que equivalencias requieren evidencia localizada.
19. Los tests de workers verificarán máximo de concurrencia, reutilización de snapshots, exclusiones, timeouts, restauración por hash, limpieza y preservación de evidencia ante fallo.
20. Los backends JavaScript/TypeScript se probarán con `node:test`, Jest y Vitest, incluidos source maps y casos donde la cobertura no pueda atribuirse.
21. Los backends Python se probarán con unittest, pytest, `coverage.py`, tracer interno y ausencia del intérprete o de cobertura confiable.
22. Los reportes se probarán por schema, hashes de input y configuración, estados, targets, reproducibilidad, vigencia y códigos de salida.
23. Los tests del coordinador demostrarán que acepta reportes válidos y rechaza reportes inexistentes, corruptos, obsoletos o con hashes incompatibles sin recalcular su contenido.
24. Los adapters se probarán automáticamente por contenido contractual, permisos, selección, prompt entregado y parsing de respuesta. La creación real de agentes se validará manualmente.
25. Los tests de instalación cubrirán instalación limpia, conflicto aislado, instalación ajena, reemplazo autorizado, cancelación, fallo intermedio y rollback byte por byte.
26. Los tests de actualización cubrirán preservación de configuración, adición de claves obligatorias, recursos divergentes, autorización `--force`, limpieza de ejecuciones y rollback.
27. Los tests de desinstalación cubrirán dry-run, archivos desconocidos, recursos propios divergentes, bloques gestionados, directorios no vacíos, `--force` y rollback.
28. Los tests de `doctor` cubrirán diagnóstico y reparación de recursos propios sin reemplazar archivos ajenos ni intervenir otras capas.
29. Los tests de proceso cubrirán rutas Windows, espacios, argumentos, entorno, señales disponibles, timeouts, procesos hijos y limpieza determinista.
30. El gate automatizado de la versión ejecutará check estático, suite Node, suite Python e inspección seca del paquete npm.
31. El inventario del paquete se comparará exactamente con el conjunto esperado para impedir publicación de fixtures internos, caches, estado o archivos no declarados.
32. Antes de publicar `0.1.0`, se ejecutarán manualmente un flujo `light`, uno `normal` y uno `full` tanto en Codex como en Claude Code sobre Windows 10 u 11.

## Fuera de alcance

- Modificar `agentic-layer`.
- Migrar instalaciones, estados, schemas, snapshots o sesiones de `agentic-layer`.
- Instalar, desinstalar o alternar automáticamente otros productos.
- Soportar simultáneamente `agentic-core` y otra capa completa dentro del mismo proyecto.
- Clasificar automáticamente tareas por tamaño, riesgo, tipo o cantidad de archivos.
- Exponer `direct` como modo invocable.
- Ejecutar roles en paralelo dentro de una misma ejecución.
- Coordinar paralelismo entre ejecuciones distintas.
- Gestionar branches, commits, merges o aislamiento mediante worktrees.
- Mantener daemon, polling, telemetría, event log, capabilities o snapshots históricos de planes.
- Conservar prompts completos, razonamiento interno o respuestas superadas en el estado.
- Convertir CodeGraph o Engram en dependencias obligatorias.
- Instalar dependencias Python durante una tarea.
- Analizar lenguajes distintos de JavaScript, TypeScript y Python en `0.1.0`.
- Ejecutar benchmarks bloqueantes o afirmar mejoras de rendimiento sin medición.
- Aplicar exclusiones globales de mutantes equivalentes.
- Expandir automáticamente el análisis de calidad a callers, callees, dependientes o módulos vecinos.
- Soportar oficialmente sistemas operativos distintos de Windows 10 y Windows 11 en la primera versión.
- Distribuir adapters simulados que no creen agentes reales.
- Permitir que `doctor` repare archivos ajenos o retire otra capa.

## Notas adicionales

- `agentic-core.md` y `golden-rules.md` son las fuentes de esta especificación. Las Golden Rules se tratan como contenido canónico del producto, no como instrucciones para el proceso de publicación.
- El repositorio está concebido como un producto nuevo y sin compatibilidad heredada; las decisiones documentadas se consideran cerradas para `0.1.0`.
- La implementación debe mantener vocabulario consistente: `direct`, `light`, `normal`, `full`, Planificador, Implementador, Refactor, Tester, Explorador, Evaluador, Documentador, brief, hand-off, retrabajo y reporte obsoleto.
- La ausencia de prior art en el repositorio hace que esta primera suite y sus fixtures definan el patrón de testing futuro.
- La publicación del paquete requiere que las validaciones automáticas y los seis recorridos manuales produzcan evidencia satisfactoria.
