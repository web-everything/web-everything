// One `status:*` label per PR — what it is waiting on (operator ask 2026-10-10: #4708/#4689/#4631 sat at the
// round cap and their labels did not show it).
import { describe, it, expect } from 'vitest';
import { derivePrStatusLabel, planPrStatusLabel, PR_STATUS_LABEL_RE, operatorQueueNeedsYou } from '../pr-status-label.mjs';
import { tagReviewStatus, LEGACY_REVIEW_STATUS_DEFAULT } from '../review-status-tag.mjs';
import { evaluatePr } from '../../operations/operator-queue.mjs';
import { STAND_DOWN_MARKER } from '../stand-down.mjs';
import { takeoverMarkerBody } from '../fix-takeover.mjs';

const BOT = { login: 'web-everything' };
const HEAD = 'a'.repeat(40);
const at = (h) => `2026-10-10T${String(h).padStart(2, '0')}:00:00Z`;
const marker = (h) => ({ author: BOT, createdAt: at(h), body: takeoverMarkerBody({ pr: 7, head: HEAD, attempts: 5, cap: 5, rung: { id: 'x' } }) });
const advisory = (h) => ({ author: BOT, createdAt: at(h), body: `**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.** x\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\`` });
const pr = (labels = [], comments = [], over = {}) => ({ number: 7, headRefOid: HEAD, baseRefName: 'main', labels: labels.map((name) => ({ name })), comments, ...over });
const derive = (o) => derivePrStatusLabel({ humanAt: 99, ...o });

describe('derivePrStatusLabel', () => {
  it('at the round cap: a planned takeover, a takeover head awaiting its one review, or a capped PR read at-round-limit', () => {
    expect(derive({ pr: pr(['review:changes']), rows: [{ kind: 'fix', mode: 'takeover' }] })).toBe('at-round-limit');
    expect(derive({ pr: pr(['review:pending']), rows: [{ kind: 'review', takeoverReview: { ok: true } }] })).toBe('at-round-limit');
    expect(derive({ pr: pr(['review:changes']), rows: [{ kind: 'takeover-awaiting-review' }] })).toBe('at-round-limit');
  });
  it('a live fixer on an unjudged takeover is takeover-running; once judged, plain fixing', () => {
    expect(derive({ pr: pr(['review:changes'], [marker(7)]), reviewStatus: { role: 'fix', state: 'fixing' } })).toBe('takeover-running');
    expect(derive({ pr: pr(['review:changes'], [marker(7), advisory(8)]), reviewStatus: { role: 'fix', state: 'fixing' } })).toBe('fixing');
  });
  it('a spent budget, a non-converging takeover or a ruling dispute is the operator\'s: escalated', () => {
    expect(derive({ pr: pr(['review:changes']), rows: [{ kind: 'cap-exhausted', takeover: 'takeover-budget-spent' }] })).toBe('escalated');
    // a takeover switched off (budget 0 or invalid) asks the operator too: it is not "a takeover is planned"
    expect(derive({ pr: pr(['review:changes']), rows: [{ kind: 'cap-exhausted', takeover: 'setting-disabled' }] })).toBe('escalated');
    expect(derive({ pr: pr(['review:changes']), rows: [{ kind: 'cap-exhausted', takeover: 'takeover-not-converging' }] })).toBe('escalated');
    expect(derive({ pr: pr([]), rows: [{ kind: 'ruling-dispute' }] })).toBe('escalated');
  });
  it('the waiting states, and accepted = ready-to-merge', () => {
    expect(derive({ pr: pr(['review:pending']), reviewStatus: { role: 'draft', state: 'awaiting-base' } })).toBe('waiting-on-base');
    expect(derive({ pr: pr([]), rows: [{ kind: 'gate-hold', hold: 'stacked-base-unmerged' }] })).toBe('waiting-on-base');
    expect(derive({ pr: pr(['review:pending']), rows: [{ kind: 'review-ci' }] })).toBe('awaiting-ci');
    expect(derive({ pr: pr(['review:pending']), rows: [{ kind: 'review' }] })).toBe('awaiting-review');
    expect(derive({ pr: pr(['review:accepted']) })).toBe('ready-to-merge');
    expect(derive({ pr: pr([]) })).toBeNull();
  });
});

