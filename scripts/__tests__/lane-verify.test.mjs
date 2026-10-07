/**
 * @file scripts/__tests__/lane-verify.test.mjs
 * @description Unit proof of the #2833 verification finish-guard core (`scripts/lib/lane-verify.mjs`). The
 *   observed stall: a build subagent backgrounded its suite run, then yielded/terminated mid-run — the lane sat
 *   half-verified but LOOKED complete, so nothing reclaimed it. The gate here makes an unfinished verification
 *   NOT look complete: a HEAD with no recorded green result (or a stranded `running` marker) is REFUSED; a HEAD
 *   whose synchronous run finished green PASSES. The suite runner + marker IO are the impure boundary
 *   (`scripts/verify-lane.mjs`) and pr-land's finish-guard calls `verifyGateDecision` here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  verifyServerVerdict,
  VERIFY_FILENAME,
  DEFAULT_VERIFY_TTL_MINUTES,
  verifyStartBody,
  verifyFinishBody,
  isVerifyAbandoned,
  verifyGateDecision,
  normalizeVerifyRecord,
  resolveVerifyOptions,
  keepMarkerAfterReset,
  waitForVerifySettle,
  resolveWaitCeilingMs,
  MAX_SAFE_WAIT_MS,
} from '../lib/lane-verify.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const T0 = Date.parse('2026-08-02T00:00:00.000Z');
const min = (n) => n * 60_000;

describe('marker lifecycle bodies (running → green/red)', () => {
  it('verifyStartBody stamps a running marker keyed to the sha, finish fields null', () => {
    const r = verifyStartBody({ sha: SHA, suites: 'npm run test:unit', startedAt: '2026-08-02T00:00:00.000Z' });
    expect(r).toMatchObject({ sha: SHA, status: 'running', startedAt: '2026-08-02T00:00:00.000Z', finishedAt: null, suites: 'npm run test:unit', exitCode: null });
  });
  it('verifyFinishBody(exit 0) → green, preserving sha/startedAt/suites', () => {
    const start = verifyStartBody({ sha: SHA, suites: 'gate', startedAt: '2026-08-02T00:00:00.000Z' });
    const done = verifyFinishBody(start, { finishedAt: '2026-08-02T00:05:00.000Z', exitCode: 0 });
    expect(done).toMatchObject({ sha: SHA, status: 'green', startedAt: '2026-08-02T00:00:00.000Z', finishedAt: '2026-08-02T00:05:00.000Z', suites: 'gate', exitCode: 0 });
  });
  it('verifyFinishBody(non-zero) → red, recording the exit code', () => {
    const done = verifyFinishBody(verifyStartBody({ sha: SHA, suites: 'gate', startedAt: 't' }), { finishedAt: 'u', exitCode: 2 });
    expect(done.status).toBe('red');
    expect(done.exitCode).toBe(2);
  });
});

describe('isVerifyAbandoned — a running marker that outlived its TTL is abandoned', () => {
  const running = verifyStartBody({ sha: SHA, suites: 'gate', startedAt: new Date(T0).toISOString() });
  it('a fresh running marker is NOT (yet) abandoned', () => {
    expect(isVerifyAbandoned(running, T0 + min(5))).toBe(false);
  });
  it('a running marker past the TTL IS abandoned', () => {
    expect(isVerifyAbandoned(running, T0 + min(DEFAULT_VERIFY_TTL_MINUTES + 1))).toBe(true);
  });
  it('a green/red marker never abandons by time (sha-identity is its freshness, not the clock)', () => {
    const green = verifyFinishBody(running, { finishedAt: new Date(T0).toISOString(), exitCode: 0 });
    expect(isVerifyAbandoned(green, T0 + min(9999))).toBe(false);
  });
  it('a malformed / dateless running marker reads as abandoned (fail toward "not fresh")', () => {
    expect(isVerifyAbandoned({ status: 'running', startedAt: 'not-a-date' }, T0)).toBe(true);
    expect(isVerifyAbandoned(null, T0)).toBe(true);
  });
});

describe('verifyGateDecision — the finish-guard the delivery path applies (#2833)', () => {
  const green = verifyFinishBody(verifyStartBody({ sha: SHA, suites: 'gate', startedAt: new Date(T0).toISOString() }), { finishedAt: new Date(T0).toISOString(), exitCode: 0 });
  const running = verifyStartBody({ sha: SHA, suites: 'gate', startedAt: new Date(T0).toISOString() });
  const red = verifyFinishBody(running, { finishedAt: new Date(T0).toISOString(), exitCode: 2 });

  it('a completed green run for THIS head → ok (delivery proceeds)', () => {
    const v = verifyGateDecision({ record: green, headSha: SHA, nowMs: T0 + min(10) });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('verified');
  });

  it('THE STALL: a running (unfinished) marker for THIS head → REFUSED, even without --require-verified', () => {
    const v = verifyGateDecision({ record: running, headSha: SHA, nowMs: T0 + min(1), requireVerified: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('verify-unfinished');
    expect(v.detail).toMatch(/in-flight/);
  });

  it('an ABANDONED running marker (past TTL) under --require-verified → still refused (fail-closed), says abandoned', () => {
    const v = verifyGateDecision({ record: running, headSha: SHA, nowMs: T0 + min(DEFAULT_VERIFY_TTL_MINUTES + 5), requireVerified: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('verify-unfinished');
    expect(v.detail).toMatch(/abandoned/);
  });

  // #2833 finding 1 — the TTL must actually GATE, not just re-word: a stranded (past-TTL) running marker must not
  // wedge the CI-gated drain forever. THE PIN: running × past-TTL × requireVerified:false → ok (untracked).
  it('finding 1: a PAST-TTL running marker + requireVerified:false → ok (untracked) — cannot wedge the CI-gated drain', () => {
    const v = verifyGateDecision({ record: running, headSha: SHA, nowMs: T0 + min(DEFAULT_VERIFY_TTL_MINUTES + 5), requireVerified: false });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('untracked');
  });
  it('finding 1: a FRESH (in-flight) running marker + requireVerified:false → STILL refused (the exact live stall)', () => {
    const v = verifyGateDecision({ record: running, headSha: SHA, nowMs: T0 + min(1), requireVerified: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('verify-unfinished');
    expect(v.detail).toMatch(/in-flight/);
  });

  it('a recorded RED result for THIS head under --require-verified → refused (fix + re-verify)', () => {
    // #2833 finding 2: red is refused only when a local green was DEMANDED. Without --require-verified the
    // required CI check gates the merge, so a red marker does not block (asserted in the decision-table block).
    const v = verifyGateDecision({ record: red, headSha: SHA, nowMs: T0, requireVerified: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('verify-red');
  });

  it('NO marker + --require-verified → refused as unverified (the solo/conveyor build gate)', () => {
    const v = verifyGateDecision({ record: null, headSha: SHA, requireVerified: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unverified');
  });

  it('NO marker under the EXPLICIT opt-out (requireVerified:false) → ok (a caller that verifies elsewhere)', () => {
    const v = verifyGateDecision({ record: null, headSha: SHA, requireVerified: false });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('untracked');
  });

  it('a green marker for a DIFFERENT commit does NOT satisfy the gate for this HEAD (stale sha)', () => {
    const stale = { ...green, sha: OTHER };
    expect(verifyGateDecision({ record: stale, headSha: SHA, requireVerified: true }).ok).toBe(false);
    // ...and without require-verified it reads as untracked-for-this-head (allow), not a false green
    const v = verifyGateDecision({ record: stale, headSha: SHA, requireVerified: false });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('untracked');
  });

  it('WE_LAND_UNVERIFIED break-glass overrides every refusal (even an unfinished run)', () => {
    const v = verifyGateDecision({ record: running, headSha: SHA, nowMs: T0, breakGlass: true });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('break-glass');
  });
});

describe('verifyGateDecision — #4296 keys the marker to what changed, not the exact commit', () => {
  const green = verifyFinishBody(verifyStartBody({ sha: SHA, suites: 'gate', startedAt: new Date(T0).toISOString() }), { finishedAt: new Date(T0).toISOString(), exitCode: 0 });
  const staleGreen = { ...green, sha: OTHER }; // recorded for OTHER, headSha will be SHA

  it('RED (the bug, without the new param): a marker for a different sha refuses even though nothing relevant changed — this is EXACTLY today\'s pre-#4296 behavior, still the default when the caller never computes the overlap', () => {
    const v = verifyGateDecision({ record: staleGreen, headSha: SHA, requireVerified: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unverified');
  });

  it('GREEN (the fix): an EMPTY computed overlap promotes the stale-sha record to a match', () => {
    const v = verifyGateDecision({ record: staleGreen, headSha: SHA, requireVerified: true, laneRelevantChangeSince: [] });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('verified');
    expect(v.detail).toMatch(/carried forward/);
    expect(v.detail).toMatch(new RegExp(OTHER.slice(0, 8)));
  });

  it('a NON-empty overlap (a genuinely overlapping change) still refuses — this is not a blanket bypass', () => {
    const v = verifyGateDecision({ record: staleGreen, headSha: SHA, requireVerified: true, laneRelevantChangeSince: ['scripts/verify-lane.mjs'] });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unverified');
  });

  it('`undefined` (never computed) and `null` (git could not tell) both fail closed — same as no param at all', () => {
    for (const val of [undefined, null]) {
      const v = verifyGateDecision({ record: staleGreen, headSha: SHA, requireVerified: true, laneRelevantChangeSince: val });
      expect(v.ok, String(val)).toBe(false);
      expect(v.reason, String(val)).toBe('unverified');
    }
  });

  it('an EXACT sha match is unaffected by the new param (still matches even with a non-empty overlap, which cannot legitimately happen for sha-equal records but must not break the exact-match fast path)', () => {
    const v = verifyGateDecision({ record: green, headSha: SHA, requireVerified: true, laneRelevantChangeSince: ['irrelevant'] });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('verified');
  });

  it('a carried-forward RED record still refuses under requireVerified (the marker\'s STATUS carries forward too, not just its shape)', () => {
    const staleRed = verifyFinishBody(verifyStartBody({ sha: OTHER, suites: 'gate', startedAt: 't' }), { finishedAt: 'u', exitCode: 2, sha: OTHER });
    const v = verifyGateDecision({ record: staleRed, headSha: SHA, requireVerified: true, laneRelevantChangeSince: [] });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('verify-red');
  });

  it('a carried-forward RUNNING record still refuses as unfinished (a half-run verification must not look complete, stale sha or not)', () => {
    const staleRunning = verifyStartBody({ sha: OTHER, suites: 'gate', startedAt: new Date(T0).toISOString() });
    const v = verifyGateDecision({ record: staleRunning, headSha: SHA, nowMs: T0 + min(1), requireVerified: true, laneRelevantChangeSince: [] });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('verify-unfinished');
  });
});

describe('verifyFinishBody stamps the sha the run verified, never the on-disk marker (#2833 finding 1)', () => {
  it('an explicit sha wins over prev.sha — a finish never inherits a moved marker\'s sha', () => {
    // `prev` is a marker that moved to OTHER (an overlapping run) while THIS run verified SHA.
    const moved = verifyStartBody({ sha: OTHER, suites: 'gate', startedAt: 't' });
    const done = verifyFinishBody(moved, { finishedAt: 'u', exitCode: 0, sha: SHA });
    expect(done.sha).toBe(SHA); // the run's own sha, NOT the on-disk OTHER
    expect(done.status).toBe('green');
  });
  it('THE FALSE-GREEN: a green finish at X does NOT produce a green record for a different sha Y', () => {
    // On disk is a RED record for Y (a newer overlapping run finished red at Y). This slow run passes green at X.
    const redY = verifyFinishBody(verifyStartBody({ sha: OTHER, suites: 'gate', startedAt: 't' }), { finishedAt: 'u', exitCode: 2, sha: OTHER });
    const greenX = verifyFinishBody(redY, { finishedAt: 'v', exitCode: 0, sha: SHA });
    expect(greenX.sha).toBe(SHA); // stamped X — it must NEVER stamp green for Y
    expect(greenX.sha).not.toBe(OTHER);
    // The gate at Y therefore still sees the red record, never a green for Y.
    expect(verifyGateDecision({ record: redY, headSha: OTHER, requireVerified: true }).reason).toBe('verify-red');
  });
  it('falls back to prev.sha only when no explicit sha is passed (legacy same-process caller)', () => {
    const start = verifyStartBody({ sha: SHA, suites: 'gate', startedAt: 't' });
    expect(verifyFinishBody(start, { finishedAt: 'u', exitCode: 0 }).sha).toBe(SHA);
  });
  // PR #2982 review — same rule for the cache key: an overlapping `request` re-stamped `prev` with a NEWER tree.
  it('an explicit treeHash (including null) wins over prev.treeHash; prev.treeHash is only the legacy fallback', () => {
    const moved = verifyStartBody({ sha: SHA, suites: 'gate', startedAt: 't', treeHash: 'newer-unverified-tree' });
    expect(verifyFinishBody(moved, { finishedAt: 'u', exitCode: 0, sha: SHA, treeHash: 'verified-tree' }).treeHash).toBe('verified-tree');
    expect(verifyFinishBody(moved, { finishedAt: 'u', exitCode: 0, sha: SHA, treeHash: null }).treeHash).toBeNull();
    expect(verifyFinishBody(moved, { finishedAt: 'u', exitCode: 0, sha: SHA }).treeHash).toBe('newer-unverified-tree');
  });
  // PR #2982 round-2 review — `suites` is a cache-key field too: an overlapping `request --gate=<other>` re-stamped it.
  it('an explicit suites wins over prev.suites; prev.suites is only the legacy fallback', () => {
    const relabeled = verifyStartBody({ sha: SHA, suites: 'stronger-gate', startedAt: 't' });
    expect(verifyFinishBody(relabeled, { finishedAt: 'u', exitCode: 0, sha: SHA, suites: 'weaker-gate' }).suites).toBe('weaker-gate');
    expect(verifyFinishBody(relabeled, { finishedAt: 'u', exitCode: 0, sha: SHA }).suites).toBe('stronger-gate');
  });
});

describe('verifyGateDecision decision table — red is conditional on requireVerified (#2833 finding 2)', () => {
  const rec = (status, exitCode = status === 'red' ? 2 : 0) => ({ sha: SHA, status, exitCode, startedAt: new Date(T0).toISOString() });
  it('red × requireVerified:true → refused (verify-red)', () => {
    const v = verifyGateDecision({ record: rec('red'), headSha: SHA, requireVerified: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('verify-red');
  });
  it('red × requireVerified:false → allowed (red-ci-gated) — the required CI check gates the merge', () => {
    const v = verifyGateDecision({ record: rec('red'), headSha: SHA, requireVerified: false });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('red-ci-gated');
  });
  it('running is refused for BOTH requireVerified values (asymmetry: never-finished ≠ finished-badly)', () => {
    expect(verifyGateDecision({ record: rec('running'), headSha: SHA, nowMs: T0 + min(1), requireVerified: false }).ok).toBe(false);
    expect(verifyGateDecision({ record: rec('running'), headSha: SHA, nowMs: T0 + min(1), requireVerified: true }).ok).toBe(false);
  });
  it('green is ok for BOTH requireVerified values', () => {
    expect(verifyGateDecision({ record: rec('green'), headSha: SHA, requireVerified: false }).ok).toBe(true);
    expect(verifyGateDecision({ record: rec('green'), headSha: SHA, requireVerified: true }).ok).toBe(true);
  });
});

describe('verifyGateDecision — a corrupt marker refuses, never fails open (#2833 finding 5)', () => {
  it('a corrupt record is refused regardless of requireVerified', () => {
    expect(verifyGateDecision({ record: { corrupt: true }, headSha: SHA, requireVerified: false }).ok).toBe(false);
    const v = verifyGateDecision({ record: { corrupt: true }, headSha: SHA, requireVerified: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('verify-corrupt');
  });
  it('break-glass still overrides a corrupt marker', () => {
    expect(verifyGateDecision({ record: { corrupt: true }, headSha: SHA, breakGlass: true }).ok).toBe(true);
  });
});

describe('normalizeVerifyRecord — the SHARED normalizer both readers use (#2833 finding 2)', () => {
  it('a valid-JSON NON-object (the finding-2 hole) folds to { corrupt: true } — never passes as absent', () => {
    // null / a string / a number / an array are all valid JSON but not a verification record. pr-land used to
    // catch only a throw, so these slipped through as "no sha → untracked → land unverified". Now they refuse.
    for (const bad of [null, 'x', 42, [], [{ sha: 'a' }]]) {
      expect(normalizeVerifyRecord(bad)).toEqual({ corrupt: true });
    }
  });
  it('a plain object passes through untouched (field validation is the gate\'s job)', () => {
    const rec = { sha: SHA, status: 'green', exitCode: 0 };
    expect(normalizeVerifyRecord(rec)).toBe(rec);
  });
  it('a folded non-object is REFUSED by the gate (does not fail open)', () => {
    expect(verifyGateDecision({ record: normalizeVerifyRecord('x'), headSha: SHA, requireVerified: false }).ok).toBe(false);
    expect(verifyGateDecision({ record: normalizeVerifyRecord([]), headSha: SHA, requireVerified: false }).reason).toBe('verify-corrupt');
  });
});

describe('resolveVerifyOptions — one flag/env resolver for BOTH entry points (#2833 finding 5)', () => {
  it('--require-verified OR WE_REQUIRE_VERIFIED=1 → requireVerified true; WE_LAND_UNVERIFIED=1 → breakGlass', () => {
    // #3321 flipped the bare default from false to true; the two POSITIVE spellings below still resolve the same.
    expect(resolveVerifyOptions({ flags: {}, env: {} })).toEqual({ requireVerified: true, breakGlass: false });
    expect(resolveVerifyOptions({ flags: { 'require-verified': true }, env: {} })).toEqual({ requireVerified: true, breakGlass: false });
    expect(resolveVerifyOptions({ flags: {}, env: { WE_REQUIRE_VERIFIED: '1' } })).toEqual({ requireVerified: true, breakGlass: false });
    // break-glass is reported SEPARATELY and does not relax `requireVerified` — the gate reads both.
    expect(resolveVerifyOptions({ flags: {}, env: { WE_LAND_UNVERIFIED: '1' } })).toEqual({ requireVerified: true, breakGlass: true });
  });
  it('the SAME flag/env pair yields IDENTICAL options at both call sites (they call one function)', () => {
    // verify-lane `check` and pr-land both call resolveVerifyOptions with {flags, env}; identical input ⇒ identical
    // output by construction. This pins that the resolution is single-sourced (finding 5: `check` used to ignore
    // WE_REQUIRE_VERIFIED, so the same env produced two verdicts).
    const flags = { 'require-verified': true };
    const env = { WE_REQUIRE_VERIFIED: '1', WE_LAND_UNVERIFIED: '1' };
    const atVerifyLane = resolveVerifyOptions({ flags, env });
    const atPrLand = resolveVerifyOptions({ flags, env });
    expect(atVerifyLane).toEqual(atPrLand);
    expect(atVerifyLane).toEqual({ requireVerified: true, breakGlass: true });
  });
});

/**
 * #3321 — VERIFICATION IS MANDATORY BEFORE A LANE LANDS.
 *
 * #2833 built the gate but defaulted `requireVerified` FALSE, so its mandatory half never engaged: a lane whose
 * suites had never run at all landed on the `untracked` verdict — "no marker → not tracked here → allow". A gate
 * that PASSES WHEN IT CANNOT TELL. The cost is measured: 18 of the 39 confirmed findings in the review corpus had
 * their input available at COMMIT time, where the suite this marker records would have caught them; and the suite
 * itself sat red on every macOS host precisely because nothing on the delivery path was obliged to look.
 *
 * These tests pin BOTH directions, because a gate that refuses everything is worse than the hole it closes:
 *   · the REFUSAL — unverified/red/unidentifiable now blocks by default, at both the resolver and the decision; and
 *   · the PASS — a legitimately verified lane (green marker for THIS head) sails through with no options at all.
 * Plus the two escapes, kept at deliberately different strengths: the opt-out relaxes only "we never saw a
 * result"; only break-glass overrides a broken one.
 */
