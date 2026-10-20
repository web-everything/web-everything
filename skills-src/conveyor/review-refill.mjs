/**
 * @file skills-src/conveyor/review-refill.mjs
 * @description Card x3mfxzv (prototype, SHADOW ONLY) — refill review slots when a review job finishes, instead of
 *   waiting for the next daemon pass (a pass takes ~11 min; three jobs finished within 6 min of dispatch on
 *   2026-10-20 and five slots sat empty ~15 min).
 *
 *   What it does: it watches the live review-round count. When the count drops (a job exited) it waits ~15 s
 *   (debounce), then asks "what would the pass dispatch right now?" by running the SAME `runReview` the pass runs,
 *   with every side effect replaced by a no-op and the dispatch replaced by a recorder. So eligibility, priority,
 *   lane and cap logic is the pass's own code, never a copy. It logs
 *   `refill-shadow: would dispatch #N now (slot freed at T by <who>)` and NEVER dispatches. Later, when the pass
 *   really dispatches that PR, it logs the idle-slot minutes saved.
 *
 *   Setting: `review.refillOnCompletion` = off | shadow | on, through the policy cascade (standard off;
 *   `scripts/settings/review-refill.json` sets this repo to shadow; env WE_REVIEW_REFILL_ON_COMPLETION). The source
 *   is logged. `on` is NOT built yet and behaves as shadow.
 *
 *   Fail closed: an unreadable process list, a missing cap, no free slot, a busy pass, a failed plan — all do
 *   nothing and wait for the pass.
 *
 *   Single-flight: `lock` is one mutex shared by the pass and the refill. The refill only ever TRY-acquires (busy =
 *   skip); the pass waits for it.
 *
 * THE HOOK in `skills-src/conveyor/review-daemon.mjs` (not applied yet: the file is held by open PRs). Exactly 5 lines:
 *
 *   1. top of file:
 *        import { createReviewRefill } from './review-refill.mjs';
 *   2. in `buildCliDaemonEffects`, right before `return {` (the object holding `tickOnce`):
 *        const refill = createReviewRefill({ runReview, budget: liveReviewRoundBudget, log: (l) => log.error(l) });
 *        refill.start();
 *   3. `tickOnce: () => withReviewFetchTick(async () => {`  becomes
 *        `tickOnce: () => refill.guardPass(() => withReviewFetchTick(async () => {`   and its closing `}),` becomes `})),`
 *   4. at the top of `onTick: (result) => {`, add:
 *        refill.notePass(result);
 *
 *   (`runReview` there is the `(opts) => runReviewTickAllRepos({...})` effect already defined in the same function;
 *   the refill passes it overrides that win because `...opts` is spread last.)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from '../../scripts/lib/policy-cascade.mjs';

export const REFILL_MODES = Object.freeze(['off', 'shadow', 'on']);
export const DEFAULT_DEBOUNCE_MS = 15_000;
export const DEFAULT_POLL_MS = 5_000;
/** Never run the (heavy) shadow plan more often than this, however many jobs finish. */
export const DEFAULT_MIN_PLAN_GAP_MS = 60_000;
/** A "would dispatch" the pass never confirmed is dropped (and logged) after this long. */
export const WOULD_TTL_MS = 30 * 60_000;

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
    });
    const mode = r.value?.refillOnCompletion;
    if (!REFILL_MODES.includes(mode)) return { mode: 'off', source: 'standard' };
    return { mode, source: r.sources?.refillOnCompletion ?? 'standard' };
  } catch { return { mode: 'off', source: 'standard' }; }
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

/** Side-effect-free option overrides for the pass's own `runReview`: the pass's plan, none of its actions. */
export function shadowOverrides(recorder, { liveReviewBudget }) {
  const noop = () => {};
  return {
    liveReviewBudget,
    dispatch: (o) => { recorder.rows.push({ repo: o.repo, prNumber: o.pr }); return { mode: 'shadow', agentId: null }; },
    tagRound: noop, tagStatus: noop, notifyReferral: noop, finishRedTeamRequest: noop,
    holdReconcile: () => [],
    statusCandidates: () => [],
    refreshScopeBloat: null, postRefreshMarker: null, promoteDrafts: null, notePromotions: null, onPlan: null,
    poolExhaustion: null, log: noop,
  };
}

const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19) + 'Z';

/**
 * @param {object} o
 * @param {(opts:object)=>object} o.runReview the pass's own review run (daemon effect); called with shadow overrides
 * @param {()=>({left:number, live?:number}|null)} o.budget fresh live-round budget (`liveReviewRoundBudget`)
 * @param {(line:string)=>void} o.log
 * @param {()=>({mode:string, source:string})} [o.settings] re-read each use
 * @param {(prev:number, live:number)=>string} [o.identify] optional: names the finished job(s), e.g. "#5690"
 */
