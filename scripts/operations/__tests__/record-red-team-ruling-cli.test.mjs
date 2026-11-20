/** The ruling CLI always prints its result or refusal, and refuses a judge run without the App gh shim on PATH. */
import { describe, expect, it } from 'vitest';
import { main, assertJudgeShimOnPath } from '../record-red-team-ruling-cli.mjs';

describe('record-red-team-ruling-cli prints every exit path', () => {
  it('prints usage on --help and returns 0', async () => {
    const out = [];
    const code = await main(['--help'], { write: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/usage|--pr/i);
  });
  it('prints the refusal text when the entry throws', async () => {
    const out = [];
    const code = await main(['--pr=1'], { entry: () => { throw new Error('boom refusal'); }, write: (s) => out.push(s) });
    expect(code).not.toBe(0);
    expect(out.join('')).toMatch(/boom refusal/);
  });
  it('prints the outcome lines and returns the outcome code', async () => {
    const out = [];
    const code = await main(['--pr=1'], { run: async () => ({ lines: ['ruled'], code: 0 }), write: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/ruled/);
  });
  it('refuses a judge run when the gh shim is not on PATH, with a clear message', () => {
    expect(() => assertJudgeShimOnPath({ PATH: '/usr/bin' }, 'judge:r10')).toThrow(/gh-shim/);
    expect(() => assertJudgeShimOnPath({ PATH: '/x/gh-shim.d/abc:/usr/bin' }, 'judge:r10')).not.toThrow();
    expect(() => assertJudgeShimOnPath({ PATH: '/usr/bin' }, 'operator')).not.toThrow();
  });
});
