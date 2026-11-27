import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pinnedHookScript, pinnedStopHookScript } from '../../lib/pinned-hook-command.mjs';
import { buildAgentArgv, defaultClaudeProvider, createTickReader, createDispatchSinks, reserveBuildLane, resolveDispatchSettingsEnv, DISPATCH_BASH_TIMEOUT_ENV } from '../dispatch-lane-io.mjs';
import { spawnPreventionLandingJob } from '../../lib/prevention-landing-job.mjs';
import { NO_PROMPT_COMMAND_RULES } from '../../lib/no-prompt-command-rules.mjs';
import { shapeDispatchRead, DISPATCH_EFFECT } from '../dispatch-lane.mjs';

describe('LEAN-DAEMON background sessions', () => {
  function fixture(kind = 'fix') {
    const root = mkdtempSync(join(tmpdir(), 'lean-daemon-'));
    const options = {
      root, sessionId: 'fixture-session',
      payload: { launchKind: kind, prompt: 'Repair the fixture.', sessionSlug: `${kind}-fixture` },
      table: { model: 'sonnet', effort: 'high', reason: 'fixture-routing' },
    };
    return { root, options, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('fix and ci-heal background argv carries lean flags and an explicit routed model', () => {
    for (const kind of ['fix', 'ci-heal']) {
      const f = fixture(kind);
      try {
        const argv = buildAgentArgv(f.options);
        for (const flag of ['--bg', '--restricted', '--tools', '--strict-mcp-config', '--disable-slash-commands']) expect(argv).toContain(flag);
        expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
        const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
        expect(JSON.stringify(settings.hooks)).toContain('guard-bash.mjs');
        expect(JSON.stringify(settings.hooks)).toContain('guard-lane.mjs');
        expect(JSON.stringify(settings)).not.toMatch(/MEMORY|check-memory|user-hooks/);
      } finally { f.cleanup(); }
    }
  });

  it.each(['fix', 'ci-heal'])('%s resume retains the lean profile and the explicit routed model', kind => {
    const f = fixture(kind);
    try {
      const argv = buildAgentArgv({ ...f.options, resumeSessionId: 'existing' });
      expect(argv).toContain('--restricted');
      expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual(['--resume', 'existing']);
      expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
      expect(argv).not.toContain('-n');
    } finally { f.cleanup(); }
  });

  it.each(['--settings=personal.json', '--bare', '--safe-mode', '--append-system-prompt-file=MEMORY.md'])('refuses a profile override %s before launch', flag => {
    const f = fixture();
    try { expect(() => buildAgentArgv({ ...f.options, extraArgs: [flag] })).toThrow(/lean.*override/i); }
    finally { f.cleanup(); }
  });

  it('missing model refuses a lean resume with an operator recovery message', () => {
    const f = fixture();
    try { expect(() => buildAgentArgv({ ...f.options, table: { model: null, effort: 'high' }, resumeSessionId: 'existing' })).toThrow(/resolvable --model/); }
    finally { f.cleanup(); }
  });

  it.each(['rejected flags', 'foreign resume', 'unknown resume', 'supported resume'].flatMap(scenario =>
    [false, true].map(wrapped => ({ scenario, wrapped }))))('$scenario with wrapped=$wrapped never retries with a broader session and stops any reported replacement', ({ scenario, wrapped }) => {
    const f = fixture();
    const active = new Set(['existing']);
    const stop = vi.fn(({ handle }) => {
      active.delete(handle);
      return { stopped: true };
    });
    const spawnAgent = vi.fn(() => {
      if (scenario === 'rejected flags') throw new Error('CLI rejected restricted/background combination; operator intervention required');
      if (scenario === 'foreign resume') active.add('foreign');
      return scenario === 'unknown resume' ? '' : `backgrounded · ${scenario === 'foreign resume' ? 'foreign' : 'existing'}`;
    });
    const request = {
      root: f.root, cwd: f.root, prompt: f.options.payload.prompt, launchKind: 'fix',
      sessionId: 'new', resumeSessionId: 'existing', table: f.options.table,
      advisorFor: () => ({ enabled: false, reason: 'kind-not-in-trial' }),
      spawnEnv: { HOME: join(f.root, 'foreign-home'), CLAUDE_CONFIG_DIR: 'personal', CLAUDE_CODE_SETTINGS: 'user-hooks', PATH: '/fixture/bin' },
    };
    const launchWrapped = vi.fn(() => { throw new Error('background resume must not start a wrapper'); });
    try {
      const run = () => defaultClaudeProvider(request, { spawnAgent, stop, wrapKind: () => wrapped, launchWrapped });
      if (scenario === 'supported resume') expect(run()).toBe('existing');
      else expect(run).toThrow(/rejected|resume.*operator/i);
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect(launchWrapped).not.toHaveBeenCalled();
      expect(spawnAgent.mock.calls[0][0]).toContain('--restricted');
      expect(spawnAgent.mock.calls[0][1].env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(spawnAgent.mock.calls[0][1].env).not.toHaveProperty('CLAUDE_CODE_SETTINGS');
      expect([...active]).toEqual(['existing']);
      if (scenario === 'foreign resume') {
        expect(stop).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledWith({ handle: 'foreign' });
      } else expect(stop).not.toHaveBeenCalled();
    } finally { f.cleanup(); }
  });

  it.each(['fix', 'ci-heal'].flatMap(kind => [false, true].map(wrapped => ({ kind, wrapped }))))('$kind foreign resume with wrapped=$wrapped leaves no replacement active or untracked before reporting failure', ({ kind, wrapped }) => {
    const f = fixture(kind);
    const active = new Set(['existing']);
    const events = [];
    const launchWrapped = vi.fn(() => {
      active.add('unchecked-wrapper');
      return { handle: 'pid:1234', wrapperPid: 1234, sessionId: 'unchecked-wrapper' };
    });
    const spawnAgent = vi.fn(() => {
      active.add('foreign');
      events.push('spawn');
      return 'backgrounded · foreign';
    });
    const stop = vi.fn(({ handle }) => {
      expect(handle).toBe('foreign');
      active.delete(handle);
      events.push('stop');
      return { stopped: true };
    });
    try {
      let failure;
      try {
        defaultClaudeProvider({
          ...f.options, ...f.options.payload, cwd: f.root, resumeSessionId: 'existing',
          advisorFor: () => ({ enabled: false, reason: 'kind-not-in-trial' }),
        }, { spawnAgent, stop, wrapKind: () => wrapped, launchWrapped });
      } catch (error) { events.push('failure'); failure = error; }
      expect(failure).toMatchObject({ foreignSessionId: 'foreign', foreignSessionStopped: true });
      expect(failure.message).toMatch(/foreign.*stopped.*operator/);
      expect(events).toEqual(['spawn', 'stop', 'failure']);
      expect([...active]).toEqual(['existing']);
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(launchWrapped).not.toHaveBeenCalled();
    } finally { f.cleanup(); }
  });

  it.each(['throws', 'unconfirmed'].flatMap(outcome => [false, true].map(wrapped => ({ outcome, wrapped })) ))('foreign resume with wrapped=$wrapped and a stop that $outcome reports the live handle and operator recovery without retrying', ({ outcome, wrapped }) => {
    const f = fixture();
    const spawnAgent = vi.fn(() => 'backgrounded · foreign');
    const stop = vi.fn(() => {
      if (outcome === 'throws') throw new Error('stop unavailable');
      return { stopped: false };
    });
    const launchWrapped = vi.fn(() => { throw new Error('background resume must not start a wrapper'); });
    try {
      let failure;
      try {
        defaultClaudeProvider({
          ...f.options, ...f.options.payload, cwd: f.root, resumeSessionId: 'existing',
          advisorFor: () => ({ enabled: false, reason: 'kind-not-in-trial' }),
        }, { spawnAgent, stop, wrapKind: () => wrapped, launchWrapped });
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({ foreignSessionId: 'foreign', foreignSessionStopped: false });
      expect(failure.message).toContain('operator must run claude stop foreign before retrying');
      expect(failure).not.toHaveProperty('notApplied');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith({ handle: 'foreign' });
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect(launchWrapped).not.toHaveBeenCalled();
    } finally { f.cleanup(); }
  });
});

describe('LEAN-DAEMON audit regressions', () => {
  function fixture(kind = 'fix') {
    const root = mkdtempSync(join(tmpdir(), 'lean-audit-'));
    const launcher = join(root, 'workspace/.guard-main/scripts/hooks/run-pinned-guard.mjs');
    mkdirSync(join(root, 'workspace/.guard-main/scripts/hooks'), { recursive: true });
    const request = {
      cwd: root, root, sessionId: 'fixture-new', resumeSessionId: 'fixture-existing',
      launchKind: kind, prompt: 'Repair fixture',
      table: { model: 'sonnet', effort: 'high', reason: 'fixture' },
      advisorFor: () => ({ enabled: false, reason: 'kind-not-in-trial' }),
      spawnEnv: { HOME: root, PATH: '/fixture/bin' },
    };
    const argv = buildAgentArgv({ ...request, payload: { launchKind: kind, prompt: request.prompt } });
    const hooks = JSON.parse(argv[argv.indexOf('--settings') + 1]).hooks;
    const commands = event => (hooks?.[event] ?? []).flatMap(group => group.hooks.map(hook => hook.command));
    const run = command => spawnSync('/bin/sh', ['-c', command], {
      cwd: root, env: { HOME: root, PATH: `${join(process.execPath, '..')}:/usr/bin:/bin` },
      input: '{}', encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    });
    return { root, launcher, request, hooks, commands, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('all lean tool guards use the pinned launcher and convert missing or failed execution to blocking exit 2', () => {
    const f = fixture();
    try {
      const commands = f.commands('PreToolUse');
      expect(commands.length).toBeGreaterThanOrEqual(7);
      for (const command of commands) {
        expect(pinnedHookScript(command)).not.toBeNull();
        expect(f.run(command)).toMatchObject({ status: 2, stderr: expect.stringContaining('launcher missing') });
      }
      writeFileSync(f.launcher, 'process.exit(7);');
      for (const command of commands) expect(f.run(command).status).toBe(2);
    } finally { f.cleanup(); }
  });

  it.each([
    ['lint-locus-prefix.mjs', ['--pre']],
    ['lint-invisible-characters.mjs', []],
    ['check-memory.mjs', ['--pre']],
    ['backlog-guard.mjs', ['--pre']],
    ['guard-backward-edge.mjs', []],
  ])('retains the pinned write-time %s guard with its required arguments', (script, args) => {
    const f = fixture();
    try {
      const commands = (f.hooks.PreToolUse ?? []).filter(group => group.matcher === 'Edit|Write')
        .flatMap(group => group.hooks.map(hook => hook.command));
      const command = commands.find(command => pinnedHookScript(command) === `scripts/${script}`);
      expect(command).toBeTypeOf('string');
      writeFileSync(f.launcher, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);');
      const result = f.run(command);
      expect(JSON.parse(result.stdout)).toEqual([`scripts/${script}`, ...args]);
      expect(result.status).toBe(2);
    } finally { f.cleanup(); }
  });

  it('Stop retains passive-wait and background-work guards through the pinned stop launcher', () => {
    const f = fixture();
    try {
      const commands = f.commands('Stop');
      expect(commands.map(pinnedStopHookScript)).toEqual([
        'scripts/guard-stop-passive-wait.mjs', 'scripts/guard-stop-background-running.mjs',
      ]);
      writeFileSync(f.launcher, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(2);');
      for (const command of commands) {
        const result = f.run(command);
        expect(JSON.parse(result.stdout)).toEqual(['--stop-hook', pinnedStopHookScript(command)]);
        expect(result.status).toBe(2);
      }
    } finally { f.cleanup(); }
  });

  it.each(['fix', 'ci-heal'])('the %s provider forwards --resume to the actual spawn', kind => {
    const f = fixture(kind);
    const spawnAgent = vi.fn(() => 'backgrounded · fixture-existing');
    try {
      expect(defaultClaudeProvider(f.request, { spawnAgent, wrapKind: () => false })).toBe('fixture-existing');
      const argv = spawnAgent.mock.calls[0][0];
      expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual(['--resume', 'fixture-existing']);
      expect(argv).not.toContain('-n');
    } finally { f.cleanup(); }
  });

  it('other kinds retain wrapper enforcement and refuse unchecked background resume handles', () => {
    const f = fixture('build');
    const spawnAgent = vi.fn(() => 'backgrounded · foreign');
    const launchWrapped = vi.fn(() => { throw new Error('wrapper refuses unsupported resume'); });
    const stop = vi.fn(() => ({ stopped: true }));
    try {
      expect(() => defaultClaudeProvider(f.request, { spawnAgent, launchWrapped, stop, wrapKind: () => true })).toThrow(/wrapper refuses/);
      expect(launchWrapped).toHaveBeenCalledTimes(1);
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(() => defaultClaudeProvider(f.request, { spawnAgent, stop, wrapKind: () => false })).toThrow(/resume.*operator/);
      expect(stop).toHaveBeenCalledWith({ handle: 'foreign' });
      spawnAgent.mockReturnValue('');
      expect(() => defaultClaudeProvider(f.request, { spawnAgent, stop, wrapKind: () => false })).toThrow(/could not confirm.*operator/);
      expect(spawnAgent).toHaveBeenCalledTimes(2);
    } finally { f.cleanup(); }
  });
});

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
