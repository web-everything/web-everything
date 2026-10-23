import { describe, it, expect, vi } from 'vitest';
import { runRedTeam, speculateRedTeam } from '../review-extra-seats.mjs';

const pr = 5762, repo = 'web-everything/web-everything', rev = 'a'.repeat(40);
const read = { netBasis: { rev }, netChangedFiles: ['scripts/example.mjs'], diffText: '+export const example = true;' };
const loopPayload = { verdict: { verdict: 'accept' }, findings: { read } };
const prior = { dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', pr, rev,
  callId: 'stored-call', provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' };

for (const entry of [runRedTeam, speculateRedTeam]) {
  describe(`${entry.name} resumeOnly`, () => {
    const run = io => entry({ pr, repo, read, loopPayload, env: {}, resumeOnly: true }, io);
    function fakeIo(readRecords) {
      return { readRecords, now: () => 1_000, log: () => {},
        cliAvailable: vi.fn(), reserveCalls: vi.fn(), runSeat: vi.fn(), runRecheck: vi.fn(),
        listComments: () => [], postComment: vi.fn(), append: vi.fn() };
    }
    function noCalls(io) {
      for (const key of ['cliAvailable', 'reserveCalls', 'runSeat', 'runRecheck']) expect(io[key], key).not.toHaveBeenCalled();
    }
    it('fails closed on an unreadable scorecard store without provider selection, reservation or model calls', async () => {
      const io = fakeIo(() => { throw Error('EIO'); });
      expect(await run(io)).toEqual({ status: 'skipped', reason: 'resume-only: scorecard store unreadable — no call launched' });
      noCalls(io);
    });
    it.each([[], [{ ...prior, status: 'error' }], [{ ...prior, rev: 'b'.repeat(40) }]])('refuses scorecards with no clean prior row: %j', async records => {
      const io = fakeIo(() => records);
      expect(await run(io)).toEqual({ status: 'skipped', reason: 'resume-only: no clean prior red-team row — no call launched' });
      noCalls(io);
    });
    it('resumes a clean prior row and finishes its comment without new reservation or model calls', async () => {
      const io = fakeIo(() => [prior]);
      expect(await run(io)).toMatchObject({ status: 'resumed', callId: prior.callId, comment: { status: 'posted' } });
      expect(io.postComment).toHaveBeenCalledOnce();
      noCalls(io);
    });
    it.each([true, false])('restores a recorded card-only result before applying the current skip (resumeOnly=%s)', async resumeOnly => {
      const cardRead = { ...read, netChangedFiles: ['backlog/123-card.md'] };
      const io = fakeIo(() => [prior]);
      expect(await entry({ pr, repo, read: cardRead,
        loopPayload: { ...loopPayload, findings: { read: cardRead } },
        env: { WE_RED_TEAM_SKIP_CARD_ONLY: '1' }, resumeOnly }, io)).toMatchObject({
        status: 'resumed', callId: prior.callId, comment: { status: 'posted' },
      });
      expect(io.postComment).toHaveBeenCalledOnce();
      noCalls(io);
    });
    it('still skips a fresh card-only call before provider selection or reservation', async () => {
      const cardRead = { ...read, netChangedFiles: ['backlog/123-card.md'] };
      const io = fakeIo(() => []);
      expect(await entry({ pr, repo, read: cardRead,
        loopPayload: { ...loopPayload, findings: { read: cardRead } },
        env: { WE_RED_TEAM_SKIP_CARD_ONLY: '1' } }, io)).toEqual({
        status: 'skipped', reason: 'red team skipped: card-only',
      });
      expect(io.postComment).not.toHaveBeenCalled();
      noCalls(io);
    });
    if (entry === speculateRedTeam) {
      it('reports a recorded card-only result without publishing before the verdict', async () => {
        const io = fakeIo(() => [prior]);
        expect(await entry({ pr, repo, read: { ...read, netChangedFiles: ['backlog/123-card.md'] },
          env: { WE_RED_TEAM_SKIP_CARD_ONLY: '1' }, resume: false }, io)).toMatchObject({ status: 'prior-row' });
        expect(io.postComment).not.toHaveBeenCalled();
        expect(io.append).not.toHaveBeenCalled();
        noCalls(io);
      });
    }
  });
}
