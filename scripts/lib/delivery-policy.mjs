/** Delivery-flow policy: human-gated values, base-ref isolation, and a best-effort event journal. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { defaultLogsDir } from '../conveyor/health-watch.mjs';
import { daemonStateDir } from './daemon-last-good.mjs';
import { isPolicySpecPath, readPolicySpecRegistryAt } from './gate-config.mjs';

export const POLICY_EVENT_REASON_MAX = 200;
export const DELIVERY_POLICY_FAILSAFE = Object.freeze({
  prCi: Object.freeze({ mainStateParity: 'on' }),
  mergeGate: Object.freeze({ recheckWhenMainMoved: 'always', recheckMaxAgeMin: 30, onMainRed: 'halt' }),
  dispatchGate: Object.freeze({ overlapOverride: 'off' }),
  heavyQueue: Object.freeze({ priority: 'repairs-first', reservedForRepairs: 1, reservedBorrowAfterMin: 10 }),
  drain: Object.freeze({ onStepRefusal: 'alert' }),
});
const DEFAULTS_FILE = 'config/deliveryPolicyDefaults.ts';
const ROOT_FILE = 'webeverything.config.json';
const MAX_SOURCE_BYTES = 1024 * 1024;
const domains = {
  prCi: { mainStateParity: ['on', 'off'] },
  mergeGate: { recheckWhenMainMoved: ['if-older-than-N-min', 'always', 'off'], recheckMaxAgeMin: 1, onMainRed: ['halt', 'warn', 'off'] },
  dispatchGate: { overlapOverride: ['off', 'logged', 'free'] },
  heavyQueue: { priority: ['repairs-first', 'fifo'], reservedForRepairs: 0, reservedBorrowAfterMin: 1 },
  drain: { onStepRefusal: ['alert', 'log'] },
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const valid = (value, domain) => Array.isArray(domain) ? domain.includes(value) : Number.isSafeInteger(value) && value >= domain;
const clone = value => structuredClone(value);
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const clean = (value, max) => {
  const text = String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};
function identityText(value, max, byteLimit) {
  let text = clean(value, max);
  // JSON escapes lone surrogates and quotes: character limits alone do not bound wire bytes.
  while (Buffer.byteLength(JSON.stringify(text)) > byteLimit) text = text.slice(0, -2) + '…';
  return text;
}
function sanitise(value, depth = 0, state = { remaining: 256, seen: new Set() }) {
  // Bound traversal before the wire-size check, even for trees without shared references.
  if (state.remaining-- <= 0) return null;
  if (typeof value === 'string') return clean(value, 500);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth >= 8 || typeof value !== 'object' || state.seen.has(value)) return null;
  // Keep references for the entire traversal: aliases, like cycles, become null.
  state.seen.add(value);
  if (Array.isArray(value)) {
    const result = [];
    for (let i = 0; i < Math.min(value.length, 20) && state.remaining > 0; i++) {
      result.push(sanitise(value[i], depth + 1, state));
    }
    return result;
  }
  const entries = [];
  for (const key of Object.keys(value).slice(0, 100)) {
    if (state.remaining <= 0) break;
    entries.push([clean(key, 500), sanitise(value[key], depth + 1, state)]);
  }
  return Object.fromEntries(entries);
}

export function policyEventsPath(env = process.env) {
  try { return env.WE_POLICY_EVENTS_FILE || join(defaultLogsDir(env), 'policy-events.jsonl'); } catch { return undefined; }
}

/** Optional env argument keeps callers and fixtures independent of ambient daemon state. */
export function recordPolicyEvent(input, env = process.env) {
  try {
    const event = { at: new Date().toISOString(), key: identityText(input.key, 200, 800), event: identityText(input.event, 200, 800), subject: identityText(input.subject, 500, 2000), reason: clean(input.reason, POLICY_EVENT_REASON_MAX) };
    if (input.detail !== undefined) event.detail = sanitise(input.detail);
    const bytes = () => Buffer.byteLength(JSON.stringify(event) + '\n');
    if (bytes() > 4096 && object(event.detail)) {
      for (const key of Object.keys(event.detail).reverse()) {
        delete event.detail[key];
        if (bytes() <= 4096) break;
      }
    }
    if (bytes() > 4096) delete event.detail;
    // Non-detail text is bounded too; keep the identity fields even for multibyte input.
    if (bytes() > 4096) event.reason = '…';
    const path = policyEventsPath(env);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch { /* A failed journal must never stop the daemon. */ }
}

export function readPolicyEvents({ sinceMs = 0, env = process.env } = {}) {
  try {
    return readFileSync(policyEventsPath(env), 'utf8').split('\n').flatMap(line => {
      try { const entry = JSON.parse(line); return object(entry) && Date.parse(entry.at) >= sinceMs ? [entry] : []; } catch { return []; }
    });
  } catch { return []; }
}

// Cache source-derived data, never the trust decision: confinement and the registry are checked each run.
const cache = new Map();
async function cached(key, version, read) {
  if (cache.get(key)?.version === version) return cache.get(key).value;
  const value = await read();
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, { version, value });
  return value;
}
function resultFrom(defaults) {
  return { ...clone(defaults), sources: Object.fromEntries(Object.entries(defaults).map(([key, fields]) => [key, Object.fromEntries(Object.keys(fields).map(field => [field, 'default']))])), warnings: [], filesRead: [] };
}

