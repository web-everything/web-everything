// @vitest-environment node
// Keep file URLs intact: the browser asset transform rewrites the settings fixture's path.
// Test-first contract: static imports intentionally fail until the module exists.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { autoRouteVerify, decideRoute, resolveRouteSettings, formatRouteLog, ROUTE_DEFAULTS } from '../lib/remote-route.mjs';
import { resolveCascade } from '../lib/policy-cascade.mjs';
import { remoteIO } from '../remote-test.mjs';

// Execute the actual entrypoint's orchestration, from selection through admission,
// with in-memory marker/child IO. No git repository, network or heavy gate is needed.
// Keep the whole contiguous region so moving routing ahead of a short-circuit fails.
const entryPath = join(dirname(fileURLToPath(import.meta.url)), '../verify-lane.mjs');
const entry = readFileSync(entryPath, 'utf8');
const modeDeclaration = entry.slice(entry.indexOf('const MODE ='), entry.indexOf('\n\n', entry.indexOf('const MODE =')));
const dispatchDeclaration = entry.slice(entry.indexOf('const DISPATCHED_RUN ='), entry.indexOf('\n', entry.indexOf('const DISPATCHED_RUN =')));
const orchestration = entry.slice(entry.indexOf('SELECTION = summarizeSelection'), entry.indexOf('// 2. Admission:'))
  .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(entryPath).href));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function entryFixture({ command, flags = {}, selected = 'related', cached = false, remoteCode = 0, readySha,
  platform, tool, toolText, env = { WE_REMOTE_ROUTE_LOAD_CAP: '0' }, live } = {}) {
  const sha = 'a'.repeat(40);
  const exit = code => { throw { fixtureExit: true, code }; };
  const emit = vi.fn((result, code) => { throw { fixtureExit: true, code, result }; });
  const remote = vi.fn().mockResolvedValue(remoteCode);
  const queue = vi.fn().mockReturnValue(JSON.stringify({ projectedWaitMinutes: 99, heavyWaitMinutes: 99 }));
  const readiness = vi.fn(() => ({ sha: readySha ?? sha, ref: 'lane/pushed-head' }));
  const writeMarker = vi.fn();
  const stderr = vi.fn();
  const localGate = vi.fn();
  const platformPreference = vi.fn(key => key === 'remoteRoute' ? platform : undefined);
  const readTool = vi.fn((path, encoding) => {
    if (path.href !== new URL('../settings/remote-route.json', import.meta.url).href || encoding !== 'utf8' || (tool === undefined && toolText === undefined)) {
      throw new Error('no tool/lease override');
    }
    return toolText ?? JSON.stringify(tool);
  });
  const bindings = {
    flags, positionals: command ? [command] : [],
    SELECTION: null, summarizeSelection: () => ({}), selectionNotice: () => 'selection',
    resolvedGate: { command: 'selected gate', decision: { mode: selected } }, GATE: 'selected gate',
    headSha: sha, REPO: '/fixture', GIT_DIR: '/fixture/markers', AS_JSON: false,
    process: { env, execPath: 'node', stderr: { write: stderr }, exit },
    readFileSync: readTool, URL,
    resolveCascade, platformPreference, ROUTE_DEFAULTS, resolveRouteSettings, autoRouteVerify,
    execFileSync: queue, loadavg: () => [99], remoteIO: () => live ?? ({ ready: readiness }), runRemoteCLI: remote,
    readMarker: () => cached ? { status: 'green', sha, treeHash: 'tree', suites: 'selected gate', executedGate: 'selected gate' } : null,
    treeHashNow: () => 'tree', describeIsolatedRetry: () => '', markerRedCause: () => ({}), emit,
    join, VERIFY_PREVIOUS_FILENAME: 'previous', LEASE_FILENAME: 'lease', writeFileSync: vi.fn(),
    git: vi.fn(), redFirstWarning: () => null, writeMarker, maybeRecordGreen: vi.fn(),
    verifyStartBody: body => body, verifyFinishBody: (body, finish) => ({ ...body, ...finish }),
    RUNNER_LOCK_ROOT: '/fixture/locks', VERIFY_DAEMON_LEASE_KEY: 'verify', runnerLeaseStatus: () => ({}),
    readLockEntry: () => null, probeRunnerLeaseLiveness: () => ({}), verifyServerVerdict: () => ({ alive: true }),
    localGate,
  };
  let outcome;
  try {
    await new AsyncFunction(...Object.keys(bindings), `${modeDeclaration}\n${dispatchDeclaration}\n${orchestration}\nlocalGate();`)(...Object.values(bindings));
  } catch (error) {
    if (!error.fixtureExit) throw error;
    outcome = error;
  }
  return { outcome, remote, queue, readiness, writeMarker, stderr, localGate, platformPreference, readTool };
}

