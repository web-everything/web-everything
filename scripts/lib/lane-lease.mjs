/**
 * lane-lease.mjs — the pure lease-decision core for the #2275 use-agnostic leased-checkout allocator.
 *
 * A lane in the #1933 pool is a use-agnostic isolated checkout. Today two sessions that each read
 * `lane-pool.mjs status`, both see a lane `clean`, and both pick it — a silent collision (observed while
 * filing #2285's slices: a `/slice` reset a lane a concurrent session was mid-edit in). The fix is an
 * EXCLUSIVE LEASE: `acquire` atomically marks a free lane held, and both a concurrent `acquire` and the
 * pool's own `refresh`/`provision` `reset --hard` treat a held lane as off-limits until `release`.
 *
 * This module is the DECISION half — no filesystem, no git, no clock — so it is unit-testable:
 *   - `isLeaseStale(lease, nowMs, ttlMs)`  — has a lease outlived its heartbeat TTL (owner died/hung)?
 *   - `chooseFreeLane(laneInfos, nowMs, ttlMs)` — the lowest-index lane safe to acquire, or null.
 *   - `leaseBody(...)` / `describeLease(lease)` — build / render the marker.
 * `lane-pool.mjs` owns the IO half (atomic O_EXCL write, git reset, status) and calls these.
 *
 * The exclusive hold is enforced by an atomic `O_EXCL` create of the marker (see `lane-pool.mjs`
 * `cmdAcquire`): for a PRISTINE free lane (no marker) that create is race-free, which is the collision the
 * story targets. Reclaiming a STALE marker (owner gone) has a small unlink→create window — the documented
 * residual this shares with the stronger central-broker lock #1936/#1945; a fresh acquire never races.
 */

export const LEASE_FILENAME = '.lane-lease';

// #2413 — the sanctioned `--purpose` token a parallel-/workflow lane acquire passes. `acquire` normalizes it
// into the dedicated `workflowLane: true` lease field (a contract field, NOT free-text `purpose`), so every
// downstream reader keys on the field. A MARKED lease switches the destructive-op guard fail-CLOSED: the op
// must assert this lease's own minted slug inline (`LANE_SESSION=<slug>`), because in the parallel-lane
// topology sibling sessions share `ownerSession` and cannot otherwise be told apart. See `laneMarkedSlug` /
// `assertedLaneSlug` and `we:scripts/guard-bash.mjs`.
export const WORKFLOW_LANE_PURPOSE = 'workflow-lane';

// A held lane is presumed abandoned after this long with no release — long enough to outlast a slow drain
// cascade / batch, short enough that a crashed session's lane returns to the pool the same day. `acquire`
// may reclaim a lease older than this; `--ttl-minutes` overrides per call.
export const DEFAULT_LEASE_TTL_MINUTES = 240;

/**
 * Has this lease outlived its TTL (so the owner is presumed gone and the lane is reclaimable)?
 * A malformed / dateless lease is treated as stale (fail-open to reclaim, never strand a lane forever).
 *
 * #2350 — a RESERVED (permanent) lease is the ONE exception: it has NO TTL and NEVER goes stale, so
 * `acquire` never reclaims it, `refresh`/`provision` (even `--force`) never reset it, and auto-pick never
 * couples an item onto it. This is what makes a lane a durable, off-limits slot (the dedicated persistent
 * memory-lane). A reserved lease is dropped only by the deliberate `release --release-reserved` un-reserve.
 */
export function isLeaseStale(lease, nowMs, ttlMs = DEFAULT_LEASE_TTL_MINUTES * 60_000) {
  if (!lease || typeof lease !== 'object') return true;
  if (lease.reserved) return false; // #2350 — permanent reserved lane: never expires, never reclaimed/reset
  const acquired = Date.parse(lease.acquiredAt);
  if (Number.isNaN(acquired)) return true;
  // #3383 — a holder that is still working RENEWS its lease ({@link renewedLease}); the TTL runs from the later of the two
  const renewed = Date.parse(lease.renewedAt);
  const at = Number.isNaN(renewed) ? acquired : Math.max(acquired, renewed);
  const ttl = Number.isFinite(lease.ttlMinutes) ? lease.ttlMinutes * 60_000 : ttlMs;
  return nowMs - at >= ttl;
}

/**
 * #3383 — the lease a still-working holder writes back to keep its lane: the same lease with `renewedAt` set, which
 * {@link isLeaseStale} counts the TTL from. Pure. A reserved lease has no TTL and is returned unchanged; anything
 * that is not a lease is `null`. Found live 2026-09-23: a `poc-land.mjs` landing outlived its lane's 4-hour lease
 * while its gate waited in the heavy-command queue, and the lane was reclaimed and reset under it.
 * @param {object} lease @param {string} nowIso
 */
export function renewedLease(lease, nowIso) {
  if (!lease || typeof lease !== 'object') return null;
  if (lease.reserved) return lease;
  return { ...lease, renewedAt: nowIso };
}

/** #2350 — is this a RESERVED (permanent) lease? A pure boolean read (older leases lack the field ⇒ falsy ⇒
 *  ordinary TTL-governed lease, today's semantics). Callers use it to render the hold distinctly and to gate
 *  `release` (a reserved lane is never handed back except via the deliberate `--release-reserved` override). */
export function isReservedLease(lease) {
  return !!(lease && lease.reserved);
}

/**
 * Is a `git fetch` failure the transient shared-object-store ref-lock race, safe to retry — versus a real
 * failure (network down, bad remote) a caller must not paper over? Live-fire dispatch test, 2026-08-29:
 * every lane in the #1933 pool clones `--reference` the same object store, so two lanes fetching at once can
 * both touch the same `refs/remotes/origin/*` and git refuses the loser with `"error: cannot lock ref
 * '<ref>': is at X but expected Y"`. On a host running several concurrent sessions this is ORDINARY
 * contention, not a real error — `lane-pool.mjs`'s `fetchOriginPruneWithRetry` uses this predicate to
 * retry ONLY this exact signature; every other fetch failure still throws unretried, exactly as before.
 */
