/**
 * @file scripts/ci/dep-trace.mjs
 * @description Shadow dependency evidence only; never selects tests.
 * Set WE_TRACE_TEST=repo/test.mjs WE_TRACE_DIR=artifact-directory and append
 * ` --import="file:///absolute/repo/scripts/ci/dep-trace.mjs"` to existing NODE_OPTIONS.
 * Observe-only: child_process calls and the environment are never rewritten. A child whose real env lacks
 * the hook, test identity, directory or settings marks the evidence `incomplete`.
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
  // What a child must match to trace into this evidence; resolved at activation, before any chdir.
  const captured = { WE_CI_SELECTION: env.WE_CI_SELECTION === undefined ? undefined : `${env.WE_CI_SELECTION}`,
    WE_TRACE_DIR: env.WE_TRACE_DIR === undefined ? undefined : resolve(`${env.WE_TRACE_DIR}`) };
  const edges = new Map();
  const exists = io.statSync?.bind(io);
  function path(value, cwd = root) {
    try {
      value = typeof value === 'string' && value.startsWith('file:') ? fileURLToPath(value) : toPath(value);
      if (value === null || value.startsWith('node:')) return null;
      // No working directory (it was deleted): only an absolute path can be resolved.
      if (cwd === null) { if (!isAbsolute(value)) return null; cwd = root; }
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
  const tracer = { add, truncated: false, incomplete: false, snapshot: () => ({ test, truncated: tracer.truncated,
    incomplete: tracer.incomplete, edges: [...edges.values()].sort((a, b) =>
    a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind)) }), install() {
    for (const [name, kind] of Object.entries({ readFileSync: 'read', readFile: 'read', readdirSync: 'list', existsSync: 'read' })) {
      const original = io[name];
      if (original) io[name] = function (...args) { add(args[0], kind, here()); return Reflect.apply(original, this, args); };
    }
    // Promise-based reads (fs/promises) are dependencies too; without this they would look like absent edges.
    const promises = io.promises;
    if (promises) {
      for (const [name, kind] of Object.entries({ readFile: 'read', readdir: 'list' })) {
        const original = promises[name];
        if (typeof original === 'function') promises[name] = function (...args) { add(args[0], kind, here()); return Reflect.apply(original, this, args); };
      }
    }
    // execSync calls Node's internal spawnSync, so it needs its own wrapper; exec reaches the exported execFile.
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'fork']) {
      const original = cp[name];
      if (!original) continue;
      // Observe-only: the caller's arguments reach Node unchanged (same values, same count, same receiver).
      cp[name] = function (...args) { observe(args); return Reflect.apply(original, this, args); };
      // Keep util.promisify's {stdout, stderr} contract: the original custom promisifier gets the same untouched arguments.
      const custom = original[promisify.custom];
      if (typeof custom === 'function') {
        Object.defineProperty(cp[name], promisify.custom, { configurable: true, value: function (...args) { observe(args); return Reflect.apply(custom, this, args); } });
      }
    }
  } };
  /** Reads a child_process call without changing it: records the spawn edge and flags a child that will not trace. */
  function observe([command, ...args]) {
    try {
      // Node takes options after an args array or an explicit null/undefined args slot; otherwise in the first slot.
      const slot = Array.isArray(args[0]) || args[0] == null ? 1 : 0;
      const options = args[slot] !== null && typeof args[slot] === 'object' ? args[slot] : {};
      // Resolve every cwd form Node accepts; any other value is left for Node to judge.
      let cwd = here();
      try {
        const given = options.cwd == null ? null : toPath(options.cwd);
        if (given !== null) cwd = isAbsolute(given) ? resolve(given) : cwd === null ? null : resolve(cwd, given);
      } catch { /* Node reports it */ }
      for (const value of [command, ...(Array.isArray(args[0]) ? args[0] : [])]) {
        // Stat the same normalized path the edge records (a URL command is a path too).
        const name = path(value, cwd);
        if (name === null) continue;
        try { if (exists?.(resolve(root, name)).isFile()) add(value, 'spawn', cwd); } catch { /* not an existing script */ }
      }
      // The child's real env, as Node builds it: options.env, or process.env when falsy.
      if (!childTraces(options.env || env, cwd)) markIncomplete();
    } catch { markIncomplete(); }
  }
  /** True only when the child will run this hook with the same test identity, output directory and settings. */
  function childTraces(childEnv, cwd) {
    try {
      // Node walks env with for...in (inherited enumerable keys included), skips undefined and stringifies the rest.
      const seen = {};
      for (const key in childEnv) { const value = childEnv[key]; if (value !== undefined) seen[key] = `${value}`; }
      if (seen.WE_TRACE_TEST !== test || seen.WE_CI_SELECTION !== captured.WE_CI_SELECTION) return false;
      if (seen.WE_TRACE_DIR === undefined || captured.WE_TRACE_DIR === undefined) return false;
      if (!isAbsolute(seen.WE_TRACE_DIR) && cwd === null) return false;
      if (resolve(cwd ?? root, seen.WE_TRACE_DIR) !== captured.WE_TRACE_DIR) return false;
      return seen.NODE_OPTIONS !== undefined && importsHook(seen.NODE_OPTIONS);
    } catch { return false; }
  }
  // Silent by design: a traced process must print exactly what an untraced one prints. The snapshot carries the flag.
  function markIncomplete() { tracer.incomplete = true; }
  return tracer;
}

