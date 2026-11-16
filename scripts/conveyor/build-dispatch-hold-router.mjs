#!/usr/bin/env node
/**
 * @file scripts/conveyor/build-dispatch-hold-router.mjs
 * @description #4465 — classify a build-dispatch HOLD's own `reason` string into one of three routes, and the
 * thin IO-shell orchestrator that acts on the plan. Closes the "a held item sits forever, with no owner" gap:
 * we:scripts/conveyor/build-dispatch-claim.mjs#listBuildDispatchHolds already lets a caller see every LIVE
 * hold, no matter which process placed it (past or future) — so this sweeps holds from the build-dispatch
 * daemon's own tick rather than needing to touch the delivery wrapper's `placeBuildDispatchHold` call site
 * (see this item's own prep note in its backlog card for why that scope was dropped).
 *
 * THREE ROUTES (the item's own MVP cut):
 *   (a) 'already-done'  — the build agent's report cites a commit that already lands the spec (`reason`
 *       matches "spec already done on main: commit <sha>"). Route: land a `backlog.mjs resolve
 *       --graduated-to=<sha>` through a lane PR (we:scripts/operations/build-dispatch-hold-route-land.mjs).
 *   (b) 'out-of-scope'   — the spec is wrong / superseded as written (`reason` matches "spec not buildable"
 *       or "spec superseded"). Route: clear the card's `scope:` (making it "unshaped"), so the EXISTING
 *       dispatch-plan auto-prepare (we:scripts/readiness/dispatch-plan.mjs's own unshaped-item handling)
 *       picks it up on its own — no new prepare-dispatch code needed — with the agent's finding appended to
 *       the card body, landed the same way as (a).
 *   (c) 'other'          — a hold this classifier does not recognize as a spec judgment at all (e.g. a
 *       crashed wrapper's `wrapper-threw`). Not a spec question a card edit can fix. Route: append a durable
 *       finding record — a human / a future health sweep reads the ledger (see this item's card for why this
 *       stays a small standalone ledger rather than the full health-episode pipeline). The hold ITSELF is
 *       deliberately left alone: releasing it early would make the item an instant re-dispatch candidate,
 *       which for a crash reason just re-runs the same crash. It self-expires on its own TTL
 *       ({@link DEFAULT_BUILD_DISPATCH_HOLD_MINUTES}, we:scripts/conveyor/build-dispatch-claim.mjs) — the SAME
 *       "TTL is the dead-holder floor, never a manually-tracked completion" posture that hold's own header
 *       already documents (`releaseBuildDispatchHold` there is an exported-but-uncalled escape hatch, never
 *       wired to a CLI). Routes (a)/(b) leave it alone for the same reason: see `routeHeldItems`'s own
 *       docblock below.
 *
 * PURE CORE / IO SHELL split (we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment):
 * `classifyHoldReason`/`planHoldRouting` are pure text-in, value-out, fully covered without touching disk.
 * `routeHeldItems` is the one IO-shell orchestrator below it, every effect injected so it is unit-tested with
 * fakes; we:skills-src/conveyor/build-dispatch-daemon.mjs wires the real spawn/append/reserve calls (never a
 * release — see `routeHeldItems`'s own docblock for why), live-only, best-effort — the same posture its
 * `adoptOrphans`/`retryInfraBlocked` effects already have.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { reserve, releaseLockDir, readLockEntry } from '../readiness/file-locks.mjs';
import { normNum } from './queue-store.mjs';
import { DEFAULT_BUILD_DISPATCH_HOLD_MINUTES } from './build-dispatch-claim.mjs';

// ── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ALREADY_DONE_RE = /spec already done on main:\s*commit\s+([0-9a-f]{7,40})/i;
const OUT_OF_SCOPE_RE = /spec (?:not buildable|superseded)/i;

/** PURE. Classify one hold's `reason` text into a route. Never throws — a missing/empty/unrecognized reason
 *  is `'other'`, never an error, since a hold this daemon cannot confidently classify must still be routed
 *  somewhere (never silently skipped). */
export function classifyHoldReason(reason) {
  const text = String(reason ?? '');
  // A decline is evidence for preparation, never proof that the spec was delivered.
  if (/^worker-declined: scope exceeds the [\w-]+ envelope — route to the builder/.test(text)) return { route: 'other', commit: null };
  if (/^worker-declined(?:\s*:|$)/.test(text)) return { route: 'out-of-scope', commit: null };
  const doneMatch = ALREADY_DONE_RE.exec(text);
  if (doneMatch) return { route: 'already-done', commit: doneMatch[1] };
  if (OUT_OF_SCOPE_RE.test(text)) return { route: 'out-of-scope', commit: null };
  return { route: 'other', commit: null };
}

