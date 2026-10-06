/**
 * @file scripts/conveyor/fix-dispatch-claim.mjs
 * @description #x0jphk5 (parent #4075, epic #3383) — THE REAL PER-(REPO, KIND, PR) CLAIM the fix-dispatch
 *   path was missing (see the CORRECTED section below, dup-heal-dispatch: the key was originally `(repo, pr,
 *   headSha)` — a real live incident proved that wrong, and this is the fixed shape). `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`'s own header used to claim this
 *   was already covered by `we:scripts/operations/action-store.mjs`'s durable atomic ledger — FALSE on `main`
 *   (see that file's corrected header): `we:scripts/conveyor/reconcile-fix-dispatch.mjs`'s own dispatch
 *   decision never imported `action-store.mjs` at all, and its ONLY double-dispatch guard was a session-NAME
 *   match against a `claude agents --json --all` listing measured (`we:scripts/operations/dispatch-lane-io.mjs`)
 *   to lag 26+ seconds behind the real spawn. Two dispatchers reading that stale listing within the lag window
 *   (the new daemon plus `we:skills-src/conveyor/runner.mjs`'s own mechanical pass, deliberately run side by
 *   side for a bake period; or a restarted daemon racing a still-live prior instance) could both decide
 *   "nothing live" and both dispatch the same `fix-<pr>` / `ci-heal-<pr>`.
 *
 * THE PRIMITIVE IS REUSED, NOT REINVENTED. This is exactly `we:scripts/readiness/file-locks.mjs`'s own
 * O_EXCL-mkdir / heartbeat-TTL-lease / dead-holder-reclaim design (#1936) — that file's own header already
 * argues the correctness case (atomic across separate invocations with no daemon; TTL as the reclaim floor).
 * This module is a THIN naming/keying layer over it: the "path" `file-locks.mjs` locks is, here, a synthetic
 * resource key `fix-dispatch:<repo>:<kind>:<pr>`, never a real file on disk — `file-locks.mjs` never
 * assumes its `path` argument is openable, only that it is a stable string to key a lock dir off.
 *
 * ROOT: THE SHARED COORDINATION SIDECAR, NOT A CHECKOUT-LOCAL DIR. `file-locks.mjs`'s own default root
 * (`.claude/locks` under a checkout) is deliberately checkout-local — it exists to serialize EDITS to files in
 * ONE central checkout. This claim instead has to be seen by every dispatcher regardless of which checkout it
 * runs from (the daemon's own clone, a lane, a CI runner), so it is pinned under
 * `we:scripts/operations/coordination-root.mjs`'s own `resolveCoordinationRoot()` — the SAME operator-owned,
 * `WE_COORDINATION_ROOT`-overridable sidecar `action-store.mjs` itself uses ("all checkouts coordinate through
 * one operator-owned sidecar, never checkout-local state" — that file's own header).
 *
 * WHY PID-LIVENESS FAST-RECLAIM IS DELIBERATELY NEVER USED HERE (the one place this module intentionally
 * departs from a typical `file-locks.mjs` caller). `reclaimDecision`'s PID fast path exists for a lock held BY
 * the process that would still be doing the work if it were alive — here it is the opposite: the DISPATCHER
 * process that wins this claim exits normally, on purpose, moments after a successful spawn
 * (`reconcile-fix-dispatch.mjs` and `ci-heal-pr-dispatch.mjs` are both documented ONE-SHOT passes). Its pid
 * going away is completion, not a crash — treating that as evidence the claim is reclaimable would defeat the
 * whole point of holding the claim past the synchronous spawn call (the 26+s LISTING LAG is exactly the gap
 * this module exists to close). So `pidLiveness` is always passed as `'unknown'` here: only the TTL governs an
 * unreleased claim's reclaim, and only an explicit {@link releaseFixDispatchClaim} call (a refused/failed
 * attempt that spawned nothing, or — see the note below — a completion/reap signal) frees one early.
 *
 * Confirmed terminal sessions are released by the daemon's pre-dispatch refresh sweep.
 * Missing sessions retain the TTL grace; historical terminal rows cannot settle a new claim.
 *
 * CORRECTED (dup-heal-dispatch, 2026-09-27 LIVE INCIDENT): the resource key used to be `(repo, pr, headSha)` —
 * a NEW push to the SAME pr was, deliberately, a free/independent slot (see the old version of {@link
 * fixDispatchResource}'s own docblock: "a new head sha is free to claim its own slot rather than being blocked
 * by a stale claim for a commit that's no longer current"). That reasoning is right for a commit pushed by
 * SOMEONE ELSE after the original work is done, and WRONG for the commit the SAME still-working dispatched
 * session pushes as part of doing its own job — which is exactly what a `ci-heal`/`fix` agent does (it commits
 * a repair, `git push`es, CI reruns). LIVE-CAUGHT 22:16 ET: three concurrent `ci-heal-2784` sessions and three
 * `ci-heal-2783` (replay of the real recovered claim files under `~/workspace/.operations/coordination/
 * fix-dispatch-claims/` shows 3-4 DISTINCT claims per PR, each on a DIFFERENT `headSha`, each held by a
 * DIFFERENT daemon pid across a few restarts within the same hour) — every one of those pushes rotated the
 * claim's own resource key out from under the still-live session that made the push, reopening the exact
 * listing-lag window this claim exists to close, every time.
 *
 * THE FIX: the resource key drops `headSha` — it is now `(repo, kind, pr)` (`headSha` stays recorded in
 * `meta` for diagnostics only, never part of the identity). `kind` (`'fix'` | `'ci-heal'`, mirroring
 * `we:scripts/conveyor/reconcile-core.mjs#bindAgents`'s own name-based PATH 2 population) is ALSO new — the
 * pre-incident key carried no kind at all, so a `fix` claim and a `ci-heal` claim for the same PR would have
 * silently shared one slot; today's two real dispatch call sites (`we:scripts/conveyor/
 * reconcile-fix-dispatch.mjs#dispatchFix`/`#tryResumeFix` pass `'fix'`, `we:scripts/operations/
 * ci-heal-pr-dispatch.mjs#dispatchCiHeal` passes `'ci-heal'`) now say so explicitly.
 *
 * TTL TIED TO SESSION LIVENESS, PLUS THE SPAWN-LISTING-LAG GRACE THE PLAIN TTL ALREADY GAVE. Dropping `headSha`
 * from the key makes the claim outlive an in-flight session's own commits, but a session that runs LONGER than
 * `DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES` would still see its own claim go stale and get reclaimed out from
 * under it. {@link refreshLiveFixDispatchClaims} is the fix: called once per daemon tick (see
 * `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`'s own IO shell), it reads every held claim, checks
 * — via the SAME name-based liveness `bindAgents`'s own PATH 2 already trusts ({@link isClaimSessionLive}) —
 * whether a live, non-terminal session still carries that `(repo, kind, pr)`'s own session name, and
 * heartbeat-refreshes ONLY those. A terminal session from the current dispatch releases its claim;
 * an unknown/missing session retains the plain TTL to cover spawn-listing lag. Old terminal sessions
 * sharing the same name cannot release a new dispatch's claim.
 */
