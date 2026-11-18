import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTickReader, createDispatchSinks, defaultSpawnAgent, defaultClaudeProvider, reserveBuildLane, resolveDispatchSettingsEnv, DISPATCH_BASH_TIMEOUT_ENV } from '../dispatch-lane-io.mjs';
import { spawnPreventionLandingJob } from '../../lib/prevention-landing-job.mjs';
import { NO_PROMPT_COMMAND_RULES } from '../../lib/no-prompt-command-rules.mjs';
import { shapeDispatchRead, DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { applyPendingEffects, inFlightEntries } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';

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
  function fixture(file = envelope, overrides = {}, template = 'dispatch brief') {
    const runNode = vi.fn(() => JSON.stringify({ decisions: {}, nextState: { tick: 99 } }));
    const readText = vi.fn((path) => {
      if (path === '/tmp/bookkeeping.json') return JSON.stringify({ bookkeeping, config: { verbose: true } });
      if (path === '/tmp/tick.json') {
        if (file instanceof Error) throw file;
        return typeof file === 'string' ? file : JSON.stringify(file);
      }
      return template;
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
  describe.each([['fix', 'spawnFixes'], ['ci-heal', 'spawnCiHeals']])('%s raw template boundary', (kind, list) => {
    const repairEnvelope = { ...envelope, tick: {
      decisions: { [list]: [{ num: '3037', lane: 8, pr: 701, reason: 'red-ci' }] }, nextState: {},
    } };
    it.each(['', ' ', '\t', '\n', '\r', '\r\n', ' \t\r\n'])('refuses %j before build requirements or operator steps', task => {
      const { read } = fixture(repairEnvelope, { laneRefForPr: () => 'lane/3037-repair' }, task);
      expect(() => read()).toThrow('dispatch-lane: the delivery-agent brief template is empty — refusing to dispatch an agent with no instructions');
    });
    it('accepts a non-empty template and injects the complete block exactly once', () => {
      const { read } = fixture(repairEnvelope, { laneRefForPr: () => 'lane/3037-repair' }, 'Repair this PR.');
      const shaped = shapeDispatchRead(read(), { num: '3037' });
      expect(shaped.launchKind).toBe(kind);
      expect(shaped.prompt.startsWith(`${NO_PROMPT_COMMAND_RULES}\n\n`)).toBe(true);
      expect(shaped.prompt.split(NO_PROMPT_COMMAND_RULES)).toHaveLength(2);
      expect(shaped.prompt).toContain('Repair this PR.');
    });
  });

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
  it.each(['build', 'prepare'])('refuses the whole %s group before any writes when a member is refused', async launchKind => {
    const provider = vi.fn(async () => 'pid:123');
    const reserveLane = vi.fn();
    const ensureSessionCwd = vi.fn();
    const sinks = baseSinks({ provider, reserveLane, ensureSessionCwd,
      readRuntimeSettings: () => ({ mode: 'only', only: true, ids: ['12'] }) });
    await expect(sinks[DISPATCH_EFFECT]({ ...payload, num: '12', launchKind, groupMembers: ['12', '13'] }))
      .rejects.toMatchObject({ notApplied: true, outcome: 'runtime-refused',
        runtimeRefused: [{ num: '13', kind: launchKind, reason: 'runtime-only' }] });
    await expect(sinks[DISPATCH_EFFECT]({ ...payload, num: '13', launchKind, groupMembers: ['12'] }))
      .rejects.toMatchObject({ notApplied: true });
    expect(provider).not.toHaveBeenCalled();
    expect(reserveLane).not.toHaveBeenCalled();
    expect(ensureSessionCwd).not.toHaveBeenCalled();
  });
  it('forwards the fully admitted group and its instructions unchanged', async () => {
    const provider = vi.fn(async () => 'pid:123');
    const sinks = baseSinks({ provider, reserveLane: () => ({}),
      readRuntimeSettings: () => ({ mode: 'only', only: true, ids: ['12', '13'] }) });
    const groupMembers = ['12', '13'];
    const prompt = 'Build #12 and #13 together';
    await sinks[DISPATCH_EFFECT]({ ...payload, num: '12', groupMembers, prompt });
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][0].groupMembers).toBe(groupMembers);
    expect(provider.mock.calls[0][0].prompt).toBe(prompt);
  });
  describe.each(['build', 'prepare-item'])('fresh %s admission at provider launch', launchKind => {
    it.each([
      ['empty list during reservation', [], 'reserve'],
      ['member removed during reservation', ['12'], 'reserve'],
      ['lead removed during reservation', ['13'], 'reserve'],
      ['empty list during final settings setup', [], 'settings'],
      ['unreadable settings after reservation', null, 'reserve'],
    ])('refuses all work and clears reservations: %s', async (_name, ids, phase) => {
      let settings = { mode: 'only', only: true, ids: ['12', '13'] };
      const revoke = () => { settings = ids === null ? null : { ...settings, ids }; };
      const reservation = { reserved: true, lane: 2, session: 'conveyor-12' };
      const leases = new Set();
      const releaseLane = vi.fn(r => leases.delete(r));
      const provider = vi.fn(async () => 'pid:123');
      const readRuntimeSettings = vi.fn(() => {
        if (settings === null) throw new Error('settings unreadable');
        return settings;
      });
      const sinks = baseSinks({ provider, releaseLane, readRuntimeSettings,
        reserveLane: () => {
          leases.add(reservation);
          if (phase === 'reserve') revoke();
          return reservation;
        },
        resolveSettingsEnv: () => { if (phase === 'settings') revoke(); return {}; },
      });
      const run = { v: 1, id: 'runtime-race', op: 'dispatch-lane', input: { num: '12' },
        cursor: 2, findings: {}, verdict: null, telemetry: [], pending: { kind: 'effect', stepIndex: 2, step: 'dispatch' },
        effects: [{ key: 'runtime-race#2#0', stepIndex: 2, index: 0, type: DISPATCH_EFFECT,
          status: 'declared', dispatch: true, idempotent: false,
          payload: { ...payload, num: '12', launchKind, groupMembers: ['13'] } }],
      };
      const store = createMemoryRunStore();
      const result = await applyPendingEffects(run, { sinks, store });
      const kind = launchKind.startsWith('prepare') ? 'prepare' : 'build';
      const refused = ['12', '13'].filter(num => ids === null || !ids.includes(num))
        .map(num => ({ num, kind: num === '12' ? launchKind : kind,
          reason: ids === null ? 'runtime-malformed' : 'runtime-only' }));
      expect(result.error).toMatchObject({ notApplied: true, outcome: 'runtime-refused', runtimeRefused: refused });
      expect(readRuntimeSettings).toHaveBeenCalledTimes(4);
      expect(provider).not.toHaveBeenCalled();
      expect(releaseLane).toHaveBeenCalledTimes(1);
      expect(releaseLane).toHaveBeenCalledWith(reservation);
      expect(leases.size).toBe(0);
      expect(result.inFlight).toEqual([]);
      expect(store.read(run.id).effects[0]).toMatchObject({ status: 'failed', handle: null });
      expect(inFlightEntries(store.read(run.id))).toMatchObject({ running: [], overdue: [], unknown: [] });
    });
    it('launches a still-listed lead and member after reservation', async () => {
      let reserved = false;
      const readRuntimeSettings = vi.fn(() => ({ mode: 'only', only: true, ids: ['12', '13'] }));
      const provider = vi.fn(async request => {
        expect(reserved).toBe(true);
        expect(readRuntimeSettings).toHaveBeenCalledTimes(4);
        expect(request).toMatchObject({ num: '12', launchKind, groupMembers: ['13'] });
        return 'pid:123';
      });
      const releaseLane = vi.fn();
      const sinks = baseSinks({ provider, readRuntimeSettings, releaseLane,
        reserveLane: () => { reserved = true; return { reserved: true, lane: 2, session: 'conveyor-12' }; },
      });
      await sinks[DISPATCH_EFFECT]({ ...payload, num: '12', launchKind, groupMembers: ['13'] });
      expect(provider).toHaveBeenCalledOnce();
      expect(releaseLane).not.toHaveBeenCalled();
    });
  });
  it('passes the sink settings reader and card identity into the default raw spawn', async () => {
    const readRuntimeSettings = vi.fn(() => ({ mode: 'only', only: true, ids: ['12'] }));
    const exec = vi.fn(() => {
      expect(readRuntimeSettings).toHaveBeenCalledTimes(3);
      return 'backgrounded · handle-12 · n';
    });
    const sinks = baseSinks({ exec, modes: { build: 'agent' }, readRuntimeSettings,
      reserveLane: () => ({ reserved: true }),
    });
    await sinks[DISPATCH_EFFECT]({ ...payload, num: '12' });
    expect(exec).toHaveBeenCalledOnce();
  });
  describe.each(['build', 'prepare-item'])('%s trust retry admission', launchKind => {
    it.each([
      ['lead revoked', ['13']], ['member revoked', ['12']], ['all revoked', []],
      ['settings unreadable', null], ['still admitted', ['12', '13']],
    ])('%s after the first attempt', async (_name, nextIds) => {
      let ids = ['12', '13'];
      const readRuntimeSettings = vi.fn(() => {
        if (ids === null) throw new Error('unreadable');
        return { mode: 'only', only: true, ids };
      });
      const exec = vi.fn(() => {
        if (exec.mock.calls.length === 1) {
          ids = nextIds;
          throw Object.assign(new Error('trust refusal'), { stderr: 'Workspace not trusted.' });
        }
        return 'retry-handle';
      });
      const grantTrust = vi.fn();
      const reservation = { reserved: true, lane: 2, session: 'conveyor-12' };
      const leases = new Set();
      const releaseLane = vi.fn(r => leases.delete(r));
      // Group-capable provider exercises the same guarded spawn helper as the default agent provider.
      const provider = request => defaultSpawnAgent(['--bg'], { cwd: request.cwd }, {
        exec, grantTrust, card: request, readRuntimeSettings,
      });
      const sinks = baseSinks({ provider, releaseLane, readRuntimeSettings,
        reserveLane: () => { leases.add(reservation); return reservation; },
      });
      const run = { v: 1, id: 'trust-retry', op: 'dispatch-lane', input: { num: '12' },
        cursor: 2, findings: {}, verdict: null, telemetry: [], pending: { kind: 'effect', stepIndex: 2, step: 'dispatch' },
        effects: [{ key: 'trust-retry#2#0', stepIndex: 2, index: 0, type: DISPATCH_EFFECT,
          status: 'declared', dispatch: true, idempotent: false,
          payload: { ...payload, num: '12', launchKind, groupMembers: ['13'] } }],
      };
      const store = createMemoryRunStore();
      const result = await applyPendingEffects(run, { sinks, store });
      expect(grantTrust).toHaveBeenCalledTimes(1);
      expect(grantTrust).toHaveBeenCalledWith('/tmp/scratch');
      expect(readRuntimeSettings).toHaveBeenCalledTimes(8);
      const admitted = nextIds?.length === 2;
      expect(exec).toHaveBeenCalledTimes(admitted ? 2 : 1);
      if (admitted) {
        expect(result.error).toBeNull();
        expect(releaseLane).not.toHaveBeenCalled();
        expect(leases.size).toBe(1);
      } else {
        const refused = ['12', '13'].filter(num => !nextIds?.includes(num)).map(num => ({
          num, kind: num === '12' ? launchKind : launchKind.startsWith('prepare') ? 'prepare' : 'build',
          reason: nextIds === null ? 'runtime-malformed' : 'runtime-only',
        }));
        expect(result.error).toMatchObject({ notApplied: true, outcome: 'runtime-refused', runtimeRefused: refused });
        expect(releaseLane).toHaveBeenCalledTimes(1);
        expect(releaseLane).toHaveBeenCalledWith(reservation);
        expect(leases.size).toBe(0);
        expect(result.inFlight).toEqual([]);
        expect(store.read(run.id).effects[0]).toMatchObject({ status: 'failed', handle: null });
        expect(inFlightEntries(store.read(run.id))).toMatchObject({ running: [], overdue: [], unknown: [] });
      }
    });
    it('forwards admission identity through the default provider to each raw launch attempt', async () => {
      let ids = ['12'];
      const exec = vi.fn(() => {
        ids = [];
        throw Object.assign(new Error('trust refusal'), { stderr: 'Workspace not trusted.' });
      });
      const releaseLane = vi.fn();
      const readRuntimeSettings = () => ({ mode: 'only', only: true, ids });
      const sinks = baseSinks({ exec, releaseLane, readRuntimeSettings,
        reserveLane: () => ({ reserved: true }),
        // Exercise defaultClaudeProvider's identity forwarding without touching the real trust file.
        provider: request => defaultClaudeProvider(request, { wrapKind: () => false,
          spawnAgent: (argv, opts, card) => defaultSpawnAgent(argv, opts, {
            exec, card, readRuntimeSettings, grantTrust: () => {},
          }),
        }),
      });
      await expect(sinks[DISPATCH_EFFECT]({ ...payload, num: '12', launchKind }))
        .rejects.toMatchObject({ outcome: 'runtime-refused' });
      expect(exec).toHaveBeenCalledOnce();
      expect(releaseLane).toHaveBeenCalledOnce();
    });
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
