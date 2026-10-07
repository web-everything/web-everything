/**
 * @file scripts/lib/host-sample.mjs
 * @description Cheap real-host reading for the dispatch gate: CPU idle % and free-memory %. macOS load average counts
 *   threads blocked on I/O and kernel work, so it overstates CPU saturation (live 2026-10-07: load 35-41 on 12 cores
 *   while `top` showed 17-25% idle and 86% memory free). Source: `top -l 2 -n 0 -s 1` (second sample = a real 1 s
 *   interval, not the since-boot first one) and `memory_pressure`. The result is cached in a small file for a few
 *   seconds so every caller (daemons, passes) shares one sample. Never throws; a failed read is `{ok:false}` and the
 *   gate falls back to load average.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HOST_SAMPLE_TTL_MS = 5000;
const defaultCachePath = () => join(tmpdir(), `we-host-sample-${process.getuid?.() ?? 'u'}.json`);

/** Last "N% idle" on a `CPU usage:` line (the second `top` sample). Null when absent. */
export function parseTopIdle(text) {
  const lines = String(text ?? '').split('\n').filter((l) => /CPU usage:/.test(l));
  const m = lines.at(-1)?.match(/([\d.]+)%\s*idle/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** "System-wide memory free percentage: 86%". Null when absent. */
export function parseMemoryFree(text) {
  const m = String(text ?? '').match(/memory free percentage:\s*([\d.]+)%/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

const run = (cmd, args, timeout) => execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });

/** Uncached read. `exec(cmd,args)` is injectable for tests. */
export function readHostSample({ exec = (c, a) => run(c, a, 8000), platform = process.platform } = {}) {
  let idlePct = null; let memFreePct = null;
  if (platform === 'darwin') {
    try { idlePct = parseTopIdle(exec('top', ['-l', '2', '-n', '0', '-s', '1'])); } catch { /* sample failed */ }
    try { memFreePct = parseMemoryFree(exec('memory_pressure', [])); } catch { /* memory unreadable: second check skipped */ }
  }
  return { ok: idlePct !== null, idlePct, memFreePct };
}

/** Cached read shared across processes for `ttlMs`. */
export function sampleHost({ read = readHostSample, now = Date.now, ttlMs = HOST_SAMPLE_TTL_MS, cachePath = defaultCachePath() } = {}) {
  try {
    const c = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (Number.isFinite(c?.at) && now() - c.at >= 0 && now() - c.at < ttlMs && c.sample) return c.sample;
  } catch { /* no/bad cache */ }
  const sample = read();
  try { const tmp = `${cachePath}.${process.pid}`; writeFileSync(tmp, JSON.stringify({ at: now(), sample })); renameSync(tmp, cachePath); } catch { /* cache is best-effort */ }
  return sample;
}
