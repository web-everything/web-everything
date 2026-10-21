/**
 * @file skills-src/conveyor/review-refill.mjs
 * @description Card x3mfxzv (prototype, SHADOW ONLY) - refill review slots when a review job finishes, instead of
 *   waiting for the next daemon pass (a pass takes ~11 min; three jobs finished within 6 min of dispatch on
 *   2026-10-20 and five slots sat empty ~15 min).
 *
 *   Design (v2, after two audit rounds showed that re-running the pass's planner is not write-free): the refill
 *   NEVER plans. It keeps the queue the LAST PASS already computed: the pass's own review rows that it did not
 *   dispatch, put in the pass's own priority order (`orderReviewsForDispatch`, injected - not copied), with each
 *   PR's head sha at plan time. When the live-round count drops (a job exited) it waits ~15 s, then takes the
 *   next queued PRs, one per freed seat, after cheap revalidation only:
 *     - the live-review cap has room (`budget()` = the pass's `liveReviewRoundBudget`, a read-only `ps`),
 *     - the PR is still OPEN and its head sha is unchanged (ONE read-only `gh pr view` per candidate).
 *   It logs `refill-shadow: would dispatch #N now (slot freed at T by ...)` and NEVER dispatches. When a later pass
 *   really dispatches that PR it logs the idle-slot minutes saved. No reconcile, no git, no lane-pool, no file
 *   writes: the only IO is the injected `budget`, the injected `readPr`, and reading the settings file.
 *
 *   Known limits (by design, shadow): the queue is as old as the last pass (dropped after 25 min); red-team rows
 *   and same-pass promotions are not in it; lane availability is not checked (the cap is the binding limit).
 *
 *   Setting: `review.refillOnCompletion` = off | shadow | on, through the policy cascade (standard off;
 *   `scripts/settings/review-refill.json` sets this repo to shadow; env WE_REVIEW_REFILL_ON_COMPLETION). The source
 *   is logged. `on` is NOT built and behaves as shadow.
 *
 *   Fail closed: unreadable `ps`, missing/zero cap room, stale or missing queue, a busy pass, an unreadable or
 *   changed PR - each does nothing for that candidate (or at all) and waits for the pass.
 *
 *   Single-flight: `lock` is one mutex shared by the pass and the refill. The refill only TRY-acquires (busy =
 *   skip); the pass waits for it.
 *
 *   Ruling (operator, 2026-10-20): the daemon's own log wrapper may rotate its log files when ANY log line is written.
 *   That is the daemon's logging, not a write by the refill. The refill writes nothing itself, silences the
 *   cascade's own source line, and calls `liveReviewRoundBudget` exactly as the pass does (no extra logging added).
 *
 * THE HOOK in `skills-src/conveyor/review-daemon.mjs` (not applied yet: the file is held by open PRs). 4 small edits:
 *
 *   1. top of file:
 *        import { createReviewRefill } from './review-refill.mjs';
 *   2. in `buildCliDaemonEffects`, before `return {`:
 *        const refill = createReviewRefill({ budget: liveReviewRoundBudget, order: orderReviewsForDispatch, log: (l) => log.error(l) });
 *        refill.start();
 *   3. `tickOnce: () => withReviewFetchTick(async () => {`  becomes
 *        `tickOnce: () => refill.guardPass(() => withReviewFetchTick(async () => {`   and its closing `}),` becomes `})),`
 *   4. in `tickOnce`, wrap the existing plan tap so the refill sees every repo's plan:
 *        `const onPlan = refill.tapPlan(sharing.reusePlan ? ({ repo, plan, rawPrs }) => plans.set(repo, { plan, rawPrs }) : null);`
 *   (There is no `onTick` edit: `guardPass` receives the pass's own result from `tickOnce` and captures the queue and
 *   the idle-minutes comparison itself, before it releases the lock.)
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from '../../scripts/lib/policy-cascade.mjs';

export const REFILL_MODES = Object.freeze(['off', 'shadow', 'on']);
export const DEFAULT_DEBOUNCE_MS = 15_000;
export const DEFAULT_POLL_MS = 5_000;
/** Never run the revalidation (gh reads) more often than this, however many jobs finish. */
export const DEFAULT_MIN_PLAN_GAP_MS = 30_000;
/** A queue older than this is not trusted. */
export const QUEUE_MAX_AGE_MS = 25 * 60_000;
/** A "would dispatch" the pass never confirmed is dropped (and logged) after this long. */
export const WOULD_TTL_MS = 30 * 60_000;
/** At most this many PR reads per flush, however many fail revalidation. */
export const MAX_READS_PER_FLUSH = 6;

const SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/settings/review-refill.json');

/** review.refillOnCompletion through the cascade: env > settings file > standard 'off'. Never throws. */
export function resolveRefillMode({ env = process.env, toolPath = SETTINGS_PATH, cascade = cascadePolicy } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(toolPath, 'utf8')); } catch { tool = undefined; }
  const raw = env?.WE_REVIEW_REFILL_ON_COMPLETION;
  try {
    const r = cascade('reviewRefill', tool && tool.refillOnCompletion !== undefined ? { refillOnCompletion: tool.refillOnCompletion } : undefined, {
      env, standard: { refillOnCompletion: 'off' },
      envValues: { refillOnCompletion: typeof raw === 'string' && REFILL_MODES.includes(raw) ? raw : undefined },
      valid: { refillOnCompletion: (v) => REFILL_MODES.includes(v) },
      // The cascade's own source line goes to console.error, which in a daemon can rotate its log files. Silence it;
      // the resolved source is logged once by `start()` through the daemon's normal log path instead.
      log: () => {},
    });
    const mode = r.value?.refillOnCompletion;
    if (!REFILL_MODES.includes(mode)) return { mode: 'off', source: 'standard' };
    return { mode, source: r.sources?.refillOnCompletion ?? 'standard' };
  } catch { return { mode: 'off', source: 'standard' }; }
}

/** The one outside read: `gh pr view` of one PR (read-only). Returns {state, headRefOid} or throws. */
export function createGhPrReader({ exec = execFileSync } = {}) {
  return ({ repo, pr }) => {
    const out = exec('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'state,headRefOid'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL' });
    return JSON.parse(out);
  };
}

/** One mutex for the pass and the refill. `tryAcquire` never waits; `acquire` waits its turn. Both return a release fn. */
export function createPassLock() {
  let holder = null;
  const waiters = [];
  const grant = (owner) => {
    holder = owner;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      holder = null;
      const next = waiters.shift();
      if (next) next.resolve(grant(next.owner));
    };
  };
  return {
    holder: () => holder,
    tryAcquire: (owner) => (holder === null ? grant(owner) : null),
    acquire: (owner) => (holder === null ? Promise.resolve(grant(owner)) : new Promise((resolve) => waiters.push({ owner, resolve }))),
  };
}

const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19) + 'Z';
const keyOf = (repo, pr) => `${repo}#${pr}`;

/**
 * @param {object} o
 * @param {()=>({left:number, live?:number}|null)} o.budget fresh live-round budget (`liveReviewRoundBudget`)
 * @param {(reviews:object[], ctx:{labelsByPr:Map, plan:object})=>object[]} [o.order] the pass's own priority order
 * @param {({repo:string, pr:number})=>({state:string, headRefOid:string})} [o.readPr] read-only PR view
 * @param {(line:string)=>void} o.log
 * @param {(prev:number, live:number)=>string} [o.identify] optional: names the finished job(s), e.g. "#5690"
 */
