import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTickReader, createDispatchSinks, reserveBuildLane, resolveDispatchSettingsEnv, DISPATCH_BASH_TIMEOUT_ENV } from '../dispatch-lane-io.mjs';
import { spawnPreventionLandingJob } from '../../lib/prevention-landing-job.mjs';
import { DISPATCH_EFFECT } from '../dispatch-lane.mjs';

describe('the tick reader handoff', () => {
  const at = '2026-10-06T12:00:00.000Z';
  const bookkeeping = { tick: 3, buildGuards: [] };
  const stdin = JSON.stringify({ bookkeeping });
  const tick = {
    decisions: { spawnBuilds: [{ num: '3037', lane: 8 }], statusLine: 'handed-off tick' },
    nextState: { tick: 4 },
  };
  const envelope = {
    at, bookkeepingHash: createHash('sha256').update(stdin).digest('hex'), tick,
  };
  function fixture(file = envelope, overrides = {}) {
    const runNode = vi.fn(() => JSON.stringify({ decisions: {}, nextState: { tick: 99 } }));
    const readText = vi.fn((path) => {
      if (path === '/tmp/bookkeeping.json') return JSON.stringify({ bookkeeping, config: { verbose: true } });
      if (path === '/tmp/tick.json') {
        if (file instanceof Error) throw file;
        return typeof file === 'string' ? file : JSON.stringify(file);
      }
      return 'dispatch brief';
    });
    const read = createTickReader({
      runNode, readText, now: () => new Date(at),
      loadItems: () => [{ num: '3037', slug: 'tick-handoff', scope: ['we:scripts/operations/'] }],
      listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
      recordLiveness: (value) => value, listAgents: () => [],
      checkAlreadyDone: () => ({ done: false, checked: true, pr: null }),
      checkBuildDelivery: () => null,
      readScorecards: () => [], readSizePolicy: () => ({}), readPromotions: () => [],
      readDeliveryAgentOverride: () => null,
      ...overrides,
    });
    return { runNode, readText, read: (options = {}) => read({
      num: '3037', bookkeepingFile: '/tmp/bookkeeping.json', tickFile: '/tmp/tick.json', ...options,
    }) };
  }

  it('uses a fresh tick file with the matching forwarded bookkeeping hash before the verbose rewrite', () => {
    const { read, runNode } = fixture();
    expect(read({ verbose: false })).toMatchObject({
      launch: tick.decisions.spawnBuilds[0], nextState: tick.nextState, statusLine: 'handed-off tick',
    });
    expect(runNode).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', { ...envelope, at: '2026-10-06T11:54:59.000Z' }],
    ['exactly five minutes old', { ...envelope, at: '2026-10-06T11:55:00.000Z' }],
    ['hash mismatch', { ...envelope, bookkeepingHash: 'wrong' }],
    ['future', { ...envelope, at: '2026-10-06T12:01:01.000Z' }],
    ['invalid timestamp', { ...envelope, at: 'invalid' }],
    ['unreadable', new Error('ENOENT')],
    ['malformed JSON', '{'],
    ['missing tick', { ...envelope, tick: undefined }],
    ['malformed tick', { ...envelope, tick: [] }],
  ])('falls back from a %s tick file', (_name, file) => {
    const { read, runNode } = fixture(file);
    expect(read().nextState).toEqual({ tick: 99 });
    expect(runNode).toHaveBeenCalledTimes(1);
    expect(runNode.mock.calls[0][1].input).toBe(stdin);
  });

  it('checks the in-flight guard before reading a tick file', () => {
    const { read, readText, runNode } = fixture(envelope, {
      listInFlightDispatches: () => ({ runs: [{ status: 'in-flight', live: true }], unreadable: 0 }),
      recordLiveness: (value) => ({ ...value, runs: value.runs.map(r => ({ ...r, live: true })) }),
    });
    expect(read().launch).toBeNull();
    expect(readText.mock.calls.some(([path]) => path === '/tmp/tick.json')).toBe(false);
    expect(runNode).not.toHaveBeenCalled();
  });

  it('accepts a Date.now-style clock for a tick file', () => {
    const { read, runNode } = fixture(envelope, { now: () => Date.parse(at) });
    expect(read().launch).toEqual(tick.decisions.spawnBuilds[0]);
    expect(runNode).not.toHaveBeenCalled();
  });

  // xykwe0h — the build-delivered gate only fires if readTick carries checkBuildDelivery's answer through as `buildDelivery`.
  it('wires checkBuildDelivery into the read as buildDelivery for a build launch', () => {
    const delivered = { outcome: 'pr-merged', pr: 4288, reason: 'PR #4288 merged' };
    const checkBuildDelivery = vi.fn(() => delivered);
    const { read } = fixture(envelope, { checkBuildDelivery });
    expect(read().buildDelivery).toEqual(delivered);
    expect(checkBuildDelivery).toHaveBeenCalledWith('3037');
  });

  it('a throwing checkBuildDelivery fails soft to buildDelivery null and still launches', () => {
    const { read } = fixture(envelope, { checkBuildDelivery: () => { throw new Error('gh down'); } });
    const out = read();
    expect(out.buildDelivery).toBeNull();
    expect(out.launch).toEqual(tick.decisions.spawnBuilds[0]);
  });

  it('does not call checkBuildDelivery when nothing is cleared for launch', () => {
    const checkBuildDelivery = vi.fn(() => ({ outcome: 'pr-open', pr: 1, reason: 'x' }));
    const { read } = fixture({ ...envelope, tick: { ...tick, decisions: { spawnBuilds: [], statusLine: 'idle' } } }, { checkBuildDelivery });
    expect(read().buildDelivery).toBeNull();
    expect(checkBuildDelivery).not.toHaveBeenCalled();
  });

  it('ignores the tick file for whole-queue reads', () => {
    const { read, readText, runNode } = fixture();
    runNode.mockReturnValue(JSON.stringify({ decisions: {
      admission: { queue: [], held: [], planned: [] },
    } }));
    expect(read({ all: true })).toEqual([]);
    expect(runNode).toHaveBeenCalledTimes(1);
    expect(readText.mock.calls.some(([path]) => path === '/tmp/tick.json')).toBe(false);
  });
});

