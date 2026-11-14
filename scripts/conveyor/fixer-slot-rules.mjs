/**
 * @file scripts/conveyor/fixer-slot-rules.mjs
 * @description The fixer slot and push-on-green RULES, as pure decisions over plain facts (we:backlog/xn025gx, slice 2 of the
 *   approved fixer proposal, operator rulings P1/P2 of 2026-10-08). Written to move into the delivery standard as-is: the
 *   rule functions take plain facts and hold no GitHub, label, process or file detail. Only the settings resolver reads
 *   the declared settings file. The loop and every other read/write live in the core implementation around them (we:scripts/conveyor/await-verify-loop.mjs, we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs).
 *
 * THE RULES
 *   R1 fix-slot-state      — what one fix session is, for the slot count: `active` | `parked` | `resume-owed`.
 *   R2 fix-slot-count      — how many slots the sessions occupy (P1: a parked session gives its slot back; a decided
 *                            resume keeps one reserved so no new dispatch can take it; parked sessions are themselves capped).
 *   R3 resume-admission    — which owed resumes may wake now (P1: resumes go first, oldest wait first, within the cap).
 *   R4 push-wake-cadence   — who runs the verify-verdict pass and how often (P2: a fast local loop; the fix tick only when
 *                            the loop is off or not alive). The push decision itself is
 *                            we:scripts/conveyor/await-verify-pass.mjs#classifyAwaitVerdict (pure, exact-sha, unchanged).
 *   R5 release-on-completion — a fix claim is released as soon as its session's completion record says `done`.
 *
 * THE SETTINGS (declared in we:scripts/dispatch-settings.json `fixDispatch`, merged with the other declared settings
 * by we:scripts/lib/settings-files.mjs; each overridable by env; the BUILT-IN value is today's behaviour, so removing the
 * file entry turns the feature off):
 *   awaitVerifyLoopSeconds  env WE_AWAIT_VERIFY_LOOP_SECONDS   built-in 0 (off: the pass runs once per fix tick)
 *   parkedReleasesSlot      env WE_FIX_PARKED_RELEASES_SLOT    built-in off (off: a parked session holds its slot)
 *   parkedCapFactor         env WE_FIX_PARKED_CAP_FACTOR       built-in 2 (live sessions incl. parked ≤ factor × cap)
 *   releaseOnCompletion     env WE_FIX_RELEASE_ON_COMPLETION   built-in off (off: release waits for the next claim sweep)
 */
import { readSettings } from '../lib/settings-files.mjs';
import { isHarnessRecord, previousCiFailurePending } from './await-verify.mjs';

export const FIXER_SLOT_SETTINGS_BUILT_IN = Object.freeze({
  awaitVerifyLoopSeconds: 0, parkedReleasesSlot: false, parkedCapFactor: 2, releaseOnCompletion: false,
});
export const FIXER_SLOT_SETTINGS_ENV = Object.freeze({
  awaitVerifyLoopSeconds: 'WE_AWAIT_VERIFY_LOOP_SECONDS',
  parkedReleasesSlot: 'WE_FIX_PARKED_RELEASES_SLOT',
  parkedCapFactor: 'WE_FIX_PARKED_CAP_FACTOR',
  releaseOnCompletion: 'WE_FIX_RELEASE_ON_COMPLETION',
});
/** The loop never runs faster than this, whatever the setting says. */
export const MIN_LOOP_SECONDS = 5;

const onOff = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (v === true || s === 'on') return true;
  if (v === false || s === 'off') return false;
  return null;
};
const seconds = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n === 0 ? 0 : Math.max(MIN_LOOP_SECONDS, Math.floor(n));
};
const factor = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? n : null;
};
const PARSE = { awaitVerifyLoopSeconds: seconds, parkedReleasesSlot: onOff, parkedCapFactor: factor, releaseOnCompletion: onOff };

/** Every setting: a valid env value wins, then a valid file value (`fixDispatch.<key>`), then the built-in. Never throws. */
export function resolveFixerSlotSettings({ env = process.env, file } = {}) {
  let raw = file;
  if (raw === undefined) raw = readSettings();
  const block = raw && typeof raw === 'object' && raw.fixDispatch && typeof raw.fixDispatch === 'object' ? raw.fixDispatch : {};
  const out = {};
  for (const key of Object.keys(FIXER_SLOT_SETTINGS_BUILT_IN)) {
    const fromEnv = PARSE[key](env?.[FIXER_SLOT_SETTINGS_ENV[key]]);
    const fromFile = PARSE[key](block[key]);
    out[key] = fromEnv ?? fromFile ?? FIXER_SLOT_SETTINGS_BUILT_IN[key];
  }
  return out;
}

/**
 * R1 fix-slot-state. Facts: does the session have a recorded verify wait, when was it requested, and has the verdict
 * already been decided (pushed or red, so the session is owed a wake-up)? A wait older than `ttlMs` (or from the future)
 * is not trusted: the session counts as active, the safe side.
 * @param {{wait:null|{requestedAtMs:number, verdictDecided:boolean}, nowMs:number, ttlMs:number}} facts
 * @returns {'active'|'parked'|'resume-owed'}
 */