describe('verify-lane entrypoint auto-routing wiring', () => {
  it('does not dispatch a non-main tree despite high queue wait and load', async () => {
    const sha = 'a'.repeat(40);
    const execFile = vi.fn((_file, args) => {
      if (args.includes('get-url')) return 'https://github.com/web-everything/web-everything.git';
      if (args.includes('status')) return '';
      if (args.includes('rev-parse')) return sha;
      if (args.includes('ls-remote')) return `${sha}\trefs/heads/lane/changed`;
      throw new Error('unexpected git command');
    });
    const execGh = vi.fn((_file, args) => {
      if (args[0] === 'auth') return '';
      if (args.at(-1) === `repos/web-everything/web-everything/commits/${sha}`) {
        return JSON.stringify({ sha, commit: { tree: { sha: 'b'.repeat(40) } } });
      }
      if (args.at(-1) === 'repos/web-everything/web-everything/commits/main') {
        return JSON.stringify({ sha: 'c'.repeat(40), commit: { tree: { sha: 'd'.repeat(40) } } });
      }
      throw new Error('unexpected GitHub command');
    });
    const io = await entryFixture({ live: remoteIO('.', { env: {}, execFile, execGh }) });
    expect(io.queue).toHaveBeenCalledOnce();
    expect(io.remote).not.toHaveBeenCalled();
    expect(io.localGate).toHaveBeenCalledOnce();
    expect(execGh.mock.calls.some(([, args]) => args[0] === 'workflow')).toBe(false);
    expect(execGh).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', 'repos/web-everything/web-everything/commits/main'], expect.any(Object));
  });

  it.each([
    ['standard', {}, { thresholdMinutes: 10, loadCap: 36, enabled: true }],
    ['platform', { platform: { thresholdMinutes: 150, loadCap: 160, enabled: false } }, { thresholdMinutes: 150, loadCap: 160, enabled: false }],
    ['tool', { platform: { thresholdMinutes: 150, loadCap: 160, enabled: false }, tool: { thresholdMinutes: 200, loadCap: 210, enabled: true } },
      { thresholdMinutes: 200, loadCap: 210, enabled: true }],
    ['environment', { platform: { thresholdMinutes: 150, loadCap: 160, enabled: false }, tool: { thresholdMinutes: 200, loadCap: 210, enabled: false },
      env: { WE_REMOTE_ROUTE_THRESHOLD_MINUTES: '1', WE_REMOTE_ROUTE_LOAD_CAP: '2', WE_REMOTE_ROUTE: 'on' } },
      { thresholdMinutes: 1, loadCap: 2, enabled: true }],
  ])('uses the %s cascade layer and logs its effective values and provenance', async (source, overrides, values) => {
    const io = await entryFixture({ env: {}, ...overrides });
    const log = io.stderr.mock.calls.flat().join('');
    for (const [key, value] of Object.entries(values)) expect(log).toContain(`${key}=${value} (${source})`);
    expect(io.platformPreference).toHaveBeenCalledWith('remoteRoute');
    expect(io.readTool).toHaveBeenCalledWith(new URL('../settings/remote-route.json', import.meta.url), 'utf8');
    if (source === 'platform' || source === 'tool') {
      expect(io.remote).not.toHaveBeenCalled();
      expect(io.localGate).toHaveBeenCalledOnce();
    } else expect(io.remote).toHaveBeenCalledOnce();
  });

  it.each(['platform', 'tool'])('rejects invalid %s values through the entrypoint predicates', async layer => {
    for (const bad of [-1, '12', null, Infinity, NaN]) {
      const io = await entryFixture({ env: {}, platform: { thresholdMinutes: 150, loadCap: 160, enabled: false },
        [layer]: { thresholdMinutes: bad, loadCap: bad, enabled: 'true' } });
      const source = layer === 'tool' ? 'platform' : 'standard';
      const expected = layer === 'tool' ? { thresholdMinutes: 150, loadCap: 160, enabled: false }
        : { thresholdMinutes: 10, loadCap: 36, enabled: true };
      for (const [key, value] of Object.entries(expected)) {
        expect(io.stderr.mock.calls.flat().join('')).toContain(`${key}=${value} (${source})`);
      }
    }
  });

  it.each(['{broken JSON', '{"thresholdMinutes":1e999,"loadCap":1e999,"enabled":"true"}'])
    ('retains platform values when tool JSON is malformed or overflows: %s', async toolText => {
      const io = await entryFixture({ env: {}, platform: { thresholdMinutes: 150, loadCap: 160, enabled: false }, toolText });
      const log = io.stderr.mock.calls.flat().join('');
      expect(log).toContain('thresholdMinutes=150 (platform)');
      expect(log).toContain('loadCap=160 (platform)');
      expect(log).toContain('enabled=false (platform)');
      expect(io.remote).not.toHaveBeenCalled();
    });

  it.each([
    { cached: true, reason: 'cached' },
    { selected: 'card-only-skip', reason: 'card-only-skip' },
  ])('returns $reason before routing despite forced remote load', async options => {
    const io = await entryFixture(options);
    expect(io.outcome).toMatchObject({ code: 0, result: { reason: options.reason } });
    expect(io.queue).not.toHaveBeenCalled();
    expect(io.readiness).not.toHaveBeenCalled();
    expect(io.remote).not.toHaveBeenCalled();
    expect(io.localGate).not.toHaveBeenCalled();
  });
  it.each([
    { flags: { gate: 'custom' } }, { flags: { gate: true } }, { flags: { 'dry-run': true } },
    { flags: { 'run-id': 'dispatch-123' } },
    ...['request', 'run', 'check', 'reset', 'remote'].map(command => ({ command })),
  ])('auto-routes only plain verify: excludes %j', async options => {
    const io = await entryFixture(options);
    expect(io.queue).not.toHaveBeenCalled();
    expect(io.readiness).not.toHaveBeenCalled();
    expect(io.remote).not.toHaveBeenCalled();
    expect(io.stderr.mock.calls.flat().join('')).not.toContain('verify-lane route:');
    if (options.flags?.gate || options.flags?.['run-id'] || options.command === 'run') {
      expect(io.localGate).toHaveBeenCalledOnce();
    }
    if (options.flags?.['run-id']) expect(io.writeMarker).toHaveBeenCalledWith(expect.objectContaining({ runId: 'dispatch-123' }));
  });
  it.each([['related', 'lane-check'], ['full', 'full']])('maps %s to %s and exits only after remote success', async (selected, mode) => {
    const io = await entryFixture({ selected });
    expect(io.remote).toHaveBeenCalledWith({ ref: 'lane/pushed-head', mode }, expect.objectContaining({ quietFailure: true }));
    expect(io.outcome).toMatchObject({ code: 0 });
    expect(io.localGate).not.toHaveBeenCalled();
    expect(io.writeMarker).not.toHaveBeenCalled();
  });
  it.each([2, 3, null])('continues to the local gate after remote failure %s', async remoteCode => {
    const io = await entryFixture({ remoteCode });
    expect(io.localGate).toHaveBeenCalledOnce();
    expect(io.writeMarker).toHaveBeenCalledOnce();
    expect(io.outcome).toBeUndefined();
  });
  it('falls back locally when HEAD changes during readiness', async () => {
    const io = await entryFixture({ readySha: 'b'.repeat(40) });
    expect(io.remote).not.toHaveBeenCalled();
    expect(io.localGate).toHaveBeenCalledOnce();
  });
});

