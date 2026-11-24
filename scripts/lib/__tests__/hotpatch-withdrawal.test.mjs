import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { withdrawRegistration, main } from '../../daemon-overlay.mjs';
import { overlayFilePath, readOverlays } from '../daemon-overlays.mjs';
const sha = 'a'.repeat(40), ref = `hotpatch/${sha}`;
it.each(['cached-dependent', 'uncached-dependent', 'unreadable', 'moved', 'post-drop-moved'])(
  'shared hotpatch withdrawal retains registration on %s', async kind => {
    const root = fs.mkdtempSync(join(process.env.TMPDIR, 'hp-withdraw-'));
    const env = { WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    const file = overlayFilePath(root, env);
    fs.mkdirSync(join(root, 'overlays'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ overlays: [{ ref }, ...(/dependent/.test(kind)
      ? [{ ref: 'lane/top', ...(kind === 'cached-dependent' ? { stackBases: [ref] } : {}) }] : [])] }));
    const git = (...args) => ({ code: kind === 'unreadable' ? 128 : 0,
      stdout: args[0] === 'ls-remote' && kind === 'moved' ? 'b'.repeat(40) : sha });
    try {
      const attempt = withdrawRegistration({ root, ref, expectedTip: sha, env,
        deps: { git, tip: () => kind === 'post-drop-moved' ? 'b'.repeat(40) : sha } });
      if (kind === 'unreadable') await expect(attempt).rejects.toThrow(/git/);
      else expect(await attempt).toMatchObject({ removed: false });
      expect(readOverlays(root, { env }).some(r => r.ref === ref)).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
it('remove CLI forwards expected-sha to shared withdrawal and reports refusal', async () => {
  const withdraw = vi.fn(async () => ({ removed: false, refused: 'tip-moved', list: [{ ref }] }));
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true), oldCode = process.exitCode;
  try {
    await main(['remove', '--clone=.', `--ref=${ref}`, `--expected-sha=${sha}`, '--json'],
      { pruneStaleOverlayRecords() {}, withdrawRegistration: withdraw });
    expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ ref, expectedTip: sha }));
    expect(process.exitCode).toBe(3);
  } finally { output.mockRestore(); process.exitCode = oldCode; }
});

it.each(['independent', 'stacked', 'moved'])('remove CLI expected-sha checks the real shared withdrawal: %s', async kind => {
  const root = fs.mkdtempSync(join(process.env.TMPDIR, 'hp-remove-'));
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  fs.mkdirSync(env.WE_DAEMON_OVERLAY_DIR, { recursive: true });
  fs.writeFileSync(overlayFilePath(root, env), JSON.stringify({ overlays: [{ ref },
    ...(kind === 'stacked' ? [{ ref: 'lane/top', stackBases: [ref] }] : [])] }));
  const tip = kind === 'moved' ? 'b'.repeat(40) : sha;
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true), oldCode = process.exitCode;
  try {
    await main(['remove', `--clone=${root}`, `--ref=${ref}`, `--expected-sha=${sha}`, '--json'], {
      pruneStaleOverlayRecords() {},
      withdrawRegistration: args => withdrawRegistration({ ...args, env, deps: { tip: () => tip,
        git: () => ({ code: 0, stdout: tip }) } }),
    });
    expect(readOverlays(root, { env }).some(r => r.ref === ref)).toBe(kind !== 'independent');
    if (kind !== 'independent') expect(process.exitCode).toBe(3);
  } finally { output.mockRestore(); process.exitCode = oldCode; fs.rmSync(root, { recursive: true, force: true }); }
});
