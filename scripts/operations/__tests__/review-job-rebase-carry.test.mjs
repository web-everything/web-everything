import { describe, it, expect, vi } from 'vitest';
import { runReviewJob } from '../review-job.mjs';
import { parseVerdictCarriedMarker } from '../../lib/rebase-verdict-carry.mjs';
import { gateOutcomesForHead } from '../../lib/red-team-gate.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40), p = 'c'.repeat(40);
const trusted = body => ({ author: { login: 'chalbert' }, body });
function fixture() {
  return { root: '.', now: () => 0, claim: () => ({ ok: true }), unclaim: vi.fn(), report: vi.fn(), log: vi.fn(),
    readPrevCompletion: () => null, newActorId: () => 'actor', acquireLane: () => ({ lanePath: 'fake-lane' }), updateRecord: vi.fn(), releaseLane: vi.fn(),
    carryAcrossRebaseSetting: () => ({ value: 'on', source: 'test' }),
    readCarryEvidence: () => ({ headSha: b, comments: [trusted(`<!-- reviewed-sha: ${a} -->`), trusted(`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->`)] }),
    readSavedResult: vi.fn(() => null),
    contributionPatchId: () => p, restampVerdict: vi.fn(() => ({ ok: true })), postCarryComment: vi.fn(),
    runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify({ stopped: 'complete', verdict: { verdict: 'accept', loop: { outcome: 'converged' } } }) })),
    runExtraSeats: vi.fn(), runRedTeam: vi.fn(), startSpeculativeRedTeam: vi.fn(), speculativeRedTeamSetting: () => ({ enabled: true }),
  };
}
describe('review job rebase carry', () => {
  it('restamps before one carry comment and starts no round or seats', () => {
    const io = fixture(); const out = runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(out.outcome).toBe('carried'); expect(io.restampVerdict).toHaveBeenCalledWith(expect.objectContaining({ newHead: b }));
    expect(io.postCarryComment).toHaveBeenCalledTimes(1);
    const body = io.postCarryComment.mock.calls[0][0].body;
    expect(parseVerdictCarriedMarker(body)).toEqual({ fromSha: a, toSha: b, patchId: p });
    expect([...gateOutcomesForHead([trusted(body)], 1, b)]).toEqual(['card-queued']);
    for (const key of ['runLoop', 'runExtraSeats', 'runRedTeam', 'startSpeculativeRedTeam']) expect(io[key]).not.toHaveBeenCalled();
    expect(io.restampVerdict.mock.invocationCallOrder[0]).toBeLessThan(io.postCarryComment.mock.invocationCallOrder[0]);
  });
  it.each(['off', 'unequal', 'unreadable', 'restamp-failed', 'red-team-pending', 'gate-with-hold', 'saved-only', 'saved-unreadable', 'no-saved-reader'])('%s runs the normal arc without a carry comment', mode => {
    const io = fixture();
    // PR #5551 red team: a gate decision on saved (unposted) evidence has no result to re-key, so it is never carried.
    if (mode === 'saved-only') io.readSavedResult = vi.fn(({ head }) => head === a ? { pr: 1, rev: a, findings: [] } : null);
    if (mode === 'saved-unreadable') io.readSavedResult = () => { throw Error('saved red-team evidence malformed'); };
    if (mode === 'no-saved-reader') delete io.readSavedResult;
    if (mode === 'off') io.carryAcrossRebaseSetting = () => ({ value: 'off' });
    if (mode === 'unequal') io.contributionPatchId = ({ sha }) => sha === a ? p : a;
    if (mode === 'unreadable') io.readCarryEvidence = () => { throw Error('read failed'); };
    if (mode === 'restamp-failed') io.restampVerdict.mockReturnValue({ ok: false, reason: 'own proof refused' });
    if (mode === 'red-team-pending') io.readCarryEvidence = () => ({ headSha: b, comments: [trusted(`<!-- reviewed-sha: ${a} -->`)] });
    if (mode === 'gate-with-hold') io.readCarryEvidence = () => ({ headSha: b, comments: [trusted(`<!-- reviewed-sha: ${a} -->`),
      trusted(`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->\nunknown hold`)] });
    const out = runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(out.outcome).not.toBe('carried'); expect(io.runLoop).toHaveBeenCalledTimes(1); expect(io.postCarryComment).not.toHaveBeenCalled();
    if (['red-team-pending', 'gate-with-hold', 'saved-only', 'saved-unreadable', 'no-saved-reader'].includes(mode)) expect(io.restampVerdict).not.toHaveBeenCalled();
  });
});

describe('human clearance remains owned by restamp', () => {
  it.each([true, false])('equal patches carry human clearance only if the restamp agrees (%s)', async agrees => {
    const { decideRestampHumanClearance, buildVerdictComment } = await import('../../review-set-label.mjs');
    const { parseLatestHumanClearedSha, parseReviewedSha, decideContradictoryVerdictHeal } = await import('../../lib/review-escalation.mjs');
    const oldDiff = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n';
    const comments = [trusted(buildVerdictComment({ to: 'clear-human', actor: 'operator', headSha: a, reviewedDiff: oldDiff })),
      trusted(`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->`)];
    const io = fixture(); io.readCarryEvidence = () => ({ headSha: b, comments });
    io.restampVerdict = vi.fn(() => {
      const humanClearance = decideRestampHumanClearance({ comments, headSha: b, headDiff: agrees ? oldDiff : oldDiff.replace('+new', '+changed') });
      comments.push(trusted(buildVerdictComment({ to: 'restamp', actor: 'review-carry', headSha: b, reviewedDiff: oldDiff, humanClearance })));
      return { ok: true };
    });
    expect(runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io).outcome).toBe('carried');
    comments.push(trusted(io.postCarryComment.mock.calls[0][0].body));
    expect(parseLatestHumanClearedSha(comments)).toBe(agrees ? b : null);
    const heal = decideContradictoryVerdictHeal({ currentLabels: ['review:accepted', 'review:human'], headSha: b,
      humanClearedSha: parseLatestHumanClearedSha(comments), acceptedSha: parseReviewedSha(comments), fetchOk: true });
    expect(heal.heal).toBe(!agrees);
    const { sweepReviewHoldLabels } = await import('../../conveyor/review-hold-reconcile.mjs');
    const provider = { readPrState: () => ({ state: 'OPEN', number: 1, labels: ['review:accepted', 'review:human'], headRefOid: b }),
      postComment: vi.fn(), setLabels: vi.fn() };
    const swept = sweepReviewHoldLabels({ repo: 'web-everything/web-everything', listPrs: () => [{ number: 1, labels: ['review:accepted', 'review:human'] }],
      provider, readComments: () => comments, readPr: () => ({ ...provider.readPrState(), comments }), settings: { referralDefault: 'operator' }, acceptCarry: () => [], runRuling: () => [] });
    expect(swept[0].healed ?? []).toEqual(agrees ? [] : ['review:accepted']);

  });
  it('unequal patches never invoke the human restamp writer', () => {
    const io = fixture(); io.contributionPatchId = ({ sha }) => sha === a ? p : b;
    runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(io.restampVerdict).not.toHaveBeenCalled();
  });
});
