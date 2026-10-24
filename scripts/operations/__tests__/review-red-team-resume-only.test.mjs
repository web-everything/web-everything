import { describe, it, expect, vi } from 'vitest';
import { priorRedTeamRow, redTeamAlreadyRan, runRedTeam, speculateRedTeam } from '../review-extra-seats.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
        import { runExtraSeatsCli } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-extra-seats.mjs')).href)};
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
const prior = { dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', pr, repo, rev,
  callId: 'stored-call', provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' };

describe('red-team scorecard repository identity', () => {
  const foreign = { ...prior, repo: 'other/repo', callId: 'foreign-call', findings: [{
    summary: 'Foreign confirmed broken finding', confirmedByRecheck: true, impactIfUnfixed: 'broken',
  }] };
  it('selects the target repository even when a foreign clean row is last', () => {
    expect(priorRedTeamRow([prior, foreign], pr, rev, repo)).toBe(prior);
    expect(redTeamAlreadyRan([prior, foreign], pr, rev, repo)).toBe(true);
  });
  it.each([foreign, { ...prior, repo: undefined }])('rejects foreign and legacy rows: %j', row => {
    expect(priorRedTeamRow([row], pr, rev, repo)).toBeNull();
    expect(redTeamAlreadyRan([row], pr, rev, repo)).toBe(false);
  });
  it.each([undefined, null, '', '   ', 42])('requires a non-empty repository: %j', invalidRepo => {
    expect(priorRedTeamRow([{ ...prior, repo: invalidRepo }], pr, rev, invalidRepo)).toBeNull();
    expect(redTeamAlreadyRan([{ ...prior, repo: invalidRepo }], pr, rev, invalidRepo)).toBe(false);
  });
});

describe('runRedTeam pre-launch deferrals', () => {
  it.each(['quota-hold', 'reservation-error'])('marks %s retryable without a model call or seat row', async failure => {
    const now = Date.parse('2026-10-23T15:00:00Z');
    const io = {
      now: () => now, log: () => {},
      readRecords: () => failure === 'quota-hold' ? [{
        dispatchKind: 'review-seat', provider: 'codex', status: 'quota-exhausted',
        scoredAt: new Date(now).toISOString(), quotaResetsAt: new Date(now + 3_600_000).toISOString(),
      }] : [],
      cliAvailable: provider => provider === 'codex',
      reserveCalls: vi.fn(() => { throw Error('reservation EIO'); }),
      runSeat: vi.fn(), append: vi.fn(), postComment: vi.fn(), makeScratch: vi.fn(),
    };
    const result = await runRedTeam({ pr, repo, read, loopPayload, env: {} }, io);
    expect(result).toMatchObject({ status: 'skipped', deferredByCap: true,
      reason: expect.stringContaining(failure === 'quota-hold' ? 'quota' : 'no call launched') });
    expect(io.reserveCalls).toHaveBeenCalledTimes(failure === 'quota-hold' ? 0 : 1);
    for (const key of ['runSeat', 'append', 'postComment', 'makeScratch']) expect(io[key], key).not.toHaveBeenCalled();
  });
});

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
    it.each([[], [{ ...prior, status: 'error' }], [{ ...prior, rev: 'b'.repeat(40) }],
      [{ ...prior, repo: 'other/repo' }], [{ ...prior, repo: undefined }]])('refuses scorecards with no clean prior row: %j', async records => {
      const io = fakeIo(() => records);
      expect(await run(io)).toEqual({ status: 'skipped', reason: 'resume-only: no clean prior red-team row — no call launched' });
      expect(io.postComment).not.toHaveBeenCalled();
      noCalls(io);
    });
    it('publishes only the target findings when a foreign confirmed break is the last clean row', async () => {
      const target = { ...prior, findings: [{ summary: 'Target repository finding', filesRead: ['scripts/example.mjs'] }] };
      const foreign = { ...prior, repo: 'other/repo', callId: 'foreign-call', foldedVerdict: 'changes', findings: [{
        summary: 'Foreign confirmed broken finding', confirmedByRecheck: true,
        filesRead: ['scripts/example.mjs'], recheckReason: 'demonstrated break',
      }] };
      const io = fakeIo(() => [target, foreign]);
      expect(await run(io)).toMatchObject({ status: 'resumed', callId: target.callId, comment: { status: 'posted' } });
      expect(io.postComment).toHaveBeenCalledOnce();
      expect(io.postComment).toHaveBeenCalledWith({ pr, repo,
        body: expect.stringContaining('Target repository finding') });
      for (const [comment] of io.postComment.mock.calls) expect(comment.body).not.toContain('Foreign confirmed broken finding');
      expect(io.append).not.toHaveBeenCalled();
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
