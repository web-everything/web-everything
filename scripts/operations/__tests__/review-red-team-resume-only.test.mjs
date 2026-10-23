import { describe, it, expect, vi } from 'vitest';
import { runRedTeam, speculateRedTeam } from '../review-extra-seats.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('red-team CLI --resume-only', () => {
  it.each([
    ['missing', ['--resume-only']],
    ['unreadable', ['--resume-only']],
    ['missing', []],
  ])('guards fresh calls with %s scorecards and flags %j', (store, flags) => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-cli-'));
    try {
      const payloadPath = join(dir, 'loop.json');
      writeFileSync(payloadPath, JSON.stringify(loopPayload));
      // Execute the production CLI handler in a child. Only effect IO is replaced;
      // argv parsing, payload reading and the real runRedTeam guard all execute.
      const source = `
        import { runExtraSeatsCli } from ${JSON.stringify(new URL('../review-extra-seats.mjs', import.meta.url).href)};
        const calls = { provider: 0, reserve: 0, model: 0, recheck: 0 };
        const forbid = key => () => { calls[key]++; throw Error('unexpected ' + key); };
        await runExtraSeatsCli(process.argv.slice(1), { redTeamIo: {
          now: () => 1000, log: () => {},
          readRecords: () => { ${store === 'unreadable' ? "throw Error('EIO');" : 'return [];'} },
          cliAvailable: forbid('provider'), reserveCalls: forbid('reserve'),
          runSeat: forbid('model'), runRecheck: forbid('recheck'),
        } });
        process.stdout.write(JSON.stringify(calls) + '\\n');
      `;
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', source,
        'red-team', `--pr=${pr}`, `--repo=${repo}`, `--lane=${dir}`, `--loop-json=${payloadPath}`, ...flags], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { PATH: '', WE_REVIEW_EXTRA_SEATS: '1', WE_REVIEW_RED_TEAM: '1', WE_RED_TEAM_SKIP_CARD_ONLY: '0' },
      });
      const [result, calls] = output.trim().split('\n').map(line => JSON.parse(line));
      if (!flags.length) {
        // Positive control: the same valid input reaches provider selection without
        // the CLI guard. The fake throws before any provider can actually execute.
        expect(result).toEqual({ status: 'error', reason: 'unexpected provider' });
        expect(calls).toEqual({ provider: 1, reserve: 0, model: 0, recheck: 0 });
        return;
      }
      expect(result).toEqual({ status: 'skipped', reason: store === 'unreadable'
        ? 'resume-only: scorecard store unreadable — no call launched'
        : 'resume-only: no clean prior red-team row — no call launched' });
      expect(calls).toEqual({ provider: 0, reserve: 0, model: 0, recheck: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

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
