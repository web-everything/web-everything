// One `status:*` label per PR — what it is waiting on (operator ask 2026-10-10: #4708/#4689/#4631 sat at the
// round cap and their labels did not show it).
import { describe, it, expect, vi } from 'vitest';
import { derivePrStatusLabel, planPrStatusLabel, PR_STATUS_LABEL_RE, operatorQueueNeedsYou } from '../pr-status-label.mjs';
import { tagReviewStatus as tagReviewStatusIo, LEGACY_REVIEW_STATUS_DEFAULT } from '../review-status-tag.mjs';
import { evaluatePr } from '../../operations/operator-queue.mjs';
import { STAND_DOWN_MARKER } from '../stand-down.mjs';
import { takeoverMarkerBody } from '../fix-takeover.mjs';

import { resolvePrStatusSettings, loadPrStatusSettings, prStatusSettingValues, PR_STATUS_SETTING_DEFAULTS } from '../pr-status-settings.mjs';

const tagReviewStatus = (options) => tagReviewStatusIo({
  readRequiredChecks: () => ({ checks: undefined }), loadStatusSettings: () => { throw new Error('settings unavailable'); },
  excuseMergeGate: pr => pr,
  ...options,
});

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
  it('a delayed review of the head before the takeover does not judge it: still takeover-running', () => {
    const OLD = 'b'.repeat(40);
    const oldReview = (h) => ({ ...advisory(h), body: advisory(h).body.replace(HEAD, OLD) });
    const oldMarker = { ...marker(7), body: takeoverMarkerBody({ pr: 7, head: OLD, attempts: 5, cap: 5, rung: { id: 'x' } }) };
    expect(derive({ pr: pr(['review:changes'], [oldReview(6), oldMarker, oldReview(8)]), reviewStatus: { role: 'fix', state: 'fixing' } })).toBe('takeover-running');
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

describe('a paused review does not judge the takeover (live #4708)', () => {
  const paused = (h) => ({ author: BOT, createdAt: at(h), body: `**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.** Pending: 2 mandatory referral(s) await a ruling\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\`` });
  it('a live fixer after a takeover whose review only paused is still a running takeover', () => {
    expect(derive({ pr: pr([], [marker(1), paused(2)]), reviewStatus: { role: 'fix', state: 'fixing' } })).toBe('takeover-running');
    expect(derive({ pr: pr([], [marker(1), advisory(2)]), reviewStatus: { role: 'fix', state: 'fixing' } })).toBe('fixing');
  });
  it('the last takeover head\'s owed review is at-round-limit, not needs-you', () => {
    expect(derive({ pr: pr([], [marker(1), paused(2)]), rows: [{ kind: 'review', takeoverReview: { ok: true } }] })).toBe('at-round-limit');
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

describe('accepted PRs in the post-accept red team (#5241, #5258, #5268)', () => {
  const requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
  const labels = ['review:accepted', 'review-status:reviewing', 'review-round:1'];
  const subject = (extraLabels = [], over = {}) => pr([...labels, ...extraLabels], [], {
    statusCheckRollup: requiredChecks.map(name => check(name)), ...over,
  });
  const reviewStatus = { role: 'review', state: 'reviewing' };
  it.each([5241, 5258, 5268])('#%i: accepted with a live reviewer is red-team', (number) => {
    expect(derive({ pr: subject([], { number }), requiredChecks, reviewStatus })).toBe('red-team');
  });
  it('keeps a stalled reviewer in red-team', () => {
    expect(derive({ pr: subject(), requiredChecks, reviewStatus: { role: 'review', state: 'review-stalled' } })).toBe('red-team');
  });
  it('respects the explicit ready-to-merge label and the compatibility setting', () => {
    expect(derive({ pr: subject(['ready-to-merge']), requiredChecks, reviewStatus })).toBe('ready-to-merge');
    expect(derive({ pr: subject(), requiredChecks, reviewStatus, settings: { acceptedRedTeamStatus: 'ready-to-merge' } })).toBe('ready-to-merge');
  });
  it('requires a live running reviewer, not just the persisted review-status label', () => {
    for (const status of [null, { role: 'draft', state: 'reviewing' }, { role: 'review', state: 'awaiting-ci' }]) {
      expect(derive({ pr: subject(), requiredChecks, reviewStatus: status })).toBe('ready-to-merge');
    }
  });
  it('required red CI still wins over the live red team', () => {
    expect(derive({ pr: subject([], { statusCheckRollup: requiredChecks.map(name => check(name, name === 'test' ? 'FAILURE' : 'SUCCESS')) }),
      requiredChecks, reviewStatus })).toBe('ci-red');
  });
  it('recognizes status:red-team and replaces the stale awaiting-review status', () => {
    expect(PR_STATUS_LABEL_RE.test('status:red-team')).toBe(true);
    expect(planPrStatusLabel({ state: 'red-team', currentLabels: [...labels, 'status:awaiting-review'] }))
      .toEqual({ add: 'status:red-team', remove: ['status:awaiting-review'] });
  });
});

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


describe('required CI determines status (#5241, #5267, #5270, #5254)', () => {
  const requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
  const green = () => requiredChecks.map(name => check(name));
  const row = (affected) => ({ kind: 'review-ci', ci: { reason: 'required-checks-not-successful', affected } });
  const reviewRow = { kind: 'review-ci', ci: { reason: 'required-review-gate-conflict', affected: [{ name: 'review-gate', reason: 'failure' }] } };
  const subject = (over = {}) => pr(['review:pending'], [], { statusCheckRollup: [...green(), ...Array.from({ length: 3 }, () => check('review-gate', 'FAILURE'))], ...over });
  it('#5241: review-gate failures are review signals, including when required by repository policy', () => {
    for (const rows of [[reviewRow], [{ kind: 'review' }]]) {
      for (const checks of [requiredChecks, [...requiredChecks, 'review-gate']]) {
        expect(derive({ pr: subject(), requiredChecks: checks, rows })).toBe('awaiting-review');
      }
    }
    expect(derive({ pr: subject(), requiredChecks: [...requiredChecks, 'review-gate'], rows: [reviewRow], settings: { reviewGateSignal: 'ci' } })).toBe('ci-red');
    expect(derive({ pr: subject(), requiredChecks, rows: [row([{ name: 'advisory-only', reason: 'pending' }])] })).toBe('awaiting-review');
  });
  it.each([
    ['review', { holds: ['review-acceptance'], jobId: 1 }, 'awaiting-review'],
    ['ci', { holds: ['review-acceptance'], jobId: 1 }, 'ci-red'],
    ['review', undefined, 'ci-red'],
  ])('#5253: merge-gate human review holds with %s signal and annotation %j yield %s', (reviewGateSignal, mergeGateReviewHold, expected) => {
    const held = subject({ number: 5253, baseRefName: 'main', statusCheckRollup: [
      ...green().filter(c => c.name !== 'merge-gate'),
      { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE',
        ...(mergeGateReviewHold ? { mergeGateReviewHold } : {}) },
    ] });
    expect(derive({ pr: held, requiredChecks, settings: { reviewGateSignal } })).toBe(expected);
  });
  it('#5267: a stacked PR missing only main-only checks waits on its base', () => {
    const stacked = subject({ baseRefName: 'lane/enqueue-verify', statusCheckRollup: green().filter(c => c.name !== 'merge-gate') });
    const rows = [row([{ name: 'merge-gate', reason: 'missing' }])];
    expect(derive({ pr: stacked, requiredChecks, rows })).toBe('waiting-on-base');
    expect(derive({ pr: stacked, requiredChecks, rows, settings: { stackedMainOnlyChecks: 'awaiting-ci' } })).toBe('awaiting-ci');
    expect(derive({ pr: { ...stacked, baseRefName: 'main' }, requiredChecks, rows })).toBe('awaiting-ci');
    expect(derive({ pr: stacked, requiredChecks, rows: [row([{ name: 'merge-gate', reason: 'missing' }, { name: 'test', reason: 'pending' }])] })).toBe('awaiting-ci');
    expect(derive({ pr: stacked, requiredChecks, rows: [row([{ name: 'merge-gate', reason: 'pending' }])] })).toBe('waiting-on-base');
    for (const reason of ['failure', 'cancelled', 'wrong-head', 'malformed']) {
      expect(derive({ pr: stacked, requiredChecks, rows: [row([{ name: 'merge-gate', reason }])] })).toBe('awaiting-ci');
    }
    expect(derive({ pr: stacked, requiredChecks, rows: [reviewRow], reviewStatus: { role: 'draft', state: 'awaiting-ci' } })).toBe('awaiting-ci');
    expect(derive({ pr: stacked, requiredChecks, rows: [reviewRow, { kind: 'owed-ci-rerun' }] })).toBe('awaiting-ci');
  });
  it('#5270 and #5254: required failures remain ci-red', () => {
    const failed = subject({ statusCheckRollup: [...green().filter(c => c.name !== 'test'), check('test', 'FAILURE'), check('integration', 'FAILURE'), check('review-gate', 'FAILURE')] });
    expect(derive({ pr: failed, requiredChecks: [...requiredChecks, 'integration'], rows: [{ kind: 'ci-heal' }] })).toBe('ci-red');
    expect(derive({ pr: subject({ statusCheckRollup: [...green().filter(c => c.name !== 'daemon-soak'), check('daemon-soak', 'FAILURE'), check('soak-shard (3)', 'CANCELLED')] }), requiredChecks, rows: [{ kind: 'ci-heal' }] })).toBe('ci-red');
  });
});


describe('status tagger excuses only proven merge-gate candidacy holds (#5253, #5223)', () => {
  const requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
  const subject = () => pr(['review:pending'], [], { number: 5253,
    statusCheckRollup: requiredChecks.map(name => check(name, name === 'merge-gate' ? 'FAILURE' : 'SUCCESS')) });
  const run = (excuseMergeGate, prState = subject()) => {
    const setLabels = vi.fn();
    const result = tagReviewStatus({ pr: prState.number, repo: 'web-everything/web-everything', agents: [],
      currentLabels: prState.labels, prState, provider: { ensureLabel: () => {}, setLabels },
      readFixClaim: () => null, planRows: [], requiredChecks, prStatusSettings: PR_STATUS_SETTING_DEFAULTS,
      excuseMergeGate });
    return { result, setLabels };
  };
  it('uses the excused snapshot when all other required checks are green', () => {
    const raw = subject();
    const excuseMergeGate = vi.fn(pr => ({ ...pr, statusCheckRollup: pr.statusCheckRollup.map(row =>
      row.name === 'merge-gate' ? { ...row, conclusion: 'SUCCESS', mergeGateHoldExcused: { kind: 'candidacy' } } : row) }));
    const { result, setLabels } = run(excuseMergeGate, raw);
    expect(excuseMergeGate).toHaveBeenCalledOnce();
    expect(excuseMergeGate).toHaveBeenCalledWith(raw, { repo: 'web-everything/web-everything' });
    expect(result.prStatus).toBe('status:awaiting-review');
    expect(setLabels).toHaveBeenCalledWith('web-everything/web-everything', 5253,
      { add: 'status:awaiting-review', remove: [] });
    expect(raw.statusCheckRollup.at(-1).conclusion).toBe('FAILURE');
  });
  it.each(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'])('retains ci-red for an unexcused %s', conclusion => {
    const raw = subject();
    raw.statusCheckRollup.at(-1).conclusion = conclusion;
    const excuseMergeGate = vi.fn(pr => pr);
    expect(run(excuseMergeGate, raw).result.prStatus).toBe('status:ci-red');
    expect(excuseMergeGate).toHaveBeenCalledOnce();
  });
  it('fails closed when excusal throws', () => {
    const excuseMergeGate = vi.fn(() => { throw new Error('verdict unreadable'); });
    expect(run(excuseMergeGate).result.prStatus).toBe('status:ci-red');
    expect(excuseMergeGate).toHaveBeenCalledOnce();
  });
  it.each(['SUCCESS', 'NEUTRAL', 'SKIPPED', null])('does no excusal work when the latest merge-gate is %s', conclusion => {
    const raw = subject();
    raw.statusCheckRollup.at(-1).completedAt = at(1);
    raw.statusCheckRollup.push({ ...check('merge-gate', conclusion),
      status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED', startedAt: at(2) });
    const excuseMergeGate = vi.fn(() => { throw new Error('must not read'); });
    run(excuseMergeGate, raw);
    expect(excuseMergeGate).not.toHaveBeenCalled();
  });
  it('does no excusal work without a merge-gate row', () => {
    const raw = subject();
    raw.statusCheckRollup = raw.statusCheckRollup.filter(row => row.name !== 'merge-gate');
    const excuseMergeGate = vi.fn(() => { throw new Error('must not read'); });
    run(excuseMergeGate, raw);
    expect(excuseMergeGate).not.toHaveBeenCalled();
  });
});

describe('prStatus settings', () => {
  it('supplies standard values and source metadata', () => {
    const resolved = resolvePrStatusSettings();
    expect(prStatusSettingValues(resolved)).toEqual({ reviewGateSignal: 'review', stackedMainOnlyChecks: 'waiting-on-base', mainOnlyRequiredChecks: ['merge-gate'], acceptedRedTeamStatus: 'red-team' });
    expect(prStatusSettingValues(resolved)).toEqual(PR_STATUS_SETTING_DEFAULTS);
    for (const setting of Object.values(resolved)) expect(setting.source).toBe('standard');
  });
  it('defaults acceptedRedTeamStatus to red-team and accepts the env compatibility override', () => {
    expect(resolvePrStatusSettings().acceptedRedTeamStatus).toEqual({ value: 'red-team', source: 'standard' });
    expect(resolvePrStatusSettings({ env: { WE_PR_STATUS_ACCEPTED_RED_TEAM: 'ready-to-merge' } }).acceptedRedTeamStatus)
      .toEqual({ value: 'ready-to-merge', source: 'env' });
  });
  it('layers standard < platform < repo < env independently and parses comma lists', () => {
    const platform = { prStatus: { reviewGateSignal: 'ci', stackedMainOnlyChecks: 'awaiting-ci', mainOnlyRequiredChecks: ['platform-check'] } };
    const repo = { prStatus: { reviewGateSignal: 'review', mainOnlyRequiredChecks: ['repo-check'] } };
    expect(resolvePrStatusSettings({ platform }).reviewGateSignal).toEqual({ value: 'ci', source: 'platform' });
    expect(resolvePrStatusSettings({ platform, repo }).reviewGateSignal).toEqual({ value: 'review', source: 'repo' });
    const resolved = resolvePrStatusSettings({ platform, repo, env: {
      WE_PR_STATUS_REVIEW_GATE_SIGNAL: 'ci', WE_PR_STATUS_STACKED_MAIN_ONLY: 'waiting-on-base',
      WE_PR_STATUS_MAIN_ONLY_CHECKS: 'merge-gate, custom-check ',
      WE_PR_STATUS_ACCEPTED_RED_TEAM: 'ready-to-merge',
    } });
    expect(prStatusSettingValues(resolved)).toEqual({ reviewGateSignal: 'ci', stackedMainOnlyChecks: 'waiting-on-base', mainOnlyRequiredChecks: ['merge-gate', 'custom-check'], acceptedRedTeamStatus: 'ready-to-merge' });
    for (const setting of Object.values(resolved)) expect(setting.source).toBe('env');
  });
  it('ignores invalid values and blocks, retaining the last valid layer', () => {
    const resolved = resolvePrStatusSettings({ platform: { prStatus: { reviewGateSignal: 'ci' } },
      repo: { prStatus: [] }, env: { WE_PR_STATUS_REVIEW_GATE_SIGNAL: 'invalid', WE_PR_STATUS_STACKED_MAIN_ONLY: 'invalid', WE_PR_STATUS_MAIN_ONLY_CHECKS: 'merge-gate,,test' } });
    expect(resolved.reviewGateSignal).toMatchObject({ value: 'ci', source: 'platform', ignored: [{ source: 'repo' }, { source: 'env' }] });
    for (const key of ['stackedMainOnlyChecks', 'mainOnlyRequiredChecks']) {
      expect(resolved[key]).toMatchObject({ value: PR_STATUS_SETTING_DEFAULTS[key], source: 'standard', ignored: [{ source: 'repo' }, { source: 'env' }] });
    }
    for (const value of ['merge-gate', [''], ['  '], [7], null]) {
      expect(resolvePrStatusSettings({ repo: { prStatus: { mainOnlyRequiredChecks: value } } }).mainOnlyRequiredChecks).toMatchObject({ source: 'standard', ignored: [{ source: 'repo' }] });
    }
  });
  it('loads preferences and declared settings with injectable reads', () => {
    const loaded = loadPrStatusSettings({ env: {}, readFile: () => JSON.stringify({ prStatus: { reviewGateSignal: 'ci' } }),
      readDeclared: () => ({ settings: { prStatus: { stackedMainOnlyChecks: 'awaiting-ci' } } }) });
    expect(loaded.reviewGateSignal).toEqual({ value: 'ci', source: 'platform' });
    expect(loaded.stackedMainOnlyChecks).toEqual({ value: 'awaiting-ci', source: 'repo' });
    const absentFile = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
    expect(prStatusSettingValues(loadPrStatusSettings({ env: {}, readFile: absentFile, readDeclared: () => ({ settings: {} }) }))).toEqual(PR_STATUS_SETTING_DEFAULTS);
    for (const declared of [{ errors: ['unreadable'] }, { duplicates: [{ path: 'prStatus.reviewGateSignal' }] }]) {
      expect(() => loadPrStatusSettings({ env: {}, readFile: absentFile, readDeclared: () => declared })).toThrow('prStatus declared settings unreadable');
    }
    expect(() => loadPrStatusSettings({ env: {}, readFile: () => 'invalid json', readDeclared: () => ({}) })).toThrow();
  });
});

describe('status tagger resolves required checks and settings at the IO boundary', () => {
  const run = (options = {}) => tagReviewStatus({ pr: 7, repo: 'web-everything/web-everything', agents: [],
    currentLabels: ['review:pending'], prState: pr(['review:pending'], [], { statusCheckRollup: [check('merge-gate', 'FAILURE'), check('review-gate', 'FAILURE')] }),
    provider: { ensureLabel: () => {}, setLabels: () => {} }, readFixClaim: () => null,
    planRows: [{ kind: 'review-ci', ci: { affected: [{ name: 'review-gate', reason: 'failure' }] } }], ...options });
  it('reads the live required set and projects resolved settings into the reducer', () => {
    const calls = [];
    expect(run({ readRequiredChecks: (args) => { calls.push(args); return { checks: ['merge-gate'] }; },
      loadStatusSettings: () => resolvePrStatusSettings() }).prStatus).toBe('status:ci-red');
    expect(calls).toEqual([{ repo: 'web-everything/web-everything' }]);
    expect(run({ readRequiredChecks: () => ({ checks: ['review-gate'] }),
      loadStatusSettings: () => resolvePrStatusSettings({ env: { WE_PR_STATUS_REVIEW_GATE_SIGNAL: 'ci' } }) }).prStatus).toBe('status:ci-red');
  });
  it('honors explicit values without invoking readers and falls back when readers throw', () => {
    const unexpected = () => { throw new Error('must not read'); };
    let reads = 0;
    const reader = () => { reads++; return unexpected(); };
    expect(run({ requiredChecks: ['review-gate'], prStatusSettings: { reviewGateSignal: 'review' }, readRequiredChecks: reader, loadStatusSettings: reader }).prStatus).toBe('status:awaiting-review');
    expect(reads).toBe(0);
    expect(run({ readRequiredChecks: reader, loadStatusSettings: reader }).prStatus).toBe('status:awaiting-review');
    expect(reads).toBe(2);
    expect(run({ planRows: null, readRequiredChecks: reader, loadStatusSettings: reader }).prStatus).toBeUndefined();
    expect(reads).toBe(2);
  });
});
