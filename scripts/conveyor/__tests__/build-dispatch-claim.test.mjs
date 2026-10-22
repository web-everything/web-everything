/**
 * @file build-dispatch-claim.test.mjs — #4349's HOLD half only (the claim primitive itself is already
 * exercised end-to-end by `skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`'s claim/retirement
 * coverage; this file is deliberately small — one responsibility, per the small-file-preference statute).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  placeBuildDispatchHold, releaseBuildDispatchHold, listBuildDispatchHolds,
  DEFAULT_BUILD_DISPATCH_HOLD_MINUTES,
  markBuildDispatchResume, readBuildDispatchResume, releaseBuildDispatchResume,
  acquireBuildDispatchClaim, listBuildDispatchClaims,
} from '../build-dispatch-claim.mjs';

// #4131 build-orphan-adopt (live 2026-09-29) — a claim aged out of the ORDINARY read while the daemon was
// down for hours on an unrelated bug, invisible to both retirement and adoption. `ignoreExpiry: true` is the
// ONE reader that needs to see past the TTL filter (`build-dispatch-orphan-adopt.mjs`'s own adoption pass).
describe('listBuildDispatchClaims — ignoreExpiry (#4131 build-orphan-adopt)', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-claims-expiry-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('the ORDINARY read (default) skips an expired claim, exactly as before this option existed', () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, leaseMinutes: 240 });
    const past = Date.now() + 300 * 60_000;
    expect(listBuildDispatchClaims({ lockRoot, nowMs: past })).toEqual([]);
  });

  it('`ignoreExpiry: true` still returns it, past its TTL', () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, leaseMinutes: 240 });
    const past = Date.now() + 300 * 60_000;
    const claims = listBuildDispatchClaims({ lockRoot, nowMs: past, ignoreExpiry: true });
    expect(claims.map((c) => c.meta.num)).toEqual(['4131']);
  });

  it('a genuinely LIVE (unexpired) claim is unaffected by the flag either way', () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot });
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num)).toEqual(['4131']);
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }).map((c) => c.meta.num)).toEqual(['4131']);
  });
});

describe('build-dispatch hold (#4349 — stops the not-ready re-dispatch loop)', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-hold-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('places a hold with its reason, visible via listBuildDispatchHolds', () => {
    placeBuildDispatchHold({ num: '4200', reason: 'not-ready (blockedBy 1 re-opened)', lockRoot });
    const holds = listBuildDispatchHolds({ lockRoot });
    expect(holds).toEqual([expect.objectContaining({ meta: expect.objectContaining({ num: '4200', reason: 'not-ready (blockedBy 1 re-opened)', kind: 'hold' }) })]);
  });

  it('never collides with a real claim — `listBuildDispatchClaims`-shaped readers must not see a hold and '
    + 'vice versa (separate root + distinct `kind`)', async () => {
    const { acquireBuildDispatchClaim, listBuildDispatchClaims } = await import('../build-dispatch-claim.mjs');
    const claimRoot = mkdtempSync(join(tmpdir(), 'bdd-hold-claimroot-'));
    try {
      acquireBuildDispatchClaim({ num: '4200', scope: [], lockRoot: claimRoot });
      placeBuildDispatchHold({ num: '4200', reason: 'not-ready', lockRoot });
      expect(listBuildDispatchClaims({ lockRoot: claimRoot }).map((c) => c.meta.num)).toEqual(['4200']);
      expect(listBuildDispatchHolds({ lockRoot }).map((h) => h.meta.num)).toEqual(['4200']);
      // a claim-listing read against the HOLD root (kind mismatch) sees nothing, and vice versa.
      expect(listBuildDispatchClaims({ lockRoot })).toEqual([]);
    } finally {
      rmSync(claimRoot, { recursive: true, force: true });
    }
  });

  it('refreshes (never refuses) a second hold placed on the same item — a cooldown, not a mutex', () => {
    placeBuildDispatchHold({ num: '4200', reason: 'first reason', lockRoot });
    placeBuildDispatchHold({ num: '4200', reason: 'second reason', lockRoot });
    const holds = listBuildDispatchHolds({ lockRoot });
    expect(holds).toHaveLength(1);
    expect(holds[0].meta.reason).toBe('second reason');
  });

  it('self-expires after its TTL — an operator does not have to clear it by hand', () => {
    placeBuildDispatchHold({ num: '4200', reason: 'x', lockRoot, holdMinutes: 10 });
    const past = Date.now() + 11 * 60_000;
    expect(listBuildDispatchHolds({ lockRoot, nowMs: past, holdMinutes: 10 })).toEqual([]);
  });

  it('releaseBuildDispatchHold clears it early — an operator\'s call once the reason is actually fixed', () => {
    placeBuildDispatchHold({ num: '4200', reason: 'x', lockRoot });
    expect(releaseBuildDispatchHold({ num: '4200', lockRoot })).toEqual({ released: true });
    expect(listBuildDispatchHolds({ lockRoot })).toEqual([]);
    expect(releaseBuildDispatchHold({ num: '4200', lockRoot })).toEqual({ released: false, reason: 'absent' });
  });

  it('DEFAULT_BUILD_DISPATCH_HOLD_MINUTES is a real, positive, hours-scale TTL', () => {
    expect(DEFAULT_BUILD_DISPATCH_HOLD_MINUTES).toBeGreaterThan(0);
    expect(DEFAULT_BUILD_DISPATCH_HOLD_MINUTES).toBeGreaterThanOrEqual(60);
  });
});

describe('build-dispatch resume marker (#4131/#4382 build-orphan-adopt)', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-resume-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('records the resume attempt\'s own pid, readable back for a later liveness check', () => {
    markBuildDispatchResume({ num: '4131', pid: 12345, lockRoot });
    const marker = readBuildDispatchResume({ num: '4131', lockRoot });
    expect(marker).toMatchObject({ pid: 12345, meta: expect.objectContaining({ num: '4131', kind: 'resume', pid: 12345 }) });
  });

  it('PR #2921 review — records the row it is bound to, its attempt count, and a PENDING (pid-less) shape '
    + 'written before the spawn', () => {
    markBuildDispatchResume({ num: '4131', pid: null, runId: 'dispatch-lane-a', rowKey: 'step:1:0', attempts: 2, lockRoot });
    expect(readBuildDispatchResume({ num: '4131', lockRoot }).meta).toMatchObject({
      pid: null, runId: 'dispatch-lane-a', rowKey: 'step:1:0', attempts: 2,
    });
  });

  it('refreshes (never refuses) a second resume marker for the same item — a re-adoption after the first '
    + 'resume itself died, not a mutex', () => {
    markBuildDispatchResume({ num: '4131', pid: 111, lockRoot });
    markBuildDispatchResume({ num: '4131', pid: 222, lockRoot });
    expect(readBuildDispatchResume({ num: '4131', lockRoot }).pid).toBe(222);
  });

  it('self-expires after its TTL, and releaseBuildDispatchResume clears it early', () => {
    markBuildDispatchResume({ num: '4131', pid: 1, lockRoot, ttlMinutes: 10 });
    const past = Date.now() + 11 * 60_000;
    expect(readBuildDispatchResume({ num: '4131', lockRoot, nowMs: past, ttlMinutes: 10 })).toBeNull();

    markBuildDispatchResume({ num: '4131', pid: 1, lockRoot });
    expect(releaseBuildDispatchResume({ num: '4131', lockRoot })).toEqual({ released: true });
    expect(readBuildDispatchResume({ num: '4131', lockRoot })).toBeNull();
  });

  it('never collides with a real claim or a hold — separate root + distinct `kind`', async () => {
    const { acquireBuildDispatchClaim, listBuildDispatchClaims } = await import('../build-dispatch-claim.mjs');
    const claimRoot = mkdtempSync(join(tmpdir(), 'bdd-resume-claimroot-'));
    try {
      acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot: claimRoot });
      markBuildDispatchResume({ num: '4131', pid: 1, lockRoot });
      expect(listBuildDispatchClaims({ lockRoot: claimRoot }).map((c) => c.meta.num)).toEqual(['4131']);
      expect(readBuildDispatchResume({ num: '4131', lockRoot })).not.toBeNull();
      expect(listBuildDispatchClaims({ lockRoot })).toEqual([]);
    } finally {
      rmSync(claimRoot, { recursive: true, force: true });
    }
  });
});

it('annotates a claim atomically, preserving its metadata; absent claims are a no-op', async () => {
  const { annotateBuildDispatchClaim } = await import('../build-dispatch-claim.mjs');
  const root = mkdtempSync(join(tmpdir(), 'claim-slot-'));
  try {
    expect(annotateBuildDispatchClaim({ num: '123', slotId: 'abc', lockRoot: root })).toBe(false);
    acquireBuildDispatchClaim({ num: '123', scope: ['we:a'], lockRoot: root });
    const before = listBuildDispatchClaims({ lockRoot: root })[0];
    expect(annotateBuildDispatchClaim({ num: '123', slotId: 'abc', lockRoot: root })).toBe(true);
    expect(listBuildDispatchClaims({ lockRoot: root })[0]).toEqual({ ...before, meta: { ...before.meta, slotId: 'abc' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
