import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addOverlay, recordOverlayReplacement, overlayFilePath } from '../daemon-overlays.mjs';
import { readSwapOverlays } from '../overlay-swap.mjs';
import { describe, it, expect, vi } from 'vitest';
import { swapAfterAdopt, swapTimeout, assertSwapRemovalAdopted } from '../overlay-swap.mjs';

const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);
function fixture() {
  let list = [{ ref: 'old', pr: 42, pinned: true, reason: 'keep', addedBy: 'original', addedAt: '2026-01-01' }];
  let time = 0, adopted = false;
  const events = [], order = [];
  const run = vi.fn(args => {
    if (args.includes('fetch')) return { status: 0 };
    if (args.includes('rev-parse')) return { status: 0, stdout: oldSha };
    if (args.at(-1) === 'HEAD') return { status: adopted ? 0 : 1 };
    return { status: 0 };
  });
  const options = {
    root: 'clone', newRef: 'new', newSha: sha, replaces: ['old'], env: {}, run,
    readOverlays: vi.fn(() => list.map(o => ({ ...o }))),
    addOverlay: vi.fn((root, entry) => { order.push('add'); list.push(entry); }),
    removeOverlay: vi.fn((root, ref) => { order.push('remove'); list = list.filter(o => o.ref !== ref); return { removed: true }; }),
    appendOverlayEvent: vi.fn((root, event) => events.push(event)),
    now: () => time, sleep: vi.fn(async ms => { time += ms; }), timeoutMs: 10, pollMs: 5,
  };
  return { options, events, order, list: () => list, setList: value => { list = value; }, adopt: () => { adopted = true; } };
}

describe('swapAfterAdopt', () => {
  it('never removes before adoption, then removes after adoption with an audit event', async () => {
    const f = fixture();
    f.options.sleep.mockImplementation(async () => {
      expect(f.options.removeOverlay).not.toHaveBeenCalled();
      f.adopt();
    });
    expect(await swapAfterAdopt(f.options)).toMatchObject({ ok: true, removed: ['old'], retained: [] });
    expect(f.events).toContainEqual({ kind: 'swap-removed', ref: 'old', replacedBy: 'new', newSha: sha });
    expect(f.options.run.mock.calls[0][0]).toEqual(['-C', 'clone', 'merge-base', '--is-ancestor', sha, 'HEAD']);
    expect(f.options.run).toHaveBeenCalledWith(['-C', 'clone', 'merge-base', '--is-ancestor', oldSha, sha], expect.any(Object));
    expect(f.options.run.mock.calls.some(([a]) => a.includes('+refs/heads/old:refs/remotes/origin/old'))).toBe(true);
  });
  it('retains an old ref whose CURRENT origin tip is not contained', async () => {
    const f = fixture(); f.adopt();
    const base = f.options.run.getMockImplementation();
    f.options.run.mockImplementation(a => a.at(-1) === sha ? { status: 1 } : base(a));
    expect(await swapAfterAdopt(f.options)).toMatchObject({ retained: ['old'], removed: [] });
    expect(f.options.removeOverlay).not.toHaveBeenCalled();
  });
  it('timeout restores missing originals with all original fields and preserves concurrent registrations', async () => {
    const f = fixture();
    const advance = f.options.sleep.getMockImplementation();
    f.options.sleep.mockImplementation(async ms => {
      await advance(ms);
      f.setList([{ ref: 'concurrent', pr: 999 }]);
    });
    expect(await swapAfterAdopt(f.options)).toMatchObject({ ok: false, reason: 'adoption-timeout', restored: ['old'] });
    expect(f.options.addOverlay).toHaveBeenCalledWith('clone', expect.objectContaining({ ref: 'old', pr: 42, pinned: true, addedBy: 'original', reason: 'keep', now: '2026-01-01' }), { env: {} });
    expect(f.list().map(o => o.ref)).toEqual(['concurrent', 'old']);
    expect(f.options.removeOverlay).not.toHaveBeenCalled();
    expect(f.events[0].kind).toBe('swap-timeout-restored');
  });
  it('restores an original captured before a rebuild removed its registration', async () => {
    const f = fixture();
    const originalEntries = f.list();
    f.setList([{ ref: 'concurrent', pr: 999 }]);
    expect(await swapAfterAdopt({ ...f.options, originalEntries, timeoutMs: 0 })).toEqual({
      ok: false, reason: 'adoption-timeout', restored: ['old'],
    });
    expect(f.options.addOverlay).toHaveBeenCalledWith('clone', expect.objectContaining({
      pr: 42, pinned: true, reason: 'keep', addedBy: 'original',
    }), { env: {} });
    expect(f.options.removeOverlay).not.toHaveBeenCalled();
  });
  it('timeout leaves present registrations unchanged and removes nothing', async () => {
    const f = fixture();
    expect(await swapAfterAdopt(f.options)).toMatchObject({ restored: [] });
    expect(f.options.addOverlay).not.toHaveBeenCalled();
    expect(f.options.removeOverlay).not.toHaveBeenCalled();
  });
  it('treats a null git exit status as an error rather than pending adoption', async () => {
    const f = fixture(); f.options.run.mockReturnValue({ status: null });
    await expect(swapAfterAdopt(f.options)).rejects.toThrow(/unavailable/);
    expect(f.options.sleep).not.toHaveBeenCalled();
    expect(f.options.removeOverlay).not.toHaveBeenCalled();
  });
  it.each(['adoption', 'fetch', 'containment'])('git error during %s fails closed', async stage => {
    const f = fixture(); if (stage !== 'adoption') f.adopt();
    const base = f.options.run.getMockImplementation();
    f.options.run.mockImplementation(a => ((stage === 'adoption' && a.at(-1) === 'HEAD')
      || (stage === 'fetch' && a.includes('fetch')) || (stage === 'containment' && a.at(-1) === sha)) ? { status: 128 } : base(a));
    await expect(swapAfterAdopt(f.options)).rejects.toThrow(/retain registrations/);
    expect(f.options.removeOverlay).not.toHaveBeenCalled();
  });
  it('fails closed when adoption disappears before removal', async () => {
    const f = fixture(); f.adopt();
    const base = f.options.run.getMockImplementation(); let probes = 0;
    f.options.run.mockImplementation(a => a.at(-1) === 'HEAD' && ++probes > 1 ? { status: 1 } : base(a));
    await expect(swapAfterAdopt(f.options)).rejects.toThrow(/no longer adopted/);
    expect(f.options.removeOverlay).not.toHaveBeenCalled();
  });
  it('rejects unsafe refs and invalid wait bounds without removing', async () => {
    const f = fixture();
    for (const override of [{ newSha: '-bad' }, { replaces: ['--bad'] }, { timeoutMs: Infinity }, { pollMs: 0 }]) {
      await expect(swapAfterAdopt({ ...f.options, ...override })).rejects.toThrow();
    }
    expect(f.options.removeOverlay).not.toHaveBeenCalled();
  });
});