describe('planPrStatusLabel: exactly one status label', () => {
  it('adds the desired one and removes every other status:* label', () => {
    expect(planPrStatusLabel({ state: 'fixing', currentLabels: ['status:awaiting-review', 'status:needs-you', 'review:changes'] }))
      .toEqual({ add: 'status:fixing', remove: ['status:awaiting-review', 'status:needs-you'] });
    expect(planPrStatusLabel({ state: 'fixing', currentLabels: ['status:fixing'] })).toEqual({ add: null, remove: [] });
    expect(planPrStatusLabel({ state: null, currentLabels: ['status:fixing'] })).toEqual({ add: null, remove: ['status:fixing'] });
    expect(PR_STATUS_LABEL_RE.test('status:bogus')).toBe(false);
  });
});

describe('tagReviewStatus writes the status label in the same pass (one writer)', () => {
  it('the same writer applies the review-status and the status:* label', () => {
    const calls = [];
    const provider = { readLabels: () => [], ensureLabel: () => {}, setLabels: (repo, n, change) => calls.push(change), readPrState: () => null };
    const r = tagReviewStatus({ pr: 7, repo: 'web-everything/web-everything', provider, agents: [], currentLabels: [{ name: 'review:changes' }],
      prState: pr(['review:changes']), readFixClaim: () => ({ meta: {} }), planRows: [] });
    expect(calls.map((c) => c.add)).toEqual(['review-status:fixing', 'status:fixing']);
    expect(r.prStatus).toBe('status:fixing');
  });
});

const check = (name, conclusion = 'SUCCESS') => ({ name, status: 'COMPLETED', conclusion });
const verdict = (head = HEAD, outcome = 'accept') => ({ author: BOT, createdAt: at(6),
  body: `**Verdict:** ${outcome}\n**Advisory outcome:** ${outcome}\nNet basis: \`${'0'.repeat(40)}..${head}\`` });
const stand = (h = 7) => ({ author: BOT, createdAt: at(h), body: STAND_DOWN_MARKER });
const human = (h = 8, login = 'chalbert') => ({ author: { login }, createdAt: at(h), body: 'Please continue.' });