export function isTransientRefLockError(message) {
  const m = String(message ?? '');
  return /cannot lock ref/i.test(m) || /unable to create '[^']*\.lock': file exists/i.test(m);
}

/**
 * Is a lane safe to acquire right now? Exists, holds no other session's uncommitted / unpushed work
 * (`dirtyOrAhead` — the #2267 data-loss guard), and carries no LIVE lease (none, or a stale one to reclaim).
 */
export function isLaneAcquirable(info, nowMs, ttlMs) {
  if (!info || !info.exists) return false;
  const doa = info.dirtyOrAhead;
  if (doa && (doa.dirty || doa.ahead > 0)) return false; // someone's work lives here — never recycle it
  return !info.lease || isLeaseStale(info.lease, nowMs, ttlMs);
}

/**
 * #xn432dz — does the LEASE ALONE already make `isLaneAcquirable` false, whatever the tree holds? True iff the
 * marker is LIVE (present and not stale — a reserved lease is never stale, so it always disqualifies). This is
 * the cheap file-read gate a picker runs BEFORE paying for `git status` / `rev-list` on a lane: when it returns
 * true, `isLaneAcquirable({ exists: true, lease, dirtyOrAhead: <anything> }, nowMs, ttlMs)` is false for EVERY
 * possible `dirtyOrAhead`, so skipping the git probe cannot change the verdict. When it returns false the
 * caller must still run the probe — a missing/stale lease says nothing about un-pushed work (#2267).
 * Observed 2026-09-23: 14 concurrent `list --acquirable` scans ran git in all ~129 lanes (most of them leased)
 * and pinned fseventsd at ~100% CPU.
 */
export function leaseDisqualifiesAcquire(lease, nowMs, ttlMs) {
  return !!lease && !isLeaseStale(lease, nowMs, ttlMs);
}

/**
 * The lowest-index acquirable lane, or null if the pool is fully held/busy. Deterministic (index order) so
 * concurrent acquirers converge on the same candidate and the atomic O_EXCL create picks exactly one winner.
 *
 * `excludeLane` (#xzitlr9 follow-up) is the CALLER'S OWN lane, and auto-pick skips it. Acquiring resets the
 * lane to the integration branch, so handing back the lane the caller is standing in changes their working
 * directory out from under them mid-task — observed 2026-09-06, where a bare `acquire --purpose=review-juror`
 * returned the driving lane and reset its checkout off the working branch.
 *
 * This is NOT the data-loss guard: `isLaneAcquirable`'s `dirtyOrAhead` test (#2267) already refuses any lane
 * holding uncommitted or unpushed work, and it held in that incident — nothing was lost. This is the
 * narrower surprise of a clean, pushed lane being reset while its owner is still working in it. It is a
 * PREFERENCE, not a refusal: an explicit `--lane=N` still names whatever the caller names, because someone
 * asking for a specific lane by number has said what they mean.
 */
export function chooseFreeLane(laneInfos, nowMs, ttlMs, { excludeLane = null } = {}) {
  const eligible = laneInfos
    .filter((i) => isLaneAcquirable(i, nowMs, ttlMs))
    .sort((a, b) => a.lane - b.lane);
  const notSelf = excludeLane == null ? eligible : eligible.filter((i) => i.lane !== excludeLane);
  // Fall back to the full set when EVERY free lane is the caller's own: a single-lane pool must still
  // acquire, and refusing there would be worse than the surprise this avoids.
  const pick = notSelf.length ? notSelf : eligible;
  return pick.length ? pick[0].lane : null;
}

/** Build a lease marker object. Caller stamps `acquiredAt` (ISO) so this stays clock-free / testable.
 *  `ownerSession` (#2367) is the DURABLE session identity (`CLAUDE_CODE_SESSION_ID`, captured at acquire) —
 *  the SOLE ownership signal `isForeignLease` compares against: it is stable across a session's separate
 *  Bash-tool calls yet distinct between concurrent sessions, and does NOT false-match two independent sessions
 *  that merely share an upper process ancestor (terminal, a parallel-lane orchestrator) — the over-match that
 *  made the earlier pid-ancestry heuristic unsafe in this guard's target topology (r2: pid-ancestry removed).
 *  `pid` is informational only (human-readable `status`/debug; a leaf that exits right after `acquire`, never
 *  useful for ownership).
 *  `predictedScope` (#2560 final slice) is the OPTIONAL, ADVISORY repo-qualified `"<repo>:<path>"` file-scope
 *  list a lane declares at acquire (`acquire --scope=`). It is the real predicted-scope source the live
 *  scope-lease observer/collector consumes — but it NEVER gates the acquire (the whole-clone lease is the real
 *  lock; §3i-A4 Fork 1). OMITTED from the marker when empty/absent, so a scope-less acquire produces a
 *  byte-identical marker to today (back-compat). Normalization is the CALLER's job — this stays zero-import.
 *  `reserved` (#2350) marks a PERMANENT reserved lane: no TTL, never stale, off-limits to acquire/refresh/
 *  provision, dropped only by `release --release-reserved`. OMITTED when false so an ordinary acquire's marker
 *  stays byte-identical to today (same back-compat discipline as `predictedScope`).
 *  `holder` (#2997) is the MINTED PER-HOLDER slug every acquire now stamps — the one ownership signal that is
 *  distinct between two SIBLING agents of the SAME session (`ownerSession` is identical for them by
 *  construction, which is the whole #2997 gap). OMITTED when absent, so a `leaseBody` call that passes no
 *  holder produces a byte-identical marker to today (an on-disk lease minted before #2997 simply has no
 *  `holder`, ⇒ `laneHolderSlug` null ⇒ the pre-#2997 fail-open behaviour, unchanged).
 *  `workerSession` (#2997 r2) is the session id of the agent that will actually WORK this lane — deliberately
 *  a DIFFERENT field from `ownerSession`, which records only whoever RAN `acquire`. OMITTED unless a caller
 *  positively claims occupancy (`acquire --adopt` / `adopt`), so an ordinary acquire's marker stays
 *  byte-identical to today. See `isForeignOccupancy` for why the two cannot be the same field.
 *  `base` (#3637) is the REF THIS LANE WAS FORKED FROM — `acquire --base=<ref>`'s own argument. Before this it
 *  survived an acquire only in the `--json` payload and one stderr line, so anything downstream that needed to
 *  know a lane was based on something other than `main` had to be told separately or lost it (blocker 3 of
 *  `#3637`'s survey). A POC-targeted lane MUST carry it: `we:scripts/lane-pool.mjs` does
 *  `checkout -B <repo.branch> <baseRef>`, so the lane's content comes from the POC branch while its LOCAL
 *  BRANCH is still named `main` — the local branch name cannot be used to infer the target, and this field is
 *  what can. Deliberately a BRANCH NAME (or any ref), NOT the hex-SHA `base` that
 *  `we:scripts/readiness/lane-manifest.mjs` validates: those are two different facts about two different
 *  artifacts (a lease vs. a PR-body manifest) that merely share a word. OMITTED when absent, so a base-less
 *  acquire's marker stays byte-identical to today; a reader keys on `laneBaseRef`. */
