/**
 * @file A CodeQL-held PR is charged only CodeQL heals. LIVE PR #4453, 2026-10-09: two red-ci heals and one CodeQL heal
 * spent the shared 3-heal cap, so the NEW CodeQL alert left afterwards ("Bad HTML filtering regexp",
 * prep-review.mjs:127) was refused as `cap-exhausted` although no heal had ever been briefed with it. Fixture is the
 * PR's real heal-marker comments and the real CodeQL check-run annotations.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planReconcile, CI_HEAL_ROUND_CAP } from '../reconcile-core.mjs';
import { enrichPrsWithCodeQL } from '../reconcile-pass.mjs';
import {
  buildCiHealComment, ciHealCommentReason, countChargeableCiHealComments, resolveCodeqlOwnBudget,
} from '../ci-heal-mark.mjs';

const FX = JSON.parse(readFileSync(`${process.cwd()}/scripts/conveyor/__tests__/fixtures/pr-4453-codeql-hold.json`, 'utf8'));
const NOW = Date.parse('2026-10-09T09:15:00Z');
const AUTOMATION = { login: 'web-everything' };
const pr4453 = (comments) => ({
  number: 4453, state: 'OPEN', headRefName: 'lane/prep-review', headRefOid: FX.headRefOid,
  mergeStateStatus: 'UNSTABLE', mergeable: 'MERGEABLE', comments,
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-09T07:30:00Z' },
    { __typename: 'CheckRun', name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-09T07:22:10Z', detailsUrl: FX.codeqlDetailsUrl },
  ],
});
const plan = (comments, over = {}) => {
  const [pr] = enrichPrsWithCodeQL([pr4453(comments)], {
    repo: 'web-everything/web-everything', exec: () => JSON.stringify(FX.annotations), settings: { drainBlocksOnCodeQL: true },
  });
  return planReconcile({ prs: [pr], agents: [], now: NOW, requiredChecks: ['test'], ...over });
};

describe('CodeQL hold has its own ci-heal budget (#4453)', () => {
  it('reads each real #4453 heal marker back to its reason', () => {
    expect(FX.healComments.map((c) => ciHealCommentReason(c.body))).toEqual(['red-ci', 'red-ci', 'codeql']);
  });

  it('replays #4453: 2 red-ci + 1 codeql heals → dispatch carrying the new alert (was cap-exhausted)', () => {
    const p = plan(FX.healComments);
    expect(p.refusals.find((r) => r.kind === 'cap-exhausted')).toBeUndefined();
    expect(p.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', reason: 'codeql', prNumber: 4453, attempts: 1 })]);
    expect(p.dispatch[0].codeql.alerts).toEqual([{
      rule: 'Bad HTML filtering regexp', path: 'scripts/conveyor/prep-review.mjs', line: 127,
      message: expect.stringContaining('--!>'),
    }]);
  });

  it('setting off restores the shared count (the old refusal)', () => {
    const p = plan(FX.healComments, { codeqlOwnBudget: false });
    expect(p.dispatch).toEqual([]);
    expect(p.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', attempts: 3 })]);
  });

  it('stays bounded: cap CodeQL heals still exhaust it', () => {
    const codeql = Array.from({ length: CI_HEAL_ROUND_CAP }, (_, i) => ({ body: buildCiHealComment({ reason: 'codeql', attemptId: `a${i}` }), author: AUTOMATION }));
    const p = plan([...FX.healComments.slice(0, 2), ...codeql]);
    expect(p.dispatch).toEqual([]);
    expect(p.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', attempts: CI_HEAL_ROUND_CAP })]);
  });

  it('an unattributable heal marker is charged conservatively', () => {
    const failed = { body: '🩹 conveyor CI-heal — failed attempt\nattempt: x1\n\nThe executor did not complete a repair.', author: AUTOMATION };
    expect(countChargeableCiHealComments([failed], { onlyReason: 'codeql' })).toBe(1);
  });

  it('new markers carry an explicit reason line; setting parses 0/false as off', () => {
    expect(buildCiHealComment({ reason: 'codeql', headSha: 'ABC' })).toMatch(/^head: abc\nreason: codeql$/m);
    expect(buildCiHealComment({})).not.toMatch(/^reason:/m);
    expect(resolveCodeqlOwnBudget({})).toBe(true);
    expect(resolveCodeqlOwnBudget({ WE_CI_HEAL_CODEQL_OWN_BUDGET: 'false' })).toBe(false);
  });
});
