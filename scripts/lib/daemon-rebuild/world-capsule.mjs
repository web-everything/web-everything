// R649 S1, inert recorder, replay throws on miss.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const recorders = new WeakMap();
const filename = 'world-capsule.json';
const secretPattern = /Authorization|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|Bearer\s|GH_TOKEN|GITHUB_TOKEN/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('world-capsule invalid or incomplete evidence'); };
const miss = () => { throw new Error('world-capsule miss'); };

function safeText(value) {
  if (typeof value !== 'string' || secretPattern.test(value)) fail();
  return value;
}

function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail();
}

function argumentsKey(command, args) {
  if (command !== 'gh' || !Array.isArray(args) || !args.length) fail();
  for (const arg of args) {
    safeText(arg);
    if (!arg || /[\x00-\x1f\x7f]/.test(arg)) fail();
  }
  return `gh ${args.join('\u0000')}`;
}

// Parse a deliberately small read-only grammar; unknown options need explicit review.
const LISTABLE_NOUNS = new Set('pr issue run'.split(' '));

function readOnlyKey(command, args) {
  const key = argumentsKey(command, args);
  const api = args[0] === 'api';
  if (!api && !(LISTABLE_NOUNS.has(args[0])
    && ['list', 'view'].includes(args[1]))) fail();
  const values = api
    ? new Set(['--method', '-X', '--jq', '-q', '--template', '-t', '--hostname'])
    : new Set(['--repo', '-R', '--json', '--jq', '-q', '--template', '-t', '--limit', '-L',
      '--state', '--author', '--assignee', '--label', '--search', '--base', '--head',
      '--branch', '--workflow', '--user', '--status', '--event', '--commit', '--job']);
  const switches = api
    ? new Set(['--paginate', '--slurp', '--include', '-i', '--silent'])
    : new Set(['--comments', '--log', '--log-failed', '--verbose']);
  let endpoints = 0;
  for (let i = api ? 1 : 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      endpoints++;
      if (api && (arg.includes('://') || arg.startsWith('/'))) fail();
      continue;
    }
    if (switches.has(arg)) continue;
    const equal = arg.indexOf('=');
    const option = equal < 0 ? arg : arg.slice(0, equal);
    if (!values.has(option)) fail();
    const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!value || value.startsWith('-')) fail();
    if ((option === '--method' || option === '-X') && !['GET', 'HEAD'].includes(value)) fail();
  }
  if (api && endpoints !== 1) fail();
  return key;
}

// A cwd-dependent lookup cannot be identified by the argument-only capsule key.
// Require a repository in argv when the caller supplies a working directory;
// execution context is inspected only for admission and is never retained.
function requireRepositoryContext(args, executionOptions) {
  // GH_REPO / GH_HOST retarget gh without appearing in argv, so the argv-only key cannot tell targets apart.
  // Refuse both at record and replay time (the env itself is only inspected, never retained).
  if (process.env.GH_REPO || process.env.GH_HOST) fail();
  if (executionOptions.some(option => option?.env?.GH_REPO || option?.env?.GH_HOST)) fail();
  // An omitted cwd still means the process cwd, so the repository must always be explicit in argv.
  if (args[0] === 'api') {
    // gh expands these placeholders using the working directory's repository.
    if (args.some(arg => /\{(?:owner|repo|branch)\}/.test(arg))) fail();
    return;
  }
  let repository;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo' || arg === '-R') repository = args[++i];
    else if (arg.startsWith('--repo=')) repository = arg.slice('--repo='.length);
    else if (arg.startsWith('-R=')) repository = arg.slice(3);
  }
  if (typeof repository !== 'string'
    || !/^(?:[a-zA-Z0-9.-]+\/)?[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) fail();
}