// x87v3ed — reserve the lane BEFORE the build session launches.
describe('x87v3ed — the build launch reserves its lane first', () => {
  const payload = { num: '5189', launchKind: 'build', lane: 2, sessionSlug: 'conveyor-5189', scope: ['we:scripts/a.mjs'], prompt: 'brief' };
  const baseSinks = (extra) => createDispatchSinks({
    root: '/Users/op/workspace/webeverything', mintSessionId: () => 'sess-1', now: () => new Date('2026-10-08T00:00:00Z'),
    sessionCwdFor: () => '/tmp/scratch', ensureSessionCwd: (d) => d, resolveSettingsEnv: () => ({}),
    resolveLaneGrant: () => ({}), grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
    ...extra,
  });
  it('reserves lane N under the worker\'s own session slug', () => {
    const calls = [];
    const r = reserveBuildLane(payload, { enabled: true, run: (cmd, argv, o) => { calls.push({ cmd, argv, env: o.env }); return ''; }, root: '/r' });
    expect(r).toEqual({ reserved: true, lane: 2, session: 'conveyor-5189' });
    expect(calls[0].argv).toEqual(expect.arrayContaining(['scripts/lane-pool.mjs', 'acquire', '--lane=2', '--session=conveyor-5189', '--item=5189']));
  });
  it('refuses with notApplied, before any process, when the lane is already leased', () => {
    const run = () => { throw Object.assign(new Error('x'), { stderr: 'lane-2 is leased by review-4306 — a LIVE lease' }); };
    let err; try { reserveBuildLane(payload, { enabled: true, run }); } catch (e) { err = e; }
    expect(err?.notApplied).toBe(true);
    expect(err.message).toMatch(/lane-reserve-failed.*LIVE lease/);
  });
  it('is off for non-build kinds and when not enabled', () => {
    const run = () => { throw new Error('must not run'); };
    expect(reserveBuildLane({ ...payload, launchKind: 'prepare' }, { enabled: true, run }).reserved).toBe(false);
    expect(reserveBuildLane(payload, { enabled: false, run }).reserved).toBe(false);
  });
  it('the sink reserves BEFORE the provider spawns, and never spawns when the reservation fails', async () => {
    const order = [];
    const sinks = baseSinks({
      reserveLane: () => { order.push('reserve'); return { reserved: true, lane: 2, session: 'conveyor-5189' }; },
      provider: async () => { order.push('spawn'); return 'handle-1'; },
    });
    await sinks[DISPATCH_EFFECT](payload, {});
    expect(order).toEqual(['reserve', 'spawn']);
    let spawned = false;
    const refusing = baseSinks({
      reserveLane: () => { throw Object.assign(new Error('lane-reserve-failed'), { notApplied: true }); },
      provider: async () => { spawned = true; return 'h'; },
    });
    await expect(refusing[DISPATCH_EFFECT](payload, {})).rejects.toThrow(/lane-reserve-failed/);
    expect(spawned).toBe(false);
  });
  it('hands the reserved lane back when the launch definitely started nothing', async () => {
    const released = [];
    const sinks = baseSinks({
      reserveLane: () => ({ reserved: true, lane: 2, session: 'conveyor-5189' }),
      releaseLane: (r) => released.push(r),
      provider: async () => { throw Object.assign(new Error('bad'), { notApplied: true }); },
    });
    await expect(sinks[DISPATCH_EFFECT](payload, {})).rejects.toThrow();
    expect(released).toEqual([{ reserved: true, lane: 2, session: 'conveyor-5189' }]);
  });
});

