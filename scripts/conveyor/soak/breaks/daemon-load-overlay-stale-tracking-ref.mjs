/**
 * A registered overlay can advance outside a clone's main-only fetch mapping.
 * Plain fetch updates FETCH_HEAD but leaves origin/<ref> stale: the old count
 * reports up-to-date and never adopts the new tip. Exercise real local Git only.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mergeOverlayRef } from '../../../lib/daemon-load-overlay.mjs';
import { gitRun } from '../../../lib/main-staleness.mjs';

export default {
  id: 'daemon-load-overlay-stale-tracking-ref',
  title: 'overlay load adopts the new remote tip even when the clone fetch mapping excludes the overlay',
  card: 'lane/g12-overlay-refspec',
  fixedBy: {
    sha: '0c47abf4072662300b066fc140a1d4b5156a1e0f',
    where: 'lane/g12-overlay-refspec',
    paths: ['scripts/lib/daemon-load-overlay.mjs'],
  },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/lib/daemon-load-overlay.mjs'), 'utf8')
        .includes('+refs/heads/${ref}:refs/remotes/origin/${ref}');
    } catch { return false; }
  },
  async run({ log, runGit = gitRun } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-overlay-stale-tracking-'));
    const remote = join(dir, 'remote');
    const clone = join(dir, 'clone');
    const ref = 'lane/overlay';
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (cwd, ...args) => execFileSync('git', [
      '-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args,
    ], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
    try {
      mkdirSync(remote);
      git(remote, 'init', '-q', '-b', 'main');
      git(remote, 'commit', '-q', '--allow-empty', '-m', 'seed');
      git(remote, 'branch', ref);
      git(dir, 'clone', '-q', remote, clone);
      git(clone, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
      const oldTip = git(clone, 'rev-parse', 'HEAD');
      git(remote, 'checkout', '-q', ref);
      git(remote, 'commit', '-q', '--allow-empty', '-m', 'new overlay tip');
      const tip = git(remote, 'rev-parse', 'HEAD');
      git(clone, 'fetch', '--quiet', '--', 'origin', ref);
      const plainFetch = {
        fetched: git(clone, 'rev-parse', 'FETCH_HEAD'),
        tracked: git(clone, 'rev-parse', `origin/${ref}`),
        behind: git(clone, 'rev-list', '--count', `HEAD..origin/${ref}`),
      };
      const violations = [];
      if (plainFetch.fetched !== tip || plainFetch.tracked !== oldTip || plainFetch.behind !== '0') {
        violations.push({ invariant: 'regression-fixture', detail: 'plain fetch did not reproduce the stale tracking ref and false up-to-date count' });
      }
      const result = mergeOverlayRef({ root: clone, ref, run: runGit });
      const head = git(clone, 'rev-parse', 'HEAD');
      const tracked = git(clone, 'rev-parse', `origin/${ref}`);
      if (result.reason !== 'merged' || !result.merged || head !== tip || tracked !== tip) {
        violations.push({ invariant: 'overlay-tip-adopted', detail: `load returned ${result.reason}; new tip adopted=${head === tip}, tracking refreshed=${tracked === tip}` });
      }
      log?.(`overlay load: ${result.reason}`);
      return { violations, report: { result, plainFetch, tip, head, tracked } };
    } catch (error) {
      return { violations: [{ invariant: 'crash', detail: String(error?.message || error).split('\n')[0] }] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
