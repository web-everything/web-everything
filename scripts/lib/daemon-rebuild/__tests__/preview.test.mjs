/** Dry-run admission and phase timing; git/network and plan computation are injected. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryRunRebuild } from '../preview.mjs';
import { planRebuild } from '../plan.mjs';
import { fetchMainAndOverlays } from '../edge-fetch.mjs';
import { acquireSmokeSlot } from '../../daemon-smoke-slots.mjs';

vi.mock('../plan.mjs', () => ({ planRebuild: vi.fn() }));
vi.mock('../edge-fetch.mjs', () => ({ fetchMainAndOverlays: vi.fn(), defaultPrState: vi.fn() }));
vi.mock('../local-state.mjs', () => ({
  findUnsafeLocalState: () => ({ safe: true, untracked: [] }), knownInputsOf: () => ({}),
}));
vi.mock('../state.mjs', () => ({ readRebuildState: () => ({}) }));
vi.mock('../../daemon-overlays.mjs', () => ({
  resolveOverlayFollowTip: () => 'follow',
  overlayFilePath: root => join(root, 'overlays.json'),
  readOverlayState: () => ({ overlays: [], corrupt: false }),
}));

let root, log, options;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'we-preview-'));
  log = { info: vi.fn(), error: vi.fn() };
  options = {
    root, env: {}, log, originUrl: 'unused-origin',
    run: args => ({ status: 0, stdout: args[0] === 'symbolic-ref' ? 'main' : root }),
  };
  fetchMainAndOverlays.mockReset();
  planRebuild.mockReset().mockResolvedValue({ ok: true, finalSha: root });
});
afterEach(() => { vi.clearAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each([false, true])('holds the slot across root inspection, object DB, and overlay merge; releases on throw=%s', async throws => {
  let held = false;
  const release = vi.fn(async () => { held = false; });
  const acquireSlot = vi.fn(async () => { held = true; return { acquired: true, release }; });
  const originalRun = options.run;
  options.run = (...args) => { expect(held).toBe(true); return originalRun(...args); };
  fetchMainAndOverlays.mockImplementation(() => { expect(held).toBe(true); });
  planRebuild.mockImplementation(async () => {
    expect(held).toBe(true);
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    if (throws) throw new Error('merge failed');
    return { ok: true, finalSha: root };
  });
  const result = dryRunRebuild({ ...options, acquireSlot });
  if (throws) await expect(result).rejects.toThrow('merge failed');
  else expect((await result).plan.ok).toBe(true);
  expect(acquireSlot).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(held).toBe(false);
});

it('fails closed on queue timeout without initializing/fetching or merging; next attempt may retry', async () => {
  const env = { WE_DAEMON_SMOKE_STATE_DIR: root, WE_DAEMON_SMOKE_MAX_CONCURRENT: '1',
    WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: '1' };
  const state = () => JSON.parse(readFileSync(join(root, 'smoke-slots.json'), 'utf8'));
  const holder = await acquireSmokeSlot({ env, log });
  const originalHolders = state().holders;
  let time = 0;
  const run = vi.fn(options.run);
  const retryOptions = { ...options, env, run, now: () => time, sleep: async ms => { time += ms; } };
  try {
    const result = await dryRunRebuild(retryOptions);
    expect(result.plan).toEqual({ ok: false, reason: 'smoke-queue-timeout' });
    expect(result.wouldDo).toBe('refuse');
    expect(fetchMainAndOverlays).not.toHaveBeenCalled();
    expect(planRebuild).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([args]) => args[0] === 'remote' && args[1] === 'add')).toBe(false);
    expect(state().holders).toEqual(originalHolders);
    expect(state().waiters).toEqual([]);

    await holder.release();
    const retry = await dryRunRebuild(retryOptions);
    expect(retry.plan.ok).toBe(true);
    expect(retry.wouldDo).toBe('nothing');
    expect(fetchMainAndOverlays).toHaveBeenCalledTimes(1);
    expect(planRebuild).toHaveBeenCalledTimes(1);
    expect(state().holders).toEqual([]);
    expect(state().waiters).toEqual([]);
  } finally { await holder.release(); }
});

it.each(['none', 'object-db', 'overlay-merge'])(
  'default admission holds its own real shared smoke ticket through setup and planning, then releases it (failure=%s)',
  async failure => {
    const env = { WE_DAEMON_SMOKE_STATE_DIR: root, WE_DAEMON_SMOKE_MAX_CONCURRENT: '2' };
    const state = () => JSON.parse(readFileSync(join(root, 'smoke-slots.json'), 'utf8'));
    const outer = await acquireSmokeSlot({ env, log });
    const originalHolders = state().holders;
    expect(originalHolders).toHaveLength(1);
    const assertHeld = () => {
      const holders = state().holders;
      expect(holders).toHaveLength(2);
      expect(holders).toContainEqual(originalHolders[0]);
      const own = holders.find(holder => holder.id !== originalHolders[0].id);
      expect(own).toEqual(expect.objectContaining({ pid: process.pid, id: expect.any(String) }));
      expect(own.ticket).not.toBe(originalHolders[0].ticket);
      expect(state().waiters).toEqual([]);
    };
    const originalRun = options.run;
    const run = (args, ...rest) => { assertHeld(); return originalRun(args, ...rest); };
    fetchMainAndOverlays.mockImplementation(() => {
      assertHeld();
      if (failure === 'object-db') throw new Error('object-db failed');
    });
    planRebuild.mockImplementation(async () => {
      assertHeld();
      await Promise.resolve();
      assertHeld();
      if (failure === 'overlay-merge') throw new Error('overlay-merge failed');
      return { ok: true, finalSha: root };
    });
    try {
      const result = dryRunRebuild({ ...options, env, run });
      if (failure === 'none') expect((await result).plan.ok).toBe(true);
      else await expect(result).rejects.toThrow(`${failure} failed`);
      expect(fetchMainAndOverlays).toHaveBeenCalledTimes(1);
      expect(planRebuild).toHaveBeenCalledTimes(failure === 'object-db' ? 0 : 1);
      expect(state().holders).toEqual(originalHolders);
      expect(state().waiters).toEqual([]);
    } finally { await outer.release(); }
    expect(state().holders).toEqual([]);
  },
);

it('default admission rejects corrupt shared state before root inspection or planning', async () => {
  const path = join(root, 'smoke-slots.json');
  writeFileSync(path, '{broken');
  const run = vi.fn(options.run);
  await expect(dryRunRebuild({ ...options, run, env: { WE_DAEMON_SMOKE_STATE_DIR: root } })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect(fetchMainAndOverlays).not.toHaveBeenCalled();
  expect(planRebuild).not.toHaveBeenCalled();
  expect(readFileSync(path, 'utf8')).toBe('{broken');
});

it('releases the slot when initial root inspection throws', async () => {
  const release = vi.fn();
  await expect(dryRunRebuild({ ...options, run: () => { throw new Error('read failed'); },
    acquireSlot: async () => ({ acquired: true, release }),
  })).rejects.toThrow('read failed');
  expect(release).toHaveBeenCalledTimes(1);
});

it('logs object-db elapsed time and releases capacity when object setup throws', async () => {
  const release = vi.fn();
  const originalRun = options.run;
  options.run = (args, ...rest) => {
    if (args[0] === 'remote' && args[1] === 'add') throw new Error('object DB failed');
    return originalRun(args, ...rest);
  };
  await expect(dryRunRebuild({ ...options, now: () => 10,
    acquireSlot: async () => ({ acquired: true, release }),
  })).rejects.toThrow('object DB failed');
  expect(log.info).toHaveBeenCalledWith('daemon-rebuild: dry-run step=object-db ms=0');
  expect(planRebuild).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it('emits separate object-db and overlay-merge elapsed milliseconds with the injected clock', async () => {
  let time = 100;
  fetchMainAndOverlays.mockImplementation(() => { time += 37; });
  planRebuild.mockImplementation(async () => { time += 59; return { ok: true, finalSha: root }; });
  await dryRunRebuild({ ...options, now: () => time,
    acquireSlot: async () => ({ acquired: true, release() {} }),
  });
  expect(log.info).toHaveBeenCalledWith('daemon-rebuild: dry-run step=object-db ms=37');
  expect(log.info).toHaveBeenCalledWith('daemon-rebuild: dry-run step=overlay-merge ms=59');
});

it('logs overlay timing even when the merge throws', async () => {
  planRebuild.mockRejectedValue(new Error('merge failed'));
  await expect(dryRunRebuild({ ...options, now: () => 10,
    acquireSlot: async () => ({ acquired: true, release() {} }),
  })).rejects.toThrow('merge failed');
  expect(log.info).toHaveBeenCalledWith('daemon-rebuild: dry-run step=overlay-merge ms=0');
});

it('fails closed without planning when the slot is not acquired', async () => {
  const acquireSlot = vi.fn(async () => ({ acquired: false, release: vi.fn() }));
  const result = await dryRunRebuild({ ...options, acquireSlot });
  expect(result.plan).toEqual({ ok: false, reason: 'smoke-queue-timeout' });
  expect(planRebuild).not.toHaveBeenCalled();
});