export function leaseBody({ session, purpose, acquiredAt, ttlMinutes = DEFAULT_LEASE_TTL_MINUTES, host, pid, ownerSession, workflowLane, predictedScope, reserved, holder, workerSession, base }) {
  return {
    session, purpose: purpose || null, acquiredAt, ttlMinutes, host: host || null,
    pid: pid ?? null, ownerSession: ownerSession ?? null,
    // #2413 — a MARKED (parallel-/workflow) lease. A plain boolean contract field (never null) so a reader can
    // key on it directly; older on-disk leases lack it (⇒ undefined ⇒ falsy ⇒ unmarked, today's semantics).
    workflowLane: !!workflowLane,
    // #2350 — a PERMANENT reserved lane. Included ONLY when true (omit-when-false keeps an ordinary acquire's
    // marker byte-identical to today); a reader keys on `isReservedLease`. A reserved lease never expires.
    ...(reserved ? { reserved: true } : {}),
    // #2997 — the minted PER-HOLDER slug. Included ONLY when a non-empty string (omit-when-absent keeps a
    // holder-less caller's marker byte-identical to today); a reader keys on `laneHolderSlug`.
    ...(typeof holder === 'string' && holder ? { holder } : {}),
    // #2997 r2 — the DECLARED OCCUPANT: the session that will actually work in this lane. Included ONLY when a
    // caller positively claims occupancy, so an ordinary acquire's marker is unchanged; a reader keys on
    // `laneWorkerSession` / `isForeignOccupancy`.
    ...(typeof workerSession === 'string' && workerSession ? { workerSession } : {}),
    // #2560 — advisory predicted file-scope, included ONLY when a non-empty array (omit-when-empty keeps a
    // scope-less acquire's marker byte-identical to today). A defensive copy so the caller can't alias in.
    ...(Array.isArray(predictedScope) && predictedScope.length ? { predictedScope: [...predictedScope] } : {}),
    // #3637 — the ref this lane was forked from (`acquire --base=<ref>`). Included ONLY when a non-empty
    // string, same omit-when-absent discipline as every field above it.
    ...(typeof base === 'string' && base.trim() ? { base: base.trim() } : {}),
  };
}

/** #3637 — the ref this lane was forked from, or `null` (an ordinary `--base`-less acquire, or a marker
 *  written before this field existed). The signal a POC-targeted lane carries its delivery target by, since
 *  `we:scripts/lane-pool.mjs`'s `checkout -B` leaves the lane's LOCAL branch named `main` regardless of what
 *  it was based on. Pure. */
export function laneBaseRef(lease) {
  return lease && typeof lease.base === 'string' && lease.base.trim() ? lease.base.trim() : null;
}

/**
 * Is `lease` held by a session OTHER than mine? The #2367 ownership decision — pure & unit-tested; the impure
 * fs/env collection lives in the CLI (guard-bash.mjs). Decided from the durable session ids ALONE (r2 removed
 * the pid-ancestry fallback, whose chain-overlap OVER-MATCHED two independent sessions sharing an upper process
 * ancestor — the guard's own target topology, parallel lanes under one orchestrator — and so failed OPEN in the
 * one place it mattered while looking protective).
 *
 *   OWNED / FOREIGN: when the lease carries an `ownerSession` AND the caller read a `mySessionId`, the lease is
 *     FOREIGN iff `lease.ownerSession !== mySessionId` (equal ⇒ mine). Authoritative — the owner's own lease can
 *     never read as foreign because both sides key on the same `CLAUDE_CODE_SESSION_ID` string.
 *   DEGRADED (fail-OPEN, ALLOW ⇒ returns false): the lease has no `ownerSession` (an older lease, or one whose
 *     acquire couldn't read the env), OR the caller has no `mySessionId`. Without an identity signal on both
 *     sides "owner" and "foreign" are fundamentally indistinguishable, so this deliberately treats the lease as
 *     NOT foreign — matching the guard's established fail-open posture (a guard bug must never wedge the agent).
 *     This is the intentional trade-off of r2: drop the misleading "protective-looking but unsafe" pid-ancestry
 *     fallback rather than replace it with a noisy fail-closed.
 *   No lease ⇒ never foreign.
 */
export function isForeignLease({ lease, mySessionId } = {}) {
  if (!lease) return false;
  if (lease.ownerSession && mySessionId) return lease.ownerSession !== mySessionId;
  return false; // degraded: no identity signal on both sides ⇒ fail-open (allow) — see doc above
}

