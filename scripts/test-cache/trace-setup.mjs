/**
 * @file scripts/test-cache/trace-setup.mjs
 * @description prepare-124 S3 — vitest setup file (FIRST in `setupFiles`, before vitest.setup.ts strips `WE_*`) that
 * traces what one test file reads and runs. It writes `<cache>/traces/<runId>/<sha(file)>.json` in `afterAll`; the shadow
 * reporter folds that (plus the file's `node` children's lines) into the shadow log and the entry's traced input list.
 * Only loaded when the cache is on and tracing is not switched off (see vitest.config.ts); shadow only.
 */
import { afterAll, expect } from 'vitest';
import { mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cacheDir } from '../lib/test-result-cache.mjs';
import { sampledForTrace, traceEnabled, traceFileBase } from '../lib/test-cache-trace.mjs';
import { atomicWrite } from '../lib/test-result-store.mjs';
import { createRecorder, installTracer } from './tracer.mjs';

const env = { ...process.env }; // snapshot: vitest.setup.ts scrubs WE_* from process.env right after this file
const runId = env.WE_TEST_CACHE_RUN_ID;
const root = process.cwd();
const testPath = () => expect.getState().testPath ?? globalThis.__vitest_worker__?.filepath ?? '';
const file = testPath() ? relative(root, testPath()) : '';

if (runId && file && traceEnabled(env) && sampledForTrace(file, runId, env)) {
  const dir = cacheDir(env);
  const base = traceFileBase(dir, runId, file);
  try { mkdirSync(dirname(base), { recursive: true }); } catch { /* children then trace nothing */ }
  const rec = createRecorder();
  const uninstall = installTracer({
    record: rec.record,
    childTrace: { traceFile: `${base}.child.jsonl`, importUrl: pathToFileURL(join(root, 'scripts', 'test-cache', 'child-tracer.mjs')).href },
  });
  afterAll(() => {
    uninstall();
    try { atomicWrite(`${base}.json`, `${JSON.stringify({ file, root, events: rec.events() })}\n`); } catch { /* shadow mode never breaks a run */ }
  });
}
