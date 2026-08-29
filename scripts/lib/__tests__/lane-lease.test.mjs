/**
 * @file lane-lease.test.mjs — proof of the #2275 lease-decision core: staleness (TTL reclaim),
 *   acquirability (dirty/ahead + live-lease exclusion), and free-lane choice (lowest-index, deterministic).
 *   All pure — `lane-pool.mjs` supplies the IO (atomic O_EXCL create, git reset, status).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LEASE_TTL_MINUTES,
  WORKFLOW_LANE_PURPOSE,
  isLeaseStale,
  isLaneAcquirable,
  chooseFreeLane,
  leaseBody,
  describeLease,
  leaseOwnedBy,
  leaseOwnedByCaller,
  isForeignLease,
  laneMarkedSlug,
  assertedLaneSlug,
  laneHolderSlug,
  laneWorkerSession,
  isForeignOccupancy,
  isContestedLease,
  requiredAssertionSlug,
  isTransientRefLockError,
} from '../lane-lease.mjs';

const T0 = Date.parse('2026-07-05T12:00:00.000Z');
const ttlMs = DEFAULT_LEASE_TTL_MINUTES * 60_000;
const leaseAt = (isoOffsetMin, extra = {}) => ({ session: 'sess-a', acquiredAt: new Date(T0 + isoOffsetMin * 60_000).toISOString(), ...extra });

describe('isLeaseStale', () => {
  it('a fresh lease (just acquired) is live', () => {
    expect(isLeaseStale(leaseAt(0), T0, ttlMs)).toBe(false);
  });
  it('a lease younger than its TTL is live', () => {
    expect(isLeaseStale(leaseAt(-(DEFAULT_LEASE_TTL_MINUTES - 1)), T0, ttlMs)).toBe(false);
  });
  it('a lease older than its TTL is stale (reclaimable)', () => {
    expect(isLeaseStale(leaseAt(-(DEFAULT_LEASE_TTL_MINUTES + 1)), T0, ttlMs)).toBe(true);
  });
  it('honors a per-lease ttlMinutes over the default', () => {
    const short = leaseAt(-10, { ttlMinutes: 5 }); // 10 min old, 5 min TTL → stale
    expect(isLeaseStale(short, T0, ttlMs)).toBe(true);
    const long = leaseAt(-10, { ttlMinutes: 60 }); // 10 min old, 60 min TTL → live
    expect(isLeaseStale(long, T0, ttlMs)).toBe(false);
  });
  it('treats a malformed / dateless / null lease as stale (fail-open, never strand a lane)', () => {
    expect(isLeaseStale(null, T0, ttlMs)).toBe(true);
    expect(isLeaseStale({}, T0, ttlMs)).toBe(true);
    expect(isLeaseStale({ acquiredAt: 'not-a-date' }, T0, ttlMs)).toBe(true);
    expect(isLeaseStale('nonsense', T0, ttlMs)).toBe(true);
  });
});

describe('isLaneAcquirable', () => {
  const base = { lane: 1, exists: true, dirtyOrAhead: { dirty: false, ahead: 0 }, lease: null };
  it('a clean, unleased, existing lane is acquirable', () => {
    expect(isLaneAcquirable(base, T0, ttlMs)).toBe(true);
  });
  it('a missing lane is never acquirable', () => {
    expect(isLaneAcquirable({ ...base, exists: false }, T0, ttlMs)).toBe(false);
  });
  it('a lane with uncommitted work is protected (not acquirable) — #2267', () => {
    expect(isLaneAcquirable({ ...base, dirtyOrAhead: { dirty: true, ahead: 0 } }, T0, ttlMs)).toBe(false);
  });
  it('a lane with unpushed commits (ahead) is protected (not acquirable) — #2267', () => {
    expect(isLaneAcquirable({ ...base, dirtyOrAhead: { dirty: false, ahead: 2 } }, T0, ttlMs)).toBe(false);
  });
  it('a lane with a LIVE lease is off-limits', () => {
    expect(isLaneAcquirable({ ...base, lease: leaseAt(0) }, T0, ttlMs)).toBe(false);
  });
  it('a lane with a STALE lease is reclaimable', () => {
    expect(isLaneAcquirable({ ...base, lease: leaseAt(-(DEFAULT_LEASE_TTL_MINUTES + 1)) }, T0, ttlMs)).toBe(true);
  });
});

describe('chooseFreeLane', () => {
  const mk = (lane, over = {}) => ({ lane, exists: true, dirtyOrAhead: { dirty: false, ahead: 0 }, lease: null, ...over });
  it('picks the lowest-index acquirable lane (deterministic — concurrent acquirers converge, O_EXCL breaks the tie)', () => {
    const infos = [mk(3), mk(1), mk(2)];
    expect(chooseFreeLane(infos, T0, ttlMs)).toBe(1);
  });
  it('skips held/dirty lanes and picks the next free one', () => {
    const infos = [
      mk(1, { lease: leaseAt(0) }),                         // held
      mk(2, { dirtyOrAhead: { dirty: true, ahead: 0 } }),   // dirty
      mk(3),                                                // free ← winner
    ];
    expect(chooseFreeLane(infos, T0, ttlMs)).toBe(3);
  });
  it('reclaims a stale-leased lane when nothing else is free', () => {
    const infos = [mk(1, { lease: leaseAt(0) }), mk(2, { lease: leaseAt(-(DEFAULT_LEASE_TTL_MINUTES + 5)) })];
    expect(chooseFreeLane(infos, T0, ttlMs)).toBe(2);
  });
  it('returns null when the whole pool is held/busy', () => {
    const infos = [mk(1, { lease: leaseAt(0) }), mk(2, { dirtyOrAhead: { dirty: true, ahead: 0 } })];
    expect(chooseFreeLane(infos, T0, ttlMs)).toBeNull();
  });
});

describe('leaseBody / describeLease / leaseOwnedBy', () => {
  it('leaseBody normalizes optional fields', () => {
    const b = leaseBody({ session: 's', acquiredAt: '2026-07-05T12:00:00.000Z' });
    expect(b).toMatchObject({ session: 's', purpose: null, ttlMinutes: DEFAULT_LEASE_TTL_MINUTES, host: null, pid: null, ownerSession: null });
  });
  it('leaseBody carries an explicit pid + ownerSession through unchanged (#2367)', () => {
    const b = leaseBody({ session: 's', acquiredAt: '2026-07-05T12:00:00.000Z', pid: 111, ownerSession: 'sess-uuid-A' });
    expect(b.pid).toBe(111);
    expect(b.ownerSession).toBe('sess-uuid-A');
  });
  it('leaseBody no longer carries an ancestry field (r2 — pid-ancestry removed)', () => {
    const b = leaseBody({ session: 's', acquiredAt: '2026-07-05T12:00:00.000Z', pid: 111, ownerSession: 'sess-uuid-A' });
    expect('ancestry' in b).toBe(false);
  });
  it('leaseBody defaults workflowLane to false and carries an explicit true through (#2413)', () => {
    expect(leaseBody({ session: 's', acquiredAt: '2026-07-05T12:00:00.000Z' }).workflowLane).toBe(false);
    expect(leaseBody({ session: 's', acquiredAt: '2026-07-05T12:00:00.000Z', workflowLane: true }).workflowLane).toBe(true);
  });
  it('leaseBody OMITS predictedScope when no scope is declared — byte-identical marker to today (#2560)', () => {
    const b = leaseBody({ session: 's', acquiredAt: '2026-07-05T12:00:00.000Z' });
    expect('predictedScope' in b).toBe(false);
    expect(b.predictedScope).toBeUndefined();
  });
  it('leaseBody carries a non-empty predictedScope array through (#2560)', () => {
    const b = leaseBody({ session: 's', acquiredAt: '2026-07-05T12:00:00.000Z', predictedScope: ['we:a', 'we:b'] });
    expect(b.predictedScope).toEqual(['we:a', 'we:b']);
  });
  it('leaseBody OMITS an empty predictedScope array (omit-when-empty, #2560)', () => {
    const b = leaseBody({ session: 's', acquiredAt: '2026-07-05T12:00:00.000Z', predictedScope: [] });
    expect('predictedScope' in b).toBe(false);
  });
  it('describeLease renders who + purpose + when', () => {
    const s = describeLease(leaseBody({ session: 'drain-1', purpose: 'drain', acquiredAt: '2026-07-05T12:00:00.000Z' }));
    expect(s).toContain('drain-1');
    expect(s).toContain('drain');
  });
  it('leaseOwnedBy matches only the owning session', () => {
    const lease = leaseBody({ session: 'sess-a', acquiredAt: '2026-07-05T12:00:00.000Z' });
    expect(leaseOwnedBy(lease, 'sess-a')).toBe(true);
    expect(leaseOwnedBy(lease, 'sess-b')).toBe(false);
    expect(leaseOwnedBy(null, 'sess-a')).toBe(false);
  });
});

describe('isForeignLease (#2367 r2 — durable ownerSession is the SOLE ownership signal)', () => {
  const at = '2026-07-05T12:00:00.000Z';
  it('a live lease whose ownerSession differs from mine is FOREIGN (deny)', () => {
    const lease = leaseBody({ session: 's', acquiredAt: at, ownerSession: 'sess-A' });
    expect(isForeignLease({ lease, mySessionId: 'sess-B' })).toBe(true);
  });
  it('my own lease (ownerSession === mySessionId) is NOT foreign (allow)', () => {
    const lease = leaseBody({ session: 's', acquiredAt: at, ownerSession: 'sess-A' });
    expect(isForeignLease({ lease, mySessionId: 'sess-A' })).toBe(false);
  });
  it('DEGRADED — a lease with no ownerSession ⇒ fail-open (allow, not foreign)', () => {
    const lease = leaseBody({ session: 's', acquiredAt: at }); // ownerSession null (older lease / env unset at acquire)
    expect(isForeignLease({ lease, mySessionId: 'sess-B' })).toBe(false);
  });
  it('DEGRADED — the caller has no mySessionId ⇒ fail-open (allow), even though the lease carries one', () => {
    const lease = leaseBody({ session: 's', acquiredAt: at, ownerSession: 'sess-A' });
    expect(isForeignLease({ lease, mySessionId: null })).toBe(false);
    expect(isForeignLease({ lease, mySessionId: '' })).toBe(false);
  });
  it('no lease ⇒ never foreign; empty args never throw', () => {
    expect(isForeignLease({ lease: null, mySessionId: 'sess-A' })).toBe(false);
    expect(isForeignLease({})).toBe(false);
    expect(isForeignLease()).toBe(false);
  });
});

describe('leaseOwnedByCaller (#2452 Gap 2 — release ownership survives a defaultSession() host:pid change)', () => {
  const at = '2026-07-05T12:00:00.000Z';
  it('exact session match wins first (legacy / explicit --session flow, unchanged)', () => {
    const lease = leaseBody({ session: 'sess-a', acquiredAt: at });
    expect(leaseOwnedByCaller({ lease, session: 'sess-a', mySessionId: null })).toBe(true);
  });
  it('an UNMARKED lease: the acquiring session releases it via ownerSession even though its host:pid `session` string changed', () => {
    // Simulates: acquire ran as `host:111` (a since-exited pid), release runs as `host:222` — the exact bug
    // (`defaultSession()`'s ppid differs per shell invocation). ownerSession (CLAUDE_CODE_SESSION_ID) is
    // stable across both calls, so ownership is still recognized — for a TARGETED `--lane=N` release.
    const lease = leaseBody({ session: 'host:111', acquiredAt: at, ownerSession: 'sess-uuid-A' });
    expect(leaseOwnedByCaller({ lease, session: 'host:222', mySessionId: 'sess-uuid-A', targeted: true })).toBe(true);
  });
  it('an UNMARKED lease genuinely owned by a DIFFERENT session (different ownerSession, no session-string match) is NOT owned', () => {
    const lease = leaseBody({ session: 'host:111', acquiredAt: at, ownerSession: 'sess-uuid-A' });
    expect(leaseOwnedByCaller({ lease, session: 'host:222', mySessionId: 'sess-uuid-B', targeted: true })).toBe(false);
  });

  // #2452 review — the SWEEP carve-out. `workflowLane` is NOT the marker of a shared `ownerSession`: it is set
  // only for `--purpose=workflow-lane`, while the conveyor's concurrently-dispatched lanes
  // (`conveyor-delivery` / `conveyor-fix` / `conveyor-prepare-*`) are UNMARKED and still share one
  // `ownerSession`, because #2413 says a spawned subagent inherits the parent's id verbatim. Keying the
  // carve-out on `workflowLane` therefore left every unmarked sibling exposed: a bare `release --all` (which
  // targets EVERY held lane) dropped their live holds with no `--force`, and the next acquire runs
  // `checkout -B --force` + `clean -fd` on the clone the sibling was still working in. Two real lanes observed
  // in this shape: lane-1 {purpose:'review-loop-model-tiers'} and lane-2 {purpose:'2864-ledger-sha'} — one
  // ownerSession, different `session` strings, both unmarked.
  it('two UNMARKED siblings sharing one ownerSession are NOT mutually owned in a SWEEP (targeted:false)', () => {
    const sibling = leaseBody({ session: 'Mac:23707', acquiredAt: at, ownerSession: 'sess-uuid-shared' });
    // the sweeping caller is the same session (shared id) but a different shell invocation / logical holder
    expect(leaseOwnedByCaller({ lease: sibling, session: 'Mac:93309', mySessionId: 'sess-uuid-shared' })).toBe(false);
    expect(leaseOwnedByCaller({ lease: sibling, session: 'Mac:93309', mySessionId: 'sess-uuid-shared', targeted: false })).toBe(false);
    // …but naming that one lane explicitly still releases it — the fallback is preserved where intent is clear.
    expect(leaseOwnedByCaller({ lease: sibling, session: 'Mac:93309', mySessionId: 'sess-uuid-shared', targeted: true })).toBe(true);
  });
  it('a SWEEP still releases on an exact `session` match — the pre-#2452 rule is untouched', () => {
    const mine = leaseBody({ session: 'Mac:93309', acquiredAt: at, ownerSession: 'sess-uuid-shared' });
    expect(leaseOwnedByCaller({ lease: mine, session: 'Mac:93309', mySessionId: 'sess-uuid-shared' })).toBe(true);
  });
  it('`targeted` defaults to false — the conservative posture for any caller that omits it', () => {
    const lease = leaseBody({ session: 'host:111', acquiredAt: at, ownerSession: 'sess-uuid-A' });
    expect(leaseOwnedByCaller({ lease, session: 'host:222', mySessionId: 'sess-uuid-A' })).toBe(false);
  });
  // #2452 review — this case previously asserted FAIL-OPEN (`toBe(true)`), inheriting isForeignLease's
  // posture. That was an authorization weakening, not a fix: isForeignLease answers "is this PROVABLY someone
  // else's?" and returns false on no signal, so `!isForeignLease(...)` handed ANY caller ownership of an
  // unmarked lease that recorded no ownerSession — strictly weaker than the exact-session match this fallback
  // was meant to supplement, and a live hold could be dropped without --force. Ownership now needs a POSITIVE
  // match on both sides; no signal means not owned, so the explicit --force is required.
  it('DEGRADED (no ownerSession recorded) is NOT owned — the durable-id fallback needs a positive match', () => {
    const lease = leaseBody({ session: 'host:111', acquiredAt: at }); // no ownerSession recorded
    expect(leaseOwnedByCaller({ lease, session: 'host:222', mySessionId: 'sess-uuid-B', targeted: true })).toBe(false);
  });
  it('DEGRADED (caller has no mySessionId) is NOT owned either — both sides must be present and equal', () => {
    const lease = leaseBody({ session: 'host:111', acquiredAt: at, ownerSession: 'sess-uuid-A' });
    expect(leaseOwnedByCaller({ lease, session: 'host:222', mySessionId: null, targeted: true })).toBe(false);
    expect(leaseOwnedByCaller({ lease, session: 'host:222', mySessionId: '', targeted: true })).toBe(false);
  });
  it('a RESERVED lease is never owned via the ownerSession fallback — #2350 keeps --release-reserved the ONE un-reserve', () => {
    // ownerSession is minted on EVERY lease, reserved ones included, so without this carve-out an ordinary
    // `release` from the minting session would silently drop a PERMANENT reserved lane with no flag —
    // exactly what "#2350: --force alone never drops one" forbids.
    const lease = leaseBody({ session: 'reserved-slug', acquiredAt: at, ownerSession: 'sess-uuid-A', reserved: true });
    expect(leaseOwnedByCaller({ lease, session: 'host:222', mySessionId: 'sess-uuid-A', targeted: true })).toBe(false);
    // the exact minted-slug match still identifies it (the --release-reserved path does the un-reserving).
    expect(leaseOwnedByCaller({ lease, session: 'reserved-slug', mySessionId: 'sess-uuid-A', targeted: true })).toBe(true);
  });
  it('a MARKED (workflowLane) lease is owned ONLY via its exact minted-slug session match — ownerSession never substitutes, because siblings share it', () => {
    const lease = leaseBody({ session: 'batch-x-lane5', acquiredAt: at, ownerSession: 'sess-uuid-shared', workflowLane: true });
    // A sibling lane under the SAME orchestrator session (shared ownerSession) but a DIFFERENT minted slug must
    // NOT read as owned — that would let one sibling release another sibling's lane. True even when TARGETED.
    expect(leaseOwnedByCaller({ lease, session: 'batch-x-lane6', mySessionId: 'sess-uuid-shared', targeted: true })).toBe(false);
    // The correct slug, asserted as `session`, still owns it.
    expect(leaseOwnedByCaller({ lease, session: 'batch-x-lane5', mySessionId: 'sess-uuid-shared', targeted: true })).toBe(true);
  });
  it('no lease ⇒ never owned; empty args never throw', () => {
    expect(leaseOwnedByCaller({ lease: null, session: 's', mySessionId: 'x', targeted: true })).toBe(false);
    expect(leaseOwnedByCaller({})).toBe(false);
    expect(leaseOwnedByCaller()).toBe(false);
  });
});

describe('laneMarkedSlug / assertedLaneSlug (#2413 — the marked-lease per-op slug channel)', () => {
  const at = '2026-07-05T12:00:00.000Z';
  it('WORKFLOW_LANE_PURPOSE is the sanctioned purpose token', () => {
    expect(WORKFLOW_LANE_PURPOSE).toBe('workflow-lane');
  });
  it('laneMarkedSlug returns the minted session slug ONLY for a marked lease', () => {
    expect(laneMarkedSlug(leaseBody({ session: 'batch-x-2427', acquiredAt: at, workflowLane: true }))).toBe('batch-x-2427');
    expect(laneMarkedSlug(leaseBody({ session: 'batch-x-2427', acquiredAt: at }))).toBeNull(); // unmarked
    expect(laneMarkedSlug({ workflowLane: true })).toBeNull(); // marked but slug-less → nothing to assert
    expect(laneMarkedSlug(null)).toBeNull();
  });
  it('assertedLaneSlug parses an inline LANE_SESSION=<slug>, stopping at whitespace / operators', () => {
    expect(assertedLaneSlug('LANE_SESSION=batch-x-2427 git reset --hard origin/main')).toBe('batch-x-2427');
    expect(assertedLaneSlug('git reset --hard')).toBeNull();                       // absent
    expect(assertedLaneSlug('LANE_SESSION=new-my.slug/1 node scripts/x.mjs')).toBe('new-my.slug/1'); // slug chars
    expect(assertedLaneSlug('FOO=1 LANE_SESSION=s2 git clean -fd')).toBe('s2');     // amid other assignments
    expect(assertedLaneSlug('')).toBeNull();
    expect(assertedLaneSlug(undefined)).toBeNull();
  });
});

// ── #2997 — the minted per-holder channel, and the CONTESTED condition that arms it ──────────────────────
//
// #2413 built the per-holder slug and gated it on `workflowLane`, which only `--purpose=workflow-lane` sets.
// Every other topology took an UNMARKED lease and fell back to the `ownerSession` compare, which answers
// "mine" for every sibling agent of one session. Two recorded incidents walked through that residual:
// 2026-08-08 (a `git reset --hard` in a lane a same-session sibling held) and 2026-08-14 (a `release --lane=5`
// that dropped a different concurrent holder's lease). These pin the decision half of the closure.
describe('#2997 — laneHolderSlug (the minted per-holder slug on EVERY lease)', () => {
  const at = '2026-07-05T12:00:00.000Z';
  it('reads the dedicated `holder` field, independent of workflowLane', () => {
    expect(laneHolderSlug(leaseBody({ session: 'Mac:1', acquiredAt: at, holder: 'build-2997-lane-3-ab12cd34' }))).toBe('build-2997-lane-3-ab12cd34');
    expect(laneHolderSlug(leaseBody({ session: 'Mac:1', acquiredAt: at }))).toBeNull(); // pre-#2997 marker
    expect(laneHolderSlug({ holder: '' })).toBeNull();
    expect(laneHolderSlug({ holder: 42 })).toBeNull();
    expect(laneHolderSlug(null)).toBeNull();
  });
  it('leaseBody OMITS holder when none is minted — a byte-identical marker to pre-#2997 (back-compat)', () => {
    const b = leaseBody({ session: 's', acquiredAt: at });
    expect('holder' in b).toBe(false);
    expect(Object.keys(leaseBody({ session: 's', acquiredAt: at, holder: 'h-1' }))).toContain('holder');
  });
});

// ── #2997 r2 — the DECLARED-OCCUPANT channel (independent review of PR #1234, finding F1) ────────────────
//
// The first cut of Gap 1 denied an Edit/Write when `lease.ownerSession !== mySessionId`. But `acquire` stamps
// `ownerSession` from the env of the process that RUNS it, which is the DISPATCHER whenever a lane is leased
// on an agent's behalf — so that compare read FOREIGN for the lane's own legitimate occupant, and every
// dispatched lane in the pool would have gone read-only for the agent sent to work in it. Occupancy is now its
// own field, written only by a session claiming the lane for itself (`acquire --adopt` / `adopt --lane=N`).
describe('#2997 r2 — laneWorkerSession / isForeignOccupancy (who is WORKING here, not who leased it)', () => {
  const at = '2026-07-05T12:00:00.000Z';
  const dispatched = leaseBody({ session: 'Mac:45983', purpose: 'review-1234', acquiredAt: at, ownerSession: 'sess-DISPATCHER', holder: 'review-1234-lane-4-abcd1234' });
  const adopted = leaseBody({ ...dispatched, acquiredAt: at, workerSession: 'sess-WORKER' });

  it('leaseBody OMITS workerSession unless occupancy is claimed — an ordinary acquire\'s marker is unchanged', () => {
    expect('workerSession' in dispatched).toBe(false);
    expect(adopted.workerSession).toBe('sess-WORKER');
    expect('workerSession' in leaseBody({ session: 's', acquiredAt: at, workerSession: '' })).toBe(false);
  });

  it('laneWorkerSession reads the dedicated field only — never ownerSession', () => {
    expect(laneWorkerSession(dispatched)).toBeNull();
    expect(laneWorkerSession(adopted)).toBe('sess-WORKER');
    expect(laneWorkerSession({ workerSession: 42 })).toBeNull();
    expect(laneWorkerSession(null)).toBeNull();
  });

  // THE REGRESSION THE REVIEW CAUGHT. `ownerSession` is a THIRD PARTY to the working session and the working
  // session is the lane's rightful occupant. This shape had NO fixture, which is why a repo-wide false DENY
  // shipped with a green gate. It must be ALLOWED — before adoption and after.
  it('MUST-ALLOW: a dispatched lane is NOT foreign to the worker it was leased FOR (review F1)', () => {
    expect(isForeignOccupancy({ lease: dispatched, mySessionId: 'sess-WORKER' })).toBe(false);
    expect(isForeignOccupancy({ lease: adopted, mySessionId: 'sess-WORKER' })).toBe(false);
  });

  it('FOREIGN once a DIFFERENT session has declared occupancy — the deny is armed by the declaration', () => {
    expect(isForeignOccupancy({ lease: adopted, mySessionId: 'sess-INTRUDER' })).toBe(true);
    // …including the dispatcher that leased it: leasing a lane is not working in it.
    expect(isForeignOccupancy({ lease: adopted, mySessionId: 'sess-DISPATCHER' })).toBe(true);
  });

  it('fail-OPEN with no declared occupant, no session id, or no lease at all', () => {
    expect(isForeignOccupancy({ lease: dispatched, mySessionId: 'sess-ANYONE' })).toBe(false);
    expect(isForeignOccupancy({ lease: adopted, mySessionId: null })).toBe(false);
    expect(isForeignOccupancy({ lease: null, mySessionId: 'sess-MINE' })).toBe(false);
    expect(isForeignOccupancy({})).toBe(false);
    expect(isForeignOccupancy()).toBe(false);
  });
});

describe('#2997 — isContestedLease (when ambient session identity provably cannot answer)', () => {
  const at = '2026-07-05T12:00:00.000Z';
  const mine = leaseBody({ session: 'Mac:39367', acquiredAt: at, ownerSession: 'sess-shared', holder: 'h-mine' });
  it('CONTESTED when another live lease carries the SAME ownerSession (the sibling-subagent topology)', () => {
    const sibling = leaseBody({ session: 'Mac:39423', acquiredAt: at, ownerSession: 'sess-shared', holder: 'h-sib' });
    expect(isContestedLease({ lease: mine, siblingLeases: [sibling] })).toBe(true);
  });
  it('NOT contested when the only other live lease belongs to a DIFFERENT session', () => {
    const other = leaseBody({ session: 'Mac:2', acquiredAt: at, ownerSession: 'sess-other', holder: 'h-o' });
    expect(isContestedLease({ lease: mine, siblingLeases: [other] })).toBe(false);
  });
  it('NOT contested when no sibling holds a lane — the solo topology pays nothing', () => {
    expect(isContestedLease({ lease: mine, siblingLeases: [] })).toBe(false);
    expect(isContestedLease({ lease: mine })).toBe(false);
  });
  it('a lease with no ownerSession is never contested (nothing to collide on; fail-open, as documented)', () => {
    const idless = leaseBody({ session: 'Mac:1', acquiredAt: at, holder: 'h-x' });
    expect(isContestedLease({ lease: idless, siblingLeases: [leaseBody({ session: 'Mac:2', acquiredAt: at, holder: 'h-y' })] })).toBe(false);
  });
  // r2 (review F4/M10) — the `s !== lease` self-exclusion had no test, so removing it reddened nothing. A
  // caller that (spuriously) includes the subject lease in its own sibling list must NOT read as contested:
  // that is a lease colliding with itself, and treating it as a sibling collision is a pure false-deny.
  it('is NOT contested by ITSELF when the subject lease appears in its own sibling list', () => {
    expect(isContestedLease({ lease: mine, siblingLeases: [mine] })).toBe(false);
    // …and a real sibling alongside it still contests, so the self-exclusion narrows nothing it shouldn't.
    const sibling = leaseBody({ session: 'Mac:39423', acquiredAt: at, ownerSession: 'sess-shared', holder: 'h-sib' });
    expect(isContestedLease({ lease: mine, siblingLeases: [mine, sibling] })).toBe(true);
  });
  it('never throws on empty/absent args', () => {
    expect(isContestedLease({})).toBe(false);
    expect(isContestedLease()).toBe(false);
    expect(isContestedLease({ lease: mine, siblingLeases: null })).toBe(false);
  });
});

describe('#2997 — requiredAssertionSlug (the single shared "must this op prove itself?" decision)', () => {
  const at = '2026-07-05T12:00:00.000Z';
  const sibling = leaseBody({ session: 'Mac:39423', acquiredAt: at, ownerSession: 'sess-shared', holder: 'h-sib' });
  it('a MARKED lease keeps #2413 precedence — its minted session slug, contested or not (no refusal weakened)', () => {
    const marked = leaseBody({ session: 'batch-x-lane5', acquiredAt: at, ownerSession: 'sess-shared', workflowLane: true, holder: 'h-m' });
    expect(requiredAssertionSlug({ lease: marked, siblingLeases: [] })).toBe('batch-x-lane5');
    expect(requiredAssertionSlug({ lease: marked, siblingLeases: [sibling] })).toBe('batch-x-lane5');
  });
  it('an UNMARKED but CONTESTED lease requires its minted holder slug — the #2997 arm', () => {
    const mine = leaseBody({ session: 'Mac:39367', acquiredAt: at, ownerSession: 'sess-shared', holder: 'h-mine' });
    expect(requiredAssertionSlug({ lease: mine, siblingLeases: [sibling] })).toBe('h-mine');
  });
  it('an UNMARKED UNCONTESTED lease requires nothing — the #2367 compare is sound, so no new friction', () => {
    const mine = leaseBody({ session: 'Mac:39367', acquiredAt: at, ownerSession: 'sess-shared', holder: 'h-mine' });
    expect(requiredAssertionSlug({ lease: mine, siblingLeases: [] })).toBeNull();
  });
  it('a CONTESTED lease with NO minted holder requires nothing — pre-#2997 markers stay fail-open, not wedged', () => {
    const legacy = leaseBody({ session: 'Mac:39367', acquiredAt: at, ownerSession: 'sess-shared' });
    expect(requiredAssertionSlug({ lease: legacy, siblingLeases: [sibling] })).toBeNull();
  });
  it('no lease ⇒ nothing to assert; empty args never throw', () => {
    expect(requiredAssertionSlug({ lease: null, siblingLeases: [sibling] })).toBeNull();
    expect(requiredAssertionSlug()).toBeNull();
  });
});

describe('#2997 — leaseOwnedByCaller refuses the ownerSession fallback on a CONTESTED lease (the release incident)', () => {
  const at = '2026-07-05T12:00:00.000Z';
  // The 2026-08-14 occurrence, verbatim: `Mac:39367 file-memory-rewrite-gap` ran `release --lane=5` and the
  // pool dropped `Mac:39423 review-1222-r2` — both leases carrying one parent CLAUDE_CODE_SESSION_ID.
  const victim = leaseBody({ session: 'Mac:39423', acquiredAt: at, ownerSession: 'sess-shared', holder: 'review-1222-r2-lane-5-9f3a1c07' });
  it('a TARGETED release of a sibling holder\'s contested lease is REFUSED (it was ALLOWED before #2997)', () => {
    expect(leaseOwnedByCaller({ lease: victim, session: 'Mac:39367', mySessionId: 'sess-shared', targeted: true, contested: true })).toBe(false);
  });
  it('…and is still ALLOWED when UNCONTESTED — #2452\'s fix for the acquire↔release ppid drift is untouched', () => {
    expect(leaseOwnedByCaller({ lease: victim, session: 'Mac:39367', mySessionId: 'sess-shared', targeted: true, contested: false })).toBe(true);
    expect(leaseOwnedByCaller({ lease: victim, session: 'Mac:39367', mySessionId: 'sess-shared', targeted: true })).toBe(true); // contested defaults false
  });
  it('the TRUE holder still releases its own contested lane by asserting the minted slug as --session', () => {
    expect(leaseOwnedByCaller({ lease: victim, session: 'review-1222-r2-lane-5-9f3a1c07', mySessionId: 'sess-shared', targeted: true, contested: true })).toBe(true);
    // …and the slug works for a SWEEP too, exactly like the exact-`session` match it generalizes.
    expect(leaseOwnedByCaller({ lease: victim, session: 'review-1222-r2-lane-5-9f3a1c07', mySessionId: 'sess-shared', targeted: false, contested: true })).toBe(true);
  });
  it('a CONTESTED lease with no minted holder keeps the pre-#2997 fallback — never unreleasable', () => {
    const legacy = leaseBody({ session: 'Mac:39423', acquiredAt: at, ownerSession: 'sess-shared' });
    expect(leaseOwnedByCaller({ lease: legacy, session: 'Mac:39367', mySessionId: 'sess-shared', targeted: true, contested: true })).toBe(true);
  });
  it('the #2350 reserved carve-out still wins over the new holder channel (--release-reserved stays the ONE un-reserve)', () => {
    const reserved = leaseBody({ session: 'memory-lane', acquiredAt: at, ownerSession: 'sess-shared', reserved: true, holder: 'h-res' });
    expect(leaseOwnedByCaller({ lease: reserved, session: 'Mac:1', mySessionId: 'sess-shared', targeted: true, contested: true })).toBe(false);
    expect(leaseOwnedByCaller({ lease: reserved, session: 'Mac:1', mySessionId: 'sess-shared', targeted: true, contested: false })).toBe(false);
  });
});

describe('isTransientRefLockError — the shared-object-store fetch race lane-pool.mjs retries', () => {
  it('matches the real message git prints on a ref-lock race (live-fire dispatch test, 2026-08-29)', () => {
    const msg = "error: cannot lock ref 'refs/remotes/origin/lane/mechanical-dispatcher-recovered': "
      + 'is at d0c83a7b0400c28b496f2a940b65b095ad11cfc8 but expected ca540827b3a39ab9345e75385ce3172535584bbb';
    expect(isTransientRefLockError(msg)).toBe(true);
  });
  it('is case-insensitive and matches on a substring (execFileSync errors wrap the git stderr in prose)', () => {
    expect(isTransientRefLockError('Command failed: git fetch origin\nError: Cannot Lock Ref \'x\': is at a but expected b')).toBe(true);
  });
  it('does NOT match an unrelated fetch failure — a real error must still throw unretried', () => {
    expect(isTransientRefLockError('fatal: unable to access \'https://github.com/x/y.git/\': Could not resolve host')).toBe(false);
    expect(isTransientRefLockError('fatal: couldn\'t find remote ref main')).toBe(false);
  });
  it('null/undefined/non-string input never matches (fail closed to "not retryable")', () => {
    expect(isTransientRefLockError(null)).toBe(false);
    expect(isTransientRefLockError(undefined)).toBe(false);
    expect(isTransientRefLockError('')).toBe(false);
  });
});
