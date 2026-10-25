import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import ts from 'typescript';
import { PLATFORM_DELIVERY_POLICY_DEFAULTS as defaults } from '../../../config/deliveryPolicyDefaults';
import * as gate from '../gate-config.mjs';
import { DELIVERY_POLICY_FAILSAFE, loadDeliveryPolicy, POLICY_EVENT_REASON_MAX, policyEventsPath, readPolicyEvents, recordPolicyEvent } from '../delivery-policy.mjs';

const defaultFile = 'config/deliveryPolicyDefaults.ts';
const rootFile = 'webeverything.config.json';
const flat = object => Object.entries(object).flatMap(([key, fields]) => Object.keys(fields).map(field => `${key}.${field}`)).sort();
const policy = result => Object.fromEntries(Object.keys(defaults).map(key => [key, result[key]]));
let dir, root, env;
const put = (file, value) => {
  const path = resolve(root, file);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};
const load = options => loadDeliveryPolicy({ root, env, ...options });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
function repository(targets = []) {
  git('init', '-q');
  let source = readFileSync(resolve('scripts/lib/gate-config.mjs'), 'utf8');
  source = source.replace('export const TRUST_CHAIN = [', `export const TRUST_CHAIN = [${targets.map(file => JSON.stringify({ file, tier: 'policy', leash: 'spec' })).join(',')}${targets.length ? ',' : ''}`);
  put('scripts/lib/gate-config.mjs', source);
  put('scripts/lib/rules-loader.cjs', readFileSync(resolve('scripts/lib/rules-loader.cjs'), 'utf8'));
  return commit();
}
function reach(result, extra = []) {
  for (const file of result.filesRead) expect(gate.isPolicySpecPath(file) || extra.includes(file)).toBe(true);
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(process.env.TMPDIR, 'delivery-policy-')));
  root = join(dir, 'repo');
  mkdirSync(root);
  mkdirSync(join(dir, 'state'));
  env = { WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_POLICY_EVENTS_FILE: join(dir, 'events.jsonl') };
  put(defaultFile, readFileSync(resolve(defaultFile), 'utf8'));
});
afterEach(() => { vi.restoreAllMocks(); gate.POLICY_SPEC_BASENAMES.delete('repair-policy.json'); gate.POLICY_SPEC_BASENAMES.delete('repair-policy.txt'); rmSync(dir, { recursive: true, force: true }); });

