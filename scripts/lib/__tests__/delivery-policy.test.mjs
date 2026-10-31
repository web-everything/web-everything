import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { PLATFORM_DELIVERY_POLICY_DEFAULTS as defaults } from '../../../config/deliveryPolicyDefaults';
import * as gate from '../gate-config.mjs';
import * as deliveryPolicy from '../delivery-policy.mjs';
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
  dir = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'delivery-policy-')));
  root = join(dir, 'repo');
  mkdirSync(root);
  mkdirSync(join(dir, 'state'));
  env = { WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_POLICY_EVENTS_FILE: join(dir, 'state/events.jsonl') };
  put(defaultFile, readFileSync(resolve(defaultFile), 'utf8'));
});
afterEach(() => { vi.restoreAllMocks(); gate.POLICY_SPEC_BASENAMES.delete('repair-policy.json'); gate.POLICY_SPEC_BASENAMES.delete('repair-policy.txt'); rmSync(dir, { recursive: true, force: true }); });

describe('trusted policy paths', () => {
  it('reads a plain confined file and accepts a realpath-resolved allowed base', () => {
    const file = put('nested/policy.json', '{"safe":true}');
    const base = join(dir, 'repo-alias');
    symlinkSync(root, base, 'dir');
    const trusted = deliveryPolicy.resolveTrustedConfigPath('nested/policy.json', { root: base, allowedRoots: [base] });
    expect(trusted.real).toBe(file);
    expect(trusted.read()).toBe('{"safe":true}');
  });

  it.each(['../outside.json', '../repo-other/policy.json'])('refuses normalized escape %s before reading', path => {
    put(path, '{"unsafe":true}');
    expect(() => deliveryPolicy.resolveTrustedConfigPath(path, { root, allowedRoots: [root] })).toThrow(/Outside root/);
  });

  it.each(['leaf', 'parent'])('refuses a symlinked %s even when its target stays inside the allowed root', kind => {
    const file = put('nested/policy.json', '{"unsafe":true}');
    const path = kind === 'leaf' ? 'linked.json' : 'linked/policy.json';
    symlinkSync(kind === 'leaf' ? file : join(root, 'nested'), join(root, kind === 'leaf' ? path : 'linked'));
    expect(() => deliveryPolicy.resolveTrustedConfigPath(path, { root, allowedRoots: [root] })).toThrow(/symlink refused/);
  });

  it.each(['leaf', 'parent', 'regular replacement'])('refuses a %s swapped between validation and fd read', kind => {
    const file = put('nested/policy.json', '{"safe":true}');
    const target = put('target/policy.json', '{"unsafe":true}');
    const trusted = deliveryPolicy.resolveTrustedConfigPath('nested/policy.json', {
      root, allowedRoots: [root], beforeRead() {
        if (kind === 'parent') {
          renameSync(join(root, 'nested'), join(root, 'original'));
          symlinkSync(join(root, 'target'), join(root, 'nested'), 'dir');
        } else {
          renameSync(file, file + '.original');
          if (kind === 'leaf') symlinkSync(target, file);
          else writeFileSync(file, '{"unsafe":true}');
        }
      },
    });
    expect(() => trusted.read()).toThrow(/symlink refused|changed|ELOOP/);
  });

  it('refuses directories, oversized files, and files grown after validation', () => {
    expect(() => deliveryPolicy.resolveTrustedConfigPath('config', { root })).toThrow(/Unreadable or oversized/);
    put('oversized.json', ' '.repeat(1024 * 1024 + 1));
    expect(() => deliveryPolicy.resolveTrustedConfigPath('oversized.json', { root })).toThrow(/Unreadable or oversized/);
    const file = put('growing.json', '{}');
    const trusted = deliveryPolicy.resolveTrustedConfigPath('growing.json', { root, beforeRead() {
      writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
    } });
    expect(() => trusted.read()).toThrow(/Unreadable or oversized/);
  });

  it.each(['leaf', 'parent'])('keeps reading the opened fd after a %s swap during a short read', kind => {
    const source = '{"safe":true}';
    const file = put('nested/policy.json', source);
    const target = put('target/policy.json', '{"safe":false}');
    const original = statSync(file);
    // Isolate native ESM patches from Vitest and the other filesystem fixtures.
    const observed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { dirname } from 'node:path';
      import { resolveTrustedConfigPath } from './scripts/lib/delivery-policy.mjs';
      const [root, file, target, kind] = process.argv.slice(1);
      const trusted = resolveTrustedConfigPath(file, { root });
      const read = fs.readSync;
      const open = fs.openSync;
      const observed = { opens: 0, identities: [] };
      let descriptor;
      fs.openSync = (...args) => { observed.opens++; return open(...args); };
      fs.readSync = (fd, buffer, offset, length, position) => {
        descriptor = fd;
        const { dev, ino } = fs.fstatSync(fd);
        observed.identities.push({ dev, ino });
        const bytes = read(fd, buffer, offset, Math.min(length, 4), position);
        if (observed.identities.length === 1) {
          const replaced = kind === 'leaf' ? file : dirname(file);
          fs.renameSync(replaced, replaced + '.original');
          fs.symlinkSync(kind === 'leaf' ? target : dirname(target), replaced);
        }
        return bytes;
      };
      syncBuiltinESMExports();
      observed.source = trusted.read();
      try { fs.fstatSync(descriptor); } catch (error) { observed.closed = error.code; }
      fs.readSync = read;
      fs.openSync = open;
      syncBuiltinESMExports();
      // Imported daemon modules may retain handles; the synchronous probe is complete.
      process.stdout.write(JSON.stringify(observed), () => process.exit(0));
    `, root, file, target, kind], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536,
    }));
    expect(observed.source).toBe(source);
    expect(observed.opens).toBe(1);
    expect(observed.identities.length).toBeGreaterThan(1);
    for (const identity of observed.identities) expect(identity).toEqual({ dev: original.dev, ino: original.ino });
    expect(observed.closed).toBe('EBADF');
    expect(readFileSync(file, 'utf8')).toBe('{"safe":false}');
  });

  it.each(['defaults', 'pointer', 'repo env', 'state env'])('rejects a symlinked parent before reusing cached %s values', async kind => {
    const base = kind === 'state env' ? env.WE_DAEMON_STATE_DIR : root;
    const directory = join(base, kind === 'defaults' ? 'config' : 'nested');
    const file = join(directory, kind === 'defaults' ? 'deliveryPolicyDefaults.ts' : kind === 'pointer' ? 'repair-policy.json' : rootFile);
    const source = kind === 'defaults'
      ? readFileSync(join(root, defaultFile), 'utf8').replace("onMainRed: 'halt'", "onMainRed: 'off'")
      : kind === 'pointer' ? { onMainRed: 'off' } : { mergeGate: { onMainRed: 'off' } };
    put(file, source);
    if (kind === 'pointer') {
      gate.POLICY_SPEC_BASENAMES.add('repair-policy.json');
      put(rootFile, { mergeGate: './nested/repair-policy.json' });
    }
    const options = kind.endsWith('env') ? { env: { ...env, WE_POLICY_CONFIG: file } } : {};
    const warm = await load(options);
    expect(warm.mergeGate.onMainRed).toBe('off');
    expect(warm.warnings).toEqual([]);
    const original = statSync(file);
    renameSync(directory, directory + '.original');
    symlinkSync(directory + '.original', directory, 'dir');
    // The leaf and its mtime are unchanged: only the path's trust has changed.
    expect(statSync(file).ino).toBe(original.ino);
    expect(statSync(file).mtimeMs).toBe(original.mtimeMs);
    const refused = await load(options);
    expect(refused.mergeGate.onMainRed).toBe('halt');
    expect(refused.sources.mergeGate.onMainRed).toBe('default');
    expect(refused.warnings).toHaveLength(1);
    expect(refused.warnings[0]).toMatch(/symlink refused|defaults unreadable/);
    expect(refused.filesRead).toEqual(kind === 'defaults' ? [] : kind === 'pointer' ? [defaultFile, rootFile] : [defaultFile]);
  });

  it('bounds total fd IO to MAX_SOURCE_BYTES + 1 when the inode grows during reading', () => {
    const maxSourceBytes = 1024 * 1024;
    const initial = '{"safe":true}';
    const file = put('growing-during-read.json', initial);
    const original = statSync(file);
    // Native ESM builtins need syncBuiltinESMExports; isolate that patch in a bounded child.
    const observed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { resolveTrustedConfigPath } from './scripts/lib/delivery-policy.mjs';
      const [root, file, limit] = process.argv.slice(1);
      const trusted = resolveTrustedConfigPath(file, { root });
      const read = fs.readSync;
      const observed = { ranges: [] };
      const identity = fd => {
        const { dev, ino, size } = fs.fstatSync(fd);
        return { dev, ino, size };
      };
      fs.readSync = (fd, buffer, offset, length, position) => {
        // Force short reads so the real loop must enforce its remaining budget across calls.
        const bytes = read(fd, buffer, offset, Math.min(length, 64 * 1024), position);
        observed.ranges.push({ position, length, bytes });
        if (observed.ranges.length === 1) {
          // Growth follows the first actual read, after the helper's size check.
          observed.atFirstRead = identity(fd);
          fs.writeFileSync(file, 'x'.repeat(3 * Number(limit)), { flag: 'a' });
          observed.afterGrowth = identity(fd);
        }
        return bytes;
      };
      syncBuiltinESMExports();
      try { trusted.read(); } catch (error) { observed.error = error.message; }
      process.stdout.write(JSON.stringify(observed));
    `, root, file, String(maxSourceBytes)], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536,
    }));

    expect(observed.error).toMatch(/Unreadable or oversized/);
    expect(observed.atFirstRead).toEqual({ dev: original.dev, ino: original.ino, size: initial.length });
    expect(observed.afterGrowth).toEqual({ dev: original.dev, ino: original.ino, size: initial.length + 3 * maxSourceBytes });
    expect(observed.ranges.length).toBeGreaterThan(1);
    expect(observed.ranges[0].bytes).toBe(initial.length);
    let total = 0;
    for (const range of observed.ranges) {
      expect(range.position).toBe(total);
      expect(range.position + range.length).toBeLessThanOrEqual(maxSourceBytes + 1);
      total += range.bytes;
    }
    expect(total).toBe(maxSourceBytes + 1);
  });

  it.each(['leaf', 'parent', 'missing leaf'])('refuses a journal %s swapped before fd append without changing the target', kind => {
    const target = put('target/events.jsonl', 'original\n');
    if (kind === 'leaf') put('nested/events.jsonl', 'trusted\n');
    else mkdirSync(join(root, 'nested'));
    const file = join(root, 'nested/events.jsonl');
    const trusted = deliveryPolicy.resolveTrustedConfigPath(file, {
      root, create: true, beforeRead() {
        if (kind === 'parent') {
          renameSync(join(root, 'nested'), join(root, 'original'));
          symlinkSync(join(root, 'target'), join(root, 'nested'), 'dir');
        } else {
          if (kind === 'leaf') renameSync(file, file + '.original');
          symlinkSync(target, file);
        }
      },
    });
    expect(() => trusted.append('unsafe\n')).toThrow(/symlink refused|changed|ELOOP|EEXIST/);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });
});

