#!/usr/bin/env node
/**
 * @file scripts/conveyor/driver-watchdog.mjs
 * @description THE DRIVER WATCHDOG (epic #3383) — a deliberately SMALL, SEPARATE process that notices when the
 *   conveyor driver has gone **silently stale** (it did not crash; it is simply not making dispatch progress
 *   any more) and mechanically rolls its checkout back to the last known-good commit before restarting it.
 *
 * ── THE FAILURE THIS CATCHES, AND WHY NOTHING ELSE CATCHES IT ───────────────────────────────────────────────
 *
 * Every existing guard watches for a driver that STOPS: the singleton lease expires
 * ({@link ../../skills-src/conveyor/runner-lock.mjs}), the supervisor sees its child exit and respawns it, the
 * lease reaper sweeps what a dead process left behind. All of them key on absence — a missing heartbeat, a dead
 * pid, an exit row. None of them fires for the failure that actually happened today: a driver that is alive,
 * heartbeating its lease every tick, running its passes, and dispatching NOTHING, because the code it was just
 * restarted onto decides — wrongly, and every tick, identically — that there is nothing to dispatch. From the
 * outside that is indistinguishable from a healthy idle conveyor, which is exactly why it ran for hours.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO OBEY ───────────────────────────────────────────────────────────────────
 *
 * **IT MUST NOT SHARE THE DRIVER'S OWN DECISION LOGIC.** Not `we:scripts/conveyor/tick-core.mjs`, not
 * `we:scripts/readiness/dispatch-plan.mjs`, not `we:scripts/operations/dispatch-lane.mjs`, not the pause /
 * concurrency / scope levers they read. A watchdog that asked the driver's own planner "is there eligible
 * work?" would answer "no" for precisely the same wrong reason the driver did, and would sit silent through the
 * only failure it was built for. Shared code is shared failure.
 *
 * So "is there eligible work" is answered HERE, minimally, from the queue sidecar's own bytes: the queue is a
 * flat `[{num, addedAt}]` list ({@link ./queue-store.mjs}), and an entry that no live session is working is
 * eligible. That is a deliberately DUMBER question than the driver's — it knows nothing of lane concurrency,
 * pauses, blockers or drift holds — and the dumbness is the feature. The consequence is stated plainly rather
 * than hidden: this watchdog can call "eligible" what the driver correctly holds. That is why staleness needs a
 * long quiet period AND no in-flight work AND a live lease before it will act (see {@link classifyDriver}), and
 * why the rollback has its own independent refusals (see {@link decideRollback}).
 *
 * `scripts/conveyor/__tests__/driver-watchdog.test.mjs` asserts the import graph, so the rule above is a fact
 * about this file rather than a promise in this comment — the same technique `restart-runner.mjs`'s suite uses
 * for its own purity claim.
 *
 * WHAT IS SHARED, and why each is safe: {@link ./queue-store.mjs}'s `parseQueue`/`normNum` and
 * {@link ./driver-mode.mjs}'s `readDriverMode` (both are sidecar GRAMMAR — a second, looser parser here would
 * disagree with the writer about what is even recorded, which is a worse failure than the one being guarded),
 * and {@link ./branch-sync.mjs}'s `gitRun` / `notifyDesktop` / `decideEscalation` / `defaultAppendLog` (the
 * repo's existing ESCALATE-DURABLY pattern, #3472 — re-nag dedup included). None is dispatch logic; all are
 * graph-asserted.
 *
 * ── THE THREE PARTS ─────────────────────────────────────────────────────────────────────────────────────────
 *
 *   1. LAST KNOWN GOOD is RECORDED, never inferred. `driver-watchdog.mjs record-good` writes
 *      `<driver>/.conveyor/last-known-good.json` = `{sha, recordedAt, note}`. Whoever promotes the driver onto
 *      new code runs it FIRST, naming the commit the driver is LEAVING. Inferring the fallback (say, "HEAD~1",
 *      or the last commit with a green run) was rejected: the fallback is the one value that must be right when
 *      everything else has gone wrong, and an inferred one is only as good as the inference.
 *
 *   2. STALENESS is judged from four independent, driver-logic-free signals — see {@link readWatchdogFacts}.
 *
 *   3. HEALING is `git reset --hard <sha>` in the driver's checkout, then the EXISTING `restart-runner`
 *      operation. See {@link healDriver} for why the control plane is this checkout and the data plane is the
 *      rolled-back one.
 *
 * PURE-CORE / IO-SHELL SPLIT, the house shape ({@link ./branch-sync.mjs}, {@link ./queue-store.mjs}): every
 * judgment ({@link sessionMatchesItem} … {@link decideRollback}) takes plain objects and no fs/clock/process,
 * so the whole decision table is unit-tested without a repo, a queue, a `claude` binary or a live driver.
 */

import { cachedClaudeAgents } from '../lib/claude-agents-cache.mjs';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { parseQueue, normNum, resolveQueuePath, resolveQueueSource } from './queue-store.mjs';
import { readDriverMode, driverModePath, DEFAULT_DRIVER_MODE } from './driver-mode.mjs';
import { gitRun, notifyDesktop, decideEscalation, defaultAppendLog, DEFAULT_RENAG_MS } from './branch-sync.mjs';
import { resolveRunnerCheckout } from './resolve-runner-checkout.mjs';
import { runnerLeaseStatus } from '../../skills-src/conveyor/runner-lock.mjs';

// ── TUNING (exported so a caller/test can override) ────────────────────────────────────────────────────────

/** How long a driver may sit with eligible work, nothing in flight and NO observable progress before it is
 *  called stale. 20 minutes: comfortably longer than the runner's ~120 s tick and longer than any single
 *  mechanical pass, so an ordinary slow tick can never trip it, yet short enough that a wedged driver is caught
 *  within one coffee break rather than one working day. `--stale-after-min` overrides it. */
export const DEFAULT_STALE_AFTER_MS = 20 * 60_000;

/** How far back a run record still counts as a progress signal. 2× the staleness window, so the scan stays
 *  bounded (a record older than this cannot possibly change the verdict) without a magic second constant. */
export const RUN_LOOKBACK_FACTOR = 2;

/** At most this many `.operations/runs/*.json` records are PARSED per check, newest first. Progress needs only
 *  the newest in-scope record, and an unbounded parse of a directory nothing prunes is how a cheap watchdog
 *  becomes an expensive one. */
export const MAX_RUNS_SCANNED = 60;