describe('#3321 — the gate no longer passes when it cannot tell (requireVerified defaults true)', () => {
  const greenFor = (sha) => verifyFinishBody(verifyStartBody({ sha, suites: 'gate', startedAt: new Date(T0).toISOString() }), { finishedAt: new Date(T0).toISOString(), exitCode: 0 });
  const runningFor = (sha) => verifyStartBody({ sha, suites: 'gate', startedAt: new Date(T0).toISOString() });

  describe('the resolver: silence means "verified, please", never "don\'t bother"', () => {
    it('#3321 no flags, no env → requireVerified TRUE (the flip; was false before this item)', () => {
      expect(resolveVerifyOptions({ flags: {}, env: {} }).requireVerified).toBe(true);
      expect(resolveVerifyOptions()).toEqual({ requireVerified: true, breakGlass: false });
    });

    it('#3321 every documented OPT-OUT spelling resolves to requireVerified false', () => {
      const optOuts = [
        { flags: { 'no-require-verified': true }, env: {} },
        { flags: { 'require-verified': '0' }, env: {} },
        { flags: { 'require-verified': 'false' }, env: {} },
        { flags: { 'require-verified': 'no' }, env: {} },
        { flags: { 'require-verified': 'OFF' }, env: {} },
        { flags: {}, env: { WE_REQUIRE_VERIFIED: '0' } },
        { flags: {}, env: { WE_REQUIRE_VERIFIED: 'false' } },
      ];
      for (const input of optOuts) {
        expect(resolveVerifyOptions(input).requireVerified, JSON.stringify(input)).toBe(false);
      }
    });

    it('#3321 only an EXPLICIT negative opts out — absence and an empty/unknown value stay required', () => {
      // An env var set to empty is an accident, not a decision. A fail-closed gate must not read an accident as
      // consent, so `WE_REQUIRE_VERIFIED=` (and any value that is not one of the negative tokens) stays required.
      expect(resolveVerifyOptions({ flags: {}, env: { WE_REQUIRE_VERIFIED: '' } }).requireVerified).toBe(true);
      expect(resolveVerifyOptions({ flags: {}, env: { WE_REQUIRE_VERIFIED: 'maybe' } }).requireVerified).toBe(true);
      expect(resolveVerifyOptions({ flags: { 'require-verified': undefined }, env: {} }).requireVerified).toBe(true);
    });

    it('#3321 an explicit --require-verified BEATS an ambient WE_REQUIRE_VERIFIED=0 (precedence, fail-closed)', () => {
      // Review finding (b) on PR #1609: the first cut of #3321 collapsed flag and env into one flat OR, so an
      // ambient negative env DEFEATED an explicit positive flag — a silent regression of the pre-#3321 precedence
      // (`!!flags['require-verified'] || env === '1'`, where the flag won) and fail-OPEN on a contradictory
      // invocation. A flag is a decision made for THIS run; an env var may be inherited from a parent that knew
      // nothing about this call. The deliberate one wins, and it wins toward verifying.
      for (const env of [{ WE_REQUIRE_VERIFIED: '0' }, { WE_REQUIRE_VERIFIED: 'false' }, { WE_REQUIRE_VERIFIED: 'off' }]) {
        expect(resolveVerifyOptions({ flags: { 'require-verified': true }, env }).requireVerified, JSON.stringify(env)).toBe(true);
        expect(resolveVerifyOptions({ flags: { 'require-verified': '1' }, env }).requireVerified, JSON.stringify(env)).toBe(true);
      }
      // The env still decides when the flag is absent — the opt-out is not being broken, only out-ranked.
      expect(resolveVerifyOptions({ flags: {}, env: { WE_REQUIRE_VERIFIED: '0' } }).requireVerified).toBe(false);
      // ...and an explicitly NEGATIVE flag still opts out; it is not "any mention of the flag wins".
      expect(resolveVerifyOptions({ flags: { 'require-verified': '0' }, env: { WE_REQUIRE_VERIFIED: '1' } }).requireVerified).toBe(false);
    });

    it('#3321 contradictory flags resolve fail-closed: --require-verified beats --no-require-verified', () => {
      // Nobody means both. A gate whose purpose is to refuse when it cannot tell must not read "I cannot tell"
      // as consent, so the contradiction resolves toward verifying.
      expect(resolveVerifyOptions({ flags: { 'require-verified': true, 'no-require-verified': true }, env: {} }).requireVerified).toBe(true);
    });

    it('#3321 break-glass is reported SEPARATELY and never relaxes requireVerified', () => {
      // The two escapes are different strengths and must stay distinguishable: collapsing WE_LAND_UNVERIFIED into
      // requireVerified would silently turn the narrow opt-out into the full bypass.
      expect(resolveVerifyOptions({ flags: {}, env: { WE_LAND_UNVERIFIED: '1' } })).toEqual({ requireVerified: true, breakGlass: true });
    });

    /**
     * #3321 — THE DOUBLE-NEGATIVE CORNER (PR #1609 r2, the correctness juror's CONFIRMED finding). The resolver's
     * comments state that `--no-require-verified=0` is "a double negative nobody means" and resolves toward
     * REQUIRED. That was documented, hand-traced and correct — and untested, which is how a stated contract turns
     * into an accidental one. It is a real corner even if `pr-land`'s regex parser is unlikely to emit it: the
     * parser accepts `--flag=<anything>`, so a caller CAN produce every row below, and the whole subject of this
     * card is a gate that must never resolve an input it cannot read as "go ahead".
     *
     * Exhaustive over the resolver's inputs: {absent, affirmative, negative} for each of the two flag spellings ×
     * {absent, '1', negative} for the env var = 27 rows, each asserted against the documented rule
     * (affirmative flag → required; else any explicit negative → opt-out; else required).
     */
    it('#3321 every flag×flag×env combination resolves exactly as the comments claim (27 rows, negated negatives included)', () => {
      const FLAG = { absent: undefined, affirmative: true, negative: '0' };
      const ENV = { absent: undefined, on: '1', negative: '0' };
      for (const [rvName, rv] of Object.entries(FLAG)) {
        for (const [nrvName, nrv] of Object.entries(FLAG)) {
          for (const [envName, ev] of Object.entries(ENV)) {
            const flags = {};
            if (rv !== undefined) flags['require-verified'] = rv;
            if (nrv !== undefined) flags['no-require-verified'] = nrv;
            const env = ev === undefined ? {} : { WE_REQUIRE_VERIFIED: ev };

            // The documented rule, restated independently of the implementation.
            const expected = rvName === 'affirmative' ? true
              : !(nrvName === 'affirmative' || rvName === 'negative' || envName === 'negative');

            const label = `require-verified:${rvName} no-require-verified:${nrvName} env:${envName}`;
            expect(resolveVerifyOptions({ flags, env }).requireVerified, label).toBe(expected);
          }
        }
      }
      // The two rows the finding named, called out by name so a regression reads as itself in the failure output:
      // a NEGATED negative is not an opt-out (it cancels, leaving the mandatory default)...
      expect(resolveVerifyOptions({ flags: { 'no-require-verified': '0' }, env: {} }).requireVerified).toBe(true);
      expect(resolveVerifyOptions({ flags: { 'no-require-verified': 'false' }, env: {} }).requireVerified).toBe(true);
      // ...and a negated `--require-verified` still opts out even against WE_REQUIRE_VERIFIED=1, because the
      // command line is the deliberate signal and it said "no".
      expect(resolveVerifyOptions({ flags: { 'require-verified': 'off' }, env: { WE_REQUIRE_VERIFIED: '1' } }).requireVerified).toBe(false);
    });
  });

  describe('the decision: a caller that omits the option gets the STRICT gate', () => {
    it('#3321 THE HOLE, CLOSED: no marker + no requireVerified argument → REFUSED as unverified', () => {
      // Before this item this exact call returned { ok: true, reason: 'untracked' } — a lane whose suites had
      // never run was allowed to land because the gate could not tell that they had not.
      const v = verifyGateDecision({ record: null, headSha: SHA });
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('unverified');
      expect(v.detail).toMatch(/verify-lane/);
    });

    it('#3321 a RED marker for this head + no requireVerified argument → REFUSED (was advisory)', () => {
      const redRec = verifyFinishBody(runningFor(SHA), { finishedAt: new Date(T0).toISOString(), exitCode: 2 });
      const v = verifyGateDecision({ record: redRec, headSha: SHA, nowMs: T0 });
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('verify-red');
    });

    it('#3321 a marker for a DIFFERENT sha + no requireVerified argument → REFUSED (stale ≠ verified)', () => {
      const v = verifyGateDecision({ record: greenFor(OTHER), headSha: SHA });
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('unverified');
    });

    it('#3321 an UNIDENTIFIABLE head (no headSha) does not wave a green marker through', () => {
      // Nothing can match a missing head, so this falls to the absent cell. Not being able to identify the tree
      // is not evidence that the tree is fine — the whole defect class this item closes.
      expect(verifyGateDecision({ record: greenFor(SHA), headSha: null }).ok).toBe(false);
      expect(verifyGateDecision({ record: greenFor(SHA), headSha: undefined }).reason).toBe('unverified');
    });

    it('#3321 an ABANDONED (past-TTL) running marker no longer degrades to allow by default', () => {
      // #2833 finding 1's degrade survives, but only for a caller that explicitly opted out.
      const abandoned = { record: runningFor(SHA), headSha: SHA, nowMs: T0 + min(DEFAULT_VERIFY_TTL_MINUTES + 5) };
      expect(verifyGateDecision(abandoned).ok).toBe(false);
      expect(verifyGateDecision(abandoned).reason).toBe('verify-unfinished');
      expect(verifyGateDecision({ ...abandoned, requireVerified: false }).ok).toBe(true);
    });
  });

  describe('the counter-test: a legitimately verified lane still LANDS', () => {
    // A gate that blocks everything is worse than the hole. These are the passes that must survive the flip.
    it('#3321 a green marker for THIS head passes with NO options at all', () => {
      const v = verifyGateDecision({ record: greenFor(SHA), headSha: SHA, nowMs: T0 + min(10) });
      expect(v.ok).toBe(true);
      expect(v.reason).toBe('verified');
    });

    it('#3321 a green marker still passes long after the TTL — sha-identity is the freshness test, not the clock', () => {
      const v = verifyGateDecision({ record: greenFor(SHA), headSha: SHA, nowMs: T0 + min(DEFAULT_VERIFY_TTL_MINUTES * 100) });
      expect(v.ok).toBe(true);
      expect(v.reason).toBe('verified');
    });

    it('#3321 END TO END: the resolver\'s own output, fed to the gate, lands a verified lane and refuses a bare one', () => {
      // The exact wiring both entry points do — `resolveVerifyOptions(…)` straight into `verifyGateDecision(…)`.
      const opts = resolveVerifyOptions({ flags: {}, env: {} });
      expect(verifyGateDecision({ record: greenFor(SHA), headSha: SHA, ...opts }).ok).toBe(true);
      expect(verifyGateDecision({ record: null, headSha: SHA, ...opts }).ok).toBe(false);
    });
  });

  describe('the two escapes are different strengths', () => {
    it('#3321 the OPT-OUT is not a bypass: a fresh running marker and a corrupt marker still refuse under it', () => {
      const optOut = resolveVerifyOptions({ flags: { 'no-require-verified': true }, env: {} });
      expect(optOut).toEqual({ requireVerified: false, breakGlass: false });
      // the #2833 stall — a half-run verification must never look complete, opt-out or not
      expect(verifyGateDecision({ record: runningFor(SHA), headSha: SHA, nowMs: T0 + min(1), ...optOut }).reason).toBe('verify-unfinished');
      // a marker that exists but did not parse is evidence of a BROKEN verification, not a missing one
      expect(verifyGateDecision({ record: { corrupt: true }, headSha: SHA, ...optOut }).reason).toBe('verify-corrupt');
      // ...while the cells it IS meant to relax do relax
      expect(verifyGateDecision({ record: null, headSha: SHA, ...optOut }).reason).toBe('untracked');
    });

    it('#3321 BREAK-GLASS is the full bypass, and reaches cells the opt-out does not', () => {
      const bg = resolveVerifyOptions({ flags: {}, env: { WE_LAND_UNVERIFIED: '1' } });
      expect(bg.requireVerified).toBe(true); // still "required" — break-glass overrides, it does not un-require
      for (const record of [null, { corrupt: true }, runningFor(SHA)]) {
        const v = verifyGateDecision({ record, headSha: SHA, nowMs: T0 + min(1), ...bg });
        expect(v.ok).toBe(true);
        expect(v.reason).toBe('break-glass');
      }
    });
  });
});

