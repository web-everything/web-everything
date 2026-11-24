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
  return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : 60;
}

export function zeroSuccessMinTicks(env = process.env) {
  const n = Number(env?.WE_ZERO_SUCCESS_MIN_TICKS);
  return Number.isFinite(n) && n >= 1 && n <= 500 ? Math.floor(n) : 3;
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
    const breach = successes === 0 && failures > 0 && worked.length >= minTicks && span >= windowMs - 15 * MINUTE;
    const counts = new Map();
    for (const t of worked) if (t.error) counts.set(t.error, (counts.get(t.error) || 0) + Math.max(1, t.failed));
    const dominantError = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({ loop, breach, ticks: worked.length, failures, sinceAt: worked[0]?.at ?? null, dominantError });
  }
  return out;
}

// ── per-loop parsers (log line shapes read live 2026-11-24) ───────────────────────────────────────────────────

const mostCommon = (xs) => { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };

/**
 * Prepare loop: each build-dispatch tick is one JSON line (`timings` present); `prepare.launched` are successes,
 * `prepare.failures` are failures (`{num, stage, reason}`). A tick with neither had nothing to do and is dropped.
 */
export function parsePrepareTicks(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    // The installed logger may prefix each line with an ISO timestamp (and a BOM); strip it before parsing.
    const t = line.trim().replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)\s+(?=\{)/, '');
    if (!t.startsWith('{') || !t.includes('"timings"')) continue;
    let r; try { r = JSON.parse(t); } catch { continue; }
    const at = Date.parse(r?.at ?? '');
    if (!Number.isFinite(at)) continue;
    // A whole-tick failure (`event: 'tick-failed'`, no `prepare` object) is a failure of the prepare loop too.
    if (r.event === 'tick-failed') { out.push({ at, loop: 'prepare', attempted: 1, succeeded: 0, failed: 1, error: 'tick-failed' }); continue; }
    if (!r.prepare || typeof r.prepare !== 'object') continue;
    const failures = Array.isArray(r.prepare.failures) ? r.prepare.failures : [];
    const launched = Array.isArray(r.prepare.launched) ? r.prepare.launched.length : 0;
    if (!failures.length && !launched) continue;
    out.push({ at, loop: 'prepare', attempted: failures.length + launched, succeeded: launched, failed: failures.length,
      error: mostCommon(failures.map((f) => String(f?.reason ?? 'unknown').replace(/\d+/g, 'N').slice(0, 160))) });
  }
  return out;
}

const DRAIN_OK = new Set(['enqueued', 'not-enqueued', 'skipped', 'not-listed']);
const COULD_NOT_FINISH_RE = /^\[drain-daemon\] (\S+Z) .*?catch-up #\d+.*? — could not finish \(class=([a-z-]+)\)/;
const DRAIN_RE2 = /^\[drain-daemon\] (\S+Z) enqueue-on-event: catch-up #\d+ fast drain exit (\S+?)[ ,].*? — (.*?) \[outcome=([a-z-]+)\]/;

/** Drain catch-up: one line per fast drain; outcome error/timeout/other/refused is a failure, the rest reached a verdict. */
export function parseDrainCatchupTicks(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('catch-up #')) continue;
    // The catch handler's line when the fast drain itself threw: a failure with a class.
    const cf = COULD_NOT_FINISH_RE.exec(line);
    if (cf) {
      const at = Date.parse(cf[1]);
      if (Number.isFinite(at)) out.push({ at, loop: 'drain-catchup', attempted: 1, succeeded: 0, failed: 1, error: `could not finish (class=${cf[2]})` });
      continue;
    }
    if (!line.includes('fast drain exit')) continue;
    const m = DRAIN_RE2.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at)) continue;
    const ok = DRAIN_OK.has(m[4]);
    out.push({ at, loop: 'drain-catchup', attempted: 1, succeeded: ok ? 1 : 0, failed: ok ? 0 : 1,
      error: ok ? null : `exit ${m[2]}: ${m[3].replace(/\d+/g, 'N').slice(0, 140)} [${m[4]}]` });
  }
  return out;
}

/** Merge new records into the kept memory; drop anything older than the window, cap the size. */
export function mergeLoopTicks(prev, fresh, { now, windowMs = 60 * MINUTE, max = 2000 } = {}) {
  const keep = [...(Array.isArray(prev) ? prev : []), ...(fresh || [])].filter((r) => r && now - r.at <= windowMs + 10 * MINUTE && r.at <= now + MINUTE);
  const seen = new Set();
  const uniq = [];
  for (const r of keep.sort((a, b) => a.at - b.at)) {
    const k = `${r.loop}|${r.at}|${r.succeeded}|${r.failed}`;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(r);
  }
  // Cap per loop, so a busy loop cannot evict another loop's evidence.
  const byLoop = new Map();
  for (const r of uniq) {
    if (!byLoop.has(r.loop)) byLoop.set(r.loop, []);
    byLoop.get(r.loop).push(r);
  }
  const kept = [];
  for (const records of byLoop.values()) {
    if (records.length <= max) { kept.push(...records); continue; }
    if (max < 5) { kept.push(...records.slice(records.length - max)); continue; }
    const worked = records.filter((r) => r.attempted > 0);
    // Preserve the supported minimum-tick ceiling (500), plus witnesses for any success or failure.
    // Keeping the latest success is sufficient: every earlier success expires before it does.
    const recentLimit = Math.min(500, max - 5);
    const selected = new Set(worked.slice(worked.length - recentLimit));
    selected.add(records.at(-1));
    const success = records.findLast((r) => r.succeeded > 0);
    const failure = worked.findLast((r) => r.failed > 0);
    if (success) selected.add(success);
    if (failure) selected.add(failure);
    // Stable time buckets retain the oldest work across the whole window, even across repeated merges.
    // The retained interval includes 10m grace and 1m future slack. N bucket widths intersect at most
    // N+1 buckets; reserve that extra slot. At max=2000 even a 24h window has buckets under one minute,
    // comfortably inside the verdict's 15m slack. Storage stays bounded independently of tick rate.
    const bucketMs = (windowMs + 11 * MINUTE) / (max - recentLimit - 4);
    const buckets = new Set();
    for (const r of worked) {
      const bucket = Math.floor(r.at / bucketMs);
      if (buckets.has(bucket)) continue;
      buckets.add(bucket); selected.add(r);
    }
    kept.push(...selected);
  }
  return kept.sort((a, b) => a.at - b.at);
}
