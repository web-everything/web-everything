// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { execGitRetrying, isTransientGitFailure } from '../git-retry-transient.mjs';

const PROMISOR_503 = Object.assign(new Error('Command failed: git archive'), {
  status: 128,
  stderr: Buffer.from("fatal: unable to access 'https://github.com/web-everything/web-everything/': The requested URL returned error: 503\nfatal: could not fetch 214f09e from promisor remote"),
});

describe('execGitRetrying', () => {
  it('classifies a promisor-remote 503 as transient and a missing object as not', () => {
    expect(isTransientGitFailure(PROMISOR_503)).toBe(true);
    expect(isTransientGitFailure(Object.assign(new Error('x'), { stderr: 'fatal: bad object deadbeef' }))).toBe(false);
  });

  it('retries a transient failure and returns the eventual success', () => {
    const exec = vi.fn().mockImplementationOnce(() => { throw PROMISOR_503; }).mockReturnValueOnce('ok');
    const sleep = vi.fn();
    expect(execGitRetrying(['archive', 'x'], {}, { exec, sleep })).toBe('ok');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and rethrows the last error', () => {
    const exec = vi.fn(() => { throw PROMISOR_503; });
    expect(() => execGitRetrying(['archive', 'x'], {}, { exec, sleep: vi.fn(), attempts: 3 })).toThrow(PROMISOR_503);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient failure', () => {
    const bad = Object.assign(new Error('bad'), { stderr: 'fatal: bad object deadbeef' });
    const exec = vi.fn(() => { throw bad; });
    expect(() => execGitRetrying(['show', 'x'], {}, { exec, sleep: vi.fn() })).toThrow(bad);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