/** Session-name prefixes that count as "this driver is working on that item". Deliberately WIDE — every extra
 *  kind here can only make the watchdog MORE reluctant to act, which is the safe direction.
 *
 *  KEPT IN STEP WITH THE DISPATCHER'S OWN SLUGS, and asserted against them: `dispatch-lane.mjs#sessionSlugFor`
 *  mints `conveyor-`, `prepare-`, `prepare-decision-`, `investigate-`, `fix-` and `ci-heal-` names. The first
 *  three were here; `investigate-<num>` was NOT, and it is keyed on the ITEM id exactly like `conveyor-<num>`,
 *  so a live investigation of a queued item read as "no session at all" and let the `working` branch fall
 *  through to `down`/`settling`/`stale` while real work was out. (`fix-`/`ci-heal-` are keyed on the PR number,
 *  not the item, so they can only match when the two coincide — listed anyway, since a spurious match here
 *  merely makes the watchdog quieter.) The agreement is asserted in the suite against `sessionSlugFor`'s own
 *  output, so a future slug kind fails a test rather than silently re-opening the hole. */
export const WATCHED_SESSION_KINDS = Object.freeze([
  'conveyor', 'fix', 'ci-heal', 'review', 'investigate', 'prepare-decision', 'prepare',
]);

/** A sha must look like one before this file will `git reset --hard` to it. */
export const SHA_RE = /^[0-9a-f]{7,40}$/i;

// ── PURE CORE (no fs / clock / process — every input is injected) ──────────────────────────────────────────

/** The one or two spellings an item id can legitimately appear under in a session slug: as the operator typed
 *  it, and normalized ({@link normNum} strips a `#` sigil and leading zeros). Pure. */