import { makeAwaitingVerifyResolver } from './await-verify.mjs';
import { hostname } from 'node:os';
import {
  reserve, readLockEntry, releaseLockDir, heartbeat, isLeaseExpired,
} from '../readiness/file-locks.mjs';
import {
  DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES, fixDispatchClaimRoot, fixDispatchResource, readFixDispatchClaim,
  fixDispatchSessionName, listFixDispatchClaims,
} from './fix-claim-store.mjs';
import { defaultListAgents } from '../operations/dispatch-lane-io.mjs';
import { startedAtMs } from './reconcile-core.mjs';
import { readHungInfo, resolveHungThresholdMs } from './hung-session.mjs';

// The light store helpers live in `fix-claim-store.mjs` (no dispatch graph — see its header); re-exported here so
// every existing importer of this module is unchanged.
export {
  DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES, fixDispatchClaimRoot, fixDispatchResource, readFixDispatchClaim,
  fixDispatchSessionName, listFixDispatchClaims,
};

/** This PROCESS's own claim identity — `hostname:pid`, mirroring `file-locks.mjs`'s own documented convention
 *  ("owner already uniquely names one process for its whole lifetime… embeds the pid"). Two different real
 *  dispatcher processes — even on the same host — never collide on this string, so a genuine second dispatcher
 *  is never mistaken for a reentrant "already mine" re-acquire. */
