import { describe, it, expect, vi } from 'vitest';
import { rebuildAdoptOverrideOperation, validateRebuildAdoptOverride, REBUILD_ADOPT_OVERRIDE_EFFECT } from '../rebuild-adopt-override.mjs';
import { createRebuildAdoptOverrideSinks, resolveRebuildDaemonRoot } from '../rebuild-adopt-override-io.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';

const sha = 'a'.repeat(40), prevHead = 'b'.repeat(40), mainTip = 'c'.repeat(40);
const root = '/fixture/daemon';
function fixture(overrides = {}) {
  let locked = false;
  let ready = { token: 'lease', adopt: { finalSha: sha, mainSha: mainTip, applied: [] } };
  const underLock = fn => vi.fn((...args) => { expect(locked).toBe(true); return fn(...args); });
  const deps = {
    env: { BASE: 'env' }, stateOpts: { env: { STATE: 'env' } }, log: {}, now: () => 123,
    resolveRoot: vi.fn(() => root),
    withWriteLock: vi.fn(async (path, fn) => {
      expect(path).toBe(root); locked = true;
      try { return { ok: true, value: await fn() }; } finally { locked = false; }
    }),
    readReadyCandidate: underLock(() => ready),
    run: underLock(args => ({ status: 0, stdout: args.at(-1) === 'HEAD' ? prevHead : mainTip })),
    readOverlayState: underLock(() => ({ overlays: [{ ref: 'edge', edgeResolution: { sha } }], corrupt: false })),
    verifyBuilt: underLock(() => true),
    appendOverlayEvent: underLock(() => {}),
    finalizeRebuild: underLock(() => { ready = null; return { adopted: true }; }),
    ...overrides,
  };
  const invoke = createRebuildAdoptOverrideSinks(deps)[REBUILD_ADOPT_OVERRIDE_EFFECT];
  return { deps, setReady: value => { ready = value; }, run: (input = { sha }) => invoke(input) };
}
function noWrites(f) {
  expect(f.deps.appendOverlayEvent).not.toHaveBeenCalled();
  expect(f.deps.finalizeRebuild).not.toHaveBeenCalled();
}

describe('rebuild-adopt-override declaration', () => {
  it('declares a default review daemon and accepts all five daemon names', () => {
    expect(parseOperationArgv(rebuildAdoptOverrideOperation(), [`--sha=${sha}`]).input).toEqual({ sha, daemon: 'review' });
    for (const daemon of ['review', 'fix', 'verify', 'build', 'drain']) {
      expect(parseOperationArgv(rebuildAdoptOverrideOperation(), [`--sha=${sha}`, `--daemon=${daemon}`]).errors).toEqual([]);
    }
  });
  it.each(['', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), `$(bad)${sha}`])('refuses invalid full sha %s', value => {
    expect(() => validateRebuildAdoptOverride({ sha: value })).toThrow(/40-hex/);
  });
  it('refuses an unknown daemon', () => {
    expect(() => validateRebuildAdoptOverride({ sha, daemon: 'unknown' })).toThrow(/daemon/);
  });
});