// A card id: a JIT-assigned number, or a pre-numbering `bornAs` hash (e.g. `x5s8b47`).
const HOLD_NUM_RE = /^(?:\d+|[a-z0-9]{6,8})$/;

/** PURE. Is `num` (already `normNum`-ed) a real card id? #4465 PR #2967 review (security finding): `num` is
 *  read from a hold's `lock.json` and then names a lock directory, a git ref (`lane/hold-route-<num>`) and a
 *  log file — a malformed or hostile value like `../../x` or `a/b` must never reach any of them. */
export function isValidHoldNum(num) {
  return HOLD_NUM_RE.test(String(num ?? ''));
}

/** PURE. `holds` is {@link listBuildDispatchHolds}'s own normalized shape (`{num, reason}`, as
 *  we:skills-src/conveyor/build-dispatch-daemon.mjs#cliListHolds already returns it). One routing entry per
 *  hold with a real card-id `num` ({@link isValidHoldNum}), in the same order; an entry with no `num`, or one
 *  that is not a card id, is dropped rather than routed blind. */
export function planHoldRouting(holds) {
  return (Array.isArray(holds) ? holds : [])
    .map((h) => {
      const num = normNum(h?.num);
      if (!isValidHoldNum(num)) return null;
      const { route, commit } = classifyHoldReason(h?.reason);
      return { num, route, commit, reason: h?.reason ?? null };
    })
    .filter(Boolean);
}

// ── IO shell ─────────────────────────────────────────────────────────────────────────────────────────────────

export function holdRouteLockRoot(root = resolveCoordinationRoot()) {
  return join(root, 'build-dispatch-hold-routes');
}

export function holdFindingsFile(root = resolveCoordinationRoot()) {
  return join(root, 'build-dispatch-hold-findings.json');
}

// A landing attempt (lane acquire → edit → commit → verify → open-pr) runs to `resolveLaneAcquireTimeoutMs()`
// (~40 min by default: NETWORK_GIT_TIMEOUT_MS + NPM_INSTALL_TIMEOUT_MS + 4×child-timeout, see
// we:scripts/lib/bounded-child.mjs) + VERIFY_TIMEOUT_MS (30 min) + OPEN_PR_TIMEOUT_MS (10 min) in
// we:scripts/operations/build-dispatch-hold-route-land.mjs — a worst case near 80 minutes. This lease is a
// dead-attempt floor for a crashed spawn (mirroring we:scripts/conveyor/build-dispatch-claim.mjs's own
// TTL-as-dead-holder-floor posture, never a "still working" timeout), so it must comfortably outlast that
// worst case or a slow-but-alive landing can get a second, overlapping spawn from the very next tick.
//
// #4465 review round 3 (live correctness finding) — it must ALSO outlast the build-dispatch hold's own TTL
// ({@link DEFAULT_BUILD_DISPATCH_HOLD_MINUTES}, 240 min): a shorter lease that expires while the hold is
// still live lets a LATER tick re-plan and re-route the SAME hold a second time — for 'out-of-scope' the
// second landing re-clears `scope:` and re-appends a finding section, silently undoing a re-prepare that
// already happened in between; for 'already-done' it re-runs (or fails against) an already-resolved card; for
// 'other' it duplicates a ledger entry. DERIVED from the hold's own constant (never a second, independently
// hand-tuned literal that can drift out of sync with it again) plus a small buffer, so at most ONE landing is
// ever spawned per hold's whole lifetime by construction. Also deliberately never released early on success
// (see `routeHeldItems`'s own docblock below) — a landed PR is not yet a MERGED one, so the next tick must
// still skip this item until either this lease or the build-dispatch hold itself lapses.
export const DEFAULT_ROUTE_LEASE_MINUTES = DEFAULT_BUILD_DISPATCH_HOLD_MINUTES + 10;

