/**
 * Closed-grammar process boundary: snapshot plain data, then build argv and directly exec.
 * Caller env passes through except runtime injection variables (undefined omitted,
 * invalid values refused, env Git config that widens transport policy refused), with
 * optional PATH prefix and task TMP roots.
 * Other environment narrowing is deferred to S1e.
 * Codex must resolve to the same executable on caller PATH as the fixed installation lookup.
 * io.spawn/io.resolveBinary are trusted test seams, never descriptor capabilities.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { types } from 'node:util';

const FIXED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMON = ['agent', 'cwd', 'processGroup', 'pathPrefix', 'tempRoot', 'env'];
const CODEX = ['sandbox', 'outputSchemaFile', 'outputLastMessageFile', 'ephemeral', 'addDirs', 'model', 'config', 'resumeThreadId'];
const CLAUDE = ['print', 'sessionId', 'resumeId', 'model', 'outputFormat', 'verbose', 'prompt'];
const RUNTIME_INJECTION_ENV = new Set(['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP',
  'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB']);
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
// Runtime-controlled loading must not execute code before the agent sandbox starts.
function envRecord(value) {
  record(value, 'env');
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && (typeof entry !== 'string' || entry.includes('\0'))) fail(`env.${key} must be a NUL-free string or undefined`);
  }
  transportPolicy(value);
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => entry !== undefined
    && !RUNTIME_INJECTION_ENV.has(key) && !key.endsWith('_OPTIONS') && !/^(?:LD_|DYLD_)/.test(key)));
}
// Tighten-only: env-supplied Git config may restrict Git's built-in transport defaults
// (ext never, file and unknown user, these always) but never widen them. Config files stay S1e.
const SAFE_TRANSPORTS = new Set(['http', 'https', 'git', 'ssh']);
function widensTransport(key, value) {
  const first = key.indexOf('.'), last = key.lastIndexOf('.');
  const section = (first < 0 ? key : key.slice(0, first)).toLowerCase();
  if (section === 'include' || section === 'includeif') return true; // indirection to an unread file
  if (section !== 'protocol' || key.slice(last + 1).toLowerCase() !== 'allow') return false;
  const policy = typeof value === 'string' ? value.toLowerCase() : undefined;
  if (policy === 'never') return false;
  const name = first === last ? undefined : key.slice(first + 1, last); // subsections are case-sensitive
  if (policy === 'always') return !SAFE_TRANSPORTS.has(name);
  if (policy === 'user') return name === undefined || name === 'ext';
  return true; // unparseable policy: fail closed
}
// Git's GIT_CONFIG_PARAMETERS grammar: space-separated sq-quoted `'key'='value'` or `'key=value'`
// entries, a literal quote spelled `'\''`. Anything else returns null (refused).
function configParameters(text) {
  const pairs = []; let i = 0;
  const quoted = () => {
    if (text[i] !== "'") return undefined;
    let out = '';
    for (;;) {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      out += text.slice(i + 1, end); i = end + 1;
      if (text[i] !== '\\' || !"'!".includes(text[i + 1] ?? '') || text[i + 2] !== "'") return out;
      out += text[i + 1]; i += 2;
    }
  };
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    const key = quoted();
    if (key === undefined) return null;
    if (text[i] === '=') {
      i++;
      const value = /\s/.test(text[i] ?? ' ') ? undefined : quoted();
      if (value === undefined && i < text.length && !/\s/.test(text[i])) return null;
      pairs.push([key, value]);
    } else {
      const eq = key.indexOf('=');
      pairs.push(eq < 0 ? [key, undefined] : [key.slice(0, eq), key.slice(eq + 1)]);
    }
    if (i < text.length && !/\s/.test(text[i])) return null;
  }
  return pairs;
}
function transportPolicy(env) {
  const widened = reason => fail(`env ${reason} widens Git transport policy; restrict it (never) or remove it and retry`);
  for (const [key, entry] of Object.entries(env)) {
    const index = /^GIT_CONFIG_KEY_(.*)$/.exec(key)?.[1];
    if (index !== undefined && entry !== undefined && widensTransport(entry, env[`GIT_CONFIG_VALUE_${index}`])) widened(key);
  }
  if (env.GIT_CONFIG_PARAMETERS !== undefined) {
    const pairs = configParameters(env.GIT_CONFIG_PARAMETERS);
    if (pairs === null || pairs.some(([key, value]) => widensTransport(key, value))) widened('GIT_CONFIG_PARAMETERS');
  }
  if (env.GIT_ALLOW_PROTOCOL !== undefined && env.GIT_ALLOW_PROTOCOL.split(':').some(p => p && !SAFE_TRANSPORTS.has(p))) widened('GIT_ALLOW_PROTOCOL');
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
  if (d.env !== undefined) envRecord(d.env);
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

// Fixed installation lookup, independently checked against the final child PATH.
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

/** Pure argv projection, retained for direct-task's existing argv consumers. */
export function buildAgentArgs(descriptor) { return argsFrom(snapshot(descriptor)); }

// Node would search these directories in order. Relative/empty entries before the
// first match cannot establish an installation identity, so refuse instead of guessing.
function firstCodex(path) {
  if (path === undefined) fail('codex not found on child PATH; set an absolute installation PATH and retry');
  for (const dir of path.split(':')) {
    if (!isAbsolute(dir)) fail('relative child PATH entry before codex; use absolute directories and retry');
    try {
      const file = realpathSync(join(dir, 'codex'));
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch { /* Try the next absolute directory. */ }
  }
  fail('codex not found on child PATH; set an absolute installation PATH and retry');
}

/** Snapshot is the first operation, including before any test seam executes. */
export function buildAgentInvocation(descriptor, io) {
  const d = snapshot(descriptor);
  const args = argsFrom(d); // Validate the entire snapshot before any IO seam executes.
  const env = envRecord(d.env ?? {});
  if (d.pathPrefix !== undefined) {
    const rest = String(env.PATH ?? '').split(':').filter(dir => dir && dir !== d.pathPrefix);
    rest.forEach(dir => absolute(dir, 'PATH'));
    env.PATH = [d.pathPrefix, ...rest].join(':');
  }
  if (d.tempRoot !== undefined && d.sandbox !== 'read-only') {
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) env[key] = d.tempRoot;
  }
  try { if (!statSync(d.cwd).isDirectory()) fail('cwd must be an existing directory'); }
  catch { fail('cwd must be an existing directory'); }
  const file = absolute((io?.resolveBinary ?? resolveBinary)(d.agent), 'resolved binary');
  if (d.agent === 'codex' && firstCodex(env.PATH) !== realpathSync(file)) {
    fail('codex binary identity differs from child PATH; align PATH with the fixed installation and retry');
  }
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
