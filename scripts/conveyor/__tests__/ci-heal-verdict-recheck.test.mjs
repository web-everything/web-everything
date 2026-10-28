import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredCheckStates, contradictingChecks, notCiBreakContradicted, unsettledRequiredChecks, ciGreenForEscalation, resolveVoidNeedsHumanWhenCiGreen, resolveCiHealVerdictSettings } from '../ci-heal-verdict-recheck.mjs';
import { buildCiHealEscalationComment, notCiBreakRecordRefusal } from '../ci-heal-escalation-mark.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { planVerdictVoid } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ci-heal-verdict/pr4535-2026-10-09.json'), 'utf8'));
const input = { escalation: { outcome: 'not-a-ci-break', headSha: fixture.headRefOid }, headSha: fixture.headRefOid,
  rollup: fixture.statusCheckRollup, requiredChecks: fixture.requiredChecks };
const green = fixture.requiredChecks.map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));

describe('required check verdict recheck', () => {
  it('contradicts the real #4535 verdict only for test', () => {
    expect(contradictingChecks(input)).toEqual(['test']);
    expect(notCiBreakContradicted(input)).toBe(true);
    expect(requiredCheckStates(input).red).toEqual(['test']);
  });
  it('review-gate red alone never contradicts', () => {
    const rollup = [...fixture.statusCheckRollup.filter((r) => r.name === 'review-gate' && r.conclusion === 'FAILURE'), ...green];
    expect(contradictingChecks({ ...input, rollup, requiredChecks: [...fixture.requiredChecks, 'review-gate'] })).toEqual([]);
  });
  it.each([{ outcome: 'needs-human', headSha: fixture.headRefOid }, { outcome: 'not-a-ci-break', headSha: 'abcdef0123456789' }])('ignores unrelated escalation %j', (escalation) => {
    expect(contradictingChecks({ ...input, escalation })).toEqual([]);
  });
  it('matches an abbreviated escalation head', () => expect(contradictingChecks({ ...input, escalation: { ...input.escalation, headSha: fixture.headRefOid.slice(0, 9) } })).toEqual(['test']));
  it('the latest run wins even when the old red appears last in the array', () => {
    const rollup = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-09T04:00:00Z', completedAt: '2026-10-09T04:01:00Z' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-09T02:00:00Z', completedAt: '2026-10-09T02:01:00Z' },
    ];
    expect(contradictingChecks({ ...input, rollup, requiredChecks: ['test'] })).toEqual([]);
  });
  it('cannot declare not-a-ci-break while the fixture checks are unfinished', () => {
    const rollup = fixture.statusCheckRollup.filter((r) => r.startedAt <= fixture.escalationAt)
      .map((r) => r.completedAt > fixture.escalationAt ? { ...r, status: 'IN_PROGRESS', conclusion: null } : r);
    const result = unsettledRequiredChecks({ ...input, rollup });
    expect([...result.pending, ...result.missing]).toEqual(expect.arrayContaining(['test', 'daemon-soak']));
    expect(result.red).toEqual([]);
  });
  it('unknown required set claims nothing red', () => expect(contradictingChecks({ ...input, requiredChecks: [] })).toEqual([]));
  it('legacy StatusContext failures count', () => {
    expect(contradictingChecks({ ...input, rollup: [{ __typename: 'StatusContext', context: 'test', state: 'FAILURE' }] })).toEqual(['test']);
  });
});

