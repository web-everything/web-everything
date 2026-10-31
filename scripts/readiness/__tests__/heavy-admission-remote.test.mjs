// @vitest-environment node
/** Contract tests for the pending remote admission exports; all execution and load IO is injected. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, decideRemote, runWithRemoteDecision, adaptLegacyRemoteResult, resolveAdmissionPolicy, heldSlots, shellQuoteWord, DEFAULT_ADMISSION_CEILING_MS, DEFAULT_FAST_RUN_TIMEOUT_MS } from '../heavy-admission.mjs';
import { runRemote } from '../remote-exec.mjs';
import { execContainerized } from '../../lib/container-exec.mjs';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(), execSync: vi.fn(),
}));
vi.mock('../../lib/host-load.mjs', async (importOriginal) => ({
  ...await importOriginal(), hostLoadAdmission: vi.fn(() => ({ admitted: true })),
}));
vi.mock('../../lib/container-exec.mjs', async (importOriginal) => ({
  ...await importOriginal(), execContainerized: vi.fn(),
  containerCliAvailable: vi.fn(() => true), containerImageAvailable: vi.fn(() => true),
}));

const argv = ['npm', 'run', 'test:unit', '--', 'a file.test.mjs', '$(must-stay-literal)'];
const remoteDefaults = { enabled: false, mode: 'above-threshold', loadPerCoreThreshold: 3,
  maxConcurrent:8, backoffMs:120000, backoffFailures:3, maxLoadPerCore:0.8, minFreeRamPct:15 };
const testRoots=[];
afterEach(()=>{for(const root of testRoots.splice(0))rmSync(root,{recursive:true,force:true});});
const healthyRead=async()=>({sampledAtET:(await import('../forge-exec-run.mjs')).easternTimestamp(Date.now()),
  cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]});
const policyFor = (remote = {}) => resolveAdmissionPolicy({
  platform: { remote: { ...remoteDefaults, enabled: true, ...remote } },
});

function expectDecision(result, remote) {
  expect(result).toEqual({ remote, reason: expect.any(String) });
  expect(result.reason.trim()).not.toBe('');
}

function fixture({ remote = {}, load = 4, result = { mode: 'remote', code: 0 } } = {}) {
  const root=mkdtempSync(join(process.env.TMPDIR,'admission-remote-'));testRoots.push(root);
  return {lockRoot:join(root,'heavy'),readTelemetry:healthyRead,
    argv: [...argv], policy: policyFor(remote), cwd: 'fixture-checkout',
    loadPerCore: vi.fn(() => load), remoteExec: vi.fn(async () => result), log: vi.fn(),
  };
}

function expectLines(log, count, direction) {
  expect(log).toHaveBeenCalledTimes(count);
  for (const call of log.mock.calls) {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe('string');
    expect(call[0].trim()).not.toBe('');
  }
  expect(log.mock.calls[0][0]).toMatch(new RegExp(direction, 'i'));
}

function expectFallback(log, reason) {
  expectLines(log, 2, 'remote');
  expect(log.mock.calls[1][0]).toMatch(/fallback/i);
  if (reason) expect(log.mock.calls[1][0]).toContain(reason);
  else expect(log.mock.calls[1][0].replace(/fallback/gi, '').replace(/[^a-z0-9]/gi, '')).not.toBe('');
}

describe('remote admission policy', () => {
  it.each([
    'invalid-diff-coverage-base',
    'diff-coverage-base-unavailable',
    'coverage-report-not-portable',
  ])('runs locally after the adapter confirms pre-execution coverage fallback %s', async (reason) => {
    const root = mkdtempSync(join(process.env.TMPDIR, 'coverage-fallback-'));
    testRoots.push(root);
    const pool = join(root, 'pool');
    const lockRoot = join(pool, '.admission', 'heavy');
    const remoteRoot = join(pool, '.admission', 'remote');
    mkdirSync(pool);
    const preferences = join(root, 'preferences.json');
    writeFileSync(preferences, JSON.stringify({ heavyAdmission: {
      remote: { enabled: true, mode: 'always' }, fastScale: { maxSlots: 1 },
    } }));
    const exited = new Error('test exit');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const [key, value] of Object.entries({ LANE_POOL_ROOT: pool, WE_PLATFORM_PREFERENCES: preferences,
      CI: '', WE_HEAVY_ADMISSION: 'on', WE_HEAVY_ADMISSION_HELD: '', WE_FORGE_GATE_DISPATCH: '',
      WE_HEAVY_ADMISSION_CONTAINER: '', WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES: '',
      WE_HEAVY_ADMISSION_RUN_WAIT_MS: '0' })) vi.stubEnv(key, value);
    const remoteExec = vi.fn(async () => adaptLegacyRemoteResult({ mode: 'fallback', reason }));
    vi.mocked(execSync).mockImplementation(() => {
      expect(heldSlots({ lockRoot, cap: 2, fastSlots: 1 })).toHaveLength(1);
      expect(heldSlots({ lockRoot: remoteRoot, cap: 8 })).toHaveLength(0);
      expect(existsSync(join(remoteRoot, 'slot-0.unconfirmed'))).toBe(false);
      throw Object.assign(new Error('local command exit'), { status: 17 });
    });
    try {
      await expect(main(['run', `--repo=${root}`, '--', ...argv], { remoteExec, readTelemetry: healthyRead }))
        .rejects.toBe(exited);
      expect(remoteExec).toHaveBeenCalledTimes(1);
      expect(execSync).toHaveBeenCalledTimes(1);
      expect(execSync).toHaveBeenCalledWith(argv.map(shellQuoteWord).join(' '), expect.objectContaining({
        cwd: root, env: expect.objectContaining({ WE_HEAVY_ADMISSION_HELD: '1' }),
      }));
      expect(exit).toHaveBeenCalledWith(17);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`fallback: ${reason}`));
      expect(heldSlots({ lockRoot, cap: 2, fastSlots: 1 })).toHaveLength(0);
    } finally {
      vi.mocked(execSync).mockReset(); exit.mockRestore(); stderr.mockRestore(); vi.unstubAllEnvs();
    }
  });

  it('runs unsupported check:standards arguments locally with a reason and no remote staging',async()=>{
    const root=mkdtempSync(join(process.env.TMPDIR,'standards-fallback-')),pool=join(root,'pool');mkdirSync(pool);
    const preferences=join(root,'preferences.json');
    writeFileSync(preferences,JSON.stringify({heavyAdmission:{remote:{enabled:true,mode:'always'}}}));
    const command=['npm','run','check:standards','--','--unknown'];
    const exited=new Error('test exit'),transport=vi.fn(),stage=vi.fn();
    const exit=vi.spyOn(process,'exit').mockImplementation(()=>{throw exited;});
    const stderr=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
    for(const [key,value] of Object.entries({LANE_POOL_ROOT:pool,WE_PLATFORM_PREFERENCES:preferences,
      CI:'',WE_HEAVY_ADMISSION:'on',WE_HEAVY_ADMISSION_HELD:'1',WE_FORGE_GATE_DISPATCH:'1',
      WE_HEAVY_ADMISSION_CONTAINER:'',WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES:''}))vi.stubEnv(key,value);
    vi.mocked(execSync).mockImplementation(()=>{throw Object.assign(new Error('local command exit'),{status:17});});
    try {
      await expect(main(['run',`--repo=${root}`,'--',...command],{
        readTelemetry:healthyRead,
        remoteExec:async options=>adaptLegacyRemoteResult(await runRemote({...options,exec:transport,fs:{mkdtemp:stage}})),
      })).rejects.toBe(exited);
      expect(execSync).toHaveBeenCalledTimes(1);
      expect(execSync).toHaveBeenCalledWith(command.map(shellQuoteWord).join(' '),expect.objectContaining({cwd:root}));
      expect(exit).toHaveBeenCalledWith(17);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('command-not-allowed'));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
      expect(vi.mocked(execSync).mock.calls[0][1].env).not.toHaveProperty('WE_FORGE_GATE_DISPATCH');
      expect(transport).not.toHaveBeenCalled();expect(stage).not.toHaveBeenCalled();
    }finally{
      vi.mocked(execSync).mockReset();exit.mockRestore();stderr.mockRestore();vi.unstubAllEnvs();
      rmSync(root,{recursive:true,force:true});
    }
  });
  it('ignores conflicting tool remote settings on the shared pool', () => {
    const remote = { enabled: true, mode: 'always', loadPerCoreThreshold: 5 };
    const policy = resolveAdmissionPolicy({
      platform: { remote }, tool: { remote: { enabled: false, mode: 'above-threshold', loadPerCoreThreshold: 99 } }, env: {},
    });
    expect(policy.settings.remote).toEqual({...remoteDefaults,...remote});
    for (const leaf of Object.keys(remote)) {
      expect(policy.sources[`remote.${leaf}`]).toBe('platform');
      expect(policy.ignored).toContainEqual(expect.stringContaining(`tool.remote.${leaf}=`));
    }
  });

  it.each([
    {env:{},command:argv,expected:argv},
    {env:{WE_HEAVY_ADMISSION_HELD:'1',WE_FORGE_GATE_DISPATCH:'1'},command:argv,expected:argv},
    {env:{WE_HEAVY_ADMISSION_HELD:'1',WE_FORGE_GATE_DISPATCH:'1'},command:['node','scripts/check-standards.mjs','--local','--files=a.mjs'],expected:['npm','run','check:standards','--','--local','--files=a.mjs']},
    {env:{},command:['vitest','run','--config','vitest.integration.config.ts','a.test.mjs'],expected:['npm','run','test:integration:vitest','--','a.test.mjs']},
    {env:{},command:['vitest','run','--config','vitest.integration.config.ts'],expected:['npm','run','test:integration:vitest']},
    {env:{},command:['vitest','run','--coverage','a.test.mjs'],expected:['npm','run','test:coverage','--','a.test.mjs']},
    {env:{},command:['vitest','run','--coverage'],expected:['npm','run','test:coverage']},
    {env:{},command:['vitest','run','a.test.mjs'],expected:['npm','run','test:unit','--','a.test.mjs']},
    {env:{},command:['vitest','run'],expected:['npm','run','test:unit']},
    {env:{},command:['vitest','list'],expected:['vitest','list']},
  ])('main run dispatches a direct command or explicitly designated Mac verify gate remotely: %j', async ({env:gateEnv,command,expected}) => {
    const root = mkdtempSync(join(tmpdir(), 'remote-main-'));
    const pool = join(root, 'pool');
    mkdirSync(pool);
    const prefs = join(root, 'preferences.json');
    writeFileSync(prefs, JSON.stringify({ heavyAdmission: { remote: { enabled: true, mode: 'always' } } }));
    const exited = new Error('test exit');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const [key, value] of Object.entries({ LANE_POOL_ROOT: pool, WE_PLATFORM_PREFERENCES: prefs,
      CI: '', WE_HEAVY_ADMISSION: 'on', WE_HEAVY_ADMISSION_HELD: '', WE_HEAVY_ADMISSION_CONTAINER: '', WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES: '',...gateEnv })) vi.stubEnv(key, value);
    try {
      const remoteExec = vi.fn(async () => ({ mode: 'remote', code: 23 }));
      await expect(main(['run', `--repo=${root}`, '--', ...command], { remoteExec, readTelemetry:healthyRead })).rejects.toBe(exited);
      expect(remoteExec).toHaveBeenCalledWith(expect.objectContaining({ argv:expected, cwd: root, signal: expect.any(AbortSignal) }));
      expect(exit).toHaveBeenCalledWith(23);
      expect(existsSync(join(pool, '.admission','heavy'))).toBe(false);
      expect(heldSlots({lockRoot:join(pool,'.admission','remote'),cap:8})).toHaveLength(0);
    } finally { exit.mockRestore(); stderr.mockRestore(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });
  it('defaults to disabled, above-threshold, threshold 3, with standard sources', () => {
    const policy = resolveAdmissionPolicy({});
    expect(policy.settings.remote).toEqual(remoteDefaults);
    expect(policy.sources).toMatchObject({
      'remote.enabled': 'standard',
      'remote.mode': 'standard',
      'remote.loadPerCoreThreshold': 'standard',
    });
    expect(policy.invalid).toEqual([]);
  });

  it.each([
    ['CI with Forge gate handoff', {CI:'true',WE_HEAVY_ADMISSION_HELD:'1',WE_FORGE_GATE_DISPATCH:'1'}, [], true, false],
    ['admission off with Forge gate handoff', {WE_HEAVY_ADMISSION:'off',WE_HEAVY_ADMISSION_HELD:'1',WE_FORGE_GATE_DISPATCH:'1'}, [], true, false],
    ['WE_HEAVY_ADMISSION=off bypass', { WE_HEAVY_ADMISSION: 'off' }, [], true, false],
    ['--container', {}, ['--container'], true, true],
    ['WE_HEAVY_ADMISSION_HELD=1', { WE_HEAVY_ADMISSION_HELD: '1' }, [], true, false],
    ['WE_HEAVY_ADMISSION_HELD set to another truthy value', { WE_HEAVY_ADMISSION_HELD: 'true' }, [], true, true],
    ['remote disabled by default', {}, [], false, true],
    ['remote.* env vars cannot enable remote', {
      'remote.enabled': 'true', 'remote.mode': 'always',
      WE_HEAVY_ADMISSION_REMOTE_ENABLED: 'true', WE_HEAVY_ADMISSION_REMOTE_MODE: 'always',
    }, [], false, true],
  ])('main run keeps %s local and proceeds with local admission', async (_name, env, flags, enableRemote, acquiresSlot) => {
    const root = mkdtempSync(join(tmpdir(), 'remote-main-local-'));
    const pool = join(root, 'pool');
    const lockRoot = join(pool, '.admission', 'heavy');
    mkdirSync(pool);
    const prefs = join(root, 'preferences.json');
    writeFileSync(prefs, JSON.stringify({ heavyAdmission: {
      ...(enableRemote ? { remote: { enabled: true, mode: 'always' } } : {}),
      fastScale: { maxSlots: 1 },
    } }));
    const exited = new Error('test exit');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const [key, value] of Object.entries({ LANE_POOL_ROOT: pool, WE_PLATFORM_PREFERENCES: prefs,
      CI: '', WE_HEAVY_ADMISSION: 'on', WE_HEAVY_ADMISSION_HELD: '', WE_HEAVY_ADMISSION_CONTAINER: '',
      WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES: '', WE_HEAVY_ADMISSION_RUN_WAIT_MS: '0', ...env })) vi.stubEnv(key, value);
    const localExec = flags.includes('--container') ? execContainerized : execSync;
    vi.mocked(localExec).mockImplementation(() => {
      expect(heldSlots({ lockRoot, cap: 2, fastSlots: 1 })).toHaveLength(acquiresSlot ? 1 : 0);
      throw Object.assign(new Error('local command exit'), { status: 17 });
    });
    try {
      const remoteExec = vi.fn(async () => ({ mode: 'remote', code: 23 }));
      await expect(main(['run', `--repo=${root}`, ...flags, '--', ...argv], { remoteExec, readTelemetry:healthyRead })).rejects.toBe(exited);
      expect(remoteExec).not.toHaveBeenCalled();
      expect(localExec).toHaveBeenCalledTimes(1);
      expect(localExec).toHaveBeenCalledWith(argv.map(shellQuoteWord).join(' '), expect.objectContaining({
        cwd: root, env: expect.objectContaining({ WE_HEAVY_ADMISSION_HELD: '1' }),
      }));
      expect(localExec.mock.calls[0][1].env).not.toHaveProperty('WE_FORGE_GATE_DISPATCH');
      expect(exit).toHaveBeenCalledWith(17);
      expect(heldSlots({ lockRoot, cap: 2, fastSlots: 1 })).toHaveLength(0);
      if (!enableRemote) expect(stderr).toHaveBeenCalledWith(expect.stringContaining('remote.enabled=false (standard)'));
    } finally {
      vi.mocked(execSync).mockReset(); vi.mocked(execContainerized).mockReset();
      exit.mockRestore(); stderr.mockRestore(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves valid platform remote settings and their provenance', () => {
    const remote = { enabled: true, mode: 'always', loadPerCoreThreshold: 5 };
    const policy = policyFor(remote);
    expect(policy.settings.remote).toEqual({...remoteDefaults,...remote});
    expect(policy.sources).toMatchObject({
      'remote.enabled': 'platform',
      'remote.mode': 'platform',
      'remote.loadPerCoreThreshold': 'platform',
    });
    expect(policy.invalid).toEqual([]);
  });

  it('rejects bogus mode and negative threshold into invalid and keeps defaults', () => {
    const policy = resolveAdmissionPolicy({
      platform: { remote: { mode: 'bogus', loadPerCoreThreshold: -1 } },
    });
    expect(policy.settings.remote).toEqual(remoteDefaults);
    expect(policy.sources).toMatchObject({
      'remote.mode': 'standard', 'remote.loadPerCoreThreshold': 'standard',
    });
    expect(policy.invalid).toEqual(expect.arrayContaining([
      expect.stringContaining('platform.remote.mode'),
      expect.stringContaining('platform.remote.loadPerCoreThreshold'),
    ]));
  });
});

describe('decideRemote', () => {
  it.each([
    ['below threshold -> local', {}, 2.9, false],
    ['at threshold -> local', {}, 3, false],
    ['above -> remote', {}, 3.1, true],
    ['disabled -> local', { enabled: false }, 100, false],
    ['disabled always -> local', { enabled: false, mode: 'always' }, 100, false],
    ['always -> remote', { mode: 'always' }, 0, true],
    ['custom threshold below -> local', { loadPerCoreThreshold: 5 }, 4, false],
    ['custom threshold above -> remote', { loadPerCoreThreshold: 1 }, 2, true],
  ])('%s', (_name, remote, loadPerCore, expected) => {
    expectDecision(decideRemote({ policy: policyFor(remote), loadPerCore, argv }), expected);
  });

  it.each([NaN, Infinity, -Infinity, undefined, null, '4', {}, []])(
    'unreadable load %j -> local with load-unreadable reason', (loadPerCore) => {
      const result = decideRemote({ policy: policyFor(), loadPerCore, argv });
      expectDecision(result, false);
      expect(result.reason).toContain('load-unreadable');
    },
  );
});

describe('adaptLegacyRemoteResult', () => {
  it.each([
    'command-not-allowed',
    'invalid-parameters',
    'forge-unreachable',
    'copy-failed',
    'ignored-test-file',
    'invalid-diff-coverage-base',
    'diff-coverage-base-unavailable',
    'coverage-report-not-portable',
    'unsupported-sibling-dependency',
  ])('maps %s to a confirmed non-start only at the adapter boundary', async (reason) => {
    const legacy = { mode: 'fallback', reason };
    const adapted = adaptLegacyRemoteResult(legacy);
    expect(adapted).toEqual({ mode: 'not-started', terminated: true, reason });
    expect(legacy).toEqual({ mode: 'fallback', reason });
    expect(await runWithRemoteDecision(fixture({ result: adapted }))).toEqual({ handled: false });
    expect(await runWithRemoteDecision(fixture({ result: legacy }))).toEqual({ handled: true, exitCode: 124 });
  });

  it.each(['ambiguous-result', 'unknown-reason', 'requires-git-worktree', undefined])('preserves unsafe fallback reason %s and refuses local rerun', async (reason) => {
    const legacy = { mode: 'fallback', reason };
    expect(adaptLegacyRemoteResult(legacy)).toBe(legacy);
    expect(await runWithRemoteDecision(fixture({ result: adaptLegacyRemoteResult(legacy) })))
      .toEqual({ handled: true, exitCode: 124 });
  });

  it('passes remote completion through unchanged', () => {
    const result = { mode: 'remote', code: 23 };
    expect(adaptLegacyRemoteResult(result)).toBe(result);
  });

  it.each([null, undefined, { mode: 'unknown', reason: 'command-not-allowed' }])('passes malformed results through unchanged: %j', (result) => {
    expect(adaptLegacyRemoteResult(result)).toBe(result);
  });

  it('uses the adapter in the default remote executor for an ineligible command', async () => {
    const f = fixture({});
    expect(await runWithRemoteDecision({ ...f, argv: ['node', 'ineligible.mjs'], remoteExec: undefined }))
      .toEqual({ handled: false });
    expectFallback(f.log, 'command-not-allowed');
  });
});

describe('runWithRemoteDecision', () => {
  it('remote is disabled by default even above the load threshold', async () => {
    const f = fixture({ load: 100 });
    expect(await runWithRemoteDecision({ ...f, policy: resolveAdmissionPolicy({}) })).toEqual({ handled: false });
    expect(f.remoteExec).not.toHaveBeenCalled();
    expectLines(f.log, 1, 'local');
    expect(f.log.mock.calls[0][0]).toContain('remote.enabled=false (standard)');
  });

  it.each([
    ['below threshold -> local', {}, 2.9],
    ['at threshold -> local', {}, 3],
    ['disabled -> local', { enabled: false }, 100],
    ['unreadable load -> local', {}, NaN],
  ])('%s without calling remoteExec', async (_name, remote, load) => {
    const f = fixture({ remote, load });
    expect(await runWithRemoteDecision(f)).toEqual({ handled: false });
    expect(f.remoteExec).not.toHaveBeenCalled();
    expectLines(f.log, 1, 'local');
    if (Number.isNaN(load)) expect(f.log.mock.calls[0][0]).toContain('load-unreadable');
  });

  it.each([
    ['above -> remote', {}, 4, 0],
    ['always -> remote', { mode: 'always' }, 0, 0],
    ['nonzero remote code stays handled', {}, 4, 7],
  ])('%s and passes the exact argv and cwd through', async (_name, remote, load, code) => {
    const f = fixture({ remote, load, result: { mode: 'remote', code } });
    const originalArgv = [...f.argv];
    expect(await runWithRemoteDecision(f)).toEqual({ handled: true, exitCode: code });
    expect(f.loadPerCore).toHaveBeenCalledTimes(1);
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expect(f.remoteExec).toHaveBeenCalledWith(expect.objectContaining({ argv: originalArgv, cwd: f.cwd }));
    expect(f.remoteExec.mock.calls[0][0].argv).toBe(f.argv);
    expect(f.argv).toEqual(originalArgv);
    expectLines(f.log, 1, 'remote');
  });

  it.each([0, 254])('accepts remote completion at valid exit boundary %s', async code => {
    expect(await runWithRemoteDecision(fixture({result:{mode:'remote', code}})))
      .toEqual({handled:true, exitCode:code});
  });

  it.each([-1, 255, 999, 1.5, NaN, Infinity, '0', undefined])
  ('refuses local rerun for invalid remote exit code %s', async code => {
    const f = fixture({result:{mode:'remote', code}});
    expect(await runWithRemoteDecision(f)).toEqual({handled:true, exitCode:124});
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('refusing local rerun'));
  });

  it.each([undefined, true])('legacy fallback refuses local rerun even with terminated=%s', async (terminated) => {
    const reason = 'remote receipt unavailable';
    const f = fixture({ result: { mode: 'fallback', reason, terminated } });
    expect(await runWithRemoteDecision(f)).toEqual({ handled: true, exitCode: 124 });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expect(f.log.mock.calls[1][0]).toContain(reason);
    expect(f.log.mock.calls[1][0]).toContain('refusing local rerun');
  });

  it.each(['not-started', 'cancelled'])('%s with terminated=true falls back to local admission', async (mode) => {
    const reason = 'remote termination confirmed';
    const f = fixture({ result: { mode, terminated: true, reason } });
    expect(await runWithRemoteDecision(f)).toEqual({ handled: false });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expectFallback(f.log, reason);
  });

  describe.each(['not-started', 'cancelled'])('%s', (mode) => {
    it.each([undefined, false, 1, 'true'])('without terminated=true refuses local rerun: %s', async (terminated) => {
      const f = fixture({ result: { mode, terminated } });
      expect(await runWithRemoteDecision(f)).toEqual({ handled: true, exitCode: 124 });
      expect(f.remoteExec).toHaveBeenCalledTimes(1);
      expect(f.log.mock.calls[1][0]).toContain('refusing local rerun');
    });
  });

  describe.each(['ssh disconnect', 'invalid receipt', 'run throws', 'finish throws'])('%s', (scenario) => {
    it('ambiguous runRemote receipt refuses local rerun', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'remote-ambiguous-'));
      const files = ['package-lock.json', 'a.test.mjs'];
      writeFileSync(join(cwd, files[0]), '{"lockfileVersion":3,"packages":{}}\n');
      writeFileSync(join(cwd, files[1]), 'fixture');
      let request;
      const actions = [];
      const exec = vi.fn(async (call) => {
        if (call.file === 'git' && call.args.includes('-i')) return { code: 0, stdout: Buffer.alloc(0) };
        if (call.file === 'git' && call.args.includes('--stage')) return { code: 0, stdout: Buffer.alloc(0) };
        if (call.file === 'rsync') return { code: 0, stdout: '' };
        if (call.file === 'ssh') {
          const action = call.args.at(-1).split(' ').at(-1);
          actions.push(action);
          if (action === 'true') return { code: 0, stdout: '' };
          if (action === 'prepare') return { code: 0, stdout: JSON.stringify({ run: 'r-' + JSON.parse(call.input).nonce }) };
          if (action === 'run') {
            request = JSON.parse(call.input);
            if (scenario === 'run throws') throw new Error('run transport lost');
            return { code: scenario === 'ssh disconnect' ? 255 : 0, stdout: '' };
          }
          if (action === 'finish') {
            if (scenario === 'finish throws') throw new Error('finish transport lost');
            if (scenario !== 'invalid receipt') return { code: 255, stdout: '' };
            const { v, nonce, run, inputDigest, argvDigest, lock, manifestDigest } = request;
            // Otherwise valid receipt, but its exit status disagrees with the run.
            return { code: 0, stdout: JSON.stringify({ v, nonce, run, inputDigest, argvDigest, lock, manifestDigest, phase: 'test', code: 7 }) };
          }
        }
        throw new Error(`Unexpected exec call: ${call.file}`);
      });
      const local = vi.fn();
      const log = vi.fn();
      try {
        const result = await runWithRemoteDecision({
          argv: ['npm', 'run', 'test:unit', '--', 'a.test.mjs'], cwd, env: {},
          lockRoot:join(cwd,'heavy'),readTelemetry:healthyRead,
          policy: policyFor({ mode: 'always' }), loadPerCore: () => 0, log,
          remoteExec: (options) => runRemote({ ...options, exec, listFiles: async () => files }),
        });
        if (!result.handled) local();
        expect(actions).toEqual(['true', 'bases', 'prepare', 'run', 'finish']);
        expect(result).toEqual({ handled: true, exitCode: 124 });
        expect(local).not.toHaveBeenCalled();
        expect(log.mock.calls[1][0]).toContain('ambiguous-result');
        expect(log.mock.calls[1][0]).toContain('refusing local rerun');
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
  });

  it('remoteExec throws -> refuses local rerun with the error reason', async () => {
    const f = fixture();
    f.remoteExec.mockRejectedValue(new Error('injected transport failure'));
    expect(await runWithRemoteDecision(f)).toEqual({ handled: true, exitCode: 124 });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expect(f.log.mock.calls[1][0]).toContain('injected transport failure');
    expect(f.log.mock.calls[1][0]).toContain('refusing local rerun');
  });

  it('a remoteExec pending until confirmed cancellation times out and falls back to local admission', async () => {
    const f = fixture();
    f.remoteExec.mockImplementation(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ mode: 'cancelled', terminated: true }), { once: true });
    }));
    expect(await runWithRemoteDecision({ ...f, timeoutMs: 20 })).toEqual({ handled: false });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expectLines(f.log, 2, 'remote');
    expect(f.log.mock.calls[1][0]).toBe('heavy-admission: remote failed (remote-timeout) - falling back to local admission\n');
  });

  it('confirms active remote execution has stopped before local execution starts', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const events = [];
      let active = false;
      let confirmTermination;
      f.remoteExec.mockImplementation(({ signal }) => new Promise((resolve) => {
        active = true;
        events.push('remote started');
        signal.addEventListener('abort', () => events.push('abort requested'), { once: true });
        confirmTermination = () => {
          active = false;
          events.push('remote stopped');
          resolve({ mode: 'cancelled', terminated: true });
        };
      }));
      const local = vi.fn(() => {
        expect(active).toBe(false);
        events.push('local started');
      });
      const pending = runWithRemoteDecision({ ...f, timeoutMs: 20 }).then((result) => {
        if (!result.handled) local();
        return result;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(active).toBe(true);
      expect(events).toEqual(['remote started', 'abort requested']);
      expect(local).not.toHaveBeenCalled();
      confirmTermination();
      expect(await pending).toEqual({ handled: false });
      expect(local).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['remote started', 'abort requested', 'remote stopped', 'local started']);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['never resolves', 'missing acknowledgement', 'false acknowledgement', 'not-started acknowledgement', 'legacy fallback', 'rejection', 'late success'])(
    'refuses a local rerun after timeout when remote termination is uncertain: %s', async (outcome) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        let signal;
        f.remoteExec.mockImplementation((options) => new Promise((resolve, reject) => {
          signal = options.signal;
          signal.addEventListener('abort', () => {
            if (outcome === 'missing acknowledgement') resolve({ mode: 'cancelled' });
            if (outcome === 'false acknowledgement') resolve({ mode: 'cancelled', terminated: false });
            if (outcome === 'not-started acknowledgement') resolve({ mode: 'not-started', terminated: true });
            if (outcome === 'legacy fallback') resolve({ mode: 'fallback', terminated: true });
            if (outcome === 'rejection') reject(new Error('transport closed'));
            if (outcome === 'late success') resolve({ mode: 'remote', code: 0 });
          }, { once: true });
        }));
        const local = vi.fn();
        const pending = runWithRemoteDecision({ ...f, timeoutMs: 20 }).then((result) => {
          if (!result.handled) local();
          return result;
        });
        await vi.advanceTimersByTimeAsync(1020);
        expect(await pending).toEqual({ handled: true, exitCode: 124 });
        expect(signal.aborted).toBe(true);
        expect(local).not.toHaveBeenCalled();
        expectLines(f.log, 2, 'remote');
        expect(f.log.mock.calls[1][0]).toContain('remote-timeout');
        expect(f.log.mock.calls[1][0]).toContain('termination unconfirmed; refusing local rerun');
        expect(f.log.mock.calls[1][0]).toContain('Confirm remote termination before retrying');
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    },
  );

  it.each([
    ['default ceiling without env', undefined, ['npm', 'run', 'build'], DEFAULT_ADMISSION_CEILING_MS],
    ['ceiling from env', { WE_HEAVY_ADMISSION_CEILING_MS: '1234' }, ['npm', 'run', 'build'], 1234],
    ['default fast-run timeout', undefined, ['npx', 'vitest', 'run', 'one.test.mjs'], DEFAULT_FAST_RUN_TIMEOUT_MS],
    ['fast-run timeout from env', { WE_HEAVY_ADMISSION_CEILING_MS: '1234', WE_HEAVY_ADMISSION_FAST_RUN_TIMEOUT_MS: '2345' }, ['npx', 'vitest', 'run', 'one.test.mjs'], 2345],
  ])('uses %s', async (_name, env, commandArgv, expectedMs) => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    try {
      const f = fixture();
      expect(await runWithRemoteDecision({ ...f, env, argv: commandArgv })).toEqual({ handled: true, exitCode: 0 });
      expect(setTimer).toHaveBeenCalledTimes(1);
      expect(setTimer).toHaveBeenCalledWith(expect.any(Function), expectedMs);
    } finally { setTimer.mockRestore(); }
  });

  it.each(['success', 'fallback', 'rejection', 'synchronous throw', 'timeout'])(
    'clears the deadline timer after remote %s', async (outcome) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        if (outcome === 'fallback') f.remoteExec.mockResolvedValue({ mode: 'fallback', reason: 'unavailable' });
        if (outcome === 'rejection') f.remoteExec.mockRejectedValue(new Error('unavailable'));
        if (outcome === 'synchronous throw') f.remoteExec.mockImplementation(() => { throw new Error('unavailable'); });
        if (outcome === 'timeout') f.remoteExec.mockImplementation(() => new Promise(() => {}));
        const pending = runWithRemoteDecision({ ...f, timeoutMs: 20 });
        if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(1020);
        const expected = outcome === 'success' ? { handled: true, exitCode: 0 } : { handled: true, exitCode: 124 };
        expect(await pending).toEqual(expected);
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    },
  );

  it.each([
    { mode: 'remote' },
    { mode: 'remote', code: undefined },
    { mode: 'remote', code: null },
    { mode: 'remote', code: '0' },
    { mode: 'remote', code: NaN },
    { mode: 'remote', code: Infinity },
    { mode: 'remote', code: -Infinity },
    { mode: 'remote', code: 0.5 },
    { mode: 'unknown', code: 0 },
    { code: 0 },
    {}, null, undefined, 0, 'remote',
    { mode: 'uncertain', reason: 'ambiguous-result', terminated: false },
  ].map((result) => [result]))('refuses local rerun on malformed or non-integer remote result %j', async (result) => {
    const f = fixture();
    f.remoteExec.mockResolvedValue(result);
    expect(await runWithRemoteDecision(f)).toEqual({ handled: true, exitCode: 124 });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expectLines(f.log, 2, 'remote');
    expect(f.log.mock.calls[1][0]).toContain('refusing local rerun');
  });
});


it('carries stage timings through legacy pre-execution adaptation without changing the decision', () => {
  const timings=[{stage:'total',startedAtET:'2026-01-01T07:00:00.000-05:00',ms:12}];
  expect(adaptLegacyRemoteResult({mode:'fallback',reason:'copy-failed',timings}))
    .toEqual({mode:'not-started',terminated:true,reason:'copy-failed',timings});
});
