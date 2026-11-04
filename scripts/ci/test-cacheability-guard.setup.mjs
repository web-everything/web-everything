/**
 * @file scripts/ci/test-cacheability-guard.setup.mjs
 * @description R578/R579 prototype. Opt-in vitest setup file: records the hidden inputs the existing prepare-124
 * tracer (scripts/test-cache/tracer.mjs: fs reads, child_process, net) does NOT see: real clock, randomness, process.env
 * reads and global fetch. Writes one JSON per test file to $WE_CACHEABILITY_GUARD_DIR (default os.tmpdir()/we-cacheability).
 * Off unless WE_CACHEABILITY_GUARD=1, so default runs are unchanged. Counting only; it never changes behaviour.
 * Settings (R528): WE_CACHEABILITY_GUARD, WE_CACHEABILITY_GUARD_DIR.
 */
import { afterAll, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const env = { ...process.env }; // snapshot before vitest.setup.ts scrubs WE_*
if (env.WE_CACHEABILITY_GUARD === '1') {
  const counts = { clock: 0, random: 0, env: 0, fetch: 0 };
  const origNow = Date.now.bind(Date);
  Date.now = () => { if (!globalThis.__vitest_fake_timers__ && !Date.now.clock) counts.clock++; return origNow(); };
  const origRandom = Math.random;
  Math.random = () => { counts.random++; return origRandom(); };
  if (typeof globalThis.fetch === 'function') {
    const f = globalThis.fetch;
    globalThis.fetch = (...a) => { counts.fetch++; return f(...a); };
  }
  process.env = new Proxy(process.env, { get(t, k, r) { if (typeof k === 'string') counts.env++; return Reflect.get(t, k, r); } });
  afterAll(() => {
    const file = relative(process.cwd(), expect.getState().testPath ?? '');
    const dir = env.WE_CACHEABILITY_GUARD_DIR || join(tmpdir(), 'we-cacheability');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${file.replace(/[\\/]/g, '__')}.json`), `${JSON.stringify({ file, ...counts })}\n`);
    } catch { /* never break a run */ }
  });
}
