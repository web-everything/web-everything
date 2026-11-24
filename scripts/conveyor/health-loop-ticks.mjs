/**
 * @file scripts/conveyor/health-loop-ticks.mjs
 * @description zero-success-alarm (2026-11-24) — pure verdict over parsed daemon tick records: a tick loop that had
 *   work and failed every time for an hour. Live: prepare logged 19,913 failures in 87 ticks and launched nothing;
 *   the drain catch-up exited 1 for about 13 hours. Each tick looked like an ordinary failure, so nothing alarmed.
 *   A record is `{ at, loop, attempted, succeeded, failed, error }`. A tick with `attempted` of 0 had nothing to do
 *   and is NOT a failure. Read-only: it only reports.
 */

const MINUTE = 60_000;

/** One tick record, or null when the object is not a usable record. */
export function normalizeLoopTick(r) {
  if (!r || typeof r !== 'object') return null;
  const at = typeof r.at === 'number' ? r.at : Date.parse(r.at ?? '');
  if (!Number.isFinite(at) || typeof r.loop !== 'string' || !r.loop) return null;
  const succeeded = Math.max(0, Number(r.succeeded) || 0);
  const failed = Math.max(0, Number(r.failed) || 0);
  const attempted = Number.isFinite(Number(r.attempted)) ? Math.max(0, Number(r.attempted)) : succeeded + failed;
  return { at, loop: r.loop, attempted, succeeded, failed, error: r.error == null ? null : String(r.error).slice(0, 300) };
}

/** Parse JSON lines into records, skipping anything unusable. */
export function parseLoopTicks(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { const n = normalizeLoopTick(JSON.parse(t)); if (n) out.push(n); } catch { /* not a record */ }
  }
  return out;
}

export function zeroSuccessWindowMinutes(env = process.env) {
  const n = Number(env?.WE_ZERO_SUCCESS_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

export function zeroSuccessMinTicks(env = process.env) {
  const n = Number(env?.WE_ZERO_SUCCESS_MIN_TICKS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/**
 * PURE: group records by loop and judge each over the last `windowMs`.
 * A loop breaches when its in-window ticks that had work number at least `minTicks`, span at least the window
 * (minus a 5 minute slack), and none succeeded.
 * @returns {Array<{loop:string, breach:boolean, ticks:number, failures:number, sinceAt:number|null, dominantError:string|null}>}
 */
export function zeroSuccessVerdicts(records, { now, windowMs = 60 * MINUTE, minTicks = 3 } = {}) {
  const byLoop = new Map();
  for (const r of records || []) {
    const n = normalizeLoopTick(r);
    if (!n || n.at > now + MINUTE) continue;
    if (!byLoop.has(n.loop)) byLoop.set(n.loop, []);
    byLoop.get(n.loop).push(n);
  }
  const out = [];
  for (const [loop, all] of byLoop) {
    const inWin = all.filter((t) => now - t.at <= windowMs).sort((a, b) => a.at - b.at);
    const worked = inWin.filter((t) => t.attempted > 0);
    const successes = inWin.reduce((s, t) => s + t.succeeded, 0);
    const failures = worked.reduce((s, t) => s + t.failed, 0);
    const span = worked.length ? worked[worked.length - 1].at - worked[0].at : 0;
    const breach = successes === 0 && failures > 0 && worked.length >= minTicks && span >= windowMs - 5 * MINUTE;
    const counts = new Map();
    for (const t of worked) if (t.error) counts.set(t.error, (counts.get(t.error) || 0) + Math.max(1, t.failed));
    const dominantError = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({ loop, breach, ticks: worked.length, failures, sinceAt: worked[0]?.at ?? null, dominantError });
  }
  return out;
}
