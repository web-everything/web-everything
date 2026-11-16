/**
 * Acceptance matrix for the review hold model (design review-hold-model §3).
 * The oracle below is LITERAL: it is never imported from, nor computed by, the model.
 */
import { describe, expect, it } from 'vitest';
import { DRAIN_GATES, GATE_IDS } from '../merge-gate-inventory.mjs';
import { formatPrResult } from '../merge-gate-verdict.mjs';
import { deriveReviewHold, serializeReviewHold } from '../review-hold-model.mjs';

const HEAD = 'a'.repeat(40);
const PR = 7001;

// Literal canonical hold reasons per probed gate.
const PROBE_REASON = {
  'required-check-read': 'required checks unreadable',
  'candidate-label': 'missing ready-to-merge label',
  'producer-certified': 'not certified by a producer',
  'default-base': 'base is not the default branch',
  'required-check-green': 'a required check is not green',
  codeql: 'CodeQL failed',
  mergeable: 'PR is not mergeable',
  'landable-state': 'branch is behind',
  'non-empty-body': 'PR body is empty',
  'red-team': 'no red-team check run on head',
  'review-hold-labels': 'review:pending label present',
  'review-acceptance': 'review acceptance does not cover the head',
  'manifest-baseline': 'manifest changed since baseline',
  'test-gaming': 'test tampering needs human clearance',
  'head-pin': 'head moved',
  freshness: 'branch is stale against main',
  'red-main-freeze': 'main is RED (freeze: main CI red on abc)',
  'duplicate-id-on-main': 'duplicate backlog id on main',
  'couple-whole': 'couple partner pending',
  'blocked-by': 'blocked by an open item',
  'overlap-yield': 'yields to an overlapping PR',
  'card-group': 'waits for the combined PR',
  'pass-cap': 'pass cap reached',
  ledger: 'labels: review labels still hold',
};

// Literal oracle: 5 R + 1 H + 1 A + 17 X = 24.
const ORACLE_CLASS = {
  'candidate-label': 'R', 'producer-certified': 'R', 'review-hold-labels': 'R', 'review-acceptance': 'R', ledger: 'R',
  'test-gaming': 'H',
  'red-team': 'A',
  'required-check-read': 'X', 'default-base': 'X', 'required-check-green': 'X', codeql: 'X', mergeable: 'X',
  'landable-state': 'X', 'non-empty-body': 'X', 'manifest-baseline': 'X', 'head-pin': 'X', freshness: 'X',
  'red-main-freeze': 'X', 'duplicate-id-on-main': 'X', 'couple-whole': 'X', 'blocked-by': 'X', 'overlap-yield': 'X',
  'card-group': 'X', 'pass-cap': 'X',
};

const RT_AXIS = {
  pass: null,
  pending: 'red-team check run in progress or incomplete',
  missing: 'no red-team check run on head',
  fail: 'red-team check run failed (failure)',
};

const clear = (id) => ({ id, status: DRAIN_GATES.find((g) => g.id === id).where === 'merge-gate' ? 'pass'
  : DRAIN_GATES.find((g) => g.id === id).where, reason: 'ok' });

function build({ probe, rt, human }) {
  const holds = new Map();
  if (probe !== 'red-team') holds.set(probe, PROBE_REASON[probe]);
  if (RT_AXIS[rt]) holds.set('red-team', RT_AXIS[rt]);
  if (human) { holds.set('review-hold-labels', PROBE_REASON['review-hold-labels']); holds.set('test-gaming', PROBE_REASON['test-gaming']); }
  const results = GATE_IDS.map((id) => (holds.has(id) ? { id, status: 'hold', reason: holds.get(id) } : clear(id)));
  const logText = [formatPrResult({ num: PR, ok: holds.size === 0, results }),
    `merge-gate: HOLD — held`].join('\n');
  return { holds, input: {
    headSha: HEAD, prNumber: PR, labels: ['review:pending'], freeze: { frozen: true },
    mergeGate: { state: 'completed', conclusion: 'failure', runId: 11, jobId: 22, jobHeadSha: HEAD, latest: true,
      completedAt: '2026-11-16T00:00:00Z', logText },
    reviewGate: { state: 'success', runId: 31, jobId: 32, jobHeadSha: HEAD, latest: true },
  } };
}

