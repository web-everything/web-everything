// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readStrictOverride, resolveCapacityLeaf } from '../capacity-leaf.mjs';
import { createCiHealReserve, resolveCiHealReserve } from '../ci-heal-reserve.mjs';
import { resolveMaxConcurrentLanes } from '../lane-concurrency.mjs';
import { capacityPolicyLeaves, readOperatorPolicy } from '../policy-cascade.mjs';
import { writeOperatorOverride } from '../operator-override-store.mjs';

const pathProbe = vi.hoisted(() => ({ throws: false }));
vi.mock('node:os', async original => {
  const actual = await original();
  return { ...actual, userInfo: (...args) => {
    if (pathProbe.throws) throw Error('account database unavailable');
    return actual.userInfo(...args);
  } };
});

const dir = mkdtempSync(join(tmpdir(), 'capacity-leaf-'));
let sequence = 0;
const file = raw => {
  const path = join(dir, `store-${sequence++}.json`);
  writeFileSync(path, raw);
  return path;
};
beforeEach(() => { pathProbe.throws = false; });
afterEach(() => { pathProbe.throws = false; vi.unstubAllEnvs(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const leaves = [
  { key: 'ciHeal.reserve', lower: 3, ceiling: 12, fallback: 2 },
  { key: 'lanes.maxConcurrent', lower: 8, ceiling: 24, fallback: 8 },
];
const liveStore = {
  'reviewConcurrency.maxLiveReviewRounds': 3, 'host.maxReviewDispatchPerTick': 2,
  'fix.conflictFixesPerPass': 4, 'resourceGate.fixCap.floor': 2,
  'resourceGate.fixCap.ceiling': 6, 'redTeamQueue.minConcurrent': 0,
};

it.each(['FIFO', 'directory', 'symlink to regular file', 'symlink to FIFO'])(
  'refuses a real %s without blocking and retains the lower layer', kind => {
    const target = join(dir, `unsafe-${sequence++}`);
    let path = target;
    if (kind.includes('FIFO')) {
      const made = spawnSync('mkfifo', [target], { timeout: 2000, maxBuffer: 4096 });
      expect(made.error).toBeUndefined();
      expect(made.status).toBe(0);
    } else if (kind === 'directory') mkdirSync(target);
    else writeFileSync(target, '{"ciHeal.reserve":6}');
    if (kind.startsWith('symlink')) {
      path = `${target}.link`;
      symlinkSync(target, path);
    }
    // A parent-side timeout can kill a blocked synchronous FIFO read; a Vitest timer cannot.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readStrictOverride, resolveCapacityLeaf } from ${JSON.stringify(new URL('../capacity-leaf.mjs', import.meta.url).href)};
      const file = process.argv[1];
      console.log(JSON.stringify({ strict: readStrictOverride('ciHeal.reserve', { file }),
        resolved: resolveCapacityLeaf('ciHeal.reserve', { file, lower: 3 }) }));
    `, path], { encoding: 'utf8', timeout: 2000, maxBuffer: 4096 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const { strict, resolved } = JSON.parse(result.stdout);
    expect(strict).toMatchObject({ ok: false, reason: expect.any(String) });
    expect(resolved).toEqual({ value: 3, source: 'lower', reason: strict.reason });
  }, 6000);

it('accepts exactly 64 KiB but refuses an oversized regular file with a lower-layer fallback', () => {
  const raw = '{"ciHeal.reserve":6}';
  const path = file(raw.padEnd(64 * 1024, ' '));
  expect(readStrictOverride('ciHeal.reserve', { file: path })).toEqual({ ok: true, value: 6 });
  writeFileSync(path, raw.padEnd(64 * 1024 + 1, ' '));
  expect(readStrictOverride('ciHeal.reserve', { file: path })).toEqual({ ok: false, reason: 'too-large' });
  expect(resolveCapacityLeaf('ciHeal.reserve', { file: path, lower: 3 }))
    .toEqual({ value: 3, source: 'lower', reason: 'too-large' });
});

it.each(['non-regular fd', 'oversized fd', 'growth after fstat', 'read failure', 'short reads'])(
  'checks the opened fd, bounds reads and closes it: %s', scenario => {
    const path = file('{"ciHeal.reserve":6}');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { readStrictOverride } from ${JSON.stringify(new URL('../capacity-leaf.mjs', import.meta.url).href)};
      const [file, scenario] = process.argv.slice(1);
      const original = { fstat: fs.fstatSync, read: fs.readSync, close: fs.closeSync };
      const counts = { fstat: 0, read: 0, close: 0, bytes: 0 };
      fs.fstatSync = (...args) => {
        counts.fstat++;
        const stat = original.fstat(...args);
        if (scenario === 'non-regular fd') stat.isFile = () => false;
        if (scenario === 'oversized fd') stat.size = 65537;
        if (scenario === 'growth after fstat') fs.appendFileSync(file, ' '.repeat(65536));
        return stat;
      };
      fs.readSync = (fd, buffer, offset, length, position) => {
        counts.read++;
        if (scenario === 'read failure') throw Error('read failed');
        const bytes = original.read(fd, buffer, offset, scenario === 'short reads' ? Math.min(length, 3) : length, position);
        counts.bytes += bytes;
        return bytes;
      };
      fs.closeSync = (...args) => { counts.close++; return original.close(...args); };
      syncBuiltinESMExports();
      const strict = readStrictOverride('ciHeal.reserve', { file });
      console.log(JSON.stringify({ strict, counts }));
    `, path, scenario], { encoding: 'utf8', timeout: 2000, maxBuffer: 4096 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const { strict, counts } = JSON.parse(result.stdout);
    expect(counts.fstat).toBe(1);
    expect(counts.close).toBe(1);
    expect(counts.bytes).toBeLessThanOrEqual(65537);
    if (scenario === 'short reads') {
      expect(counts.read).toBeGreaterThan(1);
      expect(strict).toEqual({ ok: true, value: 6 });
    } else {
      expect(strict).toMatchObject({ ok: false, reason: expect.any(String) });
      if (scenario === 'growth after fstat') {
        expect(strict.reason).toBe('too-large');
        expect(counts.bytes).toBe(65537);
      } else if (scenario !== 'read failure') expect(counts.read).toBe(0);
    }
  });

describe('platform capacity lower bounds', () => {
  it.each([
    ['lanes.maxConcurrent', { lanes: { maxConcurrent: 2 } }, 8, 2],
    ['lanes.maxConcurrent', { lanes: { maxConcurrent: 2 } }, 20, 2],
    ['ciHeal.reserve', { ciHeal: { reserve: 0 } }, 2, 0],
    ['ciHeal.reserve', { ciHeal: { reserve: 1 } }, 2, 1],
    ['ciHeal.reserve', { ciHeal: { reserve: 4 } }, 0, 0],
  ])('retains the restrictive platform or environment bound for %s with preferences %j and lower %s', (key, prefs, lower, expected) => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: file(JSON.stringify(prefs)) };
    expect(resolveCapacityLeaf(key, { lower, env, file: file('{}') }))
      .toMatchObject({ value: expected, source: 'lower' });
    expect(resolveCapacityLeaf(key, { lower, env, file: file('{ broken') }))
      .toMatchObject({ value: expected, source: 'lower' });
  });

  it.each([
    ['lanes.maxConcurrent', { lanes: { maxConcurrent: 0 } }, 8],
    ['lanes.maxConcurrent', { lanes: { maxConcurrent: '2' } }, 8],
    ['ciHeal.reserve', { ciHeal: { reserve: -1 } }, 2],
    ['ciHeal.reserve', { ciHeal: 0 }, 2],
  ])('ignores invalid platform evidence for %s', (key, prefs, lower) => {
    expect(resolveCapacityLeaf(key, { lower, file: file('{}'),
      env: { WE_PLATFORM_PREFERENCES_FILE: file(JSON.stringify(prefs)) } }))
      .toMatchObject({ value: lower, source: 'lower' });
  });

  it.each(leaves)('a valid operator override still beats a restrictive platform bound for $key', ({ key, lower }) => {
    const prefs = { lanes: { maxConcurrent: 2 }, ciHeal: { reserve: 0 } };
    expect(resolveCapacityLeaf(key, { lower, file: file(JSON.stringify({ [key]: 6 })),
      env: { WE_PLATFORM_PREFERENCES_FILE: file(JSON.stringify(prefs)) } }))
      .toMatchObject({ value: 6, source: 'operator-db' });
  });

  it('platform ciHeal.reserve=0 admits no reserved heals and resolves only once per pass', () => {
    const preferences = file('{"ciHeal":{"reserve":0}}');
    const env = { WE_PLATFORM_PREFERENCES_FILE: preferences };
    const store = file('{}');
    const gate = vi.fn(() => ({ admit: true }));
    const resolveReserve = vi.fn(() => resolveCapacityLeaf('ciHeal.reserve', {
      lower: resolveCiHealReserve({ env }), env, file: store,
    }).value);
    const reserve = createCiHealReserve({ env, gate, resolveReserve });
    expect(reserve.tryAdmit()).toMatchObject({ admit: false, kind: 'fix-cap' });
    writeFileSync(preferences, '{"ciHeal":{"reserve":2}}');
    expect(reserve.tryAdmit()).toMatchObject({ admit: false, kind: 'fix-cap' });
    expect(resolveReserve).toHaveBeenCalledTimes(1);
    expect(gate).not.toHaveBeenCalled();
    const nextPass = createCiHealReserve({ env, gate, resolveReserve });
    expect(nextPass.tryAdmit()).toMatchObject({ admit: true, reserved: true });
    expect(resolveReserve).toHaveBeenCalledTimes(2);
  });

  it('logs a restrictive platform bound and its provenance', () => {
    const log = vi.fn();
    const env = { WE_PLATFORM_PREFERENCES_FILE: file('{"lanes":{"maxConcurrent":2}}'), WE_POLICY_CASCADE_LOG: '1' };
    expect(resolveCapacityLeaf('lanes.maxConcurrent', { env, lower: 8, file: file('{}'), log }).value).toBe(2);
    expect(log.mock.calls.flat().join(' ')).toMatch(/platform.*2/);
  });
});

describe.each(leaves)('$key strict whole-store negatives', ({ key, lower, ceiling, fallback }) => {
  const negatives = [
    ['absent', () => ({ file: join(dir, 'absent.json') }), 'absent'],
    ['EACCES', () => ({ readFile: () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); } }), 'unreadable'],
    ['directory', () => ({ file: dir }), 'unreadable'],
    ['non-Error read failure', () => ({ readFile: () => { throw null; } }), 'unreadable'],
    ['path resolution failure', () => { pathProbe.throws = true; return {}; }, 'error'],
    ...[
      ['empty', ''], ['whitespace', ' \n\t'], ['invalid JSON', 'no'], ['truncated', '{"x":'],
      ['BOM', '\uFEFF{}'], ['array', '[]'], ['null root', 'null'], ['number root', '5'], ['string root', '"x"'],
      ['duplicate same', `{"${key}":1,"${key}":1}`],
      ['duplicate ascending', `{"${key}":1,"${key}":24}`],
      ['duplicate descending', `{"${key}":24,"${key}":1}`],
      ['escaped duplicate', `{"${key}":1,"${key.replace('.', '\\u002e')}":1}`],
      ['empty nested root', '{"":{"lanes.maxConcurrent":24}}'],
      ['empty key sibling', `{"":24,"${key}":6}`],
      ['nested lanes', '{"lanes":{"maxConcurrent":24}}'], ['bare lanes', '{"lanes":24}'],
      ['unknown lanes sibling', `{"${key}":6,"lanes.unknown":1}`],
      ['unknown host sibling', `{"${key}":6,"host.foo":1}`],
      ['nested existing policy sibling', `{"${key}":6,"reviewConcurrency":{"maxLiveReviewRounds":1}}`],
      ['invalid known sibling', `{"${key}":6,"resourceGate.fixCap.floor":0}`],
      ['prototype key', `{"${key}":6,"__proto__":1}`],
      ['constructor key', `{"${key}":6,"constructor":1}`],
      ['6000 levels', '{"a":'.repeat(6000) + '1' + '}'.repeat(6000)],
      ['over 64 KiB', JSON.stringify({ [key]: 6 }) + ' '.repeat(65536)],
      ['over 64 KiB in UTF-8 bytes', JSON.stringify({ [key]: 6, ['é'.repeat(33000)]: 1 })],
      ...['"6"', '6.5', '-1', 'true', 'null', '1e400', ...(key === 'ciHeal.reserve' ? ['13'] : ['0', '25'])]
        .map(raw => [`leaf value ${raw}`, `{"${key}":${raw}}`]),
    ].map(([name, raw]) => [name, () => ({ file: file(raw) })]),
  ];

  it.each(negatives)('falls back without throwing: %s', (_name, options, reason) => {
    const io = options();
    const strict = readStrictOverride(key, io);
    expect(strict).toMatchObject({ ok: false, reason: reason ?? expect.any(String) });
    const result = resolveCapacityLeaf(key, { lower, ...io });
    expect(result).toMatchObject({ value: Math.min(lower, ceiling), source: 'lower', reason: strict.reason });
  });

  it.each([undefined, NaN, Infinity, '6', 2.5])('uses the registered fallback for noninteger lower %s', lower => {
    expect(resolveCapacityLeaf(key, { lower, file: join(dir, 'absent.json') }))
      .toMatchObject({ value: fallback, source: 'lower', reason: 'absent' });
  });

  it('bounds an oversized lower value', () => {
    expect(resolveCapacityLeaf(key, { lower: 99, file: file('{}') })).toMatchObject({ value: ceiling, source: 'lower' });
  });

  it('returns not-set for a valid store without this leaf', () => {
    expect(readStrictOverride(key, { file: file(JSON.stringify(liveStore)) })).toEqual({ ok: false, reason: 'not-set' });
  });

  it('uses the injected readFile seam for a valid store', () => {
    const readFile = vi.fn(() => JSON.stringify({ [key]: 6 }));
    expect(readStrictOverride(key, { file: 'fixture.json', readFile })).toEqual({ ok: true, value: 6 });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith('fixture.json', 'utf8');
  });
});