const local = {
  projectedWaitMinutes: 1, heavyWaitMinutes: 1, load1: 2, loadCap: 36,
  thresholdMinutes: 10, remoteReady: true, mode: 'lane-check',
};

describe('autoRouteVerify local fallback', () => {
  function fixture(changes = {}) {
    return { settings: resolveRouteSettings({}, {}), mode: 'lane-check', eligible: true,
      readQueue: vi.fn().mockResolvedValue({ projectedWaitMinutes: 20, heavyWaitMinutes: 20 }),
      readLoad: vi.fn().mockReturnValue(2), readiness: vi.fn().mockResolvedValue({ ref: 'lane/pushed-head' }),
      remote: vi.fn().mockResolvedValue(0), log: vi.fn(), ...changes };
  }
  it('dispatches the pushed ref and skips the local gate only on remote success', async () => {
    const io = fixture();
    expect(await autoRouteVerify(io)).toBe(true);
    expect(io.remote).toHaveBeenCalledTimes(1);
    expect(io.remote).toHaveBeenCalledWith({ ref: 'lane/pushed-head', mode: 'lane-check' });
    expect(io.log.mock.calls.filter(([line]) => line.startsWith('verify-lane route:'))).toHaveLength(1);
  });
  it.each([2, 3, undefined])('retains the local gate on remote exit %s', async code => {
    const io = fixture({ remote: vi.fn().mockResolvedValue(code) });
    expect(await autoRouteVerify(io)).toBe(false);
    expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/falling back to the local gate/));
    expect(io.log.mock.calls.filter(([line]) => line.startsWith('verify-lane route:'))).toHaveLength(1);
  });
  it('retains the local gate if remote execution throws', async () => {
    const io = fixture({ remote: vi.fn().mockRejectedValue(new Error('unavailable')) });
    expect(await autoRouteVerify(io)).toBe(false);
    expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/falling back/));
  });
  it.each(['readQueue', 'readLoad', 'readiness'])('retains the local gate if %s is unavailable', async stage => {
    const io = fixture({ [stage]: vi.fn().mockRejectedValue(new Error('unavailable')) });
    expect(await autoRouteVerify(io)).toBe(false);
    expect(io.remote).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledTimes(1);
    expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/^verify-lane route: local —/));
  });
  it('does not dispatch on incomplete queue evidence despite high load', async () => {
    const io = fixture({ readQueue: vi.fn().mockResolvedValue({}), readLoad: vi.fn().mockReturnValue(99) });
    expect(await autoRouteVerify(io)).toBe(false);
    expect(io.remote).not.toHaveBeenCalled();
  });
  it.each([{ eligible: false }, { eligible: undefined }, { eligible: 'true' }, { settings: resolveRouteSettings({ WE_REMOTE_ROUTE: 'off' }) }])
    ('does not probe or dispatch when routing is disabled or a custom gate is requested', async changes => {
      const io = fixture(changes);
      expect(await autoRouteVerify(io)).toBe(false);
      for (const key of ['readQueue', 'readLoad', 'readiness', 'remote']) expect(io[key]).not.toHaveBeenCalled();
      expect(io.log).toHaveBeenCalledTimes(1);
      expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/^verify-lane route: local —/));
    });
});

