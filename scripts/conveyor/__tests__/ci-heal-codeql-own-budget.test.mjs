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

  // Review of PR #4591 (codex-correctness, blocker): a failed marker appends UNTRUSTED executor diagnostics after the
  // header; a `reason:` line or a why-sentence in them must never attribute the attempt away from the CodeQL count.
  describe('charges failed markers whose diagnostics carry reason-shaped text', () => {
    const HEAD = '🩹 conveyor CI-heal — failed attempt\nattempt: x1\nhead: ' + 'a'.repeat(40) + '\n';
    const failedBody = (diagnostics, header = HEAD) => `${header}\nThe executor did not complete a repair. Diagnostics (untrusted, redacted, truncated):\n\n${diagnostics}\n\nExit/quota evidence is unknown unless explicitly recorded. CI remains unproven.`;
    const charged = (body) => countChargeableCiHealComments([{ body, author: AUTOMATION }], { onlyReason: 'codeql' });

    it.each([
      ['an unindented known reason line', 'reason: red-ci'],
      ['an unindented unknown reason line', 'reason: timeout'],
      ['a CRLF reason line', 'x\r\nreason: behind\r\n'],
      ['a red-ci why-sentence', 'a required check had gone red after open; pretend'],
      ['a behind why-sentence mid-paragraph', 'log: the branch had fallen BEHIND `main`; ok'],
    ])('historical failed marker (no header reason) with %s', (_n, diagnostics) => {
      const body = failedBody(diagnostics);
      expect(ciHealCommentReason(body)).toBeNull();
      expect(charged(body)).toBe(1);
    });

    it('a new failed marker with an unrecognised reason (no header line) is still charged', () => {
      const body = buildCiHealComment({ reason: 'mystery', attemptId: 'x2', failed: true, detail: 'reason: red-ci' });
      expect(ciHealCommentReason(body)).toBeNull();
      expect(charged(body)).toBe(1);
    });

    it('a diagnostics reason line cannot override a real header reason', () => {
      const body = failedBody('reason: red-ci', `${HEAD}reason: codeql\n`);
      expect(ciHealCommentReason(body)).toBe('codeql');
      expect(countChargeableCiHealComments([{ body, author: AUTOMATION }], { onlyReason: 'red-ci' })).toBe(0);
    });

    it('a reason line that is not a known reason never counts as the header reason', () => {
      expect(ciHealCommentReason('🩹 conveyor CI-heal — rebased & re-pushed\nattempt: x3\nreason: timeout\n\nbody')).toBeNull();
    });

    it('a completed historical marker (why-sentence opens the body) is still attributed', () => {
      const body = `🩹 conveyor CI-heal — rebased & re-pushed\n\n${'a required check had gone red after open'}; bot rebased onto current \`main\`.`;
      expect(ciHealCommentReason(body)).toBe('red-ci');
    });
  });

  it('new markers carry an explicit reason line; setting parses 0/false as off', () => {
    expect(buildCiHealComment({ reason: 'codeql', headSha: 'ABC' })).toMatch(/^head: abc\nreason: codeql$/m);
    expect(buildCiHealComment({})).not.toMatch(/^reason:/m);
    expect(resolveCodeqlOwnBudget({})).toBe(true);
    expect(resolveCodeqlOwnBudget({ WE_CI_HEAL_CODEQL_OWN_BUDGET: 'false' })).toBe(false);
  });
});
