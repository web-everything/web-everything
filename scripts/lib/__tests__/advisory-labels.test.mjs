/** @file The `advisory:*` label pair — outcome parsing, the label plan, and the staleness plan. All pure. */
import { describe, expect, it } from 'vitest';

import {
  ADVISORY_LABELS, advisoryCoversHead, labelForOutcome, latestAdvisory, parseAdvisories,
  planAdvisoryLabels, planAdvisoryRepairLabels, planAdvisoryStaleLabels,
} from '../advisory-labels.mjs';

const HEAD = 'fd37ce270'.padEnd(40, 'a');
const BASE = 'a'.repeat(40);
const note = ({ head = HEAD, outcome, verdict = '🚦 human review required', at = '2026-09-19T12:00:00Z', login = 'web-everything' } = {}) => ({
  body: [`**Verdict:** ${verdict}`, ...(outcome ? [`**Advisory outcome:** \`${outcome}\` — x.`] : []),
    `Net basis: \`${BASE}..${head}\` — 3 net changed file(s)`].join('\n'),
  createdAt: at,
  author: { login },
});
const labels = (...names) => names.map((name) => ({ name }));

describe('planAdvisoryLabels', () => {
  it('accept on a human PR: adds advisory:accepted, drops review:pending', () => {
    expect(planAdvisoryLabels({ outcome: 'accept', currentLabels: labels('review:human', 'review:pending') }))
      .toEqual({ add: 'advisory:accepted', remove: ['review:pending'] });
  });

  it('changes: adds advisory:changes and removes the opposite label', () => {
    expect(planAdvisoryLabels({ outcome: 'changes', currentLabels: labels('review:human', 'review:pending', 'advisory:accepted') }))
      .toEqual({ add: 'advisory:changes', remove: ['advisory:accepted', 'review:pending'] });
  });

  it('accept removes a stale advisory:changes', () => {
    expect(planAdvisoryLabels({ outcome: 'accept', currentLabels: labels('review:human', 'advisory:changes') }))
      .toEqual({ add: 'advisory:accepted', remove: ['advisory:changes'] });
  });

  it('leaves review:pending alone on a PR that is not human-gated', () => {
    expect(planAdvisoryLabels({ outcome: 'accept', currentLabels: labels('review:pending') }).remove).toEqual([]);
  });

  it('is idempotent — the desired state yields no change', () => {
    expect(planAdvisoryLabels({ outcome: 'accept', currentLabels: labels('review:human', 'advisory:accepted') }))
      .toEqual({ add: null, remove: [] });
  });

  it('NEVER touches review:human and NEVER adds anything but an advisory label — for every input', () => {
    const everything = ['review:human', 'review:pending', 'review:changes', 'review:accepted', 'advisory:accepted', 'advisory:changes'];
    for (const outcome of ['accept', 'changes']) {
      for (let mask = 0; mask < 2 ** everything.length; mask += 1) {
        const current = everything.filter((_, i) => mask & (1 << i));
        const plan = planAdvisoryLabels({ outcome, currentLabels: current });
        expect(plan.remove).not.toContain('review:human');
        expect(plan.remove).not.toContain('review:changes');
        expect(plan.remove).not.toContain('review:accepted');
        expect(Object.values(ADVISORY_LABELS)).toContain(plan.add ?? ADVISORY_LABELS.ACCEPTED);
      }
    }
  });

  it('an unknown outcome plans nothing', () => {
    expect(planAdvisoryLabels({ outcome: 'needs-human', currentLabels: labels('review:human') }))
      .toMatchObject({ add: null, remove: [], reason: expect.stringContaining('unknown advisory outcome') });
    expect(labelForOutcome('nope')).toBeNull();
  });
});