async function transpileDefaults(source, env) {
  let scratch;
  try {
    scratch = mkdtempSync(join(env.TMPDIR || process.env.TMPDIR || tmpdir(), 'delivery-policy-defaults-'));
    const entry = join(scratch, 'deliveryPolicyDefaults.ts');
    writeFileSync(entry, source);
    // The component-tokens pattern: bundle real TS to an in-memory ESM data URL.
    // Type imports disappear before resolution; any runtime import is an ungated value source.
    const output = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
      plugins: [{ name: 'type-imports-only', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => args.kind === 'entry-point' ? undefined : { errors: [{ text: 'Policy defaults permit import type only' }] });
      } }],
    });
    const module = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
    const defaults = module.PLATFORM_DELIVERY_POLICY_DEFAULTS;
    if (!object(defaults) || Object.keys(defaults).length !== Object.keys(domains).length) throw Error('Incomplete defaults');
    for (const [key, fields] of Object.entries(domains)) {
      if (!object(defaults[key]) || Object.keys(defaults[key]).length !== Object.keys(fields).length) throw Error('Incomplete defaults');
      for (const [field, domain] of Object.entries(fields)) if (!valid(defaults[key][field], domain)) throw Error('Invalid default');
    }
    return defaults;
  } finally {
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Best effort. */ } }
  }
}

