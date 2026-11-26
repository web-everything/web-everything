/** Shared smoke identity. No claims, proofs or adoption writes belong in this module. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SMOKE_CHECKS, SMOKE_BUDGET_ENV } from '../daemon-live-smoke.mjs';
import { candidateSmokeEnv, candidateWorktreePath } from './candidate.mjs';
import { defaultPoolRoot } from '../lane-pool-paths.mjs';
import { scrubGitRepoEnv } from '../lane-git-hardening.mjs';
import { operatorPreferencesPath } from '../policy-cascade.mjs';

export const RUNNING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SUITE_ENTRIES = Object.freeze([
  'scripts/lib/daemon-live-smoke.mjs', 'scripts/lib/daemon-rebuild/smoke.mjs',
  'scripts/lib/daemon-rebuild/shared-smoke-key.mjs', 'scripts/lib/daemon-rebuild/candidate.mjs',
  'scripts/lib/daemon-rebuild/rebuild.mjs',
]);
export const PER_LAUNCH_ENV = Object.freeze([
  'WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS', 'WE_DAEMON_REBUILD_READER', 'WE_REBUILD_JOB_DEADLINE_AT',
]);
export const EXPLICIT_HASHED_ENV = Object.freeze(['PATH', 'HOME', 'VITEST', 'FAKE_GH_FIXTURE']);
export const COMPUTED_LOADS = Object.freeze([Object.freeze({
  file: 'scripts/operations/dispatch-lane-io.mjs',
  exactText: "require(join(root, 'src', '_data', 'backlog.js'))", target: 'src/_data/backlog.js',
})]);
export const K6_AUDITED_READS = Object.freeze([
  Object.freeze({ file: 'scripts/lib/daemon-rebuild/rebuild.mjs',
    exactLineText: '      ...trustedIgnoreOwners(env?.WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS, spawnerOwners, log),',
    name: 'WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS', reason: 'readyOnly lock options; never called by code-row dry-run children' }),
  Object.freeze({ file: 'scripts/lib/daemon-rebuild/rebuild.mjs',
    exactLineText: '      ...targetDaemonReader(env?.WE_DAEMON_REBUILD_READER, root, readerStartTimeOf),',
    name: 'WE_DAEMON_REBUILD_READER', reason: 'readyOnly lock options; never called by code-row dry-run children' }),
]);
/** Only exact runtime filenames, never glob or basename exceptions for missing code/config. */
export const SUITE_JSON_RUNTIME_NAMES = Object.freeze([
  '.json', 'state.json', 'owner.json', 'platform-preferences.json',
]);

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 10000;
const SHA = /^[a-f0-9]{40}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const within = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
function refuse(reason, log = console) {
  log.error?.(`smoke-shared-key: ${String(reason).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 400)}; sharing off, use per-clone smoke`);
  return null;
}
function gitAt(root, args, env) {
  return spawnSync('git', ['-C', root, ...args], {
    env: scrubGitRepoEnv(env), encoding: 'utf8', timeout: 5000, maxBuffer: 4 * MAX_BYTES, killSignal: 'SIGKILL',
  });
}
function output(result, reason) {
  if (result?.status !== 0 || result.error || typeof result.stdout !== 'string') throw new Error(reason);
  return result.stdout;
}
function oneLine(result, reason) {
  const text = output(result, reason).trim();
  if (!text || /[\r\n\0]/.test(text)) throw new Error(reason);
  return text;
}

/** Failed lock reads cannot masquerade as an absent lockfile. Git runners must be bounded. */
export function smokeIdentityComponents(git, sha, { nodeVersion = process.version, log = console } = {}) {
  try {
    if (typeof sha !== 'string' || !sha || typeof nodeVersion !== 'string' || !nodeVersion) throw new Error('identity-input-invalid');
    const tree = oneLine(git(['rev-parse', '--verify', '--end-of-options', `${sha}^{tree}`]), 'tree-unreadable');
    if (!SHA.test(tree)) throw new Error('tree-invalid');
    const lock = git(['show', `${sha}:package-lock.json`]);
    let lockHash;
    if (lock?.status === 0 && !lock.error && typeof lock.stdout === 'string') lockHash = hash(lock.stdout);
    else {
      if (lock?.error || lock?.status == null) throw new Error('lock-read-failed');
      const listed = output(git(['ls-tree', '--name-only', tree, '--', 'package-lock.json']), 'lock-list-failed');
      if (listed.trim()) throw new Error('lock-read-failed');
      lockHash = '';
    }
    return { tree, lockHash, nodeVersion };
  } catch (e) { return refuse(e.message, log); }
}