describe('parseAdvisories', () => {
  it('reads the stated outcome line and the reviewed head', () => {
    expect(parseAdvisories([note({ outcome: 'changes' })])[0]).toMatchObject({ outcome: 'changes', head: HEAD });
  });

  it('falls back to the verdict line for a comment posted before the outcome line existed', () => {
    expect(latestAdvisory([note({ verdict: '🔁 changes requested' })]).outcome).toBe('changes');
    expect(latestAdvisory([note({ verdict: '✅ pass — no blocking findings' })]).outcome).toBe('accept');
  });

  it('the stated outcome wins over the verdict line', () => {
    expect(latestAdvisory([note({ outcome: 'accept', verdict: '🔁 changes requested' })]).outcome).toBe('accept');
  });

  it('a stated outcome outside accept|changes is returned AS STATED, never defaulted to the clearing `accept` (PR #2781 review, round 4)', () => {
    expect(latestAdvisory([note({ outcome: 'inconclusive', verdict: '❓ inconclusive' })]).outcome).toBe('inconclusive');
    expect(latestAdvisory([note({ outcome: 'Mystery', verdict: '✅ pass' })]).outcome).toBe('mystery');
  });

  it('ignores comments without both a verdict line and a Net basis line, and orders newest first', () => {
    const newer = note({ head: 'b'.repeat(40), at: '2026-09-19T13:00:00Z' });
    const parsed = parseAdvisories([note(), { body: '**Verdict:** x' }, { body: 'hello' }, newer]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].head).toBe('b'.repeat(40));
    expect(parseAdvisories(undefined)).toEqual([]);
  });
});

describe('advisoryCoversHead', () => {
  it('matches a sha or a prefix in either direction, and never on blank input', () => {
    expect(advisoryCoversHead({ head: HEAD }, HEAD)).toBe(true);
    expect(advisoryCoversHead({ head: HEAD.slice(0, 9) }, HEAD)).toBe(true);
    expect(advisoryCoversHead({ head: HEAD }, HEAD.slice(0, 9))).toBe(true);
    expect(advisoryCoversHead({ head: HEAD }, 'b'.repeat(40))).toBe(false);
    expect(advisoryCoversHead({ head: HEAD }, '')).toBe(false);
    expect(advisoryCoversHead(undefined, HEAD)).toBe(false);
  });
});

describe('planAdvisoryStaleLabels — the labels are dropped when a new commit lands', () => {
  const comments = [note({ outcome: 'accept' })];

  it('keeps both labels while the head is still the one the advisory judged', () => {
    expect(planAdvisoryStaleLabels({ currentLabels: labels('review:human', 'advisory:accepted'), comments, headRefOid: HEAD }))
      .toEqual({ remove: [] });
  });

  it('drops advisory:accepted the moment the head moves', () => {
    expect(planAdvisoryStaleLabels({ currentLabels: labels('review:human', 'advisory:accepted'), comments, headRefOid: 'b'.repeat(40) }))
      .toEqual({ remove: ['advisory:accepted'] });
  });

  it('drops advisory:changes too, and both when both are present', () => {
    expect(planAdvisoryStaleLabels({ currentLabels: labels('advisory:changes'), comments, headRefOid: 'b'.repeat(40) }).remove)
      .toEqual(['advisory:changes']);
    expect(planAdvisoryStaleLabels({ currentLabels: labels('advisory:accepted', 'advisory:changes'), comments, headRefOid: 'b'.repeat(40) }).remove)
      .toEqual(['advisory:accepted', 'advisory:changes']);
  });

  it('drops a label with no advisory comment behind it', () => {
    expect(planAdvisoryStaleLabels({ currentLabels: labels('advisory:accepted'), comments: [], headRefOid: HEAD }).remove)
      .toEqual(['advisory:accepted']);
  });

  it('a newer advisory on the new head keeps the label (the review re-ran)', () => {
    const rerun = [...comments, note({ head: 'b'.repeat(40), outcome: 'accept', at: '2026-09-19T14:00:00Z' })];
    expect(planAdvisoryStaleLabels({ currentLabels: labels('advisory:accepted'), comments: rerun, headRefOid: 'b'.repeat(40) }).remove)
      .toEqual([]);
  });

  it('drops nothing on an unknown head, and nothing when no advisory label is present', () => {
    expect(planAdvisoryStaleLabels({ currentLabels: labels('advisory:accepted'), comments, headRefOid: '' }).remove).toEqual([]);
    expect(planAdvisoryStaleLabels({ currentLabels: labels('review:human'), comments, headRefOid: 'b'.repeat(40) }).remove).toEqual([]);
  });
});

