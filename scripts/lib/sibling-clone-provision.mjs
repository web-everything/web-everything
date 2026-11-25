import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { CONSTELLATION_REPOS, repoKeyForDir, repoKeyForSlug } from './constellation-repos.mjs';

/** Accept the shared keys, directory names and canonical/legacy slugs; refuse unknown repos. */
export function resolveSiblingRepoName(slugOrName) {
  const key = repoKeyForSlug(slugOrName) ?? repoKeyForDir(slugOrName);
  return key ? CONSTELLATION_REPOS[key].slug.split('/').at(-1) : null;
}

const diagnostic = value => stripVTControlCharacters(String(value?.message ?? value))
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500);

/** WE is the drain's local checkout; the table's non-empty paths identify its sibling repos. */
export function siblingCloneStatus({ cwd = process.cwd(), exists = existsSync } = {}) {
  return Object.values(CONSTELLATION_REPOS).filter(repo => repo.path).map(repo => {
    const name = resolveSiblingRepoName(repo.slug);
    const dir = resolve(cwd, '..', name);
    try {
      const present = !!exists(join(dir, '.git'));
      return { name, dir, present, reason: present ? null : `no .git at ${dir}` };
    } catch (error) {
      return { name, dir, present: false, reason: `cannot inspect ${dir}: ${diagnostic(error)}` };
    }
  });
}

/** Best-effort startup repair. run has execFileSync's synchronous (command, argv, options) contract.
 * Existing paths are never repaired/reset/deleted. Failed repairs stay unavailable until an operator
 * repairs the path and restarts the drain. home is injectable so tests never use host primary clones.
 */
export function provisionMissingSiblingClones({ cwd = process.cwd(), run = execFileSync,
  exists = existsSync, log = () => {}, dryRun = false, home = homedir() } = {}) {
  const result = { provisioned: [], failed: [] };
  const report = line => { try { log(diagnostic(line)); } catch { /* logging cannot stop the drain */ } };
  for (const status of siblingCloneStatus({ cwd, exists })) {
    if (status.present) continue;
    const { name, dir } = status;
    report(`sibling clone ${name}: ${status.reason}${dryRun ? ' (dry-run; would provision if absent)' : ''}`);
    if (dryRun) continue;
    try {
      if (status.reason.startsWith('cannot inspect ')) throw new Error(status.reason);
      if (exists(dir)) throw new Error(`existing directory at ${dir}; ${status.reason}; repair it manually and restart the drain`);
      const repo = CONSTELLATION_REPOS[repoKeyForSlug(name)];
      const primary = join(home, 'workspace', name);
      const url = `https://github.com/${repo.slug}.git`;
      const runOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 1024 * 1024 };
      const cloneArgs = exists(join(primary, '.git'))
        ? ['clone', '--quiet', '-c', 'gc.auto=0', '--reference', primary, url, dir]
        : ['clone', '--quiet', '-c', 'gc.auto=0', url, dir];
      run('git', cloneArgs, runOptions);
      if (!exists(join(dir, '.git'))) throw new Error(`no .git at ${dir}`);
      result.provisioned.push(name);
    } catch (error) {
      const reason = diagnostic(error);
      result.failed.push({ name, reason });
      report(`sibling clone ${name}: failed: ${reason}; repair the sibling clone and restart the drain`);
    }
  }
  return result;
}