function statePath(root, path) {
  safeText(root);
  safeText(path);
  if (!root || !path || root.includes('\0') || path.includes('\0') || isAbsolute(path)
    || path.split(/[\\/]/).includes('..')) fail();
  const base = resolve(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail();
  return target;
}

function containedFile(root, path) {
  const target = statePath(root, path);
  const base = realpathSync(root);
  const actual = realpathSync(target);
  const rel = relative(base, actual);
  if (!statSync(base).isDirectory() || !rel || rel === '..'
    || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(actual).isFile()) fail();
  return actual;
}

function manifest(gh, state) {
  return hash(JSON.stringify({ version: 1, gh, state }));
}

// Rebuild the schema explicitly so hashes never depend on JSON property order.
function validate(capsule) {
  keys(capsule, ['version', 'gh', 'state', 'manifestSha256']);
  if (capsule.version !== 1 || !Array.isArray(capsule.gh) || !Array.isArray(capsule.state)
    || capsule.gh.length + capsule.state.length === 0) fail();
  const seenGh = new Set();
  const gh = capsule.gh.map(entry => {
    keys(entry, ['key', 'sha256', 'body']);
    if (typeof entry.key !== 'string' || !entry.key.startsWith('gh ')) fail();
    readOnlyKey('gh', entry.key.slice(3).split('\u0000'));
    if (seenGh.has(entry.key)) fail();
    seenGh.add(entry.key);
    safeText(entry.body);
    if (entry.sha256 !== hash(entry.body)) fail();
    return { key: entry.key, sha256: entry.sha256, body: entry.body };
  });
  const seenState = new Set();
  const state = capsule.state.map(entry => {
    keys(entry, ['root', 'path', 'sha256', 'contentBase64']);
    statePath(entry.root, entry.path);
    const key = JSON.stringify([entry.root, entry.path]);
    if (seenState.has(key) || typeof entry.contentBase64 !== 'string') fail();
    seenState.add(key);
    const content = Buffer.from(entry.contentBase64, 'base64');
    if (content.toString('base64') !== entry.contentBase64 || entry.sha256 !== hash(content)) fail();
    safeText(content.toString('utf8'));
    return { root: entry.root, path: entry.path, sha256: entry.sha256, contentBase64: entry.contentBase64 };
  });
  if (capsule.manifestSha256 !== manifest(gh, state)) fail();
  return { version: 1, gh, state, manifestSha256: capsule.manifestSha256 };
}

const poisoned = new WeakSet();
const pending = new Map(); // recorder -> in-flight gh reads; finalize refuses while any are pending
const sealed = new WeakSet();

export function createCapsuleRecorder() {
  const recorder = Object.freeze({});
  recorders.set(recorder, new Map());
  return recorder;
}

export function recordingRunChild(inner, recorder) {
  const entries = recorders.get(recorder);
  if (typeof inner !== 'function' || !entries) fail();
  return async (command, args, ...executionOptions) => {
    if (command !== 'gh') return inner(command, args, ...executionOptions);
    const key = readOnlyKey(command, args);
    requireRepositoryContext(args, executionOptions);
    // Any failure after validation (inner error, unsafe body, conflicting response) poisons the recorder:
    // rejected evidence must never end up in a finalized capsule.
    if (sealed.has(recorder)) fail();
    pending.set(recorder, (pending.get(recorder) ?? 0) + 1);
    try {
      const result = await inner(command, args, ...executionOptions);
      const body = safeText(typeof result === 'string' ? result : result?.stdout);
      const entry = { key, sha256: hash(body), body };
      if (entries.has(key) && entries.get(key).sha256 !== entry.sha256) fail();
      entries.set(key, entry);
      return result;
    } catch (error) {
      poisoned.add(recorder);
      throw error;
    } finally {
      pending.set(recorder, pending.get(recorder) - 1);
    }
  };
}

export function finalizeCapsule(recorder, { stateRoots } = {}) {
  const entries = recorders.get(recorder);
  if (!entries || poisoned.has(recorder) || pending.get(recorder) || !Array.isArray(stateRoots)) fail();
  sealed.add(recorder);
  const gh = [...entries.values()].map(entry => ({ ...entry }));
  const state = [];
  for (const descriptor of stateRoots) {
    keys(descriptor, ['root', 'files']);
    if (!Array.isArray(descriptor.files) || !descriptor.files.length) fail();
    for (const path of descriptor.files) {
      const content = readFileSync(containedFile(descriptor.root, path));
      state.push({ root: descriptor.root, path, sha256: hash(content), contentBase64: content.toString('base64') });
    }
  }
  gh.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  state.sort((a, b) => {
    const left = JSON.stringify([a.root, a.path]);
    const right = JSON.stringify([b.root, b.path]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return validate({ version: 1, gh, state, manifestSha256: manifest(gh, state) });
}

export function writeCapsule(directory, capsule) {
  const checked = validate(capsule);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, filename), `${JSON.stringify(checked)}\n`, { flag: 'wx', mode: 0o600 });
}

export function readCapsule(directory) {
  return validate(JSON.parse(readFileSync(join(directory, filename), 'utf8')));
}

export function replayRunChild(capsule) {
  const checked = validate(capsule);
  const entries = new Map(checked.gh.map(entry => [entry.key, entry.body]));
  return async (command, args, ...executionOptions) => {
    let key;
    try {
      key = readOnlyKey(command, args);
      requireRepositoryContext(args, executionOptions);
    } catch { miss(); }
    if (!entries.has(key)) miss();
    return entries.get(key);
  };
}

export function readCapsuleState(capsule, root, path) {
  const checked = validate(capsule);
  const entry = checked.state.find(item => item.root === root && item.path === path);
  if (!entry) miss();
  return Buffer.from(entry.contentBase64, 'base64');
}