/** Best-effort dedup lease, one per item: `{ok:true}` when a NEW lease was just taken (the caller should act
 *  this tick), `{ok:false}` when one is already held (a previous tick's landing attempt is still in flight,
 *  or a landed-but-not-yet-merged PR is still out, or the lease genuinely could not be taken) — either way,
 *  skip, never spawn a second overlapping landing.
 *
 *  #4465 review round 2 (live correctness finding) — `owner` MUST be a fresh, per-CALL value, never a fixed
 *  `hostname:pid`. The resident build-dispatch daemon is one long-lived process ticking every ~2 minutes, so a
 *  constant owner string would make EVERY tick's reserve `entry.owner === requester` against its OWN prior
 *  call — `we:scripts/readiness/file-locks.mjs#reclaimDecision`'s reentrancy rule (`reason:'own'`) then
 *  returns `ok:true` unconditionally, every tick, defeating this lease's entire purpose (it is a
 *  cross-attempt dedup floor, never a same-owner heartbeat renewal — nothing here is meant to "renew" one
 *  lease across ticks the way a long-running holder normally would). A fresh `randomUUID()` per call makes
 *  every attempt a genuinely NEW owner, so a still-live prior lease correctly falls to the TTL/foreign-owner
 *  branch (`ok:false, reason:'held'`) instead of the reentrant one. */
export function reserveHoldRoute({
  num, route, lockRoot = holdRouteLockRoot(), nowMs = Date.now(), nowIso = new Date(nowMs).toISOString(),
  owner = `${hostname()}:${process.pid}:${randomUUID()}`, leaseMinutes = DEFAULT_ROUTE_LEASE_MINUTES,
} = {}) {
  const resource = `we:${normNum(num)}:${route}`;
  const result = reserve(lockRoot, resource, owner, nowMs, nowIso, process.pid, 'unknown', leaseMinutes, { num: normNum(num), route });
  return { ...result, resource, lockRoot };
}

/** A manual escape hatch, NOT called anywhere in this pipeline (mirrors
 *  we:scripts/conveyor/build-dispatch-claim.mjs#releaseBuildDispatchHold's own "exported-but-uncalled" posture
 *  for the exact same reason): a landing attempt reaching `landed` means a PR merely OPENED, not merged, so
 *  `routeHeldItems`/`landRoute` deliberately never call this on success — the lease is left to lapse on its
 *  own TTL ({@link DEFAULT_ROUTE_LEASE_MINUTES}) so no later tick starts a second landing before the first
 *  one's PR has actually merged. An operator (or a future automated "PR merged" observer) may still call this
 *  directly to clear a confirmed-stuck lease sooner. Absent is a no-op, never an error. */
export function releaseHoldRoute({ num, route, lockRoot = holdRouteLockRoot() } = {}) {
  const resource = `we:${normNum(num)}:${route}`;
  if (!readLockEntry(lockRoot, resource)) return { released: false, reason: 'absent' };
  releaseLockDir(lockRoot, resource);
  return { released: true };
}

/** Append one durable finding (route 'other') to the shared JSON ledger. Never throws on a read/parse
 *  failure — starts a fresh ledger rather than losing every prior entry to one bad read. */
export function appendHoldFinding({ num, reason, now = new Date(), file = holdFindingsFile() } = {}) {
  let list = [];
  if (existsSync(file)) {
    try { list = JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt → start a fresh ledger */ }
  }
  if (!Array.isArray(list)) list = [];
  list.push({ num: normNum(num), reason: reason ?? null, recordedAt: now.toISOString() });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  return { file, count: list.length };
}

