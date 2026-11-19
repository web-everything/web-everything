/**
 * @file scripts/ci/dep-trace.mjs
 * @description Shadow dependency evidence only; never selects tests.
 * Set WE_TRACE_TEST=repo/test.mjs WE_TRACE_DIR=artifact-directory and append
 * ` --import="file:///absolute/repo/scripts/ci/dep-trace.mjs"` to existing NODE_OPTIONS.
 * Children inherit the hook, test identity and output directory, including with an explicit env.
 * Edge caps emit an incomplete-evidence warning: rerun with a larger cap before using coverage.
 */
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { register, syncBuiltinESMExports } from 'node:module';
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const hook = import.meta.url;
const ROOT = fileURLToPath(new URL('../../', hook));
const defaults = { enabled: true, maxEdgesPerTest: 5000 };

/** Pure construction: only install() mutates the injected objects; record receives unique edges. */
export function createTracer({ test, root, record = () => {}, fs: io = {}, child_process: cp = {},
  env = {}, maxEdgesPerTest = 5000, warn = () => {} }) {
  const edges = new Map();
  const exists = io.statSync?.bind(io);
  function path(value, cwd = root) {
    try {
      if (value instanceof URL || (typeof value === 'string' && value.startsWith('file:'))) value = fileURLToPath(value);
      if (Buffer.isBuffer(value)) value = value.toString();
      if (typeof value !== 'string' || value.startsWith('node:')) return null;
      const name = relative(root, resolve(cwd, value));
      if (name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name) || name.split(sep).includes('node_modules')) return null;
      return name.split(sep).join('/') || '.';
    } catch { return null; }
  }
  function add(value, kind, cwd) {
    const file = path(value, cwd);
    if (file === null) return;
    const key = `${file}\0${kind}`;
    if (edges.has(key)) return;
    if (edges.size >= maxEdgesPerTest) {
      if (!tracer.truncated) warn('dep-trace: incomplete evidence (edge cap); rerun with a larger ci.selection.trace.maxEdgesPerTest');
      tracer.truncated = true;
      return;
    }
    const edge = { file, kind };
    edges.set(key, edge);
    record(edge);
  }
  const tracer = { add, truncated: false, snapshot: () => ({ test, truncated: tracer.truncated, edges: [...edges.values()].sort((a, b) =>
    a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind)) }), install() {
    for (const [name, kind] of Object.entries({ readFileSync: 'read', readFile: 'read', readdirSync: 'list', existsSync: 'read' })) {
      const original = io[name];
      if (original) io[name] = function (...args) { add(args[0], kind, process.cwd()); return Reflect.apply(original, this, args); };
    }
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
      const original = cp[name];
      if (!original) continue;
      const prepare = (command, args) => {
        const index = Array.isArray(args[0]) ? 1 : 0;
        const hasOptions = args[index] && typeof args[index] === 'object';
        const options = hasOptions ? args[index] : {};
        const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : resolve(process.cwd(), options.cwd || '.');
        for (const value of [command, ...(Array.isArray(args[0]) ? args[0] : [])]) {
          if (path(value, cwd) === null) continue;
          try { if (exists?.(resolve(cwd, value)).isFile()) add(value, 'spawn', cwd); } catch { /* not an existing script */ }
        }
        const childEnv = { ...(options.env ?? env), WE_TRACE_TEST: env.WE_TRACE_TEST, WE_TRACE_DIR: resolve(process.cwd(), env.WE_TRACE_DIR) };
        if (env.WE_CI_SELECTION !== undefined) childEnv.WE_CI_SELECTION = env.WE_CI_SELECTION;
        childEnv.NODE_OPTIONS = inheritOptions(childEnv.NODE_OPTIONS ?? env.NODE_OPTIONS);
        args.splice(index, hasOptions ? 1 : 0, { ...options, env: childEnv });
        return [command, ...args];
      };
      cp[name] = function (command, ...args) { return Reflect.apply(original, this, prepare(command, args)); };
      // Keep util.promisify's {stdout, stderr} contract: route the original custom promisifier through the same env injection.
      const custom = original[promisify.custom];
      if (typeof custom === 'function') {
        Object.defineProperty(cp[name], promisify.custom, { configurable: true, value: function (command, ...args) { return Reflect.apply(custom, this, prepare(command, args)); } });
      }
    }
  } };
  return tracer;
}

function inheritOptions(options = '') {
  const flag = `--import=${JSON.stringify(hook)}`;
  return options.includes(flag) ? options : `${options} ${flag}`.trim();
}