/**
 * Is `lease` CONFIRMED to be held by MY OWN session — the complement `isForeignLease` deliberately does not
 * provide. `isForeignLease` fails OPEN on an ambiguous read (no `ownerSession`, no `mySessionId`) because its
 * callers gate a DENY on a positive "foreign" finding, and a guard bug must never wedge the agent. A caller
 * gating an ALLOW on "this is mine" needs the opposite failure direction: ambiguous must read as NOT mine, or
 * the same missing-identity gap that makes `isForeignLease` degrade to allow would make this degrade to allow
 * too — for a predicate whose whole job is refusing everything except a confirmed match (#3378).
 *
 * A bare `ownerSession` compare is NOT that confirmed match, though — three review rounds on #3378 caught the
 * same shipped bug from different angles, because this same file already documents two topologies where
 * `ownerSession` equality does not mean "mine":
 *
 *   1. DISPATCHER/WORKER split (`workerSession`, #2997 r2 above). `ownerSession` records whoever RAN `acquire`,
 *      which is the DISPATCHER when a lane is leased on an agent's behalf and later handed off (`adopt`) — see
 *      the `dispatched`/`adopted` fixtures in `lane-lease.test.mjs`. Once occupancy is DECLARED, the declaring
 *      session is the only one confirmed, dispatcher included: `isForeignOccupancy` already treats "leasing a
 *      lane is not working in it" as the rule for DENY, so this must apply the same rule for ALLOW.
 *   2. SIBLING / `workflowLane` leases (`isContestedLease` above). Every sibling lane in a parallel `/workflow`
 *      or conveyor dispatch shares one `ownerSession` by construction (#2413/#2997), so a bare compare confirms
 *      EVERY sibling's lane as "mine", not just the caller's own — exactly the ambiguity `leaseOwnedByCaller`
 *      already refuses to resolve from `ownerSession` alone for a targeted `release` (step 2 above). When
 *      another live lease anywhere in the pool shares this lease's `ownerSession`, the ambient id is provably
 *      ambiguous and the `ownerSession` fallback is refused here too.
 *
 *   TRUE only when: a DECLARED occupant (`workerSession`) matches me — checked first and, once present, decides
 *   alone; OR there is no declared occupant AND `ownerSession` matches me AND no sibling lease in `siblingLeases`
 *   shares that `ownerSession` (uncontested). Anything else — no lease, no `mySessionId`, a mismatched worker, a
 *   mismatched owner, or a CONTESTED owner match — is NOT confirmed mine, fail-closed.
 */
export function isConfirmedOwnLease({ lease, mySessionId, siblingLeases = [] } = {}) {
  if (!lease || !mySessionId) return false;
  const worker = laneWorkerSession(lease);
  if (worker) return worker === mySessionId;
  if (!lease.ownerSession) return false;
  if (isContestedLease({ lease, siblingLeases })) return false;
  return lease.ownerSession === mySessionId;
}

// #2997 r2 — the DECLARED-OCCUPANT channel, and why `ownerSession` could not be it ────────────────────────
//
// `lane-pool.mjs acquire` stamps `ownerSession` from the env of the process that RUNS the acquire. That is the
// working agent in ONE topology (the conveyor/dispatch brief has the agent acquire its own lane — see
// `we:scripts/operations/dispatch-lane-io.mjs`, "the agent's very first instruction is to acquire a lane of its
// own") and the DISPATCHER in another (an operator leases lane-N and hands the path to a spawned agent, which
// runs under a session id of its own). A reader of the marker cannot tell those two apart, so
// `lease.ownerSession !== mySessionId` does NOT mean "someone else is working here" — for a dispatched lane it
// is true BY CONSTRUCTION for the lane's own legitimate occupant.
//
// The first cut of Gap 1 denied on exactly that compare, which would have made every dispatched lane READ-ONLY
// for the agent sent to work in it (independent review of PR #1234, F1 — reproduced live: a lease whose
// `purpose` was minted FOR the denied agent). The fix is not a special case; it is to stop overloading one
// field with two meanings. `ownerSession` keeps its meaning ("who ran acquire" — the #2367/#2452 release
// signal, untouched), and OCCUPANCY gets its own field that ONLY a session claiming to work the lane ever
// writes: `workerSession`, stamped by `acquire --adopt` or by the `adopt` hand-off command.
//
// Consequence, stated plainly: a lane whose occupant was never declared is NOT protected by the Edit/Write arm
// — it stays writable, exactly as on `main` before this item. That is the deliberate trade: an undeclared lane
// cannot be told from a dispatched one, and a false DENY here wedges an agent out of its own lane, which is
// strictly worse than the silent-write hole it would be closing.

/** The session that DECLARED it is working in this lane (`workerSession`), or null when none ever did. Pure. */
export function laneWorkerSession(lease) {
  return lease && typeof lease.workerSession === 'string' && lease.workerSession ? lease.workerSession : null;
}

/**
 * #2997 r2 — is this lane provably OCCUPIED BY SOMEONE ELSE? The ownership decision for the `Edit`/`Write`
 * guard (`guard-lane.mjs`), which has no per-operation assertion channel and so must be certain before it
 * denies. Pure.
 *
 *   FOREIGN (deny) ⇒ the lease carries a DECLARED occupant (`workerSession`) AND this caller has a session id
 *     AND they differ. Only a session claiming the lane for itself ever writes that field, so a mismatch is a
 *     positive statement that a different agent is working here — not an inference from who ran `acquire`.
 *   NOT FOREIGN (allow) ⇒ everything else: no lease, no declared occupant (an ordinary acquire, a dispatched
 *     lane nobody adopted, a pre-#2997 marker), or no session id on this side. Fail-OPEN, the guard's standing
 *     posture — see the block comment above for why the `ownerSession` compare is NOT a safe substitute.
 */