export function itemBases(num) {
  const raw = String(num ?? '').trim().replace(/^#/, '').toLowerCase();
  const norm = normNum(num);
  return [...new Set([raw, norm].filter(Boolean))];
}

/**
 * Does session `name` belong to item `num`? PURE.
 *
 * EXACT MATCH AGAINST A KNOWN ID, never id EXTRACTION from an unknown slug. That distinction is the whole
 * design: `we:scripts/conveyor/lease-reaper.mjs#itemNumFromSession` must extract (it is handed a session and
 * asked which item it is), and a loose extractor is the #3283 incident — a bare `(\d+)$` aliased `probe1` and
 * `Mac:24827` onto real item numbers. This function is never in that position. It already HAS the id, so it can
 * compare whole strings, which cannot alias at all, and it works unchanged for hash-shaped ids (`xqxpeac`) that
 * the digits-only session grammar does not match. Strictly tighter, and no second copy of that grammar exists
 * here to drift from the original.
 *
 * The optional single trailing letter is the retry suffix (`conveyor-2500b` — #3110).
 *
 * @param {string} name - a `claude agents --json` row's name.
 * @param {string|number} num - a queued item id.
 */
export function sessionMatchesItem(name, num) {
  const s = String(name ?? '').trim().toLowerCase();
  if (!s) return false;
  for (const base of itemBases(num)) {
    for (const kind of WATCHED_SESSION_KINDS) {
      const exact = `${kind}-${base}`;
      if (s === exact) return true;
      if (s.length === exact.length + 1 && s.startsWith(exact) && /[a-z]/.test(s[s.length - 1])) return true;
    }
  }
  return false;
}

/**
 * Split the queue into what is BEING WORKED and what is WAITING. PURE.
 *
 * An agent row with an unreadable `startedAt` still counts as in-flight — a session we cannot date is a session
 * we must assume is live, because the cost of being wrong is restarting a driver mid-dispatch.
 *
 * A NAME MATCH ALONE IS NOT LIVENESS (found live 2026-09-14, epic #3383's own resident restart: 18 queued items
 * read as "have a live session" — `conveyor-2786`, `prepare-3438`, … — while every one of those sessions'
 * transcripts had last written 6-13 days earlier, with no backing process at all: a stale/orphaned registry
 * entry, the same #77683-shaped decay `we:scripts/operations/clear-stuck-session.mjs`'s header documents, not a
 * live agent). `agent.pidAlive` — attached by the IO shell ({@link readWatchdogFacts}, via {@link
 * resolvePidAlive}) using the SAME two-signal liveness probe `we:scripts/operations/clear-stuck-session-io.mjs`
 * already established (a listing row's own `pid` when present, else a `ps aux` scan for the session's full
 * `sessionId`) — is read here to tell a CONFIRMED-dead registration apart from a live or merely-unprobed one.
 * `pidAlive === false` is the ONLY value that moves a name-matched row out of `inFlight`: `true` (a real live
 * pid) obviously stays in-flight, and — just as importantly — `undefined`/`null` (unknown: `ps` itself failed,
 * or no `sessionId` at all) ALSO stays in-flight, the same "absence of a field is not evidence of death"
 * direction `we:scripts/conveyor/reconcile-core.mjs#assessLiveness` already rules for the identical shape. So a
 * confirmed-dead match is never silently dropped either — it is reported back as {@link splitQueue}'s third
 * bucket, `deadSessions`, so a caller can both stop treating the item as claimed AND say out loud that a stale
 * registry entry was found (see {@link runWatchdogOnce}'s own log line) rather than quietly forgetting it —
 * reaping the entry itself stays `we:scripts/conveyor/session-reaper.mjs`'s job (already wired into every tick,
 * `we:skills-src/conveyor/runner.mjs` §4d), never re-implemented here.
 *
 * @param {Array<{num:string}>} queue - already parsed by {@link parseQueue}.
 * @param {Array<{name:string, id?:string|null, startedAt?:number, pidAlive?:boolean|null}>} agents
 * @returns {{inFlight: Array<object>, eligible: Array<object>, deadSessions: Array<{num:string, session:string}>}}
 */
export function splitQueue(queue, agents) {
  const rows = Array.isArray(agents) ? agents.filter((a) => a && typeof a === 'object') : [];
  const inFlight = [];
  const eligible = [];
  const deadSessions = [];
  for (const entry of Array.isArray(queue) ? queue : []) {
    const num = String(entry?.num ?? '').trim();
    if (!num) continue;
    const session = rows.find((a) => sessionMatchesItem(a.name, num));
    if (session && session.pidAlive === false) {
      // CONFIRMED dead — a registered session name-matches this item, but its process is verifiably gone (not
      // merely unprobed). Never counted as in-flight; the item is eligible, and the stale entry is called out
      // distinctly rather than silently dropped (see the file header for why liveness must be checked at all).
      deadSessions.push({ num, session: String(session.name ?? '') });
      eligible.push({ num, addedAt: entry?.addedAt ?? null });
    } else if (session) {
      inFlight.push({ num, session: String(session.name ?? ''), startedAt: Number(session.startedAt) || null });
    } else {
      eligible.push({ num, addedAt: entry?.addedAt ?? null });
    }
  }
  return { inFlight, eligible, deadSessions };
}

/** `process.kill(pid, 0)` — `true`/`false` when established (an `EPERM` still proves the pid exists, just not
 *  ours to signal). The direct, no-subprocess probe used when a listing row carries a `pid`. */
export function defaultIsPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * Resolve `pidAlive` for ONE `claude agents --json` row — the row's own `pid` when present (rare for this
 * listing shape, but honoured when it exists: a direct `kill(pid, 0)` must never be second-guessed by a wider,
 * noisier scan), else a scan of an already-captured `ps aux` snapshot for the row's full `sessionId` — the SAME
 * two-signal technique `we:scripts/operations/clear-stuck-session-io.mjs#resolvePidAlive`/`scanPsForSession`
 * established, reimplemented locally rather than imported (this file's own six-lines-not-reuse convention — see
 * {@link defaultListAgents}'s docblock — and that module transitively reaches `dispatch-lane-io.mjs`, on this
 * file's own forbidden-import list; see the purity suite). PURE over its inputs: the `ps aux` text and the pid
 * prober are both injected, so this never touches a subprocess itself.
 * @param {{pid?:number|null, sessionId?:string|null}} row
 * @param {{psOutput?:string|null, isPidAlive?:(pid:number)=>boolean}} [o] - `psOutput` is a full `ps aux`
 *   capture (or `null` when the scan itself failed/was skipped), lower-cased matching done here.
 * @returns {boolean|null} `true`/`false` when established, `null` when NEITHER probe could say — UNKNOWN, never
 *   read as death (see {@link splitQueue}).
 */
export function resolvePidAlive(row, { psOutput = null, isPidAlive = defaultIsPidAlive } = {}) {
  const pid = Number(row?.pid);
  if (Number.isInteger(pid) && pid > 0) return isPidAlive(pid);
  const sid = row?.sessionId ? String(row.sessionId).trim() : '';
  if (!sid || psOutput == null) return null; // no sessionId to scan for, or the scan itself failed — unknown
  return String(psOutput).toLowerCase().includes(sid.toLowerCase());
}

/**
 * Does a run record fall inside THIS driver's scope? PURE, and deliberately narrow.
 *
 * Two ways in, both explicit: the run's input names a queued item id, or it names this driver's checkout. A
 * repo-wide operation that touched neither is another instance's business and must not be read as this driver
 * making progress — the #3383 lesson `queue-scope.mjs` already learned the expensive way.
 *
 * Only SCALAR input fields are compared. An operation's input is caller-supplied, so a deep walk would let an
 * arbitrary nested blob match by accident, which is the wrong direction for a signal whose job is to SUPPRESS
 * the alarm.
 *
 * @param {{op?:string, input?:object}} record
 * @param {Set<string>} queueKeys - normalized queued ids ({@link normNum}).
 * @param {string} checkout - the driver's checkout, already resolved.
 */
export function runTouchesScope(record, queueKeys, checkout) {
  const input = record && typeof record.input === 'object' && record.input ? record.input : {};
  const want = queueKeys instanceof Set ? queueKeys : new Set(queueKeys || []);
  for (const value of Object.values(input)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const s = String(value).trim();
    if (!s) continue;
    if (want.has(normNum(s))) return true;
    if (checkout && resolveSafe(s) === checkout) return true;
  }
  return false;
}

/** `resolve()` that never throws on junk — a run record's input is caller-supplied text. Pure enough: `resolve`
 *  reads `process.cwd()` only for a RELATIVE path, and every path compared here is absolute. */
function resolveSafe(s) {
  try { return resolve(s); } catch { return null; }
}

/**
 * The newest of several progress timestamps, ignoring the ones we could not read. PURE.
 * Returns `null` when NOTHING was observable — which {@link classifyDriver} treats as "cannot tell", never as
 * "infinitely quiet".
 * @param {Array<{source:string, atMs:number|null}>} signals
 */
export function latestProgress(signals) {
  let best = null;
  for (const sig of Array.isArray(signals) ? signals : []) {
    const at = Number(sig?.atMs);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (!best || at > best.atMs) best = { source: String(sig.source ?? ''), atMs: at };
  }
  return best;
}

/**
 * THE VERDICT: is this driver stale? PURE over already-read facts.
 *
 * ── HOW EACH FALSE POSITIVE IS RULED OUT, in the order the checks run ───────────────────────────────────────
 *
 *   `unknown`  — the agent listing could not be read, or no progress timestamp was observable at all. FAILS
 *                SAFE (no action). Note this is the OPPOSITE direction from `restart-runner`'s fail-CLOSED on
 *                the same unreadable listing, and deliberately so: there the dangerous act is to PROCEED, here
 *                the dangerous act is to ACT. A watchdog that healed on a transient `claude` hiccup would be a
 *                worse outage than the one it guards.
 *   `idle`     — the queue is EMPTY. "There is just nothing to do right now" is the single most likely false
 *                positive, and it is answered first and unconditionally: no eligible work, no staleness, ever.
 *   `working`  — some queued item has a live session. Legitimate in-flight work is health, however long it has
 *                been running; a delivery agent may work an item for an hour without touching any of the
 *                signals below, and killing its driver mid-flight is exactly the double-dispatch damage the
 *                whole lease apparatus exists to prevent.
 *  `completed` — no live lease, the lease was released CLEANLY, and this checkout's driver was launched
 *                BOUNDED (`--once` / `--max-ticks=N` — recorded by {@link ./driver-mode.mjs}). It ran its
 *                ticks and left, which is the job finishing. Never healed, never alarmed about.
 *   `down`     — no LIVE lease, and nothing says it was supposed to stop. Nobody is driving, so nothing is
 *                silently stale; this is the crash case the supervisor and `restart-runner` already own.
 *                Reported loudly, never healed here — rolling a checkout back under a dead driver fixes
 *                nothing and destroys the evidence.
 *   `settling` — eligible work, nothing in flight, but something moved within `staleAfterMs`. Healthy.
 *   `stale`    — all of the above ruled out AND nothing has moved for `staleAfterMs`. The only actionable one.
 *
 * ── `down` IS NOT A SYNONYM FOR "CRASHED" (the 2026-09-12 bug) ──────────────────────────────────────────────
 *
 * This branch used to assert *"That is a crash, not silent staleness"* for EVERY absent lease. Two different
 * things reach it, and the evidence to tell them apart was already in hand and being thrown away:
 *
 *   • the holder DIED — it leaked its lease and the TTL swept it (`lease.stale === true`). A real crash.
 *   • the holder LEFT — it released its lease on the way out (`lease.stale === false`, no lease at all). A
 *     stop. Whether that stop was expected is what {@link ./driver-mode.mjs}'s marker answers: a BOUNDED
 *     driver stopping is `completed`; a RESIDENT one stopping is still `down`, because it was supposed to
 *     keep going.
 *
 * BACKWARD-COMPATIBLE BY CONSTRUCTION: `driverMode` is `null` for every checkout that has not yet run a runner
 * carrying the marker, and `null` takes the RESIDENT path — same `down` state, same `actionable:false`, same
 * non-action as before. Only the wording now follows the evidence instead of asserting past it.
 *
 * @param {object} o
 * @param {number} o.nowMs
 * @param {number} [o.staleAfterMs]
 * @param {Array<{num:string}>} o.queue
 * @param {boolean} o.listingReadable
 * @param {Array<object>} o.agents
 * @param {{held:boolean, stale:boolean, heartbeatAt:string|null, detail?:string}|null} o.lease
 * @param {{source:string, atMs:number}|null} o.progress
 * @param {{mode:'bounded'|'resident', startedAt:string|null}|null} [o.driverMode] - `null` ⇒ assume resident.
 */
export function classifyDriver({
  nowMs, staleAfterMs = DEFAULT_STALE_AFTER_MS, queue = [], listingReadable = true, agents = [],
  lease = null, progress = null, listingError = null, driverMode = null,
} = {}) {
  const { inFlight, eligible, deadSessions } = splitQueue(queue, agents);
  const base = {
    eligible, inFlight, deadSessions, queueSize: Array.isArray(queue) ? queue.length : 0,
    progress, quietMs: progress ? Math.max(0, Number(nowMs) - progress.atMs) : null,
    staleAfterMs, lease, driverMode,
  };

  if (!listingReadable) {
    return { ...base, state: 'unknown', actionable: false,
      reason: `could not read the agent listing (${listingError || 'unknown error'}) — cannot tell in-flight work from none, so no action` };
  }
  if (base.queueSize === 0) {
    return { ...base, state: 'idle', actionable: false, reason: 'the queue is empty — nothing to dispatch, so nothing to be stale about' };
  }
  if (inFlight.length) {
    return { ...base, state: 'working', actionable: false,
      reason: `${inFlight.length} queued item(s) have a live session (${inFlight.map((i) => i.session).join(', ')}) — real work is in flight` };
  }
  if (!lease || lease.held !== true) {
    const detail = lease?.detail || 'no live runner lease';
    // The POSITIVE death signal, and the only one: a holder that crashed cannot release, so its lease sits
    // there until the TTL marks it stale. Anything else is an absence, and an absence is not evidence of death.
    const leaked = lease?.stale === true;
    const mode = driverMode?.mode || DEFAULT_DRIVER_MODE;
    if (!leaked && mode === 'bounded') {
      return { ...base, state: 'completed', actionable: false,
        reason: `the driver is not running (${detail}), and this checkout's driver was started BOUNDED`
          + `${driverMode?.maxTicks ? ` (--max-ticks=${driverMode.maxTicks})` : ' (--once)'}`
          + `${driverMode?.startedAt ? ` at ${driverMode.startedAt}` : ''} — it ran its ticks and exited, releasing its lease `
          + 'cleanly. That is the job FINISHING, not a crash: nothing to restart, nothing to roll back, nothing to alarm about' };
    }
    return { ...base, state: 'down', actionable: false,
      reason: `the driver is not running (${detail}). `
        + (leaked
          ? 'The lease was LEAKED — its heartbeat is past the TTL, so the holder died without releasing it. That is a crash'
          : `The lease was released cleanly, so the driver STOPPED rather than crashed — but it was ${driverMode ? 'recorded as RESIDENT' : 'not recorded as bounded (no `.conveyor/driver-mode.json`, so it is assumed resident)'}`
            + ' and a resident driver is supposed to keep running, so something ended it')
        + '; the supervisor and `run.mjs restart-runner` own it, and rolling a checkout back under a dead driver would only destroy evidence' };
  }
  if (!progress) {
    return { ...base, state: 'unknown', actionable: false,
      reason: 'no progress timestamp was observable (no queue sidecar, no dispatch log, no run record, no session) — cannot measure quiet time' };
  }
  if (base.quietMs < staleAfterMs) {
    return { ...base, state: 'settling', actionable: false,
      reason: `${eligible.length} eligible item(s) and nothing in flight, but ${progress.source} moved ${Math.round(base.quietMs / 1000)}s ago `
        + `(under the ${Math.round(staleAfterMs / 60_000)}min window) — still settling` };
  }
  return { ...base, state: 'stale', actionable: true,
    reason: `STALE: ${eligible.length} eligible item(s) (${eligible.map((e) => e.num).join(', ')}), no live session for any of them, `
      + `a LIVE runner lease, and nothing has moved for ${Math.round(base.quietMs / 60_000)}min `
      + `(newest signal: ${progress.source}) — the driver is up but making no dispatch progress` };
}

/**
 * MAY THE ROLLBACK RUN? PURE. Four independent refusals, each guarding a different way a mechanical
 * `git reset --hard` could make things worse than the staleness it is fixing.
 *
 * `already-at-last-known-good` is the LOOP GUARD and the most important of the four. Without it a driver that
 * is stale *at* the known-good commit would be reset to where it already is, restarted onto byte-identical
 * code, found stale again, and healed again, forever — an automated outage. With it, the second heal refuses
 * and escalates to a human instead, which is the correct answer: if known-good is also stale, the marker is
 * wrong and only a person can say what the new one should be.
 *
 * @param {object} o
 * @param {{state:string, actionable:boolean, reason:string}} o.verdict
 * @param {{sha?:string, recordedAt?:string, note?:string}|null} o.lastKnownGood
 * @param {{sha:string|null, dirty:boolean|null}} o.head
 */
export function decideRollback({ verdict, lastKnownGood = null, head = {} } = {}) {
  if (!verdict || verdict.actionable !== true) {
    return { roll: false, guard: 'not-stale', reason: `no rollback: ${verdict?.reason || 'the driver was not judged stale'}` };
  }
  const sha = String(lastKnownGood?.sha ?? '').trim();
  if (!SHA_RE.test(sha)) {
    return { roll: false, guard: 'no-fallback',
      reason: 'REFUSING to roll back — no usable `.conveyor/last-known-good.json` (`sha` is missing or not a commit id). '
        + 'The fallback is recorded, never guessed: run `driver-watchdog.mjs record-good` before promoting the driver onto new code.' };
  }
  if (head?.dirty === true) {
    return { roll: false, guard: 'dirty-checkout',
      reason: 'REFUSING to roll back — the driver checkout has uncommitted changes. A driver checkout only RUNS the runner, it never '
        + 'edits (memory rule 104: edit-work lands through a lane clone), so a dirty tree means something unexpected is happening there '
        + 'and `git reset --hard` would destroy it. A human looks first.' };
  }
  if (head?.dirty !== false) {
    return { roll: false, guard: 'unknown-tree',
      reason: 'REFUSING to roll back — could not read the driver checkout\'s working-tree state, so `git reset --hard` cannot be proven non-destructive.' };
  }
  const at = String(head?.sha ?? '').trim();
  if (!SHA_RE.test(at)) {
    return { roll: false, guard: 'unknown-head', reason: 'REFUSING to roll back — could not read the driver checkout\'s HEAD commit.' };
  }
  if (at === sha || at.startsWith(sha) || sha.startsWith(at)) {
    return { roll: false, guard: 'already-at-last-known-good',
      reason: `REFUSING to roll back — the driver is ALREADY at the last-known-good commit (${sha.slice(0, 12)}) and is stale there. `
        + 'Resetting to where it already is and restarting onto identical code would loop forever. The marker is wrong, or the fault is '
        + 'not in the code: a human has to look.' };
  }
  return { roll: true, guard: null, sha, from: at, reason: `rolling the driver back from ${at.slice(0, 12)} to last-known-good ${sha.slice(0, 12)}` };
}

// ── IO SHELL (fs / git / subprocess / clock past this point) ───────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
/** This checkout — the watchdog's own, TRUSTED one. Resolved by script location, never CWD (the reason
 *  `queue-store.mjs#QUEUE_ROOT` gives: a reader and a writer that disagree about the root is a silent no-op). */
export const WATCHDOG_REPO_ROOT = resolve(HERE, '..', '..');

/** The sidecars this watchdog reads and writes, all under the DRIVER's checkout beside the queue they describe. */
export const lastKnownGoodPath = (checkout) => join(checkout, '.conveyor', 'last-known-good.json');
export const alertPath = (checkout) => join(checkout, '.conveyor', 'watchdog-alert.json');
export const logPath = (checkout) => join(checkout, '.conveyor', 'watchdog.log');
/** The cleared queue is NOT under the driver's checkout any more: it is the ONE state-home file every runner and
 *  daemon reads (decouple-primary-checkout, epic #4075) — including its one-release fallback to the primary's
 *  old sidecar (`queue-store.mjs#resolveQueueSource`). `checkout` is accepted and ignored. */
export const queueSidecarPath = (_checkout) => resolveQueueSource(resolveQueuePath()).path;
export const dispatchLogPath = (checkout) => join(checkout, '.conveyor', 'dispatch-log.json');
export const runsDirPath = (checkout) => join(checkout, '.operations', 'runs');
/** Re-exported so a caller/test has ONE spelling of the marker's location, the writer's own. */
export { driverModePath };

const iso = (ms) => new Date(ms).toISOString();

/** mtime in epoch ms, or `null` for anything unreadable. Never throws. */
export function mtimeMs(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Atomic temp+rename write, the sidecar convention `queue-store.mjs#writeQueueFile` sets — a reader mid-write
 *  never sees partial JSON, which for the last-known-good marker would read as "no fallback". */
function saveJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
  return path;
}

/**
 * `claude agents --json`, read directly. Six lines rather than
 * `we:scripts/operations/dispatch-lane-io.mjs#defaultListAgents`, and the difference is the point of this whole
 * file: that module imports the dispatch DECLARATION (`dispatch-lane.mjs`), which is precisely the driver logic
 * a watchdog must not be able to reach. Shelling one command is a syscall, not duplicated judgment.
 */
export function defaultListAgents({ exec = execFileSync } = {}) {
  const out = cachedClaudeAgents({ fetch: () => exec('claude', ['agents', '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL',
  }) });
  return JSON.parse(String(out || '[]'));
}

/**
 * A `ps aux` snapshot, or `null` when the scan itself could not run — the shared read {@link resolvePidAlive}
 * probes for a listing row's full `sessionId` (a real live Claude Code background session is a
 * `--resume=<full-uuid>` subprocess; matching the full id, never an 8-hex short one, avoids a coincidental
 * substring match against an unrelated commit sha or temp path). Best-effort, bounded, never throws — the same
 * "unreadable ⇒ unknown, not death" discipline every probe in this file follows.
 */
export function scanPsOutput({ exec = execFileSync } = {}) {
  try {
    return String(exec('ps', ['aux'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000, killSignal: 'SIGKILL' }));
  } catch {
    return null;
  }
}

/**
 * IS THE DRIVER WE ARE WATCHING ACTUALLY UP? Read through the machine-global singleton lease
 * ({@link ../../skills-src/conveyor/runner-lock.mjs}) plus {@link ./resolve-runner-checkout.mjs}, which walks
 * the lease's pid to its working directory. Both modules are lock/process plumbing, not dispatch logic.
 *
 * The lease is machine-global — one lease for whichever runner is driving — so "a lease is live" alone does not
 * mean OUR driver is live. A lease resolved to a DIFFERENT checkout is therefore held against us (`held:false`
 * ⇒ `down` ⇒ no action).
 *
 * ACCEPTED RESIDUAL, stated rather than hidden: a lease that is live but whose checkout cannot be resolved
 * (`lsof` unavailable, the pid already gone) counts as OURS. It could in principle belong to another instance.
 * That is the deliberate call, because only one runner can hold this lease at a time, and every downstream
 * guard still applies — the rollback refuses on a dirty tree, on a missing marker, and on an
 * already-at-last-known-good head, and `restart-runner` keeps all of its own refusals on top.
 */
export function defaultDriverLease({
  checkout, nowMs = Date.now(), leaseStatusFn = runnerLeaseStatus, resolveCheckout = resolveRunnerCheckout,
} = {}) {
  const status = leaseStatusFn(undefined, { nowMs });
  if (!status.held) {
    return { held: false, stale: status.stale, heartbeatAt: status.heartbeatAt, checkoutMatch: null,
      detail: status.stale ? 'a runner lease exists but its holder crashed (heartbeat past the TTL)' : 'no runner lease at all' };
  }
  const res = resolveCheckout({ nowMs });
  const match = res.status === 'resolved' ? resolve(res.cwd) === resolve(checkout) : null;
  return {
    held: match !== false, stale: false, heartbeatAt: status.heartbeatAt, checkoutMatch: match,
    detail: match === false
      ? `the live runner lease belongs to a different checkout (${res.cwd}) — this one is not driving`
      : `a live runner lease (${status.owner}${match === null ? `, checkout unresolved: ${res.status}` : ''})`,
  };
}

/**
 * The newest in-scope run record under `<checkout>/.operations/runs`, or `null`. Bounded twice — by age
 * ({@link RUN_LOOKBACK_FACTOR}) and by count ({@link MAX_RUNS_SCANNED}) — because that directory is a sidecar
 * nothing prunes. Tolerant throughout: a corrupt record is skipped, never fatal.
 */
export function newestScopedRun({ checkout, queueKeys, nowMs, lookbackMs, readDir = readdirSync, stat = mtimeMs, read = loadJson } = {}) {
  const dir = runsDirPath(checkout);
  let names;
  try { names = readDir(dir); } catch { return null; }
  const rows = [];
  for (const name of Array.isArray(names) ? names : []) {
    if (!String(name).endsWith('.json')) continue;
    const path = join(dir, name);
    const at = stat(path);
    if (at === null || nowMs - at > lookbackMs) continue;
    rows.push({ path, at });
  }
  rows.sort((a, b) => b.at - a.at);
  for (const row of rows.slice(0, MAX_RUNS_SCANNED)) {
    const record = read(row.path);
    if (record && runTouchesScope(record, queueKeys, checkout)) return { atMs: row.at, path: row.path, op: record.op ?? null };
  }
  return null;
}

/**
 * ONE observation of everything {@link classifyDriver} decides over. Every boundary is injected, so the whole
 * shell is testable with no `claude`, no lock root, no driver and no real clock.
 *
 * THE FOUR PROGRESS SIGNALS, each independent of the driver's planner:
 *   • `queue-sidecar`  — `.conveyor/queue.json`'s mtime. The driver removes an item as it consumes it, and the
 *                        operator adds one when clearing work; either way, the file moving means the board moved.
 *   • `dispatch-log`   — `.conveyor/dispatch-log.json`'s mtime, the existing "dispatch is observable" signal
 *                        (#2680). The most direct evidence a dispatch actually happened.
 *   • `run-record`     — the newest `.operations/runs/*.json` in this driver's scope ({@link runTouchesScope}).
 *   • `agent-session`  — the newest start time among sessions for queued items.
 *
 * The lease is read only for {@link classifyDriver}'s `down` check. It is NOT a progress signal and must never
 * be treated as one: a wedged driver heartbeats its lease every tick exactly like a healthy one, which is the
 * whole reason the existing guards missed this failure. Neither is the driver-mode marker: it is written ONCE
 * at launch and never touched again, so its mtime says nothing about progress — it answers only "was this
 * driver supposed to still be running?" for that same `down` check.
 */
export function readWatchdogFacts({
  checkout,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  listAgents = defaultListAgents,
  readQueueText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } },
  leaseStatus = defaultDriverLease,
  readMode = readDriverMode,
  stat = mtimeMs,
  scanRuns = newestScopedRun,
  scanPs = scanPsOutput,
  isPidAlive = defaultIsPidAlive,
  now = () => Date.now(),
} = {}) {
  const root = resolve(checkout);
  const nowMs = now();
  const queue = parseQueue(readQueueText(queueSidecarPath(root)));
  const queueKeys = new Set(queue.map((e) => normNum(e.num)).filter(Boolean));

  let agents = [];
  let listingReadable = true;
  let listingError = null;
  try {
    const raw = listAgents();
    const rows = (Array.isArray(raw) ? raw : []).map((r) => ({
      name: String(r?.name ?? ''), id: r?.id ?? null, startedAt: Number(r?.startedAt),
      pid: Number.isInteger(r?.pid) ? r.pid : null, sessionId: r?.sessionId ?? null,
    }));
    // LIVENESS (#3383 stale-registration fix — see {@link splitQueue}'s header): ONE `ps aux` scan for the
    // whole batch, never one subprocess per row, then resolved per-row through {@link resolvePidAlive}. Skipped
    // entirely when nothing was listed — no rows, nothing to probe.
    const psOutput = rows.length ? scanPs() : null;
    agents = rows.map((r) => ({ ...r, pidAlive: resolvePidAlive(r, { psOutput, isPidAlive }) }));
  } catch (e) {
    agents = [];
    listingReadable = false;
    listingError = String(e?.message ?? e).split('\n')[0];
  }

  const run = scanRuns({ checkout: root, queueKeys, nowMs, lookbackMs: staleAfterMs * RUN_LOOKBACK_FACTOR });
  const newestSession = agents
    .filter((a) => queue.some((e) => sessionMatchesItem(a.name, e.num)))
    .map((a) => Number(a.startedAt))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a)[0] ?? null;

  const progress = latestProgress([
    { source: 'queue-sidecar', atMs: stat(queueSidecarPath(root)) },
    { source: 'dispatch-log', atMs: stat(dispatchLogPath(root)) },
    { source: 'run-record', atMs: run?.atMs ?? null },
    { source: 'agent-session', atMs: newestSession },
  ]);

  return {
    checkout: root, nowMs, staleAfterMs, queue, agents, listingReadable, listingError,
    lease: leaseStatus({ checkout: root, nowMs }), progress, run, driverMode: readMode(root),
  };
}

