/**
 * @file scripts/lib/test-cache-trace.mjs
 * @description prepare-124 S3 — the pure side of the runtime tracer for tier B (subprocess / git) test files.
 *
 * The tracer (scripts/test-cache/tracer.mjs) records raw events while one test file runs: fs reads/lists/stats,
 * spawned commands, network connects, and (from `node` children) the modules they load. This module turns those events
 * into (a) DENY reasons — the file depends on more than its key can name — and (b) a TRACED INPUT LIST: the repo files
 * the file read or ran that are NOT already in its static import closure, as `{label: hash}`. A stored result is only a
 * hit when that list still matches (the ccache "manifest" idea). It also owns the K-clean-runs admission rule
 * (decision F): a file that needs a trace is admitted only after K clean, stable traced runs in a row.
 *
 * Nothing here is ever used to skip a test in S3 (shadow only).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { cacheEnabled } from './test-result-cache.mjs';

/** Decision F: clean traced runs in a row before a tier B file may count as would-skip. */
export const ADMIT_AFTER_CLEAN_RUNS = 3;
/** Tools a traced file may spawn (`gh` is the fake from the setup file). Anything else denies the file. */
export const ALLOWED_TOOLS = ['node', 'git', 'gh'];

const sha = (s) => createHash('sha256').update(s).digest('hex');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '::', '']);
const GLOBAL_TOP_RE = /^(?:vitest\.[^/]+|tsconfig[^/]*\.json|package(?:-lock)?\.json|node_modules\/\.package-lock\.json)$/;
const NODE_VALUE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader', '--experimental-loader', '--input-type', '--conditions', '-C']);

/** Tracing runs only while the cache is on and not switched off with `WE_TEST_CACHE_TRACE=0`. */
export function traceEnabled(env = process.env) {
  return cacheEnabled(env) && env.WE_TEST_CACHE_TRACE !== '0';
}

/** Trace this file in this run? `WE_TEST_CACHE_TRACE_SAMPLE=N` traces about 1 file in N, rotating with the run id. */
export function sampledForTrace(file, runId, env = process.env) {
  const n = Math.floor(Number(env.WE_TEST_CACHE_TRACE_SAMPLE));
  if (!Number.isFinite(n) || n <= 1) return true;
  return Number.parseInt(sha(`${runId}\n${file}`).slice(0, 8), 16) % n === 0;
}

/** Split a child_process call into `{file, args, options, cb}` whatever shape the caller used. */
export function parseSpawnArgs(kind, argv) {
  const a = [...argv];
  let cb;
  if (typeof a[a.length - 1] === 'function') cb = a.pop();
  const file = a.shift();
  let args = [];
  let options;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (kind === 'exec' || kind === 'execSync') {
    if (isObj(a[0])) options = a.shift();
  } else {
    if (Array.isArray(a[0])) args = a.shift();
    if (isObj(a[0])) options = a.shift();
  }
  return { file, args, options: options ?? {}, cb };
}

/** Rebuild the argument list for the real function from a (possibly edited) parse. */
export function buildSpawnArgs(kind, { file, args, options, cb }) {
  const out = kind === 'exec' || kind === 'execSync' ? [file, options] : [file, args, options];
  if (cb) out.push(cb);
  return out;
}