describe('decideRoute', () => {
  it('keeps tiny runs local and explains why', () => {
    expect(decideRoute(local)).toEqual({ path: 'local', reason: 'tiny runs are faster locally' });
  });

  it('routes remotely when projected wait exceeds the threshold', () => {
    expect(decideRoute({ ...local, projectedWaitMinutes: 10.01 })).toEqual({
      path: 'remote', reason: expect.stringMatching(/wait|threshold/i),
    });
  });

  it('routes remotely when load exceeds its cap even with a tiny wait', () => {
    expect(decideRoute({ ...local, load1: 36.01 })).toEqual({
      path: 'remote', reason: expect.stringMatching(/load/i),
    });
  });

  it('uses strict greater-than for both boundaries', () => {
    expect(decideRoute({ ...local, projectedWaitMinutes: 10, load1: 36 }).path).toBe('local');
  });

  it('uses heavy wait instead of projected wait for full mode', () => {
    expect(decideRoute({ ...local, mode: 'full', heavyWaitMinutes: 11 }).path).toBe('remote');
    expect(decideRoute({ ...local, mode: 'full', projectedWaitMinutes: 99 }).path).toBe('local');
    expect(decideRoute({ ...local, mode: 'full', heavyWaitMinutes: 10 }).path).toBe('local');
  });

  it.each(['lane-check', 'targeted'])('uses projected wait in %s mode', (mode) => {
    expect(decideRoute({ ...local, mode, projectedWaitMinutes: 11 }).path).toBe('remote');
    expect(decideRoute({ ...local, mode, heavyWaitMinutes: 99 }).path).toBe('local');
  });

  it('fails closed when remoteReady is false, even under high wait and load', () => {
    const decision = decideRoute({ ...local, remoteReady: false, projectedWaitMinutes: 99, load1: 99 });
    expect(decision.path).toBe('local');
    expect(decision.reason).toMatch(/not ready|unavailable|not pushed|dirty|gh|ref/i);
  });

  // Boolean readiness cannot carry a particular failed prerequisite. The structured
  // form preserves the caller's diagnosis without rerunning git/gh in this pure helper.
  it.each([
    'HEAD not pushed', 'working tree dirty', 'no gh executable', 'targeted-with-no-ref',
  ])('preserves the remote readiness blocker: %s', (reason) => {
    const decision = decideRoute({ ...local, remoteReady: { ready: false, reason },
      projectedWaitMinutes: 99, load1: 99 });
    expect(decision).toEqual({ path: 'local', reason: expect.stringContaining(reason) });
  });

  it('refuses targeted-with-no-ref even if the caller reports readiness', () => {
    const decision = decideRoute({ ...local, mode: 'targeted-with-no-ref', projectedWaitMinutes: 99 });
    expect(decision.path).toBe('local');
    expect(decision.reason).toMatch(/ref/i);
  });

  for (const field of ['projectedWaitMinutes', 'heavyWaitMinutes', 'load1', 'loadCap', 'thresholdMinutes']) {
    it.each([NaN, Infinity, -Infinity, -1, undefined, null, '11', 'bad'])
      (`fails closed to local for invalid ${field}=%s despite another remote trigger`, (value) => {
        const decision = decideRoute({ ...local, mode: 'full', projectedWaitMinutes: 99,
          heavyWaitMinutes: 99, load1: 99, [field]: value });
        expect(decision.path).toBe('local');
        expect(decision.reason).toMatch(/invalid|finite|missing|unavailable/i);
      });
  }

  it.each([undefined, null, 'true', {}])('fails closed for unknown readiness %s', (remoteReady) => {
    expect(decideRoute({ ...local, remoteReady, load1: 99 }).path).toBe('local');
  });

  it('fails closed for an unknown mode', () => {
    expect(decideRoute({ ...local, mode: 'mystery', load1: 99 }).path).toBe('local');
  });
});