/** The driver checkout's `{sha, dirty}`, with `null` for anything git could not tell us — {@link decideRollback}
 *  refuses on either unknown rather than guessing. */
export function readHead({ checkout, git = gitRun } = {}) {
  const rev = git(['rev-parse', 'HEAD'], checkout);
  const status = git(['status', '--porcelain'], checkout);
  return {
    sha: rev.ok ? String(rev.stdout).trim() : null,
    dirty: status.ok ? String(status.stdout).trim().length > 0 : null,
  };
}

/** Record the commit the driver is LEAVING as its fallback. Explicit, never inferred — see the file header. */
export function recordLastKnownGood({ checkout, sha, note = '', git = gitRun, now = () => Date.now(), write = saveJson } = {}) {
  const root = resolve(checkout);
  let target = String(sha ?? '').trim();
  if (!target) {
    const rev = git(['rev-parse', 'HEAD'], root);
    if (!rev.ok) throw new Error(`driver-watchdog: could not read HEAD in ${root} — ${String(rev.stderr).split('\n')[0]}`);
    target = String(rev.stdout).trim();
  }
  // RESOLVED THROUGH THE DRIVER'S OWN OBJECT DATABASE, for two reasons. A marker can never name a commit that
  // checkout does not have — a rollback target it cannot reach would fail at the worst possible moment. And the
  // stored value is always the resolved, IMMUTABLE 40-hex sha, so an operator may type any convenient rev
  // (`HEAD`, a tag, a branch) while the marker itself can never drift the way a symbolic ref would.
  const full = git(['rev-parse', '--verify', `${target}^{commit}`], root);
  if (!full.ok) throw new Error(`driver-watchdog: ${target} is not a commit in ${root} — ${String(full.stderr).split('\n')[0]}`);
  const sha40 = String(full.stdout).trim();
  if (!SHA_RE.test(sha40)) throw new Error(`driver-watchdog: ${target} resolved to ${JSON.stringify(sha40)}, which is not a commit id`);
  const record = { sha: sha40, recordedAt: iso(now()), note: String(note || '') };
  return { path: write(lastKnownGoodPath(root), record), record };
}