const firstWord = (line) => String(line).trim().replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/)[0]?.replace(/^['"]|['"]$/g, '') ?? '';

/** The recorded form of one spawn. `fork` is `node <module>`; `exec`/`execSync` run a shell line. */
export function describeSpawn(kind, parsed, { execPath, cwd }) {
  const optCwd = parsed.options?.cwd;
  const base = { k: 'spawn', kind, cwd: resolve(cwd, optCwd ? String(optCwd) : '.') };
  if (kind === 'fork') return { ...base, cmd: execPath, args: [String(parsed.file), ...parsed.args.map(String)] };
  if (kind === 'exec' || kind === 'execSync') return { ...base, cmd: firstWord(parsed.file), args: [], shell: true };
  return { ...base, cmd: String(parsed.file), args: parsed.args.map(String), shell: Boolean(parsed.options?.shell) };
}

/** The tool name of a spawn event (`node` for the running node binary). */
export function toolOf(ev, execPath = process.execPath) {
  return ev.cmd === execPath ? 'node' : basename(ev.cmd);
}

/** For a `node` spawn: the entry script path (resolved against the spawn cwd), or null for `-e`/`-p`/stdin. */
export function nodeScriptOf(ev) {
  const args = ev.args ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print') return null;
    if (NODE_VALUE_FLAGS.has(arg)) { i += 1; continue; }
    if (arg.startsWith('-')) continue;
    return resolve(ev.cwd, arg);
  }
  return null;
}

/** The directory a spawn effectively works in: its cwd, or `git -C <dir>`. */
export function effectiveCwd(ev) {
  if (basename(ev.cmd) === 'git') {
    const i = (ev.args ?? []).indexOf('-C');
    if (i >= 0 && ev.args[i + 1]) return resolve(ev.cwd, ev.args[i + 1]);
  }
  return ev.cwd;
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** Absolute temp roots to treat as "throwaway": the given dirs plus their realpaths (macOS /var vs /private/var). */
export function tmpRootsOf(dirs) {
  return [...new Set(dirs.filter(Boolean).flatMap((d) => [resolve(d), real(resolve(d))]))];
}

/**
 * Analyse one file's raw events.
 * @param {{events: object[], root: string, fuiRoot?: string, tmpRoots: string[], home?: string, cacheDir?: string,
 *   closure: Set<string>, scriptClosure?: (abs: string) => string[], execPath?: string, allowTools?: string[]}} a
 * @returns {{denies: string[], traced: {path: string, kind: 'file'|'dir'}[], spawns: number, reads: number}}
 */
export function analyzeTrace({ events, root, fuiRoot = null, tmpRoots, home = '', cacheDir = '', closure, scriptClosure = null, execPath = process.execPath, allowTools = ALLOWED_TOOLS, toolchainDirs = [dirname(dirname(execPath))] }) {
  const denies = new Set();
  const traced = new Map();
  const rootReal = real(root);
  const repoRoots = [root, rootReal, ...(fuiRoot ? [fuiRoot, real(fuiRoot)] : [])];
  const isTmp = (p) => tmpRoots.some((t) => under(p, t));
  const isRepo = (p) => repoRoots.some((r) => under(p, r));
  const homes = home ? [home, real(home)] : [];
  // The node install itself (e.g. ~/.nvm/versions/node/vX) is the toolchain: it is in the key via the full node version.
  const toolchain = toolchainDirs.flatMap((d) => [d, real(d)]).filter((t) => t.length > 1 && !homes.some((h) => under(h, t)));
  const covered = (p) => closure.has(p) || [root, rootReal].some((r) => under(p, r) && GLOBAL_TOP_RE.test(relative(r, p)));
  const addTraced = (p, kind) => { if (!covered(p) && !traced.has(`${kind}:${p}`)) traced.set(`${kind}:${p}`, { path: p, kind }); };
  let spawns = 0;
  let reads = 0;

  const touch = (p, kind) => {
    if (!p || !p.startsWith('/') || p.includes(`${sep}node_modules${sep}`) || isTmp(p) || (cacheDir && under(p, cacheDir)) || toolchain.some((t) => under(p, t)) || p.startsWith('/dev/')) return;
    if (isRepo(p)) { addTraced(p, kind); return; }
    if (homes.some((h) => under(p, h))) denies.add(`home-read: ${p.slice(home.length + 1).split('/').slice(0, 2).join('/') || '~'}`);
  };

  for (const ev of events) {
    if (ev.k === 'read' || ev.k === 'stat' || ev.k === 'exists') { reads += 1; touch(ev.p, 'file'); }
    else if (ev.k === 'list') { reads += 1; touch(ev.p, 'dir'); }
    else if (ev.k === 'mod') touch(ev.p, 'file');
    else if (ev.k === 'net') {
      if (ev.path) continue; // unix socket: local
      if (!LOOPBACK.has(String(ev.host ?? ''))) denies.add(`network: ${ev.host}`);
    } else if (ev.k === 'spawn') {
      spawns += 1;
      const tool = toolOf(ev, execPath);
      if (!allowTools.includes(tool)) denies.add(`tool: ${tool}`);
      const cwd = effectiveCwd(ev);
      if (isRepo(cwd) && !isTmp(cwd)) denies.add(`checkout-cwd: ${tool}`);
      if (tool === 'node') {
        const script = nodeScriptOf(ev);
        if (script && !isTmp(script)) {
          touch(script, 'file');
          // the script's static import closure stands in for the modules the child loads (no loader hook; see child-tracer.mjs)
          if (scriptClosure) { try { for (const f of scriptClosure(script)) touch(f, 'file'); } catch { /* unresolvable: the script itself is still listed */ } }
        }
      }
    }
  }
  return { denies: [...denies].sort(), traced: [...traced.values()].sort((a, b) => a.path.localeCompare(b.path)), spawns, reads };
}

/** Hash of one traced input: file content, a directory's sorted listing, or `absent`. */
export function hashTracedInput({ path, kind }) {
  try {
    const st = statSync(path);
    if (st.isDirectory()) return sha(readdirSync(path).sort().join('\n'));
    if (kind === 'dir') return 'absent';
    return sha(readFileSync(path));
  } catch { return 'absent'; }
}

/** `{label: hash}` for a traced list; labels are repo-relative so lanes share entries. */
export function tracedMap(traced, { root, fuiRoot = null }) {
  const out = {};
  const rootReal = real(root);
  const fuiReal = fuiRoot ? real(fuiRoot) : null;
  for (const t of traced) {
    const label = under(t.path, root) ? relative(root, t.path)
      : under(t.path, rootReal) ? relative(rootReal, t.path)
        : fuiRoot && under(t.path, fuiRoot) ? `@fui/${relative(fuiRoot, t.path)}`
          : fuiReal && under(t.path, fuiReal) ? `@fui/${relative(fuiReal, t.path)}`
            : t.path;
    out[`${t.kind}:${label}`] = hashTracedInput(t);
  }
  return out;
}

export const sameTracedMap = (a, b) => {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/** Stable digest of WHICH inputs a file touches (not their contents): a change resets the clean-run count. */
export const tracedDigest = (map) => sha(Object.keys(map ?? {}).sort().join('\n'));

/**
 * Admission after a run (decision F). `clean` = traced, passed in full, no deny reasons.
 * A clean run with the same traced-input names as the last clean run counts up; anything else restarts or resets.
 */
export function nextAdmission(prev, { clean, digest, reasons = [] }, k = ADMIT_AFTER_CLEAN_RUNS) {
  if (!clean) return { cleanRuns: 0, digest: null, status: reasons.length ? 'denied' : 'unclean', reasons, admitted: false };
  const cleanRuns = prev && prev.status === 'clean' && prev.digest === digest ? prev.cleanRuns + 1 : 1;
  return { cleanRuns, digest, status: 'clean', reasons: [], admitted: cleanRuns >= k };
}

/** Is a file admitted as of its PREVIOUS runs (what a skip decision made before this run could know)? */
export const isAdmitted = (prev, k = ADMIT_AFTER_CLEAN_RUNS) => Boolean(prev && prev.status === 'clean' && prev.cleanRuns >= k);

/** Parse the lines a traced `node` child appended: `{t:'mod',u}` module loads and `{t:'fs',events}` batches. */
export function parseChildTrace(text) {
  const events = [];
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.t === 'mod' && typeof row.u === 'string' && row.u.startsWith('file://')) {
      try { events.push({ k: 'mod', p: decodeURIComponent(new URL(row.u).pathname) }); } catch { /* skip */ }
    } else if (row.t === 'fs' && Array.isArray(row.events)) events.push(...row.events);
  }
  return events;
}

/** Read one file's trace (parent events + child lines) from the run's trace dir; null when there is none. */
export function readTraceEvents(tracePathBase) {
  let parent;
  try { parent = JSON.parse(readFileSync(`${tracePathBase}.json`, 'utf8')); } catch { return null; }
  let child = [];
  try { child = parseChildTrace(readFileSync(`${tracePathBase}.child.jsonl`, 'utf8')); } catch { /* no children */ }
  return { events: [...(parent.events ?? []), ...child], parent };
}

export const traceFileBase = (dir, runId, file) => join(dir, 'traces', runId, sha(file));