export function isForeignOccupancy({ lease, mySessionId } = {}) {
  const worker = laneWorkerSession(lease);
  if (!worker || !mySessionId) return false; // no declared occupant / no id here ⇒ nothing is proven ⇒ allow
  return worker !== mySessionId;
}

/** One-line human description of a lease for `status` output. */
export function describeLease(lease) {
  if (!lease) return '';
  const who = lease.session || 'unknown';
  const why = lease.purpose ? ` (${lease.purpose})` : '';
  // #2350 — a reserved lane is a PERMANENT hold, not a TTL-bounded one; label it so `status`/skip logs read true.
  if (lease.reserved) return `RESERVED (permanent) by ${who}${why}`;
  return `leased by ${who}${why} @ ${lease.acquiredAt}`;
}

/** Does `session` own this lease? (Guards `release` from dropping another session's hold without --force.) */
export function leaseOwnedBy(lease, session) {
  return !!lease && !!session && lease.session === session;
}

/**
 * #2452 (Gap 2) — is the CALLER the owner of `lease`, for the purpose of an un-forced `release`? Generalizes
 * `leaseOwnedBy` past its host:pid-keyed `session` string, which is unstable across a session's separate
 * shell invocations (`defaultSession()` falls back to `${hostname()}:${process.ppid}` when no `--session` /
 * `LANE_SESSION` is given) — the very bug this closes: the session that ACQUIRED a lease read as "not yours"
 * on a later RELEASE call because the two calls' `process.ppid` differed.
 *
 *   1. Exact `session` match (`leaseOwnedBy`) wins first — this is the AUTHORITATIVE signal for a MARKED
 *      (`workflowLane`) lease, whose `session` field is the minted per-lane slug an orchestrator asserts
 *      identically at both acquire and release (`LANE_SESSION=<slug>`), and it also keeps any legacy explicit
 *      `--session` flow working unchanged.
 *   2. For an UNMARKED lease with no exact `session` match, fall through to the durable `ownerSession` signal
 *      (#2367, `isForeignLease`'s DEGRADED fail-open posture): stable across a session's separate Bash-tool
 *      calls (unlike host:pid), so the session that acquired the lease can release it without needing an
 *      identical `--session` string on both ends. A MARKED lease is deliberately EXCLUDED from this fallback —
 *      every sibling parallel lane intentionally SHARES `ownerSession` (see `laneMarkedSlug`'s doc), so
 *      `ownerSession` alone cannot tell one lane's own release from a sibling's; the minted slug (step 1) is
 *      that lease's sole ownership signal.
 *
 * @param targeted the caller named ONE specific lane (`release --lane=N`), rather than sweeping (`--all`).
 *   REQUIRED for the step-2 `ownerSession` fallback; defaults to `false` (the conservative posture).
 *
 * #2452 review — why `targeted` gates step 2. `workflowLane` is NOT the marker of "siblings share this
 * ownerSession"; it is set only for `--purpose=workflow-lane`, which only the parallel `/workflow` template
 * passes. The conveyor dispatches concurrent lanes as `conveyor-delivery` / `conveyor-fix` /
 * `conveyor-prepare-*` — UNMARKED, yet they share one `ownerSession` too, because #2413's ratified statute
 * says a spawned subagent inherits its parent's id verbatim and so "no ambient env/process property can
 * distinguish siblings". Without this gate a bare `release --all` (which targets EVERY held lane) dropped
 * those siblings' live leases with no `--force`, after which a fresh acquire runs `checkout -B --force` +
 * `clean -fd` on the clone a sibling was still working in. `ownerSession` answers "same session", never
 * "this lane"; naming the lane supplies the missing half. A sweep therefore keeps the old exact-`session`
 * rule (`leaseOwnedBy`) and anything else needs the explicit `--force`.
 */
export function leaseOwnedByCaller({ lease, session, mySessionId, targeted = false, contested = false } = {}) {
  if (!lease) return false;
  if (leaseOwnedBy(lease, session)) return true;
  // #2997 — the MINTED PER-HOLDER slug is an ownership proof in its own right, asserted through the SAME
  // `--session=` / `LANE_SESSION=` channel the exact-`session` match above already reads. This is what lets a
  // holder release its own lane in the contested topology the `ownerSession` fallback below now refuses.
  if (laneHolderSlug(lease) && !!session && laneHolderSlug(lease) === session) return true;
  if (!targeted) return false; // a SWEEP never widens past the exact-session match (see #2452 review, above)
  if (lease.workflowLane) return false; // marked lease: ownership is the minted slug ONLY (step 1 above)
  // #2452 review — a RESERVED lease is never releasable through the ownerSession fallback. #2350 makes
  // `release --release-reserved` the ONE deliberate un-reserve ("--force alone never drops one"), and
  // `ownerSession` is minted on EVERY lease including reserved ones — so falling through here would let an
  // ordinary `release` from the minting session silently drop a permanent reserved lane, no flag required.
  if (isReservedLease(lease)) return false;
  // #2452 review — require a POSITIVE identity match. `isForeignLease` fails OPEN by design (it answers
  // "is this provably someone else's?", returning false when either side has no identity signal), so
  // `!isForeignLease(...)` treated "no signal at all" as "mine" — handing any caller the right to release an
  // unmarked lease that recorded no `ownerSession`, which is strictly weaker than the exact-`session` match
  // this fallback was meant to supplement. Ownership now needs both sides present AND equal; anything else
  // falls back to the explicit `--force`.
  // #2997 — …and when the lease is CONTESTED, `ownerSession` may not answer at all. On 2026-08-14 a subagent
  // ran `release --lane=5` meaning its OWN lease and dropped a DIFFERENT concurrent holder's, because both
  // leases carried the same parent `CLAUDE_CODE_SESSION_ID` and this fallback resolved to "same session,
  // therefore mine". #2452 already recorded WHY (`ownerSession` answers "same session", never "this lane") and
  // gated the fallback behind `targeted` — but naming a lane only proves the caller MEANT that lane, not that
  // it HOLDS it, and the incident was a targeted `--lane=5`. So when another LIVE lease in the pool shares this
  // lease's `ownerSession` (`isContestedLease`), the ambient id is provably ambiguous and this fallback is
  // refused: ownership must come from the minted `holder` slug above (or the explicit `--force`). A lease with
  // no minted `holder` cannot be proven either way, so it keeps the pre-#2997 fallback rather than becoming
  // unreleasable — the documented degraded mode for a marker written before this shipped.
  if (contested && laneHolderSlug(lease)) return false;
  return !!lease.ownerSession && !!mySessionId && lease.ownerSession === mySessionId;
}