/** Read the marker, or `null`. A corrupt/missing marker is a REFUSAL downstream, never a guess. */
export function readLastKnownGood(checkout) {
  return loadJson(lastKnownGoodPath(resolve(checkout)));
}

/**
 * ROLL BACK, THEN RESTART — the two mechanical steps, in that order.
 *
 * THE CONTROL PLANE IS THIS CHECKOUT; THE DATA PLANE IS THE ROLLED-BACK ONE. `run.mjs restart-runner` is
 * invoked from {@link WATCHDOG_REPO_ROOT} — the trusted, known-stable copy — while `--checkout` and
 * `--supervisor` point at the DRIVER's freshly-reset tree, so the conveyor comes back up on the rolled-back
 * code while the restart sequence itself runs code we did not just roll back. Shelling the driver's own
 * `run.mjs` instead would hand the restart to the exact commit we are trying to get away from.
 *
 * `restart-runner` keeps ALL of its own refusals (a build agent spawned in the last 60 s, an unreadable
 * listing, an unconfirmed shutdown, a live lease). This function deliberately passes no `--force`: a watchdog
 * that overrode the double-dispatch guard would be a bigger hazard than the staleness it is healing, and
 * `restart-runner` refusing is a fine outcome — the next check tries again.
 */
export function healDriver({
  checkout, sha, git = gitRun, runnerCli = join(WATCHDOG_REPO_ROOT, 'scripts', 'operations', 'run.mjs'),
  controlRoot = WATCHDOG_REPO_ROOT, run = spawnSync, timeoutMs = 180_000,
} = {}) {
  const root = resolve(checkout);
  const reset = git(['reset', '--hard', sha], root);
  if (!reset.ok) {
    return { rolledBack: false, restarted: false, sha, error: `git reset --hard ${sha} failed — ${String(reset.stderr).split('\n')[0]}` };
  }
  const args = [runnerCli, 'restart-runner', `--checkout=${root}`, `--supervisor=${join(root, 'skills-src', 'conveyor', 'supervisor.mjs')}`];
  const res = run(process.execPath, args, { cwd: controlRoot, encoding: 'utf8', timeout: timeoutMs });
  const restarted = !!res && res.status === 0;
  return {
    rolledBack: true, restarted, sha, argv: args,
    restartStatus: res?.status ?? null,
    restartOutput: String(res?.stdout ?? '').trim().split('\n').slice(-6).join('\n'),
    error: restarted ? null : `restart-runner exited ${res?.status ?? 'null'} — ${String(res?.stderr ?? '').split('\n')[0]}`,
  };
}