/** Resolve only human-gated sources. On incomplete evidence, retain defaults (or the protective failsafe). */
export async function loadDeliveryPolicy({ root = process.cwd(), env = process.env, ref } = {}) {
  const emergency = resultFrom(DELIVERY_POLICY_FAILSAFE);
  try {
    root = realpathSync(root);
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: MAX_SOURCE_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
    let commit;
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-')) throw Error('Invalid base ref');
      commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw Error('Invalid base commit');
    }
    let registry;
    // Defaults/post-check fall back to the live registry if the base registry is unavailable; ref pointers do not.
    const registered = (path, requireBaseRegistry = false) => commit && (registry || requireBaseRegistry)
      ? registry?.has(basename(path)) === true : isPolicySpecPath(path);
    const filesRead = [];
    const opened = new Set();
    const mark = path => { if (!opened.has(path)) { opened.add(path); filesRead.push(path); } };
    function locate(path, external = false) {
      const absolute = resolve(root, path);
      if (commit && !external) {
        const normalized = relative(root, absolute).split(sep).join('/');
        if (!inside(root, absolute)) throw Error(`Outside root: ${path}`);
        const tree = git(['ls-tree', '-z', commit, '--', normalized]);
        const match = /^(100644|100755) blob [a-f0-9]+\t([^\0]+)\0$/.exec(tree);
        if (!match || match[2] !== normalized) throw Error(`Not a regular policy blob: ${path}`);
        return { path: normalized, version: commit, read: () => git(['show', `${commit}:${normalized}`]) };
      }
      if (lstatSync(absolute).isSymbolicLink()) throw Error(`Policy symlink refused: ${path}`);
      const real = realpathSync(absolute);
      // Refuse symlinked parents as well as the leaf before consulting cached content.
      if (!external && real !== resolve(realpathSync(root), relative(root, absolute))) throw Error(`Policy symlink refused: ${path}`);
      if (!external && !inside(root, real)) throw Error(`Outside root: ${path}`);
      const stat = statSync(real);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw Error(`Unreadable or oversized policy source: ${path}`);
      return { path: external ? real : relative(root, real).split(sep).join('/'), version: stat.mtimeMs, read: () => readFileSync(real, 'utf8') };
    }
    async function read(location, kind) {
      return cached(`${root}:${commit || 'worktree'}:${location.path}:${kind}`, location.version, async () => {
        const source = location.read();
        mark(location.path);
        if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw Error('Oversized source');
        return kind === 'defaults' ? transpileDefaults(source, env) : JSON.parse(source);
      }).then(value => { mark(location.path); return value; });
    }
    // A missing registry refuses pointers. Defaults and root still have the fixed, human-gated contract.
    if (commit) registry = await readPolicySpecRegistryAt(commit, { root });
    let defaults;
    try {
      const location = locate(DEFAULTS_FILE);
      if (!registered(location.path)) throw Error('Ungated defaults');
      defaults = await read(location, 'defaults');
    } catch {
      emergency.filesRead = filesRead;
      emergency.warnings.push('Policy defaults unreadable; using most-protective failsafe. Restore the human-gated defaults file.');
      recordPolicyEvent({ key: 'deliveryPolicy', event: 'policy-defaults-unreadable', subject: DEFAULTS_FILE, reason: emergency.warnings[0] }, env);
      return emergency;
    }
    const result = resultFrom(defaults);
    result.filesRead = filesRead;
    const warn = message => result.warnings.push(clean(message, 1000));
    let sourcePath = ROOT_FILE, external = false, envSource = false;
    if (env.WE_POLICY_CONFIG) {
      try {
        if (env.GITHUB_ACTIONS || commit) throw Error('WE_POLICY_CONFIG ignored for PR/Actions gates');
        const requested = resolve(root, env.WE_POLICY_CONFIG);
        if (!requested.endsWith('.json')) throw Error('WE_POLICY_CONFIG must be JSON');
        const real = realpathSync(requested);
        if (lstatSync(requested).isSymbolicLink()) throw Error('WE_POLICY_CONFIG symlink refused');
        const inRoot = inside(root, real);
        if (inRoot ? !isPolicySpecPath(relative(root, real).split(sep).join('/')) : !inside(realpathSync(daemonStateDir(env)), real)) throw Error('WE_POLICY_CONFIG is outside registered repo sources and daemon state');
        sourcePath = inRoot ? relative(root, real).split(sep).join('/') : real;
        external = !inRoot;
        envSource = true;
      } catch (error) { warn(error.message); }
    }
    let config, location;
    try {
      location = locate(sourcePath, external);
      if (!external && !isPolicySpecPath(location.path)) throw Error(`Unregistered policy source: ${location.path}`);
      config = await read(location, 'json');
      if (!object(config)) throw Error('Policy config must be an object');
    } catch (error) {
      // Absence of the conventional root file is normal; unreadable existing sources are not.
      const absent = sourcePath === ROOT_FILE && (commit ? !git(['ls-tree', '-z', commit, '--', ROOT_FILE]) : error.code === 'ENOENT');
      if (!absent) warn(`Cannot read policy config ${sourcePath}: ${error.message}`);
    }
    const origins = new Map();
    async function entry(value, chain) {
      if (typeof value !== 'string') return { value, chain };
      if (chain.length >= 20 || isAbsolute(value) || !value.endsWith('.json') || !inside(root, resolve(root, value))) throw Error(`Policy pointer refused: ${value}`);
      const target = locate(value);
      if (!registered(target.path, true)) throw Error(`Unregistered policy pointer: ${target.path}`);
      if (chain.includes(target.path)) throw Error(`Policy pointer cycle: ${target.path}`);
      return entry(await read(target, 'json'), [...chain, target.path]);
    }
    if (object(config)) for (const [key, fields] of Object.entries(domains)) {
      if (!Object.hasOwn(config, key)) continue;
      try {
        const resolved = await entry(config[key], [location.path]);
        let value = resolved.value;
        if (object(value) && value.kind === 'extends-flavor') {
          if (!Array.isArray(value.flavors) || value.flavors.some(flavor => typeof flavor !== 'string')) throw Error(`Invalid descriptor: ${key}`);
          value = value.overrides ?? {};
        }
        if (!object(value)) throw Error(`Invalid policy dimension: ${key}`);
        for (const [field, setting] of Object.entries(value)) {
          if (!Object.hasOwn(fields, field) || !valid(setting, fields[field])) { warn(`Invalid policy value: ${key}.${field}`); continue; }
          result[key][field] = setting;
          result.sources[key][field] = 'config';
          origins.set(`${key}.${field}`, resolved.chain);
        }
      } catch (error) { warn(error.message); }
    }
    // Independent post-check over every opened value source, even if an earlier guard was bypassed.
    const exempt = file => external && envSource && file === sourcePath && !inside(root, file) && inside(realpathSync(daemonStateDir(env)), file);
    for (const file of filesRead) {
      const allowed = exempt(file) || registered(file);
      if (allowed) continue;
      warn(`Ungated policy source dropped by post-check: ${file}`);
      if (file === DEFAULTS_FILE) {
        const protective = resultFrom(DELIVERY_POLICY_FAILSAFE);
        return { ...protective, warnings: result.warnings, filesRead };
      }
      for (const [key, fields] of Object.entries(domains)) for (const field of Object.keys(fields)) {
        if (origins.get(`${key}.${field}`)?.includes(file)) { result[key][field] = defaults[key][field]; result.sources[key][field] = 'default'; }
      }
    }
    if (envSource) for (const [key, fields] of Object.entries(domains)) {
      const changed = Object.keys(fields).filter(field => result[key][field] !== defaults[key][field]);
      if (changed.length) recordPolicyEvent({ key, event: 'policy-source-env', subject: key, detail: { file: sourcePath, fields: changed.map(field => `${key}.${field}`) } }, env);
    }
    return result;
  } catch {
    emergency.warnings.push('Policy sources unavailable; using most-protective failsafe. Check the root and trusted base ref.');
    recordPolicyEvent({ key: 'deliveryPolicy', event: 'policy-defaults-unreadable', subject: DEFAULTS_FILE, reason: emergency.warnings[0] }, env);
    return emergency;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flags = process.argv.slice(2);
  const ref = flags.find(flag => flag.startsWith('--ref='))?.slice(6);
  const index = flags.indexOf('--ref');
  const result = await loadDeliveryPolicy({ ref: ref ?? (index >= 0 ? flags[index + 1] || '' : undefined) });
  process.stdout.write(JSON.stringify(result, null, flags.includes('--json') ? 0 : 2) + '\n');
}
