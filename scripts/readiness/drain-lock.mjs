/**
 * @file scripts/readiness/drain-lock.mjs
 * @description The drain's DUAL-LOCK concurrency guard (#2391, under #2387) — two distinct locks the land
 *   paths and the drain lifecycle contend on, both built on the atomic `O_EXCL`/mkdir + TTL-lease primitive
 *   in {@link ./file-locks.mjs} (never a fork of it).
 *
 * WHY (#2391): the drain is the SOLE SERIAL WRITER to main (#2288/#2290) — at most one process may mint an
 * NNN. Today nothing ENFORCES that: three land call sites number-then-push with no mutual exclusion
 * (`we:scripts/lane-drain.mjs` finalizeLand, `we:scripts/merge-ai-prs.mjs` land, `we:scripts/pr-land.mjs`
 * fallback-git), so two lands racing off the same base could both compute `max+1` and assign the SAME NNN —
 * a latent duplicate-numbering race the #2318 tripwire only catches AFTER it lands. This module closes it.
 *
 * TWO LOCKS, distinct lifetimes:
 *   1. SERIAL-WRITER-TO-MAIN MUTEX (a.k.a. the numbering-critical-section mutex) — a short-lived, TTL-bounded
 *      lock the land call sites take around the two writes that MUST be single-writer: the `gh pr merge`
 *      itself ({@link withLandWriteLock}) AND the number+publish step ({@link withNumberingLock}). Both share
 *      ONE lock key ({@link NUMBERING_LOCK_PATH}), so a merge and a numbering run in DIFFERENT processes are
 *      mutually exclusive — held for the seconds each takes; a crashed holder expires by the (short) TTL so the
 *      section never wedges. #2683 widened this from numbering-only to the merge write too: a `--only=<pr>`
 *      FAST DRAIN bypasses the whole-process lease (below), so this mutex is the ONLY thing serializing its
 *      `gh pr merge` against a concurrent resident-daemon sweep — the numbering mutex alone (pre-#2683) guarded
 *      only NNN allocation, leaving two processes free to race the actual merge write. Enforces the
 *      sole-serial-writer invariant: at most one process writes to main (merge OR NNN) at a time.
 *   2. WHOLE-PROCESS DRAIN LEASE — a distinct lock held for a drain run's FULL lifetime
 *      ({@link acquireDrainLease}/{@link heartbeatDrainLease}/{@link releaseDrainLease}). A second drain
 *      launch that finds a LIVE lease no-ops (its work is already being done); a STALE lease (a crashed
 *      drain) is reclaimed via the TTL. push-at-close reads {@link drainLeaseStatus} to know a drain is
 *      mid-flight before it publishes.
 *
 *      #3440 — the lease is keyed by the INVOKING CHECKOUT'S OWN repo identity ({@link localRepoSlug}, threaded
 *      through as `repoKey`), not just hostname+pid. Before this, ALL drains on a machine (regardless of which
 *      project's checkout launched them) shared the ONE fixed {@link DRAIN_LEASE_PATH} lock dir, so a resident
 *      drain for one project (e.g. `plateau-app`'s own `tools/drain-daemon/daemon.mjs`) held the SAME lease a
 *      `web-everything` drain invocation contended on — even though the two structurally never sweep each
 *      other's repo. That let one project's daemon silently starve another's: the blocked launch either false
 *      no-op'd (a legacy/unscoped holder reads as "covers everything", #2458) or, when scoped, correctly
 *      reported itself uncovered but still could not run concurrently. Keying the lock PATH by `repoKey`
 *      ({@link drainLeasePathFor}) gives each invoking checkout its own lock dir, so two DIFFERENT repos' drain
 *      runs hold independent leases and never block each other — while drains launched from the SAME checkout
 *      (the actual sole-serial-writer-to-that-repo's-main invariant #2391/#2449 exists for) still serialize on
 *      the SAME key, exactly as before. `repoKey` is OPTIONAL and defaults to `null` ⇒ the legacy global path,
 *      so a caller that never supplies one (a stale mirror, a test) keeps today's coarse, still-correct
 *      (if imprecise) behaviour.
 *
 * SHARED, MACHINE-GLOBAL LOCK ROOT: the contenders run in DIFFERENT checkouts (a lane clone, the user's
 * primary, a `/pr` fast-drain), so the lock home is a fixed HOME-level dir ({@link DRAIN_LOCK_ROOT}), NOT the
 * per-checkout `.claude/locks` file-locks uses — otherwise two checkouts would never see each other's lock.
 * Like all lock state it is LOCAL-ONLY, machine-disposable (Rule #105); it never lands on main.
 *
 * The atomic fs + reclaim decision live in file-locks.mjs (unit-tested there); this module is the thin,
 * drain-specific wiring over it (two fixed sentinel keys + a spin-acquire wrapper), unit-tested in
 * scripts/readiness/__tests__/drain-lock.test.mjs.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { canonicalizeSlug } from '../lib/constellation-repos.mjs';
import {
  reserve, readLockEntry, releaseLockDir, heartbeat, isLeaseExpired, DEFAULT_LEASE_MINUTES,
} from './file-locks.mjs';

/** Machine-global lock home — shared across every checkout on the host so lands in DIFFERENT clones contend
 *  on the SAME lock. Local-only, never committed/pushed (Rule #105). */
