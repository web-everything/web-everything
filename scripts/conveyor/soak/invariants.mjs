/**
 * @file invariants.mjs — #4075 daemon soak harness (card x0zg44l). The checks the soak runner
 * (`we:scripts/conveyor/soak/soak.mjs`) runs after EVERY daemon tick. Each one is a real live failure mode from
 * 2026-09-25 that every unit test stayed green through:
 *
 *   clean       — the daemon clone's `git status --porcelain` is empty. A runtime state file written into the
 *                 clone (`.conveyor/unsupported-repo.json`, `scripts/conveyor/run-scorecards.json`) makes the
 *                 rebuild/self-sync refuse, and every dispatch after that is refused as stale.
 *   behind      — the clone is at most `maxBehind` main moves behind origin/main. A clone that stops following
 *                 main is the SYMPTOM every freeze shares, whatever froze it.
 *   lag         — no main move stays un-adopted for more than `maxLagTicks` daemon ticks. `behind` alone misses a
 *                 clone frozen on ONE move while main then sits still (live: a sticky smoke rejection held the
 *                 clone until main happened to move again).
 *   bounded     — the tick finished inside `tickBoundMs` (a hung tick is caught by the runner's own timeout; this
 *                 catches a slow-but-finished one).
 *   no-throw    — the tick's own `tickOnce` did not throw.
 *   no-onTick   — the daemon's own `onTick`/`onTickError` logger did not throw on the tick's result (live: a
 *                 skipped tick crashing on `undefined.map`).
 *   stale       — the daemon's OWN stale-main predicate (`hasStaleMainRefusal`, imported from the daemon module in
 *                 the clone) did not fire more than `staleStreakMax` ticks in a row.
 *   owed        — every PR the fleet declares as owed work saw a dispatch of that kind within `owedGraceTicks`
 *                 ticks of the daemon that owns it (never refused forever).
 *
 * Every function here is pure over the facts the runner hands it, except {@link cloneFacts}, which reads git.
 */

import { execFileSync, spawnSync } from 'node:child_process';

/** Default bounds — one place, so a scenario overrides only what it means to. */
export const DEFAULT_BOUNDS = Object.freeze({
  maxBehind: 1,
  maxLagTicks: 6,
  tickBoundMs: 90_000,
  staleStreakMax: 3,
  owedGraceTicks: 6,
});

/** Which daemon owns each kind of owed work. */
export const OWED_KIND_DAEMON = Object.freeze({
  review: 'review',
  fix: 'fix-dispatch',
  'ci-heal': 'fix-dispatch',
});

function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Read the two git facts the invariants need, WITHOUT mutating the clone (no fetch — a fetch would move the
 * clone's own `origin/main` ref and change what the daemon sees next tick).
 * @param {{clone:string, mainMoves:string[]}} o - `mainMoves`: every sha the soak pushed to origin/main, in order.
 * @returns {{dirty:string[], behind:number, head:string}}
 */
export function cloneFacts({ clone, mainMoves }) {
  const status = gitOut(clone, ['status', '--porcelain']).split('\n').filter(Boolean);
  const head = gitOut(clone, ['rev-parse', 'HEAD']).trim();
  const missing = [];
  for (const move of mainMoves) {
    const sha = typeof move === 'string' ? move : move.sha;
    // exit 0 = ancestor; 1 = not; 128 = the object is not even in the clone (never fetched) — also "behind".
    const r = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: clone, stdio: 'ignore' });
    if (r.status !== 0) missing.push(move);
  }
  return { dirty: status, behind: missing.length, missing, head };
}

/** A session name that is `<kind>-<pr>` (optionally with a repo tag between, e.g. `fix-fui-12`). */
export function sessionMatches(name, kind, pr) {
  return new RegExp(`^${kind}-(?:[a-z-]+-)?${Number(pr)}(?:$|[^0-9])`).test(String(name ?? ''));
}

/**
 * Why did this tick not dispatch `pr`? Reads only what the daemon itself reported for the tick (its result rows and
 * log lines), never re-derives a decision. An `owed` violation that says only "no dispatch" cannot be diagnosed from
 * CI output alone (main went red on PR #10 twice with nothing else to go on). Pure.
 * @param {{result?:any, logs?:string[]}} entry
 * @param {number} pr
 * @returns {string}
 */