// #2997 — the minted PER-HOLDER ownership channel, generalizing #2413's marked-lane slug to EVERY lease ──────
//
// #2413 built the right answer (a slug minted per holder and asserted per operation) but gated it on the
// `workflowLane` marker, which only `--purpose=workflow-lane` sets. Every other concurrent topology — ad-hoc
// subagents, the conveyor's `conveyor-delivery`/`conveyor-fix`/`conveyor-prepare-*` dispatch — takes an
// UNMARKED lease and falls back to the `ownerSession` compare, which cannot separate siblings of one session.
// #2997 closes that residual by minting a `holder` slug on EVERY acquire and asserting it where the ambient
// signal is provably ambiguous. The regime is scoped to exactly that case (see `isContestedLease`) so the
// ordinary solo topology — one session, one lane — pays no new friction at all.

/** The minted per-holder slug this lease carries, or null (an unmarked pre-#2997 marker, or a caller that
 *  minted none). Pure. Distinct from `laneMarkedSlug`: that one answers only for a `workflowLane` lease and
 *  reads the `session` field; this reads the dedicated `holder` field every acquire now stamps. */
export function laneHolderSlug(lease) {
  return lease && typeof lease.holder === 'string' && lease.holder ? lease.holder : null;
}

/**
 * #2997 — is `lease` CONTESTED: does at least one OTHER live lease share its `ownerSession`? Pure — the caller
 * supplies `siblingLeases` (the other lanes' leases, already filtered to LIVE ones and excluding this lane).
 * Both callers (`guard-bash.mjs#siblingLaneLeases`, `lane-pool.mjs#liveLeasesInPoolExcept`) scan EVERY pool
 * under the `.lanes/` root, not just this lane's own pool — a session's siblings routinely hold lanes in a
 * different pool and the ambient id is exactly as ambiguous there (r2, review F3/R2).
 *
 * SCOPE OF THE CLOSURE, stated plainly (r2, review F3/R1). This predicate needs a SECOND live lease to exist.
 * A sibling agent that holds NO lane of its own — a review subagent, say — leaves nothing to find, so a lane
 * whose holder is its session's only holder reads UNCONTESTED and the op is allowed. That is not closed here.
 * The 2026-08-08 incident (a lane-less review subagent clobbering lane-1) is therefore covered ONLY when some
 * other lane was live under the same `ownerSession` at that moment; in the sole-holder shape it is not.
 *
 * This is the precise, script-decidable statement of "ambient session identity cannot answer here". When no
 * sibling of this session holds another lane, `ownerSession` DOES distinguish owner from foreigner and the
 * #2367 compare is sound — so nothing changes for the ordinary solo topology. The moment a second live lease
 * carries the same `ownerSession`, that compare answers "mine" for every one of those holders, which is the
 * exact condition behind both recorded incidents (2026-08-08 `reset --hard`, 2026-08-14 `release --lane=5`).
 *
 * A lease with no `ownerSession` is never contested — with no identity on the lease there is no shared id to
 * collide on, and the surrounding checks are already in their documented fail-open degraded mode.
 */
export function isContestedLease({ lease, siblingLeases = [] } = {}) {
  if (!lease || !lease.ownerSession) return false;
  return (Array.isArray(siblingLeases) ? siblingLeases : []).some(
    (s) => s && s !== lease && s.ownerSession === lease.ownerSession,
  );
}

/**
 * #2997 — the slug an operation must ASSERT to act on this lane, or null when no assertion is required.
 * Pure; the single place both guards and `lane-pool release` agree on what "prove it is yours" means.
 *
 *   • a MARKED (`workflowLane`) lease ⇒ its #2413 minted `session` slug, ALWAYS (contested or not) — that
 *     regime is unchanged and keeps precedence, so no existing refusal is weakened here.
 *   • an UNMARKED but CONTESTED lease ⇒ its minted `holder` slug (#2997) — the new arm.
 *   • anything else ⇒ null: the #2367 `ownerSession` compare is sound (uncontested), or there is no slug to
 *     assert (a pre-#2997 marker), which keeps the documented fail-open posture rather than wedging a lane.
 */
export function requiredAssertionSlug({ lease, siblingLeases = [] } = {}) {
  const marked = laneMarkedSlug(lease);
  if (marked) return marked;
  if (!isContestedLease({ lease, siblingLeases })) return null;
  return laneHolderSlug(lease);
}

// #2413 — the minted-slug ownership channel for a MARKED (workflowLane) lease. In the parallel-/workflow
// topology every sibling lane shares `ownerSession`, so ambient identity can't tell a lane's own destructive
// op from a sibling's. Instead the guard keys on a MINTED slug (`<batchSlug>-<laneKey>`, stored in the lease's
// `session`) that each op must ASSERT inline in its command string — the one per-op channel with both ends
// in-repo (the orchestrator template mints + asserts it; the guard checks it here).

/** The slug a LIVE MARKED lease requires an op to assert, or null if the lease is unmarked / slug-less. The
 *  caller decides liveness (needs a clock); this is the pure marked-vs-unmarked + which-slug decision. */
export function laneMarkedSlug(lease) {
  return lease && lease.workflowLane && lease.session ? lease.session : null;
}