describe('resolveRouteSettings', () => {
  // `source` is a per-setting map. cascadeDefaults carries effective values and
  // their provenance from the shared standard → platform → tool cascade.
  it('reports standard defaults and a source for every setting', () => {
    expect(resolveRouteSettings({}, {})).toEqual({
      thresholdMinutes: 10, loadCap: 36, enabled: true,
      source: { thresholdMinutes: 'standard', loadCap: 'standard', enabled: 'standard' },
    });
  });

  it.each(['platform', 'tool'])('preserves values and provenance from the %s layer', (layer) => {
    const cascade = { thresholdMinutes: 15, loadCap: 24, enabled: false,
      source: { thresholdMinutes: layer, loadCap: layer, enabled: layer } };
    expect(resolveRouteSettings({}, cascade)).toEqual(cascade);
  });

  it('applies environment overrides independently and records their sources', () => {
    const cascade = { thresholdMinutes: 15, loadCap: 24, enabled: true,
      source: { thresholdMinutes: 'tool', loadCap: 'platform', enabled: 'standard' } };
    expect(resolveRouteSettings({ WE_REMOTE_ROUTE_THRESHOLD_MINUTES: '2.5',
      WE_REMOTE_ROUTE_LOAD_CAP: '12', WE_REMOTE_ROUTE: 'off' }, cascade)).toEqual({
      thresholdMinutes: 2.5, loadCap: 12, enabled: false,
      source: { thresholdMinutes: 'environment', loadCap: 'environment', enabled: 'environment' },
    });
    expect(resolveRouteSettings({ WE_REMOTE_ROUTE_LOAD_CAP: '12' }, cascade)).toEqual({
      ...cascade, loadCap: 12, source: { ...cascade.source, loadCap: 'environment' },
    });
  });

  it.each(['NaN', 'Infinity', '-1', '12oops', '1e999'])
    ('falls back visibly to standard bounds for invalid env values %s', (value) => {
      const settings = resolveRouteSettings({ WE_REMOTE_ROUTE_THRESHOLD_MINUTES: value,
        WE_REMOTE_ROUTE_LOAD_CAP: value }, { thresholdMinutes: 15, loadCap: 24,
          source: { thresholdMinutes: 'platform', loadCap: 'tool' } });
      expect(settings.thresholdMinutes).toBe(10);
      expect(settings.loadCap).toBe(36);
      expect(settings.source.thresholdMinutes).toBe('standard (invalid environment fallback)');
      expect(settings.source.loadCap).toBe('standard (invalid environment fallback)');
    });

  it('treats empty environment values as unset', () => {
    expect(resolveRouteSettings({ WE_REMOTE_ROUTE_THRESHOLD_MINUTES: '', WE_REMOTE_ROUTE_LOAD_CAP: '',
      WE_REMOTE_ROUTE: '' }, {})).toEqual(resolveRouteSettings({}, {}));
  });

  it('disables remote routing for an unknown enable setting', () => {
    const settings = resolveRouteSettings({ WE_REMOTE_ROUTE: 'mystery' });
    expect(settings.enabled).toBe(false);
    expect(settings.source.enabled).toContain('invalid environment fallback');
  });
});

describe('formatRouteLog', () => {
  it.each(['local', 'remote'])('logs %s, its reason, effective settings and each source on one line', (path) => {
    const settings = { thresholdMinutes: 10, loadCap: 36, enabled: true,
      source: { thresholdMinutes: 'standard', loadCap: 'tool', enabled: 'environment' } };
    const log = formatRouteLog({ path, reason: 'observed routing reason' }, settings);
    expect(typeof log).toBe('string');
    for (const text of [path, 'observed routing reason', '10', '36', 'true', 'standard', 'tool', 'environment']) {
      expect(log).toContain(text);
    }
    expect(log).not.toMatch(/[\r\n]/);
  });

  it('strips terminal controls and line breaks from diagnostic text', () => {
    const log = formatRouteLog({ path: 'local', reason: 'dirty\nHEAD\r\u001b[31m' }, resolveRouteSettings({}, {}));
    expect(log).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(log).toMatch(/dirty/);
  });
});