export function fixDispatchClaimOwner({ host = hostname(), pid = process.pid } = {}) {
  return `${host}:${pid}`;
}

/**
 * Take the claim for one `(repo, kind, pr)`. Atomic (`O_EXCL` mkdir, via {@link reserve}) across separate
 * processes with no daemon of its own; a stale (TTL-expired) claim is reclaimed automatically — see this
 * file's own header for why that TTL, not PID liveness, is the ONLY reclaim floor here (and for
 * {@link refreshLiveFixDispatchClaims}, which is what keeps a genuinely still-working session's claim from
 * ever reaching that TTL in the first place).
 * @param {{repo:string, pr:number, kind?:string, headSha?:string|null, scope?:string[]|null, owner?:string, sessionId?:string|null,
 *   pid?:number, host?:string, nowMs?:number, nowIso?:string, leaseMinutes?:number, lockRoot?:string}} o
 * @returns {{ok:boolean, reason:string, heldBy:string|null, resource:string, lockRoot:string}}
 */
export function acquireFixDispatchClaim({
  repo, pr, kind = 'fix', headSha = null, scope = null, owner = fixDispatchClaimOwner(), sessionId = null,
  pid = process.pid, host = hostname(), nowMs = Date.now(), nowIso = new Date(nowMs).toISOString(),
  leaseMinutes = DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES, lockRoot = fixDispatchClaimRoot(),
} = {}) {
  if (!owner) throw new TypeError('acquireFixDispatchClaim requires an owner');
  const resource = fixDispatchResource({ repo, pr, kind });
  // `headSha` rides in `meta` only (diagnostics — which commit was in flight) — never part of the resource
  // identity above (see this file's own header for the live incident that made keying on it wrong).
  // `claimedAt` anchors {@link MAX_FIX_DISPATCH_CLAIM_REFRESH_MS}; a heartbeat re-writes `meta` verbatim, so it
  // survives every refresh. A reentrant same-owner re-acquire of a STILL-LIVE lease keeps the original
  // `claimedAt`; an expired leftover entry (claims are not released on success, and the daemon's `host:pid`
  // owner never changes) is a NEW dispatch and starts a fresh clock.
  const prior = readLockEntry(lockRoot, fixDispatchResource({ repo, pr, kind }));
  const claimedAt = prior?.owner === owner && prior?.meta?.claimedAt && !isLeaseExpired(prior, nowMs, leaseMinutes)
    ? prior.meta.claimedAt : nowIso;
  const meta = {
    host, sessionId, repo, pr, kind, headSha: headSha ?? null, claimedAt,
    // #4295 — declared scope (repo-qualified) so build/fix dispatch can serialize on overlap; omitted when unknown.
    ...(Array.isArray(scope) && scope.length ? { scope: scope.map(String) } : {}),
  };
  // `pidLiveness` is ALWAYS 'unknown' — see this file's own header for why a fast PID-dead reclaim would be
  // actively wrong here (the acquiring dispatcher's own exit is expected completion, not a crash).
  const result = reserve(lockRoot, resource, owner, nowMs, nowIso, pid, 'unknown', leaseMinutes, meta);
  return { ...result, resource, lockRoot };
}

