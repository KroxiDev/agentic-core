#!/usr/bin/env node

process.argv.splice(2, 0, "agentic-core");
await import("../dist/runtime/agentic-core.mjs");
