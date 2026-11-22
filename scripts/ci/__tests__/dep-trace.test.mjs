/**
 * @file scripts/ci/__tests__/dep-trace.test.mjs
 * @description S2 tracer evidence with isolated real-child regressions for Node runtime contracts.
 */
import { describe, it, expect, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { activateTrace, createTracer, startTrace, mergeTraces, compareCoverage, nodeBinary } from '../dep-trace.mjs';
import { initialize, load } from '../dep-trace-loader.mjs';
import { runTraceCoverage } from '../../readiness/trace-coverage.mjs';

const root = process.cwd();
const test = 'fake.test.mjs';
const hookUrl = pathToFileURL(resolve(root, 'scripts/ci/dep-trace.mjs')).href;
/** Counts reads of caller code (getters, traps, toString) that only the tracer could make in a mocked call. */
let reads = 0;
const count = () => { reads++; return 'x'; };
function fixture(extra = {}) {
  const record = vi.fn();
  const env = { WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts', NODE_OPTIONS: `--conditions=original --import=${JSON.stringify(hookUrl)}` };
  const fs = Object.fromEntries(['readFileSync', 'readFile', 'readdirSync', 'existsSync'].map(name => [name, vi.fn(() => 'result')]));
  fs.statSync = vi.fn(file => {
    if (!file.endsWith('script.mjs')) throw new Error('missing');
    return { isFile: () => true };
  });
  const child_process = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'fork'].map(name => [name, vi.fn(() => 'child')]));
  const originals = { ...child_process };
  // Mocked children: 'node' and the running binary count as Node; nodeBinary itself is tested against real files.
  const isNodeBinary = command => command === 'node' || command === process.execPath;
  const tracer = createTracer({ test, root, record, env, fs, child_process, isNodeBinary, ...extra });
  tracer.install();
  return { tracer, fs, child_process, originals, record, env };
}