export const DRAIN_LOCK_ROOT = join(homedir(), '.claude', 'drain-locks');

/** The two fixed sentinel "paths" file-locks keys its lock dirs by (a path hashes to one lock dir). They are
 *  distinct strings ⇒ distinct lock dirs ⇒ the mutex and the lease never alias. */
export const NUMBERING_LOCK_PATH = '<drain:numbering-critical-section>';
export const DRAIN_LEASE_PATH = '<drain:whole-process-lease>';

/** The numbering section is SECONDS (number a few files + one push), so its TTL is short — a crashed holder
 *  frees the section fast. Long enough to outlast a slow push. */
export const NUMBERING_LEASE_MINUTES = 5;

/** A drain run heartbeats within this lease for its whole lifetime; a heartbeat older than it ⇒ the drain
 *  crashed and the lease is reclaimable. Reuses the file-locks default (15 min). */
export const DRAIN_LEASE_MINUTES = DEFAULT_LEASE_MINUTES;

// ── owner identity ──────────────────────────────────────────────────────────────
/** A stable per-process owner id: host + pid + kind. The SAME string must be used to acquire, heartbeat, and
 *  release, so a caller builds it ONCE and threads it through. */
export function makeOwner(kind) { return `${hostname()}:${process.pid}:${kind}`; }
/** The whole-process drain lease owner for this process. */
export function drainOwner() { return makeOwner('drain'); }

// ── xuqk1vp — reclaim only a genuinely DEAD holder, never the TTL alone ────────────
/**
 * Same-machine PID-liveness probe for a held numbering/land-write lock entry, mirroring
 * `heavy-admission.mjs`'s `probeSlotHolderLiveness` (kept separate rather than imported: that helper takes a
 * bare `(pid, selfPid)` pair keyed to the admission lock's own reservation shape, while this reads straight off
 * a `file-locks.mjs` entry and additionally requires the entry's `owner` to name THIS host — the lock root
 * (`DRAIN_LOCK_ROOT`) is machine-global but this repo's contenders (a lane clone, the primary, `/pr`) are all
 * same-host by construction (see file header); a foreign-host owner (a stale entry copied in some other way, or
 * a future cross-host contender) must never be probed with a LOCAL `process.kill` — a reused pid on THIS host
 * could then be misread as the (different-host) holder. Returns `'dead'` only when a same-host pid is provably
 * gone (`ESRCH`); `'alive'`/`'unknown'` otherwise — the TTL floor in {@link reclaimDecision} is always the
 * fallback for everything that isn't a proven-dead same-host pid.
 * @param {{owner:string, pid:number|null}|null} entry
 * @returns {'dead'|'alive'|'unknown'}
 */