it.each([
  ['ciHeal.reserve', '0', 0], ['ciHeal.reserve', 'x', 2], ['ciHeal.reserve', '2.5', 2],
  ['ciHeal.reserve', '-1', 2], ['ciHeal.reserve', '20', 12],
  ['lanes.maxConcurrent', '8.9', 8], ['lanes.maxConcurrent', '0', 8],
  ['lanes.maxConcurrent', 'abc', 8], ['lanes.maxConcurrent', '30', 24],
])('preserves lower parser semantics: %s env %s → %s', (key, raw, expected) => {
  const lower = key === 'ciHeal.reserve' ? resolveCiHealReserve({ env: { WE_CI_HEAL_RESERVE: raw } })
    : resolveMaxConcurrentLanes({ WE_MAX_CONCURRENT_LANES: raw });
  expect(resolveCapacityLeaf(key, { lower, file: join(dir, 'absent.json') }))
    .toMatchObject({ value: expected, source: 'lower' });
});

it.each([
  ['ciHeal.reserve', 6, 3], ['ciHeal.reserve', 0, 3], ['lanes.maxConcurrent', 1, 8],
])('accepts live-shaped store: %s=%s', (key, value, lower) => {
  expect(resolveCapacityLeaf(key, { lower, file: file(JSON.stringify({ ...liveStore, [key]: value })) }))
    .toMatchObject({ value, source: 'operator-db' });
});

