/**
 * Closed-grammar process boundary: snapshot plain data, then BUILD the invocation.
 * PR #7022's fourteen attack classes (shell/env/other wrappers, raw options, option
 * smuggling, expanded ids, accessors, Proxies, argv0, execPath/execArgv, runtime
 * env, shell env, HOME, mutation/aliasing) shared one root: inspected and executed
 * views differed. No caller argv, unclassified caller env, binary, or spawn options cross this boundary.
 * Environment threat model: ambient process.env, including unknown names, inherits
 * parent parity (main parity) minus the registry's never list; value gates and
 * absolute-path validation still apply. Ambient indexed Git config passes only as
 * a complete set of exact hardening pins; caller Git config is always ignored.
 * Caller inheritEnv is tighten-only: registry classes, parent precedence, and numeric
 * ceilings constrain it. A positive bag limit needs an ambient ceiling; a documented
 * strict zero cannot relax configured policy. Ambient quantities survive verbatim.
 * Only exact gh auth/throttle shim directories under the real account home survive. Other
 * parent PATH entries cannot select executables; custom shims require pathPrefix.
 * io.spawn/io.resolveBinary are trusted test seams, never descriptor capabilities.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { types } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LANE_GIT_CONFIG_PINS, REMOTE_PROBE_CONFIG_PINS, LANE_HISTORY_CONFIG_PINS } from './lane-git-hardening.mjs';

const FIXED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const ENV_REGISTRY = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'agent-launch-env-registry.json'), 'utf8'));
const ENV_PREFIXES = Object.entries(ENV_REGISTRY).filter(([pattern]) => pattern.endsWith('*'));
const ENV_SUFFIXES = Object.entries(ENV_REGISTRY).filter(([pattern]) => pattern.startsWith('*'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMON = ['agent', 'cwd', 'processGroup', 'pathPrefix', 'tempRoot', 'inheritEnv'];
const CODEX = ['sandbox', 'outputSchemaFile', 'outputLastMessageFile', 'ephemeral', 'addDirs', 'model', 'config', 'resumeThreadId'];
const CLAUDE = ['print', 'sessionId', 'resumeId', 'model', 'outputFormat', 'verbose', 'prompt'];
const fail = reason => { throw new TypeError(`agent-launch: ${reason}`); };

// Inspect descriptors, never values through property access, until all data is ours.
function snapshot(input) {
  const active = new WeakSet(), copies = new WeakMap();
  let nodes = 0;
  function copy(value, depth = 0) {
    if (++nodes > 10000 || depth > 64) fail('snapshot limit exceeded; simplify the descriptor and retry');
    if (typeof value === 'function' || typeof value === 'symbol') fail('function/symbol value');
    if (value === null || typeof value !== 'object') return value;
    if (types.isProxy(value)) fail('Proxy value');
    if (active.has(value)) fail('cyclic value');
    if (copies.has(value)) return copies.get(value);
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('non-plain prototype');
    const props = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(props);
    if (keys.some(key => typeof key === 'symbol')) fail('symbol key');
    for (const key of keys) if (!Object.hasOwn(props[key], 'value')) fail(`accessor property ${key}`);
    if (array && (keys.length - 1 !== props.length.value
      || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail('sparse or decorated array');
    const out = array ? [] : Object.create(null);
    active.add(value); copies.set(value, out);
    for (const key of keys) if (!array || key !== 'length') out[key] = copy(props[key].value, depth + 1);
    active.delete(value);
    return out;
  }
  return copy(input);
}
function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be a record`);
}
function text(value, name) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || value.includes('\0')) fail(`${name} must be a non-option, NUL-free string`);
  return value;
}
function absolute(value, name) {
  if (!isAbsolute(text(value, name))) fail(`${name} must be absolute`);
  return value;
}
function choice(value, choices, name) {
  if (!choices.includes(value)) fail(`${name} must be ${choices.join('|')}`);
  return value;
}
function flag(value, name) {
  if (value !== undefined && typeof value !== 'boolean') fail(`${name} must be boolean`);
  return value === true;
}
function id(value, name) {
  if (!UUID.test(text(value, name)) || value.length !== 36) fail(`${name} must be a UUID`);
  return value;
}
function paths(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value.map(p => absolute(p, name));
}
// Exact > trailing-* prefix > leading-* suffix. Unknown caller names fail closed.
function envRule(key) {
  if (Object.hasOwn(ENV_REGISTRY, key)) return ENV_REGISTRY[key];
  return ENV_PREFIXES.find(([pattern]) => key.startsWith(pattern.slice(0, -1)))?.[1]
    ?? ENV_SUFFIXES.find(([pattern]) => key.endsWith(pattern.slice(1)))?.[1];
}
function envRecord(env) {
  record(env, 'inheritEnv');
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.includes('\0')) fail(`inheritEnv.${key} must be a NUL-free string`);
  }
}
// Parse bounded quantities; zero is restrictive only when the reader says so.
function quantity(value, { unit, minimum = 0, zeroIsStrict = false }) {
  const match = /^(\d+(?:\.\d+)?|\.\d+)([kmgt]?)$/i.exec(String(value).trim());
  if (!match || (unit !== 'bytes' && match[2])) return NaN;
  const parsed = Number(match[1]) * (1024 ** (match[2] ? 'kmgt'.indexOf(match[2].toLowerCase()) + 1 : 0));
  const n = unit === 'count' ? Math.floor(parsed) : parsed;
  return Number.isFinite(n) && (n > 0 || (zeroIsStrict && n === 0)) && n >= minimum ? n : NaN;
}
function classOf(rule, value, ceiling) {
  if ((rule?.class === 'forward-restrictive' || rule?.restrictiveValues || rule?.restrictivePrefixes || rule?.tighterThan)
    && value === '') return 'drop';
  if (rule?.tighterThan) {
    return quantity(value, rule.tighterThan) < ceiling ? 'forward-restrictive' : 'drop';
  }
  if (rule?.restrictiveValues || rule?.restrictivePrefixes) {
    return rule.restrictiveValues?.includes(String(value).trim().toLowerCase())
      || rule.restrictivePrefixes?.some(prefix => String(value).startsWith(prefix)) ? 'forward-restrictive' : 'drop';
  }
  return rule?.class;
}
// The sole indexed-config exception to GIT_*: validate the entire parent set first.
function ambientGitConfig(ambient) {
  const raw = ambient.GIT_CONFIG_COUNT;
  if (!/^\d+$/.test(raw)) return {};
  const count = Number(raw);
  // A complete set needs two distinct entries per pin. Reject impossible counts
  // before iterating; incomplete/oversized sets are dropped, so Git uses its defaults.
  if (!Number.isSafeInteger(count) || count * 2 + 1 > Object.keys(ambient).length) return {};
  const pins = [...LANE_GIT_CONFIG_PINS, ...REMOTE_PROBE_CONFIG_PINS, ...LANE_HISTORY_CONFIG_PINS];
  const out = { GIT_CONFIG_COUNT: raw };
  for (let i = 0; i < count; i++) {
    const key = `GIT_CONFIG_KEY_${i}`, value = `GIT_CONFIG_VALUE_${i}`;
    if (!Object.hasOwn(ambient, key) || !Object.hasOwn(ambient, value)
      || !pins.some(([k, v]) => ambient[key] === k && ambient[value] === v)) return {};
    out[key] = ambient[key]; out[value] = ambient[value];
  }
  return out;
}
function inheritedEnv(inherit, ambient) {
  const out = Object.create(null);
  Object.assign(out, ambientGitConfig(ambient));
  const checked = (rule, value, key) => rule.value === 'absolute-path' ? absolute(value, key)
    : rule.tighterThan ? String(quantity(value, rule.tighterThan))
    : rule.restrictiveValues?.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : value;
  for (const [key, value] of Object.entries(ambient)) {
    const rule = envRule(key);
    if (!rule) { out[key] = value; continue; }
    if (rule.never) continue;
    if (rule.restrictiveValues || rule.restrictivePrefixes) {
      if (classOf(rule, value) === 'forward-restrictive') out[key] = checked(rule, value, key);
    } else {
      // Preserve the parent's reader grammar, including empty and unusual numeric values.
      out[key] = rule.value === 'absolute-path' ? absolute(value, key) : value;
    }
  }
  for (const [key, value] of Object.entries(inherit)) {
    const rule = envRule(key);
    if (!rule || rule.never) continue;
    // Parent verification selectors are evidence, not caller capabilities.
    if (rule?.ambientOnly) continue;
    const hasParent = Object.hasOwn(ambient, key);
    const ceiling = rule.tighterThan && hasParent ? quantity(ambient[key], rule.tighterThan) : NaN;
    // Env beats configured policy: a code default cannot authorize a positive bag-only
    // limit. Ignore it so the child resolves policy; set the parent env to supply a ceiling.
    // A documented strict zero is the global minimum, independent of configured policy.
    const strictZero = !hasParent && rule.tighterThan?.zeroIsStrict
      && quantity(value, rule.tighterThan) === 0;
    const cls = strictZero ? 'forward-restrictive' : classOf(rule, value, ceiling);
    if (cls !== 'forward' && cls !== 'forward-restrictive') continue;
    const candidate = checked(rule, value, key);
    if (!rule.tighterThan && cls === 'forward-restrictive' && out[key] !== undefined && out[key] !== ''
      && (rule.precedence ?? 'ambient') === 'ambient') continue;
    out[key] = candidate;
  }
  return out;
}
function configValue(key, value) {
  switch (key) {
    case 'model_reasoning_effort': return choice(value, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], key);
    case 'sandbox_workspace_write.network_access':
      if (typeof value !== 'boolean') fail(`${key} must be boolean`);
      return String(value);
    case 'sandbox_workspace_write.writable_roots': return JSON.stringify(paths(value, key));
    case 'shell_environment_policy.set.PATH':
      text(value, key).split(':').forEach(p => absolute(p, key));
      return JSON.stringify(value);
    case 'shell_environment_policy.set.TMPDIR':
    case 'shell_environment_policy.set.TMP':
    case 'shell_environment_policy.set.TEMP': return JSON.stringify(absolute(value, key));
    default: fail(`unknown config key ${key}`);
  }
}
function argsFrom(d) {
  record(d, 'descriptor');
  choice(d.agent, ['claude', 'codex'], 'agent');
  for (const key of Object.keys(d)) if (![...COMMON, ...(d.agent === 'codex' ? CODEX : CLAUDE)].includes(key)) fail(`unknown field ${key}`);
  absolute(d.cwd, 'cwd'); flag(d.processGroup, 'processGroup');
  for (const key of ['pathPrefix', 'tempRoot']) if (d[key] !== undefined) absolute(d[key], key);
  if (d.inheritEnv !== undefined) envRecord(d.inheritEnv);
  if (d.model !== undefined && (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(text(d.model, 'model')) || /\s/.test(d.model))) fail('model must be a model name');
  const args = [];
  const option = (key, token, check = text) => { if (d[key] !== undefined) args.push(token, check(d[key], key)); };
  if (d.agent === 'claude') {
    if (d.sessionId !== undefined && d.resumeId !== undefined) fail('sessionId and resumeId are mutually exclusive');
    if (flag(d.print, 'print')) args.push('-p');
    option('sessionId', '--session-id', id); option('resumeId', '--resume', id); option('model', '--model');
    option('outputFormat', '--output-format', (v, k) => choice(v, ['text', 'json', 'stream-json'], k));
    if (flag(d.verbose, 'verbose')) args.push('--verbose');
    if (d.prompt !== undefined) args.push('--', text(d.prompt, 'prompt'));
    return args;
  }
  args.push('exec', '--json', '-s', choice(d.sandbox, ['read-only', 'workspace-write'], 'sandbox'), '--skip-git-repo-check', '-C', d.cwd);
  option('outputSchemaFile', '--output-schema', absolute); option('outputLastMessageFile', '-o', absolute);
  if (flag(d.ephemeral, 'ephemeral')) args.push('--ephemeral');
  if (d.addDirs !== undefined) for (const dir of paths(d.addDirs, 'addDirs')) args.push('--add-dir', dir);
  option('model', '-m');
  if (d.config !== undefined) {
    record(d.config, 'config');
    for (const [key, value] of Object.entries(d.config)) args.push('-c', `${key}=${configValue(key, value)}`);
  }
  if (d.resumeThreadId !== undefined) {
    const thread = id(d.resumeThreadId, 'resumeThreadId');
    if (d.ephemeral) fail('resumeThreadId conflicts with ephemeral');
    if (d.outputSchemaFile !== undefined) fail('resumeThreadId conflicts with outputSchemaFile');
    args.push('resume', thread, '-');
  }
  return args;
}

// Fixed lookup only: neither process.env.PATH nor descriptor.pathPrefix selects the agent.
function resolveBinary(agent) {
  const home = userInfo().homedir;
  const dirs = [...FIXED_PATH.split(':'), '/usr/local/bin', '/opt/homebrew/bin', join(home, '.local/bin'), join(home, '.npm-global/bin'), join(home, '.volta/bin')];
  return findAgentBinary(agent, dirs);
}

/** Lookup over explicit directories for hermetic fixtures; production supplies only its fixed list. */
export function findAgentBinary(agent, dirs) {
  for (const dir of dirs) {
    try {
      const file = realpathSync(join(dir, agent));
      if (!isAbsolute(file) || !statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch { /* Try the next fixed installation directory. */ }
  }
  fail(`${agent} binary not found; install it in a well-known installation directory`);
}

/** Pure PATH projection; production supplies the real account home and snapshotted parent paths.
 * Keep this exact structure aligned with gh-app-shim's defaultShimDir/checkoutShimDir.
 */
export function buildAgentPath({ parentPaths, home, pathPrefix, nodePath, binary = nodePath }) {
  const legacy = join(home, '.claude/github-app-token/gh-shim');
  const checkouts = join(home, '.claude/github-app-token/gh-shim.d') + '/';
  const restrictive = parentPaths.flatMap(path => String(path ?? '').split(':')).filter(dir =>
    isAbsolute(dir) && !dir.split('/').includes('..')
    && (dir === legacy || (dir.startsWith(checkouts) && /^[0-9a-f]{16}(?![\s\S])/.test(dir.slice(checkouts.length)))));
  return [...new Set([...restrictive, pathPrefix, dirname(nodePath), ...FIXED_PATH.split(':'),
    '/opt/homebrew/bin', '/usr/local/bin', dirname(binary)].filter(Boolean))].join(':');
}

/** Pure argv projection, retained for direct-task's existing argv consumers. */
export function buildAgentArgs(descriptor) { return argsFrom(snapshot(descriptor)); }

/** Snapshot is the first operation, including before any test seam executes. */
export function buildAgentInvocation(descriptor, io) {
  const d = snapshot(descriptor);
  argsFrom(d); // Validate the entire snapshot before any IO seam executes.
  // Copy trusted process.env before any IO seam can mutate it; it is not a plain record itself.
  const ambient = snapshot({ ...process.env });
  const forwarded = inheritedEnv(d.inheritEnv ?? {}, ambient);
  try { if (!statSync(d.cwd).isDirectory()) fail('cwd must be an existing directory'); }
  catch { fail('cwd must be an existing directory'); }
  const file = absolute((io?.resolveBinary ?? resolveBinary)(d.agent), 'resolved binary');
  const home = userInfo().homedir;
  const env = { ...forwarded, PATH: buildAgentPath({ parentPaths: [d.inheritEnv?.PATH, ambient.PATH],
    home, pathPrefix: d.pathPrefix, nodePath: process.execPath, binary: file }), HOME: home };
  if (d.tempRoot !== undefined) for (const key of ['TMPDIR', 'TMP', 'TEMP']) env[key] = d.tempRoot;
  // The launcher owns both child PATHs; finalize after fixed binary resolution so the agent dir agrees.
  if (d.config && Object.hasOwn(d.config, 'shell_environment_policy.set.PATH')) {
    d.config['shell_environment_policy.set.PATH'] = env.PATH;
  }
  const args = argsFrom(d);
  return { file, args, options: { shell: false, cwd: d.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: d.processGroup === true } };
}

// Admission hook point (SEC1 S3/S4 moves runtime admission here, #7090). It sees a frozen
// copy of the final spec and can only refuse (return false or throw); it cannot rewrite it.
const allowAll = () => true;
const frozen = value => Object.freeze(Array.isArray(value) ? value.map(frozen)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, frozen(v)])) : value);

export function launchAgent(descriptor, io) {
  const { file, args, options } = buildAgentInvocation(descriptor, io);
  let admitted;
  try { admitted = (io?.admit ?? allowAll)(frozen({ file, args, options })); }
  catch (e) { fail(`launch not admitted: ${e?.message ?? e}`); }
  if (admitted !== true) fail('launch not admitted');
  return (io?.spawn ?? spawn)(file, args, options);
}