export function probeNumberingHolderLiveness(entry) {
  if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0) return 'unknown';
  const entryHost = String(entry.owner || '').split(':')[0];
  if (!entryHost || entryHost !== hostname()) return 'unknown'; // not provably this host — never guess
  if (entry.pid === process.pid) return 'alive'; // the probing process can't be its own dead holder
  try { process.kill(entry.pid, 0); return 'alive'; }
  catch (e) { return e && e.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

// ── #3440 — per-repo lease key ────────────────────────────────────────────────────
/** The invoking checkout's own repo identity — an `org/repo` slug parsed from `git remote get-url origin` run
 *  in `cwd`. Used to key the whole-process drain lease PER REPO ({@link drainLeasePathFor}) so a drain launched
 *  from one project's checkout never contends with (or falsely reads as covering) one launched from another's.
 *  `null` when it can't be determined (no git / no origin remote / detached) — callers then fall back to the
 *  legacy global lease key via `repoKey: null`. Pure enough to inject `exec`/`cwd` for tests. */
export function localRepoSlug({ cwd = process.cwd(), exec = execFileSync } = {}) {
  try {
    const url = exec('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return m ? canonicalizeSlug(m[1]) : null;
  } catch { return null; }
}

/** The actual lock-dir key for the whole-process drain lease: `repoKey` given ⇒ a repo-specific path (distinct
 *  lock dir from every other repo's); omitted/`null` ⇒ the legacy fixed sentinel {@link DRAIN_LEASE_PATH}
 *  (today's behaviour, unchanged). Pure. */
export function drainLeasePathFor(repoKey = null) {
  return repoKey ? `${DRAIN_LEASE_PATH}::${repoKey}` : DRAIN_LEASE_PATH;
}

// ── impure helpers ────────────────────────────────────────────────────────────────
function ensureRoot(lockRoot) { try { mkdirSync(lockRoot, { recursive: true }); } catch { /* best-effort; reserve() also self-heals a missing root */ } }
const nowIsoFrom = (nowMs) => new Date(nowMs).toISOString();

/** Block the calling thread `ms` milliseconds WITHOUT a busy-wait (mirrors lane-drain's sleepSync). Used to
 *  space the spin-acquire polls. A SharedArrayBuffer-less env degrades to no wait (the spin still bounds via
 *  its deadline). */
export function sleepSyncMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.floor(ms))); } catch { /* no SAB — skip */ }
}

// ── (1) numbering-critical-section mutex ─────────────────────────────────────────

/**
 * Try to acquire the numbering mutex ONCE for `owner`. Thin over file-locks `reserve` (which atomically wins
 * the dir, or reclaims a stale/dead holder). xuqk1vp: hands `reserve` the same-host pid-liveness PROBE
 * ({@link probeNumberingHolderLiveness}), so a provably-dead holder is reclaimed on the `pid-dead` fast path
 * immediately — not only after the TTL — while a live-but-slow holder is NEVER reclaimed by the TTL alone
 * while its own heartbeat stays fresh (see {@link withNumberingLock}'s in-section heartbeat). The probe runs
 * inside `reserve`, against the one entry it reads (review #2668): probing here first and passing a verdict
 * would let a "dead" verdict about an OLD holder reclaim a NEW, live one that took over in between.
 * Returns `{ ok, reason, heldBy }`.
 */
export function tryAcquireNumberingLock(lockRoot, owner, { pid = process.pid, leaseMinutes = NUMBERING_LEASE_MINUTES, nowMs = Date.now(), lockPath = NUMBERING_LOCK_PATH } = {}) {
  ensureRoot(lockRoot);
  return reserve(lockRoot, lockPath, owner, nowMs, nowIsoFrom(nowMs), pid, probeNumberingHolderLiveness, leaseMinutes);
}

/** Release the numbering mutex, but ONLY if `owner` still holds it (never stomp a reclaimer who seized it
 *  mid-section — the file-locks fencing invariant). Idempotent. `lockPath` selects WHICH short-lived write
 *  mutex to release — it defaults to the numbering section's own key, and #3637's per-POC-branch land lock
 *  ({@link pocLandLockPathFor}) passes its own so the two never alias. */