it.each(leaves)('$key re-reads every call, including clear', ({ key, lower }) => {
  const path = file(JSON.stringify({ [key]: 6 }));
  const resolve = () => resolveCapacityLeaf(key, { lower, file: path });
  expect(resolve()).toMatchObject({ value: 6, source: 'operator-db' });
  writeFileSync(path, JSON.stringify({ [key]: 1 }));
  expect(resolve()).toMatchObject({ value: 1, source: 'operator-db' });
  writeFileSync(path, '{}');
  expect(resolve()).toMatchObject({ value: lower, source: 'lower', reason: 'not-set' });
});

it('logs source, lower and ceiling once per change, even under test when forced', () => {
  vi.stubEnv('WE_POLICY_CASCADE_LOG', '1');
  const log = vi.fn();
  const path = file('{"ciHeal.reserve":6}');
  const resolve = () => resolveCapacityLeaf('ciHeal.reserve', { lower: 3, file: path, log });
  resolve(); resolve();
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toBe('capacity-leaf · ciHeal.reserve=6 (operator-db) · lower 3 · ceiling 12');
  writeFileSync(path, '{}');
  resolve(); resolve();
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls[1][0]).toContain('=3 (lower; no override: not-set)');
});

it('silences diagnostics under test and survives a throwing logger', () => {
  vi.stubEnv('WE_POLICY_CASCADE_LOG', '');
  const log = vi.fn();
  const path = file('{"lanes.maxConcurrent":7}');
  resolveCapacityLeaf('lanes.maxConcurrent', { lower: 8, file: path, log });
  expect(log).not.toHaveBeenCalled();
  vi.stubEnv('WE_POLICY_CASCADE_LOG', '1');
  expect(resolveCapacityLeaf('lanes.maxConcurrent', { lower: 8, file: path, log: () => { throw null; } }))
    .toMatchObject({ value: 7, source: 'operator-db' });
});

