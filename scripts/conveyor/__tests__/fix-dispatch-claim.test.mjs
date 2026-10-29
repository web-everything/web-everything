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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES, fixDispatchClaimRoot, fixDispatchClaimOwner, fixDispatchResource,
  releaseSessionFixDispatchClaims, acquireFixDispatchClaim, releaseFixDispatchClaim, readFixDispatchClaim, fixDispatchSessionName,
  isClaimSessionLive, listFixDispatchClaims, refreshLiveFixDispatchClaims, MAX_FIX_DISPATCH_CLAIM_REFRESH_MS,
  resolveIdleClaimRelease, readPrHead, recordIdleRelease, MAX_IDLE_CLAIM_OBSERVATION_GAP_MS,
} from '../fix-dispatch-claim.mjs';
import * as dispatchIo from '../../operations/dispatch-lane-io.mjs';
import { newEnvelopeRecord } from '../../operations/completion-record.mjs';
import { writeCompletion } from '../../operations/completion-store.mjs';
import { heartbeat } from '../../readiness/file-locks.mjs';
import { acquireFixClaim } from '../fix-procedure.mjs';
import { dispatchFix, tryResumeFix, filterFixesByInFlightScope } from '../reconcile-fix-dispatch.mjs';
import { dispatchCiHeal } from '../../operations/ci-heal-pr-dispatch.mjs';
import { buildAuthorActorMarker } from '../../lib/review-independence.mjs';
import { execFileSyncThrottled } from '../../lib/gh-throttle.mjs';
import { appendDaemonEvent } from '../../lib/daemon-events.mjs';

