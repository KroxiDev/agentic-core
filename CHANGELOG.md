# Registro de cambios

## Unreleased

### Incompatible

- `agentic-core init --yes` se retiró porque no modificaba el comportamiento de instalación. Los scripts que aún lo pasen reciben `Unknown option: --yes` y terminan con código 2 antes de escribir; únicamente `--replace-conflicts` autoriza el reemplazo explícito de conflictos aislados.

### Mantenimiento

- `agentic-core update` ya migra instalaciones legacy al esquema 3 y actualiza runtime, recursos y herramientas con previsualización, rollback y ownership por recurso.
- `agentic-core uninstall` conserva divergencias, estado legacy y contenido ajeno, incluso dentro de directorios creados por la capa.