it('injects reserve once at factory time; zero refuses without consulting the host gate', () => {
  const resolveReserve = vi.fn(() => 0);
  const gate = vi.fn(() => ({ admit: true }));
  const reserve = createCiHealReserve({ resolveReserve, gate, env: {} });
  expect(resolveReserve).toHaveBeenCalledTimes(1);
  expect(reserve.tryAdmit()).toMatchObject({ admit: false, kind: 'fix-cap' });
  expect(reserve.tryAdmit()).toMatchObject({ admit: false, kind: 'fix-cap' });
  expect(resolveReserve).toHaveBeenCalledTimes(1);
  expect(gate).not.toHaveBeenCalled();
});

it.each([
  ['ciHeal.reserve', 13, false], ['lanes.maxConcurrent', 0, false], ['lanes.maxConcurrent', 24, true],
  ['ciHeal.reserve', 0, true], ['ciHeal.reserve', 12, true],
])('writer enforces %s=%s (accepted=%s)', (key, value, accepted) => {
  const path = file('{}');
  const publish = () => writeOperatorOverride({ file: path, key, value, actor: 'fixture', reason: 'capacity test' });
  if (accepted) {
    expect(publish()).toMatchObject({ key, new: value });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ [key]: value });
  } else {
    expect(publish).toThrow(/invalid/);
    expect(readFileSync(path, 'utf8')).toBe('{}');
  }
});

