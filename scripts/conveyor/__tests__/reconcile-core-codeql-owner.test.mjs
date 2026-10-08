/**
 * @file The drain's CodeQL hold must have an owner (card x8cnbii). LIVE 2026-10-08, PR #4370: ready-to-merge +
 * review:accepted, every required check green, CodeQL FAILURE (high severity). The drain skipped it every pass
 * (`drainBlocksOnCodeQL`) and reconcile answered `nothing-owed`, so nobody repaired it.
 */
import { describe, it, expect } from 'vitest';
import { planReconcile, CI_HEAL_ROUND_CAP } from '../reconcile-core.mjs';
import { enrichPrsWithCodeQL } from '../reconcile-pass.mjs';
import { buildCiHealComment } from '../ci-heal-mark.mjs';
import { buildCiHealEscalationComment } from '../ci-heal-escalation-mark.mjs';
import { alertsFromAnnotations, checkRunIdFromUrl, codeqlBriefSection, failedCodeQLCheck } from '../../lib/codeql-gate.mjs';
import { withCodeQLSection } from '../../operations/ci-heal-pr-dispatch.mjs';

const NOW = Date.parse('2026-10-08T03:00:00Z');
const HEAD = '8f74ca569d732a37315b240e046ad035ff5f29c7';
const lbl = (...names) => names.map((name) => ({ name }));
const AUTOMATION = { login: 'web-everything' };
const rollup = (codeql = 'FAILURE') => [
  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-08T01:55:00Z' },
  { __typename: 'CheckRun', name: 'CodeQL', status: 'COMPLETED', conclusion: codeql, completedAt: '2026-10-08T01:50:40Z',
    detailsUrl: 'https://github.com/web-everything/web-everything/runs/113109095870' },
];
const ANNOTATIONS = [{
  path: 'scripts/operations/perf-velocity-io.mjs', start_line: 128, annotation_level: 'failure',
  title: 'Incomplete multi-character sanitization', message: 'This string may still contain [<!--](1), which may cause an HTML element injection vulnerability.',
}];
const pr4370 = (over = {}) => ({
  number: 4370, state: 'OPEN', headRefName: 'lane/velocity', headRefOid: HEAD, mergeStateStatus: 'UNSTABLE', mergeable: 'MERGEABLE',
  labels: lbl('ready-to-merge', 'review:accepted', 'review-round:1'), statusCheckRollup: rollup(), comments: [], ...over,
});
const enriched = (over, exec = () => JSON.stringify(ANNOTATIONS)) =>
  enrichPrsWithCodeQL([pr4370(over)], { repo: 'web-everything/web-everything', exec, settings: { drainBlocksOnCodeQL: true } })[0];

