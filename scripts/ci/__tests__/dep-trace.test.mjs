/**
 * @file scripts/ci/__tests__/dep-trace.test.mjs
 * @description Hermetic S2 tracer and shadow coverage evidence; no real subprocesses.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { activateTrace, createTracer, startTrace, mergeTraces, compareCoverage } from '../dep-trace.mjs';
import { initialize, load } from '../dep-trace-loader.mjs';
import { runTraceCoverage } from '../../readiness/trace-coverage.mjs';

const root = process.cwd();
const test = 'fake.test.mjs';
function fixture(extra = {}) {
  const record = vi.fn();
  const env = { WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts', NODE_OPTIONS: '--conditions=original' };
  const fs = Object.fromEntries(['readFileSync', 'readFile', 'readdirSync', 'existsSync'].map(name => [name, vi.fn(() => 'result')]));
  fs.statSync = vi.fn(file => {
    if (!file.endsWith('script.mjs')) throw new Error('missing');
    return { isFile: () => true };
  });
  const child_process = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'].map(name => [name, vi.fn(() => 'child')]));
  const originals = { ...child_process };
  const tracer = createTracer({ test, root, record, env, fs, child_process, ...extra });
  tracer.install();
  return { tracer, fs, child_process, originals, record, env };
}

describe('shadow dependency tracer', () => {
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
  it('records BOTH a started script and its JSON read in a fake child', () => {
    const parent = fixture();
    parent.child_process.spawn('node', ['script.mjs']);
    const options = parent.originals.spawn.mock.calls[0][2];
    const child = fixture({ env: options.env });
    child.fs.readFileSync('settings.json', 'utf8');
    expect(mergeTraces([parent.tracer.snapshot(), child.tracer.snapshot()])).toEqual({
      [test]: { 'script.mjs': ['spawn'], 'settings.json': ['read'] },
    });
    expect(options.env.NODE_OPTIONS).toContain('--conditions=original');
    expect(options.env.NODE_OPTIONS).toContain('--import=');
    expect(options.env.WE_TRACE_TEST).toBe(test);
  });
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'])('patches %s, keeps callbacks and custom env, resolves child cwd', name => {
    const f = fixture();
    const callback = vi.fn();
    const opts = { cwd: 'scripts', env: { NODE_OPTIONS: '--conditions=child', CUSTOM: 'yes' } };
    expect(f.child_process[name]('node', ['script.mjs', 'missing.json'], opts, callback)).toBe('child');
    const call = f.originals[name].mock.calls[0];
    expect(call[2]).toMatchObject({ cwd: 'scripts', env: { CUSTOM: 'yes', WE_TRACE_TEST: test } });
    expect(call[2].env.NODE_OPTIONS).toContain('--conditions=child');
    expect(call[2].env.WE_TRACE_DIR).toBe(resolve(root, f.env.WE_TRACE_DIR));
    expect(resolve(root, opts.cwd, call[2].env.WE_TRACE_DIR)).toBe(resolve(root, f.env.WE_TRACE_DIR));
    expect(call[3]).toBe(callback);
    expect(f.tracer.snapshot().edges).toEqual([{ file: 'scripts/script.mjs', kind: 'spawn' }]);
  });
  it('preserves execFile callback overload and fork options overload', () => {
    const f = fixture();
    const callback = vi.fn();
    f.child_process.execFile('script.mjs', callback);
    expect(f.originals.execFile.mock.calls[0][2]).toBe(callback);
    f.child_process.fork('script.mjs', { cwd: root });
    expect(f.originals.fork.mock.calls[0][1].cwd).toBe(root);
  });
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'].flatMap(name => [undefined, null].map(args => [name, args])))('preserves %s options after an explicit %s args list', (name, args) => {
    const f = fixture();
    const callback = vi.fn();
    const options = { cwd: '/', env: { ONLY: 'x' }, input: 'console.log(process.cwd(),process.env.ONLY)', encoding: 'utf8' };
    f.child_process[name]('node', args, options, callback);
    expect(f.originals[name].mock.calls[0]).toEqual(['node', [], {
      ...options, env: expect.objectContaining({ ONLY: 'x', WE_TRACE_TEST: test }),
    }, callback]);
    expect(options.env).toEqual({ ONLY: 'x' });
  });
  it.each([undefined, null])('preserves execFile callbacks after an explicit %s options placeholder', options => {
    const f = fixture();
    const callback = vi.fn();
    f.child_process.execFile('node', [], options, callback);
    expect(f.originals.execFile.mock.calls[0]).toEqual(['node', [], expect.objectContaining({ env: expect.any(Object) }), callback]);
  });
  it('retains captured trace configuration after environment cleanup and cwd changes', () => {
    const f = fixture();
    delete f.env.WE_TRACE_TEST;
    delete f.env.WE_TRACE_DIR;
    f.env.CUSTOM = 'current';
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/');
    try {
      expect(f.child_process.spawnSync('node', ['-e', '0'])).toBe('child');
      expect(f.originals.spawnSync.mock.calls[0][2].env).toMatchObject({
        WE_TRACE_TEST: test, WE_TRACE_DIR: resolve(root, 'artifacts'), CUSTOM: 'current',
      });
    } finally { cwd.mockRestore(); }
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
      JSON.stringify({ test, truncated: false, edges: [] }));
  });
  it('preserves execFile util.promisify.custom contract and still injects the trace env', async () => {
    const custom = vi.fn(async () => ({ stdout: 'ok', stderr: 'err' }));
    const cp = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'].map(name => [name, vi.fn(() => 'child')]));
    Object.defineProperty(cp.execFile, promisify.custom, { value: custom });
    const tracer = createTracer({ test, root, record: vi.fn(), env: { WE_TRACE_TEST: test, WE_TRACE_DIR: 'artifacts' }, fs: {}, child_process: cp });
    tracer.install();
    await expect(promisify(cp.execFile)('node', ['-e', '1'])).resolves.toEqual({ stdout: 'ok', stderr: 'err' });
    expect(custom.mock.calls[0][2].env.WE_TRACE_TEST).toBe(test);
    await expect(promisify(cp.execFile)('node', undefined, { cwd: '/', encoding: 'utf8' })).resolves.toEqual({ stdout: 'ok', stderr: 'err' });
    expect(custom.mock.calls[1]).toEqual(['node', [], expect.objectContaining({ cwd: '/', encoding: 'utf8', env: expect.any(Object) })]);
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
    expect(mergeTraces([f.tracer.snapshot()])).toEqual({}); // capped evidence stays unknown
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
    expect(JSON.parse(io.writeFileSync.mock.calls[0][1])).toEqual({ test, truncated: false, edges: [{ file: 'pending.mjs', kind: 'load' }] });
    expect(queue).toHaveLength(0);
  });
  it('merges deterministically and compares direct reachability against static, retaining unknowns', () => {
    const traces = [{ test: 'z', edges: [{ file: 'b', kind: 'read' }, { file: 'b', kind: 'load' }] },
      { test: 'a', edges: [] }, { test: 'z', edges: [{ file: 'b', kind: 'read' }, { file: 'a', kind: 'spawn' }] }];
    const traceMap = mergeTraces(traces);
    expect(JSON.stringify(traceMap)).toBe('{"a":{},"z":{"a":["spawn"],"b":["load","read"]}}');
    expect(mergeTraces([...traces].reverse())).toEqual(traceMap);
    const misses = [{ test: 'z', changed: 'b' }, { test: 'a', changed: 'b' }, { test: 'unknown', changed: 'b' }];
    expect(compareCoverage({ misses, traceMap, staticSelected: ['a'] })).toEqual({ results: [
      { test: 'z', changed: 'b', static: false, traced: true, traceKnown: true },
      { test: 'a', changed: 'b', static: true, traced: false, traceKnown: true },
      { test: 'unknown', changed: 'b', static: false, traced: false, traceKnown: false },
    ], counts: { total: 3, static: 1, traced: 1, additional: 1, unknown: 1 } });
  });
  it('CLI uses injected evidence, prints summary and rejects unreadable/malformed input', () => {
    const print = vi.fn();
    const readFile = file => ({ map: '{}', misses: '[]', static: '[]' })[file];
    expect(runTraceCoverage(['map', 'misses', 'static'], { readFile, print }).counts.total).toBe(0);
    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('"total":0'));
    expect(() => runTraceCoverage([], { readFile, print })).toThrow('usage');
    expect(() => runTraceCoverage(['missing', 'misses'], { readFile, print })).toThrow();
    expect(() => runTraceCoverage(['map', 'misses'], { readFile: () => { throw new Error('unreadable'); }, print })).toThrow('unreadable');
  });
  it('labels omitted static evidence unknown without claiming additional coverage', () => {
    const evidence = { traceMap: { t: { data: ['read'] } }, misses: [{ test: 't', changed: 'data' }] };
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
    for (const evidence of [{ misses: {} }, { traceMap: [] }, { traceMap: { t: { a: [] } } },
      { traceMap: { t: { a: ['unknown'] } } }, { misses: [{ test: 't' }] }, { staticSelected: 't' }, { staticSelected: null }]) {
      expect(() => compareCoverage({ misses: [], traceMap: {}, ...evidence })).toThrow('invalid coverage evidence');
    }
  });
});
