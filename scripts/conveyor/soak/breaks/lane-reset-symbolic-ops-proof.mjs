/** PR #5805: symbolic aliases and direct remaps of excluded ops tips must never authorize a lane reset.
 * Runs the real acquire CLI against disposable repositories; no network or host lanes are used.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'lane-reset-symbolic-ops-proof',
  title: 'symbolic aliases and direct remaps of excluded ops refs cannot authorize destruction of unique lane work',
  card: 'we:PR#5805',
  // The launcher creates the repair commit; later replays can supply --revert=<repair-sha>.
  fixedBy: { sha: 'HEAD', where: 'lane/lane-git-diet-fetch', paths: ['scripts/lane-pool.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8');
    const proof = /function localRemoteShas\([^]*?\n\}/.exec(source)?.[0] ?? '';
    return proof.includes('%(symref)') && proof.includes('remote.origin.fetch');
  },
  async run({ root = REPO_ROOT } = {}) {
    const violations = [];
    for (const alias of ['symbolic', 'mapped', 'wildcard-mapped']) {
      const report = await runAliasCase(root, alias);
      violations.push(...report.violations.map((message) => `${alias}: ${message}`));
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};

async function runAliasCase(root, alias) {
    const base = mkdtempSync(join(tmpdir(), 'soak-symbolic-ops-'));
    const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      const origin = join(base, 'origin.git'), reference = join(base, 'reference'), pool = join(base, 'pool');
      git(['init', '--quiet', '--bare', '--initial-branch=trunk', origin]);
      git(['clone', '--quiet', origin, reference]);
      git(['config', 'user.email', 'test@example.com'], reference);
      git(['config', 'user.name', 'Test'], reference);
      writeFileSync(join(reference, 'work.txt'), 'seed\n');
      git(['add', 'work.txt'], reference);
      git(['commit', '--quiet', '-m', 'seed'], reference);
      git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], reference);
      const cli = (args) => spawnSync(process.execPath, [join(root, 'scripts/lane-pool.mjs'), ...args,
        `--origin=${origin}`, `--reference=${reference}`, '--name=symbolic-ops', '--branch=trunk', '--no-install'], {
        encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool }, timeout: 30000, maxBuffer: 1024 * 1024,
      });
      const provision = cli(['provision', '--count=1']);
      if (provision.status !== 0) throw Error(`fixture provision failed: ${provision.stderr}`);
      const lane = join(pool, 'symbolic-ops', 'lane-1');
      git(['config', 'user.email', 'test@example.com'], lane);
      git(['config', 'user.name', 'Test'], lane);
      const content = 'unique lane work\n';
      writeFileSync(join(lane, 'work.txt'), content);
      git(['add', 'work.txt'], lane);
      git(['commit', '--quiet', '-m', 'unique work'], lane);
      const head = git(['rev-parse', 'HEAD'], lane);
      const ops = 'refs/heads/ops/review-requests';
      const tracking = 'refs/remotes/origin/ops/review-requests';
      git(['push', '--quiet', 'origin', `HEAD:${ops}`], lane);
      git(['fetch', '--quiet', 'origin', `+${ops}:${tracking}`], lane);
      if (alias === 'symbolic') {
        git(['symbolic-ref', 'refs/remotes/origin/saved', tracking], lane);
        git(['update-ref', '-d', ops], origin);
      } else {
        const mapping = alias === 'mapped'
          ? `+${ops}:refs/remotes/origin/saved`
          : '+refs/heads/ops/*:refs/remotes/origin/archive/*';
        git(['config', '--add', 'remote.origin.fetch', mapping], lane);
        git(['fetch', '--quiet', 'origin', mapping], lane);
        git(['update-ref', ops, 'refs/heads/trunk'], origin);
      }
      if (git(['for-each-ref', `--contains=${head}`, '--format=%(refname)', 'refs/heads/'], origin)) {
        throw Error('fixture work is still contained by a remote branch');
      }
      const acquire = cli(['acquire', '--lane=1', '--session=symbolic-ops-proof', '--hard-max=1']);
      const violations = [];
      if (acquire.status === 0 || !/would destroy that work/.test(acquire.stderr)) {
        violations.push('acquire did not refuse the stale alias proof');
      }
      if (git(['rev-parse', 'HEAD'], lane) !== head || readFileSync(join(lane, 'work.txt'), 'utf8') !== content) {
        violations.push('acquire reset unique lane work using an excluded ops alias');
      }
      return { violations };
    } finally { rmSync(base, { recursive: true, force: true }); }
}