/** NODE_OPTIONS names this hook with --import, split as Node splits it (spaces; double quotes with backslash escapes). */
function importsHook(options) {
  const words = [];
  let word = null, quoted = false;
  for (let i = 0; i < options.length; i++) {
    const char = options[i];
    if (quoted && char === '\\' && i + 1 < options.length) { word = (word ?? '') + options[++i]; continue; }
    if (char === '"') { quoted = !quoted; word ??= ''; continue; }
    if (!quoted && char === ' ') { if (word !== null) words.push(word); word = null; continue; }
    word = (word ?? '') + char;
  }
  if (word !== null) words.push(word);
  const targets = new Set([hook, fileURLToPath(hook)]);
  return words.some((value, i) => (value.startsWith('--import=') && targets.has(value.slice(9)))
    || (value === '--import' && targets.has(words[i + 1])));
}

/**
 * The path forms Node's fs and child_process accept: string, Buffer/Uint8Array, or a file URL.
 * URLs are duck-typed because a test environment may install a different URL global than node:url's.
 * Returns null for anything else.
 */
function toPath(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
  // Node's own URL test: a legacy url.parse() result (it has auth/path) is not a URL to Node.
  if (value !== null && typeof value === 'object' && typeof value.href === 'string' && value.protocol === 'file:'
    && value.auth === undefined && value.path === undefined) return fileURLToPath(value.href);
  return null;
}

/** process.cwd() throws once the working directory is deleted; tracing then resolves absolute paths only. */
function here() {
  try { return process.cwd(); } catch { return null; }
}

/**
 * Sorted union of per-process evidence: { tests: {test: {file: kinds}}, incomplete: [test] }.
 * Missing entries remain unknown, never proof of coverage. A test whose evidence is incomplete (a process
 * flagged it, or the flag is absent) keeps its observed edges, but an edge it lacks is not proof of absence.
 */
export function mergeTraces(traces) {
  const tests = new Map();
  const truncated = new Set(traces.filter(t => t.truncated).map(t => t.test));
  const incomplete = new Set(traces.filter(t => !truncated.has(t.test) && t.incomplete !== false).map(t => t.test));
  for (const { test, edges } of traces) {
    if (truncated.has(test)) continue; // capped evidence is unknown, never a known trace
    if (!tests.has(test)) tests.set(test, new Map());
    for (const { file, kind } of edges) {
      const files = tests.get(test);
      if (!files.has(file)) files.set(file, new Set());
      files.get(file).add(kind);
    }
  }
  return { tests: Object.fromEntries([...tests].sort(([a], [b]) => a.localeCompare(b)).map(([test, files]) =>
    [test, Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, kinds]) => [file, [...kinds].sort()]))])),
  incomplete: [...incomplete].sort() };
}

/**
 * staticSelected is an optional list/Set of test paths. Missing evidence is explicitly unknown, and an
 * untraced result for a test with incomplete evidence is `traced: null` (unknown), never `false`.
 */
export function compareCoverage({ misses, traceMap, staticSelected }) {
  const staticKnown = staticSelected !== undefined;
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const tests = object(traceMap) ? traceMap.tests : undefined;
  if (!Array.isArray(misses) || misses.some(v => !object(v) || typeof v.test !== 'string' || typeof v.changed !== 'string')
    || !object(tests) || Object.values(tests).some(files => !object(files) || Object.values(files).some(kinds =>
      !Array.isArray(kinds) || !kinds.length || kinds.some(k => !['load', 'read', 'list', 'spawn'].includes(k))))
    || !Array.isArray(traceMap.incomplete) || traceMap.incomplete.some(t => typeof t !== 'string' || !Object.hasOwn(tests, t))
    || (staticKnown && (!(Array.isArray(staticSelected) || staticSelected instanceof Set) || [...staticSelected].some(v => typeof v !== 'string'))))
    throw new Error('invalid coverage evidence');
  const selected = new Set(staticSelected);
  const partial = new Set(traceMap.incomplete);
  const results = misses.map(({ test, changed }) => {
    const seen = Object.hasOwn(tests, test) && Object.hasOwn(tests[test], changed);
    return { test, changed, static: staticKnown ? selected.has(test) : null,
      traced: seen ? true : partial.has(test) ? null : false, traceKnown: Object.hasOwn(tests, test), incomplete: partial.has(test) };
  });
  const counts = { total: results.length, static: staticKnown ? results.filter(r => r.static).length : null,
    traced: results.filter(r => r.traced === true).length,
    additional: staticKnown ? results.filter(r => r.traced === true && !r.static).length : null,
    unknown: results.filter(r => !r.traceKnown).length, incomplete: results.filter(r => r.incomplete).length };
  return { ...(!staticKnown ? { staticEvidence: 'not supplied' } : {}), incomplete: counts.incomplete > 0, results, counts };
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
  // The loader worker makes shared pipes non-blocking; preserve synchronous child writes.
  for (const name of ['stdout', 'stderr']) {
    try {
      const handle = runtime[name]?._handle;
      if (typeof handle?.setBlocking === 'function') handle.setBlocking(true);
    } catch { /* tracing must not throw when a stream is unavailable */ }
  }
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
