import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { boundedGitCommand, BOUNDED_GIT_GRACE_MS } from './git-bounded.mjs';
import { NETWORK_GIT_TIMEOUT_MS } from './bounded-child.mjs';
import { gitRun } from './git-run.mjs';
import { CONSTELLATION_REPOS, repoKeyForDir, repoKeyForSlug } from './constellation-repos.mjs';

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
const readOptions = cwd => ({ cwd, timeoutMs: 5_000, maxBuffer: 1024 * 1024 });
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
  exists = existsSync, read = readOrigin, shallow = readShallow, beforeWrite = () => {}, log = () => {}, dryRun = false, home = homedir() } = {}) {
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
        timeout: NETWORK_GIT_TIMEOUT_MS + BOUNDED_GIT_GRACE_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 };
      let fullPrimary = false;
      if (exists(join(primary, '.git'))) {
        try { fullPrimary = shallow(primary).trim() === 'false'; } catch { /* unknown: plain clone */ }
      }
      const cloneArgs = fullPrimary
        ? ['clone', '--quiet', '-c', 'gc.auto=0', '--reference', primary, url, dir]
        : ['clone', '--quiet', '-c', 'gc.auto=0', url, dir];
      beforeWrite();
      mkdirSync(dir); // Reserve the absent path exclusively before taking cleanup ownership.
      created = true;
      const bounded = boundedGitCommand(cloneArgs, NETWORK_GIT_TIMEOUT_MS);
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
