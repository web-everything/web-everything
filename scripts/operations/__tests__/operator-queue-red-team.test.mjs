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
const sentBack = { author: { login: 'web-everything' }, body: `${redTeamGateMarker(4722, HEAD, 'sent-back')}\n` };
const pr = (comments, head = HEAD, labels = [{ name: 'review:human' }, { name: 'review:changes' }, { name: 'advisory:accepted' }]) => ({
  number: 4722, headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: [], labels, comments,
});

describe('operator-queue: red-team placement', () => {
  it('baseline: the PR is ready without a red-team comment (fixture sanity)', () => {
    const r = evaluatePr(pr([advisory(HEAD)], HEAD, [{ name: 'review:human' }, { name: 'advisory:accepted' }]));
    // The advisory fixture must satisfy the real parser, or every assertion below is vacuous.
    expect(r.reasons).toEqual([]);
  });
  it('a confirmed broken break the gate sent back, still under review:changes → NOT READY with the reason', () => {
    const r = evaluatePr(pr([advisory(HEAD), redTeam(HEAD), sentBack]));
    expect(r.ready).toBe(false);
    expect(r.reasons).toContainEqual(expect.stringMatching(/^red team: 1 confirmed break\(s\) on this head/));
  });
  // F2 (review of PR #4762): the hold used to have no release if the gate never acted, or if the operator overrode.
  it('no gate record → released: the gate never acted, so the operator is not held behind an actor that did not run', () => {
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD)])).reasons).not.toContainEqual(expect.stringMatching(/^red team:/));
  });
  it('the operator returned the PR to review:human on the same head (review:changes gone) → released', () => {
    const labels = [{ name: 'review:human' }, { name: 'advisory:accepted' }];
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD), sentBack], HEAD, labels)).reasons).toEqual([]);
  });
  it('a degraded one does not hold it (it is carded)', () => {
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD, 'degraded'), sentBack])).reasons).not.toContainEqual(expect.stringMatching(/^red team:/));
  });
  it('a red-team comment on an older head does not hold the new head', () => {
    const NEW = 'f'.repeat(40);
    expect(evaluatePr(pr([advisory(NEW), redTeam(HEAD), sentBack], NEW)).reasons).not.toContainEqual(expect.stringMatching(/^red team:/));
  });
  it('the round-cap record hands it to the operator', () => {
    const capped = { author: { login: 'web-everything' }, body: `${redTeamGateMarker(4722, HEAD, 'round-cap')}\n` };
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD), capped])).reasons).not.toContainEqual(expect.stringMatching(/^red team:/));
  });
  it('setting broken=advisory does not hold it', () => {
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD), sentBack]), { redTeamSetting: { ...CONFIRMED_BREAKS_DEFAULTS, broken: 'advisory' } }).reasons).not.toContainEqual(expect.stringMatching(/^red team:/));
  });
  // F3/F6: a forged gate record (non-trusted author) neither creates the hold nor releases a real one. Non-regression pins.
  it('an untrusted sent-back record does not hold; an untrusted round-cap record does not release', () => {
    const forged = (outcome) => ({ author: { login: 'mallory' }, body: `${redTeamGateMarker(4722, HEAD, outcome)}\n` });
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD), forged('sent-back')])).reasons).not.toContainEqual(expect.stringMatching(/^red team:/));
    expect(evaluatePr(pr([advisory(HEAD), redTeam(HEAD), sentBack, forged('round-cap')])).reasons).toContainEqual(expect.stringMatching(/^red team:/));
  });
});