export function fixSlotState({ wait, nowMs, ttlMs }) {
  if (!wait || !Number.isFinite(wait.requestedAtMs) || !Number.isFinite(nowMs) || !(ttlMs > 0)) return 'active';
  const age = nowMs - wait.requestedAtMs;
  if (age < 0 || age > ttlMs) return 'active';
  return wait.verdictDecided ? 'resume-owed' : 'parked';
}

/**
 * R2 fix-slot-count. The number compared against the cap (a new dispatch is admitted while it is below `cap`).
 *   off: every live session counts (today).
 *   on:  active + resume-owed sessions count; a parked one does not — until the live total reaches
 *        `parkedCapFactor × cap`, so parked sessions cannot pile up without bound.
 * Equivalent admission: active + owed < cap AND total < factor × cap.
 * @param {{states:string[], cap:number, parkedReleasesSlot:boolean, parkedCapFactor?:number}} facts
 * @returns {number}
 */
export function fixSlotCount({ states, cap, parkedReleasesSlot, parkedCapFactor = FIXER_SLOT_SETTINGS_BUILT_IN.parkedCapFactor }) {
  const list = Array.isArray(states) ? states : [];
  if (!parkedReleasesSlot) return list.length;
  const working = list.filter((s) => s !== 'parked').length;
  const ceilingSpill = list.length - Math.floor(cap * Math.max(1, parkedCapFactor)) + cap;
  return Math.max(working, ceilingSpill);
}

/**
 * R2, as a subset: which sessions to present to a counter that counts list length. Working sessions first, then just
 * enough parked ones to reach {@link fixSlotCount}. Items keep their order otherwise. Pure.
 * @template T
 * @param {{items:Array<{state:string, item:T}>, cap:number, parkedReleasesSlot:boolean, parkedCapFactor?:number}} o
 * @returns {T[]}
 */
export function slotCountedItems({ items, cap, parkedReleasesSlot, parkedCapFactor }) {
  const list = Array.isArray(items) ? items : [];
  const n = fixSlotCount({ states: list.map((x) => x.state), cap, parkedReleasesSlot, parkedCapFactor });
  const working = list.filter((x) => x.state !== 'parked');
  const parked = list.filter((x) => x.state === 'parked');
  return [...working, ...parked].slice(0, n).map((x) => x.item);
}

/** Classify only the two phase-A waits the pass cannot wake. Other waits retain admission. */
export function classifyUnwakeableWait(row) {
  if (row?.action !== 'wait') return null;
  if (row.reason === 'previous-head CI repair must be verified and re-marked') return 'delivered-previous-ci';
  if (typeof row.result === 'string' && row.result.startsWith('resume-exhausted')) return 'resume-exhausted';
  return null;
}

/** New work may retire an unwakeable wait only with explicit evidence that its session is no longer live. */
export function shouldRetireUnwakeable({ reason, sessionLive, newerVerdict }) {
  return (reason === 'delivered-previous-ci' || reason === 'resume-exhausted')
    && sessionLive === false && newerVerdict === true;
}

export const STALE_HEAD_GRACE_MS = 60_000;

/** Stale owed keys. PR facts are a Map keyed by record key; unknown facts retain the record.
 * Only an explicitly closed PR, an open PR whose readable head sha differs from the record's (any session), or a valid, strictly newer, different SHA in the same repo/PR, kind and session lineage
 * retires a wait. Preserve pending previousCi failure inventory (previousCiFailurePending) even after PR closure or a moved head; normal cleanup may still need its repair handoff.
 * Clean previousCi metadata (empty or already handed-off inventory, as the pushAfterCi gate writes on success) never keeps an obsolete wait.
 * When either session id is missing, lineage requires both the same lane and worker name.
 * `records` may include newer waits that have not yet become owed. */
export function classifyStaleOwed({ owed, prFacts = new Map(), records = owed, nowMs = Date.now() }) {
  // Only a `green` wait (its sha was pushed by phase A before the head was read), pushed (pendingResume.at) long enough ago that a lagging head read
  // cannot predate the push; records written before `at` existed fall back to requestedAt. red / escalate / push-refused waits may name a never-pushed sha and are always kept.
  const movedHead = (r, f) => r.pendingResume?.kind === 'green' && nowMs - Date.parse(r.pendingResume.at ?? r.requestedAt) >= STALE_HEAD_GRACE_MS && f?.open === true && /^[0-9a-f]{40}$/i.test(String(f.headSha ?? '')) && /^[0-9a-f]{40}$/i.test(String(r.sha ?? ''))
    && f.headSha.toLowerCase() !== r.sha.toLowerCase();
  return owed.filter(({ key, record: r }) => (prFacts.get(key)?.open === false && !previousCiFailurePending(r))
    // Any session: an owed wait for a sha that is no longer the open PR's head is obsolete. Unreadable head keeps it.
    || (!previousCiFailurePending(r) && movedHead(r, prFacts.get(key)))
    || (!previousCiFailurePending(r) && records.some(({ record: newer }) => isHarnessRecord(newer) && r.repo && r.pr && r.sha
      && newer.repo === r.repo && newer.pr === r.pr && newer.sha.toLowerCase() !== String(r.sha).toLowerCase()
      && newer.kind === r.kind
      && (r.sessionId && newer.sessionId
        ? r.sessionId === newer.sessionId
        : r.lane && newer.lane === r.lane && r.who && newer.who === r.who)
      && Date.parse(newer.requestedAt) > Date.parse(r.requestedAt))))
    .map(({ key }) => key);
}