vi.mock('../../lib/gh-throttle.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSyncThrottled: vi.fn(actual.execFileSyncThrottled) };
});
vi.mock('../../lib/daemon-events.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, appendDaemonEvent: vi.fn(actual.appendDaemonEvent) };
});

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

  it('a claim with empty claimedAt is stamped on refresh and stops refreshing past the four-hour ceiling', () => {
    const key = { repo: 'we', pr: 2784, kind: 'ci-heal', lockRoot: claimRoot };
    acquireFixDispatchClaim({ ...key, owner: 'A', nowMs: T0, nowIso: iso(T0) });
    const entry = readFixDispatchClaim(key);
    expect(heartbeat(claimRoot, fixDispatchResource(key), entry.owner, iso(T0), entry.pid,
      { ...entry.meta, claimedAt: '' })).toBe(true);
    expect(readFixDispatchClaim(key).meta.claimedAt).toBe('');
    const refresh = (at) => refreshLiveFixDispatchClaims({ lockRoot: claimRoot,
      listAgentsAll: () => [{ name: 'ci-heal-2784', state: 'working' }], hungInfoFor: () => ({ hung: false }),
      nowMs: at, nowIso: () => iso(at) });
    const stampedAt = T0 + 60_000;
    expect(refresh(stampedAt).refreshed).toHaveLength(1);
    expect(readFixDispatchClaim(key).meta.claimedAt).toBe(iso(stampedAt));
    expect(refresh(stampedAt + MAX_FIX_DISPATCH_CLAIM_REFRESH_MS).refreshed).toHaveLength(1);
    const lastRefreshed = readFixDispatchClaim(key);
    expect(lastRefreshed.meta.claimedAt).toBe(iso(stampedAt));
    expect(refresh(stampedAt + MAX_FIX_DISPATCH_CLAIM_REFRESH_MS + 1).refreshed).toHaveLength(0);
    expect(readFixDispatchClaim(key)).toEqual(lastRefreshed);
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
    grantConflictHelper: () => ({ ok: true }), // Permission migration is covered by the real-file resume regression.
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

describe('fixing claim session settlement', () => {
  it.each([
    { sessionId: 'S1', state: 'stopped', released: true, refreshed: false },
    { sessionId: 'OLD', state: 'stopped', released: false, refreshed: false },
    { sessionId: 'S1', state: 'working', released: false, refreshed: true },
  ])('$sessionId $state: released=$released, refreshed=$refreshed', ({ sessionId, state, released, refreshed }) => {
    const key = { repo: 'we', pr: 3964, kind: 'fixing', lockRoot: claimRoot };
    expect(acquireFixClaim({ ...key, who: 'fix-3964', sessionId: 'S1', nowMs: T0 }).ok).toBe(true);
    const entry = readFixDispatchClaim(key);
    expect(entry.meta.claimedAt).toBe(iso(T0));
    const result = refreshLiveFixDispatchClaims({
      lockRoot: claimRoot, nowMs: T0 + 1000, nowIso: () => iso(T0 + 1000), hungInfoFor: () => null,
      listAgentsAll: () => [{ name: entry.meta.who, sessionId, state, startedAt: T0 - 10_000 }],
    });
    const expected = { repo: 'we', pr: 3964, kind: 'fixing', owner: entry.owner };
    expect(result.released ?? []).toEqual(released ? [expected] : []);
    expect(result.refreshed).toEqual(refreshed ? [{ ...expected, headSha: null }] : []);
    if (released) expect(readFixDispatchClaim(key)).toBeNull();
    else expect(readFixDispatchClaim(key)).not.toBeNull();
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

describe('awaiting-verify claim exemption (#5137)', () => {
  const key = () => ({ repo: 'we', pr: 4115, kind: 'fixing', lockRoot: claimRoot });
  const setup = () => {
    expect(acquireFixClaim({ ...key(), who: 'fix-4115', sessionId: 'S1', nowMs: T0 }).ok).toBe(true);
    return readFixDispatchClaim(key());
  };
  const sweep = (awaitingVerifyFor, nowMs = T0 + 1000) => refreshLiveFixDispatchClaims({
    lockRoot: claimRoot, nowMs, nowIso: () => iso(nowMs), hungInfoFor: () => null, awaitingVerifyFor,
    listAgentsAll: () => [{ name: 'fix-4115', sessionId: 'S1', state: 'done', status: 'idle', startedAt: T0 - 1000 }],
  });
  it('without awaiting-verify a done fixing session releases its claim', () => {
    const entry = setup();
    expect(sweep(null).released).toEqual([{ repo: 'we', pr: 4115, kind: 'fixing', owner: entry.owner }]);
    expect(readFixDispatchClaim(key())).toBeNull();
  });
  it('awaiting-verify heartbeats a done fixing session and reports awaiting', () => {
    const entry = setup();
    const result = sweep((row, { pr }) => ({ awaiting: row.sessionId === 'S1' && pr === 4115 }));
    const expected = { repo: 'we', pr: 4115, kind: 'fixing', owner: entry.owner };
    expect(result.awaiting).toEqual([expected]);
    expect(result.refreshed).toEqual([{ ...expected, headSha: null }]);
    expect(result.released).toBeUndefined();
    expect(readFixDispatchClaim(key()).heartbeatAt).toBe(iso(T0 + 1000));
  });
  it('awaiting-verify for a different PR does not keep the claim', () => {
    setup();
    const result = sweep((row, { pr }) => ({ awaiting: pr === 4116 }));
    expect(result.awaiting).toBeUndefined();
    expect(result.released).toHaveLength(1);
    expect(readFixDispatchClaim(key())).toBeNull();
  });
  it('awaiting-verify cannot bypass the four-hour ceiling', () => {
    setup();
    const result = sweep(() => ({ awaiting: true }), T0 + MAX_FIX_DISPATCH_CLAIM_REFRESH_MS + 1);
    expect(result.refreshed).toEqual([]);
    expect(result.awaiting).toBeUndefined();
    expect(readFixDispatchClaim(key()).heartbeatAt).toBe(iso(T0));
  });
});

// 117 S3b regression 2026-10-08: an agent's own fixing claim has no runnerPid and needs the wrapped listing.
it.each([false, true])('default claim refresh keeps a live wrapped fixing claim (awaiting=%s)', (awaiting) => {
  const sid = '12345678-1234-4234-8234-123456789abc';
  const key = { repo: 'we', pr: 3964, kind: 'fixing', lockRoot: claimRoot };
  const completions = join(claimRoot, 'completions');
  vi.stubEnv('OPERATION_COMPLETIONS_DIR', completions);
  const list = vi.spyOn(dispatchIo, 'defaultListAgents').mockReturnValue([]);
  try {
    acquireFixClaim({ ...key, who: 'fix-3964', sessionId: sid, nowMs: T0 });
    const record = newEnvelopeRecord({ session: 'fix-3964', role: 'fix', launcher: 'claude-p', sessionId: sid,
      pid: process.pid, cwd: '/lane', timeoutMs: 60_000, now: () => iso(T0),
      ...(awaiting ? { awaitingVerify: { sha: 'a'.repeat(40), pr: 3964, ref: 'lane/fix', requestedAt: iso(T0) } } : {}),
    });
    writeCompletion(record, completions);
    const result = refreshLiveFixDispatchClaims({ lockRoot: claimRoot, nowMs: T0 + 1000, nowIso: () => iso(T0 + 1000), hungInfoFor: () => null, awaitingVerifyFor: () => null });
    expect(list).toHaveBeenCalledWith({ all: true });
    expect(result.refreshed).toHaveLength(1);
    expect(result.released ?? []).toEqual([]);
    expect(readFixDispatchClaim(key).heartbeatAt).toBe(iso(T0 + 1000));
  } finally {
    list.mockRestore();
    vi.unstubAllEnvs();
  }
});

// R201 (2026-10-28): PR #5996's `fix-5996` claim stayed live for hours because an IDLE background session counts as
// "live, non-terminal" and was heartbeated forever. An idle session whose PR head has not moved for the configured
// time stops being heartbeated; its claim is released and logged as an event. A working session keeps its claim.
describe('idle-claim auto-release (R201)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const IDLE_MS = 30 * 60_000;
  const acquire = (pr = 5996) => acquireFixDispatchClaim({ repo: 'we', pr, kind: 'fix', headSha: 'sha1', owner: 'A', lockRoot: claimRoot, nowMs: T0, nowIso: iso(T0), leaseMinutes: 10 });
  const sweep = (at, { state = 'idle', head = 'sha1', events = [], extra = {} } = {}) => refreshLiveFixDispatchClaims({
    lockRoot: claimRoot, listAgentsAll: () => [{ name: 'fix-5996', state }], hungInfoFor: () => null,
    awaitingVerifyFor: null, prHeadFor: () => head, recordEvent: (e) => events.push(e), nowIso: () => iso(at),
    idleRelease: resolveIdleClaimRelease({ env: {}, platform: null }), ...extra,
  });
  // Explicit intervening observations keep fixtures on the daemon's two-minute cadence.
  // Tests of observation gaps call sweep directly instead.
  const sweepThrough = (from, at, options) => {
    for (let tick = from + 120_000; tick < at; tick += 120_000) {
      expect(sweep(tick, options).released ?? []).toHaveLength(0);
    }
    return sweep(at, options);
  };

  it('readPrHead fails closed when gh throws', () => {
    execFileSyncThrottled.mockImplementationOnce(() => { throw new Error('gh unavailable'); });
    expect(readPrHead({ repo: 'we', pr: 5996 })).toBeNull();
  });

  it.each(['', 'malformed JSON', 'null', '{}', '{"headRefOid":42}', '{"headRefOid":""}', '{"headRefOid":"   "}'])('readPrHead fails closed for %s', (output) => {
    execFileSyncThrottled.mockReturnValueOnce(output);
    expect(readPrHead({ repo: 'we', pr: 5996 })).toBeNull();
  });

  it.each(['we', 'web-everything/web-everything'])('readPrHead maps %s to the gh repo slug and requests headRefOid with bounded I/O', (repo) => {
    const sha = 'a'.repeat(40);
    execFileSyncThrottled.mockClear().mockReturnValueOnce(JSON.stringify({ headRefOid: sha }));
    expect(readPrHead({ repo, pr: 5996 })).toBe(sha);
    expect(execFileSyncThrottled).toHaveBeenCalledTimes(1);
    expect(execFileSyncThrottled).toHaveBeenCalledWith('gh', [
      'pr', 'view', '5996', '--repo', 'web-everything/web-everything', '--json', 'headRefOid',
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  });

  it.each(['throws', 'rejects'])('recordIdleRelease does not throw or leave an unhandled rejection when appendDaemonEvent %s', async (failure) => {
    const event = { kind: 'idle-claim-released', repo: 'we', pr: 5996 };
    const error = new Error('event storage unavailable');
    appendDaemonEvent.mockImplementationOnce(() => {
      if (failure === 'throws') throw error;
      return Promise.reject(error);
    });
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    try {
      expect(() => recordIdleRelease(event)).not.toThrow();
      expect(appendDaemonEvent).toHaveBeenLastCalledWith(event);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandledRejection);
    }
  });

  it('resolves the idle window through the policy cascade: default 30 min from the standard layer, env overrides, both with sources', () => {
    const d = resolveIdleClaimRelease({ env: {}, platform: null });
    expect(d.enabled).toBe(true);
    expect(d.sources.enabled).toBe('standard');
    expect(d.idleMinutes).toBe(30);
    expect(d.sources.idleMinutes).toMatch(/standard/);
    const e = resolveIdleClaimRelease({ env: { WE_IDLE_CLAIM_RELEASE_MINUTES: '5' }, platform: null });
    expect(e.idleMinutes).toBe(5);
    expect(e.sources.idleMinutes).toMatch(/env/);
  });

  it.each([
    ['platform overrides standard', false, {}, false, 12, 'platform', 'platform'],
    ['environment overrides enabled', false, { WE_IDLE_CLAIM_RELEASE_ENABLED: '1' }, true, 12, 'env', 'platform'],
    ['environment overrides minutes', false, { WE_IDLE_CLAIM_RELEASE_MINUTES: '5' }, false, 5, 'platform', 'env'],
    ['environment overrides both leaves', false, { WE_IDLE_CLAIM_RELEASE_ENABLED: '1', WE_IDLE_CLAIM_RELEASE_MINUTES: '5' }, true, 5, 'env', 'env'],
    ['environment disables platform', true, { WE_IDLE_CLAIM_RELEASE_ENABLED: '0' }, false, 12, 'env', 'platform'],
  ])('platform idle-release policy: %s with provenance', (_name, platformEnabled, env, enabled, idleMinutes, enabledSource, minutesSource) => {
    const platform = { fixLoop: { idleClaimRelease: { enabled: platformEnabled, idleMinutes: 12 } } };
    expect(resolveIdleClaimRelease({ env, platform })).toEqual({
      enabled, idleMinutes, sources: { enabled: enabledSource, idleMinutes: minutesSource }, invalid: [],
    });
  });

  it('reports invalid platform and environment values while retaining valid lower layers', () => {
    const platform = { fixLoop: { idleClaimRelease: { enabled: 'yes', idleMinutes: 12 } } };
    const policy = resolveIdleClaimRelease({ env: { WE_IDLE_CLAIM_RELEASE_MINUTES: '0' }, platform });
    expect(policy).toEqual({ enabled: true, idleMinutes: 12,
      sources: { enabled: 'standard', idleMinutes: 'platform' },
      invalid: ['platform.enabled="yes"', 'env.idleMinutes=0'] });
  });

  it.each(['abc', '0'])('malformed WE_IDLE_CLAIM_RELEASE_MINUTES=%s falls back to the 30 min standard', (value) => {
    const idleRelease = resolveIdleClaimRelease({ env: { WE_IDLE_CLAIM_RELEASE_MINUTES: value }, platform: null });
    expect(idleRelease.idleMinutes).toBe(30);
    expect(idleRelease.sources.idleMinutes).toMatch(/standard/);
    expect(idleRelease.invalid).toHaveLength(1);
    acquire();
    sweep(T0 + 60_000, { extra: { idleRelease } });
    const inside = sweepThrough(T0 + 60_000, T0 + 60_000 + IDLE_MS - 1, { extra: { idleRelease } });
    expect(inside.released ?? []).toHaveLength(0);
    expect(inside.refreshed).toHaveLength(1);
    const expired = sweep(T0 + 60_000 + IDLE_MS, { extra: { idleRelease } });
    expect(expired.released).toHaveLength(1);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot })).toBeNull();
  });

  it('an idle session awaiting verification is never idle-released, clears its idle clock, and never probes the PR head', () => {
    acquire();
    sweep(T0 + 60_000);
    const prHeadFor = vi.fn(() => 'sha1');
    const awaitingVerifyFor = vi.fn(() => ({ awaiting: true }));
    const extra = { awaitingVerifyFor, prHeadFor };
    const result = sweepThrough(T0 + 60_000, T0 + 60_000 + 2 * IDLE_MS, { extra });
    expect(result.released ?? []).toHaveLength(0);
    expect(result.refreshed).toHaveLength(1);
    expect(result.awaiting).toEqual([{ repo: 'we', pr: 5996, kind: 'fix', owner: 'A' }]);
    const current = readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot });
    expect(current?.owner).toBe('A');
    expect(current.meta).not.toHaveProperty('idleHead');
    expect(awaitingVerifyFor).toHaveBeenCalled();
    expect(prHeadFor).not.toHaveBeenCalled();
  });

  it('a claim with a live meta.runnerPid is never idle-released and clears its idle clock', () => {
    acquire();
    sweep(T0 + 60_000);
    const key = { repo: 'we', pr: 5996, lockRoot: claimRoot };
    const current = readFixDispatchClaim(key);
    expect(heartbeat(claimRoot, fixDispatchResource(key), current.owner, iso(T0 + 60_000), current.pid,
      { ...current.meta, runnerPid: 12345, runnerStart: 'runner-start', runnerArgv: 'runner-argv' })).toBe(true);
    const alive = vi.fn(() => true);
    const identity = vi.fn(() => ({ alive: true }));
    const prHeadFor = vi.fn(() => 'sha1');
    const result = sweepThrough(T0 + 60_000, T0 + 60_000 + 2 * IDLE_MS, { extra: { alive, identity, prHeadFor } });
    expect(result.released ?? []).toHaveLength(0);
    expect(result.refreshed).toHaveLength(1);
    const refreshed = readFixDispatchClaim(key);
    expect(refreshed?.owner).toBe('A');
    expect(refreshed.meta.runnerPid).toBe(12345);
    expect(refreshed.meta).not.toHaveProperty('idleHead');
    expect(alive).toHaveBeenCalledWith(12345);
    expect(identity).toHaveBeenCalledWith(12345, { expectStart: 'runner-start', expectArgv: 'runner-argv' });
    expect(prHeadFor).not.toHaveBeenCalled();
  });

  it.each(['working', 'disabled'])('%s clears a stale idle clock and resuming idle release requires a fresh window', (mode) => {
    acquire();
    sweep(T0 + 60_000);
    const prHeadFor = vi.fn(() => 'sha1');
    const idleRelease = resolveIdleClaimRelease({ env: { WE_IDLE_CLAIM_RELEASE_ENABLED: '0' }, platform: null });
    const result = sweep(T0 + 10 * 60_000, mode === 'working'
      ? { state: 'working', extra: { prHeadFor } } : { extra: { idleRelease, prHeadFor } });
    expect(result.released ?? []).toHaveLength(0);
    expect(result.refreshed).toHaveLength(1);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot }).meta).not.toHaveProperty('idleHead');
    expect(prHeadFor).not.toHaveBeenCalled();
    const resumedAt = T0 + 20 * 60_000;
    sweep(resumedAt);
    const originalWindow = sweepThrough(resumedAt, T0 + 60_000 + IDLE_MS);
    expect(originalWindow.released ?? []).toHaveLength(0);
    expect(originalWindow.refreshed).toHaveLength(1);
    expect(sweepThrough(T0 + 60_000 + IDLE_MS, resumedAt + IDLE_MS).released).toHaveLength(1);
  });

  it('an unreadable head clears the idle clock so readable X again requires a full new window', () => {
    acquire();
    sweep(T0 + 60_000, { head: 'sha1' });
    const unreadable = sweep(T0 + 10 * 60_000, { head: null });
    expect(unreadable.released ?? []).toHaveLength(0);
    expect(unreadable.refreshed).toHaveLength(1);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot }).meta).not.toHaveProperty('idleHead');
    const readableAt = T0 + 20 * 60_000;
    sweep(readableAt, { head: 'sha1' });
    const originalWindow = sweepThrough(readableAt, T0 + 60_000 + IDLE_MS);
    expect(originalWindow.released ?? []).toHaveLength(0);
    expect(originalWindow.refreshed).toHaveLength(1);
    const insideFreshWindow = sweepThrough(T0 + 60_000 + IDLE_MS, readableAt + IDLE_MS - 1);
    expect(insideFreshWindow.released ?? []).toHaveLength(0);
    expect(insideFreshWindow.refreshed).toHaveLength(1);
    const expired = sweep(readableAt + IDLE_MS);
    expect(expired.released).toHaveLength(1);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot })).toBeNull();
  });

  it('recordEvent throwing does not stop a release or the sweep of subsequent claims', () => {
    acquire(5996);
    acquire(5997);
    const recordEvent = vi.fn(() => { throw new Error('event storage unavailable'); });
    const extra = { recordEvent, listAgentsAll: () => [5996, 5997].map((pr) => ({ name: `fix-${pr}`, state: 'idle' })) };
    expect(sweep(T0 + 60_000, { extra }).refreshed).toHaveLength(2);
    const result = sweepThrough(T0 + 60_000, T0 + 60_000 + IDLE_MS, { extra });
    expect(result.checked).toBe(2);
    expect(result.released).toHaveLength(2);
    expect(result.released.map(({ pr }) => pr).sort()).toEqual([5996, 5997]);
    expect(result.refreshed).toHaveLength(0);
    expect(recordEvent).toHaveBeenCalledTimes(2);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot })).toBeNull();
    expect(readFixDispatchClaim({ repo: 'we', pr: 5997, lockRoot: claimRoot })).toBeNull();
  });

  it('recordEvent returning a rejected promise processes subsequent claims without an unhandled rejection', async () => {
    acquire(5996);
    acquire(5997);
    const recordEvent = vi.fn(() => Promise.reject(new Error('event storage unavailable')));
    const extra = { recordEvent, listAgentsAll: () => [5996, 5997].map((pr) => ({ name: `fix-${pr}`, state: 'idle' })) };
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    try {
      expect(sweep(T0 + 60_000, { extra }).refreshed).toHaveLength(2);
      const result = sweepThrough(T0 + 60_000, T0 + 60_000 + IDLE_MS, { extra });
      expect(result.checked).toBe(2);
      expect(result.released).toHaveLength(2);
      expect(result.released.map(({ pr }) => pr).sort()).toEqual([5996, 5997]);
      expect(result.refreshed).toHaveLength(0);
      expect(recordEvent).toHaveBeenCalledTimes(2);
      expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot })).toBeNull();
      expect(readFixDispatchClaim({ repo: 'we', pr: 5997, lockRoot: claimRoot })).toBeNull();
      // Cross an event-loop turn so an unhandled rejection would have been emitted.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandledRejection);
    }
  });

  it('an idle session with an unmoved PR head past the window loses its claim, which is released and logged as an event', () => {
    acquire();
    const events = [];
    sweep(T0 + 60_000, { events }); // first idle observation starts the clock, still heartbeated
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, kind: 'fix', lockRoot: claimRoot })?.owner).toBe('A');
    const result = sweepThrough(T0 + 60_000, T0 + 60_000 + IDLE_MS, { events });
    expect(result.released).toHaveLength(1);
    expect(result.released[0]).toMatchObject({ repo: 'we', pr: 5996, kind: 'fix', owner: 'A' });
    expect(result.refreshed).toHaveLength(0);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, kind: 'fix', lockRoot: claimRoot })).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'idle-claim-released', pr: 5996 });
    expect(events[0].detail).toMatchObject({ idleMinutes: 30, headSha: 'sha1' });
    expect(events[0].detail.sources).toBeTruthy();
  });

  it('an idle session inside the window keeps its claim', () => {
    acquire();
    sweep(T0 + 60_000);
    const result = sweepThrough(T0 + 60_000, T0 + 60_000 + IDLE_MS - 1_000);
    expect(result.released ?? []).toHaveLength(0);
    expect(result.refreshed).toHaveLength(1);
  });

  it('the default PR-head and event adapters append one daemon JSONL event with policy provenance', async () => {
    acquire();
    vi.stubEnv('WE_DAEMON_EVENTS', join(claimRoot, 'events', 'daemon-events.jsonl'));
    const sha = 'a'.repeat(40);
    execFileSyncThrottled.mockReturnValueOnce(JSON.stringify({ headRefOid: sha }))
      .mockReturnValueOnce(JSON.stringify({ headRefOid: sha }));
    appendDaemonEvent.mockClear();
    const idleRelease = resolveIdleClaimRelease({ env: { WE_IDLE_CLAIM_RELEASE_MINUTES: '5' }, platform: null });
    const extra = { prHeadFor: undefined, recordEvent: undefined, idleRelease };
    sweep(T0 + 60_000, { extra });
    expect(sweep(T0 + 6 * 60_000, { extra }).released).toHaveLength(1);
    expect(appendDaemonEvent).toHaveBeenCalledTimes(1);
    expect(appendDaemonEvent).toHaveBeenCalledWith({
      kind: 'idle-claim-released', repo: 'we', pr: 5996, daemon: 'reconcile-fix-dispatch',
      detail: { kind: 'fix', idleMinutes: 5, sources: idleRelease.sources,
        headSha: sha, idleSince: iso(T0 + 60_000), owner: 'A' },
    });
    expect(await appendDaemonEvent.mock.results[0].value).toBe(true);
    const lines = readFileSync(process.env.WE_DAEMON_EVENTS, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      at: expect.any(String),
      kind: 'idle-claim-released', repo: 'we', pr: 5996, daemon: 'reconcile-fix-dispatch',
      detail: { kind: 'fix', idleMinutes: 5, sources: idleRelease.sources,
        headSha: sha, idleSince: iso(T0 + 60_000), owner: 'A' },
    });
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot })).toBeNull();
  });

  it.each([MAX_IDLE_CLAIM_OBSERVATION_GAP_MS + 1, 2 * IDLE_MS])('an unobserved gap of %d ms restarts the clock without releasing', (gap) => {
    acquire();
    const first = T0 + 60_000;
    const next = first + gap;
    const events = [];
    sweep(first, { events });
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot }).meta.idleHead)
      .toEqual({ sha: 'sha1', since: iso(first), lastSeen: iso(first) });
    const result = sweep(next, { events });
    expect(result.released ?? []).toHaveLength(0);
    expect(result.refreshed).toHaveLength(1);
    const retained = readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot });
    expect(retained.owner).toBe('A');
    expect(retained.meta.idleHead).toEqual({ sha: 'sha1', since: iso(next), lastSeen: iso(next) });
    expect(events).toHaveLength(0);
    expect(sweepThrough(next, next + IDLE_MS, { events }).released).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].detail.idleSince).toBe(iso(next));
  });

  it('updates lastSeen on every idle observation and accepts gaps of exactly three sweep intervals', () => {
    acquire();
    const first = T0 + 60_000;
    const gap = MAX_IDLE_CLAIM_OBSERVATION_GAP_MS;
    const idleRelease = resolveIdleClaimRelease({ env: { WE_IDLE_CLAIM_RELEASE_MINUTES: String(2 * gap / 60_000) }, platform: null });
    const extra = { idleRelease };
    sweep(first, { extra });
    expect(sweep(first + gap, { extra }).refreshed).toHaveLength(1);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot }).meta.idleHead)
      .toEqual({ sha: 'sha1', since: iso(first), lastSeen: iso(first + gap) });
    expect(sweep(first + 2 * gap, { extra }).released).toHaveLength(1);
  });

  it.each([
    ['legacy missing lastSeen', undefined], ['malformed lastSeen', 'not-a-date'],
    ['lastSeen before since', iso(T0)], ['lastSeen in the future', iso(T0 + 3 * IDLE_MS)],
  ])('fails closed for %s by starting a fresh idle window', (_name, lastSeen) => {
    acquire();
    const key = { repo: 'we', pr: 5996, lockRoot: claimRoot };
    const current = readFixDispatchClaim(key);
    const first = T0 + 60_000;
    const idleHead = { sha: 'sha1', since: iso(first), ...(lastSeen === undefined ? {} : { lastSeen }) };
    expect(heartbeat(claimRoot, fixDispatchResource(key), current.owner, iso(first), current.pid,
      { ...current.meta, idleHead })).toBe(true);
    const next = first + 2 * IDLE_MS;
    const events = [];
    const result = sweep(next, { events });
    expect(result.released ?? []).toHaveLength(0);
    expect(result.refreshed).toHaveLength(1);
    expect(events).toHaveLength(0);
    expect(readFixDispatchClaim(key).meta.idleHead).toEqual({ sha: 'sha1', since: iso(next), lastSeen: iso(next) });
  });

  it.each([
    ['mixed idle and working rows retain the claim and clear the idle clock', ['idle', 'working'], false],
    ['all idle rows release the claim', ['idle', 'idle'], true],
    ['idle and done rows release the claim', ['idle', 'done'], true],
    ['idle and stopped rows release the claim', ['idle', 'stopped'], true],
    ['idle and failed rows release the claim', ['idle', 'failed'], true],
  ])('%s beyond the idle window', (_name, states, shouldRelease) => {
    acquire();
    const first = T0 + 60_000;
    const at = first + IDLE_MS + 1;
    sweep(first);
    sweepThrough(first, first + IDLE_MS - 1);
    const prHeadFor = vi.fn(() => 'sha1');
    const events = [];
    const result = sweep(at, { events, extra: { prHeadFor,
      listAgentsAll: () => states.map((state) => ({ name: 'fix-5996', state })),
    } });
    if (shouldRelease) {
      expect(result.released).toHaveLength(1);
      expect(result.refreshed).toHaveLength(0);
      expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot })).toBeNull();
      expect(prHeadFor).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
      return;
    }
    expect(result.released ?? []).toHaveLength(0);
    expect(result.refreshed).toHaveLength(1);
    const retained = readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot });
    expect(retained.owner).toBe('A');
    expect(retained.meta).not.toHaveProperty('idleHead');
    expect(prHeadFor).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('an owner replacement during the idle head probe leaves the new claim untouched and records no release', () => {
    acquire();
    const first = T0 + 60_000;
    const at = first + IDLE_MS;
    sweep(first);
    sweepThrough(first, at - 1);
    const key = { repo: 'we', pr: 5996, lockRoot: claimRoot };
    let replacement;
    const prHeadFor = vi.fn(() => {
      expect(releaseFixDispatchClaim({ ...key, owner: 'A' }).released).toBe(true);
      expect(acquireFixDispatchClaim({ ...key, owner: 'B', headSha: 'sha2', nowMs: at, nowIso: iso(at) }).ok).toBe(true);
      replacement = readFixDispatchClaim(key);
      return 'sha1';
    });
    const recordEvent = vi.fn();
    let result;
    expect(() => { result = sweep(at, { extra: { prHeadFor, recordEvent } }); }).not.toThrow();
    expect(prHeadFor).toHaveBeenCalledOnce();
    expect(result.released ?? []).toHaveLength(0);
    expect(result.refreshed).toHaveLength(0);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(replacement.owner).toBe('B');
    expect(readFixDispatchClaim(key)).toEqual(replacement);
  });

  it('a session that is working keeps its claim however long the head is unmoved', () => {
    acquire();
    const events = [];
    for (let at = 0; at <= 3 * IDLE_MS; at += 120_000) {
      const r = sweep(T0 + at, { state: 'working', events });
      expect(r.released ?? []).toHaveLength(0);
      expect(r.refreshed).toHaveLength(1);
    }
    expect(events).toHaveLength(0);
  });

  it('a session that goes back to work restarts the idle clock', () => {
    acquire();
    sweep(T0 + 60_000);
    sweepThrough(T0 + 60_000, T0 + 10 * 60_000 - 1);
    sweep(T0 + 10 * 60_000, { state: 'working' });
    sweep(T0 + 11 * 60_000);
    const r = sweepThrough(T0 + 11 * 60_000, T0 + 60_000 + IDLE_MS);
    expect(r.released ?? []).toHaveLength(0);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot }).meta.idleHead.since).toBe(iso(T0 + 11 * 60_000));
  });

  it('a PR head that moves restarts the idle clock', () => {
    acquire();
    sweep(T0 + 60_000);
    sweepThrough(T0 + 60_000, T0 + 20 * 60_000 - 1);
    sweep(T0 + 20 * 60_000, { head: 'sha2' });
    const r = sweepThrough(T0 + 20 * 60_000, T0 + 60_000 + IDLE_MS, { head: 'sha2' });
    expect(r.released ?? []).toHaveLength(0);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, lockRoot: claimRoot }).meta.idleHead.since).toBe(iso(T0 + 20 * 60_000));
  });

  it('fails closed: an unreadable PR head never releases', () => {
    acquire();
    sweep(T0 + 60_000, { head: null });
    const r = sweepThrough(T0 + 60_000, T0 + 60_000 + 2 * IDLE_MS, { head: null });
    expect(r.released ?? []).toHaveLength(0);
    expect(readFixDispatchClaim({ repo: 'we', pr: 5996, kind: 'fix', lockRoot: claimRoot })?.owner).toBe('A');
  });

  it('a prHeadFor that throws never releases and never crashes the sweep', () => {
    acquire();
    const boom = () => { throw new Error('gh down'); };
    sweep(T0 + 60_000, { extra: { prHeadFor: boom } });
    const r = sweepThrough(T0 + 60_000, T0 + 60_000 + 2 * IDLE_MS, { extra: { prHeadFor: boom } });
    expect(r.released ?? []).toHaveLength(0);
  });

  it('can be disabled by the policy: enabled=false keeps heartbeating an idle session', () => {
    acquire();
    const idleRelease = resolveIdleClaimRelease({ env: { WE_IDLE_CLAIM_RELEASE_ENABLED: '0' }, platform: null });
    sweep(T0 + 60_000, { extra: { idleRelease } });
    const r = sweepThrough(T0 + 60_000, T0 + 60_000 + 2 * IDLE_MS, { extra: { idleRelease } });
    expect(r.released ?? []).toHaveLength(0);
  });

  it('honours a configured shorter window', () => {
    acquire();
    const idleRelease = resolveIdleClaimRelease({ env: { WE_IDLE_CLAIM_RELEASE_MINUTES: '5' }, platform: null });
    sweep(T0 + 60_000, { extra: { idleRelease } });
    const r = sweep(T0 + 60_000 + 5 * 60_000, { extra: { idleRelease } });
    expect(r.released).toHaveLength(1);
  });
});
