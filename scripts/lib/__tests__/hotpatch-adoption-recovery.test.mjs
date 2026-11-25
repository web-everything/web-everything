/** RS-HP-3: guardedRegister refuses hotpatch/* without admission; hotpatch/* never blocks a rollback. */
import { describe, it, expect, vi } from 'vitest';
import { guardedRegister } from '../daemon-load-overlay.mjs';

describe('guardedRegister hotpatch refusal (negative tests)', () => {
  const base = { root: '/nonexistent', pr: null, env: {}, gate: {} };
  it('refuses hotpatch/* when no admission is supplied, and never registers', async () => {
    const register = vi.fn();
    const r = await guardedRegister({ ...base, ref: 'hotpatch/x', register });
    expect(r).toMatchObject({ registered: false, reason: 'hotpatch-not-admitted' });
    expect(register).not.toHaveBeenCalled();
  });
  it.each(['fail', 'wait', 'unknown'])('refuses hotpatch/* when admission says %s', async (outcome) => {
    const register = vi.fn();
    const r = await guardedRegister({ ...base, ref: 'hotpatch/x', register, admitHotpatch: async () => ({ outcome }) });
    expect(r).toMatchObject({ registered: false, reason: 'hotpatch-not-admitted' });
    expect(register).not.toHaveBeenCalled();
  });
  it('refuses when admission throws', async () => {
    const register = vi.fn();
    const r = await guardedRegister({ ...base, ref: 'hotpatch/x', register, admitHotpatch: async () => { throw new Error('boom'); } });
    expect(r).toMatchObject({ registered: false, reason: 'hotpatch-not-admitted' });
  });
});
