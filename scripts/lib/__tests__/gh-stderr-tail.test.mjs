import { describe, it, expect } from 'vitest';
import { ghStderrTail } from '../gh-stderr-tail.mjs';

describe('ghStderrTail', () => {
  it('returns the stderr tail of a failed gh call', () => {
    expect(ghStderrTail({ stderr: 'pull request create failed: GraphQL: boom' })).toBe('pull request create failed: GraphQL: boom');
  });
  it('accepts a Buffer stderr', () => {
    expect(ghStderrTail({ stderr: Buffer.from('HTTP 403: nope') })).toBe('HTTP 403: nope');
  });
  it('trims to the last 800 characters', () => {
    const out = ghStderrTail({ stderr: 'x'.repeat(5000) + 'END' });
    expect(out.length).toBeLessThanOrEqual(800);
    expect(out.endsWith('END')).toBe(true);
  });
  it('redacts tokens', () => {
    const out = ghStderrTail({ stderr: 'auth failed Bearer abcdefghijklmnop and ghs_' + 'A'.repeat(30) });
    expect(out).not.toMatch(/abcdefghijklmnop|ghs_A{30}/);
  });
  it('is empty when there is no stderr', () => {
    expect(ghStderrTail({})).toBe('');
    expect(ghStderrTail(null)).toBe('');
  });
});
