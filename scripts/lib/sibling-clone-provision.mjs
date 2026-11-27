import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { boundedGitCommand, BOUNDED_GIT_GRACE_MS } from './git-bounded.mjs';
import { NETWORK_GIT_TIMEOUT_MS } from './bounded-child.mjs';
import { gitRun } from './git-run.mjs';
import { hardenLaneGitArgs, laneGitHardeningEnv, scrubGitRepoEnv } from './lane-git-hardening.mjs';
import { CONSTELLATION_REPOS, repoKeyForDir, repoKeyForSlug } from './constellation-repos.mjs';

const NO_REPO_CWD = parse(resolve('/')).root;

function templateFree(env) {
  const out = { ...env };
  // Templates can plant credential config in the new repository before its first fetch.
  delete out.GIT_TEMPLATE_DIR;
  return out;
}

const CREDENTIAL_RESET_KEYS = ['credential.helper', 'core.askPass'];
const MAX_PARENT_CONFIG_ENTRIES = 1024;
const MAX_PARENT_CONFIG_BYTES = 65536;

function parentCredentialResets(env) {
  const invalid = () => { throw new Error('parent-git-config-invalid: repair inherited git config and restart the drain'); };
  const resets = new Set();
  const retain = (key, value) => {
    if (!key) invalid();
    const canonical = CREDENTIAL_RESET_KEYS.find(candidate => candidate.toLowerCase() === key.toLowerCase());
    if (canonical && value === null) invalid();
    if (canonical && value === '') resets.add(canonical);
  };
  const rawCount = env.GIT_CONFIG_COUNT ?? '0';
  if (!/^(0|[1-9][0-9]*)(?![\s\S])/.test(rawCount) || Number(rawCount) > MAX_PARENT_CONFIG_ENTRIES) invalid();
  let bytes = 0;
  for (let i = 0; i < Number(rawCount); i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`], value = env[`GIT_CONFIG_VALUE_${i}`];
    if (typeof key !== 'string' || typeof value !== 'string') invalid();
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (bytes > MAX_PARENT_CONFIG_BYTES) invalid();
    retain(key, value);
  }
  const parameters = env.GIT_CONFIG_PARAMETERS ?? '';
  if (Buffer.byteLength(parameters) + bytes > MAX_PARENT_CONFIG_BYTES) invalid();
  let pos = 0, entries = Number(rawCount);
  const whitespace = char => char !== undefined && /[ \t\r\n\v\f]/.test(char);
  // Git uses single-quoted words, with \\' and \\! between quoted segments.
  // Accept both legacy 'key=value' and current 'key'='value' encodings.
  const quoted = () => {
    if (parameters[pos++] !== "'") invalid();
    let word = '';
    while (pos < parameters.length) {
      const char = parameters[pos++];
      if (char !== "'") { word += char; continue; }
      if (parameters[pos] === '\\' && ["'", '!'].includes(parameters[pos + 1]) && parameters[pos + 2] === "'") {
        word += parameters[pos + 1]; pos += 3; continue;
      }
      return word;
    }
    invalid();
  };
  while (pos < parameters.length) {
    if (whitespace(parameters[pos])) { pos++; continue; }
    if (++entries > MAX_PARENT_CONFIG_ENTRIES) invalid();
    const word = quoted();
    if (parameters[pos] === '=') {
      pos++;
      retain(word, parameters[pos] === "'" ? quoted() : null);
    } else {
      const equals = word.indexOf('=');
      retain(equals < 0 ? word : word.slice(0, equals), equals < 0 ? null : word.slice(equals + 1));
    }
    if (pos < parameters.length && !whitespace(parameters[pos])) invalid();
  }
  return CREDENTIAL_RESET_KEYS.filter(key => resets.has(key));
}

function cloneGitEnv() {
  // Capture only the parent's empty resets before the account form scrubs config.
  // With no reset, private clones retain the trusted account's credential helper.
  const resets = parentCredentialResets(process.env);
  const env = laneGitHardeningEnv(templateFree(scrubGitRepoEnv(process.env)), { credentialPins: false });
  let count = Number(env.GIT_CONFIG_COUNT);
  for (const key of resets) {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count++}`] = '';
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}

/** Accept the shared keys, directory names and canonical/legacy slugs; refuse unknown repos. */
export function resolveSiblingRepoName(slugOrName) {
  const key = repoKeyForSlug(slugOrName) ?? repoKeyForDir(slugOrName);
  return key ? CONSTELLATION_REPOS[key].slug.split('/').at(-1) : null;
}

const diagnostic = value => stripVTControlCharacters(String(value?.message ?? value))
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500);

