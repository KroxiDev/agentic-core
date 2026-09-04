# Registro de cambios

## Unreleased

### Incompatible

- `agentic-core init --yes` se retiró porque no modificaba el comportamiento de instalación. Los scripts que aún lo pasen reciben `Unknown option: --yes` y terminan con código 2 antes de escribir; únicamente `--replace-conflicts` autoriza el reemplazo explícito de conflictos aislados.