/** Parse an inline `LANE_SESSION=<slug>` assertion out of a command string (the per-op ownership channel a
 *  marked lease requires), or null if absent. Mirrors the guard's `LANE_CLOBBER_OK=1` env-token parse; the
 *  slug is a bare `<batchSlug>-<laneKey>` token, so match slug-shaped chars only (never a trailing operator). */
export function assertedLaneSlug(command) {
  const m = String(command || '').match(/\bLANE_SESSION=([A-Za-z0-9._/-]+)/);
  return m ? m[1] : null;
}

/**
 * The caller's own lane NUMBER, for `chooseFreeLane`'s `excludeLane` — or null when the caller is not
 * standing in a lane OF THE POOL BEING ACQUIRED. PURE: the caller injects both paths.
 *
 * SCOPED TO THE TARGET POOL, and that is the whole point (#1961 correctness finding 3). A regex over any
 * `.lanes/<pool>/lane-N` segment leaks across pools: standing in `.lanes/repoA/lane-2` and acquiring in
 * repoB would exclude repoB's lane 2 — an unrelated lane that is not the caller's and not at risk. The
 * effect is only a suboptimal pick (the fallback still prevents exhaustion), but the heuristic would be
 * measuring the wrong thing, and this codebase acquires cross-repo on purpose (the dispatcher's impl-repo
 * lanes), so the mismatch is reachable rather than theoretical.
 *
 * @param cwdReal   the caller's REALPATH'd working directory.
 * @param poolDir   the REALPATH'd pool directory being acquired from (`<workspace>/.lanes/<pool>`).
 * @param sepChar   path separator (injected so the logic is testable on any platform).
 * @returns the lane number, or null.
 */
export function ownLaneNumber(cwdReal, poolDir, sepChar = '/') {
  const cwd = String(cwdReal || '');
  const pool = String(poolDir || '').replace(new RegExp(`\\${sepChar}+$`), '');
  if (!cwd || !pool) return null;
  // Must be INSIDE this pool — not merely inside some pool.
  if (cwd !== pool && !cwd.startsWith(pool + sepChar)) return null;
  const rest = cwd.slice(pool.length).replace(new RegExp(`^\\${sepChar}`), '');
  const m = rest.match(/^lane-(\d+)(?:$|[/\\])/);
  return m ? Number(m[1]) : null;
}

/**
 * Did THIS lane author a commit since the lease was taken, and did that commit LAND? Read off the lane's own HEAD
 * reflog (`%gt<TAB>%H<TAB>%gs` per line — reflog entry time, the commit the entry points at, its subject): a
 * `commit…` / `cherry-pick…` entry at or after `acquiredAtMs` whose commit `isLanded` is work the holder produced
 * and finished. A lane that merely synced forward (`reset` / `checkout` / fast-forward `merge` / `pull`) to a newer
 * main records no such entry, and one that committed WIP then `reset --hard` to main abandoned that commit, so it
 * is not on upstream and does not count. A commit's own date is no proof either — a live, still-empty lane that
 * fast-forwards to a main that moved after its acquire also has a HEAD newer than `acquiredAt`. Pure; a missing or
 * empty reflog reads as "no".
 */
export function laneAuthoredSince(reflogLines, acquiredAtMs, isLanded = () => true) {
  if (!Array.isArray(reflogLines) || !Number.isFinite(acquiredAtMs)) return false;
  return reflogLines.some((line) => {
    const [ts, sha, ...rest] = String(line).split('\t');
    const ms = Number.parseInt(ts, 10) * 1000;
    return Number.isFinite(ms) && ms >= acquiredAtMs && /^(commit|cherry-pick)\b/.test(rest.join('\t').trim())
      && Boolean(sha) && isLanded(sha) === true;
  });
}

/**
 * A clean, landed HEAD that THIS lease's holder produced. `authoredSinceAcquire` ({@link laneAuthoredSince}) is
 * required: a clean tree whose HEAD sits on upstream also describes a live lane that only synced to a newer main.
 */
export function isDeliveredLease({ porcelain, headIsAncestorOfUpstream, headCommitMs, acquiredAtMs, authoredSinceAcquire }) {
  return porcelain === '' && headIsAncestorOfUpstream === true && authoredSinceAcquire === true
    && Number.isFinite(headCommitMs) && Number.isFinite(acquiredAtMs)
    && headCommitMs >= acquiredAtMs;
}

// ── The lane hold rule (we:backlog/xbdixjc-lane-hold-rule-protect-unpushed.md) ─────────────────────────────────
// "May this lane be released, reset, removed or reclaimed right now?" A fixer that ends its turn to await verify
// looks gone to the lease reaper; on 2026-10-08 17:00–21:00Z the reaper released 24 lanes holding unpushed work
// and acquire reset 10 over it, stranding verified commits (#4446, #4461, #4433, #4453). This is ONE rule, pure,
// over plain facts — no git, GitHub, label or file-name strings — so the reaper, release, acquire, trim, reclaim
// and refresh paths all ask the same question and a second implementation can pass the same replay fixtures.
// Every threshold and mode is a DECLARED SETTING below; the `off` values reproduce the behaviour before this rule.

/** The rule's name, as it appears in journal lines, logs and the settings env prefix. */
export const LANE_HOLD_RULE = 'lane-hold';

/** Built-in settings. Off values (the pre-rule behaviour): `mode: 'off'`, `aheadEquivalence: 'any'`. */
export const BUILT_IN_LANE_HOLD_SETTINGS = Object.freeze({
  // 'enforce' — a held lane is refused by every path; 'off' — the rule always allows (the pre-rule behaviour).
  mode: 'enforce',
  // How long a hold signal (an await-verify record, a running or passed verify, an unreadable verify record) stays
  // live, measured from its own timestamp. Equals the await-verify TTL (150 min); past it the salvage path takes
  // the work, so a lane is never held forever.
  holdMinutes: 150,
  // How much of a lane's unpushed history must be patch-equivalent to work already on the remote before a
  // reset may treat it as pushed: 'every' unpushed change, or 'any' one of them (the pre-rule behaviour, which
  // let one already-pushed commit vouch for a newer unpushed fix — lane-5, 4b254297, 2026-10-08 17:56Z).
  aheadEquivalence: 'every',
});