/** Release only dispatch claims minted for the session that just posted its stand-down. */
export function releaseSessionFixDispatchClaims({ repo, pr, who, lockRoot = fixDispatchClaimRoot() } = {}) {
  const released = [];
  const skipped = [];
  for (const kind of ['fix', 'ci-heal']) {
    const entry = readFixDispatchClaim({ repo, pr, kind, lockRoot });
    if (!entry) { skipped.push({ kind, reason: 'absent' }); continue; }
    let name;
    try { name = fixDispatchSessionName({ repo, pr, kind }); }
    catch { skipped.push({ kind, reason: 'unknown-session' }); continue; }
    if (name !== who) { skipped.push({ kind, reason: 'session-mismatch' }); continue; }
    const result = releaseFixDispatchClaim({ repo, pr, kind, owner: entry.owner, lockRoot });
    if (result.released) released.push({ kind, owner: entry.owner });
    else skipped.push({ kind, reason: result.reason });
  }
  return { released, skipped };
}

/**
 * Release a claim this `owner` holds. A no-op (never throws, never touches a lock it does not own) when the
 * claim is already gone or owned by someone else — the caller learns why via `reason`, but nothing is torn
 * down out from under a legitimate different holder (e.g. one that reclaimed it after our own TTL lapsed).
 * @param {{repo:string, pr:number, kind?:string, owner:string, lockRoot?:string}} o
 * @returns {{released:boolean, reason?:string, heldBy?:string|null}}
 */
export function releaseFixDispatchClaim({
  repo, pr, kind = 'fix', owner, lockRoot = fixDispatchClaimRoot(),
} = {}) {
  if (!owner) throw new TypeError('releaseFixDispatchClaim requires an owner');
  const resource = fixDispatchResource({ repo, pr, kind });
  const current = readLockEntry(lockRoot, resource);
  if (!current) return { released: false, reason: 'absent' };
  if (current.owner !== owner) return { released: false, reason: 'not-owner', heldBy: current.owner };
  releaseLockDir(lockRoot, resource);
  return { released: true };
}

/** we:scripts/conveyor/fix-dispatch-claim.mjs#isClaimSessionLive — is there a LIVE, non-terminal session
 *  still carrying `(repo, kind, pr)`'s own dispatched name, in a `claude agents --json --all`-shaped listing?
 *  `'done'`/`'stopped'`/`'failed'` are terminal — mirrors `we:scripts/conveyor/health-smells/
 *  red-pr-unattended.mjs`'s own exact liveness convention (`state !== 'done' && state !== 'stopped' && state
 *  !== 'failed'`), reused rather than re-derived so "live" means the same thing everywhere this repo asks it.
 *  Pure — the caller supplies `agentsAll` (a real caller reads it fresh; a test hands in a fixture).
 * @param {{repo:string, pr:number, kind?:string, agentsAll:Array<object>}} o
 * @returns {boolean}
 */
export function isClaimSessionLive({ repo, pr, kind = 'fix', agentsAll, name: nameOverride = null }) {
  // fix-procedure: a `kind:'fixing'` claim names its session in `meta.who` (any fixer identity), not a minted
  // `<kind>-<pr>` slug — `mintSessionSlug` would throw on the kind — so the caller passes the name directly.
  const name = nameOverride ?? fixDispatchSessionName({ repo, pr, kind });
  return (Array.isArray(agentsAll) ? agentsAll : []).some((a) => (
    a && String(a.name ?? '') === name
    && a.state !== 'done' && a.state !== 'stopped' && a.state !== 'failed'
    // PR #2789 review: raw `state` lies for a HUNG session (it keeps reading 'working' until reaped). Honor the
    // same upstream AGENT-level finished verdicts `reconcile-core.mjs#assessLiveness` already trusts.
    && a.hung !== true && a.selfReportedDone !== true && a.authExpired !== true
  ));
}