/**
 * ONE watchdog pass: observe, judge, and (unless `dryRun`) heal. The only caller-facing entry point.
 *
 * A `stale` verdict is ALWAYS surfaced durably — log line, dedup record, desktop notification — whether the
 * heal ran, refused, or was skipped. That is `branch-sync.mjs`'s own #3472 lesson applied here: the incident it
 * replaced wrote one line into a log nobody was tailing and the checkout drifted 53 commits behind. A driver
 * that had to be rolled back is a real event a human must learn about, not something to hide behind a silent
 * self-repair. {@link decideEscalation} dedups the notification (same state ⇒ quiet for 30 min) so a driver
 * stuck across many checks nags once, not every pass.
 *
 * `down` gets the SAME desktop alert (found missing tonight — a fully-crashed driver never notified anyone,
 * `.conveyor/watchdog-alert.json` sat untouched through two real down episodes), but deliberately none of the
 * rest: `down` never reaches {@link decideRollback} or {@link healDriver}, because `verdict.actionable` stays
 * `false` for it (see {@link classifyDriver}) — only the ALERT widened, not the auto-heal policy.
 */
export function runWatchdogOnce({
  checkout,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  dryRun = false,
  renagMs = DEFAULT_RENAG_MS,
  readFacts = readWatchdogFacts,
  readHeadFn = readHead,
  readMarker = readLastKnownGood,
  heal = healDriver,
  notify = notifyDesktop,
  appendLog = defaultAppendLog,
  loadAlert = loadJson,
  saveAlert = saveJson,
  now = () => Date.now(),
  ...io
} = {}) {
  const root = resolve(checkout);
  const facts = readFacts({ checkout: root, staleAfterMs, now, ...io });
  const verdict = classifyDriver({
    nowMs: facts.nowMs, staleAfterMs, queue: facts.queue, listingReadable: facts.listingReadable,
    listingError: facts.listingError, agents: facts.agents, lease: facts.lease, progress: facts.progress,
    driverMode: facts.driverMode,
  });

  const line = (msg) => appendLog(logPath(root), `${iso(facts.nowMs)} watchdog[${verdict.state}]: ${msg}`);

  // NEVER SILENT (see `splitQueue`'s header) — a confirmed-dead registered session is excluded from `inFlight`
  // every check, but that must not read as "quietly forgotten": name it, every time it recurs, so the log is
  // the durable trail an operator (or `session-reaper.mjs`'s own ground-truth axis) can act on. Logged
  // regardless of `verdict.state` — a dead registration is worth knowing about even on a tick that is
  // otherwise `working`/`settling` because other, genuinely-live sessions are also in the queue.
  if (verdict.deadSessions?.length) {
    line(`${verdict.deadSessions.length} queued item(s) name a registered session CONFIRMED no longer running `
      + `(${verdict.deadSessions.map((d) => d.session).join(', ')}) — not counted as in-flight; a stale registry `
      + 'entry for `session-reaper.mjs`/`clear-stuck-session.mjs` to reap, not this file\'s job');
  }

  if (!verdict.actionable) {
    line(verdict.reason);
    if (verdict.state !== 'down') {
      return { checkout: root, verdict, action: 'none', rollback: null, heal: null, alerted: false };
    }
    // `down` ALERTS EXACTLY LIKE `stale` (same `notifyDesktop`, same `decideEscalation` dedup/re-nag window) —
    // the most severe verdict this file can reach must never sit silent just because it is not the one this
    // file may HEAL. It must NOT, however, reach `decideRollback`/`heal`: `verdict.actionable` stays `false`
    // for `down` (untouched — see `classifyDriver`'s own `down` branch for why rolling back under a dead
    // driver would destroy evidence), so the heal-gating this file already had is exactly as before. This is
    // the ONE place `actionable:false` still reaches the desktop notification; every other non-actionable state
    // (`idle`, `working`, `unknown`, `settling`, `completed`) returns above, unchanged.
    const escalation = decideEscalation({
      signature: `down:${verdict.reason}`,
      lastAlert: loadAlert(alertPath(root)), nowMs: facts.nowMs, renagMs,
    });
    if (escalation.fire) {
      saveAlert(alertPath(root), { ...escalation.record, state: verdict.state, action: 'alert-only', reason: verdict.reason });
      notify({ title: 'Conveyor driver DOWN', body: `${root}: ${verdict.reason}`,
        // quietHours breakthrough (card xmvc6oc): a daemon down long enough reaches the operator overnight.
        emergency: { kind: 'daemon-down', downForMs: Number.isFinite(verdict.quietMs) ? verdict.quietMs : null } });
    }
    return { checkout: root, verdict, action: 'alert-only', rollback: null, heal: null, alerted: escalation.fire };
  }

  const head = readHeadFn({ checkout: root, ...io });
  const rollback = decideRollback({ verdict, lastKnownGood: readMarker(root), head });

  // The escalation fires on the STALE verdict, not on a successful heal — a refused rollback is the case a
  // human most needs to hear about, and it is exactly the case with nothing else to show for itself.
  const escalation = decideEscalation({
    signature: `${verdict.state}:${rollback.guard ?? 'roll'}:${rollback.sha ?? head.sha ?? ''}`,
    lastAlert: loadAlert(alertPath(root)), nowMs: facts.nowMs, renagMs,
  });

  let outcome = null;
  let action = 'refused';
  if (!rollback.roll) {
    line(`${verdict.reason} — ${rollback.reason}`);
  } else if (dryRun) {
    action = 'dry-run';
    line(`${verdict.reason} — DRY RUN, would ${rollback.reason}`);
  } else {
    line(`${verdict.reason} — ${rollback.reason}`);
    outcome = heal({ checkout: root, sha: rollback.sha, ...io });
    action = outcome.rolledBack && outcome.restarted ? 'healed' : 'heal-failed';
    line(outcome.error
      ? `HEAL INCOMPLETE — rolledBack=${outcome.rolledBack} restarted=${outcome.restarted}: ${outcome.error}`
      : `HEALED — checkout reset to ${String(outcome.sha).slice(0, 12)} and restart-runner completed`);
  }

  if (escalation.fire) {
    saveAlert(alertPath(root), { ...escalation.record, state: verdict.state, action, reason: rollback.reason });
    notify({
      title: `Conveyor driver ${action === 'healed' ? 'ROLLED BACK' : 'STALE'}`,
      body: action === 'healed'
        ? `${root}: no dispatch progress for ${Math.round(verdict.quietMs / 60_000)}min — reset to ${String(rollback.sha).slice(0, 12)} and restarted.`
        : `${root}: no dispatch progress for ${Math.round(verdict.quietMs / 60_000)}min and NOT healed — ${rollback.reason}`,
    });
  }

  return { checkout: root, verdict, action, rollback, heal: outcome, alerted: escalation.fire };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────

export function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
    else rest.push(arg);
  }
  return { flags, rest };
}

