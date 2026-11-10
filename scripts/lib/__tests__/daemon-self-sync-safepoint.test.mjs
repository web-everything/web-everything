import { it, expect, vi, afterEach } from 'vitest';
import { withSelfSync, safePoint } from '../daemon-self-sync.mjs';
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { readReadyCandidate } from '../daemon-rebuild/state.mjs';
import { removeOverlay } from '../daemon-overlays.mjs';
import { fixture } from './helpers/safe-point-fixture.mjs';
const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function setup(tick, overrides = {}) {
  const f = fixture(); fixtures.push(f);
  let ready = null;
  const release = vi.fn();
  const acquire = vi.fn(() => ({ ok: true }));
  const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
  const restart = vi.fn(() => 'restarted');
  const opts = { root: f.root, env: f.env, versions: null, background: {}, entries: ['test-daemon.mjs'],
    readHead: () => f.head, readReady: () => ready, readState: () => ({}), rebuild,
    acquireRead: acquire, releaseRead: release, log: { error: vi.fn() }, onRestart: restart,
    importClosure: () => null, diffFiles: () => null, minRestartIntervalMs: 0, ...overrides };
  const w = withSelfSync({ tickOnce: () => tick({ f, acquire, release, rebuild, restart, setReady: (r = f.ready) => { ready = r; } }) }, opts);
  return { w, f, acquire, release, rebuild, restart };
}
it('outside a running default tick is a no-op', async () => expect(await safePoint('idle')).toEqual({ adopted: false }));
it('matching candidate is adopted at the phase boundary and the tick stops', async () => {
  const tail = vi.fn();
  const { w, rebuild, release, restart } = setup(async (h) => {
    h.setReady();
    h.rebuild.mockResolvedValue({ moved: true, adopted: true, head: h.f.target });
    await safePoint('facts'); tail();
  });
  expect(await w.tickOnce()).toBe('restarted');
  expect(rebuild).toHaveBeenLastCalledWith({ adoptReadyOnly: true });
  expect(release).toHaveBeenCalledTimes(1); expect(restart).toHaveBeenCalledTimes(1); expect(tail).not.toHaveBeenCalled();
  expect(await safePoint('after')).toEqual({ adopted: false });
});
it.each([
  { reason: 'min-interval', changedFiles: ['scripts/lib/daemon-self-sync.mjs'] },
  { reason: 'no-imported-change', changedFiles: [] },
])('successful safe-point adoption with restart denied ($reason) never executes the tick tail', async ({ reason, changedFiles }) => {
  const tail = vi.fn();
  const log = { error: vi.fn() };
  const { w, rebuild, acquire, release, restart } = setup(async (h) => {
    h.setReady();
    h.rebuild.mockResolvedValue({ moved: true, adopted: true, head: h.f.target });
    await safePoint('facts');
    tail();
  }, { now: () => 0, minRestartIntervalMs: 60_000, diffFiles: () => changedFiles, log });
  expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: `safe-point-abort: restart-${reason}` });
  expect(rebuild).toHaveBeenLastCalledWith({ adoptReadyOnly: true });
  expect(tail).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(log.error).toHaveBeenCalledWith(expect.stringContaining(`safe-point facts skipped (restart-${reason}; tick-ended)`));
  expect(await safePoint('after-abort')).toEqual({ adopted: false });
});
it('no candidate keeps the read lock held and continues the tick', async () => {
  const { w, release, acquire, rebuild } = setup(async (h) => {
    expect(await safePoint('facts')).toEqual({ adopted: false });
    expect(h.release).not.toHaveBeenCalled(); return 'continued';
  });
  expect(await w.tickOnce()).toBe('continued'); expect(acquire).toHaveBeenCalledTimes(1);
  expect(rebuild).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
});
it('other-base candidate is ignored without releasing the read lock', async () => {
  const { w, rebuild } = setup(async (h) => {
    h.setReady({ ...h.f.ready, prevHead: 'other' }); await safePoint('review');
    expect(h.release).not.toHaveBeenCalled(); return 'continued';
  });
  expect(await w.tickOnce()).toBe('continued'); expect(rebuild).toHaveBeenCalledTimes(1);
});
it('write-lock refusal reacquires the read lock and continues', async () => {
  const { w, acquire, release } = setup(async (h) => {
    h.setReady(); h.rebuild.mockResolvedValue({ moved: false, reason: 'tick-in-progress' });
    expect(await safePoint('fix')).toEqual({ adopted: false }); return 'continued';
  });
  expect(await w.tickOnce()).toBe('continued'); expect(acquire).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(2);
});
it('refused read reacquisition aborts cleanly and never continues unlocked', async () => {
  const tail = vi.fn();
  const { w, release } = setup(async (h) => {
    h.setReady(); h.acquire.mockReturnValue({ ok: false, reason: 'writer-active' });
    await safePoint('fix'); tail();
  });
  expect(await w.tickOnce()).toMatchObject({ skipped: true, reason: 'safe-point-abort: writer-active' });
  expect(tail).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
});
it('R854: applied A,B with B removed before safe point drops readiness under the write lock', async () => {
  const { w, f, rebuild } = setup(async (h) => {
    h.f.record(); h.setReady(); removeOverlay(h.f.root, 'B', { env: h.f.env });
    h.rebuild.mockImplementation((options) => rebuildClone({ root: h.f.root, env: h.f.env, run: h.f.run,
      ...options, log: { error: vi.fn() }, emitEvent: vi.fn(), lockOpts: { waitMs: 20 } }));
    expect(await safePoint('review')).toEqual({ adopted: false }); return 'continued';
  });
  expect(await w.tickOnce()).toBe('continued'); expect(f.git('rev-parse', 'HEAD')).toBe(f.head);
  expect(readReadyCandidate(f.root, f.env)).toBeNull();
  // The returned reason proves the live locked matcher, not just the pre-check, refused B.
  expect(await rebuild.mock.results.at(-1).value).toMatchObject({ reason: 'overlay-no-longer-wanted' });
});
it('adoptReadyOnly adopts a matching real candidate without fetching, planning or smoking', async () => {
  const f = fixture(); fixtures.push(f); f.record();
  const runSmoke = vi.fn();
  const result = await rebuildClone({ root: f.root, env: f.env, adoptReadyOnly: true, asJob: true, runSmoke,
    run: (args, opts) => { expect(['fetch', 'commit-tree', 'worktree']).not.toContain(args[0]); return f.run(args, opts); },
    emitEvent: vi.fn(), log: { error: vi.fn() } });
  expect(result).toMatchObject({ moved: true, adopted: true, head: f.target }); expect(runSmoke).not.toHaveBeenCalled();
});
it('async contexts keep overlapping withSelfSync instances independent', async () => {
  let unblock; const waiting = new Promise((r) => { unblock = r; });
  let started; const entered = new Promise((r) => { started = r; });
  const a = setup(async (h) => { h.setReady(); started(); await waiting; await safePoint('a'); return 'a'; });
  const b = setup(async () => { await safePoint('b'); unblock(); return 'b'; });
  const first = a.w.tickOnce(); await entered; expect(await b.w.tickOnce()).toBe('b'); expect(await first).toBe('a');
  expect(a.rebuild).toHaveBeenCalledTimes(2); expect(b.rebuild).toHaveBeenCalledTimes(1);
});

it('adoptReadyOnly refuses an unverified exact record and drops it', async () => {
  const f = fixture(); fixtures.push(f);
  f.ready.adopt = { ...f.plan, finalSha: f.plan.applied[0].sha }; f.record();
  const result = await rebuildClone({ root: f.root, env: f.env, run: f.run, adoptReadyOnly: true,
    emitEvent: vi.fn(), log: { error: vi.fn() } });
  expect(result).toMatchObject({ moved: false, reason: 'unverified-build' });
  expect(readReadyCandidate(f.root, f.env)).toBeNull();
});
it('adoptReadyOnly without readiness never plans or starts a job', async () => {
  const f = fixture(); fixtures.push(f); const runSmoke = vi.fn();
  expect(await rebuildClone({ root: f.root, env: f.env, adoptReadyOnly: true, asJob: true, runSmoke,
    run: (args, opts) => { expect(['fetch', 'commit-tree', 'worktree']).not.toContain(args[0]); return f.run(args, opts); },
    emitEvent: vi.fn(), log: { error: vi.fn() } })).toMatchObject({ moved: false, reason: 'none' });
  expect(runSmoke).not.toHaveBeenCalled();
});