describe('truthful stage regressions', () => {
  it('#4715: an answered stand-down with stale changes belongs to the fixer', () => {
    const subject = pr(['review:human', 'review-round:5', 'advisory:changes', 'status:needs-you'],
      [verdict('b'.repeat(40), 'changes'), stand(), human()], { mergeStateStatus: 'CLEAN', statusCheckRollup: [check('test')] });
    expect(operatorQueueNeedsYou(subject, { humanAt: 99 })).toBe(false);
    const state = derive({ pr: subject, rows: [{ kind: 'stood-down' }] });
    expect(state).toBe('answered-waiting-fixer');
    expect(planPrStatusLabel({ state, currentLabels: subject.labels })).toEqual({ add: 'status:answered-waiting-fixer', remove: ['status:needs-you'] });
  });
  it('matches the queue, including mergeability and CI gates on daemon snapshots', () => {
    const subject = pr(['review:human', 'advisory:accepted'], [verdict()], { mergeStateStatus: 'CLEAN', statusCheckRollup: [check('test')] });
    expect(evaluatePr({ ...subject, mergeable: 'MERGEABLE' }).ready).toBe(true);
    expect(operatorQueueNeedsYou(subject)).toBe(true);
    expect(derive({ pr: subject })).toBe('needs-you');
    for (const mergeStateStatus of ['DIRTY', 'UNKNOWN', undefined]) expect(operatorQueueNeedsYou({ ...subject, mergeStateStatus })).toBe(false);
    expect(operatorQueueNeedsYou({ ...subject, mergeable: 'CONFLICTING' })).toBe(false);
    expect(operatorQueueNeedsYou({ ...subject, statusCheckRollup: [check('test', 'FAILURE')] })).toBe(false);
  });
  it('#4814: required red replaces readiness and green restores it, leaving the bare label alone', () => {
    const subject = pr(['ready-to-merge', 'review:accepted', 'status:ready-to-merge'], [], { statusCheckRollup: [check('test', 'FAILURE')] });
    const state = derive({ pr: subject });
    expect(state).toBe('ci-red');
    expect(planPrStatusLabel({ state, currentLabels: subject.labels })).toEqual({ add: 'status:ci-red', remove: ['status:ready-to-merge'] });
    expect(derive({ pr: { ...subject, statusCheckRollup: [check('test'), check('review-gate', 'FAILURE')] } })).toBe('ready-to-merge');
  });
  it('required checks handle context failures, injected requirements and live repair precedence', () => {
    for (const state of ['FAILURE', 'ERROR']) expect(derive({ pr: pr([], [], { statusCheckRollup: [{ context: 'test', state }] }) })).toBe('ci-red');
    expect(derive({ pr: pr([], [], { statusCheckRollup: [check('custom', 'CANCELLED')] }), requiredChecks: ['custom'] })).toBe('ci-red');
    for (const conclusion of ['SUCCESS', 'SKIPPED', 'NEUTRAL']) expect(derive({ pr: pr(['review:accepted'], [], { statusCheckRollup: [check('test', conclusion)] }) })).toBe('ready-to-merge');
    expect(derive({ pr: pr(['ci:failed']), rows: [{ kind: 'review' }] })).toBe('ci-red');
    expect(derive({ pr: pr(['review:accepted', 'ci:failed']), reviewStatus: { role: 'ci-heal', state: 'healing-ci' } })).toBe('fixing');
    expect(derive({ pr: pr(['ci:failed']), reviewStatus: { role: 'ci-heal', state: 'needs-human' } })).toBe('ci-red');
    expect(derive({ reviewStatus: { role: 'ci-heal', state: 'needs-human' } })).toBe('escalated');
  });
  it('distinguishes unanswered, answered, and subsequently renewed stand-downs', () => {
    expect(derive({ pr: pr([], [stand()]) })).toBe('stood-down');
    for (const login of ['web-everything', 'github-actions', 'worker[bot]']) expect(derive({ pr: pr([], [stand(), human(8, login)]) })).toBe('stood-down');
    expect(derive({ pr: pr([], [human(), stand(9), stand(7)]) })).toBe('stood-down');
    expect(derive({ rows: [{ kind: 'stood-down' }] })).toBe('stood-down');
    expect(derive({ pr: pr(['review:changes']) })).toBe('sent-back-review');
    expect(derive({ pr: pr([], [verdict(HEAD, 'changes')]) })).toBe('sent-back-review');
    expect(derive({ pr: pr([], [verdict('b'.repeat(40), 'changes')]) })).toBeNull();
    expect(derive({ rows: [{ kind: 'fix' }] })).toBe('fixing');
    expect(planPrStatusLabel({ state: 'waiting-on-base', currentLabels: ['status:awaiting-base'] })).toEqual({ add: 'status:waiting-on-base', remove: ['status:awaiting-base'] });
  });
  it('gates legacy writes, removes every old stage, and preserves the durable withdrawal marker', () => {
    expect(LEGACY_REVIEW_STATUS_DEFAULT).toBe(true);
    for (const legacyReviewStatus of [true, false]) {
      const calls = [];
      const provider = { ensureLabel: () => {}, setLabels: (repo, n, change) => calls.push(change) };
      const result = tagReviewStatus({ pr: 7, repo: 'web-everything/web-everything', provider, agents: [],
        currentLabels: ['review-status:fixing', 'review-status:stood-down', 'review-status:draft-withdrawn'],
        prState: pr([]), readFixClaim: () => ({ meta: {} }), planRows: [], legacyReviewStatus });
      expect(result.prStatus).toBe('status:fixing');
      if (!legacyReviewStatus) {
        expect(calls.some(c => c.add?.startsWith('review-status:'))).toBe(false);
        expect(calls.flatMap(c => c.remove)).toEqual(expect.arrayContaining(['review-status:fixing', 'review-status:stood-down']));
        expect(calls.flatMap(c => c.remove)).not.toContain('review-status:draft-withdrawn');
      }
    }
  });
});
