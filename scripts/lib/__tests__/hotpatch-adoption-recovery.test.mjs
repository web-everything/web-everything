/** RS-HP-3: one door for hotpatch/* registration (admitted sha == registered candidate sha). */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedRegister, admitHotpatchRef } from '../daemon-load-overlay.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('admitHotpatchRef (negative tests)', () => {
  it('does not apply to non-hotpatch refs', async () => {
    const admit = vi.fn();
    expect(await admitHotpatchRef({ ref: 'lane/x', candSha: SHA, admitHotpatch: admit })).toEqual({ ok: true });
    expect(admit).not.toHaveBeenCalled();
  });
  it('admits the candidate sha itself and nothing else', async () => {
    const admit = vi.fn(async () => ({ outcome: 'pass' }));
    expect(await admitHotpatchRef({ ref: 'hotpatch/x', candSha: SHA, admitHotpatch: admit, tipOf: () => SHA })).toEqual({ ok: true });
    expect(admit.mock.calls[0][0]).toBe(SHA);
  });
  it('refuses when the branch moved after admission', async () => {
    const r = await admitHotpatchRef({ ref: 'hotpatch/x', candSha: SHA, admitHotpatch: async () => ({ outcome: 'pass' }), tipOf: () => OTHER });
    expect(r).toMatchObject({ ok: false, reason: 'hotpatch-sha-moved' });
  });
  it('refuses when the tip is unreadable', async () => {
    const r = await admitHotpatchRef({ ref: 'hotpatch/x', candSha: SHA, admitHotpatch: async () => ({ outcome: 'pass' }), tipOf: () => null });
    expect(r).toMatchObject({ ok: false, reason: 'hotpatch-sha-moved' });
  });
  it.each(['fail', 'wait', 'unknown'])('refuses when admission says %s', async (outcome) => {
    const r = await admitHotpatchRef({ ref: 'hotpatch/x', candSha: SHA, admitHotpatch: async () => ({ outcome }), tipOf: () => SHA });
    expect(r).toMatchObject({ ok: false, reason: 'hotpatch-not-admitted' });
  });
  it('refuses when admission throws or the candidate sha is missing', async () => {
    expect(await admitHotpatchRef({ ref: 'hotpatch/x', candSha: SHA, admitHotpatch: async () => { throw new Error('x'); }, tipOf: () => SHA }))
      .toMatchObject({ ok: false, reason: 'hotpatch-not-admitted' });
    expect(await admitHotpatchRef({ ref: 'hotpatch/x', candSha: undefined, admitHotpatch: async () => ({ outcome: 'pass' }), tipOf: () => SHA }))
      .toMatchObject({ ok: false, reason: 'hotpatch-not-admitted' });
  });
});

describe('guardedRegister hotpatch door', () => {
  const env = () => ({ ...process.env, WE_DAEMON_OVERLAY_DIR: mkdtempSync(join(tmpdir(), 'we-hp3-')), WE_DAEMON_OVERLAY_STACK_BASES: '{}' });
  const run = (extra) => {
    const register = vi.fn();
    const root = mkdtempSync(join(tmpdir(), 'we-hp3-root-'));
    return guardedRegister({ root, ref: 'hotpatch/x', pr: null, env: env(), gate: {}, register,
      checkFn: async () => ({ ok: true, clean: true, candSha: SHA }), tipOf: () => SHA, ...extra }).then((r) => ({ r, register }));
  };
  it('never registers a hotpatch ref that fails admission', async () => {
    const { r, register } = await run({ admitHotpatch: async () => ({ outcome: 'fail' }) });
    expect(r).toMatchObject({ registered: false, reason: 'hotpatch-not-admitted' });
    expect(register).not.toHaveBeenCalled();
  });
  it('never registers when the branch moved after admission', async () => {
    const { r, register } = await run({ admitHotpatch: async () => ({ outcome: 'pass' }), tipOf: () => OTHER });
    expect(r).toMatchObject({ registered: false, reason: 'hotpatch-sha-moved' });
    expect(register).not.toHaveBeenCalled();
  });
  it('registers an admitted hotpatch ref at the admitted sha', async () => {
    const { r, register } = await run({ admitHotpatch: async () => ({ outcome: 'pass' }) });
    expect(r).toMatchObject({ registered: true });
    expect(register).toHaveBeenCalledOnce();
  });
});
