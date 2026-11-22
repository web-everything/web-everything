/**
 * @file scripts/ci/dep-trace.mjs
 * @description Shadow dependency evidence only; never selects tests.
 * Set WE_TRACE_TEST=repo/test.mjs WE_TRACE_DIR=artifact-directory and append
 * ` --import="file:///absolute/repo/scripts/ci/dep-trace.mjs"` to existing NODE_OPTIONS.
 * Observe-only: child_process calls and the environment are never rewritten, and a caller value is read only
 * when the read cannot run caller code (no getter, no Proxy, no object toString). A child that is not Node
 * (a shell, `cat`), one whose real env lacks the hook, test identity, directory or settings, and one whose
 * options or env could not be read safely mark the evidence `incomplete`.
 * Edge caps emit an incomplete-evidence warning: rerun with a larger cap before using coverage.
 */
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { register, syncBuiltinESMExports } from 'node:module';
import { MessageChannel, receiveMessageOnPort, threadId } from 'node:worker_threads';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { promisify, types } from 'node:util';

const hook = import.meta.url;
const ROOT = fileURLToPath(new URL('../../', hook));
const defaults = { enabled: true, maxEdgesPerTest: 5000 };
/** A read the tracer refused because it could run caller code; the evidence is then incomplete. */
const UNSAFE = Symbol('unsafe');
// Intrinsics captured before any test code runs, so a later monkeypatch never runs inside the tracer.
const { statSync, accessSync, realpathSync, constants: { X_OK } } = fs;
const bufferFrom = Buffer.from, bufferToString = Buffer.prototype.toString;
/** Above these sizes the tracer stops reading and marks the evidence incomplete (Node judges the call). */
const MAX_ARGS = 65536, MAX_PATH_BYTES = 65536;
/** Node options with which the hook may not load, or the work runs outside Node (`--run` uses a shell). */
// An env or config file can supply trace settings the parent never had, so it is untraced too.
const UNTRACED_FLAGS = ['--run', '--permission', '--experimental-permission', '--check', '-c', '--env-file',
  '--env-file-if-exists', '--experimental-config-file', '--experimental-default-config-file', '--experimental-sea-config'];
/** node:url's own URL getters, captured at load: a getter a test later installs is caller code. */
const urlGetters = new Set(Object.values(Object.getOwnPropertyDescriptors(NodeURL.prototype)).map(d => d.get).filter(Boolean));
const untracedFlag = word => typeof word === 'string' && UNTRACED_FLAGS.some(flag => word === flag || word.startsWith(`${flag}=`));

/**
 * True when `command` starts the running Node binary: a path resolving (via realpath) to execPath, or a bare
 * name found first on the child's PATH whose realpath is execPath. Relative or empty PATH entries, Windows,
 * and anything unreadable answer false (incomplete evidence). Uses the intrinsics captured above.
 */
export function nodeBinary(command, pathValue, cwd, execPath = process.execPath) {
  if (typeof command !== 'string' || !command || process.platform === 'win32') return false;
  const same = file => { try { return realpathSync(file) === realpathSync(execPath); } catch { return false; } };
  if (command.includes(sep)) return isAbsolute(command) ? same(command) : cwd !== null && same(resolve(cwd, command));
  if (typeof pathValue !== 'string') return false;
  for (const dir of pathValue.split(':')) {
    if (!isAbsolute(dir)) return false;
    const file = resolve(dir, command);
    try { if (!statSync(file).isFile()) continue; accessSync(file, X_OK); } catch { continue; }
    return same(file);
  }
  return false;
}

/** Gives a wrapper the original's name and length, so a traced function looks like Node's own. */
function mirror(wrapper, original) {
  for (const key of ['name', 'length']) {
    const d = Reflect.getOwnPropertyDescriptor(original, key);
    if (d && Object.hasOwn(d, 'value')) Object.defineProperty(wrapper, key, d);
  }
  return wrapper;
}

/**
 * obj[key] read without running caller code, or UNSAFE. Walks the prototype chain by descriptor, refusing at a
 * Proxy or a getter; node:url's own URL getters are pure and allowed. Observe-only (PR #7123): Node reads the
 * value again, so a second read of a getter would hand the child a different value than an untraced run.
 */
function peek(obj, key) {
  for (let o = obj; o !== null; o = Reflect.getPrototypeOf(o)) {
    if (types.isProxy(o)) return UNSAFE;
    const d = Reflect.getOwnPropertyDescriptor(o, key);
    if (!d) continue;
    if (Object.hasOwn(d, 'value')) return d.value;
    return o === NodeURL.prototype && urlGetters.has(d.get) ? Reflect.apply(d.get, obj, []) : UNSAFE;
  }
  return undefined;
}

/**
 * The child env as Node builds it (for...in, inherited enumerable keys included, undefined skipped, the rest
 * stringified), or null when reading it could run caller code: a Proxy in the chain, a getter, an object value.
 */
