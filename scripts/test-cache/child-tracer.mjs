/**
 * @file scripts/test-cache/child-tracer.mjs
 * @description prepare-124 S3 — preloaded (`NODE_OPTIONS=--import`) into every `node` child a traced test file spawns.
 * Records the child's own fs/spawn/net events plus its CommonJS module cache, appending them to the file named by
 * `WE_TRACE_FILE` as one line at exit. Silent; any failure leaves the child untouched. It deliberately does NOT use
 * `module.register` (a loader-hook thread): measured here, that made a child's `fs.writeSync(1, big)` to a pipe come back
 * truncated at 8 KB, i.e. it changes test outcomes. ESM modules a child loads are covered instead by the static import
 * closure of its entry script (computed by the shadow reporter), so the traced list stays complete without a hook.
 */
import { appendFileSync } from 'node:fs';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRecorder, installTracer } from './tracer.mjs';

const traceFile = process.env.WE_TRACE_FILE;
if (traceFile) {
  try {
    const rec = createRecorder({ cap: 5000 });
    installTracer({
      record: rec.record,
      childTrace: { traceFile, importUrl: new URL(import.meta.url).href },
    });
    process.on('exit', () => {
      try { const mods = Object.keys(Module._cache ?? {}).filter((p) => p.startsWith('/')).map((p) => ({ t: 'mod', u: pathToFileURL(p).href }));
        appendFileSync(traceFile, `${[...mods, { t: 'fs', events: rec.events() }].map((r) => JSON.stringify(r)).join('\n')}\n`); } catch { /* ignore */ }
    });
  } catch { /* tracing never breaks a child */ }
}