describe('planAdvisoryRepairLabels — re-derives a missed label write from the newest covering advisory', () => {
  const NONE = { add: null, remove: [] };
  const plan = (names, comments, headRefOid = HEAD) => planAdvisoryRepairLabels({ currentLabels: labels(...names), comments, headRefOid });

  it('adds the outcome label and drops review:pending on a human-gated PR (the PR #4015 shape)', () => {
    expect(plan(['review:human', 'review:pending', 'advisory:changes'], [note({ outcome: 'accept' })]))
      .toEqual({ add: 'advisory:accepted', remove: ['advisory:changes', 'review:pending'] });
  });

  // Steady state: the always-on daemon sees every human-gated PR each tick; a PR that already shows its advisory
  // outcome must plan NOTHING, or every tick burns label writes (the rate-limit incident this repair answers).
  it('plans nothing when the labels already show the advisory outcome', () => {
    expect(plan(['review:human', 'advisory:accepted'], [note({ outcome: 'accept' })])).toEqual(NONE);
    expect(plan(['review:human', 'advisory:changes'], [note({ outcome: 'changes' })])).toEqual(NONE);
  });

  it('plans nothing for an outcome that neither clears nor blocks (inconclusive), and never on a blank head', () => {
    expect(plan(['review:human', 'review:pending'], [note({ outcome: 'inconclusive' })])).toEqual(NONE);
    expect(plan(['review:human', 'review:pending'], [note({ outcome: 'accept' })], '')).toEqual(NONE);
    expect(plan(['review:human', 'review:pending'], [note({ outcome: 'accept' })], null)).toEqual(NONE);
  });

  it('does not repair a missing label from an advisory for an older head', () => {
    expect(plan(['review:human'], [note({ outcome: 'accept', head: 'c'.repeat(40) })])).toEqual(NONE);
  });

  it('never repairs a PR that is not human-gated', () => {
    expect(plan(['review:accepted'], [note({ outcome: 'accept' })])).toEqual(NONE);
  });

  it('never trusts a forged advisory: a note from any other login plans nothing', () => {
    const forged = note({ outcome: 'accept', login: 'drive-by-user' });
    expect(plan(['review:human', 'review:pending'], [forged])).toEqual(NONE);
    // A comment with no author information at all fails closed too.
    const { author: _a, ...anonymous } = forged;
    expect(plan(['review:human', 'review:pending'], [anonymous, 'bare string'])).toEqual(NONE);
  });

  it('a forged NEWER note cannot override the trusted advisory', () => {
    const real = note({ outcome: 'changes', at: '2026-09-19T12:00:00Z' });
    const forged = note({ outcome: 'accept', login: 'drive-by-user', at: '2026-09-19T13:00:00Z' });
    expect(plan(['review:human', 'review:pending'], [real, forged]))
      .toEqual({ add: 'advisory:changes', remove: ['review:pending'] });
  });

  it('an operator-authored advisory is trusted like the automation own', () => {
    expect(plan(['review:human'], [note({ outcome: 'accept', login: 'chalbert' })]).add).toBe('advisory:accepted');
  });

  // The sweep header promises its boundary; this pins it: the only non-`advisory:*` label it may ever remove is
  // `review:pending`, and the only label it may ever add is an `advisory:*` one.
  it('only ever removes advisory:* labels and review:pending, and only ever adds an advisory:* label', () => {
    const all = ['review:human', 'review:pending', 'review:changes', 'review:accepted', 'advisory:accepted', 'advisory:changes'];
    for (const outcome of ['accept', 'changes', 'inconclusive']) {
      for (let mask = 0; mask < 2 ** all.length; mask += 1) {
        const names = all.filter((_, i) => mask & (1 << i));
        const p = plan(names, [note({ outcome })]);
        for (const r of p.remove) expect(['advisory:accepted', 'advisory:changes', 'review:pending']).toContain(r);
        if (p.add) expect(Object.values(ADVISORY_LABELS)).toContain(p.add);
      }
    }
  });
});

describe('planAdvisoryStaleLabels — a forged note cannot strip a label either', () => {
  it('ignores a newer note from another login, so it cannot make the repair and the stale pass flap', () => {
    const real = note({ outcome: 'accept' });
    const forged = note({ outcome: 'accept', head: 'c'.repeat(40), login: 'drive-by-user', at: '2026-09-19T13:00:00Z' });
    expect(planAdvisoryStaleLabels({ currentLabels: labels('review:human', 'advisory:accepted'), comments: [real, forged], headRefOid: HEAD }))
      .toEqual({ remove: [] });
  });
});