describe('swap timeout provenance', () => {
  it('resolves settings, environment and standard fallback with logged sources', () => {
    const log = vi.fn();
    expect(swapTimeout({ env: {}, tool: {}, log })).toEqual({ timeoutMs: 600000, source: 'standard' });
    expect(swapTimeout({ env: {}, tool: { timeoutMs: 123 }, log })).toEqual({ timeoutMs: 123, source: 'tool' });
    expect(swapTimeout({ env: { WE_OVERLAY_SWAP_TIMEOUT_MS: '456' }, tool: { timeoutMs: 123 }, log })).toEqual({ timeoutMs: 456, source: 'env' });
    expect(log.mock.calls.flat().join('\n')).toContain('timeoutMs=456 (env)');
    expect(swapTimeout({ env: { WE_OVERLAY_SWAP_TIMEOUT_MS: '99999999999999999999' }, tool: { timeoutMs: 123 }, log })).toEqual({ timeoutMs: 123, source: 'tool' });
    expect(log.mock.calls.at(-1)[0]).toContain('ignored invalid');
  });
});

describe('manual predecessor removal guard', () => {
  it.each([null, false, {}, { ref: 'new' }, { sha }])('refuses malformed persisted replacement markers (%j)', replacedBy => {
    expect(() => assertSwapRemovalAdopted({ root: 'clone', ref: 'old',
      readOverlays: () => [{ ref: 'old', replacedBy }], run: vi.fn(),
    })).toThrow(/invalid|refusing/);
  });
  it.each([1, 128, null])('refuses pending or unknown adoption (git status %s)', status => {
    expect(() => assertSwapRemovalAdopted({ root: 'clone', ref: 'old', env: {},
      readOverlays: () => [{ ref: 'old', replacedBy: { ref: 'new', sha } }], run: () => ({ status }),
    })).toThrow(/refusing|unavailable/);
  });
  it('permits an adopted replacement and unrelated removals', () => {
    const run = vi.fn(() => ({ status: 0 }));
    const readOverlays = () => [{ ref: 'old', replacedBy: { ref: 'new', sha } }];
    assertSwapRemovalAdopted({ root: 'clone', ref: 'old', readOverlays, run });
    expect(run).toHaveBeenCalledOnce();
    assertSwapRemovalAdopted({ root: 'clone', ref: 'unrelated', readOverlays, run });
    expect(run).toHaveBeenCalledOnce();
  });
});


it('persists replacement markers without rewriting metadata and refuses a corrupt registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'we-overlay-swap-'));
  const env = { WE_DAEMON_OVERLAY_DIR: root };
  try {
    addOverlay(root, { ref: 'old', pr: 42, pinned: true, reason: 'current', addedBy: 'owner' }, { env });
    addOverlay(root, { ref: 'unrelated', pr: 99 }, { env });
    const before = readSwapOverlays(root, { env });
    recordOverlayReplacement(root, 'old', { ref: 'new', sha }, { env });
    expect(readSwapOverlays(root, { env })).toEqual([
      { ...before[0], replacedBy: { ref: 'new', sha } }, before[1],
    ]);
    expect(() => assertSwapRemovalAdopted({ root, ref: 'old', env, run: () => ({ status: 1 }) })).toThrow(/refusing/);
    writeFileSync(overlayFilePath(root, env), 'invalid json');
    expect(() => assertSwapRemovalAdopted({ root, ref: 'old', env })).toThrow(/unreadable registry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