describe('delivery policy values', () => {
  it('defaults include the stop and alert absent in the incident, with default provenance', async () => {
    const result = await load();
    expect(policy(result)).toEqual(defaults);
    expect(Object.values(result.sources).flatMap(Object.values)).toEqual(Array(9).fill('default'));
    expect(result.warnings).toEqual([]);
    expect(result.filesRead).toEqual([defaultFile]);
    reach(result);
  });
  const values = {
    prCi: { mainStateParity: ['on', 'off'] },
    mergeGate: { recheckWhenMainMoved: ['if-older-than-N-min', 'always', 'off'], recheckMaxAgeMin: [1, 30, 61], onMainRed: ['halt', 'warn', 'off'] },
    dispatchGate: { overlapOverride: ['off', 'logged', 'free'] },
    heavyQueue: { priority: ['repairs-first', 'fifo'], reservedForRepairs: [0, 1, 50], reservedBorrowAfterMin: [1, 10, 60] },
    drain: { onStepRefusal: ['alert', 'log'] },
  };
  for (const [key, fields] of Object.entries(values)) for (const [field, choices] of Object.entries(fields)) for (const value of choices) {
    it(`${key}.${field} accepts ${value} inline and over the dimension default`, async () => {
      for (const entry of [{ [field]: value }, { kind: 'extends-flavor', flavors: ['platform'], overrides: { [field]: value } }]) {
        put(rootFile, { [key]: entry });
        const result = await load();
        expect(result[key]).toEqual({ ...defaults[key], [field]: value });
        expect(result.sources[key][field]).toBe('config');
        expect(result.warnings).toEqual([]);
        reach(result);
      }
    });
  }
  it('partial override leaves other fields and their provenance at default', async () => {
    put(rootFile, { mergeGate: { onMainRed: 'warn' } });
    const result = await load();
    expect(result.mergeGate).toEqual({ ...defaults.mergeGate, onMainRed: 'warn' });
    expect(result.sources.mergeGate).toEqual({ recheckWhenMainMoved: 'default', recheckMaxAgeMin: 'default', onMainRed: 'config' });
  });
  it.each([
    ['unknown value', { mergeGate: { onMainRed: 'explode' } }],
    ['wrong type', { heavyQueue: { reservedForRepairs: 'two' } }],
    ['zero positive integer', { mergeGate: { recheckMaxAgeMin: 0 } }],
    ['negative reservation', { heavyQueue: { reservedForRepairs: -1 } }],
    ['fraction', { heavyQueue: { reservedBorrowAfterMin: 0.5 } }],
    ['bad JSON', '{'], ['missing pointer', { mergeGate: './missing.json' }],
    ['wrong dimension type', { mergeGate: false }],
  ])('%s falls back with one warning and never throws', async (_name, config) => {
    put(rootFile, config);
    const result = await load();
    expect(policy(result)).toEqual(defaults);
    expect(result.warnings).toHaveLength(1);
    reach(result);
  });
  it('project and defaults caches reuse unchanged mtime and refresh changed mtime', async () => {
    for (const file of [rootFile, defaultFile]) {
      if (file === rootFile) put(file, { mergeGate: { onMainRed: 'halt' } });
      const before = await load();
      const path = join(root, file);
      // Set a precisely representable timestamp before priming this cache entry.
      utimesSync(path, 1000000000, 1000000000);
      await load();
      const source = file === rootFile ? JSON.stringify({ mergeGate: { onMainRed: 'off' } }) : readFileSync(path, 'utf8').replace("onMainRed: 'halt'", "onMainRed: 'off'");
      put(file, source);
      utimesSync(path, 1000000000, 1000000000);
      expect((await load()).mergeGate.onMainRed).toBe(before.mergeGate.onMainRed);
      utimesSync(path, 1000000001, 1000000001);
      expect((await load()).mergeGate.onMainRed).toBe('off');
      if (file === rootFile) rmSync(path);
    }
  });
  it('unreadable or untranspilable defaults use every most-protective failsafe field and journal once', async () => {
    expect(DELIVERY_POLICY_FAILSAFE).toEqual({ ...defaults, mergeGate: { ...defaults.mergeGate, recheckWhenMainMoved: 'always' } });
    for (const broken of [null, 'export const = ;']) {
      if (broken === null) rmSync(join(root, defaultFile)); else put(defaultFile, broken);
      const result = await load();
      expect(policy(result)).toEqual(DELIVERY_POLICY_FAILSAFE);
      expect(result.warnings).toHaveLength(1);
    }
    expect(readPolicyEvents({ env }).map(event => event.event)).toEqual(['policy-defaults-unreadable', 'policy-defaults-unreadable']);
  });
  it('defaults source imports types only; a value import is rejected before execution', async () => {
    const source = readFileSync(resolve(defaultFile), 'utf8');
    const ast = ts.createSourceFile(defaultFile, source, ts.ScriptTarget.Latest, true);
    for (const node of ast.statements.filter(ts.isImportDeclaration)) expect(node.importClause?.isTypeOnly).toBe(true);
    put(defaultFile, `import './ungated.mjs';\n${source}`);
    put('config/ungated.mjs', "throw Error('must never execute');");
    expect(policy(await load())).toEqual(DELIVERY_POLICY_FAILSAFE);
  });
  it('CLI flattened keys equal the defaults and all nine documented fields', () => {
    const output = JSON.parse(execFileSync(process.execPath, [resolve('scripts/lib/delivery-policy.mjs'), '--json'], { cwd: root, env: { ...process.env, ...env, WE_POLICY_CONFIG: '', GITHUB_ACTIONS: '' }, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }));
    expect(flat(policy(output))).toEqual(flat(defaults));
    expect(flat(policy(output))).toHaveLength(9);
    expect(policy(output)).toEqual(defaults);
  });
});

