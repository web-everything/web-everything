/** PR #7246: a lane-local origin/main ref must not release verified private work. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'lane-branch-forged-main-hold',
  title: 'branch keeps verification holds despite forged local main evidence',
  card: 'we:PR#7246',
  fixedBy: { sha: 'HEAD', where: 'lane/lane-pool-branch', paths: ['scripts/lane-pool.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8').includes('function branchHeadOnFreshRemote(');
  },
  async run({ root = ROOT, log } = {}) {
    const scratch = mkdtempSync(join(tmpdir(), 'soak-branch-hold-'));
    const git = (cwd, ...args) => execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const violations = [];
    try {
      const primary = join(scratch, 'primary');
      const origin = join(scratch, 'origin.git');
      const pool = join(scratch, 'pool');
      const lane = join(pool, 'fixture', 'lane-1');
      mkdirSync(primary);
      mkdirSync(join(pool, 'fixture'), { recursive: true });
      git(primary, 'init', '--quiet', '--initial-branch=main');
      const commit = cwd => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'work');
      commit(primary);
      git(scratch, 'clone', '--quiet', '--bare', primary, origin);
      git(scratch, 'clone', '--quiet', '--reference', primary, origin, lane);
      commit(lane);
      const head = git(lane, 'rev-parse', 'HEAD');
      git(lane, 'update-ref', 'refs/remotes/origin/main', head);
      const lease = JSON.stringify({ holder: 'holder', session: 'soak', acquiredAt: new Date().toISOString(), ttlMinutes: 120 });
      const marker = join(lane, '.git', '.lane-lease');
      writeFileSync(marker, lease);
      const refs = git(lane, 'show-ref');
      for (const status of ['green', 'corrupt']) {
        writeFileSync(join(lane, '.git', '.lane-verify'), status === 'corrupt' ? '{' : JSON.stringify({
          sha: head, status, finishedAt: new Date().toISOString(),
        }));
        for (const dryRun of [false, true]) {
          const result = spawnSync(process.execPath, [join(root, 'scripts/lane-pool.mjs'), 'branch',
            '--pool=fixture', `--reference=${primary}`, `--origin=${origin}`, '--lane=1', '--session=holder',
            '--name=lane/soak', ...(dryRun ? ['--dry-run'] : [])], {
            cwd: primary, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
            env: { ...process.env, LANE_POOL_ROOT: pool, WE_LANE_HOLD: 'enforce' },
          });
          const label = `${status}, dry-run=${dryRun}`;
          if (result.status !== 1 || !result.stderr.includes('lane-hold')) violations.push(`${label}: verification hold bypassed`);
          if (git(lane, 'show-ref') !== refs || git(lane, 'symbolic-ref', 'HEAD') !== 'refs/heads/main'
            || readFileSync(marker, 'utf8') !== lease) violations.push(`${label}: branch refusal changed lane state`);
          log?.(`${label}: exit ${result.status}`);
        }
      }
      return { violations };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