/** Absolute ceiling on how long {@link refreshLiveFixDispatchClaims} keeps ONE claim alive, measured from its
 *  original acquire (`meta.claimedAt`). A backstop for a session that reads live forever while not actually
 *  progressing and that no hung detector caught: past this, the refresh stops and the plain TTL reclaims it.
 *  Well above any real fix/ci-heal run, and above `hung-session.mjs`'s own 30-min hung threshold. */
export const MAX_FIX_DISPATCH_CLAIM_REFRESH_MS = 4 * 60 * 60 * 1000;

/**
 * we:scripts/conveyor/fix-dispatch-claim.mjs#refreshLiveFixDispatchClaims — THE FIX for a claim outliving a
 * genuinely still-working session past its own TTL (see this file's own header). Called once per daemon tick
 * (the IO shell, `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`), BEFORE that tick's own
 * `fix`/`ci-heal` dispatch attempts: reads every held claim ({@link listFixDispatchClaims}), and for each one
 * whose `(repo, kind, pr)` still names a LIVE, non-terminal session ({@link isClaimSessionLive}, ONE shared
 * `agentsAll` read for the whole sweep — never one `claude agents --json --all` call per claim),
 * heartbeat-refreshes it (`file-locks.mjs#heartbeat`) so its TTL never lapses while the session is real. A
 * claim with a terminal session from this dispatch is released before overlap admission, even while its PR
 * remains in review. Unknown/missing sessions retain the TTL grace; old terminal rows cannot release a new
 * dispatch sharing their name. PR labels/head changes alone never release a live session's claim.
 *
 * PR #2789 review hardening:
 *  - HUNG: every candidate agent row is first run through `hung-session.mjs#readHungInfo` (injectable as
 *    `hungInfoFor`) — the SAME detector `reconcile-pass.mjs` feeds `markHungSessions` — so a session stuck at
 *    `state: 'working'` with a stale transcript is not "live" here either.
 *  - CEILING: past {@link MAX_FIX_DISPATCH_CLAIM_REFRESH_MS} since `meta.claimedAt`, a claim is never refreshed.
 *  - OWNERSHIP: the entry is RE-READ immediately before the heartbeat write and skipped unless the on-disk owner
 *    still matches the listed one — the same owner check `releaseFixDispatchClaim` makes — so a claim released
 *    and re-acquired by a different owner during the sweep is skipped, not overwritten. (Read-then-write, not
 *    atomic: the residual window is the microseconds between that re-read and the write.)
 *  - A session judged hung, or older than the ceiling, deliberately LOSES its claim to the plain TTL — so a
 *    genuinely slow-but-alive run past those bounds can be re-dispatched. That matches the reaper's own view.
 *  - SYNC ONLY: `listAgentsAll` must return an array; a Promise throws, rather than reading as "no agents".
 * Await records (we:scripts/conveyor/await-verify.mjs) keep deliberately ended turns live for their own
 * PR. They bypass terminal release but retain the owner re-read and four-hour refresh ceiling; successful
 * await heartbeats are also reported under `awaiting` (omitted when empty).
 * @param {{lockRoot?:string, listAgentsAll?:Function, hungInfoFor?:Function, hungThresholdMs?:number,
 *   awaitingVerifyFor?:Function|null, nowMs?:number, nowIso?:()=>string}} [o]
 * @returns {{checked:number, refreshed:Array<{repo:string, pr:number, kind:string, headSha:string|null, owner:string}>}}
 */