describe('trust, confinement and reach set', () => {
  it('base config and defaults win over PR head and CLI supports --ref', async () => {
    put(rootFile, { mergeGate: { onMainRed: 'halt' } });
    const base = repository();
    put(rootFile, { mergeGate: { onMainRed: 'off' } });
    put(defaultFile, readFileSync(join(root, defaultFile), 'utf8').replace("mainStateParity: 'on'", "mainStateParity: 'off'").replace("onMainRed: 'halt'", "onMainRed: 'off'"));
    commit();
    expect((await load()).mergeGate.onMainRed).toBe('off');
    const result = await load({ ref: base });
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.prCi.mainStateParity).toBe('on');
    expect(result.sources.prCi.mainStateParity).toBe('default');
    reach(result);
    const cli = JSON.parse(execFileSync(process.execPath, [resolve('scripts/lib/delivery-policy.mjs'), '--json', `--ref=${base}`], { cwd: root, env: { ...process.env, ...env, WE_POLICY_CONFIG: '' }, encoding: 'utf8', timeout: 20000 }));
    expect(cli.mergeGate.onMainRed).toBe('halt');
  });
  it('PR default edits with no project config cannot weaken base defaults or execute PR code', async () => {
    const base = repository();
    put(defaultFile, readFileSync(join(root, defaultFile), 'utf8').replace("mainStateParity: 'on'", "mainStateParity: 'off'").replace("onMainRed: 'halt'", "onMainRed: 'off'") + "\nthrow Error('PR default executed');");
    commit();
    const result = await load({ ref: base });
    expect(policy(result)).toEqual(defaults);
    expect(result.filesRead).toEqual([defaultFile]);
    expect(result.warnings).toEqual([]);
  });
  it.each(['../outside.json', 'absolute', 'symlink'])('refuses confined pointer escape %s', async kind => {
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ onMainRed: 'off' }));
    if (kind === 'symlink') symlinkSync(outside, join(root, 'repair-policy.json'));
    put(rootFile, { mergeGate: kind === 'absolute' ? outside : kind === 'symlink' ? 'repair-policy.json' : kind });
    const result = await load();
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.warnings).toHaveLength(1);
    reach(result);
  });
  it('unregistered pointers are refused locally, at base, recursively and inside env config', async () => {
    put('ungated.json', { onMainRed: 'off' });
    put(rootFile, { mergeGate: './ungated.json' });
    const base = repository();
    for (const ref of [undefined, base]) {
      const result = await load({ ref });
      expect(result.mergeGate.onMainRed).toBe('halt');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('ungated.json');
      reach(result);
    }
    gate.POLICY_SPEC_BASENAMES.add('repair-policy.json');
    put('repair-policy.json', JSON.stringify('./ungated.json'));
    put(rootFile, { mergeGate: './repair-policy.json' });
    const nested = await load();
    expect(nested.mergeGate.onMainRed).toBe('halt');
    expect(nested.warnings).toHaveLength(1);
    reach(nested);
    const path = join(dir, 'state/config.json');
    writeFileSync(path, JSON.stringify({ mergeGate: './ungated.json' }));
    const fromEnv = await load({ env: { ...env, WE_POLICY_CONFIG: path } });
    expect(fromEnv.mergeGate.onMainRed).toBe('halt');
    expect(fromEnv.warnings).toHaveLength(1);
    reach(fromEnv, [path]);
  });
  it('honours registered normalized JSON paths using the registry, and audits the full reach set', async () => {
    gate.POLICY_SPEC_BASENAMES.add('repair-policy.json');
    mkdirSync(join(root, 'nested'));
    put('repair-policy.json', { onMainRed: 'off' });
    put(rootFile, { mergeGate: './nested/../repair-policy.json' });
    const local = await load();
    expect(local.mergeGate.onMainRed).toBe('off');
    expect(local.sources.mergeGate.onMainRed).toBe('config');
    expect(local.filesRead).toEqual([defaultFile, rootFile, 'repair-policy.json']);
    reach(local);
    const base = repository(['repair-policy.json']);
    const result = await load({ ref: base });
    expect(result.mergeGate.onMainRed).toBe('off');
    expect(result.filesRead).toEqual(local.filesRead);
    reach(result);
  });
  it('PR-only registry changes are refused; broken base registries refuse every pointer', async () => {
    put(rootFile, { mergeGate: './repair-policy.json' });
    put('repair-policy.json', { onMainRed: 'off' });
    const base = repository();
    repository(['repair-policy.json']);
    let result = await load({ ref: base });
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.warnings).toHaveLength(1);
    put('scripts/lib/gate-config.mjs', "throw Error('unreadable registry');");
    result = await load({ ref: commit() });
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.warnings).toHaveLength(1);
    reach(result);
  });
  it('refuses registered symlinks locally and git mode 120000, non-blobs, and non-JSON targets', async () => {
    gate.POLICY_SPEC_BASENAMES.add('repair-policy.json');
    put('ungated.json', { onMainRed: 'off' });
    symlinkSync('ungated.json', join(root, 'repair-policy.json'));
    put(rootFile, { mergeGate: './repair-policy.json' });
    const base = repository(['repair-policy.json']);
    for (const ref of [undefined, base]) {
      const result = await load({ ref });
      expect(result.mergeGate.onMainRed).toBe('halt');
      expect(result.warnings).toHaveLength(1);
      reach(result);
    }
    rmSync(join(root, 'repair-policy.json'));
    mkdirSync(join(root, 'repair-policy.json'));
    put('repair-policy.json/child', 'directory');
    const tree = await load({ ref: commit() });
    expect(tree.mergeGate.onMainRed).toBe('halt');
    expect(tree.warnings).toHaveLength(1);
    gate.POLICY_SPEC_BASENAMES.add('repair-policy.txt');
    put('repair-policy.txt', { onMainRed: 'off' });
    put(rootFile, { mergeGate: './repair-policy.txt' });
    const result = await load();
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.warnings).toHaveLength(1);
    reach(result);
  });
  it('post-check drops values even if an unregistered source bypasses the pointer check', async () => {
    put('ungated.json', { onMainRed: 'off' });
    put(rootFile, { mergeGate: './ungated.json' });
    const real = gate.isPolicySpecPath;
    let calls = 0;
    vi.spyOn(gate, 'isPolicySpecPath').mockImplementation(path => basename(path) === 'ungated.json' ? ++calls === 1 : real(path));
    const result = await load();
    expect(calls).toBeGreaterThan(1);
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.sources.mergeGate.onMainRed).toBe('default');
    expect(result.warnings).toHaveLength(1);
  });
  it('pointer cache refreshes on mtime changes and cycles have a bounded default fallback', async () => {
    gate.POLICY_SPEC_BASENAMES.add('repair-policy.json');
    const path = put('repair-policy.json', { onMainRed: 'warn' });
    put(rootFile, { mergeGate: './repair-policy.json' });
    expect((await load()).mergeGate.onMainRed).toBe('warn');
    put('repair-policy.json', { onMainRed: 'off' });
    utimesSync(path, 1000000002, 1000000002);
    expect((await load()).mergeGate.onMainRed).toBe('off');
    put('repair-policy.json', JSON.stringify('./repair-policy.json'));
    utimesSync(path, 1000000003, 1000000003);
    const cycle = await load();
    expect(cycle.mergeGate.onMainRed).toBe('halt');
    expect(cycle.warnings).toHaveLength(1);
    reach(cycle);
  });
  it('registered missing JSON and invalid pointer JSON have a single warning', async () => {
    gate.POLICY_SPEC_BASENAMES.add('repair-policy.json');
    put(rootFile, { mergeGate: './repair-policy.json' });
    for (const source of [null, '{']) {
      if (source !== null) put('repair-policy.json', source);
      const result = await load();
      expect(result.mergeGate.onMainRed).toBe('halt');
      expect(result.warnings).toHaveLength(1);
      reach(result);
    }
  });
  it('unreadable root config and oversized JSON fail closed with an operator-visible fallback', async () => {
    mkdirSync(join(root, rootFile));
    let result = await load();
    expect(policy(result)).toEqual(defaults);
    expect(result.warnings).toHaveLength(1);
    rmSync(join(root, rootFile), { recursive: true });
    put(rootFile, ' '.repeat(1024 * 1024 + 1));
    result = await load();
    expect(policy(result)).toEqual(defaults);
    expect(result.warnings).toHaveLength(1);
  });
  it('state-dir env differences journal once per dimension; defaults do not; exemption survives post-check', async () => {
    const path = join(dir, 'state/config.json');
    writeFileSync(path, JSON.stringify({ mergeGate: { onMainRed: 'off' } }));
    const result = await load({ env: { ...env, WE_POLICY_CONFIG: path } });
    expect(result.mergeGate.onMainRed).toBe('off');
    reach(result, [path]);
    const events = readPolicyEvents({ env });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'policy-source-env', key: 'mergeGate', detail: { file: path, fields: ['mergeGate.onMainRed'] } });
    writeFileSync(path, JSON.stringify(defaults));
    await load({ env: { ...env, WE_POLICY_CONFIG: path } });
    expect(readPolicyEvents({ env })).toHaveLength(1);
  });
  it('ignores env redirect in Actions, outside state/repo, or to unregistered repo files', async () => {
    for (const [path, extra] of [[join(dir, 'state/config.json'), { GITHUB_ACTIONS: 'true' }], [join(dir, 'outside.json'), {}], [join(root, 'ungated.json'), {}]]) {
      writeFileSync(path, JSON.stringify({ mergeGate: { onMainRed: 'off' } }));
      const result = await load({ env: { ...env, ...extra, WE_POLICY_CONFIG: path } });
      expect(result.mergeGate.onMainRed).toBe('halt');
      expect(result.warnings).toHaveLength(1);
      reach(result);
    }
  });
  it('env config is JSON only, and ref reads cannot be redirected even outside Actions', async () => {
    const base = repository();
    const path = join(dir, 'state/config.txt');
    writeFileSync(path, JSON.stringify({ mergeGate: { onMainRed: 'off' } }));
    for (const ref of [undefined, base]) {
      const result = await load({ ref, env: { ...env, WE_POLICY_CONFIG: path } });
      expect(result.mergeGate.onMainRed).toBe('halt');
      expect(result.warnings).toHaveLength(1);
      reach(result);
    }
  });
});

