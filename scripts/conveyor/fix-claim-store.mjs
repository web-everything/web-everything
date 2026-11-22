/**
 * @file scripts/conveyor/fix-claim-store.mjs
 * @description The LIGHT half of the `(repo, kind, pr)` claim store (`fix-dispatch-claim.mjs`, #2789): the
 *   root, the resource key, and the read/list helpers — with NO import of the dispatch/agent-listing graph.
 *   Split out (fix procedure, operator-approved 2026-09-27) because `guard-bash.mjs` must read fix claims on a
 *   `git push`, and `fix-dispatch-claim.mjs`'s own imports (`dispatch-lane-io.mjs` → `guard-lane.mjs` →
 *   `guard-bash.mjs`) form a cycle back into the hook — a cycle that deadlocks a top-level `await import`.
 *   `fix-dispatch-claim.mjs` re-exports every name here, so no existing importer changes.
 */
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { readLockEntry, parseLockEntry, isLeaseExpired } from '../readiness/file-locks.mjs';
import { mintSessionSlug } from './session-slug.mjs';

/** How long an unreleased claim survives before a DIFFERENT owner may reclaim it (dead-holder floor). Chosen
 *  well above the measured 26+s `claude agents --json --all` listing lag ({@link ../operations/dispatch-lane-io.mjs})
 *  this claim exists to bridge, with a wide margin so a real dispatch's own retry/confirm loop never outlives
 *  it, while still short enough that an abandoned claim (the release-on-reap hook not yet wired, above) self-
 *  heals without anyone touching a lock file by hand. */
export const DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES = 10;

/** The pinned, cross-checkout root every dispatcher's claim lives under — see this file's own header for why
 *  it is NOT `file-locks.mjs`'s own checkout-local default. `WE_COORDINATION_ROOT`-overridable via
 *  `resolveCoordinationRoot`, exactly like every other cross-process conveyor coordination path. */
export function fixDispatchClaimRoot(root = resolveCoordinationRoot()) {
  return join(root, 'fix-dispatch-claims');
}

/** The resource key this claim locks on: `(repo, kind, PR)` — NOT `headSha` (dropped by the dup-heal-dispatch
 *  fix, see this file's own header for the live incident that proved keying on `headSha` wrong: it let a
 *  still-live session's OWN push rotate its claim out from under itself). `kind` (`'fix'`/`'ci-heal'`) keeps a
 *  fix claim and a ci-heal claim for the same PR from sharing one slot — the two are independent dispatch
 *  kinds with independent session names (`we:scripts/conveyor/reconcile-core.mjs#bindAgents`'s own PATH 2).
 *  `headSha`, when given, is carried in `fix-dispatch-claim.mjs#acquireFixDispatchClaim`'s `meta` only — never part of the
 *  identity — purely for diagnostics (which commit was in flight when this claim was taken).
 * @param {{repo:string, pr:number, kind?:string}} o
 */
export function fixDispatchResource({ repo, pr, kind = 'fix' }) {
  if (!repo || typeof repo !== 'string') throw new TypeError('fixDispatchResource requires a repo string');
  if (!Number.isInteger(pr) || pr <= 0) throw new TypeError('fixDispatchResource requires an integer pr');
  if (!kind || typeof kind !== 'string') throw new TypeError('fixDispatchResource requires a kind string');
  return `fix-dispatch:${repo}:${kind}:${pr}`;
}

/**
 * Read-only introspection of one `(repo, kind, pr)` claim's current entry, or `null` if free — the primitive
 * a dry-run/status read (never a mutation) uses to report "claimed by X" without acquiring or releasing
 * anything itself.
 * @param {{repo:string, pr:number, kind?:string, lockRoot?:string}} o
 */
export function readFixDispatchClaim({
  repo, pr, kind = 'fix', lockRoot = fixDispatchClaimRoot(),
} = {}) {
  const resource = fixDispatchResource({ repo, pr, kind });
  return readLockEntry(lockRoot, resource);
}

/** we:scripts/conveyor/fix-claim-store.mjs#fixDispatchSessionName — the SAME session name a real dispatch
 *  for `(repo, kind, pr)` mints (`we:scripts/conveyor/reconcile-fix-dispatch.mjs#dispatchFix`'s own
 *  `sessionSlugFor(planned.pr, 'fix', null, '', repo)`, `we:scripts/operations/ci-heal-pr-dispatch.mjs
 *  #dispatchCiHeal`'s own `sessionSlugFor(planned.itemNum, 'ci-heal', planned.pr, '', repo)`) and the SAME
 *  name `we:scripts/conveyor/reconcile-core.mjs#bindAgents`'s own PATH 2 matches against `claude agents
 *  --json --all` — reused here (via the shared, lower-level {@link mintSessionSlug}, never re-derived) so
 *  `fix-dispatch-claim.mjs#isClaimSessionLive` asks `bindAgents`'s exact question. Pure.
 * @param {{repo:string, pr:number, kind?:string}} o
 * @returns {string}
 */
export function fixDispatchSessionName({ repo, pr, kind = 'fix' }) {
  return mintSessionSlug({ kind, id: pr, repo });
}

/**
 * we:scripts/conveyor/fix-claim-store.mjs#listFixDispatchClaims — every currently-held claim under
 * `lockRoot`, parsed via `file-locks.mjs`'s own tolerant {@link parseLockEntry} (a half-written/corrupt entry
 * is skipped, never thrown over). Raw directory scan, not keyed by resource — `fix-dispatch-claim.mjs#refreshLiveFixDispatchClaims`
 * needs to iterate EVERY claim, and the resource string a claim was filed under is not recoverable from its
 * hashed lock-dir name (`we:scripts/readiness/file-locks.mjs#lockIdFor`), so this reads each entry's own
 * `meta` (`{repo, pr, kind, headSha}`, written by `fix-dispatch-claim.mjs#acquireFixDispatchClaim`) instead of re-deriving the
 * resource string. An entry with no usable `meta` (written before this shape existed, or corrupt) is skipped —
 * `fix-dispatch-claim.mjs#refreshLiveFixDispatchClaims` simply never refreshes it, and it recovers on its own plain TTL exactly
 * as before this fix.
 * @param {string} [lockRoot]
 * @param {{liveOnly?:boolean, nowMs?:number, leaseMinutes?:number}} [o]  `liveOnly` skips TTL-expired claims (#4295)
 * @returns {Array<{owner:string, path:string, pid:number|null, heartbeatAt:string, meta:{repo:string, pr:number, kind:string, headSha:string|null}}>}
 */
export function listFixDispatchClaims(lockRoot = fixDispatchClaimRoot(), {
  liveOnly = false, nowMs = Date.now(), leaseMinutes = DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES,
} = {}) {
  let dirNames;
  try { dirNames = readdirSync(lockRoot); } catch { return []; }
  const out = [];
  for (const dirName of dirNames) {
    let raw = '';
    try { raw = readFileSync(join(lockRoot, dirName, 'lock.json'), 'utf8'); } catch { /* skip: no entry file */ }
    const entry = parseLockEntry(raw);
    if (!entry || !entry.meta || !entry.meta.repo || !entry.meta.pr || !entry.meta.kind) continue;
    // #4295 — `liveOnly` drops a TTL-expired claim (a stale leftover must not hold a build/fix out).
    if (liveOnly && isLeaseExpired(entry, nowMs, leaseMinutes)) continue;
    out.push(entry);
  }
  return out;
}