/** Every recorded finding, oldest first. `[]` on a missing/corrupt ledger — never throws. */
export function listHoldFindings({ file = holdFindingsFile() } = {}) {
  if (!existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/**
 * Act on one tick's routing plan. Every effect is injected so this is fully unit-testable with fakes; the
 * daemon wires the real spawn-detached-landing / JSON-ledger-append calls, LIVE only (never on a `--dry-run`
 * tick — see that file's own wiring). ASYNC: `spawnLand` is itself async in production (a dynamic `import()`
 * then a detached spawn) and is `await`ed here so a rejection is captured per-item as `spawn-failed`, never
 * left to surface as a process-level `unhandledRejection` (which could otherwise kill the resident
 * build-dispatch daemon) — callers must `await routeHeldItems(...)` (the daemon's own `runBuildDispatchTick`
 * already does).
 *
 * `reserveRoute` dedups ACROSS ticks, for EVERY route including 'other' (#4465 review round 2 — an earlier
 * revision dedup'd only (a)/(b), so a route-'other' hold re-appended a duplicate ledger entry on every single
 * tick for its whole 240-minute hold TTL, ~120 duplicates for one crash): a landing/finding attempt for one
 * item that is still within its lease (still running, landed-but-not-yet-merged, or simply already recorded
 * this cycle) must not repeat from the very next tick — `{ok:false}` means "already handled, skip this tick
 * for this item", never an error.
 *
 * NEITHER route releases the build-dispatch hold, and a SUCCESSFUL (a)/(b) landing or (c) finding-record does
 * not release the dedup lease either — both are deliberately left to self-expire on their own TTL
 * (`DEFAULT_ROUTE_LEASE_MINUTES` above, `DEFAULT_BUILD_DISPATCH_HOLD_MINUTES` in
 * we:scripts/conveyor/build-dispatch-claim.mjs), the SAME "TTL is the dead-holder floor, never a
 * manually-tracked completion" posture that hold's own header already documents. Releasing either the moment
 * a route "completes" would be wrong: for route 'other' the hold IS the cooldown that stops an instant
 * re-dispatch into the same crash; for (a)/(b), a landing reaching `'landed'` only means a PR opened, not
 * that it merged, so the card edit is not yet on main. A hold that outlives a card genuinely
 * resolved/re-scoped is harmless — a resolved item is never a build candidate regardless of hold state, and
 * a re-scoped/unshaped item is a `prepare` candidate, a code path this daemon's hold-gating never touches.
 *
 * `releaseRoute` DOES run on a DEFINITE failure — `spawnLand` throwing/rejecting (the detached process never
 * even started, e.g. a bad argv or an import failure) or `recordFinding` throwing (the ledger write itself
 * failed) — releasing the just-taken lease so the very NEXT tick can retry promptly, rather than waiting out
 * the whole lease TTL for an attempt that never ran at all. #4465 review round 3 (live correctness finding):
 * this is deliberately narrower than "release on any failure" — `spawnLand` succeeding only means the
 * DETACHED landing process started; that process's own eventual outcome (the lane acquire, the citation
 * checks, `verify`, `open-pr`) is NOT observed here at all (no run-store/settle channel exists for this
 * pipeline the way `we:scripts/operations/deliver-item-settle.mjs` gives the `build` dispatch path — see this
 * item's own card for the filed follow-up). A landing that starts but later fails inside the detached
 * process is therefore a KNOWN, ACCEPTED MVP gap: it is not retried inside the lease's lifetime, and the item
 * simply falls back to ordinary build dispatch once the (longer) hold TTL itself lapses.
 * @returns {{num, route, action, error?}[]} one outcome per plan entry.
 */
export async function routeHeldItems({
  plan, reserveRoute = reserveHoldRoute, releaseRoute = releaseHoldRoute, spawnLand = () => ({ spawned: false }),
  recordFinding = appendHoldFinding,
} = {}) {
  const outcomes = [];
  for (const entry of Array.isArray(plan) ? plan : []) {
    if (!entry?.num) continue;
    // EVERY route dedups against a still-live lease first (#4465 review round 2 — route 'other' had NO dedup
    // at all: the same held item is re-planned every tick for the whole hold TTL, so a bare
    // `recordFinding` here would append one duplicate ledger entry per tick — ~120 of them over a 240-minute
    // hold — for one single crash).
    let lease;
    try { lease = reserveRoute({ num: entry.num, route: entry.route }); }
    catch (e) { outcomes.push({ num: entry.num, route: entry.route, action: 'reserve-failed', error: String(e?.message || e).split('\n')[0] }); continue; }
    if (!lease?.ok) { outcomes.push({ num: entry.num, route: entry.route, action: 'already-in-flight' }); continue; }
    if (entry.route === 'other') {
      try {
        recordFinding({ num: entry.num, reason: entry.reason });
        outcomes.push({ num: entry.num, route: entry.route, action: 'finding-recorded' });
      } catch (e) {
        try { releaseRoute({ num: entry.num, route: entry.route }); } catch { /* best-effort — the TTL still bounds it */ }
        outcomes.push({ num: entry.num, route: entry.route, action: 'finding-failed', error: String(e?.message || e).split('\n')[0] });
      }
      continue;
    }
    // (a)/(b) — land a card edit through a lane PR.
    try {
      await spawnLand(entry);
      outcomes.push({ num: entry.num, route: entry.route, action: 'landing-spawned' });
    } catch (e) {
      try { releaseRoute({ num: entry.num, route: entry.route }); } catch { /* best-effort — the TTL still bounds it */ }
      outcomes.push({ num: entry.num, route: entry.route, action: 'spawn-failed', error: String(e?.message || e).split('\n')[0] });
    }
  }
  return outcomes;
}