export function releaseNumberingLockIfOwned(lockRoot, owner, lockPath = NUMBERING_LOCK_PATH) {
  const cur = readLockEntry(lockRoot, lockPath);
  if (cur && cur.owner === owner) { releaseLockDir(lockRoot, lockPath); return true; }
  return false;
}

/**
 * Run `fn` inside the NUMBERING CRITICAL SECTION — the mutex that makes the number+publish step
 * sole-serial-writer (#2288/#2290). Spin-acquires (reclaim-aware, pid-dead-fast-path per xuqk1vp) up to
 * `waitMs`, runs `fn`, then releases (only if still owned). The default `waitMs` is a full lease, so a
 * CRASHED holder is always reclaimed within the budget (immediately if its pid is provably dead) and only a
 * genuinely-live holder can block.
 *
 * `fn` is called as `fn(heartbeat)` — xuqk1vp: a multi-step section (JIT-number, then resolve-on-land, then
 * push; or a merge-cascade's per-PR loop) can call `heartbeat()` between its own steps to refresh the lock's
 * `heartbeatAt` mid-section, WITHOUT any timer/thread (Node's single-threaded, so a heartbeat can only ever
 * happen at a synchronous call boundary `fn` itself controls). This is what makes "the section can legitimately
 * outlive `leaseMinutes`" safe: a genuinely-live holder that heartbeats stays un-reclaimable (the TTL floor in
 * `reclaimDecision` only fires once the heartbeat itself goes stale), while a holder that crashed mid-section
 * stops heartbeating and is reclaimed by the TTL (or sooner, via the pid-dead fast path) exactly as before. A
 * caller that ignores the arg (every pre-existing `() => {...}` `fn`) is unaffected — extra call args are a
 * no-op in JS. `heartbeat` itself is a no-op once the lock is no longer held (reclaimed away, or never held).
 *
 * `runUnlockedOnContention` DEFAULTS `true` (UNCHANGED — #2288/#2683 backward compat): several existing
 * call sites (`merge-ai-prs.mjs`, `pr-land.mjs`, `number-pending-hashes-before-push.mjs`) are OUTSIDE this
 * item's declared scope and still read `.result` assuming `fn` always ran; flipping the shared default out
 * from under them would hand each an `undefined` result on contention with no matching guard — a worse bug
 * than the one this item fixes. xuqk1vp's "never run a write-to-main section unlocked" instead ships as an
 * OPT-IN (`runUnlockedOnContention: false`, mirroring the #3637 POC-land contract exactly): the ONE in-scope
 * write-to-main section this item owns (`lane-drain.mjs`'s numbering+push) passes it explicitly and handles
 * `ran:false` via {@link lockResultOr}. A future item can migrate the other call sites the same way, each
 * auditing its own `.result` consumption — tracked as a natural follow-up, not silently forced here.
 *
 * @returns {{ result: any, ran: boolean, held: boolean, contended: boolean, heldBy: string|null, reason: string }}
 */