describe('delivery policy values', () => {
  it.each([
    ['empty', ''], ['whitespace', ' '], ['null', null], ['number', 42], ['object', {}], ['option-like', '--help'],
  ])('uses the protective failsafe without throwing for a %s ref', async (_name, ref) => {
    put(rootFile, { mergeGate: { onMainRed: 'off' } });
    const result = await load({ ref });
    expect(policy(result)).toEqual(DELIVERY_POLICY_FAILSAFE);
    expect(result.sources.mergeGate.onMainRed).toBe('default');
    expect(result.filesRead).toEqual([]);
    expect(result.warnings).toEqual([
      'Policy sources unavailable; using most-protective failsafe. Check the root and trusted base ref.',
    ]);
  });

  it('CLI --ref without a value returns the protective failsafe with a warning', () => {
    put(rootFile, { mergeGate: { onMainRed: 'off' } });
    const result = JSON.parse(execFileSync(process.execPath, [resolve('scripts/lib/delivery-policy.mjs'), '--json', '--ref'], {
      cwd: root, env: { ...process.env, ...env, WE_POLICY_CONFIG: '' }, encoding: 'utf8', timeout: 20000,
    }));
    expect(policy(result)).toEqual(DELIVERY_POLICY_FAILSAFE);
    expect(result.filesRead).toEqual([]);
    expect(result.warnings).toEqual([
      'Policy sources unavailable; using most-protective failsafe. Check the root and trusted base ref.',
    ]);
  });

  it('refuses a non-cyclic registered pointer chain beyond the 20 depth cap with a warning', async () => {
    const targets = Array.from({ length: 21 }, (_, i) => `depth-policy-${i}.json`);
    targets.forEach((target, i) => put(target, i + 1 < targets.length ? JSON.stringify(`./${targets[i + 1]}`) : { onMainRed: 'off' }));
    put(rootFile, { mergeGate: `./${targets[0]}` });
    const result = await load({ ref: repository(targets) });
    expect(policy(result)).toEqual(defaults);
    expect(result.sources.mergeGate.onMainRed).toBe('default');
    expect(result.warnings).toEqual([`Policy pointer refused: ./${targets[19]}`]);
    expect(result.filesRead).toEqual([defaultFile, rootFile, ...targets.slice(0, 19)]);
    reach(result, targets);
  });

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
  it.each([undefined, null, 'platform', {}, [42], ['platform', null]])(
    'rejects an extends-flavor descriptor whose flavors is not a string array: %j', async flavors => {
      put(rootFile, { mergeGate: { kind: 'extends-flavor', flavors, overrides: { onMainRed: 'off' } } });
      const result = await load();
      expect(policy(result)).toEqual(defaults);
      expect(result.sources.mergeGate.onMainRed).toBe('default');
      expect(result.warnings).toEqual(['Invalid descriptor: mergeGate']);
      reach(result);
    },
  );
  it('ignores an unknown field inside a valid dimension with a warning and keeps valid overrides', async () => {
    put(rootFile, { mergeGate: { onMainRed: 'warn', onMainRead: 'off' } });
    const result = await load();
    expect(policy(result)).toEqual({ ...defaults, mergeGate: { ...defaults.mergeGate, onMainRed: 'warn' } });
    expect(result.sources.mergeGate).toEqual({ recheckWhenMainMoved: 'default', recheckMaxAgeMin: 'default', onMainRed: 'config' });
    expect(result.warnings).toEqual(['Invalid policy value: mergeGate.onMainRead']);
    reach(result);
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
  it.each(['__proto__', 'constructor', 'toString'])('refuses defaults whose dimension is inherited, not own (%s)', async name => {
    const { prCi, ...rest } = defaults;
    const pad = name === '__proto__' ? 'padding' : name;
    put(defaultFile, `export const PLATFORM_DELIVERY_POLICY_DEFAULTS = { __proto__: { prCi: ${JSON.stringify(prCi)} }, ${Object.entries(rest).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}, ${pad}: {} };`);
    const result = await load();
    expect(policy(result)).toEqual(DELIVERY_POLICY_FAILSAFE);
    expect(result.warnings).toHaveLength(1);
  });
  it('refuses defaults with the right own-key count where one required field is only inherited', async () => {
    const { prCi, ...rest } = defaults;
    const body = Object.entries(rest).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
    put(defaultFile, `export const PLATFORM_DELIVERY_POLICY_DEFAULTS = { ${body}, prCi: { __proto__: ${JSON.stringify(prCi)}, padding: 'on' } };`);
    const result = await load();
    expect(policy(result)).toEqual(DELIVERY_POLICY_FAILSAFE);
    expect(result.warnings).toHaveLength(1);
  });
  it('defaults source imports types only; a value import is rejected before execution', async () => {
    const source = readFileSync(resolve(defaultFile), 'utf8');
    const ast = ts.createSourceFile(defaultFile, source, ts.ScriptTarget.Latest, true);
    for (const node of ast.statements.filter(ts.isImportDeclaration)) expect(node.importClause?.isTypeOnly).toBe(true);
    put(defaultFile, `import './ungated.mjs';\n${source}`);
    put('config/ungated.mjs', "throw Error('must never execute');");
    expect(policy(await load())).toEqual(DELIVERY_POLICY_FAILSAFE);
  });
  it.each([
    ['computed', "const x = 'node:path'; await import /* gap */ (x);"],
    ['template', 'const x = "path"; await import(`node:${x}`);'],
    ['relative template', 'const x = "other"; if (false) import(`./${x}`);'],
    ['literal', "await import('node:path');"],
    ['meta', 'void import /* gap */ .meta.url;'],
    ['dead require', "if (false) require('node:path');"],
  ])('refuses %s runtime imports before executing defaults and reports failsafe', async (_name, expression) => {
    const source = readFileSync(join(root, defaultFile), 'utf8');
    put(defaultFile, `${expression}\n${source}`);
    const result = await load();
    expect(policy(result)).toEqual(DELIVERY_POLICY_FAILSAFE);
    expect(result.warnings).toEqual([expect.stringMatching(/failsafe/)]);
    expect(readPolicyEvents({ env })).toMatchObject([{ event: 'policy-defaults-unreadable' }]);
  });
  it.each([
    ['new Function', `new Function('return im'+'port("node:path")')()`],
    ['Function call', `Function('return im'+'port("node:path")')()`],
    ['eval', `eval('im'+'port("node:path")')`],
    ['constructor member', `(()=>{}).constructor('return im'+'port("node:path")')()`],
    ['computed constructor member', `(()=>{})['constructor']('return im'+'port("node:path")')()`],
    ['dynamically computed constructor key', `const key = ['con', 'structor'].join(''); const make = (() => {})[key]; make('return pro' + 'cess')().exit(0)`],
    ['globalThis', 'void globalThis'],
    ['process', 'void process'],
    ['require alias', 'const loader = require'],
    ['module', 'void module'],
    ['string setTimeout', `setTimeout('im'+'port("node:path")', 0)`],
    ['string setInterval', `setInterval('im'+'port("node:path")', 0)`],
    ['import.meta', 'void import.meta'],
    ['WebAssembly', 'void WebAssembly'],
    ['Worker', 'void Worker'],
  ])('refuses %s dynamic-code escape with failsafe at every execution boundary', async (_name, expression) => {
    const guard = deliveryPolicy.createPolicyImportGuard();
    expect(() => guard.check(expression)).toThrow(/Policy defaults runtime import refused/);
    await expect(guard.importModule(expression)).rejects.toThrow(/Policy defaults runtime import refused/);
    const source = readFileSync(join(root, defaultFile), 'utf8');
    put(defaultFile, `${expression};\n${source}`);
    const result = await load();
    expect(policy(result)).toEqual(DELIVERY_POLICY_FAILSAFE);
    expect(result.warnings).toEqual([expect.stringMatching(/failsafe/)]);
    expect(readPolicyEvents({ env })).toMatchObject([{ event: 'policy-defaults-unreadable' }]);
  });
  it('loads benign defaults with dynamic-code words only in strings and comments', async () => {
    const source = readFileSync(join(root, defaultFile), 'utf8');
    const words = 'eval Function .constructor globalThis process require module setTimeout setInterval import.meta WebAssembly Worker';
    put(defaultFile, `// ${words}\n/* ${words} */\nexport const note = ${JSON.stringify(words)};\n${source}`);
    const result = await load();
    expect(policy(result)).toEqual(defaults);
    expect(result.warnings).toEqual([]);
    expect(readPolicyEvents({ env })).toEqual([]);
  });
  it('CLI flattened keys equal the defaults and all nine documented fields', () => {
    const output = JSON.parse(execFileSync(process.execPath, [resolve('scripts/lib/delivery-policy.mjs'), '--json'], { cwd: root, env: { ...process.env, ...env, WE_POLICY_CONFIG: '', GITHUB_ACTIONS: '' }, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }));
    expect(flat(policy(output))).toEqual(flat(defaults));
    expect(flat(policy(output))).toHaveLength(9);
    expect(policy(output)).toEqual(defaults);
  });
});

describe('policy runtime import allow-list', () => {
  it('checks executable output again at the data-URL boundary and permits an approved literal', () => {
    // Exercise native import.meta.resolve, which Vitest's import.meta shim lacks.
    const observed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createPolicyImportGuard } from './scripts/lib/delivery-policy.mjs';
      const guard = createPolicyImportGuard(['node:path']);
      const module = await guard.importModule("export const path = await import('node:path');");
      const source = 'globalThis.__policyImportProbe = true; const x = "node:path"; await import(x);';
      let refusal;
      try { await guard.importModule(source); } catch (error) { refusal = error.message; }
      process.stdout.write(JSON.stringify({ name: module.path.basename('/a/b'), refusal, executed: globalThis.__policyImportProbe === true }), () => process.exit(0));
    `], { cwd: resolve('.'), encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 }));
    expect(observed.name).toBe('b');
    expect(observed.refusal).toMatch(/Policy defaults/);
    expect(observed.executed).toBe(false);
  });

  it('freezes the empty production list and resolves an injected literal allow-list once', () => {
    expect(deliveryPolicy.POLICY_DEFAULTS_IMPORT_ALLOW_LIST).toEqual([]);
    expect(Object.isFrozen(deliveryPolicy.POLICY_DEFAULTS_IMPORT_ALLOW_LIST)).toBe(true);
    const resolveImport = vi.fn(() => 'node:path');
    const guard = deliveryPolicy.createPolicyImportGuard(['path'], resolveImport);
    for (const source of ["import /* gap */ ('path')", "import('node:path')", "import p from 'path';"]) {
      expect(() => guard.check(source)).not.toThrow();
    }
    expect(() => guard.check("require('path')")).toThrow(/Policy defaults runtime import refused/);
    expect(resolveImport).toHaveBeenCalledTimes(1);
    expect(guard.resolve('path')).toBe('node:path');
  });

  it.each([
    "import(x)", 'import(`./${x}`)', "import /* comment */ (x)",
    "import('node:fs')", 'import(`path`)', "import('path' + '')",
    'import.meta', "require(x)", "require('node:fs')", 'const r = require;',
    "export { x } from 'node:fs';", "import x = require('node:fs');", 'import(',
  ])('refuses unknown or incomplete syntax at scan and runtime boundaries: %s', async source => {
    const guard = deliveryPolicy.createPolicyImportGuard(['path'], () => 'node:path');
    expect(() => guard.check(source)).toThrow(/Policy defaults/);
    // Isolate each import shape: an unrelated forbidden global or statement
    // must not be the reason the runtime boundary rejects these exact bytes.
    await expect(guard.importModule(source)).rejects.toThrow(/Policy defaults runtime import refused/);
  });

  it('ignores strings, comments, regexes and erased type imports, but scans template expressions', () => {
    const guard = deliveryPolicy.createPolicyImportGuard();
    expect(() => guard.check(`
      import type { X } from './types';
      import { type Y } from './types';
      type Z = import('./types').Z;
      const text = "import(x); require(x); import.meta";
      const template = \`import(x)\`;
      const regex = /import\\(x\\)/;
      // import(x)
      /* require(x) */
    `)).not.toThrow();
    expect(() => guard.check('const text = `${import(x)}`;')).toThrow(/Policy defaults/);
  });

  it.each([
    'const key = "constructor"; const value = {}[key];',
    'const value = {}.toString;',
    'const value = (() => 1)();',
    'const value = { get answer() { return 1; } };',
    'const value = { ["answer"]: 1 };',
    'const value = { ...{} };',
    'const { value } = {};',
    'const value = `${1 + 1}`;',
  ])('refuses non-data defaults syntax at check and execution boundaries: %s', async source => {
    const guard = deliveryPolicy.createPolicyImportGuard();
    expect(() => guard.check(source)).toThrow(/Policy defaults runtime import refused/);
    await expect(guard.importModule(source)).rejects.toThrow(/Policy defaults runtime import refused/);
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
  it.each([false, true])('refuses a directory-symlink pointer before and after a target swap (cached targets: %s)', async cachedTargets => {
    for (const [variant, onMainRed] of [['strict', 'halt'], ['weak', 'off']]) {
      put(`variants/${variant}/${rootFile}`, { onMainRed });
      if (cachedTargets) {
        put(rootFile, { mergeGate: `./variants/${variant}/${rootFile}` });
        utimesSync(join(root, rootFile), 1000000000, variant === 'strict' ? 1000000000 : 1000000001);
        expect((await load()).mergeGate.onMainRed).toBe(onMainRed);
      }
    }
    const pointer = `./selector/${rootFile}`;
    const source = JSON.stringify({ mergeGate: pointer });
    put(rootFile, source);
    utimesSync(join(root, rootFile), 1000000000, 1000000002);
    const parse = vi.spyOn(JSON, 'parse');
    symlinkSync('variants/strict', join(root, 'selector'), 'dir');
    const strict = await load();
    rmSync(join(root, 'selector'));
    symlinkSync('variants/weak', join(root, 'selector'), 'dir');
    const weak = await load();
    const repeated = await load();
    // The root document is cached across the swap; target trust must still be checked.
    expect(parse.mock.calls.filter(([text]) => text === source)).toHaveLength(1);
    for (const result of [weak, repeated, strict]) {
      expect(result.mergeGate.onMainRed).toBe('halt');
      expect(result.sources.mergeGate.onMainRed).toBe('default');
      expect(result.warnings).toEqual([`Policy symlink refused: ${pointer}`]);
      expect(result.filesRead).toEqual([defaultFile, rootFile]);
    }
  });
  it('refuses a symlinked defaults parent before and after a strict-to-weak swap', async () => {
    const source = readFileSync(join(root, defaultFile), 'utf8');
    put('variants/weak/deliveryPolicyDefaults.ts', source.replace("onMainRed: 'halt'", "onMainRed: 'off'"));
    renameSync(join(root, 'config'), join(root, 'variants/strict'));
    symlinkSync('variants/strict', join(root, 'config'), 'dir');
    const strict = await load();
    rmSync(join(root, 'config'));
    symlinkSync('variants/weak', join(root, 'config'), 'dir');
    const weak = await load();
    const repeated = await load();
    for (const result of [weak, repeated, strict]) {
      expect(policy(result)).toEqual(DELIVERY_POLICY_FAILSAFE);
      expect(result.warnings).toEqual(['Policy defaults unreadable; using most-protective failsafe. Restore the human-gated defaults file.']);
      expect(result.filesRead).toEqual([]);
    }
  });
  it('refuses external WE_POLICY_CONFIG through a symlinked parent in daemon state without reading it', async () => {
    const state = join(dir, 'state');
    mkdirSync(join(state, 'variant'));
    const target = join(state, 'variant/override.json');
    writeFileSync(target, JSON.stringify({ mergeGate: { onMainRed: 'off' } }));
    symlinkSync('variant', join(state, 'selector'), 'dir');
    const result = await load({ env: { ...env, WE_POLICY_CONFIG: join(state, 'selector/override.json') } });
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.warnings).toEqual(['WE_POLICY_CONFIG symlink refused']);
    expect(result.filesRead).toEqual([defaultFile]);
  });
  it('refuses a symlinked WE_POLICY_CONFIG leaf without reading its target', async () => {
    const target = join(dir, 'state/target.json');
    writeFileSync(target, JSON.stringify({ mergeGate: { onMainRed: 'off' } }));
    const path = join(dir, 'state/override.json');
    symlinkSync(target, path);
    const result = await load({ env: { ...env, WE_POLICY_CONFIG: path } });
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.warnings).toEqual(['WE_POLICY_CONFIG symlink refused']);
    expect(result.filesRead).toEqual([defaultFile]);
  });
  it('refuses a WE_POLICY_CONFIG dot-dot escape without reading it', async () => {
    put('../outside.json', { mergeGate: { onMainRed: 'off' } });
    const result = await load({ env: { ...env, WE_POLICY_CONFIG: '../outside.json' } });
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.warnings).toEqual(['WE_POLICY_CONFIG is outside registered repo sources and daemon state']);
    expect(result.filesRead).toEqual([defaultFile]);
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
  it('uses the live registry for base defaults and root config when the base registry is null, but refuses pointers', async () => {
    gate.POLICY_SPEC_BASENAMES.add('repair-policy.json');
    put(rootFile, { prCi: { mainStateParity: 'off' }, mergeGate: './repair-policy.json' });
    put('repair-policy.json', { onMainRed: 'off' });
    repository(['repair-policy.json']);
    put('scripts/lib/gate-config.mjs', "throw Error('unreadable registry');");
    const ref = commit();
    const registry = vi.spyOn(gate, 'readPolicySpecRegistryAt');
    const liveRegistry = vi.spyOn(gate, 'isPolicySpecPath');
    const result = await load({ ref });
    expect(registry).toHaveBeenCalledWith(ref, { root });
    expect(await registry.mock.results[0].value).toBeNull();
    expect(liveRegistry).toHaveBeenCalledWith(defaultFile);
    expect(liveRegistry).toHaveBeenCalledWith(rootFile);
    expect(policy(result)).toEqual({ ...defaults, prCi: { mainStateParity: 'off' } });
    expect(policy(result)).not.toEqual(DELIVERY_POLICY_FAILSAFE);
    expect(result.sources.prCi.mainStateParity).toBe('config');
    expect(result.sources.mergeGate).toEqual({ recheckWhenMainMoved: 'default', recheckMaxAgeMin: 'default', onMainRed: 'default' });
    expect(result.filesRead).toEqual([defaultFile, rootFile]);
    expect(result.warnings).toEqual(['Unregistered policy pointer: repair-policy.json']);
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
  it('returns the most-protective failsafe when the defaults file is unregistered at post-check', async () => {
    put(defaultFile, readFileSync(join(root, defaultFile), 'utf8').replace("onMainRed: 'halt'", "onMainRed: 'off'"));
    put(rootFile, { drain: { onStepRefusal: 'log' } });
    const real = gate.isPolicySpecPath;
    let defaultChecks = 0;
    vi.spyOn(gate, 'isPolicySpecPath').mockImplementation(path => path === defaultFile ? ++defaultChecks === 1 : real(path));
    const result = await load();
    expect(defaultChecks).toBe(2);
    expect(policy(result)).toEqual(DELIVERY_POLICY_FAILSAFE);
    expect(policy(result)).not.toEqual(defaults);
    expect(Object.values(result.sources).flatMap(Object.values)).toEqual(Array(9).fill('default'));
    expect(result.filesRead).toEqual([defaultFile, rootFile]);
    expect(result.warnings).toEqual([`Ungated policy source dropped by post-check: ${defaultFile}`]);
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
  it('rechecks pointer registration on cache hits without a file or mtime change', async () => {
    gate.POLICY_SPEC_BASENAMES.add('repair-policy.json');
    const path = put('repair-policy.json', { onMainRed: 'off' });
    put(rootFile, { mergeGate: './repair-policy.json' });
    const source = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const allowed = await load();
    expect(allowed.mergeGate.onMainRed).toBe('off');
    expect(allowed.sources.mergeGate.onMainRed).toBe('config');
    expect(allowed.filesRead).toEqual([defaultFile, rootFile, 'repair-policy.json']);
    expect(allowed.warnings).toEqual([]);
    reach(allowed);

    gate.POLICY_SPEC_BASENAMES.delete('repair-policy.json');
    const refused = await load();
    expect(readFileSync(path, 'utf8')).toBe(source);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(refused.mergeGate.onMainRed).toBe('halt');
    expect(refused.sources.mergeGate.onMainRed).toBe('default');
    expect(refused.warnings).toEqual(['Unregistered policy pointer: repair-policy.json']);
    expect(refused.filesRead).toEqual([defaultFile, rootFile]);
    reach(refused);
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
  it('env config is JSON only outside Actions', async () => {
    const path = join(dir, 'state/config.txt');
    writeFileSync(path, JSON.stringify({ mergeGate: { onMainRed: 'off' } }));
    const result = await load({ env: { ...env, WE_POLICY_CONFIG: path } });
    expect(result.mergeGate.onMainRed).toBe('halt');
    expect(result.warnings).toEqual(['WE_POLICY_CONFIG must be JSON']);
    reach(result);
  });
  it('ref reads and CLI reject an otherwise valid state-dir JSON env redirect outside Actions', async () => {
    put(rootFile, { mergeGate: { onMainRed: 'halt' } });
    const base = repository();
    const path = join(dir, 'state/config.json');
    writeFileSync(path, JSON.stringify({ mergeGate: { onMainRed: 'off' } }));
    const overrideEnv = { ...env, WE_POLICY_CONFIG: path };
    const local = await load({ env: overrideEnv });
    expect(local.mergeGate.onMainRed).toBe('off');
    expect(local.sources.mergeGate.onMainRed).toBe('config');
    expect(local.warnings).toEqual([]);
    reach(local, [path]);

    const fromRef = await load({ ref: base, env: overrideEnv });
    const fromCli = JSON.parse(execFileSync(process.execPath, [resolve('scripts/lib/delivery-policy.mjs'), '--json', `--ref=${base}`], {
      cwd: root, env: { ...process.env, ...overrideEnv, GITHUB_ACTIONS: '' }, encoding: 'utf8', timeout: 20000,
    }));
    for (const result of [fromRef, fromCli]) {
      expect(result.mergeGate.onMainRed).toBe('halt');
      expect(result.sources.mergeGate.onMainRed).toBe('config');
      expect(result.warnings).toEqual(['WE_POLICY_CONFIG ignored for PR/Actions gates']);
      expect(result.filesRead).toEqual([defaultFile, rootFile]);
      reach(result);
    }
  });
});

describe('policy journal', () => {
  it.each(['stale replacement', 'disappearing lock'])('bounds retries by monotonic time under %s churn', kind => {
    // Patch native ESM bindings only in the child; exercise the real lock checks and
    // generation-guard removal while recreating contention before every open.
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { performance } from 'node:perf_hooks';
      import { dirname } from 'node:path';
      import { appendPolicyJournal } from './scripts/lib/delivery-policy.mjs';
      const [path, kind] = process.argv.slice(1);
      const lock = path + '.lock';
      const originalOpen = fs.openSync;
      let attempts = 0, elapsed = 0;
      Object.defineProperty(performance, 'now', { value: () => elapsed });
      fs.openSync = (file, flags, ...args) => {
        if (file === lock && (flags & fs.constants.O_EXCL)) {
          // A safety cutoff makes the pre-fix infinite retry fail deterministically.
          if (++attempts > 30) throw Error('Lock churn exceeded its monotonic budget');
          elapsed += 100;
          if (kind === 'stale replacement') {
            fs.writeFileSync(lock, '{}');
            fs.utimesSync(lock, 1, 1);
          } else {
            fs.rmSync(lock, { force: true });
            throw Object.assign(Error('lock disappeared'), { code: 'EEXIST' });
          }
        }
        return originalOpen(file, flags, ...args);
      };
      Atomics.wait = () => 'timed-out';
      syncBuiltinESMExports();
      let error;
      try { appendPolicyJournal(path, '{}\\n', { allowedRoots: [dirname(path)] }); }
      catch (caught) { error = caught.message; }
      process.stdout.write(JSON.stringify({ error, attempts, elapsed, journalExists: fs.existsSync(path) }));
    `;
    const result = JSON.parse(execFileSync(process.execPath,
      ['--input-type=module', '-e', script, env.WE_POLICY_EVENTS_FILE, kind],
      { cwd: resolve('.'), encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 }));
    expect(result.error).toMatch(/lock timeout; event not recorded/);
    expect(result.attempts).toBe(10);
    expect(result.elapsed).toBe(1000);
    expect(result.journalExists).toBe(false);
  });

  it('does not reclaim an aged lock with a live pid and refuses within a bounded wait', () => {
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    const owner = JSON.stringify({ pid: process.pid, token: 'live-owner' });
    writeFileSync(lock, owner);
    utimesSync(lock, 1, 1);
    const start = Date.now();
    expect(() => deliveryPolicy.appendPolicyJournal(env.WE_POLICY_EVENTS_FILE, '{}\n', {
      allowedRoots: [dir],
    })).toThrow(/lock timeout; event not recorded/);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(() => recordPolicyEvent({ event: 'refused' }, env)).not.toThrow();
    expect(readPolicyEvents({ env })).toEqual([]);
    expect(readFileSync(lock, 'utf8')).toBe(owner);
  });

  it('reclaims an aged lock with a dead pid', () => {
    const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    }));
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    writeFileSync(lock, JSON.stringify({ pid, token: 'dead-owner' }));
    utimesSync(lock, 1, 1);
    recordPolicyEvent({ event: 'reclaimed' }, env);
    expect(readPolicyEvents({ env })).toMatchObject([{ event: 'reclaimed' }]);
    expect(() => statSync(lock)).toThrow(/ENOENT/);
  });

  it('does not reclaim an aged lock when pid liveness is unknown', () => {
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    const owner = JSON.stringify({ pid: process.pid, token: 'inaccessible-owner' });
    writeFileSync(lock, owner);
    utimesSync(lock, 1, 1);
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(Error('not permitted'), { code: 'EPERM' });
    });
    expect(() => recordPolicyEvent({ event: 'refused' }, env)).not.toThrow();
    expect(probe).toHaveBeenCalledWith(process.pid, 0);
    expect(readPolicyEvents({ env })).toEqual([]);
    expect(readFileSync(lock, 'utf8')).toBe(owner);
  });

  it('refuses an oversized aged lock without reclaiming it', () => {
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    const content = 'x'.repeat(4097);
    writeFileSync(lock, content);
    utimesSync(lock, 1, 1);
    expect(() => deliveryPolicy.appendPolicyJournal(env.WE_POLICY_EVENTS_FILE, '{}\n', {
      allowedRoots: [dir],
    })).toThrow(/Oversized policy journal lock.*Verify no writer/);
    expect(() => recordPolicyEvent({ event: 'refused' }, env)).not.toThrow();
    expect(readPolicyEvents({ env })).toEqual([]);
    expect(readFileSync(lock, 'utf8')).toBe(content);
  });

  it.each(['append', 'best effort'])('aborts %s when the lock token is stolen before the write', mode => {
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { appendPolicyJournal, recordPolicyEvent } from './scripts/lib/delivery-policy.mjs';
      const [envText, mode] = process.argv.slice(1);
      const env = JSON.parse(envText);
      const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
      const original = fs.openSync;
      let owner, sameInode;
      fs.openSync = (path, ...args) => {
        const fd = original(path, ...args);
        if (path === env.WE_POLICY_EVENTS_FILE && (args[0] & fs.constants.O_APPEND)) {
          owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
          const before = fs.statSync(lock);
          fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'stolen' }));
          sameInode = fs.statSync(lock).ino === before.ino;
        }
        return fd;
      };
      syncBuiltinESMExports();
      let error;
      try {
        if (mode === 'append') appendPolicyJournal(env.WE_POLICY_EVENTS_FILE, '{}\\n', {
          allowedRoots: [env.WE_DAEMON_STATE_DIR],
        });
        else recordPolicyEvent({ event: 'refused' }, env);
      } catch (caught) { error = caught.message; }
      process.stdout.write(JSON.stringify({ owner, sameInode, error, pid: process.pid }), () => process.exit(0));
    `;
    const result = JSON.parse(execFileSync(process.execPath,
      ['--input-type=module', '-e', script, JSON.stringify(env), mode],
      { cwd: resolve('.'), encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 }));
    expect(result.owner.pid).toBe(result.pid);
    expect(result.owner.token).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    expect(result.sameInode).toBe(true);
    if (mode === 'append') expect(result.error).toMatch(/lock ownership lost; event not recorded/);
    else expect(result.error).toBeUndefined();
    expect(readFileSync(env.WE_POLICY_EVENTS_FILE, 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(env.WE_POLICY_EVENTS_FILE + '.lock', 'utf8')).token).toBe('stolen');
  });

  it.each(['normal capacity', 'one remaining record'])('serializes stale removers across the validation/unlink gap with %s', async capacity => {
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    if (capacity === 'one remaining record') {
      const at = new Date().toISOString();
      const firstBytes = Buffer.byteLength(JSON.stringify({ at, key: '', event: 'interleaved', subject: 'first', reason: '' }) + '\n');
      const seed = { at, subject: 'seed', padding: '' };
      const paddingBytes = 1024 * 1024 - firstBytes - Buffer.byteLength(JSON.stringify(seed) + '\n');
      writeFileSync(env.WE_POLICY_EVENTS_FILE, JSON.stringify({ ...seed, padding: 'x'.repeat(paddingBytes) }) + '\n');
    }
    writeFileSync(lock, 'stale');
    utimesSync(lock, 1, 1);
    const barrier = new SharedArrayBuffer(8);
    const control = new Int32Array(barrier);
    const workerFile = join(dir, 'journal-reclamation-worker.mjs');
    writeFileSync(workerFile, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { performance } from 'node:perf_hooks';
      import { parentPort, workerData } from 'node:worker_threads';
      const { recordPolicyEvent } = await import(workerData.module);
      const { env, role, barrier } = workerData;
      const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
      const control = new Int32Array(barrier);
      const original = { open: fs.openSync, unlink: fs.unlinkSync, write: fs.writeSync };
      const now = performance.now.bind(performance);
      let barrierMs = 0;
      // Worker startup and parent scheduling while deliberately paused are test
      // orchestration, not lock contention. Keep real time for ordinary retries.
      Object.defineProperty(performance, 'now', { value: () => now() - barrierMs });
      let paused = false, competing = false, survived;
      const compete = kind => {
        if (!competing) { competing = true; parentPort.postMessage({ phase: 'competing', kind }); }
      };
      const wait = index => {
        const start = now();
        try {
          if (Atomics.wait(control, index, 0, 8000) === 'timed-out') throw Error('barrier timed out');
        } finally { barrierMs += now() - start; }
      };
      fs.unlinkSync = (path, ...args) => {
        if (role === 'first' && path === lock && !paused) {
          paused = true;
          parentPort.postMessage({ phase: 'paused' });
          wait(0); // Last identity check has completed; unlink has not run.
        }
        return original.unlink(path, ...args);
      };
      fs.openSync = (path, ...args) => {
        try { return original.open(path, ...args); } catch (error) {
          if (role === 'second' && String(path).endsWith('.reclaim') && error.code === 'EEXIST') compete('contended');
          throw error;
        }
      };
      fs.writeSync = (fd, data, ...args) => {
        if (role === 'second' && String(data).includes('"event":"interleaved"')) {
          const held = fs.lstatSync(lock);
          compete('replacement');
          parentPort.postMessage({ phase: 'held' });
          wait(1); // Hold the replacement while the first remover finishes.
          try {
            const current = fs.lstatSync(lock);
            survived = current.dev === held.dev && current.ino === held.ino;
          } catch { survived = false; }
        }
        return original.write(fd, data, ...args);
      };
      syncBuiltinESMExports();
      recordPolicyEvent({ event: 'interleaved', subject: role }, env);
      parentPort.postMessage({ phase: 'done', survived });
      process.exit(0);
    `);
    const workers = [];
    const start = role => {
      const worker = new Worker(workerFile, { workerData: {
        module: resolve('scripts/lib/delivery-policy.mjs'), env, role, barrier,
      } });
      workers.push(worker);
      const messages = new Map(), waiting = new Map();
      let failure;
      worker.on('message', message => {
        messages.set(message.phase, message);
        waiting.get(message.phase)?.resolve(message);
      });
      worker.on('error', error => {
        failure = error;
        for (const pending of waiting.values()) pending.reject(error);
      });
      return phase => {
        if (failure) return Promise.reject(failure);
        if (messages.has(phase)) return Promise.resolve(messages.get(phase));
        return new Promise((resolve, reject) => waiting.set(phase, { resolve, reject }));
      };
    };
    const resume = index => { Atomics.store(control, index, 1); Atomics.notify(control, index); };
    try {
      const first = start('first');
      await first('paused');
      const second = start('second');
      const competition = await second('competing');
      resume(0);
      await first('done');
      await Promise.race([second('held'), second('done')]);
      resume(1);
      const completed = await second('done');
      if (capacity === 'normal capacity') {
        expect(completed.survived).toBe(true);
        expect(readPolicyEvents({ env }).map(event => event.subject).sort()).toEqual(['first', 'second']);
      } else {
        // The second writer must recheck size after the first appends. Refuse
        // its record rather than growing the journal beyond the reader's bound.
        expect(completed.survived).toBeUndefined();
        expect(statSync(env.WE_POLICY_EVENTS_FILE).size).toBe(1024 * 1024);
        expect(readPolicyEvents({ env }).map(event => event.subject)).toEqual(['seed', 'first']);
      }
      expect(competition.kind).toBe('contended');
      expect(() => statSync(lock)).toThrow(/ENOENT/);
    } finally {
      resume(0); resume(1);
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  }, 15000);

  it('fails closed on an abandoned generation guard and reports operator cleanup without stopping the daemon', () => {
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    writeFileSync(lock, 'stale');
    utimesSync(lock, 1, 1);
    const { dev, ino, birthtimeMs } = statSync(lock);
    const guard = `${lock}.${dev}-${ino}-${birthtimeMs}.reclaim`;
    writeFileSync(guard, 'abandoned');
    utimesSync(guard, 1, 1);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => recordPolicyEvent({ event: 'refused' }, env)).not.toThrow();
    expect(readPolicyEvents({ env })).toEqual([]);
    expect(readFileSync(lock, 'utf8')).toBe('stale');
    expect(readFileSync(guard, 'utf8')).toBe('abandoned');
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/reclamation guard.*verify no writer.*remove/i));
  });

  it.each(['new journal', 'missing directories', 'stale lock'])('serializes two child-process appends with %s into intact JSON lines', async kind => {
    if (kind === 'missing directories') env.WE_POLICY_EVENTS_FILE = join(env.WE_DAEMON_STATE_DIR, 'new/nested/events.jsonl');
    if (kind === 'stale lock') {
      writeFileSync(env.WE_POLICY_EVENTS_FILE + '.lock', 'stale');
      utimesSync(env.WE_POLICY_EVENTS_FILE + '.lock', 1, 1);
    }
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { recordPolicyEvent } from './scripts/lib/delivery-policy.mjs';
      const [envText, subject] = process.argv.slice(1);
      const env = JSON.parse(envText);
      const original = fs.writeSync;
      let writes = 0;
      fs.writeSync = (fd, data, ...args) => {
        if (String(data).includes('"event":"parallel"')) {
          if (!fs.existsSync(env.WE_POLICY_EVENTS_FILE + '.lock')) throw Error('unlocked journal write');
          writes++;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
        }
        return original(fd, data, ...args);
      };
      syncBuiltinESMExports();
      recordPolicyEvent({ key: 'mergeGate', event: 'parallel', subject, detail: 'x'.repeat(500) }, env);
      process.stdout.write(JSON.stringify({ writes }), () => process.exit(0));
    `;
    const children = await Promise.all(['one', 'two'].map(subject => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', script, JSON.stringify(env), subject],
      { cwd: resolve('.'), encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 })));
    for (const child of children) expect(JSON.parse(child.stdout).writes).toBe(1);
    const lines = readFileSync(env.WE_POLICY_EVENTS_FILE, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map(line => JSON.parse(line).subject).sort()).toEqual(['one', 'two']);
    expect(() => statSync(env.WE_POLICY_EVENTS_FILE + '.lock')).toThrow(/ENOENT/);
  });

  it('waits out a lock holder that is slow under host load instead of dropping the event (main-red 545e68a5b)', () => {
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    writeFileSync(lock, 'held');
    // Deterministic stand-in for a loaded host: the holder releases once the writer has
    // asked to sleep 600ms in total, which is longer than the old ten-attempt budget (440ms).
    let requested = 0;
    const sleep = vi.spyOn(Atomics, 'wait').mockImplementation((_cell, _index, _value, ms) => {
      requested += ms;
      if (requested >= 600) rmSync(lock, { force: true });
      return 'timed-out';
    });
    try {
      recordPolicyEvent({ event: 'after-slow-holder' }, env);
    } finally { sleep.mockRestore(); }
    expect(readPolicyEvents({ env })).toMatchObject([{ event: 'after-slow-holder' }]);
  });

  it.each([-3600000, 3600000])('bounds a live lock wait by monotonic time when wall time steps %ims', step => {
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    const owner = JSON.stringify({ pid: process.pid, token: 'live-owner' });
    writeFileSync(lock, owner);
    const wallStart = Date.now();
    let elapsed = 0, wallStep = 0;
    const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const wall = vi.spyOn(Date, 'now').mockImplementation(() => wallStart + elapsed + wallStep);
    const sleep = vi.spyOn(Atomics, 'wait').mockImplementation((_cell, _index, _value, ms) => {
      // The first sleep happens after the deadline is computed. Advance monotonic
      // time by the requested sleep, but step the wall clock independently.
      wallStep = step;
      elapsed += ms;
      if (elapsed >= 2000) throw Error('Lock wait exceeded its monotonic budget');
      return 'timed-out';
    });
    try {
      expect(() => deliveryPolicy.appendPolicyJournal(env.WE_POLICY_EVENTS_FILE, '{}\n', {
        allowedRoots: [dir],
      })).toThrow(/lock timeout; event not recorded/);
      expect(Date.now() - wallStart).toBe(elapsed + step);
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(elapsed).toBeLessThan(1080);
      expect(readFileSync(lock, 'utf8')).toBe(owner);
      expect(readPolicyEvents({ env })).toEqual([]);
    } finally {
      sleep.mockRestore();
      wall.mockRestore();
      monotonic.mockRestore();
    }
  });

  it('refuses a live lock within a bounded wait without stopping the daemon', () => {
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    writeFileSync(lock, 'held');
    const start = Date.now();
    expect(() => recordPolicyEvent({ event: 'refused' }, env)).not.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(readPolicyEvents({ env })).toEqual([]);
    expect(readFileSync(lock, 'utf8')).toBe('held');
  });

  it('reclaims an aged lock and removes its own lock after a failed append', () => {
    const lock = env.WE_POLICY_EVENTS_FILE + '.lock';
    writeFileSync(lock, 'stale');
    utimesSync(lock, 1, 1);
    recordPolicyEvent({ event: 'reclaimed' }, env);
    expect(readPolicyEvents({ env })).toMatchObject([{ event: 'reclaimed' }]);
    expect(() => statSync(lock)).toThrow(/ENOENT/);
    writeFileSync(env.WE_POLICY_EVENTS_FILE, 'x'.repeat(1024 * 1024));
    expect(() => recordPolicyEvent({ event: 'too-large' }, env)).not.toThrow();
    expect(statSync(env.WE_POLICY_EVENTS_FILE).size).toBe(1024 * 1024);
    expect(() => statSync(lock)).toThrow(/ENOENT/);
  });

  it('refuses a symlink lock without following or removing its target', () => {
    const target = join(env.WE_DAEMON_STATE_DIR, 'target');
    writeFileSync(target, 'untouched');
    symlinkSync(target, env.WE_POLICY_EVENTS_FILE + '.lock');
    recordPolicyEvent({ event: 'refused' }, env);
    expect(readPolicyEvents({ env })).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('refuses oversized raw records before writing and exposes the bound to its best-effort caller', () => {
    expect(() => deliveryPolicy.appendPolicyJournal(env.WE_POLICY_EVENTS_FILE, 'x'.repeat(4097), {
      allowedRoots: [env.WE_DAEMON_STATE_DIR],
    })).toThrow(/oversized.*record/i);
    expect(readPolicyEvents({ env })).toEqual([]);
  });

  it.each(['leaf', 'parent'])('refuses a symlinked journal %s for both append and read', kind => {
    const state = env.WE_DAEMON_STATE_DIR;
    mkdirSync(join(state, 'target'));
    const target = join(state, 'target/events.jsonl');
    const original = JSON.stringify({ at: new Date().toISOString(), event: 'untrusted' }) + '\n';
    writeFileSync(target, original);
    const path = join(state, kind === 'leaf' ? 'linked.jsonl' : 'linked/events.jsonl');
    symlinkSync(kind === 'leaf' ? target : join(state, 'target'), join(state, kind === 'leaf' ? 'linked.jsonl' : 'linked'));
    const journalEnv = { ...env, WE_POLICY_EVENTS_FILE: path };
    recordPolicyEvent({ key: 'mergeGate', event: 'refused' }, journalEnv);
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(readPolicyEvents({ env: journalEnv })).toEqual([]);
  });

  it('refuses an escaping journal without creating parents, and ignores oversized journals', () => {
    const outsideEnv = { ...env, WE_POLICY_EVENTS_FILE: join(dir, 'outside/missing/events.jsonl') };
    recordPolicyEvent({ event: 'refused' }, outsideEnv);
    expect(() => statSync(join(dir, 'outside'))).toThrow(/ENOENT/);
    expect(readPolicyEvents({ env: outsideEnv })).toEqual([]);
    const oversized = ' '.repeat(1024 * 1024 + 1);
    writeFileSync(env.WE_POLICY_EVENTS_FILE, oversized);
    recordPolicyEvent({ event: 'refused' }, env);
    expect(readFileSync(env.WE_POLICY_EVENTS_FILE, 'utf8')).toBe(oversized);
    expect(readPolicyEvents({ env })).toEqual([]);
  });

  it('creates missing journal directories and reads the default journal in the configured logs root', () => {
    const logs = join(dir, 'new-logs/nested');
    const journalEnv = { WE_DAEMON_STATE_DIR: env.WE_DAEMON_STATE_DIR, HEALTH_WATCH_LOGS_DIR: logs };
    recordPolicyEvent({ key: 'mergeGate', event: 'refused' }, journalEnv);
    expect(readPolicyEvents({ env: journalEnv })).toMatchObject([{ key: 'mergeGate', event: 'refused' }]);
    expect(statSync(join(logs, 'policy-events.jsonl')).isFile()).toBe(true);
  });

  it('records the reported eight-level shared array graph within a bounded child process', () => {
    execFileSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', `
      import { recordPolicyEvent } from './scripts/lib/delivery-policy.mjs';
      const detail = Array.from({ length: 8 }).reduce(previous => Array(20).fill(previous), 'x');
      recordPolicyEvent({ key: 'mergeGate', event: 'refused', subject: 'PR 1', detail }, JSON.parse(process.argv[1]));
    `, JSON.stringify(env)], { cwd: resolve('.'), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 });
    expect(readPolicyEvents({ env })).toMatchObject([{ key: 'mergeGate', event: 'refused', subject: 'PR 1' }]);
    expect(Buffer.byteLength(readFileSync(env.WE_POLICY_EVENTS_FILE))).toBeLessThanOrEqual(4096);
  });

  it.each(['array', 'object', 'mixed'])('visits shared %s descendants once and resets traversal for each event', shape => {
    let reads = 0;
    const leaf = { get value() { if (++reads > 2) throw new Error('repeated shared expansion'); return 'kept'; } };
    const shared = shape === 'array' ? [leaf] : { leaf };
    const detail = shape === 'object' ? { first: shared, second: shared } : [shared, shared];
    for (let i = 0; i < 2; i++) recordPolicyEvent({ key: 'mergeGate', event: 'refused', subject: 'PR 1', detail }, env);
    const expected = shape === 'object'
      ? { first: { leaf: { value: 'kept' } }, second: null }
      : [shape === 'array' ? [{ value: 'kept' }] : { leaf: { value: 'kept' } }, null];
    expect(reads).toBe(2);
    expect(readPolicyEvents({ env }).map(event => event.detail)).toEqual([expected, expected]);
  });

  it('bounds total traversal of distinct descendants before serialization and preserves the event', () => {
    let reads = 0;
    const tree = depth => {
      const value = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), null]));
      for (const key of Object.keys(value)) Object.defineProperty(value, key, { enumerable: true, get() {
        if (++reads > 256) throw new Error('unbounded traversal');
        return depth ? tree(depth - 1) : 'leaf';
      } });
      return value;
    };
    recordPolicyEvent({ key: 'mergeGate', event: 'refused', subject: 'PR 1', detail: tree(6) }, env);
    expect(reads).toBeLessThanOrEqual(256);
    expect(readPolicyEvents({ env })).toMatchObject([{ key: 'mergeGate', event: 'refused', subject: 'PR 1' }]);
    expect(Buffer.byteLength(readFileSync(env.WE_POLICY_EVENTS_FILE))).toBeLessThanOrEqual(4096);
  });

  it('does not read object values beyond the field limit and handles cycles', () => {
    const detail = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i]));
    Object.defineProperty(detail, 'outside', { enumerable: true, get() { throw new Error('outside field limit'); } });
    recordPolicyEvent({ key: 'mergeGate', event: 'refused', subject: 'PR 1', detail }, env);
    const cycle = { value: 'kept' };
    cycle.self = cycle;
    recordPolicyEvent({ key: 'mergeGate', event: 'refused', subject: 'PR 2', detail: cycle }, env);
    expect(readPolicyEvents({ env }).map(event => event.detail)).toEqual([
      Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i])),
      { value: 'kept', self: null },
    ]);
  });

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

describe('policy file path identity', () => {
  const entry = (name, link = false) => ({ name, isSymbolicLink: () => link, isFile: () => !link });
  const listAt = listing => dir => dir === root ? listing : readdirSync(dir, { withFileTypes: true });
  const hostile = { mergeGate: { onMainRed: 'off' } };
  it.each([
    ['case alias', () => [entry('WebEverything.config.json')]],
    ['symlink', () => [entry(rootFile, true)]],
    ['unicode variant', () => [entry('webeverything.config.json\u0301')]],
  ])('refuses the conventional root file when its stored entry is a %s', async (_name, listing) => {
    put(rootFile, hostile);
    const result = await load({ readdir: listAt(listing()) });
    expect(result.mergeGate.onMainRed).toBe(defaults.mergeGate.onMainRed);
    expect(result.warnings).toEqual([expect.stringMatching(/policy config/)]);
  });
  it('accepts the exact stored name', async () => {
    put(rootFile, hostile);
    const result = await load({ readdir: listAt([entry(rootFile)]) });
    expect(result.mergeGate.onMainRed).toBe('off');
  });
  it('refuses NFC/NFD variants of a stored name', () => {
    const nfc = 'caf\u00e9.json', nfd = nfc.normalize('NFD');
    const check = (stored, wanted) => deliveryPolicy.assertStoredEntryName('d', wanted, () => [entry(stored)]);
    expect(() => check(nfc, nfc)).not.toThrow();
    expect(() => check(nfd, nfc)).toThrow(/identity/);
    expect(() => check(nfc, nfd)).toThrow(/identity/);
  });
});
