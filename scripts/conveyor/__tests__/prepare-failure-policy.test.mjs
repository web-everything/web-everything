import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPrepareFailure, recordPrepareFailure, readFailureState, validatePrepareRelease, releasedAttempt, readPrepareReleases } from '../prepare-failure-policy.mjs';
import { writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

describe('readPrepareReleases against a real git history', () => {
  it('keeps ancestor entries and drops non-ancestor or malformed ones without throwing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'prepare-releases-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'fix');
      const fixCommit = git('rev-parse', 'HEAD');
      const good = { target: '1', attempt: 'run:a', cause: 'result-lost', evidence: 'x', fixCommit };
      const notAncestor = { ...good, attempt: 'run:b', fixCommit: 'f'.repeat(40) };
      const path = join(repo, 'releases.json');
      writeFileSync(path, JSON.stringify({ releases: [good, notAncestor, { target: '1' }] }));
      const invalid = [];
      expect(readPrepareReleases(path, repo, { onInvalid: entry => invalid.push(entry) })).toEqual([good]);
      expect(invalid).toHaveLength(2);
      writeFileSync(path, 'not json');
      expect(readPrepareReleases(path, repo)).toEqual([]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('prepare failure evidence and durable decisions', () => {
  let dir, path, fileCard;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prepare-policy-')); path = join(dir, 'state.json'); fileCard = vi.fn(() => ({ ok: true, handle: 'pid:42' })); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it.each([
    [{ stoppedBeforeCompletion: true }, 'agent-stopped-early'],
    [{ sessionAbsent: true }, 'no-session'],
    [{ resultAuthored: true, resultDiscarded: true }, 'result-lost'],
    [{ error: 'HTTP 429 rate limit' }, 'infra-transient'],
    [{ error: 'ECONNRESET' }, 'infra-transient'],
    [{ error: 'wrapper-failed' }, 'unknown'],
    [{ error: 'timeout' }, 'unknown'],
    [{ resultDiscarded: true }, 'unknown'],
  ])('records evidence %j as %s', async (evidence, cause) => {
    const row = await recordPrepareFailure({ num: '1', attempt: 'run:a', stage: 'result', evidence }, { path, fileCard });
    expect(row.cause).toBe(cause);
    expect(row.held).toBe(cause !== 'infra-transient');
    expect(Object.values(readFailureState(path).failures)[0].evidence).toEqual(evidence);
    expect(classifyPrepareFailure(evidence)).toBe(cause);
  });
  it('only retries observed infrastructure faults, at most twice across restarts; rereads consume no budget', async () => {
    const input = { num: '1', stage: 'dispatch', evidence: { error: 'ECONNRESET' } };
    const first = await recordPrepareFailure({ ...input, attempt: 'a' }, { path, fileCard });
    expect(first.retry).toBe(true);
    expect(await recordPrepareFailure({ ...input, attempt: 'a' }, { path, fileCard })).toEqual(first);
    expect((await recordPrepareFailure({ ...input, attempt: 'b' }, { path, fileCard })).retry).toBe(true);
    expect((await recordPrepareFailure({ ...input, attempt: 'c' }, { path, fileCard })).held).toBe(true);
    expect(fileCard).not.toHaveBeenCalled();
  });
  it('holds unknowns and files once per distinct cause across items and restarts', async () => {
    for (const num of ['1', '2', '1']) await recordPrepareFailure({ num, attempt: 'a', stage: 'result', evidence: { causeKey: 'missing-worker-result' } }, { path, fileCard });
    expect(fileCard).toHaveBeenCalledTimes(1);
    expect(Object.values(readFailureState(path).failures).every(f => f.held && !f.retry && f.prevention.status === 'queued')).toBe(true);
  });
  it('a corrupt ledger degrades to empty state and keeps the bytes for diagnosis instead of throwing', () => {
    writeFileSync(path, '{"failures": {');
    expect(readFailureState(path)).toEqual({ failures: {}, cards: {} });
    expect(readdirSync(dir).some(n => n.includes('.corrupt-'))).toBe(true);
  });
  it('records filing failure without claiming success or blind respawning', async () => {
    fileCard.mockImplementation(() => { throw new Error('spawn refused'); });
    const input = { num: '1', attempt: 'a', stage: 'result' };
    expect((await recordPrepareFailure(input, { path, fileCard })).prevention.status).toBe('failed');
    await recordPrepareFailure(input, { path, fileCard });
    expect(fileCard).toHaveBeenCalledTimes(1);
  });
  it('refuses uncited, unknown-cause, or unapplied releases and binds accepted releases to exact attempt', () => {
    const entry = { target: '1', attempt: 'run:a', cause: 'result-lost', evidence: 'observed stamp error and repair', fixCommit: 'a'.repeat(40) };
    expect(() => validatePrepareRelease({ ...entry, fixCommit: '' }, () => true)).toThrow(/refused/);
    expect(() => validatePrepareRelease({ ...entry, cause: 'unknown' }, () => true)).toThrow(/refused/);
    expect(() => validatePrepareRelease(entry, () => false)).toThrow(/ancestor/);
    const releases = [validatePrepareRelease(entry, () => true)];
    expect(releasedAttempt(releases, '1', 'run:a')).toBe(true);
    expect(releasedAttempt(releases, '1', 'run:b')).toBe(false);
    expect(releasedAttempt(releases, 'route:prepare', 'run:a')).toBe(false);
  });
});

describe('builder-starved-2 — a prepare that never got a lane is infrastructure, not the card', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prepare-lane-infra-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const terminal = "I couldn't acquire lane 57, so no prepare pass was done on #4560.\n- `lane-pool.mjs acquire` failed with `could not determine an origin URL`.";
  it('classifies the lane-acquire origin failure as infra-transient', () => {
    expect(classifyPrepareFailure({ error: 'build-dispatch-orphan-adopt: dispatch retired (prepare-unstamped)', terminal, reason: 'prepare-unstamped' }, 'result')).toBe('infra-transient');
  });
  it('releases an old held `unknown` record of that failure (the live #4560 hold)', async () => {
    const path = join(dir, 'prepare-failures.json');
    writeFileSync(path, JSON.stringify({ failures: { '4560:run x:result': { num: '4560', attempt: 'run x', stage: 'result', cause: 'unknown',
      evidence: { error: 'build-dispatch-orphan-adopt: dispatch retired (prepare-unstamped)', terminal, reason: 'prepare-unstamped' },
      retry: false, held: true, recordedAt: '2026-10-07T12:00:00.000Z' } }, cards: {} }));
    const { releaseDuePrepareRetries } = await import('../prepare-failure-policy.mjs');
    expect(releaseDuePrepareRetries({ path, now: Date.parse('2026-10-07T19:00:00Z') })).toEqual(['4560']);
    expect(readFailureState(path).failures['4560:run x:result']).toMatchObject({ held: false, retry: true, cause: 'infra-transient', healedFrom: 'unknown' });
  });
});