it('does not change capacityPolicyLeaves or readOperatorPolicy for existing cascade policies', () => {
  const policies = {
    reviewConcurrency: ['maxLiveReviewRounds'], host: ['maxReviewDispatchPerTick'],
    fix: ['conflictFixesPerPass', 'conflictFixExemptPerPass'],
    resourceGate: ['fixCap.floor', 'fixCap.ceiling', 'fixCap.raiseMinMemFreePct'],
    redTeamQueue: ['minConcurrent'], deliveryCapacity: ['pinUnits', 'pinUntil', 'holdUntil'],
  };
  const values = { ...liveStore, 'fix.conflictFixExemptPerPass': 1, 'resourceGate.fixCap.raiseMinMemFreePct': 40,
    'deliveryCapacity.pinUnits': 4, 'deliveryCapacity.pinUntil': Date.now() + 3600000,
    'deliveryCapacity.holdUntil': Date.now() + 3600000 };
  const path = file(JSON.stringify({ ...values, 'ciHeal.reserve': 6, 'lanes.maxConcurrent': 12 }));
  for (const [policy, keys] of Object.entries(policies)) {
    expect(capacityPolicyLeaves(policy)).toEqual(keys);
    expect(readOperatorPolicy(policy, { file: path })).toEqual(Object.fromEntries(
      keys.map(key => [key, values[`${policy}.${key}`]])));
  }
});