// ── #3321 — THE CALLER SWEEP, as a test instead of an assertion in a comment ──────────────────────────────────
//
// The residual this item's round-3 fix named and deferred, built here instead. FOUR times now, a docblock or a
// test name has asserted a completed sweep of the callers the flipped default re-points, and four times the
// sweep had missed one: round 1 missed `we:scripts/lane-drain.mjs`, round 2 missed
// `we:skills-src/batch-backlog-items/parallel-execute.workflow.js` (four flag-free argvs, so every `/workflow`
// lane died at pr-land's step-1b gate with exit 3 / `unverified`), round 3 missed the three DOC emitters
// below, and round 4 missed `we:agent-memory-src/lane-pr-is-universal-delivery-all-repos.md` — see THE PREFIX
// ARM on `PR_LAND_CMD`.
//
// RETRACTION — this comment used to end: "So the sweep runs here, over the real committed source: every
// `node scripts/pr-land.mjs …` command string this repo ships must state its verification posture explicitly …
// Add a fifth flag-free invocation and this reddens instead of shipping." THAT WAS FALSE WHEN WRITTEN. The
// round-3 sweep iterated TWO HARD-CODED FILENAMES (`for (const file of [WORKFLOW, DRAIN])`) — the same
// hand-maintained caller list it claimed to be replacing, relocated from a comment into a test. Measured by
// review round 3, in this lane at `ff8088e4`: appending a flag-free `node scripts/pr-land.mjs` invocation
// (argv `--ref=lane/x --label-on-green --json`) to a THIRD emitter (`scripts/lane-review.mjs`)
// left the suite GREEN at 53 passed; appending the identical line to a swept file reddened it. And the list was
// false by its own stated criterion: running its own predicate over `git ls-files` finds THREE further emitters
// shipping a `--ref=` invocation that says nothing about verification —
// `skills-src/batch-backlog-items/SKILL.md` (the serial `/batch` close-out),
// `docs/agent/backlog-workflow.md` (the canonical per-item arc) and
// `agent-memory-src/single-session-should-use-a-lane.md`.
//
// SO THE HARVEST IS NOW THE TRACKED FILE SET. `git grep -lF pr-land.mjs` over tracked files, minus exactly one
// exclusion (`scripts/pr-land.mjs` — a tool's own `--help` usage banner documents its flags; it is not a caller
// of itself, and the exclusion is pinned below so it cannot silently grow). Every invocation the harvest finds
// must DECLARE ITS POSTURE, one of two ways — which is the contract review round 2 actually asked for, "either
// carries a verify flag or is preceded by a verify-lane run":
//   · it carries `--require-verified` / `--no-require-verified`, or
//   · a `verify-lane.mjs` / `run.mjs verify` command sits on the same line or within the 3 lines above it, so the
//     arc records a marker for the commit it is about to land. The window is deliberately TIGHT: it proves the
//     verify is adjacent in the documented arc, NOT merely somewhere in the same file. What it does NOT prove is
//     execution order — source adjacency is the checkable proxy, and the reason the doc arcs were edited to put
//     the verify AFTER the item commit rather than leaving it where it already sat, hundreds of lines up.
// Each harvested invocation is then driven through pr-land's own flag parser, `resolveVerifyOptions`, and
// `verifyGateDecision` against the marker state that path really sees.
//
// RETRACTION — THE TITLE BELOW READ "#3321 — every committed pr-land invocation declares its verification
// posture (caller sweep)". FALSE WHEN WRITTEN, for the fifth time in this PR's history and by the same
// mechanism: the sweep's stated scope was larger than its actual scope. Round 4's `PR_LAND_CMD` matched only
// `node scripts/pr-land.mjs …`, so an invocation written with this repo's own `we:` locus prefix was not
// "a committed pr-land invocation" as far as the sweep was concerned — and exactly one such invocation was
// shipping, flag-free, in a loaded agent memory. The title now says what the sweep IS, and the limits below
// say what it is not, rather than a name doing the claiming.
//
// WHAT THE SWEEP IS NOT — the stated limits, so the next round need not discover them:
//   · It harvests COMMAND STRINGS carrying at least one `--flag`. A bare `node we:scripts/pr-land.mjs` with no
//     flags at all (e.g. `we:backlog/2219…:222`) is prose about the tool, not an argv, and is NOT harvested.
//   · It knows three spellings of the path — bare, `we:`-prefixed, `./`-prefixed. A fourth spelling would be
//     invisible again; the mutation probes below are the defence against that, not the regex.
//   · Argvs built as ARRAYS (`we:scripts/lane-drain.mjs#buildPrLandArgs`) are invisible to any command-string
//     scan and are pinned by a separate case.
//   · Source adjacency is a checkable proxy for "the verify precedes the land", never a proof of execution order.
describe('#3321 — every pr-land COMMAND STRING the tracked file set ships declares its posture (caller sweep)', () => {
  const REPO = process.cwd();
  const WORKFLOW = 'skills-src/batch-backlog-items/parallel-execute.workflow.js';
  const DRAIN = 'scripts/lane-drain.mjs';
  // The ONE exclusion. pr-land's `--help` banner spells its own flags out as example command lines; they are
  // documentation of the tool, not call sites of it. Pinned by name AND by count below.
  const SELF = 'scripts/pr-land.mjs';

  // pr-land's OWN flag parser (`scripts/pr-land.mjs`, the argv loop) — the same regex, not a re-implementation.
  const parseArgv = (cmd) => {
    const flags = {};
    for (const a of cmd.split(/\s+/).slice(2)) {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
    }
    return flags;
  };
  // A REAL invocation, not the prose form: at least one `--flag` must follow, so a docblock's
  // "the `node scripts/pr-land.mjs …` argv" is not mistaken for a call site that forgot its posture.
  //
  // THE PREFIX ARM (review round 5, the CONFIRMED coverage-gap finding). This regex used to read
  // `/node scripts\/pr-land\.mjs…/` — a bare path and nothing else — while this repo's own documentation
  // convention writes cross-repo paths with the constellation locus prefix, `node we:scripts/pr-land.mjs …`.
  // So the sweep's harvest was blind to exactly the spelling the docs are written in. Measured in this lane,
  // not assumed: running this describe's own predicate over `git grep -lF pr-land.mjs` (213 candidate files)
  // with and without the prefix arm harvested 8 invocations vs 7, and the one invocation only the widened
  // regex sees is `agent-memory-src/lane-pr-is-universal-delivery-all-repos.md:20` — a `type: feedback` agent
  // (CITATION CORRECTED, round 6: this read `:16` for three rounds. The line number drifted when this round's own
  // verify step was inserted into that file; `:16` was right when written and stale by the time it was read. The
  // invocation itself never moved file. Re-measured here, not adjusted by arithmetic: `grep -n pr-land` on that
  // file puts the harvested argv at line 20.)
  // memory, i.e. a LOADED INSTRUCTION, and the canonical cross-repo delivery arc for Frontier UI and
  // plateau-app. It carried no verify flag and no adjacent verify run, so after this item's flip an agent
  // following it would have hit `pr-land`'s step-1b gate with exit 3 / `unverified`. That arc is fixed in this
  // round, and the `we:`-prefixed shape is now a named mutation probe below so the prefix cannot go blind again.
  //
  // The `./` arm harvests NOTHING today — measured: 0 additional invocations over the same 213 files. It is
  // here because "the sweep did not know that spelling" is the failure mode of record, five rounds running.
  const PR_LAND_CMD = /node (?:we:|\.\/)?scripts\/pr-land\.mjs(?:\s+--[^\s`\\]+)+/g;
  const VERIFY_FLAGS = ['require-verified', 'no-require-verified'];
  // The second arm: a recorded verification for the commit about to land. `verify-lane.mjs` is the ONLY writer of
  // `.git/.lane-verify`; `run.mjs verify` is the operation that shells it.
  const VERIFY_RUN = /verify-lane\.mjs|run\.mjs verify/;
  const VERIFY_WINDOW = 3;
  const srcOf = (f) => readFileSync(resolve(REPO, f), 'utf8');
  const greenFor = (sha) => verifyFinishBody(
    verifyStartBody({ sha, suites: 'gate', startedAt: new Date(T0).toISOString() }),
    { finishedAt: new Date(T0).toISOString(), exitCode: 0 },
  );

  /** Every tracked file that mentions pr-land.mjs — the harvest set, computed, never listed. */
  const trackedMentioningPrLand = () =>
    execFileSync('git', ['grep', '-lF', '--', 'pr-land.mjs'], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  /**
   * Harvest one source TEXT's invocations WITH the line context the verify-arm needs. PURE over `(name, src)`,
   * which is what lets the mutation probes below run the REAL predicate over a real file's source plus one
   * injected line — no temp clone, no file written, no `git checkout` to undo.
   */
  const scanSource = (name, src) => {
    const lines = src.split('\n');
    const out = [];
    lines.forEach((line, i) => {
      for (const m of line.matchAll(PR_LAND_CMD)) {
        const before = lines.slice(Math.max(0, i - VERIFY_WINDOW), i + 1).join('\n');
        out.push({ file: name, line: i + 1, cmd: m[0].trim(), precededByVerify: VERIFY_RUN.test(before) });
      }
    });
    return out;
  };
  /** The predicate the `no HARVESTED emitter …` case applies, factored out so a probe asserts the REAL rule. */
  const silentIn = (invocations) => invocations
    .filter((v) => !VERIFY_FLAGS.some((f) => f in parseArgv(v.cmd)))
    .filter((v) => !v.precededByVerify)
    .map((v) => `${v.file}:${v.line}: ${v.cmd.slice(0, 90)}`);
  const invocationsIn = (f) => scanSource(f, srcOf(f));
  const cmdsIn = (f) => invocationsIn(f).map((v) => v.cmd);

  const harvest = () =>
    trackedMentioningPrLand()
      .filter((f) => f !== SELF)
      .flatMap(invocationsIn);

  it('the harvest is the TRACKED FILE SET, not a hand-written list of filenames', () => {
    const files = trackedMentioningPrLand();
    // The files the round-3 sweep hard-coded are of course still in it — but so is everything else, which is the
    // whole point. If this ever equals exactly [WORKFLOW, DRAIN, SELF] the sweep has quietly narrowed again.
    expect(files).toContain(WORKFLOW);
    expect(files).toContain(DRAIN);
    expect(files.length).toBeGreaterThan(3);
    // And the emitters the review rounds missed are inside the harvest now, by construction rather than by name.
    const harvested = harvest().map((v) => v.file);
    for (const missed of [
      // round 3 missed these three
      'skills-src/batch-backlog-items/SKILL.md',
      'docs/agent/backlog-workflow.md',
      'agent-memory-src/single-session-should-use-a-lane.md',
      // round 4 missed this one, because it is written with the `we:` locus prefix (see PR_LAND_CMD above)
      'agent-memory-src/lane-pr-is-universal-delivery-all-repos.md',
    ]) expect(harvested).toContain(missed);
  });

  it('the ONE exclusion is pr-land\'s own --help banner, and it stays one file', () => {
    const excluded = trackedMentioningPrLand().filter((f) => f === SELF);
    expect(excluded).toEqual([SELF]);
    // Every hit the exclusion swallows lives in the usage banner — i.e. above the `import` line that starts the
    // program. If a REAL self-invocation is ever added below it, this count moves and the exclusion must be
    // re-argued rather than silently widened.
    const src = srcOf(SELF);
    const programStart = src.indexOf('\nimport ');
    const hits = [...src.matchAll(PR_LAND_CMD)];
    // 15, not 14 (draft-first PRs, operator-approved 2026-09-27) — one new usage-banner line added, documenting
    // the `--no-draft` opt-out for the new draft-by-default `--park` open. Still above `programStart` (the
    // usage banner), same as every other hit. (Deliberately NOT quoting the actual command string here: this
    // FILE is itself part of the tracked set `trackedMentioningPrLand()` scans below, and a quoted flag-carrying
    // invocation in a comment would itself get harvested as an undeclared-posture hit.)
    expect(hits.length).toBe(15);
    for (const h of hits) expect(h.index, h[0]).toBeLessThan(programStart);
  });

  it('no HARVESTED emitter ships a pr-land invocation that says nothing about verification', () => {
    // RETRACTION — this case was named "no emitter ships a pr-land invocation that says nothing about
    // verification". FALSE WHEN WRITTEN, and false for the specific reason the describe block above records:
    // `PR_LAND_CMD` matched only the bare `node scripts/pr-land.mjs` spelling, so an emitter writing the same
    // command with this repo's own `we:` locus prefix was not an emitter as far as this case was concerned. It
    // says "HARVESTED" now, and what the harvest is — and is not — is stated in the describe title and pinned by
    // the mutation probes below, rather than asserted by a name.
    expect(silentIn(harvest())).toEqual([]);
  });

  /**
   * THE MUTATION PROBES. Every round of this PR that widened the sweep also claimed the widening was complete,
   * and three times a reviewer disproved the claim the same way: append one flag-free `pr-land` invocation to a
   * real tracked file and watch the suite stay green. So the probe is a TEST now, not a reviewer's manual step.
   *
   * Each probe runs the REAL predicate (`scanSource` + `silentIn` — the same functions the harvest case above
   * uses) over a real tracked file's real source with ONE line appended. Nothing is written to disk.
   */
  describe('mutation probes — a flag-free invocation in a file nobody listed must be SEEN', () => {
    // THE PROBE COMMANDS ARE COMPOSED, NEVER WRITTEN AS ONE LITERAL. This test file is itself in the harvest's
    // candidate set (it mentions `pr-land.mjs` throughout), so a probe spelled as a single string literal would
    // be harvested from THIS file and reported as a silent emitter — the sweep would redden on its own probes.
    // Splitting `node` off the front means no committed pr-land COMMAND STRING exists here for `PR_LAND_CMD` to
    // match, while the string the probe actually injects is byte-identical to the real shape. The alternative —
    // excluding this file from the harvest — would have made the sweep blind inside the one file most likely to
    // grow a `pr-land` invocation, and would have grown the stated exclusion list from one to two.
    const NODE = 'node';
    const PROBE_ARGV = '--ref=lane/mutation-probe-999 --label-on-green';
    const PROBES = [
      {
        // Review round 3's probe, against a file that was outside the round-3 two-filename sweep entirely.
        name: 'the PLAIN shape, in scripts/lane-review.mjs (review round 3\'s probe)',
        file: 'scripts/lane-review.mjs',
        cmd: `${NODE} scripts/pr-land.mjs ${PROBE_ARGV} --json`,
      },
      {
        // Review round 5's probe. The round-4 regex saw NOTHING here: it is the identical shape, spelled with
        // the `we:` locus prefix this repo's documentation uses everywhere.
        name: 'the we:-PREFIXED shape, in skills-src/pr/SKILL.md (review round 5\'s probe)',
        file: 'skills-src/pr/SKILL.md',
        cmd: `${NODE} we:scripts/pr-land.mjs ${PROBE_ARGV}`,
      },
    ];

    for (const probe of PROBES) {
      it(`#3321 ${probe.name} is harvested, and reddens the silent-emitter rule`, () => {
        // The file is a real tracked file, and a real candidate: it mentions pr-land.mjs, so the harvest's own
        // `git grep -lF` already returns it. A probe against a file the grep never reaches would prove nothing.
        expect(trackedMentioningPrLand(), probe.file).toContain(probe.file);

        const clean = srcOf(probe.file);
        expect(silentIn(scanSource(probe.file, clean)), 'the unmutated file must be clean').toEqual([]);

        const found = scanSource(probe.file, `${clean}\n\`${probe.cmd}\`\n`);
        expect(found.map((v) => v.cmd), 'the injected invocation must be HARVESTED').toContainEqual(probe.cmd);
        expect(silentIn(found), 'and must be reported as declaring nothing').toHaveLength(1);
      });

      it(`#3321 ${probe.name}, WITH an adjacent verify, passes — the rule is posture, not "no pr-land here"`, () => {
        // The counter-direction. Without this a probe only proves the sweep dislikes the word `pr-land`; with it,
        // the probe proves the sweep is reading the DECLARED POSTURE — which is the contract the item states.
        const clean = srcOf(probe.file);
        const verify = `${NODE} scripts/operations/run.mjs verify --checkout=<lane> --json`;
        expect(silentIn(scanSource(probe.file, `${clean}\n\`${verify}\`\n\`${probe.cmd}\`\n`))).toEqual([]);
        // …and the flag arm passes too, on the same injected line.
        expect(silentIn(scanSource(probe.file, `${clean}\n\`${probe.cmd} --no-require-verified\`\n`))).toEqual([]);
      });
    }
  });

  it('every harvested invocation reaches ok:true on the marker state its own path really has', () => {
    for (const v of harvest()) {
      const opts = resolveVerifyOptions({ flags: parseArgv(v.cmd), env: {} });
      const where = `${v.file}:${v.line}`;
      if (opts.requireVerified) {
        // The lane-local arms: no flag, but a verify adjacent above them, so a FRESH green marker for the commit
        // being landed is exactly what the arc produces. These are the paths where the gate MEANS something.
        expect(v.precededByVerify, where).toBe(true);
        expect(verifyGateDecision({ record: greenFor(SHA), headSha: SHA, ...opts }), where)
          .toMatchObject({ ok: true, reason: 'verified' });
        // …and the reason the verify has to sit AFTER the item commit: a green marker for an EARLIER head is
        // stale, and the strict gate refuses it (the #3212 shape).
        expect(verifyGateDecision({ record: greenFor(OTHER), headSha: SHA, ...opts }), where)
          .toMatchObject({ ok: false, reason: 'unverified' });
      } else {
        // The CI-gated arms: the marker is structurally unreachable, so they declare the opt-out instead.
        expect(verifyGateDecision({ record: null, headSha: SHA, ...opts }), where)
          .toMatchObject({ ok: true, reason: 'untracked' });
      }
    }
  });

  it('the parallel /workflow producer passes the opt-out on EVERY argv it emits', () => {
    const invocations = cmdsIn(WORKFLOW);
    // Step 8 emits two (the WE PR and the impl-repo PR); the #2216 label-reconcile pass emits two more.
    expect(invocations.length).toBe(4);
    for (const cmd of invocations) {
      const opts = resolveVerifyOptions({ flags: parseArgv(cmd), env: {} });
      expect(opts, cmd).toEqual({ requireVerified: false, breakGlass: false });
      // The marker state this path REALLY has: absent. Its step-4 gate shells the suites directly and never
      // writes `.git/.lane-verify`, and the reconcile pass runs from the PRIMARY checkout against a lane ref,
      // where a lane clone's marker is structurally unreachable.
      expect(verifyGateDecision({ record: null, headSha: SHA, ...opts }), cmd)
        .toMatchObject({ ok: true, reason: 'untracked' });
    }
  });

  it('the same argvs WITHOUT the flag are the wedge — so the flag is provably load-bearing', () => {
    const stripped = cmdsIn(WORKFLOW).map((c) => c.replace(/\s--no-require-verified\b/g, ''));
    expect(stripped.length).toBe(4);
    for (const cmd of stripped) {
      const opts = resolveVerifyOptions({ flags: parseArgv(cmd), env: {} });
      expect(opts.requireVerified, cmd).toBe(true);
      expect(verifyGateDecision({ record: null, headSha: SHA, ...opts }), cmd)
        .toMatchObject({ ok: false, reason: 'unverified' });
    }
  });

  it('the drain builds its argv as an ARRAY, and that array declares the posture too', () => {
    // `buildPrLandArgs` is an array literal, not a command string, so the regex above cannot see it. Pinned here
    // as well, so the sweep has no hole the drain could slip back through. (`lane-drain.test.mjs` pins the
    // resolved behaviour; this pins that the sweep itself covers the shape.)
    expect(srcOf(DRAIN)).toMatch(/const args = \['scripts\/pr-land\.mjs',[^\]]*'--no-require-verified'/);
  });

  // #4348-open-pr-retry addendum — a THIRD array-built caller, alongside the drain: `infra-blocked.mjs`'s
  // `resumeOpen` re-invokes pr-land from the PRIMARY checkout (`INFRA_ROOT`, never a lane clone) to resume a
  // PR-open that failed on an outside dependency after the lane ref was already pushed. Structurally identical
  // posture to the drain/workflow producer — a lane-clone verify marker cannot exist at that cwd — but this
  // caller was MISSING the opt-out until this fix: every resume was refused `unverified`, silently (the live
  // #4348 stall, confirmed by reading pr-land's own refusal path — `--dry-run` cannot reproduce it, since
  // pr-land's own docblock states the verify gate runs strictly AFTER the dry-run branch returns).
  const INFRA_RESUME = 'scripts/conveyor/infra-blocked.mjs';
  it('infra-blocked.mjs\'s resumeOpen builds its argv as an ARRAY too, and that array declares the posture', () => {
    expect(srcOf(INFRA_RESUME)).toMatch(/const args = \[prLand,[^\]]*'--no-require-verified'/);
  });
  // PR #2899 review — the opt-out is only sound for the commit that was actually verified, so this caller must
  // pin `--sha` to the RECORDED sha (checked against the live tip by `resumeShaDecision`), never to the
  // moving `origin/<ref>` tip.
  it('infra-blocked.mjs\'s resumeOpen pins --sha to the recorded sha, never the moving origin/<ref> tip', () => {
    const src = srcOf(INFRA_RESUME);
    expect(src).toMatch(/const args = \[prLand,[^\]]*`--sha=\$\{pin\.sha\}`/);
    expect(src).not.toMatch(/`--sha=origin\//);
    expect(src).toMatch(/const pin = resumeShaDecision\(\{ recordedSha: entry\.sha,/);
  });
  it('RED/GREEN — resumeOpen\'s REAL argv shape: WITHOUT the flag it is refused unverified (the live bug); '
    + 'WITH it (this fix) it is untracked/ok, the same posture the drain and workflow producer already have', () => {
    // The exact command resumeOpen builds (mirrored here as a string so the SAME `parseArgv`/`resolveVerifyOptions`/
    // `verifyGateDecision` machinery the caller sweep already trusts for the drain/workflow can drive it) — never
    // driven live: `resumeOpen` itself spawns real `git fetch` + `pr-land.mjs` + a `gh pr create`, which this
    // suite does not have credentials or network for, and must not depend on either.
    const REF = 'lane/4348-cross-locus-build-agents-never-get-the-we-lane-lane-is-overw';
    const withFlag = `node scripts/pr-land.mjs --ref=${REF} --sha=origin/${REF} --base=main --label-on-green --no-require-verified --json`;
    const withoutFlag = withFlag.replace(/\s--no-require-verified\b/, '');

    // RED — the live #4348 shape: no marker at the primary's cwd, and no opt-out passed.
    const redOpts = resolveVerifyOptions({ flags: parseArgv(withoutFlag), env: {} });
    expect(redOpts.requireVerified).toBe(true);
    expect(verifyGateDecision({ record: null, headSha: SHA, ...redOpts }))
      .toMatchObject({ ok: false, reason: 'unverified' });

    // GREEN — this fix's actual argv.
    const greenOpts = resolveVerifyOptions({ flags: parseArgv(withFlag), env: {} });
    expect(greenOpts).toEqual({ requireVerified: false, breakGlass: false });
    expect(verifyGateDecision({ record: null, headSha: SHA, ...greenOpts }))
      .toMatchObject({ ok: true, reason: 'untracked' });
  });
});

describe('the marker filename is the never-tracked in-.git convention', () => {
  it('VERIFY_FILENAME matches the .lane-lease sibling convention', () => {
    expect(VERIFY_FILENAME).toBe('.lane-verify');
  });
});

describe('keepMarkerAfterReset — an acquire drops the previous holder\'s verify record (#3383)', () => {
  it('keeps only a record for the commit the reset landed on', () => {
    expect(keepMarkerAfterReset({ sha: 'abc', status: 'green' }, 'abc')).toBe(true);
    expect(keepMarkerAfterReset({ sha: 'old', status: 'green' }, 'abc')).toBe(false);
    expect(keepMarkerAfterReset({ sha: 'old', status: 'red' }, 'abc')).toBe(false);
    expect(keepMarkerAfterReset({ corrupt: true }, 'abc')).toBe(false);
    expect(keepMarkerAfterReset(null, 'abc')).toBe(false);
  });
});

/**
 * waitForVerifySettle (#4358) — the bounded, internally-pollable wait `verify-lane.mjs check --wait=<ms>` is
 * built on. Everything here uses a FAKE clock/sleep (a shared counter `t`, advanced only by `sleep`, never a
 * real timer) so the whole suite runs instantly regardless of the simulated ceilings/intervals it exercises —
 * exactly the "fake clock, fake marker reads" shape the card's own test plan (item 1) asks for.
 */
describe('waitForVerifySettle — bounded wait for the marker to settle (#4358)', () => {
  const gateFor = (sha) => ({
    running: verifyStartBody({ sha, suites: 'gate', startedAt: new Date(T0).toISOString() }),
    green: verifyFinishBody(verifyStartBody({ sha, suites: 'gate', startedAt: new Date(T0).toISOString() }), { finishedAt: new Date(T0).toISOString(), exitCode: 0 }),
  });

  /** A fake clock: `now()` reads a shared counter that only `sleep()` ever advances — no real timers, so a
   *  simulated multi-poll wait resolves in real-test-time ~0ms regardless of how many virtual ms it spans. */
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
  }

  it('settles as soon as the marker goes green — returns on the poll it settles, not the full ceiling', async () => {
    const { running, green } = gateFor(SHA);
    let calls = 0;
    const readRecord = () => { calls += 1; return calls < 4 ? running : green; }; // green on the 4th poll
    const { now, sleep } = fakeClock();

    const result = await waitForVerifySettle({
      readRecord, readHead: () => SHA, headSha: SHA,
      ceilingMs: 60_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(result).toMatchObject({ status: 'green', ok: true, settled: true });
    expect(result.waited.polls).toBe(4);
    // 3 sleeps of 2s each elapsed before the 4th (settling) poll — nowhere near the 60s ceiling.
    expect(result.waited.ms).toBe(6_000);
  });

  it('a bounded "still pending" result at the ceiling — never waits past it, and is clearly UNSETTLED', async () => {
    const { running } = gateFor(SHA);
    const { now, sleep } = fakeClock();

    const result = await waitForVerifySettle({
      readRecord: () => running, readHead: () => SHA, headSha: SHA,
      ceilingMs: 10_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(result.settled).toBe(false);
    expect(result.status).toBe('timeout');
    expect(result.reason).toBe('wait-timeout');
    expect(result.ok).toBe(false);
    expect(result.waited.ms).toBe(10_000); // stops AT the ceiling, never beyond it
    expect(result.lastStatus).toBe('running'); // the last real read is preserved for diagnosis…
    expect(result.status).not.toBe('running'); // …but never SUBSTITUTES for the honest "timeout" verdict
  });

  it('break-glass ends the wait immediately (a constant override — more waiting could never change it)', async () => {
    const { running } = gateFor(SHA);
    const { now, sleep } = fakeClock();

    const result = await waitForVerifySettle({
      readRecord: () => running, readHead: () => SHA, headSha: SHA, breakGlass: true,
      ceilingMs: 60_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(result).toMatchObject({ status: 'break-glass', ok: true });
    // #4358 risk: an ok:true verdict that is NOT a verified result must never read as "settled".
    expect(result.settled).toBe(false);
    expect(result.waited.polls).toBe(1);
    expect(result.waited.ms).toBe(0); // no sleep needed — decided on the very first poll
  });

  it('a corrupt marker ends the wait with an explicit error, never a silent retry', async () => {
    const { now, sleep } = fakeClock();

    const result = await waitForVerifySettle({
      readRecord: () => ({ corrupt: true }), readHead: () => SHA, headSha: SHA,
      ceilingMs: 60_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(result).toMatchObject({ status: 'corrupt', reason: 'verify-corrupt', ok: false, settled: false });
    expect(result.waited.polls).toBe(1); // no retry loop
  });

  it('untracked (ok:true, but not a verified result) does NOT settle the wait — ends immediately, unsettled', async () => {
    // requireVerified:false + no record for this head ⇒ verifyGateDecision's `untracked` (ok:true) — the exact
    // #4358 risk: this must not be read as "done" just because ok is true. It ends the wait right away (nothing
    // will ever write a marker for this head without an explicit request/verify), not after burning the ceiling.
    const { now, sleep } = fakeClock();

    const result = await waitForVerifySettle({
      readRecord: () => null, readHead: () => SHA, headSha: SHA, requireVerified: false,
      ceilingMs: 6_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(result).toMatchObject({ status: 'untracked', ok: true, settled: false });
    expect(result.waited.polls).toBe(1);
    expect(result.waited.ms).toBe(0); // no sleep — decided on the very first poll, not at the ceiling
  });

  it('absent (requireVerified:true, no marker for this head) ends the wait immediately — never burns the full ceiling', async () => {
    // #4358 — nothing but an explicit request/verify ever writes this head's marker, so waiting longer here
    // cannot help; pins the fix for an earlier cut that lumped `absent` in with `running` (see the backlog
    // card's Progress section for the review history).
    const { now, sleep } = fakeClock();

    const result = await waitForVerifySettle({
      readRecord: () => null, readHead: () => SHA, headSha: SHA, requireVerified: true,
      ceilingMs: 60_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(result).toMatchObject({ status: 'absent', reason: 'unverified', ok: false, settled: false });
    expect(result.waited.polls).toBe(1);
    expect(result.waited.ms).toBe(0);
  });

  it('a STALE marker (recorded for a DIFFERENT, already-superseded sha) also ends the wait immediately, same as absent', async () => {
    const { green } = gateFor(OTHER); // a real green record, but for the WRONG head
    const { now, sleep } = fakeClock();

    const result = await waitForVerifySettle({
      readRecord: () => green, readHead: () => SHA, headSha: SHA, requireVerified: true,
      ceilingMs: 60_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(result).toMatchObject({ status: 'absent', reason: 'unverified', ok: false, settled: false });
    expect(result.waited.polls).toBe(1);
  });

  it('#4296: a STALE marker covered by an EMPTY resolveLaneRelevantChangeSince settles GREEN instead of ending absent', async () => {
    const { green } = gateFor(OTHER); // recorded for OTHER, but nothing lane-relevant changed since
    const { now, sleep } = fakeClock();
    let calledWith = null;

    const result = await waitForVerifySettle({
      readRecord: () => green, readHead: () => SHA, headSha: SHA, requireVerified: true,
      resolveLaneRelevantChangeSince: (record) => { calledWith = record; return []; },
      ceilingMs: 60_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(calledWith).toBe(green); // called with the FULL record, not just its sha
    expect(result).toMatchObject({ status: 'green', reason: 'verified', ok: true, settled: true });
  });

  it('#4296 (converge round 2): an exact-match record still settles GREEN even when resolveLaneRelevantChangeSince is called and returns something else entirely — the exact-sha fast path wins regardless', async () => {
    // Round 2 removed the local "only call when sha differs" pre-check (a third partial copy of the guard
    // laneRelevantChangeSinceForRecord already owns) — the resolver is now called UNCONDITIONALLY whenever the
    // caller supplies one. This proves that change is safe: even a resolver that returns a NON-empty overlap (the
    // "refuse" signal) is ignored for an exact-sha match, because verifyGateDecision's exactShaMatch short-circuits
    // before `laneRelevantChangeSince` is ever consulted.
    const { green } = gateFor(SHA);
    const { now, sleep } = fakeClock();
    let calledWith;
    const resolveLaneRelevantChangeSince = (record) => { calledWith = record; return ['some/file.mjs']; };

    const result = await waitForVerifySettle({
      readRecord: () => green, readHead: () => SHA, headSha: SHA, requireVerified: true,
      resolveLaneRelevantChangeSince,
      ceilingMs: 60_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(calledWith).toBe(green); // it WAS called (round-2 change) — with the exact-match record
    expect(result).toMatchObject({ status: 'green', ok: true, settled: true }); // but it changed nothing
  });

  it('a HEAD move mid-wait is reported distinctly from "still pending" — never folded into a timeout', async () => {
    const { running } = gateFor(SHA);
    const { now, sleep } = fakeClock();
    let polls = 0;
    // HEAD matches for the first 2 polls, then a new commit lands (the tracked sha is no longer HEAD).
    const readHead = () => { polls += 1; return polls <= 2 ? SHA : OTHER; };

    const result = await waitForVerifySettle({
      readRecord: () => running, readHead, headSha: SHA,
      ceilingMs: 60_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(result).toMatchObject({ status: 'head-moved', reason: 'head-moved', ok: false, settled: false });
    expect(result.detail).toMatch(new RegExp(OTHER.slice(0, 8)));
    // caught on the 3rd poll — well before the 60s ceiling would otherwise have been reached.
    expect(result.waited.polls).toBe(3);
    expect(result.waited.ms).toBe(4_000);
  });

  it('a red result also settles the wait (both requireVerified arms) — only green/red are terminal-settled', async () => {
    const redFor = (sha) => verifyFinishBody(verifyStartBody({ sha, suites: 'gate', startedAt: 't' }), { finishedAt: 'u', exitCode: 2 });
    const { now, sleep } = fakeClock();

    const strict = await waitForVerifySettle({
      readRecord: () => redFor(SHA), readHead: () => SHA, headSha: SHA, requireVerified: true,
      ceilingMs: 10_000, pollIntervalMs: 2_000, now, sleep,
    });
    expect(strict).toMatchObject({ status: 'red', reason: 'verify-red', ok: false, settled: true });

    const { now: now2, sleep: sleep2 } = fakeClock();
    const optOut = await waitForVerifySettle({
      readRecord: () => redFor(SHA), readHead: () => SHA, headSha: SHA, requireVerified: false,
      ceilingMs: 10_000, pollIntervalMs: 2_000, now: now2, sleep: sleep2,
    });
    expect(optOut).toMatchObject({ status: 'red', reason: 'red-ci-gated', ok: true, settled: true });
  });

  it('a ceiling that is NOT an exact multiple of the poll interval still stops EXACTLY at the ceiling, never past it', async () => {
    // #4358 — a ceiling/interval pair that divides evenly (10_000 / 2_000, used above) can't tell a correct
    // final-sleep clamp apart from one that simply overshoots by up to one interval. 7_000 / 2_000 does not
    // divide evenly: an unclamped final sleep would land at 8_000, not 7_000.
    const { running } = gateFor(SHA);
    const { now, sleep } = fakeClock();

    const result = await waitForVerifySettle({
      readRecord: () => running, readHead: () => SHA, headSha: SHA,
      ceilingMs: 7_000, pollIntervalMs: 2_000, now, sleep,
    });

    expect(result.status).toBe('timeout');
    expect(result.waited.ms).toBe(7_000); // exactly the ceiling — the last sleep was clamped to 1_000, not 2_000
  });
});

describe('resolveWaitCeilingMs — the SAME clamp verify-lane.mjs applies to a requested --wait= (#4358)', () => {
  it('passes a requested value through unchanged when it is within the safe ceiling', () => {
    expect(resolveWaitCeilingMs(1_000)).toBe(1_000);
    expect(resolveWaitCeilingMs(MAX_SAFE_WAIT_MS)).toBe(MAX_SAFE_WAIT_MS); // exactly at the bound — not clamped down
  });
  it('clamps a requested value ABOVE the safe ceiling down to it', () => {
    expect(resolveWaitCeilingMs(MAX_SAFE_WAIT_MS + 1)).toBe(MAX_SAFE_WAIT_MS);
    expect(resolveWaitCeilingMs(10_000_000)).toBe(MAX_SAFE_WAIT_MS);
  });
});

describe('failure details belong to the finishing execution', () => {
  const failureDetails = { tests: [{ file: 'one.test.ts', name: 'outer > fails' }], summary: 'assertion failed', truncated: false };
  it('never inherits overlapping diagnostics and clears them for green', () => {
    const prev = { sha: 'ours', failureDetails };
    expect(verifyFinishBody(prev, { exitCode: 1 }).failureDetails).toBeUndefined();
    expect(verifyFinishBody(prev, { exitCode: 0, failureDetails }).failureDetails).toBeUndefined();
    expect(verifyFinishBody(prev, { exitCode: 1, failureDetails }).failureDetails).toEqual(failureDetails);
  });
  it('carries exact-SHA red diagnostics through wait, never foreign records', async () => {
    const record = { sha: 'ours', status: 'red', failureDetails };
    expect(verifyGateDecision({ record, headSha: 'other' }).failureDetails).toBeUndefined();
    expect(verifyGateDecision({ record, headSha: 'other', laneRelevantChangeSince: [] }).failureDetails).toBeUndefined();
    const waited = await waitForVerifySettle({ readRecord: () => record, readHead: () => 'ours', headSha: 'ours', ceilingMs: 10 });
    expect(waited.failureDetails).toEqual(failureDetails);
    expect(waited.ok).toBe(false);
  });
});

describe('verifyFinishBody — an infrastructure failure carries no failing-test names', () => {
  it('drops failureDetails when the run was killed (no test verdict)', () => {
    const failureDetails = { tests: [{ file: 'one.test.ts', name: 'outer > fails' }], summary: 'x', truncated: false };
    const body = verifyFinishBody({ sha: 'a' }, { exitCode: 137, sha: 'a', failureDetails });
    expect(body.status).toBe('infrastructure-failure');
    expect(body.failureDetails).toBeUndefined();
  });
});

describe('verifyStartBody — optional runId (dispatcher run identity)', () => {
  it('records runId only when given, leaving the existing shape untouched otherwise', () => {
    expect(verifyStartBody({ sha: 'a', suites: 's', startedAt: 't' })).not.toHaveProperty('runId');
    expect(verifyStartBody({ sha: 'a', suites: 's', startedAt: 't', runId: 'r1' })).toMatchObject({ runId: 'r1' });
  });
});

describe('fix-3311: one wait for the entire verify budget', () => {
  it('waits across a 30-minute run in one invocation then reports legacy exit 137 honestly', async () => {
    let elapsed = 0;
    const sha = 'fix3311';
    const result = await waitForVerifySettle({ headSha: sha, readHead: () => sha,
      readRecord: () => elapsed < 31 * 60_000
        ? { sha, status: 'running', startedAt: new Date().toISOString() }
        : { sha, status: 'red', exitCode: 137 },
      ceilingMs: resolveWaitCeilingMs(160 * 60_000),
      now: () => elapsed, sleep: async (ms) => { elapsed += ms; },
    });
    expect(result).toMatchObject({ status: 'infrastructure-failure', reason: 'verify-signal', ok: false, settled: true });
    expect(result.waited.ms).toBe(31 * 60_000);
    expect(result.detail).toContain('SIGKILL');
    // Mandatory mode blocks; advisory mode (requireVerified:false) reports the same status without blocking.
    expect(verifyGateDecision({ record: { sha, status: 'red', exitCode: 137 }, headSha: sha, requireVerified: true }).ok).toBe(false);
    expect(verifyGateDecision({ record: { sha, status: 'red', exitCode: 137 }, headSha: sha, requireVerified: false }))
      .toMatchObject({ ok: true, status: 'infrastructure-failure' });
  });
});

describe('verifyGateDecision — infrastructure-failure decision matrix (requireVerified × record shape)', () => {
  const sha = 'matrix1';
  const longAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const infra = { reason: 'verify-timeout', signal: 'SIGKILL', phase: 'gate', ceilingMs: 1, detail: 'killed' };
  it.each([
    ['terminal infrastructure-failure marker', { sha, status: 'infrastructure-failure', infrastructure: infra }],
    ['same marker long past any TTL (terminal: no TTL escape)', { sha, status: 'infrastructure-failure', infrastructure: infra, startedAt: longAgo, finishedAt: longAgo }],
    ['legacy red marker with a signal exit code', { sha, status: 'red', exitCode: 137 }],
  ])('%s: blocks under requireVerified, reports without blocking under advisory mode', (_label, record) => {
    const mandatory = verifyGateDecision({ record, headSha: sha, requireVerified: true });
    expect(mandatory).toMatchObject({ ok: false, status: 'infrastructure-failure' });
    const advisory = verifyGateDecision({ record, headSha: sha, requireVerified: false });
    expect(advisory).toMatchObject({ ok: true, status: 'infrastructure-failure', reason: mandatory.reason });
    expect(advisory.detail).toContain('opted out of mandatory verification');
  });

  it('a genuine red (non-signal exit) is unchanged: blocks under requireVerified, red-ci-gated under advisory', () => {
    const record = { sha, status: 'red', exitCode: 1 };
    expect(verifyGateDecision({ record, headSha: sha, requireVerified: true })).toMatchObject({ ok: false, status: 'red' });
    expect(verifyGateDecision({ record, headSha: sha, requireVerified: false })).toMatchObject({ ok: true, reason: 'red-ci-gated' });
  });
});

it('timeout retry audit is bound to the finishing run and visible on red/green reads', () => {
  const retriedTimeouts = ['untouched.test.mjs'];
  for (const exitCode of [0, 1]) {
    const record = verifyFinishBody({ sha: 'ours' }, { exitCode, retriedTimeouts });
    expect(record.retriedTimeouts).toEqual(retriedTimeouts);
    const verdict = verifyGateDecision({ record, headSha: 'ours' });
    expect(verdict.retriedTimeouts).toEqual(retriedTimeouts);
    expect(verdict.detail).toContain('untouched.test.mjs');
    expect(verifyFinishBody(record, { exitCode }).retriedTimeouts).toBeUndefined();
  }
});


describe('verifyServerVerdict (#4161)', () => {
  const owner = 'host:123:verify-daemon';
  it.each(['alive', 'unknown'])('held lease + %s pid is alive', (pidLiveness) => {
    expect(verifyServerVerdict({ leaseStatus: { held: true, stale: false, owner }, pidLiveness }))
      .toEqual({ alive: true, owner });
  });
  it.each([
    [{ held: true, stale: false, owner }, 'dead', 'holder-dead'],
    [{ held: false, stale: true, owner }, 'alive', 'stale-lease'],
    [{ held: false, stale: false, owner: null }, 'unknown', 'no-lease'],
  ])('refuses unavailable server %#', (leaseStatus, pidLiveness, reason) => {
    expect(verifyServerVerdict({ leaseStatus, pidLiveness })).toEqual({ alive: false, reason });
  });
});

it('75c: the isolated-retry audit (flaky-outside-diff) survives finish, check and verdict reads', () => {
  const retriedFailures = [{ file: 'untouched.test.mjs', kind: 'assertion' }];
  const record = verifyFinishBody({ sha: 'ours' }, { exitCode: 0, retriedFailures, isolatedRetry: 'flaky-outside-diff' });
  expect(record).toMatchObject({ status: 'green', retriedFailures, isolatedRetry: 'flaky-outside-diff' });
  expect(record.retriedTimeouts).toBeUndefined();
  const verdict = verifyGateDecision({ record, headSha: 'ours' });
  expect(verdict).toMatchObject({ ok: true, retriedFailures, isolatedRetry: 'flaky-outside-diff' });
  expect(verdict.detail).toContain('flaky-outside-diff');
  const red = verifyFinishBody({ sha: 'ours' }, { exitCode: 1, retriedFailures, isolatedRetry: 'still-red' });
  expect(verifyGateDecision({ record: red, headSha: 'ours' })).toMatchObject({ ok: false, isolatedRetry: 'still-red' });
  expect(verifyFinishBody(record, { exitCode: 0 }).retriedFailures).toBeUndefined();
});

// #5189 — the marker-nonce suffix is the one format both verify-lane (writer) and verify-dispatch (checker) share.
it('markerNonceSuffix formats a hex nonce and fails closed to empty on anything else', async () => {
  const { markerNonceSuffix, VERIFY_MARKER_NONCE_ENV } = await import('../lib/lane-verify.mjs');
  expect(VERIFY_MARKER_NONCE_ENV).toBe('WE_VERIFY_MARKER_NONCE');
  expect(markerNonceSuffix('abcdef0123456789')).toBe(' [nonce=abcdef0123456789]');
  for (const bad of [undefined, null, '', 'short', 'zz'.repeat(8), 'ab\ncd'.repeat(4), 42, 'abcdef0123456789 trailing']) {
    expect(markerNonceSuffix(bad)).toBe('');
  }
});