export function createReviewRefill({
  runReview, budget, log = () => {}, settings = () => resolveRefillMode(), identify = null,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, setPoll = setInterval, clearPoll = clearInterval,
  debounceMs = DEFAULT_DEBOUNCE_MS, pollMs = DEFAULT_POLL_MS, minPlanGapMs = DEFAULT_MIN_PLAN_GAP_MS,
  lock = createPassLock(),
} = {}) {
  let prevLive = null;       // last known live-round count; null = unknown (seed on next good read)
  let freed = [];            // [{at, by}] slots freed and not yet matched to a would-dispatch
  const would = new Map();   // "repo#pr" -> {at, by}
  let timer = null;
  let pollTimer = null;
  let lastPlanAt = -Infinity;
  let announcedMode = null;
  let savedMinutes = 0;
  const mode = () => {
    let s;
    try { s = settings(); } catch { s = { mode: 'off', source: 'standard' }; }
    const key = `${s.mode}/${s.source}`;
    if (key !== announcedMode) { announcedMode = key; try { log(`refill: review.refillOnCompletion=${s.mode} (${s.source})${s.mode === 'on' ? ' - on is not built yet, running as shadow' : ''}`); } catch { /* log only */ } }
    return s.mode;
  };

  function readLive() {
    try { const b = budget(); return b && Number.isFinite(b.live) ? b.live : null; } catch { return null; }
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

  /** The shadow plan. Does nothing (waits for the pass) on any doubt. Returns the logged rows. */
  function flush() {
    if (mode() === 'off') { freed = []; return []; }
    const t = now();
    for (const [k, w] of would) if (t - w.at > WOULD_TTL_MS) { would.delete(k); log(`refill-shadow: ${k} was never dispatched by a pass within ${WOULD_TTL_MS / 60_000} min - dropped`); }
    if (!freed.length) return [];
    if (t - lastPlanAt < minPlanGapMs) { schedule(); return []; }
    const release = lock.tryAcquire('refill');
    if (!release) return []; // a pass is running: it will dispatch
    let rows = [];
    try {
      lastPlanAt = t;
      const b = budget();
      if (!b || !Number.isFinite(b.left) || b.left <= 0) return []; // unknown or full: fail closed
      const recorder = { rows: [] };
      runReview(shadowOverrides(recorder, { liveReviewBudget: b }));
      rows = recorder.rows.filter((r) => !would.has(`${r.repo}#${r.prNumber}`)).slice(0, freed.length);
      for (const r of rows) {
        const slot = freed.shift();
        would.set(`${r.repo}#${r.prNumber}`, { at: t, by: slot.by, freedAt: slot.at });
        log(`refill-shadow: would dispatch #${r.prNumber} now (${r.repo}; slot freed at ${hhmmss(slot.at)} by ${slot.by})`);
      }
    } catch (e) {
      log(`refill-shadow: plan failed, waiting for the pass: ${String(e?.message ?? e).split('\n')[0]}`);
    } finally { release(); }
    return rows;
  }

  /** The pass finished: match what it really dispatched against earlier would-dispatches. */
  function notePass(result) {
    if (mode() === 'off') return;
    const end = now();
    for (const d of (Array.isArray(result?.dispatched) ? result.dispatched : [])) {
      const k = `${d.repo}#${d.prNumber}`;
      const w = would.get(k);
      if (!w) continue;
      would.delete(k);
      const at = Number.isFinite(d.at) ? d.at : end; // pass end is an upper bound when the dispatch time is not recorded
      const mins = Math.max(0, (at - w.at) / 60_000);
      savedMinutes += mins;
      log(`refill-shadow: pass dispatched #${d.prNumber} (${d.repo}) ${mins.toFixed(1)} min after the refill would have${Number.isFinite(d.at) ? '' : ' (upper bound: pass end time)'}; idle-slot minutes saved ${mins.toFixed(1)}, total ${savedMinutes.toFixed(1)}`);
    }
    // anything the pass already settled without dispatching stays until its TTL; a stale slot record would only mislead
    freed = [];
  }

  async function guardPass(fn) {
    const release = await lock.acquire('pass');
    try { return await fn(); } finally { release(); }
  }

  function start() {
    if (pollTimer !== null) return stop;
    pollTimer = setPoll(() => { try { poll(); } catch { /* fail closed */ } }, pollMs);
    pollTimer?.unref?.();
    return stop;
  }
  function stop() {
    if (pollTimer !== null) { clearPoll(pollTimer); pollTimer = null; }
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  return { poll, flush, notePass, guardPass, start, stop, lock, _state: () => ({ prevLive, freed: [...freed], would: new Map(would), savedMinutes }) };
}