/** Sorted union of per-process evidence. Missing entries remain unknown, never proof of coverage. */
export function mergeTraces(traces) {
  const tests = new Map();
  const incomplete = new Set(traces.filter(t => t.truncated).map(t => t.test));
  for (const { test, edges } of traces) {
    if (incomplete.has(test)) continue; // capped evidence is unknown, never a known trace
    if (!tests.has(test)) tests.set(test, new Map());
    for (const { file, kind } of edges) {
      const files = tests.get(test);
      if (!files.has(file)) files.set(file, new Set());
      files.get(file).add(kind);
    }
  }
  return Object.fromEntries([...tests].sort(([a], [b]) => a.localeCompare(b)).map(([test, files]) =>
    [test, Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, kinds]) => [file, [...kinds].sort()]))]));
}

/** staticSelected is a list/Set of test paths. A missing trace is explicitly unknown. */
export function compareCoverage({ misses, traceMap, staticSelected = [] }) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!Array.isArray(misses) || misses.some(v => !object(v) || typeof v.test !== 'string' || typeof v.changed !== 'string')
    || !object(traceMap) || Object.values(traceMap).some(files => !object(files) || Object.values(files).some(kinds =>
      !Array.isArray(kinds) || !kinds.length || kinds.some(k => !['load', 'read', 'list', 'spawn'].includes(k))))
    || !(Array.isArray(staticSelected) || staticSelected instanceof Set) || [...staticSelected].some(v => typeof v !== 'string'))
    throw new Error('invalid coverage evidence');
  const selected = new Set(staticSelected);
  const results = misses.map(({ test, changed }) => ({ test, changed, static: selected.has(test),
    traced: Object.hasOwn(traceMap[test] ?? {}, changed), traceKnown: Object.hasOwn(traceMap, test) }));
  return { results, counts: { total: results.length, static: results.filter(r => r.static).length,
    traced: results.filter(r => r.traced).length, additional: results.filter(r => r.traced && !r.static).length,
    unknown: results.filter(r => !r.traceKnown).length } };
}

/** Injectable startup keeps no-env and disabled paths completely inert. */
export async function startTrace({ env = process.env, settings, activate = activateTrace } = {}) {
  if (!env.WE_TRACE_TEST || !env.WE_TRACE_DIR) return;
  if (!settings) {
    try { settings = (await import('../lib/ci-selection-settings.mjs')).loadCiSelection({ env }).trace; }
    catch {
      settings = { ...defaults };
      try {
        const trace = JSON.parse(env.WE_CI_SELECTION || '{}').trace;
        if (typeof trace?.enabled === 'boolean') settings.enabled = trace.enabled;
        if (Number.isSafeInteger(trace?.maxEdgesPerTest) && trace.maxEdgesPerTest >= 0) settings.maxEdgesPerTest = trace.maxEdgesPerTest;
      } catch { /* built-in defaults */ }
    }
  }
  if (settings.enabled) return activate(env, settings);
}

/** Runtime seams let mock-only tests exercise registration and synchronous exit persistence together. */
export function activateTrace(env, settings, { fs: io = fs, child_process: cp = childProcess, process: runtime = process,
  MessageChannel: Channel = MessageChannel, register: registerLoader = register, syncBuiltinESMExports: syncExports = syncBuiltinESMExports,
  receiveMessageOnPort: receive = receiveMessageOnPort } = {}) {
  const tracer = createTracer({ test: env.WE_TRACE_TEST, root: ROOT, env, fs: io, child_process: cp,
    maxEdgesPerTest: settings.maxEdgesPerTest, warn: message => console.error(message) });
  const { port1, port2 } = new Channel();
  port1.on('message', url => tracer.add(url, 'load'));
  port1.unref();
  registerLoader(new URL('./dep-trace-loader.mjs', hook), { parentURL: hook, data: { port: port2 }, transferList: [port2] });
  env.NODE_OPTIONS = inheritOptions(env.NODE_OPTIONS);
  tracer.install();
  syncExports();
  runtime.once('exit', () => {
    let pending;
    while ((pending = receive(port1))) tracer.add(pending.message, 'load');
    try {
      io.mkdirSync(env.WE_TRACE_DIR, { recursive: true });
      io.writeFileSync(resolve(env.WE_TRACE_DIR, `trace-${runtime.pid}.json`), JSON.stringify(tracer.snapshot()));
    } catch (error) { console.error(`dep-trace: incomplete evidence: ${error.code || 'write failed'}`); }
  });
  return tracer;
}

await startTrace();
