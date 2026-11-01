import { describe, it, expect, vi } from 'vitest';
import { createRedTeamIo, priorRedTeamRow, redTeamAlreadyRan, redTeamMarker, runRedTeam, speculateRedTeam } from '../review-extra-seats.mjs';
import { readStore } from '../../conveyor/run-scorecard-store.mjs';
import { readCompletePrComments } from '../../conveyor/pr-comments-complete.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

vi.mock('../../conveyor/pr-comments-complete.mjs', () => ({ readCompletePrComments: vi.fn(() => []) }));

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

describe('shared red-team recovery entry guards', () => {
  const finished = result => ({ repo, pr, head: rev, status: 'finished', result });
  function fakeIo(mode, over = {}) {
    return { now: () => 1_000, log: () => {},
      readRecords: vi.fn(() => mode === 'resume' ? [prior] : []),
      readRedTeamStatus: vi.fn(() => mode === 'resume' ? finished('ran') : null),
      readRecoveryComments: vi.fn(() => []), listComments: () => [],
      cliAvailable: vi.fn(() => { throw Error('provider reached'); }),
      reserveCalls: vi.fn(), runSeat: vi.fn(), runRecheck: vi.fn(), makeScratch: vi.fn(),
      postComment: vi.fn(), append: vi.fn(), ...over };
  }
  const run = (redTeamMode, io, extra = {}) => runRedTeam({ pr, repo, loopPayload, env: {}, redTeamMode, ...extra }, io);
  function noLaunch(io) {
    for (const key of ['cliAvailable', 'reserveCalls', 'runSeat', 'runRecheck', 'makeScratch']) expect(io[key], key).not.toHaveBeenCalled();
  }
  async function refused(mode, io, reason, extra) {
    expect(await run(mode, io, extra)).toEqual({ status: 'not-owed',
      ...(reason === 'red-team result already on head' ? {} : { deferredByGuard: true }),
      reason: `${reason}; inspect stored evidence before retrying — no call launched` });
    noLaunch(io);
    for (const key of ['postComment', 'append']) expect(io[key], key).not.toHaveBeenCalled();
  }
  it('live bare resumed review-pr row without a seat follows fresh dispatch', async () => {
    const row = { repo, pr: 5762, head: rev, status: 'finished', result: 'resumed', loopPayload: { ...loopPayload, op: 'review-pr' } };
    const io = fakeIo('fresh', { readRedTeamStatus: () => row });
    expect(await run('fresh', io)).toEqual({ status: 'error', reason: 'provider reached' });
    expect(io.cliAvailable).toHaveBeenCalled();
  });
  it('live bare resumed review-pr row with a clean seat resumes that seat', async () => {
    const row = { repo, pr: 5762, head: rev, status: 'finished', result: 'resumed', loopPayload: { ...loopPayload, op: 'review-pr' } };
    const io = fakeIo('resume', { readRedTeamStatus: () => row });
    expect(await run('resume', io)).toMatchObject({ status: 'resumed', callId: prior.callId });
    noLaunch(io);
  });
  async function withOversizedComments(check) {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-large-comments-'));
    try {
      const comments = [{ author: { login: 'someone' }, body: 'x'.repeat(2 * 1024 * 1024 + 1024) }];
      writeFileSync(join(dir, 'comments.json'), JSON.stringify({ comments }));
      writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json') && args.includes('comments')) {
  fs.writeFileSync(1, fs.readFileSync(path.join(__dirname, 'comments.json')));
} else if (args[0] === 'pr' && args[1] === 'comment' && args.includes('--body-file')) {
  fs.writeFileSync(path.join(__dirname, 'posted.txt'), fs.readFileSync(0));
} else {
  process.exitCode = 1;
}
`, { mode: 0o755 });
      const production = createRedTeamIo({ env: { PATH: dir }, storePath: join(dir, 'scorecards.json') });
      await check({ production, comments, postedBody: () => readFileSync(join(dir, 'posted.txt'), 'utf8') });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('reads more than 2 MiB of comments and posts through the production gh helper', async () => {
    await withOversizedComments(({ production, comments, postedBody }) => {
      expect(production.listComments({ pr, repo })).toEqual(comments);
      production.postComment({ pr, repo, body: 'red-team result' });
      expect(postedBody()).toBe('red-team result');
    });
  });
  it('resumes a recorded clean pass with oversized comments and posts its result without model calls', async () => {
    await withOversizedComments(async ({ production, postedBody }) => {
      const io = fakeIo('resume', { listComments: production.listComments, postComment: production.postComment });
      const result = await run('resume', io);
      expect(result).toMatchObject({ status: 'resumed', callId: prior.callId, comment: { status: 'posted' } });
      expect(postedBody()).toBe(result.comment.body);
      expect(postedBody()).toContain(redTeamMarker(pr, rev));
      noLaunch(io);
    });
  });
  it('reports a spawn error when gh has no stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-missing-gh-'));
    try {
      const io = createRedTeamIo({ env: { PATH: dir }, storePath: join(dir, 'scorecards.json') });
      expect(() => io.listComments({ pr, repo })).toThrow(/gh pr view failed: .*ENOENT/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('includes the comment failure reason in the resume summary', async () => {
    const io = fakeIo('resume', { listComments: () => { throw Error('comment read failed: ENOBUFS'); } });
    const result = await run('resume', io);
    expect(result.comment).toMatchObject({ status: 'error', reason: 'comment read failed: ENOBUFS' });
    expect(result.reason).toContain('comment error (comment read failed: ENOBUFS)');
    expect(io.postComment).not.toHaveBeenCalled();
    noLaunch(io);
  });
  it.each(['fresh', 'resume'])('refuses a result posted after the daemon snapshot in %s mode with zero model calls', async mode => {
    const io = fakeIo(mode, { readRecoveryComments: vi.fn(() => [{ author: { login: 'web-everything' }, body: redTeamMarker(pr, rev) }]) });
    await refused(mode, io, 'red-team result already on head');
    expect(io.readRecoveryComments).toHaveBeenCalledOnce();
    expect(io.readRecoveryComments).toHaveBeenCalledWith({ pr, repo });
  });
  it.each(['fresh', 'resume'].flatMap(mode => ['throws', 'malformed', 'missing-hook'].map(kind => ({ mode, kind }))))(
    'refuses an unreadable complete PR thread ($kind) in $mode mode with zero model calls', async ({ mode, kind }) => {
      const io = fakeIo(mode, { readRecoveryComments: kind === 'missing-hook' ? undefined : vi.fn(() => {
        if (kind === 'throws') throw Error('unreadable');
        return null;
      }) });
      await refused(mode, io, 'PR comments unreadable');
    });
  it.each(['fresh', 'resume'].flatMap(mode => ['unreadable', 'malformed', 'missing-hook'].map(kind => ({ mode, kind }))))(
    'refuses $kind scorecards in $mode mode with zero model calls', async ({ mode, kind }) => {
      const io = fakeIo(mode, { readRecords: kind === 'missing-hook' ? undefined : vi.fn(() => {
        if (kind === 'unreadable') throw Error('unreadable');
        return null;
      }) });
      await refused(mode, io, 'scorecard store unreadable');
      if (io.readRecords) expect(io.readRecords).toHaveBeenCalledWith({ strict: true });
    });
  it.each(['fresh', 'resume'].flatMap(mode => ['throws', 'undefined', 'missing-hook'].map(kind => ({ mode, kind }))))(
    'refuses $kind head status in $mode mode with zero model calls', async ({ mode, kind }) => {
      const io = fakeIo(mode, { readRedTeamStatus: kind === 'missing-hook' ? undefined : vi.fn(() => {
        if (kind === 'throws') throw Error('unreadable');
      }) });
      await refused(mode, io, 'red-team status unreadable');
    });
  it.each(['error', 'skipped', 'disabled', 'not-owed', null].flatMap(result => [result, { status: result }]))(
    'refuses a finished non-recoverable result %j with zero model calls', async result => {
      await refused('resume', fakeIo('resume', { readRedTeamStatus: () => finished(result) }), 'prior red-team result is not resumable');
    });
  it.each(['ran', 'resumed'].flatMap(status => [
    { status, comment: 'posted' }, { status, comment: { status: 'posted' } },
  ]))('refuses resume result %j already recorded as posted with zero model calls', async result => {
    await refused('resume', fakeIo('resume', { readRedTeamStatus: () => finished(result) }), 'prior red-team result is not resumable');
  });
  it.each([null, 'queued', 'running', 'error'])('requires a finished resume status, refusing %s with zero model calls', async status => {
    await refused('resume', fakeIo('resume', { readRedTeamStatus: () => status && { ...finished('ran'), status } }), 'prior red-team result is not resumable');
  });
  it.each(['ran', 'resumed'].flatMap(result =>
    ['missing', 'error-row', 'wrong-head', 'wrong-repo', 'legacy-repo'].map(kind => ({ result, kind }))))(
    'refuses $result resume on $kind scorecards with zero model calls', async ({ result, kind }) => {
      const records = kind === 'missing' ? [] : [{ ...prior,
        ...(kind === 'error-row' ? { status: 'error' } : {}),
        ...(kind === 'wrong-head' ? { rev: 'b'.repeat(40) } : {}),
        ...(kind === 'wrong-repo' ? { repo: 'other/repo' } : {}),
        ...(kind === 'legacy-repo' ? { repo: undefined } : {}),
      }];
      await refused('resume', fakeIo('resume', { readRedTeamStatus: () => finished(result), readRecords: () => records }), 'no clean prior red-team row');
    });
  it.each(['ok', 'error', 'quota-exhausted', 'unknown', undefined])('refuses fresh recovery with any prior row status %s and zero model calls', async status => {
    const io = fakeIo('fresh', { readRecords: vi.fn(() => [{ ...prior, status }]) });
    await refused('fresh', io, 'prior red-team seat row; not re-run');
    expect(io.readRecords).toHaveBeenCalledOnce();
    expect(io.readRedTeamStatus).toHaveBeenCalledWith({ pr, repo, head: rev });
  });
  it.each(['finished', 'queued', 'running', 'error', 'unknown'])('refuses fresh recovery with prior %s status and zero model calls', async status => {
    await refused('fresh', fakeIo('fresh', { readRedTeamStatus: () => ({ ...finished({ status: 'ran' }), status }) }), 'prior red-team status; not re-run');
  });
  it('refuses direct fresh recovery without admission for an abandoned running live writer with zero calls', async () => {
    const status = { repo, pr, head: rev, status: 'running', result: null, pid: process.pid,
      staleAbandoned: { at: '2026-01-01T00:00:00.000Z', pid: process.pid } };
    expect(() => process.kill(status.pid, 0)).not.toThrow();
    const io = fakeIo('fresh', { readRedTeamStatus: () => status });
    await refused('fresh', io, 'prior red-team status; not re-run');
  });
  it.each(['ran', 'resumed', { status: 'resumed' }])('a finished placeholder %j without a seat reaches fresh dispatch', async result => {
    const io = fakeIo('fresh', { readRedTeamStatus: () => finished(result) });
    expect(await run('fresh', io)).toEqual({ status: 'error', reason: 'provider reached' });
    expect(io.cliAvailable).toHaveBeenCalledOnce();
    for (const hook of ['reserveCalls', 'runSeat', 'runRecheck']) expect(io[hook]).not.toHaveBeenCalled();
  });
  it.each([false, true])('refuses a finished null result without queued provenance and with no seat or comment (admitted=%s)', async admitted => {
    const status = finished(null);
    const io = fakeIo('fresh', { readRedTeamStatus: () => admitted
      ? { status: 'queued', pid: 42, result: null } : status });
    await refused('fresh', io, 'prior red-team status; not re-run', admitted
      ? { redTeamAdmission: { pid: 42, prior: status } } : {});
  });
  it.each(['ran', { status: 'ran', comment: 'error' }, 'resumed', { status: 'resumed', comment: { status: 'error' } }])(
    'resumes both production result shapes %j with a clean matching row and zero model calls', async result => {
      const io = fakeIo('resume', { readRedTeamStatus: () => finished(result) });
      expect(await run('resume', io)).toMatchObject({ status: 'resumed', callId: prior.callId, comment: { status: 'posted' } });
      noLaunch(io);
      expect(io.postComment).toHaveBeenCalledOnce();
    });
  it.each([{ ...prior, repo: 'other/repo' }, { ...prior, rev: 'b'.repeat(40) }, { ...prior, pr: pr + 1 }])(
    'does not count another identity as fresh-mode evidence: %j', async row => {
      const io = fakeIo('fresh', { readRecords: () => [row] });
      expect(await run('fresh', io)).toEqual({ status: 'error', reason: 'provider reached' });
      expect(io.cliAvailable).toHaveBeenCalledOnce();
      expect(io.runSeat).not.toHaveBeenCalled();
    });
  it('leaves normal full reviews free to resume without recovery readers', async () => {
    const io = fakeIo('resume', { readRedTeamStatus: vi.fn(() => { throw Error('unavailable'); }),
      readRecoveryComments: vi.fn(() => { throw Error('unavailable'); }) });
    expect(await run(undefined, io)).toMatchObject({ status: 'resumed' });
    expect(io.readRedTeamStatus).not.toHaveBeenCalled();
    expect(io.readRecoveryComments).not.toHaveBeenCalled();
    noLaunch(io);
  });
  it.each(['fresh', 'resume'])('uses the production strict store read and shared complete-comments reader in %s mode', async mode => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-recovery-'));
    const path = join(dir, 'scorecards.json');
    try {
      writeFileSync(path, '{broken');
      const production = createRedTeamIo({ env: {}, storePath: path });
      const io = fakeIo(mode, { readRecords: production.readRecords });
      await refused(mode, io, 'scorecard store unreadable');
      writeFileSync(path, JSON.stringify({ records: mode === 'resume' ? [prior] : [] }));
      io.readRecoveryComments = production.readRecoveryComments;
      readCompletePrComments.mockClear();
      expect((await run(mode, io)).status).toBe(mode === 'resume' ? 'resumed' : 'error');
      expect(readCompletePrComments).toHaveBeenCalledOnce();
      expect(readCompletePrComments).toHaveBeenCalledWith(pr, { repo, exec: expect.any(Function) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['fresh', 'resume'])('preserves strict EIO failures in %s recovery with zero model calls', async mode => {
    const io = fakeIo(mode, { readRecords: options => readStore({ ...options, path: 'injected-scorecards.json',
      exists: () => true, read: () => { throw Object.assign(Error('EIO'), { code: 'EIO' }); } }).records });
    await refused(mode, io, 'scorecard store unreadable');
  });
  it.each(['fresh', 'resume'])('verifies the queued admission and its prior status in %s mode', async mode => {
    const status = mode === 'resume' ? finished('ran') : null;
    const io = fakeIo(mode, { readRedTeamStatus: () => ({ repo, pr, head: rev, status: 'queued', pid: 42, result: status?.result ?? null }) });
    const extra = { redTeamAdmission: { pid: 42, prior: status } };
    expect((await run(mode, io, extra)).status).toBe(mode === 'resume' ? 'resumed' : 'error');
    if (mode === 'resume') noLaunch(io);
    else expect(io.cliAvailable).toHaveBeenCalledOnce();
  });
  it.each(['finished', 'error', 'queued'])('cannot hide a prior %s status behind fresh queued admission', async status => {
    const io = fakeIo('fresh', { readRedTeamStatus: () => ({ status: 'queued', pid: 42, result: null }) });
    await refused('fresh', io, 'prior red-team status; not re-run', {
      redTeamAdmission: { pid: 42, prior: { repo, pr, head: rev, status, result: 'error' } },
    });
  });
  it.each(['writer', 'result', 'prior-repo', 'missing-prior'])('refuses changed or incomplete queued admission (%s) with zero model calls', async kind => {
    const io = fakeIo('resume', { readRedTeamStatus: () => ({ status: 'queued', pid: kind === 'writer' ? 99 : 42,
      result: kind === 'result' ? null : 'ran' }) });
    await refused('resume', io, kind === 'prior-repo' ? 'prior red-team status identity mismatch'
      : kind === 'result' ? 'red-team admission result changed' : 'red-team admission changed', {
      redTeamAdmission: { pid: 42, ...(kind === 'missing-prior' ? {} : { prior: { ...finished('ran'), ...(kind === 'prior-repo' ? { repo: 'other/repo' } : {}) } }) },
    });
  });
});

describe('red-team CLI recovery mode plumbing', () => {
  it.each(['fresh', 'resume'])('enforces %s guards through the production child argv with zero model calls', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-recovery-cli-'));
    try {
      const payloadPath = join(dir, 'loop.json');
      writeFileSync(payloadPath, JSON.stringify(loopPayload));
      const source = `
        import { runExtraSeatsCli, redTeamMarker } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-extra-seats.mjs')).href)};
        import { redTeamRunnerArgs } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-job.mjs')).href)};
        const [mode, loopFile, lanePath] = process.argv.slice(1);
        const pr = ${pr}, repo = ${JSON.stringify(repo)}, head = ${JSON.stringify(rev)};
        const prior = ${JSON.stringify(prior)};
        const calls = { provider: 0, reserve: 0, model: 0, recheck: 0, post: 0, append: 0 };
        const forbid = key => () => { calls[key]++; throw Error('unexpected ' + key); };
        for (const failure of ['late-result', 'comments', 'scorecards', 'evidence', 'admitted-late-result']) {
          const admission = failure === 'admitted-late-result' ? { pid: 42,
            prior: mode === 'resume' ? { repo, pr, head, status: 'finished', result: 'ran' } : null } : undefined;
          const io = {
            now: () => 1000, log: () => {},
            readRecords: () => {
              if (failure === 'scorecards') throw Error('EIO');
              return mode === 'resume' ? [prior] : failure === 'evidence' ? [{ ...prior, status: 'error' }] : [];
            },
            readRedTeamStatus: () => admission ? { status: 'queued', pid: 42, result: mode === 'resume' ? 'ran' : null }
              : mode === 'resume' ? { status: 'finished', result: failure === 'evidence' ? 'error' : 'ran' } : null,
            readRecoveryComments: () => {
              if (failure === 'comments') throw Error('thread incomplete');
              return failure.endsWith('late-result') ? [{ body: redTeamMarker(pr, head), author: { login: 'web-everything' } }] : [];
            },
            cliAvailable: forbid('provider'), reserveCalls: forbid('reserve'),
            runSeat: forbid('model'), runRecheck: forbid('recheck'),
            postComment: forbid('post'), append: forbid('append'),
          };
          const argv = redTeamRunnerArgs({ pr, repo, lanePath, loopFile, redTeamMode: mode, redTeamAdmission: admission });
          await runExtraSeatsCli(argv.slice(1), { redTeamIo: io });
        }
        process.stdout.write(JSON.stringify(calls) + '\\n');
      `;
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', source, mode, payloadPath, dir], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { PATH: '', WE_REVIEW_EXTRA_SEATS: '1', WE_REVIEW_RED_TEAM: '1' },
      });
      const results = output.trim().split('\n').map(line => JSON.parse(line));
      expect(results.pop()).toEqual({ provider: 0, reserve: 0, model: 0, recheck: 0, post: 0, append: 0 });
      expect(results).toEqual(['red-team result already on head', 'PR comments unreadable', 'scorecard store unreadable',
        mode === 'resume' ? 'prior red-team result is not resumable' : 'prior red-team seat row; not re-run',
        'red-team result already on head'].map(reason => ({ status: 'not-owed',
        ...(reason === 'red-team result already on head' ? {} : { deferredByGuard: true }),
        reason: reason + '; inspect stored evidence before retrying — no call launched' })));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

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
        status: 'skipped', reason: 'red team skipped: card-only', policy: 'card-only',
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


describe('PR 5890 completed-seat dedupe', () => {
  it.each([{ status: 'error' }, { seatStatus: 'error' }])('does not treat a failed execution as a prior pass: %j', fields => {
    expect(priorRedTeamRow([{ ...prior, ...fields }], pr, rev, repo)).toBeNull();
  });
  it('a completed broken row dedupes speculation without claiming a clean verdict', async () => {
    const broken = { ...prior, foldedVerdict: 'changes', confirmedMissCount: 1,
      findings: [{ summary: 'Confirmed break', confirmedByRecheck: true, impactIfUnfixed: 'broken' }] };
    const io = { now: () => 1_000, log: () => {}, readRecords: () => [broken],
      listComments: () => [{ author: { login: 'web-everything' }, body: redTeamMarker(pr, rev) }],
      cliAvailable: vi.fn(() => { throw Error('must not launch another pass'); }) };
    const result = await speculateRedTeam({ pr, repo, read, env: {}, resume: false }, io);
    expect(priorRedTeamRow([broken], pr, rev, repo)).toBe(broken);
    expect(result).toMatchObject({ status: 'prior-row', reason: expect.stringContaining('completed red-team seat row') });
    expect(result.reason).not.toContain('clean');
    expect(io.cliAvailable).not.toHaveBeenCalled();
  });
  it('a completed confirmed break resumes its effects with zero new model calls', async () => {
    const broken = { ...prior, foldedVerdict: 'changes', confirmedMissCount: 1,
      findings: [{ summary: 'Confirmed break', confirmedByRecheck: true, impactIfUnfixed: 'broken' }] };
    const io = { now: () => 1_000, log: () => {}, readRecords: () => [broken], listComments: () => [],
      postComment: vi.fn(), append: vi.fn(),
      cliAvailable: vi.fn(), reserveCalls: vi.fn(), runSeat: vi.fn(), runRecheck: vi.fn() };
    const result = await runRedTeam({ pr, repo, loopPayload, env: {} }, io);
    expect(result).toMatchObject({ status: 'resumed', callId: prior.callId, comment: { status: 'posted' } });
    expect(result.reason).not.toContain('clean');
    expect(io.postComment.mock.calls[0][0].body).toContain('Confirmed break');
    expect(io.append).toHaveBeenCalled();
    for (const hook of ['cliAvailable', 'reserveCalls', 'runSeat', 'runRecheck']) expect(io[hook]).not.toHaveBeenCalled();
  });
  it.each([{ findings: null }, { findings: undefined }, { confirmedMissCount: 'unknown' },
    { confirmedMissCount: 1 }, { foldedVerdict: 'changes' }, { foldedVerdict: 'needs-human' },
    { foldedVerdict: 'unknown' }, { foldedVerdict: 'changes', findings: [{ summary: 'Unconfirmed' }] }])(
    'incomplete completed-row evidence fails closed without publishing or rerunning: %j', async fields => {
      const row = { ...prior, ...fields };
      const io = { now: () => 1_000, log: () => {}, readRecords: () => [row],
        listComments: () => [], postComment: vi.fn(), cliAvailable: vi.fn() };
      expect(priorRedTeamRow([row], pr, rev, repo)).toBe(row);
      expect(await runRedTeam({ pr, repo, loopPayload, env: {} }, io)).toMatchObject({ status: 'error' });
      expect(io.postComment).not.toHaveBeenCalled();
      expect(io.cliAvailable).not.toHaveBeenCalled();
    });
});
