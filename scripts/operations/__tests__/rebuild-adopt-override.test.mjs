import { describe, it, expect, vi } from 'vitest';
import { rebuildAdoptOverrideOperation, validateRebuildAdoptOverride, REBUILD_ADOPT_OVERRIDE_EFFECT } from '../rebuild-adopt-override.mjs';
import { createRebuildAdoptOverrideSinks, resolveRebuildDaemonRoot } from '../rebuild-adopt-override-io.mjs';
import { DEFAULT_READY_MAX_AGE_MS } from '../../lib/daemon-rebuild/lease.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';

const sha = 'a'.repeat(40), prevHead = 'b'.repeat(40), mainTip = 'c'.repeat(40);
const root = '/fixture/daemon';
const nowMs = Date.parse('2026-11-09T12:00:00Z');
const freshReady = () => ({ passedAt: new Date(nowMs).toISOString(), prevHead,
  adopt: { finalSha: sha, mainSha: mainTip, inputsKey: 'fixture', applied: [] } });
function fixture(overrides = {}) {
  let locked = false;
  let ready = { token: 'lease', ...freshReady() };
  const underLock = fn => vi.fn((...args) => { expect(locked).toBe(true); return fn(...args); });
  const deps = {
    env: { BASE: 'env' }, stateOpts: { env: { STATE: 'env' } }, log: {}, now: () => nowMs,
    resolveRoot: vi.fn(() => root),
    withWriteLock: vi.fn(async (path, fn) => {
      expect(path).toBe(root); locked = true;
      try { return { ok: true, value: await fn() }; } finally { locked = false; }
    }),
    readReadyCandidate: underLock(() => ready),
    readRebuildState: underLock(() => ({ rejected: null })),
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
  it.each(['dropRefs', 'suspects'])('refuses nonempty adopt-level %s', async field => {
    const f = fixture(); f.setReady({ adopt: { finalSha: sha, [field]: [{ ref: 'unsafe' }] } });
    await expect(f.run()).rejects.toThrow(/plain verified adopt/); noWrites(f);
  });
  it.each(['dropRefs', 'suspects', 'fallback'])('refuses nonempty READY-level %s without writing', async field => {
    const f = fixture(); f.setReady({ ...freshReady(), [field]: [{ ref: 'unsafe' }] });
    await expect(f.run()).rejects.toThrow(/plain verified adopt/); noWrites(f);
  });
  it.each(['dropRefs', 'suspects', 'fallback'])('refuses truthy READY-level %s without writing', async field => {
    const f = fixture(); f.setReady({ ...freshReady(), [field]: true });
    await expect(f.run()).rejects.toThrow(/plain verified adopt/); noWrites(f);
  });
  it('refuses a fallback-kind record even without drop metadata and writes nothing', async () => {
    const f = fixture(); f.setReady({ ...freshReady(), kind: 'fallback' });
    await expect(f.run()).rejects.toThrow(/plain verified adopt/); noWrites(f);
  });
  it.each([undefined, null, {}, [null], [{}]])('refuses incomplete applied-overlay evidence %j without writing', async applied => {
    const f = fixture(); f.setReady({ ...freshReady(), adopt: { ...freshReady().adopt, applied } });
    await expect(f.run()).rejects.toThrow(/registered/); noWrites(f);
  });
  it.each([true, 'forced', 1])('refuses a forced READY record (%s) without writing', async forced => {
    const f = fixture(); f.setReady({ ...freshReady(), forced });
    await expect(f.run()).rejects.toThrow(/forced/); noWrites(f);
  });
  it.each([{}, { passedAt: 'invalid' }, { at: 'invalid' }])('refuses missing or invalid pass time %j without writing', async time => {
    const f = fixture(); const ready = freshReady(); delete ready.passedAt; f.setReady({ ...ready, ...time });
    await expect(f.run()).rejects.toThrow(/expired|pass time/); noWrites(f);
  });
  it.each(['passedAt', 'at'])('refuses %s older than the default max age without writing', async field => {
    const f = fixture(); const ready = freshReady(); delete ready.passedAt;
    f.setReady({ ...ready, [field]: new Date(nowMs - DEFAULT_READY_MAX_AGE_MS - 1).toISOString() });
    await expect(f.run()).rejects.toThrow(/expired/); noWrites(f);
  });
  it('refuses a pass older than the configured max age without writing', async () => {
    const f = fixture({ env: { WE_DAEMON_READY_MAX_AGE_MS: '1000' } });
    f.setReady({ ...freshReady(), passedAt: new Date(nowMs - 1001).toISOString() });
    await expect(f.run()).rejects.toThrow(/expired/); noWrites(f);
  });
  it('accepts the age boundary and historical at timestamp with the default for an invalid max age', async () => {
    const f = fixture({ env: { WE_DAEMON_READY_MAX_AGE_MS: 'invalid' } });
    const ready = freshReady(); delete ready.passedAt;
    f.setReady({ ...ready, at: new Date(nowMs - DEFAULT_READY_MAX_AGE_MS).toISOString() });
    await expect(f.run()).resolves.toEqual({ adopted: true });
  });
  it('refuses a READY record based on another HEAD without writing', async () => {
    const f = fixture(); f.setReady({ ...freshReady(), prevHead: mainTip });
    await expect(f.run()).rejects.toThrow(/base|HEAD/); noWrites(f);
  });
  it('refuses inputs rejected after the pass without writing', async () => {
    const f = fixture({ readRebuildState: vi.fn(() => ({ rejected: {
      inputsKey: 'fixture', at: new Date(nowMs + 1).toISOString(),
    } })) });
    await expect(f.run()).rejects.toThrow(/rejected/); noWrites(f);
  });
  it.each([
    { inputsKey: 'fixture', at: new Date(nowMs - 1).toISOString() },
    { inputsKey: 'fixture', at: new Date(nowMs).toISOString() },
    { inputsKey: 'other', at: new Date(nowMs + 1).toISOString() },
  ])('accepts rejection evidence that does not supersede this pass %j', async rejected => {
    const f = fixture({ readRebuildState: vi.fn(() => ({ rejected })) });
    await expect(f.run()).resolves.toEqual({ adopted: true });
  });
  it.each([undefined, null, () => undefined, () => { throw new Error('unreadable'); }])(
    'refuses unreadable rebuild state without writing (%s)', async readRebuildState => {
      const f = fixture({ readRebuildState });
      await expect(f.run()).rejects.toThrow(/unreadable rebuild state/); noWrites(f);
    });
  it('refuses an applied ref absent from the live overlay registry without writing', async () => {
    const f = fixture(); f.setReady({ ...freshReady(), adopt: { ...freshReady().adopt,
      applied: [{ ref: 'removed', sha }] } });
    await expect(f.run()).rejects.toThrow(/registered/); noWrites(f);
  });
  it('accepts empty READY fallback metadata on a plain verified record', async () => {
    const f = fixture(); f.setReady({ ...freshReady(), dropRefs: [], suspects: [], fallback: [] });
    await expect(f.run()).resolves.toEqual({ adopted: true });
  });
  it('accepts registered applied refs while intentionally allowing omission of another live overlay', async () => {
    const f = fixture(); f.setReady({ ...freshReady(), adopt: { ...freshReady().adopt,
      applied: [{ ref: 'edge', sha }] } });
    f.deps.readOverlayState.mockReturnValue({ corrupt: false, overlays: [{ ref: 'edge' }, { ref: 'omitted-live' }] });
    await expect(f.run()).resolves.toEqual({ adopted: true });
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
      stateOpts: f.deps.stateOpts, now: f.deps.now, plan: freshReady().adopt, prevHead, lease: { token: 'lease' } });
    expect(f.deps.readReadyCandidate).toHaveBeenCalledWith(root, { BASE: 'env', STATE: 'env' });
    expect(f.deps.readRebuildState).toHaveBeenCalledWith(root, { BASE: 'env', STATE: 'env' }, { strict: true });
  });
  it('runs once: finalization consumes the record and a second call refuses', async () => {
    const f = fixture(); await f.run();
    await expect(f.run()).rejects.toThrow(/no ready record/);
    expect(f.deps.finalizeRebuild).toHaveBeenCalledTimes(1);
    expect(f.deps.appendOverlayEvent).toHaveBeenCalledTimes(1);
  });
  it('runs all IO inside the injected write lock and supplies a null lease token when absent', async () => {
    const f = fixture(); f.setReady(freshReady()); await f.run();
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