export function refreshLiveFixDispatchClaims({
  lockRoot = fixDispatchClaimRoot(),
  listAgentsAll = () => defaultListAgents({ all: true }),
  hungInfoFor = readHungInfo,
  awaitingVerifyFor = makeAwaitingVerifyResolver(),
  hungThresholdMs = resolveHungThresholdMs(),
  nowIso = () => new Date().toISOString(),
  nowMs = Date.parse(nowIso()),
} = {}) {
  const claims = listFixDispatchClaims(lockRoot);
  if (!claims.length) return { checked: 0, refreshed: [] };
  const listed = listAgentsAll();
  if (listed && typeof listed.then === 'function') {
    throw new TypeError('refreshLiveFixDispatchClaims: listAgentsAll must be synchronous (got a Promise)');
  }
  const refreshed = [];
  const released = [];
  const awaiting = [];
  for (const entry of claims) {
    const { repo, pr, kind, headSha = null, claimedAt = null } = entry.meta;
    const claimedMs = Date.parse(claimedAt ?? '');
    if (Number.isFinite(claimedMs) && nowMs - claimedMs > MAX_FIX_DISPATCH_CLAIM_REFRESH_MS) continue;
    // fix-procedure (`kind:'fixing'`, `we:scripts/conveyor/fix-procedure.mjs`): the holder's session name is
    // `meta.who`, not a minted slug — minting one would THROW on the unknown kind and crash this whole sweep.
    // A claim whose name cannot be resolved is skipped (left to its own TTL), never thrown over.
    let name = null;
    if (kind === 'fixing') name = entry.meta.who ? String(entry.meta.who) : null;
    else { try { name = fixDispatchSessionName({ repo, pr, kind }); } catch { name = null; } }
    if (!name) continue;
    const agentsAll = (Array.isArray(listed) ? listed : []).filter((a) => a && String(a.name ?? '') === name)
      .map((a) => {
        let info = null;
        try { info = hungInfoFor(a, nowMs, hungThresholdMs); } catch { info = null; }
        return info?.hung === true ? { ...a, hung: true } : a;
      });
    const isAwaiting = typeof awaitingVerifyFor === 'function' && agentsAll.some((row) => {
      try { return awaitingVerifyFor(row, { pr })?.awaiting === true; } catch { return false; }
    });
    if (!isAwaiting && !isClaimSessionLive({ repo, pr, kind, agentsAll, name })) {
      // A terminal row must belong to THIS dispatch, not an older round with the
      // same reusable name. Missing/failed listings and the spawn-listing lag
      // never release a claim. A live sibling above always wins over old rows.
      // #3964 (2026-10-05): a fixer's own session starts before its fixing claim;
      // an exact sessionId match settles that claim regardless of start time.
      const settled = agentsAll.some((a) =>
        ['done', 'stopped', 'failed'].includes(a.state)
        && ((entry.meta.sessionId && a.sessionId === entry.meta.sessionId)
          || (Number.isFinite(claimedMs) && startedAtMs(a.startedAt) >= claimedMs)));
      if (settled) {
        const current = readLockEntry(lockRoot, fixDispatchResource({ repo, pr, kind }));
        if (current?.owner === entry.owner && current.meta?.claimedAt === claimedAt) {
          const result = releaseFixDispatchClaim({ repo, pr, kind, owner: entry.owner, lockRoot });
          if (result.released) released.push({ repo, pr, kind, owner: entry.owner });
        }
      }
      continue;
    }
    const resource = fixDispatchResource({ repo, pr, kind });
    const current = readLockEntry(lockRoot, resource);
    if (!current || current.owner !== entry.owner) continue;
    // Write back the FRESHLY re-read entry (not the listing snapshot); a pre-`claimedAt` claim is stamped now so
    // the ceiling applies to it from here on.
    const meta = current.meta?.claimedAt ? current.meta : { ...(current.meta ?? entry.meta), claimedAt: nowIso() };
    heartbeat(lockRoot, resource, current.owner, nowIso(), current.pid ?? null, meta);
    if (isAwaiting) awaiting.push({ repo, pr, kind, owner: entry.owner });
    refreshed.push({
      repo, pr, kind, headSha, owner: entry.owner,
    });
  }
  return { checked: claims.length, refreshed, ...(released.length ? { released } : {}), ...(awaiting.length ? { awaiting } : {}) };
}
