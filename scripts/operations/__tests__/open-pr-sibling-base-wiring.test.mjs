import { describe, expect, it, vi } from 'vitest';
import { createPrLandRunner } from '../open-pr-io.mjs';

const sha = 'a'.repeat(40);
const main = 'b'.repeat(40);

function fixture(overrides = {}) {
  const spawn = vi.fn((_cmd, argv) => ({ status: 0,
    stdout: JSON.stringify(argv.includes('--check') ? { reason: 'check-ok' } : { pr: 7379 }) }));
  const run = createPrLandRunner({
    env: {}, spawn, canonicalAudit: () => ({ ok: true, sha }),
    prePrReview: () => ({ action: 'pass' }), prepGate: () => ({ ok: true }),
    ...overrides,
  });
  return { run, spawn };
}

describe('sibling-base admission with injected publishing IO', () => {
  it('keeps the default history check active when spawn is injected', () => {
    const git = vi.fn(args => {
      if (args[0] === 'rev-parse') return args.at(-1).startsWith('refs/remotes/origin/main') ? main : sha;
      if (args[0] === 'rev-list') return `${sha}\n`;
      if (args[0] === 'for-each-ref') return '';
      throw new Error(`unexpected Git read: ${args.join(' ')}`);
    });
    const f = fixture({ git });
    expect(f.run({ argv: ['--ref=lane/own'] })).toMatchObject({ outcome: 'opened', pr: 7379 });
    expect(git).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], expect.any(Object));
    expect(git.mock.calls.some(([args]) => args[0] === 'for-each-ref')).toBe(true);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0][1]).not.toContain('--check');
  });

  it.each([false, true])('refuses unreadable history despite a successful child, check=%s', checking => {
    const git = vi.fn(() => { throw new Error('objects unavailable'); });
    const f = fixture({ git });
    const result = f.run({ argv: ['--ref=lane/own', ...(checking ? ['--check'] : [])] });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('objects unavailable');
    expect(result.detail).toContain('clean lane');
    expect(git).toHaveBeenCalled();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0][1]).toContain('--check');
  });

  it('allows other gate fixtures to inject history evidence explicitly, preserving the audited SHA and parent', () => {
    const git = vi.fn(() => { throw new Error('fixture must not read Git'); });
    const siblingBase = vi.fn(() => ({ ok: true }));
    const f = fixture({ git, siblingBase });
    expect(f.run({ argv: ['--ref=lane/own', '--sha=HEAD', '--base=lane/parent'] }).outcome).toBe('opened');
    expect(siblingBase).toHaveBeenCalledOnce();
    expect(siblingBase).toHaveBeenCalledWith({ git, ref: 'lane/own', sha, base: 'lane/parent' });
    expect(git).not.toHaveBeenCalled();
    expect(f.spawn.mock.calls[0][1]).toContain(`--sha=${sha}`);
  });
});