// PR #5729 — a daemon's gh refusal shim is its auth boundary: a dispatch that cannot install it never starts.
describe('PR #5729 — daemon dispatch fails closed without the gh refusal shim', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const DAEMONS = [['explicit', { WE_GH_DAEMON_CALLER: 'review-daemon' }], ['XPC-only', { XPC_SERVICE_NAME: 'com.we.review-daemon' }]];
  const payload = { num: '5189', launchKind: 'build', lane: 2, sessionSlug: 'conveyor-5189', scope: ['we:scripts/a.mjs'], prompt: 'brief' };
  // A real gh on PATH (records any call) and a HOME whose `.claude` is read-only, so the shim-dir mkdir is EACCES.
  function unwritableShimHome(marker) {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-gh-guard-'));
    const bin = join(dir, 'bin');
    const claude = join(dir, 'home', '.claude');
    mkdirSync(bin);
    mkdirSync(claude, { recursive: true });
    const invoked = join(dir, 'gh-invoked');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho called >> '${invoked}'\n`, { mode: 0o755 });
    chmodSync(claude, 0o500);
    vi.stubEnv('HOME', join(dir, 'home'));
    vi.stubEnv('PATH', bin);
    vi.stubEnv('WE_GH_DAEMON_CALLER', marker.WE_GH_DAEMON_CALLER ?? '');
    vi.stubEnv('XPC_SERVICE_NAME', marker.XPC_SERVICE_NAME ?? '');
    return { invoked, cleanup: () => { chmodSync(claude, 0o700); rmSync(dir, { recursive: true, force: true }); } };
  }
  const sinksWith = (provider) => createDispatchSinks({
    root: '/Users/op/workspace/webeverything', mintSessionId: () => 'sess-1', now: () => new Date('2026-10-22T00:00:00Z'),
    sessionCwdFor: () => '/tmp/scratch', ensureSessionCwd: (d) => d, resolveSettingsEnv: resolveDispatchSettingsEnv,
    resolveLaneGrant: () => ({}), grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
    reserveLane: () => ({ reserved: false }), releaseLane: () => {}, provider,
  });

  it.each(DAEMONS)('daemon dispatch refuses an unwritable shim dir before invoking the provider (%s)', async (_kind, marker) => {
    const f = unwritableShimHome(marker);
    try {
      const provider = vi.fn(async () => 'handle-1');
      const err = await sinksWith(provider)[DISPATCH_EFFECT](payload, {}).then(() => null, (e) => e);
      expect(err?.message).toMatch(/dispatch refused: gh-shim: refusing daemon dispatch without the gh auth guard/);
      expect(err?.notApplied).toBe(true); // definitely not started: retryable, never an UNKNOWN in-flight entry
      expect(provider).not.toHaveBeenCalled();
      expect(existsSync(f.invoked)).toBe(false);
    } finally { f.cleanup(); }
  });

  it('an interactive dispatch keeps the best-effort fallback: the provider runs without shim settings', async () => {
    const f = unwritableShimHome({});
    try {
      const provider = vi.fn(async () => 'handle-1');
      await sinksWith(provider)[DISPATCH_EFFECT](payload, {});
      expect(provider).toHaveBeenCalledTimes(1);
      expect(provider.mock.calls[0][0].settingsEnv).toEqual(DISPATCH_BASH_TIMEOUT_ENV);
    } finally { f.cleanup(); }
  });

  it.each(DAEMONS)('the prevention landing job refuses to spawn without the guard (%s)', (_kind, marker) => {
    vi.stubEnv('WE_GH_DAEMON_CALLER', marker.WE_GH_DAEMON_CALLER ?? '');
    vi.stubEnv('XPC_SERVICE_NAME', marker.XPC_SERVICE_NAME ?? '');
    const spawnDetached = vi.fn(() => ({ pid: 4242 }));
    const r = spawnPreventionLandingJob({ title: 't', kind: 'story', size: 1, digest: 'd', scope: 'we:x', queue: true }, {
      spawnDetached, logPathFor: () => '/dev/null',
      resolveSettingsEnv: () => { throw new Error('gh-shim: refusing daemon dispatch without the gh auth guard'); },
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/refusing to spawn without the gh auth guard/) });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('the prevention landing job stays fail-soft for an interactive caller', () => {
    vi.stubEnv('WE_GH_DAEMON_CALLER', '');
    vi.stubEnv('XPC_SERVICE_NAME', '');
    const spawnDetached = vi.fn(() => ({ pid: 4242 }));
    const r = spawnPreventionLandingJob({ title: 't', kind: 'story', size: 1, digest: 'd', scope: 'we:x', queue: true }, {
      spawnDetached, logPathFor: () => '/dev/null', resolveSettingsEnv: () => { throw new Error('boom'); },
    });
    expect(r.ok).toBe(true);
    expect(spawnDetached.mock.calls[0][1].settingsEnv).toBeNull();
  });
});