/**
 * R3 resume-admission. Facts: the owed resumes (`key`, when the wait began) and how many sessions are working now.
 *   off: every owed resume wakes (today).
 *   on:  oldest wait first, while working + woken < cap. The rest wait; they still hold their reserved slot (R2), so
 *        no new dispatch can take it first.
 * @param {{owed:Array<{key:string, requestedAtMs:number}>, activeCount:number, cap:number, parkedReleasesSlot:boolean}} facts
 * @returns {{admit:string[], defer:string[]}}
 */
export function admitResumes({ owed, activeCount, cap, parkedReleasesSlot }) {
  const list = (Array.isArray(owed) ? owed : []).slice()
    .sort((a, b) => (a.requestedAtMs - b.requestedAtMs) || String(a.key).localeCompare(String(b.key)));
  if (!parkedReleasesSlot) return { admit: list.map((o) => o.key), defer: [] };
  const free = Math.max(0, cap - Math.max(0, activeCount));
  return { admit: list.slice(0, free).map((o) => o.key), defer: list.slice(free).map((o) => o.key) };
}

/**
 * R4 push-wake-cadence. Who runs the verify-verdict pass this time.
 *   loop off (0 s)          → the fix tick runs it (today).
 *   loop on and alive       → the loop runs it every `awaitVerifyLoopSeconds`; the tick skips it.
 *   loop on but not alive   → the tick runs it (fallback, never a gap).
 * A heartbeat older than three loop periods (and never under 2 min) means not alive.
 * @param {{loopSeconds:number, loopHeartbeatAtMs:number|null, nowMs:number}} facts
 * @returns {{runner:'tick'|'loop', reason:string}}
 */
export function awaitPassRunner({ loopSeconds, loopHeartbeatAtMs, nowMs }) {
  if (!(loopSeconds > 0)) return { runner: 'tick', reason: 'loop-off' };
  const staleMs = Math.max(120_000, loopSeconds * 3_000);
  if (!Number.isFinite(loopHeartbeatAtMs) || nowMs - loopHeartbeatAtMs > staleMs) return { runner: 'tick', reason: 'loop-not-alive' };
  return { runner: 'loop', reason: 'loop-alive' };
}

/**
 * R5 release-on-completion. Facts: the claim (when taken, which session if known), the session's completion record, and
 * whether the session still has a recorded verify wait, and when the harness last woke it.
 * Released only when ALL hold: the setting is on; the record says `done`; it was written at or after the claim was
 * taken (an older round's record never releases a new claim) AND strictly after the session's last wake-up (a session
 * woken to repair a red is working again, whatever it reported before; a record in the very same millisecond as the stamp
 * cannot be ordered against it, so it is held); the session ids agree when both are known;
 * and no verify wait is still recorded (the session may yet be woken).
 * @param {{enabled:boolean, claim:{claimedAtMs:number, sessionId:string|null},
 *   completion:null|{status:string, updatedAtMs:number, sessionId:string|null}, awaitingVerify:boolean,
 *   lastWokenAtMs?:number|null}} facts
 * @returns {{release:boolean, reason:string}}
 */
export function releaseOnCompletion({ enabled, claim, completion, awaitingVerify, lastWokenAtMs = null }) {
  if (!enabled) return { release: false, reason: 'off' };
  if (!completion) return { release: false, reason: 'no-completion-record' };
  if (completion.status !== 'done') return { release: false, reason: `completion-${completion.status ?? 'unknown'}` };
  if (!Number.isFinite(claim?.claimedAtMs) || !Number.isFinite(completion.updatedAtMs)) return { release: false, reason: 'unknown-times' };
  if (completion.updatedAtMs < claim.claimedAtMs) return { release: false, reason: 'record-older-than-claim' };
  if (Number.isFinite(lastWokenAtMs) && completion.updatedAtMs <= lastWokenAtMs) return { release: false, reason: 'record-older-than-last-wake' };
  if (claim.sessionId && completion.sessionId && claim.sessionId !== completion.sessionId) return { release: false, reason: 'other-session' };
  if (awaitingVerify) return { release: false, reason: 'still-awaiting-verify' };
  return { release: true, reason: 'completion-done' };
}
