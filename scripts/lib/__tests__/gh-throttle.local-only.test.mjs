/**
 * @file scripts/lib/__tests__/gh-throttle.local-only.test.mjs
 * @description Live 2026-10-07 17:09Z: a primary-budget block on the `default` identity made `gh auth token`
 *   (answered from the local login, no GitHub request) throw instantly, so missing-run recovery for PR #4244
 *   failed "during credential". A local-only call must never be gated by a budget block.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGhSync, isGhLocalOnly, writeBudgetBlock } from '../gh-throttle.mjs';

const NOW = Date.parse('2026-10-07T17:09:00Z');
const blockedRoot = () => {
  const lockRoot = mkdtempSync(join(tmpdir(), 'gh-local-'));
  for (const r of ['core', 'graphql']) writeBudgetBlock(lockRoot, 'default', r, { untilMs: NOW + 600_000, nowMs: NOW });
  return lockRoot;
};

describe('isGhLocalOnly', () => {
  it('is true only for calls answered without a GitHub request', () => {
    expect(isGhLocalOnly(['auth', 'token', '--hostname', 'github.com'])).toBe(true);
    expect(isGhLocalOnly(['--hostname', 'github.com', 'auth', 'token'])).toBe(true);
    expect(isGhLocalOnly(['--version'])).toBe(true);
    expect(isGhLocalOnly(['auth', 'status'])).toBe(false);
    expect(isGhLocalOnly(['pr', 'view', '1'])).toBe(false);
    expect(isGhLocalOnly(['api', 'repos/o/n'])).toBe(false);
  });
});

describe('runGhSync under an active budget block', () => {
  const opts = (lockRoot, exec) => ({ throttle: { lockRoot, cap: 4, now: () => NOW, sleep: () => {}, env: {}, exec }, encoding: 'utf8' });

  it('still runs `gh auth token` (no GitHub call, no budget)', () => {
    const exec = vi.fn(() => 'gho_x\n');
    expect(runGhSync(['auth', 'token', '--hostname', 'github.com'], opts(blockedRoot(), exec))).toBe('gho_x\n');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('still fails a real GitHub read fast without calling gh', () => {
    const exec = vi.fn(() => '{}');
    expect(() => runGhSync(['pr', 'view', '1'], opts(blockedRoot(), exec))).toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
});