export function withNumberingLock(fn, {
  lockRoot = DRAIN_LOCK_ROOT,
  owner = makeOwner('numbering'),
  pid = process.pid,
  leaseMinutes = NUMBERING_LEASE_MINUTES,
  waitMs = NUMBERING_LEASE_MINUTES * 60_000,
  pollMs = 250,
  now = Date.now,
  sleep = sleepSyncMs,
  lockPath = NUMBERING_LOCK_PATH,
  runUnlockedOnContention = true,
} = {}) {
  ensureRoot(lockRoot);
  const deadline = now() + waitMs;
  let acq = tryAcquireNumberingLock(lockRoot, owner, { pid, leaseMinutes, nowMs: now(), lockPath });
  while (!acq.ok && now() < deadline) {
    sleep(pollMs);
    acq = tryAcquireNumberingLock(lockRoot, owner, { pid, leaseMinutes, nowMs: now(), lockPath });
  }
  const held = acq.ok;
  // #3637/xuqk1vp — a caller whose critical section must NEVER run unserialized opts IN via
  // `runUnlockedOnContention: false`; the default stays permissive (see the doc comment above).
  if (!held && !runUnlockedOnContention) {
    return { result: undefined, ran: false, held: false, contended: true, heldBy: acq.heldBy ?? null, reason: acq.reason };
  }
  // Fenced like releaseNumberingLockIfOwned (review #2668): write only while the entry still names `owner`, so a
  // late heartbeat from a holder whose lease was already reclaimed never re-seats it over the reclaimer.
  const doHeartbeat = () => held && (readLockEntry(lockRoot, lockPath) || {}).owner === owner
    && heartbeat(lockRoot, lockPath, owner, nowIsoFrom(now()), pid);
  try {
    return { result: fn(doHeartbeat), ran: true, held, contended: !held, heldBy: acq.heldBy ?? null, reason: acq.reason };
  } finally {
    if (held) releaseNumberingLockIfOwned(lockRoot, owner, lockPath);
  }
}

/**
 * #2683 — run `fn` (a single `gh pr merge` write) inside the SERIAL-WRITER-TO-MAIN critical section. A thin
 * wrapper over {@link withNumberingLock} that shares the SAME lock key ({@link NUMBERING_LOCK_PATH}) so the
 * merge write and the numbering step are mutually exclusive across processes — the invariant the fast-drain
 * (`--only=<pr>`, which bypasses the whole-process drain lease) relies on to serialize its merge against a
 * concurrent resident-daemon sweep. Owner is tagged `land` (vs `numbering`) for diagnostics only; the lock key,
 * not the owner, is what provides the mutual exclusion. Same reclaim-aware spin + never-hang fallback contract
 * as {@link withNumberingLock}: a live holder blocking past the budget runs `fn` WITHOUT the lock and reports
 * `contended:true` (the caller's per-PR idempotency re-check is the backstop against a double-attempt).
 * @returns {{ result: any, held: boolean, contended: boolean, heldBy: string|null, reason: string }}
 */
export function withLandWriteLock(fn, opts = {}) {
  return withNumberingLock(fn, { owner: makeOwner('land'), ...opts });
}

/**
 * xuqk1vp — safe accessor for a {@link withNumberingLock}/{@link withLandWriteLock} outcome that may have
 * REFUSED to run (`ran:false`, a live holder + the new default `runUnlockedOnContention:false`): returns
 * `fallback` when `lock.ran` is false, else `lock.result`. Every write-to-main call site should read a lock's
 * outcome through this rather than `lock.result` directly — a raw `.result` is `undefined` on refusal, and
 * treating `undefined` as "the numbering/merge outcome" (e.g. `.result.assigned`) throws, or worse, silently
 * mis-reads "didn't run" as "ran with nothing to do".
 * @param {{ran:boolean, result:any}} lock
 * @param {any} fallback
 */
export function lockResultOr(lock, fallback) {
  return lock.ran ? lock.result : fallback;
}

// ── (1b) #3637 — the PER-POC-BRANCH land lock ────────────────────────────────────

/** The sentinel prefix the per-POC-branch land lock keys its lock dirs by. Distinct from both
 *  {@link NUMBERING_LOCK_PATH} and {@link DRAIN_LEASE_PATH}, so a POC landing never contends with a drain's
 *  write-to-main mutex (they write to DIFFERENT refs — serializing them against each other would be a pure
 *  latency tax with no invariant behind it). */
export const POC_LAND_LOCK_PATH = '<poc-land:branch-write>';

/** A POC landing is a fetch + a rebase + a verify + a push. The verify is the long pole (it runs the item's
 *  own tests), so this TTL is deliberately longer than the numbering section's 5 minutes — long enough that a
 *  genuinely-live lander is never reclaimed out from under its own push, short enough that a crashed one frees
 *  the branch within a coffee break. */
export const POC_LAND_LEASE_MINUTES = 20;

