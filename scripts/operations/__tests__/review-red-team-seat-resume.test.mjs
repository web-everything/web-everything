// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { finishSpeculativeRedTeam, redTeamReadFingerprint } from '../review-extra-seats.mjs';

const repo = 'web-everything/web-everything', rev = 'a'.repeat(40), pr = 6212;
const read = { title: 'guard', body: 'Claims: guard', diffText: '+guard',
  netChangedFiles: ['x.mjs'], netBasis: { base: 'b'.repeat(40), rev } };
const loopPayload = { verdict: { verdict: 'changes' }, findings: { read,
  judge: { findings: [{ summary: 'juror also found a problem' }] } } };
const env = { WE_RED_TEAM_TIMING: 'panel-seat' };
const prior = { dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev, status: 'ok',
  callId: 'old-call', provider: 'codex', model: 'test', findings: [], recheckStatus: 'ok',
  foldedVerdict: 'accept', confirmedMissCount: 0, changedFiles: ['x.mjs'] };

describe('panel seat reuses live-head evidence', () => {
  it('returns saved findings and re-check status when resuming a completed pass', async () => {
    const postComment = vi.fn(), runSeat = vi.fn();
    const out = await finishSpeculativeRedTeam({ pr, repo, env, loopPayload,
      pass: { status: 'prior-row', rev, readFingerprint: redTeamReadFingerprint(read) } }, {
      readRecords: () => [prior], now: () => Date.now(), log: () => {}, append: vi.fn(),
      listComments: () => [], postComment, runSeat,
    });
    expect(out).toMatchObject({ status: 'ran', rev, findings: [], recheckStatus: 'ok', confirmedMissCount: 0 });
    expect(runSeat).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledOnce();
  });

  it('a prior row never bypasses the pinned read fingerprint', async () => {
    const readRecords = vi.fn(() => [prior]);
    const out = await finishSpeculativeRedTeam({ pr, repo, env, loopPayload,
      pass: { status: 'prior-row', rev, readFingerprint: 'another-read' } }, { readRecords });
    expect(out.status).toBe('stale');
    expect(readRecords).not.toHaveBeenCalled();
  });
});
