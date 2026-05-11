// Installs the import-in-the-middle ESM loader hook before any user code
// runs. OpenTelemetry's auto-instrumentation patches modules at require/
// import time, so the hook has to be registered via Node's `--import`
// mechanism — registering it from inside an already-loaded module is too
// late for built-ins like `node:http`. Without this, `getNodeAutoInstrumentations`
// loads but silently never wraps anything in ESM mode.
//
// Usage: node --import ./instrument.mjs --import ./tracing.ts server.ts
import { register } from 'node:module';

register('import-in-the-middle/hook.mjs', import.meta.url);