function readGitOutput(result) {
  if (result.status !== 0) throw new Error(result.stderr || `git read failed (exit ${result.status})`);
  return result.stdout.trim();
}
const readOptions = cwd => ({ cwd, timeoutMs: 5_000, maxBuffer: 1024 * 1024,
  // gitRun overlays process.env: mask removed keys so they cannot be inherited again.
  env: { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])),
    ...laneGitHardeningEnv(templateFree(scrubGitRepoEnv(process.env))) } });
// These fixed read argv need no rewriting; keep them literal for the push audit.
const readOrigin = cwd => readGitOutput(gitRun('git', ['remote', 'get-url', 'origin'], readOptions(cwd)));
const readShallow = cwd => readGitOutput(gitRun('git', ['rev-parse', '--is-shallow-repository'], readOptions(cwd)));

function originMatches(dir, slug, read) {
  try {
    const origin = read(dir).trim();
    const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(origin);
    return !!match && repoKeyForSlug(match[1].toLowerCase()) === repoKeyForSlug(slug);
  } catch { return false; }
}

/** WE is the drain's local checkout; the table's non-empty paths identify its sibling repos. */
export function siblingCloneStatus({ cwd = process.cwd(), exists = existsSync, read = readOrigin } = {}) {
  return Object.values(CONSTELLATION_REPOS).filter(repo => repo.path).map(repo => {
    const name = resolveSiblingRepoName(repo.slug);
    const dir = resolve(cwd, '..', name);
    try {
      if (!exists(join(dir, '.git'))) return { name, dir, present: false, reason: `no .git at ${dir}` };
      const present = originMatches(dir, repo.slug, read);
      return { name, dir, present, reason: present ? null : 'origin mismatch' };
    } catch (error) {
      return { name, dir, present: false, reason: `cannot inspect ${dir}: ${diagnostic(error)}` };
    }
  });
}

/** Best-effort startup repair. run has execFileSync's synchronous (command, argv, options) contract.
 * Existing paths are never repaired/reset/deleted; only directories reserved here are removed on failure.
 * Failed repairs stay unavailable until an operator repairs the path and restarts the drain. home is injectable so tests never use host primary clones.
 */
export function provisionMissingSiblingClones({ cwd = process.cwd(), run = execFileSync,
  exists = existsSync, read = readOrigin, shallow = readShallow, log = () => {}, dryRun = false, home = homedir() } = {}) {
  const result = { provisioned: [], failed: [] };
  const report = line => { try { log(diagnostic(line)); } catch { /* logging cannot stop the drain */ } };
  for (const status of siblingCloneStatus({ cwd, exists, read })) {
    if (status.present) continue;
    const { name, dir } = status;
    report(`sibling clone ${name}: ${status.reason}${dryRun ? ' (dry-run; would provision if absent)' : ''}`);
    if (dryRun) continue;
    let created = false;
    try {
      if (status.reason.startsWith('cannot inspect ')) throw new Error(status.reason);
      if (exists(dir)) throw new Error(`existing directory at ${dir}; ${status.reason}; repair it manually and restart the drain`);
      const repo = CONSTELLATION_REPOS[repoKeyForSlug(name)];
      const primary = join(home, 'workspace', name);
      const url = `https://github.com/${repo.slug}.git`;
      const runOptions = { stdio: ['ignore', 'ignore', 'inherit'],
        timeout: NETWORK_GIT_TIMEOUT_MS + BOUNDED_GIT_GRACE_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
        // A root cwd excludes lane-local config; parent credential resets still apply.
        env: cloneGitEnv(), cwd: NO_REPO_CWD };
      let fullPrimary = false;
      if (exists(join(primary, '.git'))) {
        try { fullPrimary = shallow(primary).trim() === 'false'; } catch { /* unknown: plain clone */ }
      }
      const cloneArgs = fullPrimary
        ? ['clone', '--quiet', '-c', 'gc.auto=0', '--reference', primary, url, dir]
        : ['clone', '--quiet', '-c', 'gc.auto=0', url, dir];
      mkdirSync(dir); // Reserve the absent path exclusively before taking cleanup ownership.
      created = true;
      const bounded = boundedGitCommand(hardenLaneGitArgs(cloneArgs), NETWORK_GIT_TIMEOUT_MS);
      run(bounded.file, bounded.args, runOptions);
      if (!exists(join(dir, '.git'))) throw new Error(`no .git at ${dir}`);
      if (!originMatches(dir, repo.slug, read)) throw new Error('origin mismatch');
      result.provisioned.push(name);
    } catch (error) {
      let reason = diagnostic(error);
      if (created) {
        try { rmSync(dir, { recursive: true, force: true }); }
        catch (cleanupError) { reason += `; cleanup failed: ${diagnostic(cleanupError)}`; }
      }
      result.failed.push({ name, reason });
      report(`sibling clone ${name}: failed: ${reason}; repair the sibling clone and restart the drain`);
    }
  }
  return result;
}