const LANE_HOLD_SETTING_RULES = {
  mode: (v) => v === 'enforce' || v === 'off',
  holdMinutes: (v) => Number.isFinite(v) && v >= 1 && v <= 24 * 60,
  aheadEquivalence: (v) => v === 'every' || v === 'any',
};
/** Env overrides, one per setting. */
export const LANE_HOLD_SETTING_ENV = Object.freeze({
  mode: 'WE_LANE_HOLD', holdMinutes: 'WE_LANE_HOLD_MINUTES', aheadEquivalence: 'WE_LANE_AHEAD_EQUIVALENCE',
});

/**
 * Resolve the settings: built-ins, then a plain object (a settings file's contents), then env. Each key is
 * validated on its own; a malformed value keeps the built-in (never a looser one). Pure.
 * @param {{env?:object, raw?:object}} [p]
 */
export function resolveLaneHoldSettings({ env = {}, raw = null } = {}) {
  const out = { ...BUILT_IN_LANE_HOLD_SETTINGS };
  const take = (key, value) => { if (LANE_HOLD_SETTING_RULES[key](value)) out[key] = value; };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(LANE_HOLD_SETTING_RULES)) if (Object.hasOwn(raw, key)) take(key, raw[key]);
  }
  for (const [key, name] of Object.entries(LANE_HOLD_SETTING_ENV)) {
    const value = env?.[name];
    if (value === undefined || value === '') continue;
    take(key, key === 'holdMinutes' ? Number(value) : String(value).trim());
  }
  return out;
}

/** The actions the rule judges. `take-over` = a new holder claiming a lane whose lease went stale. */
export const LANE_HOLD_ACTIONS = Object.freeze(['release', 'reset', 'remove', 'reclaim', 'take-over']);

const holdLive = (atMs, nowMs, holdMs) => Number.isFinite(atMs) && nowMs - atMs <= holdMs;

/**
 * Does the decision for these facts depend on `unpushed`? Lets an IO shell skip the (costly) work-state read
 * when the answer cannot change. Pure; same fact shape as {@link laneHoldVerdict}.
 */
export function laneHoldNeedsWorkState(facts, settings = BUILT_IN_LANE_HOLD_SETTINGS) {
  if (!facts || settings.mode === 'off') return false;
  if (facts.byHolder === true && facts.action === 'release') return false;
  const holdMs = settings.holdMinutes * 60_000;
  if ((facts.awaits ?? []).some((a) => holdLive(a?.requestedAtMs, facts.nowMs, holdMs))) return false;
  const v = facts.verify;
  if (!v || !holdLive(v.atMs, facts.nowMs, holdMs)) return false;
  if (v.state === 'running') return false;
  if (v.state === 'unreadable') return true;
  return v.state === 'passed' && !!v.revision && v.revision === facts.revision;
}

/**
 * THE LANE HOLD RULE. Pure.
 * @param {{
 *   action: 'release'|'reset'|'remove'|'reclaim'|'take-over',
 *   byHolder?: boolean,            // the caller holds this lane's lease (its own release is always allowed)
 *   nowMs: number,
 *   awaits?: Array<{requestedAtMs:number}>, // await-verify records that name this lane (a parked fixer)
 *   verify?: null|{state:'running'|'passed'|'failed'|'unreadable', revision?:string|null, atMs:number},
 *   revision?: string|null,        // the lane's current commit id
 *   unpushed?: boolean|null,       // the lane holds work on no remote; null/undefined = unknown
 * }} facts
 * @param {typeof BUILT_IN_LANE_HOLD_SETTINGS} [settings]
 * @returns {{allowed:boolean, hold:(null|'awaiting-verify'|'verifying'|'verified-unpushed'|'verify-unreadable'|'work-state-unknown'), reason:string}}
 */
export function laneHoldVerdict(facts, settings = BUILT_IN_LANE_HOLD_SETTINGS) {
  const allow = (reason) => ({ allowed: true, hold: null, reason });
  const hold = (h, reason) => ({ allowed: false, hold: h, reason: `${LANE_HOLD_RULE}: ${reason}` });
  if (settings?.mode === 'off') return allow(`${LANE_HOLD_RULE} off`);
  if (!facts || typeof facts !== 'object' || !LANE_HOLD_ACTIONS.includes(facts.action) || !Number.isFinite(facts.nowMs)) {
    return hold('work-state-unknown', 'facts missing or malformed — never act blind');
  }
  if (facts.byHolder === true && facts.action === 'release') return allow('the holder releases its own lane');
  const holdMs = (settings?.holdMinutes ?? BUILT_IN_LANE_HOLD_SETTINGS.holdMinutes) * 60_000;
  const { nowMs } = facts;
  if ((facts.awaits ?? []).some((a) => holdLive(a?.requestedAtMs, nowMs, holdMs))) {
    return hold('awaiting-verify', 'a fixer is parked awaiting verify for this lane and will resume in it');
  }
  const v = facts.verify;
  if (v && holdLive(v.atMs, nowMs, holdMs)) {
    if (v.state === 'running') return hold('verifying', 'a verify gate is running or queued for this lane');
    const atHead = v.state === 'passed' && !!v.revision && v.revision === facts.revision;
    if (atHead || v.state === 'unreadable') {
      if (facts.unpushed === false) return allow('verified work is already pushed');
      if (facts.unpushed !== true) return hold('work-state-unknown', 'cannot tell whether the verified work is pushed');
      return atHead
        ? hold('verified-unpushed', 'the lane holds a verified commit that is not pushed yet')
        : hold('verify-unreadable', 'the verify record is unreadable and the lane holds unpushed work');
    }
  }
  return allow('no hold signal');
}