describe('rebuild-adopt-override locked adoption', () => {
  it('refuses with no ready record and writes nothing', async () => {
    const f = fixture(); f.setReady(null);
    await expect(f.run()).rejects.toThrow(/no ready record/); noWrites(f);
  });
  it('refuses a sha mismatch, including a matching abbreviated prefix', async () => {
    const f = fixture();
    await expect(f.run({ sha: 'd'.repeat(40) })).rejects.toThrow(/sha mismatch/); noWrites(f);
    await expect(f.run({ sha: sha.slice(0, 12) })).rejects.toThrow(/40-hex/); noWrites(f);
  });
  it.each([undefined, null, () => false, () => undefined])('refuses absent or false verifyBuilt evidence', async verifyBuilt => {
    const f = fixture({ verifyBuilt });
    await expect(f.run()).rejects.toThrow(/verified/); noWrites(f);
  });
  it.each(['dropRefs', 'suspects'])('refuses nonempty %s', async field => {
    const f = fixture(); f.setReady({ adopt: { finalSha: sha, [field]: [{ ref: 'unsafe' }] } });
    await expect(f.run()).rejects.toThrow(/plain verified adopt/); noWrites(f);
  });
  it('logs needs-you after verification and before finalization, with exact finalizer inputs', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({ adopted: true });
    expect(f.deps.verifyBuilt).toHaveBeenCalledWith(expect.objectContaining({ mainTip, prevHead, adopt: expect.objectContaining({ finalSha: sha }) }));
    expect(f.deps.verifyBuilt.mock.calls[0][0].approvedEdgeShaFor('edge')).toBe(sha);
    expect(f.deps.appendOverlayEvent).toHaveBeenCalledWith(root,
      expect.objectContaining({ kind: 'needs-you', need: 'rebuild-adopt-override', target: sha, daemon: 'review' }), { env: f.deps.env });
    expect(f.deps.verifyBuilt.mock.invocationCallOrder[0]).toBeLessThan(f.deps.appendOverlayEvent.mock.invocationCallOrder[0]);
    expect(f.deps.appendOverlayEvent.mock.invocationCallOrder[0]).toBeLessThan(f.deps.finalizeRebuild.mock.invocationCallOrder[0]);
    expect(f.deps.finalizeRebuild).toHaveBeenCalledWith({ root, env: f.deps.env, log: f.deps.log, run: f.deps.run,
      stateOpts: f.deps.stateOpts, now: f.deps.now, plan: { finalSha: sha, mainSha: mainTip, applied: [] }, prevHead, lease: { token: 'lease' } });
    expect(f.deps.readReadyCandidate).toHaveBeenCalledWith(root, { BASE: 'env', STATE: 'env' });
  });
  it('runs once: finalization consumes the record and a second call refuses', async () => {
    const f = fixture(); await f.run();
    await expect(f.run()).rejects.toThrow(/no ready record/);
    expect(f.deps.finalizeRebuild).toHaveBeenCalledTimes(1);
    expect(f.deps.appendOverlayEvent).toHaveBeenCalledTimes(1);
  });
  it('runs all IO inside the injected write lock and supplies a null lease token when absent', async () => {
    const f = fixture(); f.setReady({ adopt: { finalSha: sha } }); await f.run();
    expect(f.deps.withWriteLock).toHaveBeenCalledTimes(1);
    expect(f.deps.finalizeRebuild.mock.calls[0][0].lease).toEqual({ token: null });
  });
  it('refuses a busy write lock without reading or writing state', async () => {
    const f = fixture({ withWriteLock: vi.fn(async () => ({ ok: false, reason: 'busy' })) });
    await expect(f.run()).rejects.toThrow(/write lock/);
    expect(f.deps.readReadyCandidate).not.toHaveBeenCalled(); noWrites(f);
  });
  it('throws when finalization does not adopt, retaining the attempted override event', async () => {
    const f = fixture({ finalizeRebuild: vi.fn(() => ({ adopted: false })) });
    await expect(f.run()).rejects.toThrow(/did not adopt/);
    expect(f.deps.appendOverlayEvent).toHaveBeenCalledTimes(1);
  });
  it('refuses unreadable git tips even if the injected verifier returns true', async () => {
    const f = fixture({ run: vi.fn(() => ({ status: 1, stdout: '' })) });
    await expect(f.run()).rejects.toThrow(/HEAD|origin\/main/); noWrites(f);
  });
  it('refuses corrupt overlay approval state', async () => {
    const f = fixture({ readOverlayState: vi.fn(() => ({ corrupt: true, overlays: [] })) });
    await expect(f.run()).rejects.toThrow(/overlay/); noWrites(f);
  });
});

describe('daemon root resolution', () => {
  it('selects the daemon label from shared discovery, including drain code clone', () => {
    const discover = vi.fn(() => [{ path: root, labels: ['com.plateau.drain-daemon'] }]);
    expect(resolveRebuildDaemonRoot('drain', { discover, env: {} })).toBe(root);
  });
  it('refuses missing, ambiguous or incomplete discovery', () => {
    for (const discover of [() => [], () => [{ path: root, labels: ['com.we.review-daemon'] }, { path: '/other', labels: ['com.we.review-daemon'] }],
      ({ onIncomplete }) => { onIncomplete('unreadable'); return []; }]) {
      expect(() => resolveRebuildDaemonRoot('review', { discover })).toThrow(/resolve.*daemon/);
    }
  });
});