export function explainNoDispatch(entry, pr) {
  const result = entry?.result ?? {};
  const n = Number(pr);
  const parts = [];
  const rowsFor = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => Number(r?.prNumber ?? r?.pr ?? r?.number) === n);
  const clip = (x) => String(x).replace(/\s+/g, ' ').slice(0, 200);
  for (const key of ['notStarted', 'failed', 'pendingNotDispatched', 'refusals']) {
    for (const r of rowsFor(result[key])) {
      parts.push(`${key}: ${clip(r.reason ?? r.error ?? r.kind ?? (Array.isArray(r.reasons) ? r.reasons.join('; ') : JSON.stringify(r)))}`);
    }
  }
  if ((Array.isArray(result.liveProcessPrs) ? result.liveProcessPrs : []).some((r) => Number(r?.prNumber ?? r) === n)) parts.push('a live process still holds this PR');
  for (const key of ['deferredForLanes', 'deferredForCap', 'deferredForAuth']) {
    if (Number(result[key]) > 0) parts.push(`${key}=${result[key]}${key === 'deferredForCap' && result.deferredForCapReason ? ` (${clip(result.deferredForCapReason)})` : ''}`);
  }
  const lines = (Array.isArray(entry?.logs) ? entry.logs : []).filter((l) => new RegExp(`#${n}(?![0-9])`).test(String(l)));
  for (const l of lines.slice(0, 3)) parts.push(`log: ${clip(l)}`);
  const dispatched = Array.isArray(result.dispatched) ? result.dispatched.map((d) => d?.prNumber ?? d?.pr).join(',') : '';
  parts.push(`reviewsOwed=${result.reviewsOwed ?? '?'} dispatched=[${dispatched}]`);
  return parts.join(' | ');
}

/**
 * Check one finished tick. Pure.
 * @param {object} o
 * @param {string} o.daemon
 * @param {number} o.index - this daemon's own tick count so far (0-based).
 * @param {{result?:any, error?:string|null, onTickError?:string|null, restart?:boolean, ms?:number}} o.entry
 * @param {{dirty:string[], behind:number, missing?:Array<{sha:string, atTick:number}>}} o.facts
 * @param {number} [o.totalTicks] - daemon ticks run so far across every daemon (for `lag`).
 * @param {boolean} o.stale - the daemon's own `hasStaleMainRefusal(result)`.
 * @param {number} o.staleStreak - consecutive stale ticks INCLUDING this one.
 * @param {Array<{pr:number, kind:string, sinceTick:number}>} o.owed - owed work this daemon owns, still undispatched.
 * @param {typeof DEFAULT_BOUNDS} o.bounds
 * @returns {Array<{invariant:string, detail:string}>}
 */
export function checkTick({ daemon, index, entry, facts, stale, staleStreak, owed = [], bounds = DEFAULT_BOUNDS, totalTicks = null }) {
  const v = [];
  if (facts.dirty.length) v.push({ invariant: 'clean', detail: `clone is dirty: ${facts.dirty.slice(0, 5).join(' | ')}` });
  if (facts.behind > bounds.maxBehind) {
    v.push({ invariant: 'behind', detail: `clone is ${facts.behind} main moves behind origin/main (max ${bounds.maxBehind})` });
  }
  const oldest = (facts.missing ?? []).find((m) => m && Number.isFinite(m.atTick));
  if (oldest && Number.isFinite(totalTicks) && totalTicks - oldest.atTick > bounds.maxLagTicks) {
    v.push({ invariant: 'lag', detail: `main move ${String(oldest.sha).slice(0, 9)} still not adopted ${totalTicks - oldest.atTick} ticks after it landed (max ${bounds.maxLagTicks})` });
  }
  if (Number.isFinite(entry.ms) && entry.ms > bounds.tickBoundMs) {
    v.push({ invariant: 'bounded', detail: `tick took ${entry.ms}ms (bound ${bounds.tickBoundMs}ms)` });
  }
  if (entry.error) v.push({ invariant: 'no-throw', detail: `tickOnce threw: ${String(entry.error).split('\n')[0]}` });
  if (entry.onTickError) v.push({ invariant: 'no-onTick-crash', detail: `onTick threw: ${String(entry.onTickError).split('\n')[0]}` });
  if (stale && staleStreak > bounds.staleStreakMax) {
    v.push({ invariant: 'stale', detail: `${daemon} refused work as stale-main ${staleStreak} ticks in a row (max ${bounds.staleStreakMax})` });
  }
  for (const o of owed) {
    const waited = index - o.sinceTick + 1;
    if (waited > bounds.owedGraceTicks) {
      const why = o.why ? `; daemon said: ${o.why}` : '';
      v.push({ invariant: 'owed', detail: `PR #${o.pr} owed ${o.kind} for ${waited} ${daemon} ticks with no dispatch (grace ${bounds.owedGraceTicks})${why}` });
    }
  }
  return v;
}

/** One compact per-tick report line — the soak's proof output. */
export function formatTickLine({ round, daemon, index, entry, facts, stale, violations }) {
  const kind = entry.restart ? 'restart' : entry.error ? 'threw' : 'ok';
  const dispatched = Array.isArray(entry.result?.dispatched) ? entry.result.dispatched.length : 0;
  const marks = [
    facts.dirty.length ? 'DIRTY' : 'clean',
    `behind=${facts.behind}`,
    `${entry.ms ?? '?'}ms`,
    entry.onTickError ? 'ONTICK-CRASH' : 'onTick-ok',
    stale ? 'STALE' : 'fresh',
    `dispatched=${dispatched}`,
  ];
  const head = `r${String(round).padStart(2, '0')} ${daemon.padEnd(12)} #${String(index).padStart(2, '0')} ${kind.padEnd(7)}`;
  return `${head} ${marks.join(' ')}${violations.length ? `  VIOLATION: ${violations.map((x) => `[${x.invariant}] ${x.detail}`).join('; ')}` : '  invariants ok'}`;
}