describe('cancelled smoke verdict retry ownership', () => {
  it('unfinished cancelled smoke remains unsettled', () => {
    const rollup = [{ name: 'smoke', status: 'IN_PROGRESS', conclusion: 'CANCELLED' }];
    expect(unsettledRequiredChecks({ rollup, requiredChecks: ['smoke'] }))
      .toEqual({ pending: ['smoke'], missing: [], red: [] });
  });

  const head = 'a'.repeat(40);
  const check = (conclusion) => ({ name: 'smoke', status: 'COMPLETED', conclusion });
  const retry = { eligible: true, infraCancelled: true, head, pr: 5972,
    jobs: [{ run: 10, job: 20, attempt: 1 }] };
  const pull = (over = {}) => ({ number: 5972, state: 'OPEN', isDraft: false,
    headRefOid: head, headRefName: 'lane/verdict-retry', mergeStateStatus: 'CLEAN', labels: [],
    statusCheckRollup: [check('CANCELLED')],
    comments: [{ author: { login: 'web-everything' },
      body: buildCiHealEscalationComment({ headSha: head, outcome: 'not-a-ci-break' }) }],
    timeoutRetry: retry, timeoutRetryBudget: { confirmed: 0, rejected: 0, pending: false }, ...over });
  const voidFor = (pr, requiredChecks = ['smoke']) => planVerdictVoid({ pr,
    note: { kind: 'ci-heal-escalated', outcome: 'not-a-ci-break', headSha: head, prNumber: pr.number },
    repo: 'web-everything/web-everything', verdictSettings: { recheckNotCiBreak: true },
    readRequiredChecks: () => requiredChecks });

  it('not-a-ci-break recorded, later smoke infra-cancelled with retry unspent: verdict is voided and retry dispatches', () => {
    const pr = pull({ statusCheckRollup: [check('SUCCESS')] });
    expect(notCiBreakRecordRefusal({ headSha: head, pr, requiredChecks: ['smoke'] })).toBeNull();
    expect(voidFor(pr)).toBeNull();
    pr.statusCheckRollup = [check('CANCELLED')];
    const plan = () => planReconcile({ prs: [pr], agents: [], requiredChecks: ['smoke'] });
    expect(plan().dispatch).toEqual([]);
    const row = voidFor(pr);
    expect(row).toMatchObject({ kind: 'ci-heal-verdict-void', alreadyPosted: false });
    pr.comments.push({ author: { login: 'web-everything' }, body: row.body });
    expect(plan().dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-timeout-rerun' }));
  });

  it.each([
    ['pending request even at cap', { timeoutRetryBudget: { confirmed: 6, pending: true } }],
    ['unknown spent budget', { timeoutRetryBudget: undefined }],
    ['unreadable retry evidence', { timeoutRetry: { eligible: false, reason: 'timeout-evidence:read-failed' } }],
    ['custom cap with one retry left', { timeoutRetry: { ...retry, cap: 3 }, timeoutRetryBudget: { confirmed: 1, rejected: 1 } }],
  ])('cancelled smoke contradicts recorded verdict with %s', (_name, over) => {
    const pr = pull(over);
    expect(notCiBreakRecordRefusal({ headSha: head, pr, requiredChecks: ['smoke'] })).toBeTruthy();
    expect(voidFor(pr)).toMatchObject({ kind: 'ci-heal-verdict-void', alreadyPosted: false });
  });

  it.each([
    ['exhausted default cap', { timeoutRetryBudget: { confirmed: 6, pending: false } }],
    ['rejections exhaust custom cap', { timeoutRetry: { ...retry, cap: 3 }, timeoutRetryBudget: { confirmed: 1, rejected: 2 } }],
    ['ineligible retry', { timeoutRetry: { eligible: false } }],
  ])('cancelled smoke with no retry owed stays settled: %s', (_name, over) => {
    const pr = pull(over);
    expect(notCiBreakRecordRefusal({ headSha: head, pr, requiredChecks: ['smoke'] })).toBeNull();
    expect(voidFor(pr)).toBeNull();
    expect(ciGreenForEscalation({ rollup: pr.statusCheckRollup, requiredChecks: ['smoke'] })).toBe(false);
  });

  it('retry evidence does not void optional smoke or superseded cancellation', () => {
    expect(voidFor(pull(), ['test'])).toBeNull();
    expect(voidFor(pull({ statusCheckRollup: [
      { ...check('SUCCESS'), startedAt: '2026-10-27T02:00:00Z' },
      { ...check('CANCELLED'), startedAt: '2026-10-27T01:00:00Z' },
    ] }))).toBeNull();
  });
});

describe('resolveCiHealVerdictSettings', () => {
  it.each([['off', 'on', false], ['on', 'off', true]])('env %s overrides file %s', (env, file, value) => {
    expect(resolveCiHealVerdictSettings({ WE_CI_HEAL_RECHECK_NOT_CI_BREAK: env }, { read: () => JSON.stringify({ ciHealVerdict: { recheckNotCiBreak: file } }) })).toMatchObject({ recheckNotCiBreak: value });
  });
  it('malformed settings fail closed', () => expect(resolveCiHealVerdictSettings({}, { read: () => '{' })).toMatchObject({ recheckNotCiBreak: false }));
  it('checked-in settings enable rechecking', () => expect(resolveCiHealVerdictSettings({})).toMatchObject({ recheckNotCiBreak: true }));
});


describe('void needs-human settings and green evidence', () => {
  const resolve = (platform, repo, env = {}) => resolveVoidNeedsHumanWhenCiGreen(env, {
    platformPath: 'platform', path: 'repo',
    read: path => JSON.stringify({ ciHealVerdict: { voidNeedsHumanWhenCiGreen: path === 'platform' ? platform : repo } }),
  });
  it('cascades standard → platform → repo → env', () => {
    expect(resolve()).toMatchObject({ value: true, source: 'standard' });
    expect(resolve('off')).toMatchObject({ value: false, source: 'platform' });
    expect(resolve('off', 'on')).toMatchObject({ value: true, source: 'repo' });
    expect(resolve('on', 'on', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'off' })).toMatchObject({ value: false, source: 'env' });
  });
  it('fails closed on invalid layers with reasons', () => {
    const result = resolve('off', 'invalid', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'bad' });
    expect(result).toMatchObject({ value: false, source: 'repo' });
    expect(result.ignored).toEqual([expect.objectContaining({ source: 'repo', reason: expect.any(String) }), expect.objectContaining({ source: 'env', reason: expect.any(String) })]);
    expect(resolveVoidNeedsHumanWhenCiGreen({}, { read: () => '{' })).toMatchObject({ value: false, source: 'platform' });
  });
  it.each(['{', 'null', '[]', '{"ciHealVerdict":null}', '{"ciHealVerdict":[]}', '{"ciHealVerdict":{"voidNeedsHumanWhenCiGreen":true}}'])('invalid document %s cannot be overridden on', document => {
    expect(resolveVoidNeedsHumanWhenCiGreen({ WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'on' }, {
      platformPath: 'platform', path: 'repo', read: path => path === 'platform' ? document : '{}',
    }).value).toBe(false);
  });
  it.each(['EACCES', 'EIO'])('unreadable platform %s cannot be overridden on', code => {
    expect(resolveVoidNeedsHumanWhenCiGreen({ WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'on' }, {
      read: () => { throw Object.assign(new Error(code), { code }); },
    }).value).toBe(false);
  });
  it('allows absent optional platform preferences but fails closed on a missing repo file', () => {
    const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    expect(resolveVoidNeedsHumanWhenCiGreen({}, { platformPath: 'platform', read: path => path === 'platform' ? missing() : '{}' }).value).toBe(true);
    expect(resolveVoidNeedsHumanWhenCiGreen({}, { read: missing }).value).toBe(false);
  });
  it('exposes the resolved boolean and source', () => {
    expect(resolveCiHealVerdictSettings({ WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'off' })).toMatchObject({ voidNeedsHumanWhenCiGreen: false, voidNeedsHumanSource: 'env' });
  });
  it('invalid repo or env cannot silently restore the default on', () => {
    expect(resolve('on', 'invalid').value).toBe(false);
    expect(resolve('on', 'on', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'invalid' }).value).toBe(false);
    expect(resolve('invalid', 'on', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'on' }).value).toBe(false);
  });
  it('requires a known, settled required set, excluding review-gate', () => {
    const checks = ['test', 'review-gate'];
    const rollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }];
    expect(ciGreenForEscalation({ rollup, requiredChecks: checks })).toBe(true);
    for (const conclusion of ['FAILURE', 'TIMED_OUT']) expect(ciGreenForEscalation({ rollup: [{ ...rollup[0], conclusion }], requiredChecks: checks })).toBe(false);
    expect(ciGreenForEscalation({ rollup: [{ ...rollup[0], status: 'IN_PROGRESS' }], requiredChecks: checks })).toBe(false);
    expect(ciGreenForEscalation({ rollup: [], requiredChecks: checks })).toBe(false);
    expect(ciGreenForEscalation({ rollup, requiredChecks: [] })).toBe(false);
  });
});