describe('policy journal', () => {
  it('round-trips with timestamp, since filter, corrupt-line tolerance and never throws on unwritable IO', () => {
    expect(policyEventsPath(env)).toBe(env.WE_POLICY_EVENTS_FILE);
    expect(policyEventsPath({ HEALTH_WATCH_LOGS_DIR: dir })).toBe(join(dir, 'policy-events.jsonl'));
    const input = { key: 'dispatchGate', event: 'override', subject: 'PR 1', reason: 'operator reason', detail: { files: ['one.json'] } };
    recordPolicyEvent(input, env);
    const events = readPolicyEvents({ env });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(input);
    expect(Number.isNaN(Date.parse(events[0].at))).toBe(false);
    expect(readPolicyEvents({ env, sinceMs: Date.now() + 10000 })).toEqual([]);
    writeFileSync(env.WE_POLICY_EVENTS_FILE, readFileSync(env.WE_POLICY_EVENTS_FILE, 'utf8') + '{broken\n');
    expect(readPolicyEvents({ env })).toHaveLength(1);
    expect(() => recordPolicyEvent(input, { WE_POLICY_EVENTS_FILE: dir })).not.toThrow();
    expect(readPolicyEvents({ env: { WE_POLICY_EVENTS_FILE: dir } })).toEqual([]);
  });
  it('strips C0/C1, bounds reasons and nested detail strings/arrays, caps UTF-8 line at 4KB', () => {
    expect(POLICY_EVENT_REASON_MAX).toBe(200);
    for (const reason of ['line\n\x1b\x85end', 'x'.repeat(5000), 'x'.repeat(200)]) recordPolicyEvent({ key: 'mergeGate', event: 'refused', subject: 'PR 2', reason, detail: { files: Array(100).fill('file\n\x1b'), nested: { value: 'y'.repeat(501) } } }, env);
    const events = readPolicyEvents({ env });
    expect(events[0].reason).toBe('lineend');
    expect(events[1].reason).toBe('x'.repeat(199) + '…');
    expect(events[2].reason).toBe('x'.repeat(200));
    expect(events[0].detail.files).toEqual(Array(20).fill('file'));
    expect(events[0].detail.nested.value).toBe('y'.repeat(499) + '…');
    recordPolicyEvent({ key: 'mergeGate', event: 'refused', subject: 'PR 2', detail: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, '😀'.repeat(500)])) }, env);
    const lines = readFileSync(env.WE_POLICY_EVENTS_FILE, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(Buffer.byteLength(line + '\n')).toBeLessThanOrEqual(4096);
    expect(JSON.parse(lines[3])).toMatchObject({ key: 'mergeGate', event: 'refused', subject: 'PR 2' });
    expect(JSON.parse(lines[3]).detail).not.toHaveProperty('field99');
  });
  it('bounds escaped Unicode identity fields as well as detail, keeping all identity keys', () => {
    recordPolicyEvent({ key: '\ud800'.repeat(5000), event: '\ud800'.repeat(5000), subject: '\ud800'.repeat(5000), reason: '\ud800'.repeat(5000), detail: ['x'.repeat(5000)] }, env);
    const line = readFileSync(env.WE_POLICY_EVENTS_FILE, 'utf8');
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4096);
    for (const field of ['key', 'event', 'subject', 'reason']) expect(JSON.parse(line)[field]).toMatch(/…$/);
  });
});
