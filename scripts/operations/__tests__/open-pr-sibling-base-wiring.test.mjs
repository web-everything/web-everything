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

  it('skips sibling history on --dry-run: a refusing or throwing checker is never consulted', () => {
    for (const siblingBase of [
      vi.fn(() => ({ ok: false, reason: 'sibling-base', detail: 'carried lane' })),
      vi.fn(() => { throw new Error('history unreadable'); }),
    ]) {
      const f = fixture({ siblingBase });
      const result = f.run({ argv: ['--ref=lane/own', '--dry-run'] });
      expect(result.outcome).not.toBe('refused');
      expect(siblingBase).not.toHaveBeenCalled();
      expect(f.spawn).toHaveBeenCalledOnce();
      expect(f.spawn.mock.calls[0][1]).toContain('--dry-run');
      expect(f.spawn.mock.calls[0][1]).not.toContain('--check');
    }
  });

  it('does not read Git for the default history checker on --dry-run', () => {
    const git = vi.fn(() => { throw new Error('dry-run must not read Git'); });
    const f = fixture({ git });
    expect(f.run({ argv: ['--ref=lane/own', '--dry-run'] }).outcome).not.toBe('refused');
    expect(git).not.toHaveBeenCalled();
  });

  it('a sibling-base refusal survives an audited pre-PR-review bypass: only --check reaches pr-land', () => {
    const siblingBase = vi.fn(() => ({ ok: false, reason: 'sibling-base', detail: 'Unmerged sibling lanes carried by this branch: lane/7357' }));
    const prePrReview = () => ({ action: 'pass', bypass: { actor: 'nic', reason: 'hotfix', operatorInstruction: 'ship it' } });
    const f = fixture({ siblingBase, prePrReview });
    const result = f.run({ argv: ['--ref=lane/own'], skipPrePrReview: 'hotfix', actor: 'nic', operatorInstruction: 'ship it' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(result.blockers).toContainEqual(expect.objectContaining({ gate: 'sibling-base', reason: 'sibling-base' }));
    expect(siblingBase).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0][1]).toContain('--check');
  });
});
