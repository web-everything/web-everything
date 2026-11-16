import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPrepareFailure, recordPrepareFailure, readFailureState, validatePrepareRelease, releasedAttempt } from '../prepare-failure-policy.mjs';

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