const USAGE = `driver-watchdog — detect a silently-stale conveyor driver and roll it back to last-known-good.

  record-good [--checkout=DIR] [--sha=COMMIT] [--note=TEXT]
      Record the fallback commit. Run this BEFORE promoting the driver onto new code, naming the commit it is
      LEAVING (defaults to that checkout's current HEAD). Explicit by design — never inferred.

  check [--checkout=DIR] [--stale-after-min=N] [--json]
      Read-only diagnosis. Prints the verdict and exits 0 (healthy) or 2 (stale). Changes nothing.

  heal [--checkout=DIR] [--stale-after-min=N] [--dry-run] [--json]
      Diagnose, and if stale: git reset --hard <last-known-good>, then \`run.mjs restart-runner\`.
      Refuses on a dirty tree, a missing marker, or an already-at-last-known-good driver.

  --checkout defaults to the current directory.`;

export function main(argv) {
  const { flags, rest } = parseFlags(argv);
  const verb = rest[0] || 'check';
  if (flags.help || verb === 'help') { process.stdout.write(USAGE + '\n'); return 0; }

  const checkout = resolve(String(flags.checkout || process.cwd()));
  if (!existsSync(join(checkout, '.git'))) {
    process.stderr.write(`driver-watchdog: ${checkout} has no .git — that is not a driver checkout\n`);
    return 1;
  }
  const staleAfterMs = Number(flags['stale-after-min']) > 0 ? Number(flags['stale-after-min']) * 60_000 : DEFAULT_STALE_AFTER_MS;

  if (verb === 'record-good') {
    const { path, record } = recordLastKnownGood({ checkout, sha: flags.sha === true ? '' : flags.sha, note: flags.note === true ? '' : flags.note });
    process.stdout.write(flags.json ? JSON.stringify(record) + '\n' : `driver-watchdog: last-known-good = ${record.sha.slice(0, 12)} → ${path}\n`);
    return 0;
  }

  if (verb === 'check' || verb === 'heal') {
    const result = runWatchdogOnce({
      checkout, staleAfterMs,
      // `check` is READ-ONLY: it takes the dry-run path AND is handed a heal that would refuse to act, so the
      // read-only promise does not rest on one flag being threaded correctly.
      dryRun: verb === 'check' || flags['dry-run'] === true,
      ...(verb === 'check' ? { heal: () => { throw new Error('driver-watchdog: `check` never heals'); } } : {}),
    });
    if (flags.json) process.stdout.write(JSON.stringify(result) + '\n');
    else process.stdout.write(`driver-watchdog [${result.verdict.state}] ${result.checkout}\n  ${result.verdict.reason}\n`
      + (result.rollback ? `  ${result.rollback.reason}\n` : '') + `  action: ${result.action}\n`);
    return result.verdict.actionable ? 2 : 0;
  }

  process.stderr.write(`driver-watchdog: unknown verb "${verb}"\n\n${USAGE}\n`);
  return 1;
}

const IS_CLI = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (IS_CLI) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`driver-watchdog: ${String((e && e.stack) || e)}\n`); process.exitCode = 1; }
}