function readEnv(childEnv) {
  if (childEnv === null || typeof childEnv !== 'object') return null;
  for (let o = childEnv; o !== null; o = Reflect.getPrototypeOf(o)) if (types.isProxy(o)) return null;
  const seen = Object.create(null);
  for (const key in childEnv) {
    const value = peek(childEnv, key);
    if (value === UNSAFE || (value !== null && (typeof value === 'object' || typeof value === 'function'))) return null;
    if (value !== undefined) seen[key] = `${value}`;
  }
  return seen;
}

/** Pure construction: only install() mutates the injected objects; record receives unique edges. */
export function createTracer({ test, root, record = () => {}, fs: io = {}, child_process: cp = {},
  env = {}, maxEdgesPerTest = 5000, warn = () => {}, execPath = process.execPath, liveEnv = () => env,
  isNodeBinary = (command, pathValue, cwd) => nodeBinary(command, pathValue, cwd, execPath) }) {
  // What a child must match to trace into this evidence; resolved at activation, before any chdir.
  const captured = { WE_CI_SELECTION: env.WE_CI_SELECTION === undefined ? undefined : `${env.WE_CI_SELECTION}`,
    WE_TRACE_DIR: env.WE_TRACE_DIR === undefined ? undefined : resolve(`${env.WE_TRACE_DIR}`) };
  const edges = new Map();
  const exists = io.statSync?.bind(io);
  function path(value, cwd = root, kind) {
    try {
      // Only the loader reports URL strings; to fs and child_process a `file:` string is a literal relative path.
      value = kind === 'load' && typeof value === 'string' && value.startsWith('file:') ? fileURLToPath(value) : toPath(value);
      if (value === UNSAFE) { markIncomplete(); return null; }
      if (value === null || value.startsWith('node:')) return null;
      // No working directory (it was deleted): only an absolute path can be resolved.
      if (cwd === null) { if (!isAbsolute(value)) return null; cwd = root; }
      const name = relative(root, resolve(cwd, value));
      if (name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name) || name.split(sep).includes('node_modules')) return null;
      return name.split(sep).join('/') || '.';
    } catch { return null; }
  }
  function add(value, kind, cwd) {
    const file = path(value, cwd, kind);
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
      if (original) io[name] = mirror(function (...args) { add(args[0], kind, here()); return Reflect.apply(original, this, args); }, original);
    }
    // Promise-based reads (fs/promises) are dependencies too; without this they would look like absent edges.
    const promises = io.promises;
    if (promises) {
      for (const [name, kind] of Object.entries({ readFile: 'read', readdir: 'list' })) {
        const original = promises[name];
        if (typeof original === 'function') promises[name] = mirror(function (...args) { add(args[0], kind, here()); return Reflect.apply(original, this, args); }, original);
      }
    }
    // execSync calls Node's internal spawnSync, so it needs its own wrapper; exec reaches the exported execFile.
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'fork']) {
      const original = cp[name];
      if (!original) continue;
      // Observe-only: the caller's arguments reach Node unchanged (same values, same count, same receiver).
      cp[name] = mirror(function (...args) { observe(name, args); return Reflect.apply(original, this, args); }, original);
      // Keep util.promisify's {stdout, stderr} contract: the original custom promisifier gets the same untouched arguments.
      const custom = original[promisify.custom];
      if (typeof custom === 'function') {
        Object.defineProperty(cp[name], promisify.custom, { configurable: true, value: mirror(function (...args) { observe(name, args); return Reflect.apply(custom, this, args); }, custom) });
      }
    }
  } };
  /**
   * Reads a child_process call without changing it: records the spawn edge and flags a child that will not trace.
   * Every caller value is read through peek, so a getter or Proxy is never run; one that cannot be read marks
   * the evidence incomplete and the call still reaches Node untouched.
   */
  function observe(name, [command, ...args]) {
    try {
      // Node takes options after an args array or an explicit null/undefined args slot; otherwise in the first slot.
      const list = Array.isArray(args[0]) ? args[0] : null;
      const slot = list || args[0] == null ? 1 : 0;
      const options = args[slot] !== null && typeof args[slot] === 'object' ? args[slot] : {};
      const [cwdOption, envOption, shell, forkExec, execArgv] = ['cwd', 'env', 'shell', 'execPath', 'execArgv'].map(key => peek(options, key));
      if ([cwdOption, envOption, shell, forkExec, execArgv].includes(UNSAFE)) return markIncomplete();
      const values = [command];
      const nodeArgs = readList(list);
      // Node spreads any iterable execArgv (a falsy one means the parent's own); only an array can be read safely.
      const forkArgs = name === 'fork' && execArgv ? (Array.isArray(execArgv) ? readList(execArgv) : null) : [];
      if (nodeArgs === null || forkArgs === null) return markIncomplete();
      values.push(...nodeArgs);
      // Resolve every cwd form Node accepts; any other value is left for Node to judge.
      let cwd = here();
      try {
        const given = cwdOption == null ? null : toPath(cwdOption);
        if (given === UNSAFE) return markIncomplete();
        if (given !== null) cwd = isAbsolute(given) ? resolve(given) : cwd === null ? null : resolve(cwd, given);
      } catch { /* Node reports it */ }
      for (const value of values) {
        // Stat the same normalized path the edge records (a URL command is a path too).
        const file = path(value, cwd);
        if (file === null) continue;
        try { if (exists?.(resolve(root, file)).isFile()) add(value, 'spawn', cwd); } catch { /* not an existing script */ }
      }
      // The child's real env, as Node builds it at call time: options.env, or the live process.env when falsy.
      const childEnv = envOption || liveEnv();
      const seen = childEnv === UNSAFE ? null : readEnv(childEnv);
      if (seen === null) return markIncomplete();
      // A non-Node child (a shell, `cat`) never loads the hook, so whatever it reads is untraced.
      if (!nodeChild(name, command, shell, forkExec, seen.PATH, cwd)) return markIncomplete();
      // Flags with which the hook may not load, or that hand the work to a shell (`--run`).
      if ((name === 'fork' ? forkArgs : nodeArgs).some(untracedFlag)) return markIncomplete();
      if (!childTraces(seen, cwd)) markIncomplete();
    } catch { markIncomplete(); }
  }
  /** The elements of a caller array read by descriptor, or null when a getter, a Proxy or its size forbids it. */
  function readList(array) {
    if (array === null) return [];
    const length = peek(array, 'length');
    if (!Number.isSafeInteger(length) || length > MAX_ARGS) return null;
    const values = [];
    for (let i = 0; i < length; i++) {
      const value = peek(array, i);
      if (value === UNSAFE) return null;
      values.push(value);
    }
    return values;
  }
  /**
   * True only when Node itself is the child: fork (its execPath unset or Node), or a shell-less spawn of Node.
   * execSync and any `shell` option run a shell first, whose command may read files untraced.
   */
  function nodeChild(name, command, shell, forkExec, pathValue, cwd) {
    if (name === 'fork') return forkExec == null || isNodeBinary(forkExec, pathValue, cwd);
    return name !== 'execSync' && !shell && isNodeBinary(command, pathValue, cwd);
  }
  /** True only when the child will run this hook with the same test identity, output directory and settings. */
  function childTraces(seen, cwd) {
    try {
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
  // A flag with which the hook may not load (or the work leaves Node) makes the child untraced.
  if (words.some(untracedFlag)) return false;
  return words.some((value, i) => (value.startsWith('--import=') && targets.has(value.slice(9)))
    || (value === '--import' && targets.has(words[i + 1])));
}

/**
 * The path forms Node's fs and child_process accept: string, Buffer/Uint8Array, or a file URL.
 * URLs are duck-typed because a test environment may install a different URL global than node:url's
 * (happy-dom's extends it). Returns null for anything else, and UNSAFE when reading the value could run
 * caller code (a getter outside node:url's URL, a Proxy): the evidence is then incomplete.
 */
function toPath(value) {
  if (typeof value === 'string') return value;
  // Intrinsic TypedArray getters: a subclass or own getter cannot run.
  if (types.isUint8Array(value)) {
    const [buffer, offset, length] = [viewBuffer, viewOffset, viewLength].map(get => Reflect.apply(get, value, []));
    return length > MAX_PATH_BYTES ? UNSAFE : Reflect.apply(bufferToString, Reflect.apply(bufferFrom, Buffer, [buffer, offset, length]), []);
  }
  if (value === null || typeof value !== 'object') return null;
  // Node's own URL test: a legacy url.parse() result (it has auth/path) is not a URL to Node.
  const [href, protocol, auth, legacy, hostname, pathname] = ['href', 'protocol', 'auth', 'path', 'hostname', 'pathname'].map(key => peek(value, key));
  if ([href, protocol, auth, legacy].includes(UNSAFE)) return UNSAFE;
  if (!href || !protocol || auth !== undefined || legacy !== undefined) return null;
  if (protocol !== 'file:') return null;
  // Node converts a URL object from its hostname and pathname (not href); only plain strings are read.
  if (typeof hostname !== 'string' || typeof pathname !== 'string') return UNSAFE;
  return fileURLToPath(value);
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const [viewBuffer, viewOffset, viewLength] = ['buffer', 'byteOffset', 'byteLength']
  .map(key => Object.getOwnPropertyDescriptor(typedArray, key).get);

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
  // Node reads process.env at call time, so a test that reassigns it changes what a child inherits.
  const liveEnv = () => { const live = peek(runtime, 'env'); return live === undefined ? env : live; };
  const tracer = createTracer({ test: env.WE_TRACE_TEST, root: ROOT, env, liveEnv, fs: io, child_process: cp,
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