describe('shadow dependency tracer', () => {
  /**
   * Runs `source` under `node -e`; traced runs activate through NODE_OPTIONS, as documented.
   * The suite's own test-cache tracer would otherwise rewrite these children's env; load its no-op mode explicitly.
   */
  function runChild(source, { traced = true, nodeOptions = '' } = {}) {
    const dir = mkdtempSync(resolve(tmpdir(), 'dep-trace-'));
    const base = `--import ${pathToFileURL(resolve(root, 'scripts/test-cache/child-tracer.mjs')).href} ${nodeOptions}`.trim();
    const env = { ...process.env, WE_TRACE_FILE: '', NODE_OPTIONS: base };
    for (const key of ['WE_TRACE_TEST', 'WE_TRACE_DIR', 'WE_CI_SELECTION']) delete env[key];
    if (traced) Object.assign(env, { NODE_OPTIONS: `${base} --import=${JSON.stringify(hookUrl)}`,
      WE_TRACE_TEST: test, WE_TRACE_DIR: dir, WE_CI_SELECTION: JSON.stringify({ trace: { enabled: true } }) });
    try {
      const result = spawnSync(process.execPath, ['-e', source], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      const file = resolve(dir, `trace-${result.pid}.json`);
      return { result, parent: traced && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const tracedChild = source => runChild(source).result;
  it('runs an env:{} child of a NODE_OPTIONS=--input-type=module parent unchanged and reports incomplete', () => {
    const { result, parent } = runChild(`
      import { spawnSync } from 'node:child_process';
      const child = spawnSync(process.execPath, ['-e', 'require("node:fs"); process.stdout.write("cjs-ok")'], { env: {}, encoding: 'utf8' });
      process.stdout.write(JSON.stringify({ status: child.status, stdout: child.stdout }));
      process.exitCode = child.status;
    `, { nodeOptions: '--input-type=module' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: 0, stdout: 'cjs-ok' });
    expect(parent).toMatchObject({ test, incomplete: true });
  });
  it.each([
    ['frozen options', `cp.spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], Object.freeze({ encoding: 'utf8' })).stdout`, false],
    ['Buffer cwd', `cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: Buffer.from(os.tmpdir()), encoding: 'utf8' }).stdout`, false],
    ['env:{}', `cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => /^(WE_|NODE_OPTIONS$)/.test(k))))'], { env: {}, encoding: 'utf8' }).stdout`, true],
    ['promisify', `(await util.promisify(cp.execFile)(process.execPath, ['-e', 'process.stdout.write("ok")'])).stdout`, false],
    // PR #7123 send-back 1: the child exits 7 unless it sees the getter's FIRST value, so a second read by the tracer fails it.
    ['env getter read once', `(() => { let n = 0; const env = Object.defineProperty({ ...process.env }, 'PROBE', { enumerable: true, get: () => (n++ ? 'second' : 'first') });
      const child = cp.spawnSync(process.execPath, ['-e', 'process.exit(process.env.PROBE === "first" ? 0 : 7)'], { env });
      if (child.status !== 0) throw new Error('child exited ' + child.status); return child.status; })()`, true],
    // PR #7123 send-back 2: a non-Node child never loads the hook, so its reads are untraced.
    ['execSync cat', `cp.execSync('cat package.json').length > 0`, true],
  ])('a traced %s child exits and prints exactly as an untraced one', (_label, expression, incomplete) => {
    const source = `const cp = require('node:child_process'), os = require('node:os'), util = require('node:util');
      (async () => { process.stdout.write(String(${expression})); })().catch(e => { process.stderr.write(String(e)); process.exitCode = 1; });`;
    const plain = runChild(source, { traced: false }).result;
    const { result, parent } = runChild(source);
    expect(plain.status, plain.stderr).toBe(0);
    expect({ status: result.status, signal: result.signal, stdout: result.stdout })
      .toEqual({ status: plain.status, signal: plain.signal, stdout: plain.stdout });
    expect(parent).toMatchObject({ test, incomplete });
  });
  it.each([1, 2])('preserves a real traced child synchronous 65536-byte write to captured fd %s', fd => {
    const result = tracedChild(`require('node:fs').writeFileSync(${fd}, Buffer.alloc(65536, 'x'))`);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr.slice(-2048)).toBe(0);
    expect(Buffer.byteLength(fd === 1 ? result.stdout : result.stderr)).toBe(65536);
  });
  it.each(['spawnSync', 'execFileSync'])('accepts frozen encoding options in a real traced %s call', name => {
    const result = tracedChild(`
      const cp = require('node:child_process');
      const result = cp.${name}(process.execPath, ['-e', 'process.stdout.write("ok")'], Object.freeze({ encoding: 'utf8' }));
      process.stdout.write(${JSON.stringify(name)} === 'spawnSync' ? result.stdout : result);
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('ok');
  });
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'])('%s passes frozen options with an inherited cwd through untouched', name => {
    const f = fixture();
    const options = Object.freeze(Object.create({ cwd: 'scripts' }, {
      encoding: { value: 'utf8', enumerable: true },
      env: { value: Object.freeze({ CUSTOM: 'yes' }), enumerable: false },
    }));
    const args = ['script.mjs'];
    expect(f.child_process[name]('node', args, options)).toBe('child');
    const passed = f.originals[name].mock.calls[0];
    expect(passed).toHaveLength(3);
    expect(passed[1]).toBe(args);
    expect(passed[2]).toBe(options);
    expect(f.tracer.snapshot()).toMatchObject({ incomplete: true, edges: [{ file: 'scripts/script.mjs', kind: 'spawn' }] });
  });
  const shapes = () => {
    const cb = () => {};
    return [
      ['command only', ['node']],
      ['args only', ['node', ['script.mjs']]],
      ['undefined args then options', ['node', undefined, { cwd: '/' }, cb]],
      ['null args then options', ['node', null, { env: { ONLY: 'x' } }]],
      ['null options placeholder', ['node', [], null, cb]],
      ['undefined options placeholder', ['node', [], undefined, cb]],
      ['callback in the args slot', ['script.mjs', cb]],
      ['options in the args slot', ['script.mjs', { cwd: root }]],
      ['env:{}', ['node', [], { env: {} }]],
      ['numeric NODE_OPTIONS', ['node', [], { env: { NODE_OPTIONS: 7 } }]],
      ['Symbol NODE_OPTIONS', ['node', [], { env: { NODE_OPTIONS: Symbol('opts') } }]],
      ['Buffer cwd', ['node', ['script.mjs'], { cwd: Buffer.from(resolve(root, 'scripts')) }]],
      ['number cwd', ['node', ['script.mjs'], { cwd: 7 }]],
      ['throwing env getter', ['node', [], { get env() { throw new Error('getter'); } }]],
    ];
  };
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'fork'].flatMap(name => shapes().map(([label, args]) => [name, label, args])))(
    '%s hands Node the exact caller arguments: %s', (name, _label, args) => {
      const f = fixture();
      const receiver = { marker: true };
      let seen;
      f.originals[name].mockImplementation(function () { seen = this; return 'child'; });
      expect(Reflect.apply(f.child_process[name], receiver, args)).toBe('child');
      const passed = f.originals[name].mock.calls[0];
      expect(passed).toHaveLength(args.length);
      passed.forEach((value, i) => expect(value).toBe(args[i]));
      expect(seen).toBe(receiver);
    });
  it.each(['working', 'missing', 'throws'])('restores blocking streams after loader registration with %s stdout handle', mode => {
    const order = [];
    const stdout = mode === 'missing' ? {} : { _handle: { setBlocking(value) {
      expect(value).toBe(true);
      order.push('stdout');
      if (mode === 'throws') throw new Error('closed stream');
    } } };
    const stderr = { _handle: { setBlocking: vi.fn(value => { expect(value).toBe(true); order.push('stderr'); }) } };
    activateTrace({ WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts' }, { maxEdgesPerTest: 5000 }, {
      fs: {}, child_process: {}, process: { stdout, stderr, once: vi.fn() },
      register: () => order.push('register'), syncBuiltinESMExports: () => order.push('sync'),
      MessageChannel: class { constructor() { this.port1 = { on: vi.fn(), unref: vi.fn() }; this.port2 = {}; } },
    });
    expect(order).toEqual(mode === 'missing' ? ['register', 'stderr', 'sync'] : ['register', 'stdout', 'stderr', 'sync']);
  });
  it('does nothing without both environment keys or when disabled', async () => {
    const activate = vi.fn();
    const loadSettings = vi.fn(() => { throw new Error('must not load settings'); });
    for (const env of [{}, { WE_TRACE_TEST: test }, { WE_TRACE_DIR: 'artifacts' }]) {
      await startTrace({ env, activate, loadSettings, settings: { get enabled() { throw new Error('must not read settings'); } } });
    }
    await startTrace({ env: { WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts' }, settings: { enabled: false }, activate, loadSettings });
    expect(activate).not.toHaveBeenCalled();
    expect(loadSettings).not.toHaveBeenCalled();
  });
  it('activates only the injected runtime with configured bounds', async () => {
    const activate = vi.fn();
    const env = { WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts' };
    await startTrace({ env, settings: { enabled: true, maxEdgesPerTest: 4 }, activate });
    expect(activate).toHaveBeenCalledWith(env, { enabled: true, maxEdgesPerTest: 4 });
  });
  it.each([
    ['disabled', '{"trace":{"enabled":false,"maxEdgesPerTest":4}}', null],
    ['bounded', '{"trace":{"enabled":true,"maxEdgesPerTest":4}}', 4],
    ['zero cap', '{"trace":{"maxEdgesPerTest":0}}', 0],
    ['malformed JSON', '{', 5000],
    ['null JSON', 'null', 5000],
    ['invalid leaves', '{"trace":{"enabled":"no","maxEdgesPerTest":-1}}', 5000],
    ['fractional cap', '{"trace":{"maxEdgesPerTest":1.5}}', 5000],
    ['unsafe cap', '{"trace":{"maxEdgesPerTest":9007199254740992}}', 5000],
  ])('honours fallback settings after loader failure: %s', async (_label, raw, cap) => {
    const env = { WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts', WE_CI_SELECTION: raw };
    const activate = vi.fn();
    const loadSettings = vi.fn(async () => { throw new Error('settings import unavailable'); });
    await startTrace({ env, activate, loadSettings });
    expect(loadSettings).toHaveBeenCalledWith(env);
    if (cap === null) expect(activate).not.toHaveBeenCalled();
    else expect(activate).toHaveBeenCalledWith(env, { enabled: true, maxEdgesPerTest: cap });
  });
  it('records BOTH a started script and its JSON read in a child that inherits the trace env', () => {
    const parent = fixture();
    parent.child_process.spawn('node', ['script.mjs']);
    expect(parent.originals.spawn.mock.calls[0]).toEqual(['node', ['script.mjs']]);
    const child = fixture();
    child.fs.readFileSync('settings.json', 'utf8');
    expect(mergeTraces([parent.tracer.snapshot(), child.tracer.snapshot()])).toEqual({
      tests: { [test]: { 'script.mjs': ['spawn'], 'settings.json': ['read'] } }, incomplete: [],
    });
  });
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'])('%s records the spawn edge against the child cwd', name => {
    const f = fixture();
    f.child_process[name]('node', ['script.mjs', 'missing.json'], { cwd: 'scripts' }, vi.fn());
    expect(f.tracer.snapshot().edges).toEqual([{ file: 'scripts/script.mjs', kind: 'spawn' }]);
  });
  const traceEnv = (extra = {}) => ({ WE_TRACE_TEST: test, WE_TRACE_DIR: resolve(root, 'artifacts'),
    NODE_OPTIONS: `--import=${JSON.stringify(hookUrl)}`, ...extra });
  it.each([
    ['inherited process env', undefined, false],
    ['falsy env falls back to process env', { env: false }, false],
    ['explicit env carrying the hook', { env: traceEnv() }, false],
    ['hook as a separate --import word', { env: traceEnv({ NODE_OPTIONS: `--conditions=x --import ${hookUrl}` }) }, false],
    ['hook as a quoted file path', { env: traceEnv({ NODE_OPTIONS: `--import="${resolve(root, 'scripts/ci/dep-trace.mjs')}"` }) }, false],
    ['inherited (prototype) env keys', { env: Object.create(traceEnv()) }, false],
    ['relative trace dir under the same cwd', { env: traceEnv({ WE_TRACE_DIR: 'artifacts' }) }, false],
    ['env:{}', { env: {} }, true],
    ['env without the hook', { env: traceEnv({ NODE_OPTIONS: '--conditions=x' }) }, true],
    ['hook only named, not imported', { env: traceEnv({ NODE_OPTIONS: `--require=${hookUrl}` }) }, true],
    ['hook after a tab, which Node does not split on', { env: traceEnv({ NODE_OPTIONS: `--conditions=x\t--import=${hookUrl}` }) }, true],
    ['hook inside a quoted other value',{ env: traceEnv({ NODE_OPTIONS: `--title="--import=${hookUrl}"` }) }, true],
    ['numeric NODE_OPTIONS', { env: traceEnv({ NODE_OPTIONS: 7 }) }, true],
    ['Symbol NODE_OPTIONS', { env: traceEnv({ NODE_OPTIONS: Symbol('opts') }) }, true],
    ['missing test identity', { env: traceEnv({ WE_TRACE_TEST: undefined }) }, true],
    ['other test identity', { env: traceEnv({ WE_TRACE_TEST: 'other.test.mjs' }) }, true],
    ['missing trace dir', { env: traceEnv({ WE_TRACE_DIR: undefined }) }, true],
    ['relative trace dir under another cwd', { cwd: 'scripts', env: traceEnv({ WE_TRACE_DIR: 'artifacts' }) }, true],
    ['other settings override', { env: traceEnv({ WE_CI_SELECTION: '{"trace":{"enabled":false}}' }) }, true],
    ['non-enumerable test identity', { env: Object.defineProperty(traceEnv({ WE_TRACE_TEST: undefined }), 'WE_TRACE_TEST', { value: test, enumerable: false }) }, true],
    ['throwing env getter', { get env() { throw new Error('getter'); } }, true],
  ])('flags incomplete evidence from the child real env: %s', (_label, options, incomplete) => {
    const f = fixture();
    f.child_process.spawn('node', [], ...(options === undefined ? [] : [options]));
    expect(f.tracer.snapshot().incomplete).toBe(incomplete);
    expect(f.originals.spawn).toHaveBeenCalledTimes(1);
  });
  // PR #7123 send-back 2: a shell runs first, so even `node -e 0` through execSync is not provably traced.
  it('observes execSync, which bypasses the exported spawnSync, and flags its shell child incomplete', () => {
    const f = fixture();
    f.child_process.execSync('node -e 0', { encoding: 'utf8' });
    expect(f.originals.execSync.mock.calls[0]).toEqual(['node -e 0', { encoding: 'utf8' }]);
    expect(f.tracer.snapshot().incomplete).toBe(true);
  });
  it.each([
    ['execSync cat', f => f.child_process.execSync('cat package.json'), true],
    ['spawnSync cat', f => f.child_process.spawnSync('cat', ['package.json']), true],
    ['execFile of a shell', f => f.child_process.execFile('/bin/sh', ['-c', 'cat x']), true],
    ['spawn node with shell: true', f => f.child_process.spawn('node', ['-e', '0'], { shell: true }), true],
    ['spawn node with a shell path', f => f.child_process.spawn('node', [], { shell: '/bin/bash' }), true],
    ['fork with a non-Node execPath', f => f.child_process.fork('script.mjs', [], { execPath: '/bin/cat' }), true],
    ['spawn of the running Node binary', f => f.child_process.spawn(process.execPath, ['-e', '0']), false],
    ['spawn node by name', f => f.child_process.spawnSync('node', ['-e', '0']), false],
    ['spawn of another binary named node', f => f.child_process.spawnSync('/opt/other/node', ['-e', '0']), true],
    ['node --run (a package script through a shell)', f => f.child_process.spawn('node', ['--run', 'build']), true],
    ['node --permission (the hook may not load)', f => f.child_process.spawnSync('node', ['--permission', 'script.mjs']), true],
    ['node --check=…', f => f.child_process.execFileSync('node', ['--check=1', 'script.mjs']), true],
    ['fork with a --permission execArgv', f => f.child_process.fork('script.mjs', [], { execArgv: ['--permission'] }), true],
    ['fork with a getter execArgv element', f => f.child_process.fork('script.mjs', [], { execArgv: Object.defineProperty([], 0, { enumerable: true, get: count }) }), true],
    ['fork with plain execArgv', f => f.child_process.fork('script.mjs', [], { execArgv: ['--conditions=x'] }), false],
    ['NODE_OPTIONS carrying --permission', f => f.child_process.spawn('node', [], { env: traceEnv({ NODE_OPTIONS: `--permission --import=${hookUrl}` }) }), true],
    ['a huge sparse args array, bounded', f => f.child_process.spawn('node', new Array(2 ** 32 - 1)), true],    ['fork with no execPath', f => f.child_process.fork('script.mjs'), false],
    ['fork with execPath Node', f => f.child_process.fork('script.mjs', [], { execPath: process.execPath }), false],
  ])('a non-Node child marks the trace incomplete: %s', (_label, call, incomplete) => {
    const f = fixture();
    call(f);
    expect(f.tracer.snapshot().incomplete).toBe(incomplete);
  });
  // PR #7123 send-back 1: Node reads every caller value again, so the tracer must never run a getter, Proxy trap
  // or toString itself; such a value marks the trace incomplete and reaches Node untouched.
  it.each([
    ['env own getter', () => [{ env: Object.defineProperty(traceEnv(), 'PROBE', { enumerable: true, get: count }) }]],
    ['env inherited getter', () => [{ env: Object.create(Object.defineProperty(traceEnv(), 'PROBE', { enumerable: true, get: count })) }]],
    ['env Proxy', () => [{ env: new Proxy(traceEnv(), { get: (t, k) => (count(), t[k]), ownKeys: t => (count(), Reflect.ownKeys(t)) }) }]],
    ['env with a Proxy prototype', () => [{ env: Object.create(new Proxy(traceEnv(), { get: (t, k) => (count(), t[k]) })) }]],
    ['env object value with toString', () => [{ env: traceEnv({ PROBE: { toString: count } }) }]],
    ['options.env getter', () => [{ get env() { return count(), traceEnv(); } }]],
    ['options.cwd getter', () => [{ env: traceEnv(), get cwd() { return count(), root; } }]],
    ['options.shell getter', () => [{ env: traceEnv(), get shell() { return count(), false; } }]],
    ['options Proxy', () => [new Proxy({ env: traceEnv() }, { get: (t, k) => (count(), t[k]) })]],
    ['duck-typed URL cwd with getters', () => [{ env: traceEnv(), cwd: { get href() { return count(), 'file:///'; }, protocol: 'file:' } }]],
  ])('never runs caller code and flags incomplete: %s', (_label, make) => {
    reads = 0;
    const f = fixture();
    const [options] = make();
    f.child_process.spawn('node', ['script.mjs'], options);
    expect(reads).toBe(0);
    expect(f.originals.spawn.mock.calls[0][2]).toBe(options);
    expect(f.tracer.snapshot().incomplete).toBe(true);
  });
  it('never runs an args-array getter or Proxy and flags incomplete', () => {
    reads = 0;
    const f = fixture();
    const list = Object.defineProperty(['script.mjs'], 1, { enumerable: true, get: count });
    f.child_process.spawn('node', list, { env: traceEnv() });
    f.child_process.spawnSync('node', new Proxy(['script.mjs'], { get: (t, k) => (count(), t[k]) }), { env: traceEnv() });
    expect(reads).toBe(0);
    expect(f.originals.spawn.mock.calls[0][1]).toBe(list);
    expect(f.tracer.snapshot()).toMatchObject({ incomplete: true, edges: [] });
  });
  it('never runs a getter on an fs path, and flags the unreadable path incomplete', () => {
    reads = 0;
    const f = fixture();
    const target = { get href() { return count(), pathToFileURL(resolve(root, 'a.json')).href; }, protocol: 'file:' };
    expect(f.fs.readFileSync(target)).toBe('result');
    expect(reads).toBe(0);
    expect(f.tracer.snapshot()).toMatchObject({ incomplete: true, edges: [] });
  });
  it('nodeBinary accepts only the running Node binary, by path or first on an absolute PATH', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'dep-trace-node-'));
    try {
      writeFileSync(resolve(dir, 'node'), '#!/bin/sh\ncat "$@"\n', { mode: 0o755 });
      expect(nodeBinary(process.execPath, undefined, null)).toBe(true);
      expect(nodeBinary('node', dirname(realpathSync(process.execPath)), root)).toBe(true);
      expect(nodeBinary('node', `${dir}:${dirname(realpathSync(process.execPath))}`, root)).toBe(false);
      expect(nodeBinary(resolve(dir, 'node'), undefined, root)).toBe(false);
      expect(nodeBinary('node', undefined, root)).toBe(false);
      expect(nodeBinary('node', `bin:${dirname(process.execPath)}`, root)).toBe(false);
      expect(nodeBinary('cat', '/bin:/usr/bin', root)).toBe(false);
      expect(nodeBinary('./node', dirname(process.execPath), null)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('judges an inheriting child by the live process.env, as Node does at call time', () => {
    const env = traceEnv();
    const runtime = { once: vi.fn(), env };
    const cp = { spawn: vi.fn() };
    const tracer = activateTrace(env, { maxEdgesPerTest: 5000 }, {
      fs: {}, child_process: cp, process: runtime, register: vi.fn(), syncBuiltinESMExports: vi.fn(),
      MessageChannel: class { constructor() { this.port1 = { on: vi.fn(), unref: vi.fn() }; this.port2 = {}; } },
    });
    cp.spawn(process.execPath, ['-e', '0']);
    expect(tracer.incomplete).toBe(false);
    runtime.env = { ...env, WE_TRACE_DIR: resolve(root, 'elsewhere') };
    cp.spawn(process.execPath, ['-e', '0']);
    expect(tracer.incomplete).toBe(true);
  });
  it('wrappers keep the original name and length', () => {
    const cp = { spawn: function spawn(a, b, c) { return [a, b, c]; } };
    const io = { readFileSync: function readFileSync(p, o) { return [p, o]; }, promises: { readdir: async function readdir(p) { return p; } } };
    createTracer({ test, root, env: {}, fs: io, child_process: cp }).install();
    expect([cp.spawn.name, cp.spawn.length, io.readFileSync.name, io.readFileSync.length, io.promises.readdir.name])
      .toEqual(['spawn', 3, 'readFileSync', 2, 'readdir']);
  });
  it('reads fs paths as Node does: a file: string is literal, a URL object converts from its pathname', () => {
    const f = fixture();
    f.fs.readFileSync(pathToFileURL(resolve(root, 'package.json')).href);
    f.fs.readFileSync({ href: 'file:///wrong', protocol: 'file:', hostname: '', pathname: resolve(root, 'a.json') });
    f.tracer.add(pathToFileURL(resolve(root, 'loaded.mjs')).href, 'load');
    const files = f.tracer.snapshot().edges.map(edge => edge.file);
    expect(files).toContain('a.json');
    expect(files).toContain('loaded.mjs');
    expect(files).not.toContain('package.json');
    expect(files).not.toContain('wrong');
  });
  it('never calls a patched Buffer.from, and bounds a huge Buffer path', () => {
    const f = fixture();
    const path = Buffer.from(resolve(root, 'a.json'));
    const from = vi.spyOn(Buffer, 'from');
    try { f.fs.readFileSync(path); } finally { from.mockRestore(); }
    expect(from).not.toHaveBeenCalled();
    expect(f.tracer.snapshot()).toMatchObject({ incomplete: false, edges: [{ file: 'a.json', kind: 'read' }] });
    f.fs.readFileSync(Buffer.alloc(70000, 'a'));
    expect(f.tracer.snapshot().incomplete).toBe(true);
  });
  it('still traces getter-free env, inherited data keys, node:url and happy-dom URLs, and Buffer subclasses', () => {
    const f = fixture();
    class Path extends Uint8Array { get buffer() { throw new Error('user getter'); } }
    f.child_process.spawn('node', ['script.mjs'], { env: Object.create(traceEnv()), cwd: new URL(pathToFileURL(root).href) });
    f.child_process.spawn('node', ['script.mjs'], { env: traceEnv(), cwd: new Path(Buffer.from(resolve(root, 'scripts'))) });
    expect(f.tracer.snapshot()).toEqual({ test, truncated: false, incomplete: false,
      edges: [{ file: 'script.mjs', kind: 'spawn' }, { file: 'scripts/script.mjs', kind: 'spawn' }] });
  });
  it('flags a child that inherits a process env whose trace identity setup removed', () => {
    const f = fixture();
    delete f.env.WE_TRACE_TEST;
    f.child_process.spawnSync('node', ['-e', '0']);
    expect(f.originals.spawnSync.mock.calls[0]).toEqual(['node', ['-e', '0']]);
    expect(f.tracer.snapshot().incomplete).toBe(true);
  });
  it('flags incomplete when the working directory is gone and the child trace dir is relative', () => {
    const f = fixture();
    const gone = vi.spyOn(process, 'cwd').mockImplementation(() => { throw Object.assign(new Error('uv_cwd'), { code: 'ENOENT' }); });
    try { f.child_process.spawn('node', [], { env: traceEnv({ WE_TRACE_DIR: 'artifacts' }) }); } finally { gone.mockRestore(); }
    expect(f.tracer.snapshot().incomplete).toBe(true);
  });
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'].flatMap(name => [
    ['Buffer', () => Buffer.from(resolve(root, 'scripts'))],
    ['URL', () => pathToFileURL(resolve(root, 'scripts'))],
    ['relative string', () => 'scripts'],
  ].map(([label, cwd]) => [name, label, cwd])))('%s accepts a %s cwd and resolves scripts against it', (name, _label, makeCwd) => {
    const f = fixture();
    const cwd = makeCwd();
    expect(() => f.child_process[name]('node', ['script.mjs'], { cwd })).not.toThrow();
    expect(f.originals[name].mock.calls[0][2].cwd).toBe(cwd);
    expect(f.tracer.snapshot().edges).toEqual([{ file: 'scripts/script.mjs', kind: 'spawn' }]);
  });
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'].flatMap(name => [
    ['number cwd', { cwd: 7 }],
    ['object cwd', { cwd: { toString: () => 'scripts' } }],
    ['numeric NODE_OPTIONS', { env: { NODE_OPTIONS: 7 } }],
  ].map(([label, options]) => [name, label, options])))('%s never throws from tracing on %s; Node judges the input', (name, _label, options) => {
    const f = fixture();
    expect(() => f.child_process[name]('node', ['script.mjs'], options)).not.toThrow();
    expect(f.originals[name]).toHaveBeenCalledTimes(1);
    expect(f.originals[name].mock.calls[0][2]).toBe(options);
  });
  it('never throws when the working directory was deleted; absolute paths still trace', async () => {
    const f = fixture();
    f.fs.promises = { readFile: vi.fn(async () => 'result'), readdir: vi.fn(async () => []) };
    f.tracer.install();
    const gone = vi.spyOn(process, 'cwd').mockImplementation(() => { throw Object.assign(new Error('uv_cwd'), { code: 'ENOENT' }); });
    try {
      expect(() => f.fs.existsSync(resolve(root, 'a.json'))).not.toThrow();
      expect(() => f.fs.readFileSync(resolve(root, 'b.json'))).not.toThrow();
      expect(() => f.fs.readFileSync('relative.json')).not.toThrow();
      await expect(f.fs.promises.readFile(resolve(root, 'c.json'))).resolves.toBe('result');
      for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
        expect(() => f.child_process[name]('node', ['script.mjs'], { cwd: resolve(root, 'scripts') })).not.toThrow();
        expect(() => f.child_process[name]('node', ['script.mjs'], { cwd: 'scripts' })).not.toThrow();
        expect(f.originals[name]).toHaveBeenCalledTimes(2);
      }
    } finally { gone.mockRestore(); }
    expect(f.tracer.snapshot().edges).toEqual([
      { file: 'a.json', kind: 'read' }, { file: 'b.json', kind: 'read' }, { file: 'c.json', kind: 'read' },
      { file: 'scripts/script.mjs', kind: 'spawn' }]);
  });
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'].flatMap(name => [
    ['inherited', () => Object.create({ cwd: 'scripts' })],
    ['non-enumerable', () => Object.defineProperty({}, 'cwd', { value: 'scripts', enumerable: false })],
  ].map(([label, make]) => [name, label, make])))('%s keeps an %s cwd visible to Node and to tracing', (name, _label, make) => {
    const f = fixture();
    f.child_process[name]('node', ['script.mjs'], make());
    expect(f.originals[name].mock.calls[0][2].cwd).toBe('scripts');
    expect(f.tracer.snapshot().edges).toEqual([{ file: 'scripts/script.mjs', kind: 'spawn' }]);
  });
  it('resolves URL commands like the path normalizer, and ignores legacy url.parse objects Node rejects', async () => {
    const { parse } = await import('node:url');
    const f = fixture();
    f.child_process.fork(pathToFileURL(resolve(root, 'scripts/script.mjs')));
    f.fs.readFileSync(parse(pathToFileURL(resolve(root, 'package.json')).href));
    expect(f.tracer.snapshot().edges).toEqual([{ file: 'scripts/script.mjs', kind: 'spawn' }]);
  });
  it('options in the args slot still resolve the spawn cwd (fork overload)', () => {
    const f = fixture();
    f.child_process.fork('script.mjs', { cwd: resolve(root, 'scripts') });
    expect(f.tracer.snapshot().edges).toEqual([{ file: 'scripts/script.mjs', kind: 'spawn' }]);
  });
  it('activation leaves NODE_OPTIONS and the rest of the environment untouched', () => {
    const env = { WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts', NODE_OPTIONS: '--conditions=x' };
    const before = { ...env };
    activateTrace(env, { maxEdgesPerTest: 5000 }, {
      fs: {}, child_process: {}, process: { once: vi.fn() }, register: vi.fn(), syncBuiltinESMExports: vi.fn(),
      MessageChannel: class { constructor() { this.port1 = { on: vi.fn(), unref: vi.fn() }; this.port2 = {}; } },
    });
    expect(env).toEqual(before);
  });
  it('persists evidence after setup removes the trace environment and changes cwd', () => {
    const env = { WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts' };
    const runtime = { pid: 123, once: vi.fn() };
    const io = { mkdirSync: vi.fn(), writeFileSync: vi.fn() };
    activateTrace(env, { maxEdgesPerTest: 5000 }, {
      fs: io, child_process: {}, process: runtime, receiveMessageOnPort: () => undefined, register: vi.fn(), threadId: 0,
      syncBuiltinESMExports: vi.fn(), MessageChannel: class { constructor() { this.port1 = { on: vi.fn(), unref: vi.fn() }; this.port2 = {}; } },
    });
    delete env.WE_TRACE_TEST;
    delete env.WE_TRACE_DIR;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/');
    try { runtime.once.mock.calls[0][1](); } finally { cwd.mockRestore(); }
    expect(io.mkdirSync).toHaveBeenCalledWith(resolve(root, 'artifacts'), { recursive: true });
    expect(io.writeFileSync).toHaveBeenCalledWith(resolve(root, 'artifacts/trace-123.json'),
      JSON.stringify({ test, truncated: false, incomplete: false, edges: [] }));
  });
  it('preserves execFile util.promisify.custom contract with untouched arguments, and still observes the child', async () => {
    const custom = vi.fn(async () => ({ stdout: 'ok', stderr: 'err' }));
    const cp = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'].map(name => [name, vi.fn(() => 'child')]));
    Object.defineProperty(cp.execFile, promisify.custom, { value: custom });
    const env = { WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts', NODE_OPTIONS: `--import=${hookUrl}` };
    const tracer = createTracer({ test, root, record: vi.fn(), env, fs: {}, child_process: cp });
    tracer.install();
    const args = ['-e', '1'];
    // The running binary by absolute path: this env has no PATH, so a bare `node` would be unprovable (incomplete).
    await expect(promisify(cp.execFile)(process.execPath, args)).resolves.toEqual({ stdout: 'ok', stderr: 'err' });
    expect(custom.mock.calls[0]).toHaveLength(2);
    expect(custom.mock.calls[0][1]).toBe(args);
    expect(tracer.incomplete).toBe(false);
    const options = { cwd: '/', encoding: 'utf8', env: {} };
    await expect(promisify(cp.execFile)('node', undefined, options)).resolves.toEqual({ stdout: 'ok', stderr: 'err' });
    expect(custom.mock.calls[1]).toHaveLength(3);
    expect(custom.mock.calls[1][1]).toBeUndefined();
    expect(custom.mock.calls[1][2]).toBe(options);
    expect(tracer.incomplete).toBe(true);
  });
  it('records fs/promises reads and lists', async () => {
    const promises = { readFile: vi.fn(async () => 'x'), readdir: vi.fn(async () => []) };
    const tracer = createTracer({ test, root, record: vi.fn(), env: {}, fs: { promises }, child_process: {} });
    tracer.install();
    await promises.readFile('package.json', 'utf8');
    await promises.readdir('scripts');
    expect(tracer.snapshot().edges).toEqual([{ file: 'package.json', kind: 'read' }, { file: 'scripts', kind: 'list' }]);
  });
  it('records all requested reads/lists and forwards arguments, receiver and return value', () => {
    const f = fixture();
    const cb = vi.fn();
    expect(f.fs.readFile('settings.json', cb)).toBe('result');
    f.fs.readFileSync(pathToFileURL(resolve(root, 'settings.json')));
    f.fs.readdirSync(root);
    f.fs.existsSync(Buffer.from('missing.json'));
    expect(f.record.mock.calls.map(([edge]) => edge)).toEqual([
      { file: 'settings.json', kind: 'read' }, { file: '.', kind: 'list' }, { file: 'missing.json', kind: 'read' },
    ]);
  });
  it('filters outside-root, node_modules and builtins including file URLs', () => {
    const f = fixture();
    for (const path of ['../outside', 'node_modules/pkg/file.js', 'nested/node_modules/file', 'node:fs',
      pathToFileURL(resolve(root, '../outside')), 7]) f.tracer.add(path, 'load');
    expect(f.tracer.snapshot().edges).toEqual([]);
  });
  it('bounds unique edges and reports incomplete evidence once; zero cap records nothing', () => {
    const warn = vi.fn();
    const f = fixture({ maxEdgesPerTest: 1, warn });
    f.tracer.add('a', 'read');
    f.tracer.add('a', 'read');
    f.tracer.add('b', 'load');
    f.tracer.add('c', 'load');
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(f.tracer.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rerun with a larger'));
    expect(mergeTraces([f.tracer.snapshot()])).toEqual({ tests: {}, incomplete: [] }); // capped evidence stays unknown
    const zero = fixture({ maxEdgesPerTest: 0 });
    zero.tracer.add('a', 'read');
    expect(zero.record).not.toHaveBeenCalled();
  });
  it('worker threads persist to a thread-specific file instead of overwriting the process trace', () => {
    const runtime = { pid: 123, once: vi.fn() };
    const io = { mkdirSync: vi.fn(), writeFileSync: vi.fn() };
    const port1 = { on: vi.fn(), unref: vi.fn() };
    activateTrace({ WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts' }, { maxEdgesPerTest: 5000 }, {
      fs: io, child_process: {}, process: runtime, receiveMessageOnPort: () => undefined, register: vi.fn(), threadId: 2,
      syncBuiltinESMExports: vi.fn(), MessageChannel: class { constructor() { this.port1 = port1; this.port2 = {}; } },
    });
    runtime.once.mock.calls[0][1]();
    expect(io.writeFileSync.mock.calls[0][0]).toBe(resolve(root, 'artifacts/trace-123-t2.json'));
  });
  it('loader forwards successful file loads, skips builtins and preserves errors', async () => {
    const port = { postMessage: vi.fn() };
    initialize({ port });
    const result = { format: 'module', source: 'export {}' };
    const next = vi.fn(async () => result);
    expect(await load('file:///repo/a.mjs', {}, next)).toBe(result);
    await load('node:fs', {}, next);
    await expect(load('file:///repo/missing', {}, async () => { throw new Error('missing'); })).rejects.toThrow('missing');
    expect(port.postMessage.mock.calls).toEqual([['file:///repo/a.mjs']]);
  });
  it('drains pending loader messages synchronously at exit before writing the trace', async () => {
    const queue = [];
    const port1 = { on: vi.fn(), unref: vi.fn() };
    const port2 = { postMessage: message => queue.push({ message }) };
    const runtime = { pid: 123, once: vi.fn() };
    const io = { mkdirSync: vi.fn(), writeFileSync: vi.fn() };
    const receive = vi.fn(port => {
      expect(port).toBe(port1);
      return queue.shift();
    });
    const register = vi.fn((_url, options) => initialize(options.data));
    activateTrace({ WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts' }, { maxEdgesPerTest: 5000 }, {
      fs: io, child_process: {}, process: runtime, receiveMessageOnPort: receive, register, threadId: 0,
      syncBuiltinESMExports: vi.fn(), MessageChannel: class { constructor() { this.port1 = port1; this.port2 = port2; } },
    });
    await load(pathToFileURL(resolve(root, 'pending.mjs')).href, {}, async () => ({ format: 'module', source: '' }));
    expect(queue).toHaveLength(1);
    expect(io.writeFileSync).not.toHaveBeenCalled();
    expect(runtime.once).toHaveBeenCalledWith('exit', expect.any(Function));
    runtime.once.mock.calls[0][1]();
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);
    expect(io.writeFileSync.mock.calls[0][0]).toBe(resolve(root, 'artifacts/trace-123.json'));
    expect(JSON.parse(io.writeFileSync.mock.calls[0][1])).toEqual({ test, truncated: false, incomplete: false, edges: [{ file: 'pending.mjs', kind: 'load' }] });
    expect(queue).toHaveLength(0);
  });
  it('merges deterministically and compares direct reachability against static, retaining unknowns', () => {
    const traces = [{ test: 'z', incomplete: false, edges: [{ file: 'b', kind: 'read' }, { file: 'b', kind: 'load' }] },
      { test: 'a', incomplete: false, edges: [] }, { test: 'z', incomplete: false, edges: [{ file: 'b', kind: 'read' }, { file: 'a', kind: 'spawn' }] }];
    const traceMap = mergeTraces(traces);
    expect(JSON.stringify(traceMap)).toBe('{"tests":{"a":{},"z":{"a":["spawn"],"b":["load","read"]}},"incomplete":[]}');
    expect(mergeTraces([...traces].reverse())).toEqual(traceMap);
    const misses = [{ test: 'z', changed: 'b' }, { test: 'a', changed: 'b' }, { test: 'unknown', changed: 'b' }];
    expect(compareCoverage({ misses, traceMap, staticSelected: ['a'] })).toEqual({ incomplete: false, results: [
      { test: 'z', changed: 'b', static: false, traced: true, traceKnown: true, incomplete: false },
      { test: 'a', changed: 'b', static: true, traced: false, traceKnown: true, incomplete: false },
      { test: 'unknown', changed: 'b', static: false, traced: false, traceKnown: false, incomplete: false },
    ], counts: { total: 3, static: 1, traced: 1, additional: 1, unknown: 1, incomplete: 0 } });
  });
  it('keeps observed edges of incomplete evidence but never reports their absence as untraced', () => {
    const traceMap = mergeTraces([
      { test: 'p', incomplete: false, edges: [{ file: 'x', kind: 'read' }] },
      { test: 'p', incomplete: true, edges: [{ file: 'y', kind: 'read' }] },
      { test: 'legacy', edges: [] }, // written without the flag: completeness unknown, so incomplete
      { test: 'capped', truncated: true, incomplete: true, edges: [] },
    ]);
    expect(traceMap).toEqual({ tests: { legacy: {}, p: { x: ['read'], y: ['read'] } }, incomplete: ['legacy', 'p'] });
    const summary = compareCoverage({ traceMap, staticSelected: [], misses: [{ test: 'p', changed: 'x' },
      { test: 'p', changed: 'z' }, { test: 'legacy', changed: 'z' }, { test: 'capped', changed: 'z' }] });
    expect(summary.incomplete).toBe(true);
    expect(summary.results.map(r => [r.traced, r.incomplete, r.traceKnown]))
      .toEqual([[true, true, true], [null, true, true], [null, true, true], [false, false, false]]);
    expect(summary.counts).toMatchObject({ traced: 1, additional: 1, unknown: 1, incomplete: 3 });
  });
  it('never reports an unknown test traced through an inherited object key', () => {
    const summary = compareCoverage({ traceMap: { tests: {}, incomplete: [] }, misses: [{ test: 'constructor', changed: 'name' }] });
    expect(summary.results[0]).toMatchObject({ traced: false, traceKnown: false });
  });
  it('CLI prints the incomplete flag and warns when results rest on incomplete evidence', () => {
    const print = vi.fn();
    const warn = vi.fn();
    const files = { map: JSON.stringify({ tests: { t: {} }, incomplete: ['t'] }), misses: JSON.stringify([{ test: 't', changed: 'c' }]) };
    runTraceCoverage(['map', 'misses'], { readFile: file => files[file], print, warn });
    expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({ incomplete: true, counts: { incomplete: 1 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('incomplete evidence for 1 result(s)'));
    const clean = vi.fn();
    runTraceCoverage(['map', 'misses'], { readFile: file => (file === 'map' ? '{"tests":{"t":{}},"incomplete":[]}' : files[file]), print, warn: clean });
    expect(clean).not.toHaveBeenCalled();
  });
  it('CLI uses injected evidence, prints summary and rejects unreadable/malformed input', () => {
    const print = vi.fn();
    const readFile = file => ({ map: '{"tests":{},"incomplete":[]}', misses: '[]', static: '[]' })[file];
    expect(runTraceCoverage(['map', 'misses', 'static'], { readFile, print }).counts.total).toBe(0);
    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('"total":0'));
    expect(() => runTraceCoverage([], { readFile, print })).toThrow('usage');
    expect(() => runTraceCoverage(['missing', 'misses'], { readFile, print })).toThrow();
    expect(() => runTraceCoverage(['map', 'misses'], { readFile: () => { throw new Error('unreadable'); }, print })).toThrow('unreadable');
  });
  it('labels omitted static evidence unknown without claiming additional coverage', () => {
    const evidence = { traceMap: { tests: { t: { data: ['read'] } }, incomplete: [] }, misses: [{ test: 't', changed: 'data' }] };
    const summary = compareCoverage(evidence);
    expect(summary).toMatchObject({ staticEvidence: 'not supplied', results: [{ static: null, traced: true }],
      counts: { static: null, traced: 1, additional: null } });
    const print = vi.fn();
    const readFile = file => JSON.stringify(file === 'map' ? evidence.traceMap : evidence.misses);
    expect(runTraceCoverage(['map', 'misses'], { readFile, print })).toEqual(summary);
    expect(JSON.parse(print.mock.calls[0][0]).staticEvidence).toBe('not supplied');
    expect(compareCoverage({ ...evidence, staticSelected: [] }).counts).toMatchObject({ static: 0, additional: 1 });
    expect(compareCoverage({ ...evidence, staticSelected: new Set(['t']) }).counts).toMatchObject({ static: 1, additional: 0 });
  });
  it('rejects incomplete evidence shapes instead of reporting a clear replay', () => {
    const map = (tests, incomplete = []) => ({ traceMap: { tests, incomplete } });
    for (const evidence of [{ misses: {} }, { traceMap: [] }, { traceMap: {} }, map({ t: { a: [] } }),
      map({ t: { a: ['unknown'] } }), { misses: [{ test: 't' }] }, { staticSelected: 't' }, { staticSelected: null },
      { traceMap: { t: { a: ['read'] } } }, // legacy plain map: completeness unknown
      { traceMap: { tests: {} } }, map({}, 'p'), map({ p: {} }, [7]), map({}, ['p'])]) {
      expect(() => compareCoverage({ misses: [], traceMap: { tests: {}, incomplete: [] }, ...evidence })).toThrow('invalid coverage evidence');
    }
  });
});