/** Shared strict walker for the running suite and the candidate's code-row env reads. */
function walk({ root, entries, env, readFile = readFileSync }) {
  root = realpathSync(root);
  const bytes = new Map(); const sources = new Map(); const reads = []; const auditedReads = [];
  const pending = entries.map(p => resolve(root, p));
  const jsonLiterals = [];
  let packageUsed = false;
  function read(path) {
    if (!within(root, path) || !within(root, realpathSync(path))) throw new Error(`out-of-root:${relative(root, path)}`);
    if (!bytes.has(path)) {
      if (bytes.size >= MAX_FILES) throw new Error('file-limit');
      if (statSync(path).size > MAX_BYTES) throw new Error('input-too-large');
      const data = readFile(path);
      if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('input-too-large');
      if (path.endsWith('.json')) JSON.parse(String(data));
      bytes.set(path, data);
    }
    return bytes.get(path);
  }
  function resolveLoad(file, spec) {
    if (spec.startsWith('node:')) return;
    if (!spec.startsWith('.')) {
      if (isAbsolute(spec) || !/^[@a-z\d_-][^\s]*$/i.test(spec)) throw new Error('load-specifier-invalid');
      packageUsed = true; return;
    }
    const base = resolve(dirname(file), spec);
    if (!within(root, base)) throw new Error('load-out-of-root');
    for (const path of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.json`, `${base}/index.mjs`, `${base}/index.js`, `${base}/index.cjs`]) {
      try { if (!statSync(path).isFile()) continue; }
      catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
      read(path); pending.push(path); return;
    }
    throw new Error(`unresolved-load:${relative(root, file)}:${spec}`);
  }
  while (pending.length) {
    const path = pending.pop(); if (sources.has(path)) continue;
    const data = read(path); sources.set(path, true);
    if (path.endsWith('.json')) { JSON.parse(String(data)); continue; }
    const file = relative(root, path); const text = String(data);
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw new Error(`malformed-source:${file}`);
    const createNames = new Set(['createRequire']); const requireNames = new Set(['require']);
    function bindings(n) {
      if (ts.isImportSpecifier(n) && (n.propertyName?.text ?? n.name.text) === 'createRequire') createNames.add(n.name.text);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)
        && createNames.has(n.initializer.expression.getText(ast))) requireNames.add(n.name.text);
      ts.forEachChild(n, bindings);
    }
    bindings(ast);
    function envRead(n, name) {
      const line = text.split('\n')[ast.getLineAndCharacterOfPosition(n.getStart(ast)).line];
      const pin = K6_AUDITED_READS.find(p => p.file === file && p.name === name && p.exactLineText === line);
      reads.push({ file, name, line });
      if (pin) auditedReads.push(pin);
    }
    const envObject = n => n && (n.getText(ast) === 'process.env' || n.getText(ast) === 'env' || n.getText(ast).endsWith('.env'));
    function visit(n) {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) resolveLoad(path, n.moduleSpecifier.text);
      if (ts.isCallExpression(n)) {
        const expr = n.expression;
        const load = expr.kind === ts.SyntaxKind.ImportKeyword || requireNames.has(expr.getText(ast))
          || (ts.isCallExpression(expr) && createNames.has(expr.expression.getText(ast)));
        if (load) {
          const arg = n.arguments[0];
          if (arg && ts.isStringLiteralLike(arg)) resolveLoad(path, arg.text);
          else {
            const pin = COMPUTED_LOADS.find(p => p.file === file && p.exactText === n.getText(ast));
            if (!pin) throw new Error(`nonliteral-load:${file}:${n.getStart(ast)}`);
            read(resolve(root, pin.target)); pending.push(resolve(root, pin.target));
          }
        }
      }
      if (ts.isStringLiteralLike(n) && /^[^\s]+\.json$/.test(n.text)) jsonLiterals.push([path, n.text]);
      if (ts.isPropertyAccessExpression(n) && envObject(n.expression)) envRead(n, n.name.text);
      if (ts.isElementAccessExpression(n) && envObject(n.expression) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) envRead(n, n.argumentExpression.text);
      if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && envObject(n.initializer)) {
        for (const binding of n.name.elements) if (!binding.dotDotDotToken) envRead(binding, (binding.propertyName ?? binding.name).text);
      }
      ts.forEachChild(n, visit);
    }
    visit(ast);
  }
  // Track by basename only for basename literals; slash-containing paths have one exact meaning.
  const trackedText = output(gitAt(root, ['ls-files', '-z', '--', '*.json'], env), 'tracked-json-unreadable');
  if (trackedText && !trackedText.endsWith('\0')) throw new Error('tracked-json-incomplete');
  const tracked = trackedText.split('\0').filter(Boolean);
  if (tracked.length > MAX_FILES) throw new Error('tracked-json-limit');
  for (const [file, literal] of jsonLiterals) {
    const matches = literal.startsWith('.') && literal.includes('/') ? [resolve(dirname(file), literal)]
      : literal.includes('/') ? [resolve(root, literal)] : tracked.filter(p => basename(p) === literal).map(p => resolve(root, p));
    if (!matches.length && !SUITE_JSON_RUNTIME_NAMES.includes(literal)) throw new Error(`unknown-json:${literal}`);
    for (const path of matches) {
      try { read(path); }
      catch (e) { if (e.code === 'ENOENT' && SUITE_JSON_RUNTIME_NAMES.includes(literal) && !tracked.includes(relative(root, path))) continue; throw e; }
    }
  }
  for (const path of tracked.filter(p => /^scripts\/settings\/[^/]+\.json$/.test(p)
    || /^scripts\/lib\/[^/]*settings[^/]*\.json$/.test(p) || /^scripts\/lib\/delivery-[^/]+\.json$/.test(p)
    || p === 'scripts/dispatch-settings.json')) read(resolve(root, path));
  if (packageUsed) read(join(root, 'package-lock.json'));
  return { bytes, reads, auditedReads, root };
}

/** Sorted [repo-relative path, content hash] entries plus named checks and operator-file evidence. */
export function suiteManifest({ root = RUNNING_ROOT, env = process.env, checks = SMOKE_CHECKS, readFile = readFileSync, log = console } = {}) {
  try {
    const entries = [...SUITE_ENTRIES, ...checks.flatMap(c => c.codeEntries ?? [])];
    const walked = walk({ root, entries, env, readFile });
    const manifest = [...walked.bytes].map(([p, data]) => [relative(walked.root, p), hash(data)]);
    const platform = operatorPreferencesPath(env);
    let platformHash;
    try {
      if (statSync(platform).size > MAX_BYTES) throw new Error('input-too-large');
      const data = readFile(platform);
      if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('input-too-large');
      JSON.parse(String(data));
      platformHash = hash(data);
    } catch (e) { if (e.code !== 'ENOENT') throw e; platformHash = 'absent'; }
    manifest.push(['@operator-platform', platformHash], ['@smoke-checks', hash(JSON.stringify(checks.map(({ name, kind, mayBeTransient, codeEntries }) => ({ name, kind, mayBeTransient, codeEntries })) ))]);
    return manifest.sort((a, b) => order(a[0], b[0]));
  } catch (e) { return refuse(`suite:${e.message}`, log); }
}
export function smokeSuiteHash(options) { const manifest = suiteManifest(options); return manifest && hash(JSON.stringify(manifest)); }

/** Literal reads, with exact-line audited reads excluded only from names (all sites remain inspectable). */
export function codeEnvNames(treeRoot, { entries = SMOKE_CHECKS.filter(c => c.kind === 'code').flatMap(c => c.codeEntries ?? []), env = process.env, log = console } = {}) {
  try {
    const { reads, auditedReads } = walk({ root: treeRoot, entries, env });
    const names = [...new Set(reads.filter(r => !auditedReads.some(p => p.file === r.file && p.name === r.name && p.exactLineText === r.line)).map(r => r.name))].sort(order);
    return { names, reads, auditedReads };
  } catch (e) { return refuse(`env-closure:${e.message}`, log); }
}

function ownershipPaths(root, env) {
  const paths = ['--show-toplevel', '--git-dir', '--git-common-dir'].map(flag => resolve(root, oneLine(gitAt(root, ['rev-parse', flag], env), `ownership-probe:${flag}`)));
  if (realpathSync(paths[0]) !== realpathSync(root)) throw new Error('ownership-root-mismatch');
  return [...paths, dirname(paths[2])];
}
function ownershipSafe(paths, liveRoot, env) {
  const pool = resolve(liveRoot, defaultPoolRoot(liveRoot, env));
  const realPool = realpathSync(pool);
  for (const path of paths) {
    if (path.split(sep).some(p => /^lane-\d+$/.test(p)) || within(pool, path) || within(realPool, path)) throw new Error('ownership-pool-or-lane');
  }
}
/** Predicted candidate may be absent; its parent and every live Git ownership path must be readable. */
export function preSlotOwnershipOk(liveRoot, predictedCandidatePath, env = process.env, { log = console } = {}) {
  try {
    if (!isAbsolute(liveRoot) || !isAbsolute(predictedCandidatePath)) throw new Error('ownership-path-invalid');
    const paths = ownershipPaths(liveRoot, env);
    ownershipSafe([...paths, ...paths.map(p => realpathSync(p)), predictedCandidatePath, dirname(predictedCandidatePath), realpathSync(dirname(predictedCandidatePath))], liveRoot, env);
    return true;
  } catch (e) { refuse(e.message, log); return false; }
}
/** Confirmation only permits/downgrades reuse. It never computes or changes a key. */
export function confirmCandidateOwnership(candidatePath, liveRoot, env = process.env, { log = console } = {}) {
  try {
    const live = ownershipPaths(liveRoot, env); const candidate = ownershipPaths(candidatePath, env);
    if (realpathSync(live[2]) !== realpathSync(candidate[2])) throw new Error('ownership-common-dir-mismatch');
    const paths = [...live, ...candidate, candidatePath, dirname(candidatePath)];
    ownershipSafe([...paths, ...paths.map(p => realpathSync(p))], liveRoot, env);
    return true;
  } catch (e) { refuse(e.message, log); return false; }
}

/** Canonical effective child env; values are ephemeral and must never be stored in identity records. */
export function effectiveEnvEntries({ root, env = process.env, envIgnore = [], extraNames = [], ownershipOk = false, log = console }) {
  try {
    if (!ownershipOk) throw new Error('env-ownership-unconfirmed');
    if (!Array.isArray(envIgnore) || envIgnore.some(n => typeof n !== 'string') || !Array.isArray(extraNames) || extraNames.some(n => typeof n !== 'string')) throw new Error('env-names-invalid');
    const effective = candidateSmokeEnv({ root, env });
    const budgets = [...Object.values(SMOKE_BUDGET_ENV), 'WE_REBUILD_SMOKE_TOTAL_MS', 'WE_REBUILD_SMOKE_FALLBACK_MIN_MS', 'WE_REBUILD_SMOKE_FAIL_FAST'];
    return Object.entries(effective).filter(([name, value]) => value !== undefined
      && (/^(WE_|GH_|GITHUB_|LANE_POOL_|NODE_|VITEST_)/.test(name) || EXPLICIT_HASHED_ENV.includes(name) || extraNames.includes(name))
      && ![...PER_LAUNCH_ENV, ...budgets, ...envIgnore].includes(name)).map(([name, value]) => {
      if (typeof value !== 'string') throw new Error('env-value-invalid');
      return [name, name === 'WE_SMOKE_LIVE_CLONE' ? '<present>' : /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|AUTH/i.test(name) ? (value === '' ? '' : '<present>') : value];
    }).sort((a, b) => order(a[0], b[0]));
  } catch (e) { return refuse(e.message, log); }
}
export function effectiveEnvHash(options) { const entries = effectiveEnvEntries(options); return entries && hash(JSON.stringify(entries)); }

/** Pre-slot identity: all failures disable sharing. Suite always belongs to the running harness. */
export function sharedSmokeIdentity({ root, sha, env = process.env, predictedCandidatePath,
  suiteRoot = RUNNING_ROOT, checks = SMOKE_CHECKS, envIgnore = [], extraNames = [],
  host = hostname(), nodeVersion = process.version, log = console }) {
  try {
    if (!preSlotOwnershipOk(root, predictedCandidatePath, env, { log })) return null;
    const components = smokeIdentityComponents(args => gitAt(root, args, env), sha, { nodeVersion, log });
    if (!components) return null;
    const liveOrigin = oneLine(gitAt(root, ['remote', 'get-url', 'origin'], env), 'origin-unreadable');
    if (!/^[^/]*:/.test(liveOrigin) || !host) throw new Error('origin-or-host-invalid');
    const suiteHash = smokeSuiteHash({ root: suiteRoot, env, checks, log }); if (!suiteHash) return null;
    const entries = effectiveEnvEntries({ root, env, envIgnore, extraNames, ownershipOk: true, log }); if (!entries) return null;
    const envHash = hash(JSON.stringify(entries));
    const key = hash(JSON.stringify([1, components.tree, components.lockHash, components.nodeVersion, suiteHash, envHash, host, liveOrigin]));
    return { ...components, key, suiteHash, envHash, envNames: entries.map(([name]) => name), host, liveOrigin };
  } catch (e) { return refuse(e.message, log); }
}
export function sharedDerivedKey(sharedKey, localKey) { return `shared-${hash(`${sharedKey}:${localKey}`)}`; }

/** Bounded stdin: a pipe that never closes must not hang the read-only diagnostic. */
function stdinEnvJson() {
  return new Promise((accept, reject) => {
    const chunks = []; let size = 0;
    const finish = (error) => {
      clearTimeout(timer); process.stdin.pause();
      process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.off('error', fail);
      process.stdin.destroy();
      if (error) reject(error); else accept(Buffer.concat(chunks));
    };
    const data = chunk => { size += chunk.length; if (size > MAX_BYTES) finish(new Error('env-json-input-too-large')); else chunks.push(chunk); };
    const end = () => finish(); const fail = error => finish(error);
    const timer = setTimeout(() => finish(new Error('env-json-timeout')), 5000);
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', fail);
  });
}
async function main(args) {
  try {
    if (!args.includes('--print-key')) throw new Error('usage: --print-key --clone=<path> --sha=<ref> [--env-json=-] [--confirm-candidate=<path>] [--json]');
    const value = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    let env = process.env;
    if (value('env-json') != null) {
      const inputPath = value('env-json');
      if (inputPath !== '-' && statSync(inputPath).size > MAX_BYTES) throw new Error('env-json-input-too-large');
      const data = inputPath === '-' ? await stdinEnvJson() : readFileSync(inputPath);
      if (data.byteLength > MAX_BYTES) throw new Error('env-json-input-too-large');
      env = JSON.parse(String(data));
      if (!env || Array.isArray(env) || typeof env !== 'object' || Object.values(env).some(v => typeof v !== 'string')) throw new Error('env-json-invalid');
    }
    const root = resolve(value('clone') || process.cwd());
    const predictedCandidatePath = candidateWorktreePath(root, env, 'probe');
    const identity = sharedSmokeIdentity({ root, sha: value('sha') || 'HEAD', env, predictedCandidatePath });
    const candidate = value('confirm-candidate');
    const confirmed = !candidate || confirmCandidateOwnership(resolve(candidate), root, env);
    process.stdout.write(`${JSON.stringify(identity && confirmed ? identity : { key: null, reason: confirmed ? 'identity-unavailable' : 'candidate-confirm-failed' })}\n`);
    if (!identity || !confirmed) process.exitCode = 1;
  } catch (e) { refuse(`cli:${e.message}`); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