/**
 * #3637 — the lock-dir key for ONE POC branch's write lock, keyed by BOTH the repo and the branch.
 *
 * Per-branch, not global, on purpose (the ruling's own words): two landers targeting DIFFERENT POC branches
 * write to different refs and must never block each other, while two targeting the SAME branch must serialize
 * or they race the exact way `we:scripts/conveyor/branch-sync.mjs`'s header documents its predecessor failing.
 * `repoKey` is folded in for the same reason {@link drainLeasePathFor} folds it in (#3440): two constellation
 * repos may both carry a branch called `lane/foo`, and they are not the same ref. PURE.
 * @param {string} branch - the POC branch, WITHOUT a remote prefix (`lane/mechanical-dispatcher`).
 * @param {string|null} [repoKey] - `localRepoSlug()`'s `org/repo`, or null for the legacy repo-less key.
 * @returns {string}
 */
export function pocLandLockPathFor(branch, repoKey = null) {
  const name = String(branch ?? '').trim().replace(/^origin\//, '');
  if (!name) throw new Error('drain-lock: pocLandLockPathFor needs a branch name');
  return `${POC_LAND_LOCK_PATH}::${repoKey || 'unkeyed'}::${name}`;
}

/**
 * #3637 — run `fn` (ONE POC branch's fetch/rebase/verify/push cycle) inside that branch's own write lock, so
 * concurrent landers targeting the same POC branch serialize instead of racing the ref.
 *
 * THE ONE CONTRACT DIFFERENCE FROM {@link withLandWriteLock}, and it is deliberate: this does NOT degrade to
 * running `fn` unlocked when a live holder blocks past the budget. `withNumberingLock`'s never-hang fallback is
 * right for numbering (the #2318 duplicate-NNN tripwire is the backstop, and wedging a land is worse than a
 * rare unserialized one). It is wrong here: an unserialized push to a shared ref is the entire failure mode
 * this lock exists to prevent, and there is no downstream tripwire that would catch it. A blocked lander gets
 * `ran:false` and reports a clear "another lander holds <branch>" refusal — `poc-land` surfaces that rather
 * than pushing anyway.
 *
 * @param {Function} fn
 * @param {{branch: string, repoKey?: string|null}} o - plus any {@link withNumberingLock} option.
 * @returns {{ result: any, ran: boolean, held: boolean, contended: boolean, heldBy: string|null, reason: string }}
 */
export function withPocLandLock(fn, { branch, repoKey = null, ...opts } = {}) {
  const lockPath = pocLandLockPathFor(branch, repoKey);
  return withNumberingLock(fn, {
    owner: makeOwner('poc-land'),
    leaseMinutes: POC_LAND_LEASE_MINUTES,
    waitMs: POC_LAND_LEASE_MINUTES * 60_000,
    ...opts,
    lockPath,
    runUnlockedOnContention: false,
  });
}

// ── (2) whole-process drain lease ────────────────────────────────────────────────

/**
 * Acquire the whole-process drain lease for `owner`. `ok:true` ⇒ this process may run the drain (it won the
 * lease, or reclaimed a STALE one via the TTL). `ok:false, reason:'held'` ⇒ a LIVE drain already holds it —
 * the caller must NO-OP (a second drain launch). Thin over file-locks `reserve`.
 */
export function acquireDrainLease(lockRoot = DRAIN_LOCK_ROOT, owner = drainOwner(), { pid = process.pid, leaseMinutes = DRAIN_LEASE_MINUTES, nowMs = Date.now(), scope = null, repoKey = null } = {}) {
  ensureRoot(lockRoot);
  const path = drainLeasePathFor(repoKey); // #3440 — per-repo lock dir; null repoKey ⇒ the legacy global path
  // #2458 — record THIS drain's repo scope in the lease so a differently-scoped launch can tell whether the
  // holder's next pass actually covers its repos, instead of blindly no-op'ing with a false coverage claim.
  // On a re-acquire of an OWN live lease (reserve's 'own' path is a heartbeat) a null `scope` carries the
  // existing recorded scope forward — mirrors heartbeatDrainLease so a re-acquire never silently drops it.
  const cur = readLockEntry(lockRoot, path);
  const keep = normalizeScope(scope) || (cur && cur.owner === owner && cur.meta && normalizeScope(cur.meta.scope)) || null;
  return reserve(lockRoot, path, owner, nowMs, nowIsoFrom(nowMs), pid, 'unknown', leaseMinutes, keep ? { scope: keep } : null);
}

/** Refresh the drain lease heartbeat (a live drain extends its lease each pass). No-op if the lease was
 *  reclaimed away from `owner` (returns false — the caller's next acquire attempt will surface it). The
 *  recorded repo `scope` (#2458) is PRESERVED across heartbeats: a caller-supplied scope refreshes it, else
 *  the existing lease's scope is carried forward (heartbeat rebuilds the entry, so it must be re-supplied).
 *  `repoKey` (#3440) MUST match the value passed to {@link acquireDrainLease} — it selects the same lock dir. */
export function heartbeatDrainLease(lockRoot = DRAIN_LOCK_ROOT, owner = drainOwner(), { pid = process.pid, nowMs = Date.now(), scope = null, repoKey = null } = {}) {
  const path = drainLeasePathFor(repoKey);
  const cur = readLockEntry(lockRoot, path);
  if (!cur || cur.owner !== owner) return false;
  const keep = normalizeScope(scope) || (cur.meta && normalizeScope(cur.meta.scope)) || null;
  return heartbeat(lockRoot, path, owner, nowIsoFrom(nowMs), pid, keep ? { scope: keep } : null);
}

/** Release the drain lease, but ONLY if `owner` still holds it (never stomp a reclaimer). Idempotent.
 *  `repoKey` (#3440) MUST match the value passed to {@link acquireDrainLease}. */
export function releaseDrainLease(lockRoot = DRAIN_LOCK_ROOT, owner = drainOwner(), { repoKey = null } = {}) {
  const path = drainLeasePathFor(repoKey);
  const cur = readLockEntry(lockRoot, path);
  if (cur && cur.owner === owner) { releaseLockDir(lockRoot, path); return true; }
  return false;
}

/**
 * The read-only drain-lease view push-at-close consults: is a drain mid-flight right now?
 *   • `held:true`  — a LIVE drain holds the lease (heartbeat within the TTL); push-at-close should wait/skip.
 *   • `held:false, stale:true`  — a lease exists but its holder crashed (heartbeat past the TTL) → reclaimable.
 *   • `held:false, stale:false` — no lease at all → no drain running.
 * `repoKey` (#3440) selects WHICH repo's lease to read — omitted ⇒ the legacy global lease (the lock dir every
 * caller shared before this repo-keying existed).
 * @returns {{ held: boolean, stale: boolean, owner: string|null, heartbeatAt: string|null }}
 */
export function drainLeaseStatus(lockRoot = DRAIN_LOCK_ROOT, { nowMs = Date.now(), leaseMinutes = DRAIN_LEASE_MINUTES, repoKey = null } = {}) {
  const entry = readLockEntry(lockRoot, drainLeasePathFor(repoKey));
  if (!entry) return { held: false, stale: false, owner: null, heartbeatAt: null, scope: null };
  const stale = isLeaseExpired(entry, nowMs, leaseMinutes);
  // #2458 — surface the holder's recorded repo scope (or null when a legacy/unscoped lease didn't record it).
  return { held: !stale, stale, owner: entry.owner, heartbeatAt: entry.heartbeatAt, scope: (entry.meta && normalizeScope(entry.meta.scope)) || null };
}

/** #2458 — normalize a repo-scope input to a de-duped, sorted array of non-empty slug strings, or `null`
 *  when there is nothing usable. Keeps the lease payload canonical and scope comparisons order-independent. */
export function normalizeScope(scope) {
  if (!Array.isArray(scope)) return null;
  const slugs = [...new Set(scope.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))].sort();
  return slugs.length ? slugs : null;
}
