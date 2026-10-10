/**
 * Card x1b8hlo — operator-queue placement: a review:human PR whose live head carries a CONFIRMED red-team break the
 * setting sends back is NOT READY (the fixer's), never NEEDS YOU; a new head or the round-cap record releases it.
 */
import { describe, expect, it } from 'vitest';
import { evaluatePr } from '../operator-queue.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker } from '../../lib/red-team-gate.mjs';

const HEAD = 'ea117e881164c3b6366b0bb78a3660c9a00503b1';
const advisory = (head) => ({
  author: { login: 'web-everything' }, createdAt: '2026-10-10T02:00:00Z',
  body: `**Verdict:** human review required\n**Advisory outcome:** \`accept\` — x.\nNet basis: \`${'b'.repeat(40)}..${head}\``,
});
const redTeam = (rev, impact = 'broken') => ({
  author: { login: 'web-everything' }, createdAt: '2026-10-10T02:04:41Z',
  body: renderRedTeamComment({ pr: 4722, rev, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
    findings: [{ summary: 'two writers', category: 'edge-case', impactIfUnfixed: impact, file: 'a.mjs', line: 1, confirmedByRecheck: true }] }),
});
const pr = (comments, head = HEAD) => ({
  number: 4722, headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: [],
  labels: [{ name: 'review:human' }, { name: 'advisory:accepted' }], comments,
});

describe('operator-queue: red-team placement', () => {
  it('baseline: the PR is ready without a red-team comment (fixture sanity)', () => {
    const r = evaluatePr(pr([advisory(HEAD)]));
    // The advisory fixture must satisfy the real parser, or every assertion below is vacuous.
    expect(r.reasons).toEqual([]);
  });
  it('a confirmed broken break on the live head → NOT READY with the reason', () => {
    const r = evaluatePr(pr([advisory(HEAD), redTeam(HEAD)]));
    expect(r.ready).toBe(false);
    expect(r.reasons).toContainEqual(expect.stringMatching(/^red team: 1 confirmed break\(s\) on this head/));
  });
  it('a degraded one does not hold it (it is carded)', () => {
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD, 'degraded')])).reasons).toEqual([]);
  });
  it('a red-team comment on an older head does not hold the new head', () => {
    const NEW = 'f'.repeat(40);
    expect(evaluatePr(pr([advisory(NEW), redTeam(HEAD)], NEW)).reasons).toEqual([]);
  });
  it('the round-cap record hands it to the operator', () => {
    const capped = { author: { login: 'web-everything' }, body: `${redTeamGateMarker(4722, HEAD, 'round-cap')}\n` };
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD), capped])).reasons).toEqual([]);
  });
  it('setting broken=advisory does not hold it', () => {
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD)]), { redTeamSetting: { ...CONFIRMED_BREAKS_DEFAULTS, broken: 'advisory' } }).reasons).toEqual([]);
  });
});