export function createReviewRefill({
  budget, order = (reviews) => reviews, readPr = createGhPrReader(), log = () => {},
  settings = () => resolveRefillMode(), identify = null,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, setPoll = setInterval, clearPoll = clearInterval,
  debounceMs = DEFAULT_DEBOUNCE_MS, pollMs = DEFAULT_POLL_MS, minPlanGapMs = DEFAULT_MIN_PLAN_GAP_MS,
  lock = createPassLock(),
} = {}) {
  let prevLive = null;       // last known live-round count; null = unknown (seed on next good read)
  let freed = [];            // [{at, by}] slots freed and not yet matched to a would-dispatch
  const would = new Map();   // "repo#pr" -> {at, by}
  let planning = new Map();  // plans seen during the pass now running: repo -> {plan, rawPrs}
  let queue = null;          // {at, rows:[{repo, prNumber, head}]} from the last finished pass
  let timer = null;
  let pollTimer = null;
  let lastFlushAt = -Infinity;
  let announcedMode = null;
  let savedMinutes = 0;
  // Logging is best-effort: a throwing logger must never change what the refill decides or keeps.
  const say = (line) => { try { log(line); } catch { /* logging never changes behavior */ } };
  const mode = () => {
    let s;
    try { s = settings(); } catch { s = { mode: 'off', source: 'standard' }; }
    const key = `${s.mode}/${s.source}`;
    if (key !== announcedMode) { announcedMode = key; try { say(`refill: review.refillOnCompletion=${s.mode} (${s.source})${s.mode === 'on' ? ' - on is not built yet, running as shadow' : ''}`); } catch { /* log only */ } }
    return s.mode;
  };

  function readLive() {
    try { const b = budget(); return b && Number.isFinite(b.live) ? b.live : null; } catch { return null; }
  }

  /** The pass's `onPlan`, tapped: remember each repo's plan, then call the existing consumer unchanged. */
  function tapPlan(next = null) {
    return (info) => {
      try { if (info?.repo && info.plan) planning.set(info.repo, { plan: info.plan, rawPrs: info.rawPrs, at: now() }); } catch { /* observation only */ }
      return typeof next === 'function' ? next(info) : undefined;
    };
  }

  /** One watch step: a drop in live rounds means slot(s) freed. Unreadable = keep the old count, do nothing. */
  function poll() {
    if (mode() === 'off') { prevLive = null; return; }
    const live = readLive();
    if (live === null) return;
    if (prevLive !== null && live < prevLive) {
      const at = now();
      let by = 'a review job';
      try { by = identify?.(prevLive, live) || by; } catch { /* name is cosmetic */ }
      for (let i = 0; i < prevLive - live; i++) freed.push({ at, by: `${by} (live ${prevLive}->${live})` });
      schedule();
    }
    prevLive = live;
  }

  function schedule() {
    if (timer !== null) return; // debounce: one trailing flush
    timer = setTimer(() => { timer = null; try { flush(); } catch { /* fail closed */ } }, debounceMs);
    timer?.unref?.();
  }

  /** Take the next queued PRs, one per freed seat, after revalidation. Does nothing on any doubt. Returns logged rows. */
  function flush() {
    if (mode() === 'off') { freed = []; return []; }
    const t = now();
    for (const [k, w] of would) if (t - w.at > WOULD_TTL_MS) { would.delete(k); say(`refill-shadow: ${k} was never dispatched by a pass within ${WOULD_TTL_MS / 60_000} min - dropped`); }
    if (!freed.length) return [];
    if (t - lastFlushAt < minPlanGapMs) { schedule(); return []; }
    const release = lock.tryAcquire('refill');
    if (!release) return []; // a pass is running: it will dispatch
    const out = [];
    try {
      lastFlushAt = t;
      if (!queue || t - queue.at > QUEUE_MAX_AGE_MS) return []; // no trusted queue: wait for the pass
      const b = budget();
      if (!b || !Number.isFinite(b.left) || b.left <= 0) return []; // unknown or full: fail closed
      const seats = Math.min(freed.length, b.left);
      let reads = 0;
      for (const row of queue.rows) {
        if (out.length >= seats || reads >= MAX_READS_PER_FLUSH) break;
        if (would.has(keyOf(row.repo, row.prNumber)) || !row.head) continue;
        reads++;
        let view;
        try { view = readPr({ repo: row.repo, pr: row.prNumber }); } catch { continue; } // unreadable: skip it
        if (!view || String(view.state).toUpperCase() !== 'OPEN') continue;
        if (String(view.headRefOid ?? '').toLowerCase() !== String(row.head).toLowerCase()) continue;
        const slot = freed.shift();
        would.set(keyOf(row.repo, row.prNumber), { at: t, by: slot.by, freedAt: slot.at });
        out.push(row);
        say(`refill-shadow: would dispatch #${row.prNumber} now (${row.repo}; slot freed at ${hhmmss(slot.at)} by ${slot.by})`);
      }
    } catch (e) {
      say(`refill-shadow: failed, waiting for the pass: ${String(e?.message ?? e).split('\n')[0]}`);
    } finally { release(); }
    return out;
  }

  /** Rebuild the queue from the plans this pass saw: owed reviews it did not dispatch, in the pass's own order. */
  function buildQueue(result) {
    const sent = new Set([...(result?.dispatched ?? []), ...(result?.notStarted ?? [])].map((d) => keyOf(d.repo, d.prNumber)));
    const rows = [];
    for (const [repo, { plan, rawPrs }] of planning) {
      const prs = Array.isArray(rawPrs) ? rawPrs : [];
      const labelsByPr = new Map(prs.map((p) => [Number(p?.number), p?.labels ?? []]));
      const reviews = (plan?.dispatch ?? []).filter((d) => d && d.kind === 'review');
      const ordered = order([...reviews], { labelsByPr, plan });
      for (const d of ordered) {
        if (sent.has(keyOf(repo, d.prNumber))) continue;
        const pr = prs.find((p) => Number(p?.number) === Number(d.prNumber));
        rows.push({ repo, prNumber: d.prNumber, head: pr?.headRefOid ?? null });
      }
    }
    return rows;
  }

  /** The pass finished: match what it dispatched against earlier would-dispatches, and keep its leftover queue. */
  function notePass(result) {
    if (mode() === 'off' || result?.skipped) { planning = new Map(); return; } // no plan was made: keep any older queue, which keeps aging
    const end = now();
    // The queue ages from when its OLDEST plan was captured, not from when the pass ended.
    try { queue = planning.size ? { at: Math.min(...[...planning.values()].map((p) => p.at)), rows: buildQueue(result) } : null; } catch { queue = null; } // doubt: no queue
    planning = new Map();
    freed = []; // the pass just refilled whatever it could
    // The queue is already replaced; this idle-minutes comparison is best-effort and cannot leave an old queue behind.
    try {
      for (const d of (Array.isArray(result?.dispatched) ? result.dispatched : [])) {
        const k = keyOf(d.repo, d.prNumber);
        const w = would.get(k);
        if (!w) continue;
        would.delete(k);
        const at = Number.isFinite(d.at) ? d.at : end; // pass end is an upper bound when the dispatch time is not recorded
        const mins = Math.max(0, (at - w.at) / 60_000);
        savedMinutes += mins;
        say(`refill-shadow: pass dispatched #${d.prNumber} (${d.repo}) ${mins.toFixed(1)} min after the refill would have${Number.isFinite(d.at) ? '' : ' (upper bound: pass end time)'}; idle-slot minutes saved ${mins.toFixed(1)}, total ${savedMinutes.toFixed(1)}`);
      }
    } catch { /* comparison only */ }
  }

  async function guardPass(fn) {
    const release = await lock.acquire('pass');
    planning = new Map(); // plans left by an earlier aborted pass are never trusted
    try {
      const out = await fn();
      // The guarded function returns the pass's own result (dispatched, notStarted, skipped...). Capture the queue
      // HERE, while the plans are still held, so a successful pass always leaves its queue behind.
      try { notePass(out); } catch { /* doubt: no queue */ }
      return out;
    } catch (e) {
      queue = null; // an aborted pass is doubt: an older queue is not trusted either
      throw e;
    } finally { planning = new Map(); release(); } // an aborted pass leaves nothing behind
  }

  function start() {
    if (pollTimer !== null) return stop;
    mode(); // logs the resolved setting and its source once, through the daemon's normal log
    pollTimer = setPoll(() => { try { poll(); } catch { /* fail closed */ } }, pollMs);
    pollTimer?.unref?.();
    return stop;
  }
  function stop() {
    if (pollTimer !== null) { clearPoll(pollTimer); pollTimer = null; }
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  return { poll, flush, notePass, tapPlan, guardPass, start, stop, lock,
    _state: () => ({ prevLive, freed: [...freed], would: new Map(would), queue, savedMinutes }) };
}
