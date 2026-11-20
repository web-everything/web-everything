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
import { MessageChannel, receiveMessageOnPort, threadId } from 'node:worker_threads';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const hook = import.meta.url;
const ROOT = fileURLToPath(new URL('../../', hook));
const defaults = { enabled: true, maxEdgesPerTest: 5000 };

/** Pure construction: only install() mutates the injected objects; record receives unique edges. */
export function createTracer({ test, root, record = () => {}, fs: io = {}, child_process: cp = {},
  env = {}, maxEdgesPerTest = 5000, warn = () => {} }) {
  // Test setup may scrub process.env; trace identity and destination belong to activation.
  // Keep ordinary inherited environment values live, but resolve the destination before chdir.
  const traceEnv = { WE_TRACE_TEST: env.WE_TRACE_TEST,
    WE_TRACE_DIR: env.WE_TRACE_DIR === undefined ? undefined : resolve(env.WE_TRACE_DIR) };
  if (env.WE_CI_SELECTION !== undefined) traceEnv.WE_CI_SELECTION = env.WE_CI_SELECTION;
  const initialNodeOptions = env.NODE_OPTIONS;
  const edges = new Map();
  const exists = io.statSync?.bind(io);
  function path(value, cwd = root) {
    try {
      value = typeof value === 'string' && value.startsWith('file:') ? fileURLToPath(value) : toPath(value);
      if (value === null || value.startsWith('node:')) return null;
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
    // Promise-based reads (fs/promises) are dependencies too; without this they would look like absent edges.
    const promises = io.promises;
    if (promises) {
      for (const [name, kind] of Object.entries({ readFile: 'read', readdir: 'list' })) {
        const original = promises[name];
        if (typeof original === 'function') promises[name] = function (...args) { add(args[0], kind, process.cwd()); return Reflect.apply(original, this, args); };
      }
    }
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
      const original = cp[name];
      if (!original) continue;
      const prepare = (command, args) => {
        // Node accepts an explicit null/undefined args slot before options.
        if (args.length && args[0] == null) args[0] = [];
        const index = Array.isArray(args[0]) ? 1 : 0;
        const hasOptions = args[index] && typeof args[index] === 'object';
        const options = hasOptions ? args[index] : {};
        // Tracing must never throw: resolve every cwd form Node accepts, and leave any other value for Node to judge.
        let cwd = process.cwd();
        try { const given = options.cwd == null ? null : toPath(options.cwd); if (given !== null) cwd = resolve(cwd, given); } catch { /* Node reports it */ }
        for (const value of [command, ...(Array.isArray(args[0]) ? args[0] : [])]) {
          if (path(value, cwd) === null) continue;
          try { if (exists?.(resolve(cwd, value)).isFile()) add(value, 'spawn', cwd); } catch { /* not an existing script */ }
        }
        const childEnv = { ...(options.env ?? env), ...traceEnv };
        // Node stringifies env values; a non-string NODE_OPTIONS must not break the wrapper.
        childEnv.NODE_OPTIONS = inheritOptions(String(childEnv.NODE_OPTIONS ?? env.NODE_OPTIONS ?? initialNodeOptions ?? ''));
        // Replace an options placeholder too, so a following callback keeps its position.
        args.splice(index, hasOptions || (index < args.length && args[index] == null) ? 1 : 0, { ...options, env: childEnv });
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

/**
 * The path forms Node's fs and child_process accept: string, Buffer/Uint8Array, or a file URL.
 * URLs are duck-typed because a test environment may install a different URL global than node:url's.
 * Returns null for anything else.
 */
function toPath(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
  if (value !== null && typeof value === 'object' && typeof value.href === 'string' && value.protocol === 'file:') return fileURLToPath(value.href);
  return null;
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

/** staticSelected is an optional list/Set of test paths. Missing evidence is explicitly unknown. */
export function compareCoverage({ misses, traceMap, staticSelected }) {
  const staticKnown = staticSelected !== undefined;
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!Array.isArray(misses) || misses.some(v => !object(v) || typeof v.test !== 'string' || typeof v.changed !== 'string')
    || !object(traceMap) || Object.values(traceMap).some(files => !object(files) || Object.values(files).some(kinds =>
      !Array.isArray(kinds) || !kinds.length || kinds.some(k => !['load', 'read', 'list', 'spawn'].includes(k))))
    || (staticKnown && (!(Array.isArray(staticSelected) || staticSelected instanceof Set) || [...staticSelected].some(v => typeof v !== 'string'))))
    throw new Error('invalid coverage evidence');
  const selected = new Set(staticSelected);
  const results = misses.map(({ test, changed }) => ({ test, changed, static: staticKnown ? selected.has(test) : null,
    traced: Object.hasOwn(traceMap[test] ?? {}, changed), traceKnown: Object.hasOwn(traceMap, test) }));
  return { ...(!staticKnown ? { staticEvidence: 'not supplied' } : {}), results,
    counts: { total: results.length, static: staticKnown ? results.filter(r => r.static).length : null,
    traced: results.filter(r => r.traced).length, additional: staticKnown ? results.filter(r => r.traced && !r.static).length : null,
    unknown: results.filter(r => !r.traceKnown).length } };
}

/** Injectable startup keeps no-env and disabled paths completely inert. */
export async function startTrace({ env = process.env, settings, activate = activateTrace,
  loadSettings = async env => (await import('../lib/ci-selection-settings.mjs')).loadCiSelection({ env }).trace } = {}) {
  if (!env.WE_TRACE_TEST || !env.WE_TRACE_DIR) return;
  if (!settings) {
    try { settings = await loadSettings(env); }
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
  receiveMessageOnPort: receive = receiveMessageOnPort, threadId: tid = threadId } = {}) {
  const outputDir = resolve(env.WE_TRACE_DIR);
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
      io.mkdirSync(outputDir, { recursive: true });
      io.writeFileSync(resolve(outputDir, `trace-${runtime.pid}${tid ? `-t${tid}` : ''}.json`), JSON.stringify(tracer.snapshot()));
    } catch (error) { console.error(`dep-trace: incomplete evidence: ${error.code || 'write failed'}`); }
  });
  return tracer;
}

await startTrace();