// Run the actual CLI with all child-process IO replaced before its imports load.
// No production hooks or source extraction: the emitted build decisions prove the shell's config handling.
const preload = join(dir, 'tick-preload.mjs');
writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const os = require('node:os');
const userInfo = os.userInfo;
os.userInfo = () => ({ ...userInfo(), homedir: process.env.CAPACITY_TEST_HOME });
const blocked = () => { throw Error('fixture refuses external IO'); };
for (const key of ['exec', 'execSync', 'execFile', 'spawn', 'spawnSync', 'fork']) cp[key] = blocked;
cp.execFileSync = (cmd, args) => {
  if (cmd !== 'node') return blocked();
  if (args[0].endsWith('/conveyor-state.mjs')) return JSON.stringify({ queue: [], lanes: [], prs: [] });
  if (args[0].endsWith('/dispatch-plan.mjs')) return JSON.stringify({ launch: Array.from({ length: 30 }, (_, i) => ({ num: i + 1, lane: i + 1 })), held: [] });
  if (args[0].endsWith('/lane-pool.mjs')) return JSON.stringify(Array.from({ length: 30 }, (_, i) => i + 1));
  if (args[0].endsWith('/heavy-admission.mjs')) return '{}';
  return blocked();
};
syncBuiltinESMExports();
`);
const cliHome = join(dir, 'cli-home');
mkdirSync(join(cliHome, '.claude'), { recursive: true });

it.each([
  [30, undefined, 8], [4, undefined, 4], [0, undefined, 8], [2.5, undefined, 8], ['x', undefined, 8],
  [undefined, 12, 12], [30, 12, 12], [4, 12, 4],
])('tick CLI config %s with override %s admits %s builds', (explicit, override, expected) => {
  writeFileSync(join(cliHome, '.claude/operator-overrides.json'), JSON.stringify(
    override === undefined ? {} : { 'lanes.maxConcurrent': override }));
  const result = spawnSync(process.execPath, ['--import', preload,
    fileURLToPath(new URL('../../conveyor/tick-core.mjs', import.meta.url)), '--no-pause-check'], {
    input: JSON.stringify({ config: { maxConcurrentLanes: explicit, verbose: false, costAdmission: { mode: 'off' } } }),
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
    env: { ...process.env, CAPACITY_TEST_HOME: cliHome, WE_MAX_CONCURRENT_LANES: '8',
      WE_POLICY_CASCADE_LOG: '0', WE_PLANNING_SNAPSHOT_DIR: '' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).decisions.spawnBuilds).toHaveLength(expected);
});

it.each([
  [undefined, undefined, 2], [undefined, 6, 6], [1, undefined, 1], [0, undefined, 2],
])('tick CLI respects platform lanes.maxConcurrent=2 with explicit %s and operator %s', (explicit, override, expected) => {
  const preferences = file('{"lanes":{"maxConcurrent":2}}');
  writeFileSync(join(cliHome, '.claude/operator-overrides.json'), JSON.stringify(
    override === undefined ? {} : { 'lanes.maxConcurrent': override }));
  const result = spawnSync(process.execPath, ['--import', preload,
    fileURLToPath(new URL('../../conveyor/tick-core.mjs', import.meta.url)), '--no-pause-check'], {
    input: JSON.stringify({ config: { maxConcurrentLanes: explicit, verbose: false, costAdmission: { mode: 'off' } } }),
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
    env: { ...process.env, CAPACITY_TEST_HOME: cliHome, WE_MAX_CONCURRENT_LANES: '',
      WE_PLATFORM_PREFERENCES_FILE: preferences, WE_POLICY_CASCADE_LOG: '0', WE_PLANNING_SNAPSHOT_DIR: '' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).decisions.spawnBuilds).toHaveLength(expected);
});
