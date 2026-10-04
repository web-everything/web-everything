/**
 * @file scripts/conveyor/__tests__/fix-dispatch-claim.test.mjs — #x0jphk5 (parent #4075, epic #3383), corrected
 *   dup-heal-dispatch (2026-09-27 LIVE INCIDENT).
 * @description Proves the real per-(repo, kind, PR) claim `reconcile-fix-dispatch-daemon.mjs`'s own header used
 *   to (falsely) claim already existed. Three planes:
 *     1. The claim primitives themselves (`fix-dispatch-claim.mjs`), against a real temp lock root — atomic
 *        mutual exclusion and TTL-bounded dead-holder reclaim, mirroring `file-locks.test.mjs`'s own style.
 *     2. THE RED→GREEN PROOF: `dispatchFix`, `tryResumeFix` and `dispatchCiHeal` each wired to take this claim
 *        before spawning/resuming — two dispatch attempts for the SAME PR, from two DIFFERENT owners (modeling
 *        two real dispatcher processes racing the 26+s `claude agents --json --all` listing lag these
 *        functions' own docblocks describe), produce EXACTLY ONE spawn.
 *     3. THE dup-heal-dispatch REGRESSION PROOF: the original design keyed the claim on `(repo, pr, headSha)`,
 *        so a live session's OWN push (a NEW head sha, same PR, same kind) opened a free, independent slot — a
 *        second dispatcher reading it during the SAME listing-lag window dispatched a genuine DUPLICATE
 *        (`ci-heal-2784` x3 / `ci-heal-2783` x3, live 2026-09-26 22:16 ET — see `fix-dispatch-claim.mjs`'s own
 *        header). The key is now `(repo, kind, pr)`, with `headSha` carried only as diagnostic `meta` — these
 *        tests prove the SAME head-sha-rotation scenario is now refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES, fixDispatchClaimRoot, fixDispatchClaimOwner, fixDispatchResource,
  releaseSessionFixDispatchClaims, acquireFixDispatchClaim, releaseFixDispatchClaim, readFixDispatchClaim, fixDispatchSessionName,
  isClaimSessionLive, listFixDispatchClaims, refreshLiveFixDispatchClaims, MAX_FIX_DISPATCH_CLAIM_REFRESH_MS,
} from '../fix-dispatch-claim.mjs';
import { heartbeat } from '../../readiness/file-locks.mjs';
import { dispatchFix, tryResumeFix, filterFixesByInFlightScope } from '../reconcile-fix-dispatch.mjs';
import { dispatchCiHeal } from '../../operations/ci-heal-pr-dispatch.mjs';
import { buildAuthorActorMarker } from '../../lib/review-independence.mjs';

let claimRoot;
beforeEach(() => { claimRoot = mkdtempSync(join(tmpdir(), 'fix-dispatch-claim-test-')); });
afterEach(() => { rmSync(claimRoot, { recursive: true, force: true }); });

const T0 = Date.parse('2026-09-25T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

describe('fixDispatchResource', () => {
  it('keys on repo + kind + pr, distinguishing every axis', () => {
    const a = fixDispatchResource({ repo: 'we', pr: 100, kind: 'fix' });
    const b = fixDispatchResource({ repo: 'plateau-app', pr: 100, kind: 'fix' });
    const c = fixDispatchResource({ repo: 'we', pr: 101, kind: 'fix' });
    const d = fixDispatchResource({ repo: 'we', pr: 100, kind: 'ci-heal' });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
  // dup-heal-dispatch (2026-09-27 LIVE INCIDENT) — THE REGRESSION THIS FIX CLOSES. Before this fix, a
  // different head sha for the SAME (repo, pr) was a FREE, independent slot — exactly what let a still-live
  // session's own push (a fresh commit it made mid-task) rotate its own claim out from under it, so a second
  // dispatcher inside the listing-lag window saw "free" and double-dispatched (`ci-heal-2784`/`ci-heal-2783`,
  // live tonight). The resource key no longer varies with `headSha` at all — it is metadata only now (see
  // `acquireFixDispatchClaim`'s own `meta.headSha`).
  it('a DIFFERENT head sha for the SAME (repo, kind, pr) is the SAME resource — no longer a free slot', () => {
    const a = fixDispatchResource({ repo: 'we', pr: 100, kind: 'ci-heal' });
    const b = fixDispatchResource({ repo: 'we', pr: 100, kind: 'ci-heal' }); // headSha isn't even part of the call
    expect(a).toBe(b);
  });
  it('kind defaults to "fix" — every pre-existing caller that never passed one keeps its old resource string', () => {
    expect(fixDispatchResource({ repo: 'we', pr: 100 })).toBe(fixDispatchResource({ repo: 'we', pr: 100, kind: 'fix' }));
  });
  it('rejects a non-string repo, non-integer pr, or empty kind', () => {
    expect(() => fixDispatchResource({ repo: '', pr: 5 })).toThrow(TypeError);
    expect(() => fixDispatchResource({ repo: 'we', pr: 'x' })).toThrow(TypeError);
    expect(() => fixDispatchResource({ repo: 'we', pr: 5, kind: '' })).toThrow(TypeError);
  });
});

describe('fixDispatchClaimRoot / fixDispatchClaimOwner', () => {
  it('roots under the coordination sidecar, not a checkout-local dir', () => {
    expect(fixDispatchClaimRoot('/coord')).toBe(join('/coord', 'fix-dispatch-claims'));
  });
  it('the default owner embeds host and pid, so two different real processes never collide', () => {
    const o1 = fixDispatchClaimOwner({ host: 'mac', pid: 111 });
    const o2 = fixDispatchClaimOwner({ host: 'mac', pid: 222 });
    expect(o1).not.toBe(o2);
    expect(o1).toBe('mac:111');
  });
});

describe('acquireFixDispatchClaim / releaseFixDispatchClaim — atomic mutual exclusion', () => {
  it('the first owner acquires cleanly', () => {
    const r = acquireFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    expect(r).toMatchObject({ ok: true, reason: 'free', heldBy: 'A' });
  });

  it('a SECOND, different owner is refused while the first still holds it', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    const r2 = acquireFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'B', lockRoot: claimRoot, nowMs: T0 + 1000, nowIso: iso(T0 + 1000) });
    expect(r2).toMatchObject({ ok: false, reason: 'held', heldBy: 'A' });
  });

  // dup-heal-dispatch REGRESSION PROOF — see this file's own header and `fixDispatchResource`'s own test above.
  it('a DIFFERENT head sha for the SAME (repo, kind, pr) is BLOCKED, not a free slot (the live incident this fixes)', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 100, kind: 'ci-heal', headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    // Models the still-live session's OWN push: a fresh head sha, same PR, same kind, moments later.
    const r2 = acquireFixDispatchClaim({ repo: 'we', pr: 100, kind: 'ci-heal', headSha: 'sha2', owner: 'B', lockRoot: claimRoot, nowMs: T0 + 60_000, nowIso: iso(T0 + 60_000) });
    expect(r2).toMatchObject({ ok: false, reason: 'held', heldBy: 'A' });
  });
  it('a DIFFERENT kind for the SAME (repo, pr) is a free, independent slot — fix and ci-heal never share one', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 100, kind: 'fix', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    const r2 = acquireFixDispatchClaim({ repo: 'we', pr: 100, kind: 'ci-heal', owner: 'B', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    expect(r2.ok).toBe(true);
  });

  it('the SAME owner re-acquiring is a reentrant heartbeat refresh, not a refusal', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    const r2 = acquireFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0 + 1000, nowIso: iso(T0 + 1000) });
    expect(r2).toMatchObject({ ok: true, reason: 'own', heldBy: 'A' });
  });

  it('release by the OWNER frees it for the next acquirer immediately', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    const rel = releaseFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'A', lockRoot: claimRoot });
    expect(rel).toEqual({ released: true });
    const r2 = acquireFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'B', lockRoot: claimRoot, nowMs: T0 + 1000, nowIso: iso(T0 + 1000) });
    expect(r2.ok).toBe(true);
  });

  it('release by a NON-owner is a safe no-op — never tears down a lock it does not own', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    const rel = releaseFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'B', lockRoot: claimRoot });
    expect(rel).toEqual({ released: false, reason: 'not-owner', heldBy: 'A' });
    expect(readFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', lockRoot: claimRoot })?.owner).toBe('A');
  });

  it('releasing an absent claim is a safe no-op', () => {
    expect(releaseFixDispatchClaim({ repo: 'we', pr: 999, headSha: 'x', owner: 'A', lockRoot: claimRoot })).toEqual({ released: false, reason: 'absent' });
  });

  it('DEAD-HOLDER RECLAIM: a claim past its TTL is reclaimed by a new owner, never PID-fast-pathed', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 100, headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0), leaseMinutes: 10 });
    // Just inside the TTL: still held.
    const withinTtl = acquireFixDispatchClaim({
      repo: 'we', pr: 100, headSha: 'sha1', owner: 'B', lockRoot: claimRoot,
      nowMs: T0 + 9 * 60_000, nowIso: iso(T0 + 9 * 60_000), leaseMinutes: 10,
    });
    expect(withinTtl.ok).toBe(false);
    // Past the TTL: reclaimed, even though the ORIGINAL owner's "pid" was never probed as dead (this module
    // never passes a real pid-liveness verdict — see fix-dispatch-claim.mjs's own header for why).
    const pastTtl = acquireFixDispatchClaim({
      repo: 'we', pr: 100, headSha: 'sha1', owner: 'B', lockRoot: claimRoot,
      nowMs: T0 + 11 * 60_000, nowIso: iso(T0 + 11 * 60_000), leaseMinutes: 10,
    });
    expect(pastTtl).toMatchObject({ ok: true, reason: 'lease-expired', heldBy: 'B' });
  });

  it('the default TTL is comfortably above the measured 26+s listing lag', () => {
    expect(DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES * 60).toBeGreaterThan(26 * 10);
  });
});

describe('readFixDispatchClaim — read-only introspection for a dry-run', () => {
  it('reports null when free, and the holder once claimed', () => {
    expect(readFixDispatchClaim({ repo: 'we', pr: 7, headSha: 's', lockRoot: claimRoot })).toBeNull();
    acquireFixDispatchClaim({ repo: 'we', pr: 7, headSha: 's', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    expect(readFixDispatchClaim({ repo: 'we', pr: 7, headSha: 's', lockRoot: claimRoot })?.owner).toBe('A');
  });
});

describe('fixDispatchSessionName / isClaimSessionLive — the name-based liveness signal the refresh relies on', () => {
  it('mints the SAME name a real dispatch would (mirrors bindAgents PATH 2)', () => {
    expect(fixDispatchSessionName({ repo: 'we', pr: 2784, kind: 'ci-heal' })).toBe('ci-heal-2784');
    expect(fixDispatchSessionName({ repo: 'we', pr: 2783, kind: 'fix' })).toBe('fix-2783');
  });
  it('is live when a non-terminal agent carries the exact expected name', () => {
    const agentsAll = [{ name: 'ci-heal-2784', state: 'working' }];
    expect(isClaimSessionLive({ repo: 'we', pr: 2784, kind: 'ci-heal', agentsAll })).toBe(true);
  });
  it('is NOT live once the session reaches a terminal state', () => {
    const agentsAll = [{ name: 'ci-heal-2784', state: 'done' }];
    expect(isClaimSessionLive({ repo: 'we', pr: 2784, kind: 'ci-heal', agentsAll })).toBe(false);
  });
  it('is NOT live when no agent carries that name at all (covers the spawn-listing lag)', () => {
    expect(isClaimSessionLive({ repo: 'we', pr: 2784, kind: 'ci-heal', agentsAll: [] })).toBe(false);
  });
});

describe('listFixDispatchClaims / refreshLiveFixDispatchClaims — the tick-time keep-alive', () => {
  it('lists every held claim with usable meta', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    acquireFixDispatchClaim({ repo: 'we', pr: 2783, kind: 'ci-heal', headSha: 'sha2', owner: 'B', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    const claims = listFixDispatchClaims(claimRoot);
    expect(claims).toHaveLength(2);
    expect(claims.map((c) => c.meta.pr).sort()).toEqual([2783, 2784]);
  });

  it('returns [] for a lockRoot that does not exist yet, rather than throwing', () => {
    expect(listFixDispatchClaims(join(claimRoot, 'does-not-exist'))).toEqual([]);
  });

  it('refreshes ONLY the claim whose session is confirmed live — a claim near TTL expiry survives a tick while its session is still running', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0), leaseMinutes: 10 });
    acquireFixDispatchClaim({ repo: 'we', pr: 2783, kind: 'ci-heal', headSha: 'sha2', owner: 'B', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0), leaseMinutes: 10 });

    // #2784's session is still live; #2783's already finished.
    const listAgentsAll = () => [{ name: 'ci-heal-2784', state: 'working' }, { name: 'ci-heal-2783', state: 'done' }];
    const refreshAt = T0 + 9 * 60_000; // just inside the original 10-minute TTL
    const result = refreshLiveFixDispatchClaims({ lockRoot: claimRoot, listAgentsAll, nowIso: () => iso(refreshAt) });
    expect(result.checked).toBe(2);
    expect(result.refreshed).toHaveLength(1);
    expect(result.refreshed[0]).toMatchObject({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A' });

    // Past the ORIGINAL TTL (T0 + 11min): #2784's claim (refreshed at T0+9min) is still held; #2783's (never
    // refreshed) is now reclaimable — proving the refresh, not a fluke, is what kept #2784's claim alive.
    const pastOriginalTtl = T0 + 11 * 60_000;
    const stillHeld = acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'C', lockRoot: claimRoot, nowMs: pastOriginalTtl, nowIso: iso(pastOriginalTtl) });
    expect(stillHeld.ok).toBe(false);
    const reclaimed = acquireFixDispatchClaim({ repo: 'we', pr: 2783, kind: 'ci-heal', owner: 'C', lockRoot: claimRoot, nowMs: pastOriginalTtl, nowIso: iso(pastOriginalTtl) });
    expect(reclaimed).toMatchObject({ ok: true, reason: 'lease-expired' });
  });

  // PR #2789 review (correctness) — a HUNG session keeps reporting `state: 'working'` until the reaper reaps
  // it; before this fix the refresh re-heartbeated its claim forever instead of letting the TTL reclaim it.
  it('a HUNG-but-"working" session (transcript stale) is NOT refreshed — the plain TTL reclaims its claim', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0), leaseMinutes: 10 });
    const listAgentsAll = () => [{ name: 'ci-heal-2784', state: 'working', cwd: '/x', sessionId: 'sid' }];
    const hungInfoFor = () => ({ hung: true, reason: 'stale-transcript' });
    for (const m of [9, 18, 27]) {
      refreshLiveFixDispatchClaims({ lockRoot: claimRoot, listAgentsAll, hungInfoFor, nowMs: T0 + m * 60_000, nowIso: () => iso(T0 + m * 60_000) });
    }
    const at = T0 + 27 * 60_000;
    expect(acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'C', lockRoot: claimRoot, nowMs: at, nowIso: iso(at) }))
      .toMatchObject({ ok: true, reason: 'lease-expired' });
  });

  it('an agent row already carrying an upstream finished verdict (hung / selfReportedDone / authExpired) is NOT live', () => {
    for (const flag of ['hung', 'selfReportedDone', 'authExpired']) {
      const agentsAll = [{ name: 'ci-heal-2784', state: 'working', [flag]: true }];
      expect(isClaimSessionLive({ repo: 'we', pr: 2784, kind: 'ci-heal', agentsAll })).toBe(false);
    }
  });

  it('HARD CEILING: even a session that reads live forever stops being refreshed past MAX_FIX_DISPATCH_CLAIM_REFRESH_MS', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0), leaseMinutes: 10 });
    const listAgentsAll = () => [{ name: 'ci-heal-2784', state: 'working' }];
    const hungInfoFor = () => ({ hung: false });
    const inside = T0 + MAX_FIX_DISPATCH_CLAIM_REFRESH_MS - 60_000;
    expect(refreshLiveFixDispatchClaims({ lockRoot: claimRoot, listAgentsAll, hungInfoFor, nowMs: inside, nowIso: () => iso(inside) }).refreshed).toHaveLength(1);
    const past = T0 + MAX_FIX_DISPATCH_CLAIM_REFRESH_MS + 60_000;
    expect(refreshLiveFixDispatchClaims({ lockRoot: claimRoot, listAgentsAll, hungInfoFor, nowMs: past, nowIso: () => iso(past) }).refreshed).toHaveLength(0);
  });

  it('claimedAt: a reentrant re-acquire of a LIVE lease keeps it; re-acquiring an EXPIRED leftover (same daemon owner) starts fresh', () => {
    const at = (m) => ({ nowMs: T0 + m * 60_000, nowIso: iso(T0 + m * 60_000) });
    const read = () => readFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', lockRoot: claimRoot }).meta.claimedAt;
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A', lockRoot: claimRoot, leaseMinutes: 10, ...at(0) });
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A', lockRoot: claimRoot, leaseMinutes: 10, ...at(5) });
    expect(read()).toBe(iso(T0));
    // Hours later the SAME long-running daemon dispatches the PR again over its own never-released leftover.
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A', lockRoot: claimRoot, leaseMinutes: 10, ...at(300) });
    expect(read()).toBe(iso(T0 + 300 * 60_000));
  });

  it('a legacy claim with no claimedAt is stamped on its first refresh, so the ceiling applies to it too', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    const [entry] = listFixDispatchClaims(claimRoot);
    const { claimedAt, ...legacyMeta } = entry.meta;
    expect(claimedAt).toBe(iso(T0));
    heartbeat(claimRoot, fixDispatchResource({ repo: 'we', pr: 2784, kind: 'ci-heal' }), 'A', iso(T0), null, legacyMeta);
    const listAgentsAll = () => [{ name: 'ci-heal-2784', state: 'working' }];
    const r = refreshLiveFixDispatchClaims({ lockRoot: claimRoot, listAgentsAll, hungInfoFor: () => ({ hung: false }), nowMs: T0 + 60_000, nowIso: () => iso(T0 + 60_000) });
    expect(r.refreshed).toHaveLength(1);
    expect(readFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', lockRoot: claimRoot }).meta.claimedAt).toBe(iso(T0 + 60_000));
  });

  // PR #2789 review (security/toctou) — the refresh used an owner snapshot from the listing and heartbeat-wrote
  // it blindly, clobbering a DIFFERENT owner that released+re-acquired in between.
  it('never clobbers a claim re-acquired by a DIFFERENT owner between the listing and the heartbeat write', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    const listAgentsAll = () => {
      // Between listFixDispatchClaims() and the heartbeat: A releases, C wins the same resource.
      releaseFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A', lockRoot: claimRoot });
      acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', headSha: 'sha2', owner: 'C', lockRoot: claimRoot, nowMs: T0 + 1000, nowIso: iso(T0 + 1000) });
      return [{ name: 'ci-heal-2784', state: 'working' }];
    };
    const result = refreshLiveFixDispatchClaims({ lockRoot: claimRoot, listAgentsAll, hungInfoFor: () => ({ hung: false }), nowMs: T0 + 2000, nowIso: () => iso(T0 + 2000) });
    expect(result.refreshed).toHaveLength(0);
    expect(readFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', lockRoot: claimRoot })).toMatchObject({ owner: 'C', meta: { headSha: 'sha2' } });
    expect(releaseFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'C', lockRoot: claimRoot })).toEqual({ released: true });
  });

  // PR #2789 review (antigravity) — an async listing would have been silently read as "no agents" (a Promise is
  // not an array), skipping every refresh. It must fail LOUDLY instead.
  it('an async (Promise-returning) listAgentsAll is refused loudly, never silently treated as an empty listing', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 2784, kind: 'ci-heal', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    expect(() => refreshLiveFixDispatchClaims({ lockRoot: claimRoot, listAgentsAll: async () => [] })).toThrow(TypeError);
  });

  it('a lock root with no claims at all is a no-op (never calls listAgentsAll unnecessarily)', () => {
    let called = false;
    const result = refreshLiveFixDispatchClaims({ lockRoot: join(claimRoot, 'empty'), listAgentsAll: () => { called = true; return []; } });
    expect(result).toEqual({ checked: 0, refreshed: [] });
    expect(called).toBe(false);
  });
});

// ── THE RED→GREEN PROOF ─────────────────────────────────────────────────────────────────────────────────────
// Each block below calls the REAL dispatch function twice for the SAME (repo, pr, headSha), from two DIFFERENT
// claim owners (modeling two independent dispatcher processes), sharing one real `claimRoot`. Before this item,
// nothing stopped both calls from spawning; the assertion is always "exactly one spawn happened, total".

const REAL_TEMPLATE_STUB = [
  '# fix brief for {{PR_NUM}} (item {{ITEM_NUM}})',
  'acquire: node scripts/lane-pool.mjs acquire --lane={{LANE}} --session={{SESSION_SLUG}} --scope={{SCOPE}} --base={{LANE_REF}}',
  'this brief documents {{LIKE_THIS}} as an example convention, not a real token',
].join('\n');

describe('dispatchFix — two racing dispatchers, one PR: exactly one spawn', () => {
  const planned = { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-x', scope: ['we:x'], lane: 9, headRefOid: 'deadbeef'.repeat(5) };
  const baseOpts = { root: '/repo', readBrief: () => REAL_TEMPLATE_STUB, claimRoot };

  it('dispatcher A spawns; dispatcher B (racing the listing lag) is refused `held`, spawning nothing', () => {
    const spawnCalls = [];
    const spawnAgent = (argv, opts) => { spawnCalls.push({ argv, opts }); return ''; };

    const resultA = dispatchFix(planned, { ...baseOpts, mintSessionId: () => 'sid-a', spawnAgent, claimOwner: 'dispatcher-A' });
    expect(resultA.held).toBeUndefined();
    expect(resultA.sessionId).toBe('sid-a');

    const resultB = dispatchFix(planned, { ...baseOpts, mintSessionId: () => 'sid-b', spawnAgent, claimOwner: 'dispatcher-B' });
    expect(resultB).toMatchObject({ held: true, reason: 'held', heldBy: 'dispatcher-A' });

    expect(spawnCalls).toHaveLength(1); // ← THE PROOF: not two.
  });

  it('RED WITHOUT THE CLAIM (regression guard): calling twice with claiming disabled would double-spawn — proves the claim, not something else, is what caps it at one', () => {
    const spawnCalls = [];
    const spawnAgent = () => { spawnCalls.push(1); return ''; };
    const noClaim = () => ({ ok: true, reason: 'free', heldBy: null });
    const noop = () => ({ released: false, reason: 'absent' });

    dispatchFix(planned, { ...baseOpts, mintSessionId: () => 'sid-a', spawnAgent, acquireClaim: noClaim, releaseClaim: noop });
    dispatchFix(planned, { ...baseOpts, mintSessionId: () => 'sid-b', spawnAgent, acquireClaim: noClaim, releaseClaim: noop });
    expect(spawnCalls).toHaveLength(2); // without the claim wired, both attempts spawn — this is the bug this item fixes.
  });

  it('a failed attempt (spawnAgent throws) releases its claim so a legitimate retry is never blocked forever', () => {
    const throwing = () => { throw new Error('claude --bg failed'); };
    expect(() => dispatchFix(planned, { ...baseOpts, mintSessionId: () => 'sid-a', spawnAgent: throwing, claimOwner: 'dispatcher-A' })).toThrow('claude --bg failed');

    const spawnCalls = [];
    const retry = dispatchFix(planned, { ...baseOpts, mintSessionId: () => 'sid-b', spawnAgent: (a, o) => { spawnCalls.push({ a, o }); return ''; }, claimOwner: 'dispatcher-B' });
    expect(retry.held).toBeUndefined();
    expect(spawnCalls).toHaveLength(1);
  });
});

describe('runReconcileFixDispatch — a `held` result returns its popped lane to the pool', () => {
  it('reports `held` for the claimed PR (never pushed into `dispatched`) and reuses the SAME lane for the next entry — proving it was given back, not leaked', async () => {
    const { runReconcileFixDispatch } = await import('../reconcile-fix-dispatch.mjs');
    const dispatchCalls = [];
    const result = runReconcileFixDispatch({
      root: '/repo',
      // No conveyor item in either head ref — the item-less PR-diff-fallback path, so no `findItemFn`/
      // `resolveFallbackScope` plumbing is needed to reach a real `scope:` (mirrors this file's own
      // `reconcile-fix-dispatch.test.mjs` "attributed to the PR itself" fixture).
      reconcile: () => ({
        dispatch: [
          { kind: 'fix', prNumber: 50, headRefName: 'some-hand-opened-branch-a', headRefOid: 'a'.repeat(40) },
          { kind: 'fix', prNumber: 51, headRefName: 'some-hand-opened-branch-b', headRefOid: 'b'.repeat(40) },
        ],
        refusals: [],
      }),
      findItemFn: () => null,
      loadItems: () => [],
      fetchItemlessDiffPaths: (pr) => [pr === 50 ? 'we:x' : 'we:y'], // disjoint — #4295 would serialize identical scopes
      pickFreeLanes: () => [3], // exactly ONE lane in the pool — the second entry can only dispatch if it's returned.
      tryResume: () => ({ resumed: false, resumeAttempt: null }),
      dispatch: (entry) => {
        dispatchCalls.push(entry);
        return entry.pr === 50 ? { held: true, reason: 'held', heldBy: 'dispatcher-A' } : { sessionId: 's', pr: entry.pr, itemNum: null, lane: entry.lane, unknownTokens: [], resumed: false };
      },
      checkStaleness: () => ({ fresh: true, behind: 0 }),
    });
    expect(result.refusals).toEqual([{ pr: 50, kind: 'held', why: expect.stringContaining('dispatcher-A') }]);
    expect(result.dispatched).toEqual([{ sessionId: 's', pr: 51, itemNum: null, lane: 3, unknownTokens: [], resumed: false }]);
    expect(dispatchCalls.map((d) => d.lane)).toEqual([3, 3]); // the SAME lane number, reused after being given back.
  });
});

describe('tryResumeFix — a racing resume attempt is claim-refused, never a duplicate `--resume`', () => {
  const MATCHING_HEAD = 'deadbeef'.repeat(5);
  const marker = buildAuthorActorMarker('cand-0000-0000-0000-000000000000');
  const planned = {
    itemNum: '3438', pr: 1764, laneRef: 'lane/3438-wire-reconcile-pass', scope: ['we:x'],
    isConflict: true, body: `some PR body\n\n${marker}\n`, headRefOid: MATCHING_HEAD,
  };
  const baseOpts = {
    root: '/repo', claimRoot,
    listAgentsAll: () => [{ sessionId: 'cand-0000-0000-0000-000000000000', id: 'candxxxx', cwd: '/lanes/lane-4', name: 'conveyor-3438' }],
    resolveHead: (cwd) => (cwd === '/lanes/lane-4' ? MATCHING_HEAD : null),
  };

  it('two dispatchers racing the same, ownership-confirmed resume candidate: only one issues `--resume`', () => {
    // Genuine interleaving, not just two sequential calls: dispatcher B races in from INSIDE dispatcher A's own
    // `spawnAgent` call — i.e. after A has taken the claim but before it has released it — modeling the real
    // race (two dispatchers reading the same stale listing at nearly the same instant). A sequential-only test
    // would pass even without the claim wired correctly, since `tryResumeFix` releases on completion; this is
    // the shape that actually needs the claim's mutual exclusion.
    const resumeCalls = [];
    let bResult = null;
    const spawnAgent = (argv) => {
      resumeCalls.push(argv);
      if (!bResult) {
        bResult = tryResumeFix(planned, {
          ...baseOpts, claimOwner: 'dispatcher-B',
          spawnAgent: (bArgv) => { resumeCalls.push(bArgv); return 'backgrounded · candxxxx\n'; },
        });
      }
      return 'backgrounded · candxxxx\n';
    };

    const a = tryResumeFix(planned, { ...baseOpts, spawnAgent, claimOwner: 'dispatcher-A' });

    expect(resumeCalls).toHaveLength(1); // ← THE PROOF: B raced in mid-flight and did NOT get to `--resume`.
    expect(a.resumed).toBe(true);
    expect(bResult.resumed).toBe(false);
    expect(bResult.resumeAttempt).toMatchObject({ attempted: false, refused: 'claimed-elsewhere' });
    // The winning attempt released its own claim once its (synchronous, bounded) resume attempt concluded —
    // a THIRD dispatcher arriving after A finishes is free to try again (not double-blocked forever).
    expect(readFixDispatchClaim({ repo: 'we', pr: 1764, headSha: MATCHING_HEAD, lockRoot: claimRoot })).toBeNull();
  });
});

describe('dispatchCiHeal — two racing dispatchers, one PR: exactly one spawn', () => {
  const TEMPLATE = 'heal #{{ITEM_NUM}} pr={{PR_NUM}} ref={{LANE_REF}} lane={{LANE}} slug={{SESSION_SLUG}} scope={{SCOPE}} why={{REASON}}';
  const planned = { itemNum: '2638', pr: 743, laneRef: 'lane/2638-some-slug', scope: ['we:scripts/a.mjs'], lane: 9, headRefOid: 'sha-ci' };

  it('dispatcher A spawns via the sink; dispatcher B is refused `held`, the sink never called', async () => {
    const { DISPATCH_EFFECT } = await import('../../operations/dispatch-lane.mjs');
    const sinkCalls = [];
    const sinks = { [DISPATCH_EFFECT]: async (payload) => { sinkCalls.push(payload); return { handle: 'agent-1' }; } };

    const a = await dispatchCiHeal(planned, { readBrief: () => TEMPLATE, sinks, claimRoot, claimOwner: 'dispatcher-A' });
    expect(a.held).toBeUndefined();

    const b = await dispatchCiHeal(planned, { readBrief: () => TEMPLATE, sinks, claimRoot, claimOwner: 'dispatcher-B' });
    expect(b).toMatchObject({ held: true, reason: 'held', heldBy: 'dispatcher-A' });

    expect(sinkCalls).toHaveLength(1); // ← THE PROOF: the sink (which is what actually spawns) ran once.
  });

  // dup-heal-dispatch — THE LIVE INCIDENT ITSELF, REPLAYED THROUGH THE REAL DISPATCH FUNCTION: `ci-heal-2784`
  // dispatched three times tonight because each dispatch's OWN push (a real ci-heal commit) changed the PR's
  // `headRefOid` before the previous session was confirmed live, and the OLD claim keyed on that head sha let
  // the second dispatch see a free slot. This models EXACTLY that: dispatcher A dispatches against `headRefOid:
  // 'sha1'`; dispatcher B, moments later, reads the SAME PR post-push (`headRefOid: 'sha2'`) and tries again —
  // must be refused, not a second real spawn.
  it('the SAME PR redispatched after its OWN head sha changed (a live session\'s own push) is refused, not a second spawn', async () => {
    const { DISPATCH_EFFECT } = await import('../../operations/dispatch-lane.mjs');
    const sinkCalls = [];
    const sinks = { [DISPATCH_EFFECT]: async (payload) => { sinkCalls.push(payload); return { handle: 'agent-1' }; } };

    const a = await dispatchCiHeal({ ...planned, headRefOid: 'sha1' }, { readBrief: () => TEMPLATE, sinks, claimRoot, claimOwner: 'dispatcher-A' });
    expect(a.held).toBeUndefined();

    const b = await dispatchCiHeal({ ...planned, headRefOid: 'sha2' }, { readBrief: () => TEMPLATE, sinks, claimRoot, claimOwner: 'dispatcher-B' });
    expect(b).toMatchObject({ held: true, reason: 'held', heldBy: 'dispatcher-A' });

    expect(sinkCalls).toHaveLength(1); // ← THE PROOF: tonight's actual duplicate-dispatch shape, now refused.
  });
});

// PR #2789 review (codex-correctness) — the kind-discrimination test above bypassed the real callers. If
// dispatchCiHeal ever dropped its explicit `kind: 'ci-heal'`, it would fall back to 'fix' and a live fix claim
// would silently suppress ci-heal for the same PR. Drives BOTH real dispatch functions through one claim root.
describe('dispatchFix and dispatchCiHeal acquire independent claims for the same PR', () => {
  it('both spawn for one PR; a second attempt of EITHER kind is then held', async () => {
    const { DISPATCH_EFFECT } = await import('../../operations/dispatch-lane.mjs');
    const planned = { itemNum: '3438', pr: 1764, laneRef: 'lane/3438-x', scope: ['we:x'], lane: 9, headRefOid: 'sha-mixed' };
    const spawnCalls = [];
    const spawnAgent = () => { spawnCalls.push('fix'); return ''; };
    const sinks = { [DISPATCH_EFFECT]: async () => { spawnCalls.push('ci-heal'); return { handle: 'agent-1' }; } };
    const fixOpts = { root: '/repo', readBrief: () => REAL_TEMPLATE_STUB, claimRoot, spawnAgent };
    const healOpts = { readBrief: () => 'heal {{PR_NUM}} {{ITEM_NUM}} {{LANE_REF}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}} {{REASON}}', sinks, claimRoot };

    const fixA = dispatchFix(planned, { ...fixOpts, mintSessionId: () => 'sid-a', claimOwner: 'dispatcher-A' });
    expect(fixA.held).toBeUndefined();
    const healA = await dispatchCiHeal(planned, { ...healOpts, claimOwner: 'dispatcher-A' });
    expect(healA.held).toBeUndefined(); // ← a live FIX claim must not suppress ci-heal for the same PR.

    expect(dispatchFix(planned, { ...fixOpts, mintSessionId: () => 'sid-b', claimOwner: 'dispatcher-B' })).toMatchObject({ held: true });
    expect(await dispatchCiHeal(planned, { ...healOpts, claimOwner: 'dispatcher-B' })).toMatchObject({ held: true });
    expect(spawnCalls).toEqual(['fix', 'ci-heal']);
  });
});

describe('#4295 — fix claims carry scope; the list can be live-only', () => {
  it('acquireFixDispatchClaim stores meta.scope', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 5, scope: ['we:scripts/a.mjs'], lockRoot: claimRoot, nowMs: T0 });
    expect(listFixDispatchClaims(claimRoot)[0].meta.scope).toEqual(['we:scripts/a.mjs']);
  });
  it('omits meta.scope when none is given', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 5, lockRoot: claimRoot, nowMs: T0 });
    expect(listFixDispatchClaims(claimRoot)[0].meta.scope).toBeUndefined();
  });
  it('liveOnly excludes an expired claim', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 5, scope: ['we:a'], lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0) });
    const later = T0 + (DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES + 5) * 60_000;
    expect(listFixDispatchClaims(claimRoot, { liveOnly: true, nowMs: T0 + 1000 })).toHaveLength(1);
    expect(listFixDispatchClaims(claimRoot, { liveOnly: true, nowMs: later })).toHaveLength(0);
    expect(listFixDispatchClaims(claimRoot)).toHaveLength(1);
  });
});

describe('overlap claim settlement', () => {
  const scope = ['we:scripts/pr-land.mjs'];
  const claim = () => acquireFixDispatchClaim({ repo: 'we', pr: 3103, scope, owner: 'A', lockRoot: claimRoot, nowMs: T0 });
  const sweep = (agents) => refreshLiveFixDispatchClaims({ lockRoot: claimRoot,
    listAgentsAll: () => agents, hungInfoFor: () => null, nowMs: T0 + 1000, nowIso: () => iso(T0 + 1000) });
  it('releases the overlap slot on settle while the PR remains in review', () => {
    claim();
    const waiting = [{ pr: 3033, scope }];
    expect(filterFixesByInFlightScope(waiting, [], listFixDispatchClaims(claimRoot)).planned).toEqual([]);
    sweep([{ name: 'fix-3103', state: 'done', startedAt: T0 + 1 }, { name: 'review-3103', state: 'working' }]);
    expect(readFixDispatchClaim({ repo: 'we', pr: 3103, lockRoot: claimRoot })).toBeNull();
    expect(filterFixesByInFlightScope(waiting, [], listFixDispatchClaims(claimRoot)).planned).toEqual(waiting);
  });
  it.each([
    [],
    [{ name: 'fix-3103', state: 'done', startedAt: T0 - 1 }],
    [{ name: 'fix-3103', state: 'done' }],
    [{ name: 'fix-3103', state: 'done', startedAt: T0 + 1 }, { name: 'fix-3103', state: 'working' }],
  ].map((agents) => ({ agents })))('retains the claim during lag, an old terminal row, or a live sibling (%j)', ({ agents }) => {
    claim();
    sweep(agents);
    expect(readFixDispatchClaim({ repo: 'we', pr: 3103, lockRoot: claimRoot })).not.toBeNull();
  });
  it('does not release a replacement claim from the same daemon owner', () => {
    claim();
    refreshLiveFixDispatchClaims({ lockRoot: claimRoot, nowMs: T0 + 1000, listAgentsAll: () => {
      releaseFixDispatchClaim({ repo: 'we', pr: 3103, owner: 'A', lockRoot: claimRoot });
      acquireFixDispatchClaim({ repo: 'we', pr: 3103, owner: 'A', scope, lockRoot: claimRoot, nowMs: T0 + 500 });
      return [{ name: 'fix-3103', state: 'done', startedAt: T0 + 1 }];
    } });
    expect(readFixDispatchClaim({ repo: 'we', pr: 3103, lockRoot: claimRoot }).meta.claimedAt).toBe(iso(T0 + 500));
  });
});


it('releaseSessionFixDispatchClaims releases only the claim minted for that who', () => {
  for (const [pr, kind] of [[3311, 'fix'], [3311, 'ci-heal'], [3312, 'fix']]) {
    acquireFixDispatchClaim({ repo: 'we', pr, kind, owner: 'daemon:1', lockRoot: claimRoot });
  }
  expect(releaseSessionFixDispatchClaims({ repo: 'we', pr: 3311, who: 'fix-3311', lockRoot: claimRoot }).released)
    .toEqual([{ kind: 'fix', owner: 'daemon:1' }]);
  expect(readFixDispatchClaim({ repo: 'we', pr: 3311, lockRoot: claimRoot })).toBeNull();
  for (const [pr, kind] of [[3311, 'ci-heal'], [3312, 'fix']]) {
    expect(readFixDispatchClaim({ repo: 'we', pr, kind, lockRoot: claimRoot })).not.toBeNull();
  }
});