/** Literal per-case expectation, derived only from the literal tables above. */
function expected({ probe, rt, human, holds }) {
  const classes = [...holds.keys()].map((id) => (id === 'red-team' ? (rt === 'fail' ? 'X' : 'A') : ORACLE_CLASS[id]));
  const noBlocking = holds.size === 0;
  const hasX = classes.includes('X');
  const publishable = !noBlocking && !hasX;
  const candidacy = publishable && !human && classes.every((c) => c === 'R' || c === 'A');
  const firstX = GATE_IDS.find((id) => holds.has(id) && (id === 'red-team' ? rt === 'fail' : ORACLE_CLASS[id] === 'X'));
  const reason = noBlocking ? 'merge-gate:header-not-hold' : !hasX ? 'publishable' : rt === 'fail' ? 'red-team-failed' : `real-hold:${firstX}`;
  return { publishable, candidacy, reason, annotated: publishable && !candidacy };
}

const cases = [];
for (const probe of GATE_IDS) for (const rt of Object.keys(RT_AXIS)) for (const human of [false, true]) cases.push({ probe, rt, human });

describe('review hold model: 192-case matrix', () => {
  it('enumerates 24 x 4 x 2 = 192 cases and the oracle covers every inventory gate', () => {
    expect(cases).toHaveLength(192);
    expect(Object.keys(ORACLE_CLASS).sort()).toEqual([...GATE_IDS].sort());
    expect(Object.values(ORACLE_CLASS).filter((c) => c === 'R')).toHaveLength(5);
    expect(Object.values(ORACLE_CLASS).filter((c) => c === 'X')).toHaveLength(17);
  });

  it.each(cases.map((c) => [`${c.probe} | red-team=${c.rt} | human=${c.human}`, c]))('%s', (_n, c) => {
    const { holds, input } = build(c);
    const want = expected({ ...c, holds });
    const got = deriveReviewHold(input);
    expect(got.publishable).toBe(want.publishable);
    expect(got.candidacy).toBe(want.candidacy);
    expect(got.reason).toBe(want.reason);
    const ann = serializeReviewHold(got);
    expect(Boolean(ann)).toBe(want.annotated);
    if (ann) {
      expect(ann.reviewHold.v).toBe(2);
      expect(ann.reviewHold.headSha).toBe(HEAD);
      expect(ann.reviewHold.jobId).toBe(22);
    }
  });

  describe('named rows', () => {
    it.each(['missing', 'pending'])('round-5: test-gaming + review-hold-labels + red-team %s -> publishable, not candidacy, annotated', (rt) => {
      const { input } = build({ probe: 'test-gaming', rt, human: true });
      const got = deriveReviewHold(input);
      expect(got.publishable).toBe(true);
      expect(got.candidacy).toBe(false);
      expect(serializeReviewHold(got)).not.toBeNull();
      expect(got.holds.map((h) => [h.id, h.class]).sort()).toEqual(
        [['red-team', 'A'], ['review-hold-labels', 'R'], ['test-gaming', 'H']]);
    });

    it('red-team-pass control: review-hold-labels + test-gaming is publishable, not candidacy, annotated', () => {
      const { input } = build({ probe: 'test-gaming', rt: 'pass', human: true });
      const got = deriveReviewHold(input);
      expect(got.publishable).toBe(true);
      expect(got.candidacy).toBe(false);
      expect(serializeReviewHold(got)).not.toBeNull();
    });

    it('red-team failed with the round-5 pair is never publishable', () => {
      const { input } = build({ probe: 'test-gaming', rt: 'fail', human: true });
      const got = deriveReviewHold(input);
      expect(got.publishable).toBe(false);
      expect(got.reason).toBe('red-team-failed');
    });

    it('a pure candidacy red (review-hold-labels + red-team missing) is publishable AND candidacy, with no annotation', () => {
      const { input } = build({ probe: 'review-hold-labels', rt: 'missing', human: false });
      const got = deriveReviewHold(input);
      expect(got.publishable).toBe(true);
      expect(got.candidacy).toBe(true);
      expect(serializeReviewHold(got)).toBeNull();
    });
  });
});
