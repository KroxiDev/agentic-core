# Archivo histórico de Full

El [issue #84](https://github.com/KroxiDev/agentic-core/issues/84), parte de la
[especificación #83](https://github.com/KroxiDev/agentic-core/issues/83), conserva
el estado completo de Full anterior a su retiro.

- Repositorio: `KroxiDev/agentic-core`.
- Rama congelada: [`archive/full`](https://github.com/KroxiDev/agentic-core/tree/archive/full).
- Commit preservado: `a4c173d0093fe3cc44f095fc09be35662af704ed`.
- Árbol Git: `d80362aad93aecb29efaef9d60e9e6de220d81bc`.
- Fecha de preservación: 2026-09-08.

El commit era el HEAD de `main` en el repositorio canónico al crear el archivo.
La rama no existía; se creó mediante la API de creación de referencias, que
rechaza nombres existentes, después de verificar la identidad `KroxiDev` y el
destino. No se reutilizó una rama antigua de implementación.

## Contenido recuperable

La referencia conserva el árbol completo de 133 archivos versionados, incluidos:

| Área | Recursos representativos |
| --- | --- |
| Implementación | `src/quality-cli.js`, `src/quality/session.js`, `src/quality/python-mutation.js`, `src/installation/install.js` |
| Coordinación y perfiles | `skills/orquestar/SKILL.md`, `adapters/codex/agents/`, `adapters/claude/` |
| Documentación | `README.md`, `agentic-core-spec.md`, `adapters/manual-validation.md` |
| Pruebas | `test/semantic-coordination.test.js`, `test/quality-python-full-freshness.test.js`, `test/quality-python-mutation.test.js`, `test_python/` |
| Dependencias y construcción | `package-lock.json`, `third_party/python/`, `scripts/build-runtime.mjs` |

## Recuperación

Desde un clon del repositorio canónico, elegir una ruta nueva para consultar el
archivo sin mover la rama congelada:

```sh
git fetch origin refs/heads/archive/full
git rev-parse FETCH_HEAD
# Debe devolver a4c173d0093fe3cc44f095fc09be35662af704ed.
git worktree add --detach ../agentic-core-full-history a4c173d0093fe3cc44f095fc09be35662af704ed
```

Si la referencia devuelve otro SHA, detenerse y comprobar la divergencia; no
sobrescribirla. El SHA registrado identifica el estado histórico exacto.

## Validación y límites

1. Se recuperó la rama desde GitHub y se comprobó la igualdad del commit y del
   árbol con los identificadores registrados.
2. Se generó un archivo TAR de la referencia recuperada con
   `git -c core.autocrlf=false archive --format=tar refs/remotes/origin/archive/full`.
   Se leyeron sus 133 archivos y se comparó cada hash de blob Git con
   `git ls-tree -r`: coincidieron todos, sin archivos faltantes ni adicionales.
   La opción local evita conversiones de fin de línea al verificar los bytes;
   no cambia la configuración del repositorio.
3. Se comprobó que la CI existente no tiene un disparador `push` para esta rama.
   El archivo conserva los workflows históricos, pero no se incorpora al
   mantenimiento ni a la validación continua y no debe recibir nuevos commits.

No se ejecutaron la suite Full, sus roles ni una orquestación nativa. Esta
validación demuestra recuperabilidad del contenido versionado, no funcionamiento
actual de Full ni preservación de archivos locales ignorados o no versionados.

Este ticket no cambia los modos activos ni retira código compartido. El retiro
de Full pertenece a T11 de la especificación #83. La rama histórica queda
congelada, sin obligación de mantenimiento o validación continua.
