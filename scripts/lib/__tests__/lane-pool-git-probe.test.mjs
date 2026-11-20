import { describe, it, expect, vi } from 'vitest';
import { retryGitProbe } from '../lane-pool-scan.mjs';

describe('retryGitProbe', () => {
  const args = ['status', '--porcelain'];

  it('does not retry a successful empty result', () => {
    const git = vi.fn(() => '');
    expect(retryGitProbe(args, 'lane', git)).toEqual({ output: '', error: null });
    expect(git).toHaveBeenCalledTimes(1);
  });

  it('retries once with the same read-only args and cwd', () => {
    const git = vi.fn().mockImplementationOnce(() => { throw new Error('transient'); }).mockReturnValue('0');
    expect(retryGitProbe(args, 'lane', git)).toEqual({ output: '0', error: null });
    expect(git.mock.calls).toEqual([[args, 'lane'], [args, 'lane']]);
  });

  it('persistent probe failure stays unknown with stderr after exactly two attempts', () => {
    const git = vi.fn(() => { throw Object.assign(new Error('command failed'), { stderr: Buffer.from('fatal: unreadable\n') }); });
    expect(retryGitProbe(args, 'lane', git)).toEqual({ output: null, error: 'fatal: unreadable' });
    expect(git).toHaveBeenCalledTimes(2);
  });

  it('retains the spawn error message when stderr is empty', () => {
    const git = vi.fn(() => { throw Object.assign(new Error('spawn git EMFILE'), { stderr: '' }); });
    expect(retryGitProbe(args, 'lane', git)).toEqual({ output: null, error: 'spawn git EMFILE' });
  });

  it('retains stderr wrapped by the bounded process reader', () => {
    const git = vi.fn(() => { throw new Error('git read failed (exit)', { cause: { stderr: 'fatal: wrapped failure\n' } }); });
    expect(retryGitProbe(args, 'lane', git)).toEqual({ output: null, error: 'fatal: wrapped failure' });
  });
});