describe('CodeQL-held PR is owed a ci-heal (x8cnbii)', () => {
  it('replays #4370: the held PR gets a ci-heal row carrying the alert (red on the old nothing-owed behaviour)', () => {
    const plan = planReconcile({ prs: [enriched()], agents: [], now: NOW, requiredChecks: ['test'] });
    expect(plan.refusals.find((r) => r.kind === 'nothing-owed')).toBeUndefined();
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 4370, reason: 'codeql' })]);
    expect(plan.dispatch[0].codeql.alerts).toEqual([{
      rule: 'Incomplete multi-character sanitization', path: 'scripts/operations/perf-velocity-io.mjs', line: 128,
      message: expect.stringContaining('HTML element injection'),
    }]);
    expect(plan.dispatch[0].why).toMatch(/CodeQL/);
  });

  it('a queued PR with CodeQL passing (or absent) still has nothing owed', () => {
    for (const statusCheckRollup of [rollup('SUCCESS'), rollup().filter((c) => c.name !== 'CodeQL')]) {
      const plan = planReconcile({ prs: [enriched({ statusCheckRollup })], agents: [], now: NOW, requiredChecks: ['test'] });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals.map((r) => r.kind)).toContain('nothing-owed');
    }
  });

  it('with the drain gate off the PR is not owed anything for CodeQL (same knob as the drain)', () => {
    const [p] = enrichPrsWithCodeQL([pr4370()], { repo: 'x/y', exec: () => '[]', settings: { drainBlocksOnCodeQL: false } });
    expect(p.codeqlFailure).toBeUndefined();
    expect(planReconcile({ prs: [p], agents: [], now: NOW, requiredChecks: ['test'] }).dispatch).toEqual([]);
  });

  it('is bounded: at the ci-heal cap it is a logged cap-exhausted refusal plus a note, not another dispatch', () => {
    const comments = Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: buildCiHealComment({ reason: 'codeql' }), author: AUTOMATION }));
    const plan = planReconcile({ prs: [enriched({ comments })], agents: [], now: NOW, requiredChecks: ['test'] });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', prNumber: 4370 })]);
    expect(plan.notes).toEqual([expect.objectContaining({ kind: 'ci-heal-exhausted', prNumber: 4370, lastFailureReason: 'CodeQL (drain gate)' })]);
  });

  it('a head-scoped ci-heal escalation stops re-dispatch for that exact head', () => {
    const comments = [{ body: buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'cannot fix' }), author: AUTOMATION }];
    const plan = planReconcile({ prs: [enriched({ comments })], agents: [], now: NOW, requiredChecks: ['test'] });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'ci-heal-escalated', prNumber: 4370 })]);
  });

  it('a live fix claim still wins (no second author on the lane)', () => {
    const plan = planReconcile({ prs: [enriched({ fixClaim: { who: 'fixer:fix-4370' } })], agents: [], now: NOW, requiredChecks: ['test'] });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals.map((r) => r.kind)).toEqual(['fix-claimed']);
  });
});

describe('codeql-gate lib', () => {
  it('reads the check-run id and only failure-level annotations', () => {
    expect(checkRunIdFromUrl('https://github.com/o/r/runs/113109095870')).toBe('113109095870');
    expect(checkRunIdFromUrl('https://github.com/o/r/actions/runs/1/job/2')).toBeNull();
    expect(alertsFromAnnotations([...ANNOTATIONS, { annotation_level: 'warning', title: 'x', path: 'a', start_line: 1, message: 'm' }])).toHaveLength(1);
  });
  it('an annotations read failure still owes the heal, with the failure logged on the evidence', () => {
    const p = enriched({}, () => { throw new Error('HTTP 403'); });
    expect(p.codeqlFailure).toMatchObject({ checkRunId: '113109095870', alerts: [], readError: 'HTTP 403' });
    expect(planReconcile({ prs: [p], agents: [], now: NOW, requiredChecks: ['test'] }).dispatch).toHaveLength(1);
  });
  it('only the LATEST CodeQL run counts (a superseded failure does not hold)', () => {
    const roll = [
      { __typename: 'CheckRun', name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-08T01:00:00Z', completedAt: '2026-10-08T01:01:00Z' },
      { __typename: 'CheckRun', name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-08T02:00:00Z', completedAt: '2026-10-08T02:01:00Z' },
    ];
    expect(failedCodeQLCheck({ statusCheckRollup: roll })).toBeNull();
  });
  it('the heal brief names rule, file, line, message and the annotations command', () => {
    const planned = { reason: 'codeql', pr: 4370, codeql: enriched().codeqlFailure };
    const out = withCodeQLSection('BASE', planned, 'we');
    expect(out.startsWith('BASE')).toBe(true);
    for (const needle of ['Incomplete multi-character sanitization', 'perf-velocity-io.mjs', 'line: 128', 'HTML element injection',
      'check-runs/113109095870/annotations', 'Do not stand down as "not a CI break"']) expect(out).toContain(needle);
    expect(withCodeQLSection('BASE', { reason: 'red-ci' }, 'we')).toBe('BASE');
    expect(codeqlBriefSection({ alerts: [], readError: 'boom' })).toContain('could not be read: boom');
  });
});
