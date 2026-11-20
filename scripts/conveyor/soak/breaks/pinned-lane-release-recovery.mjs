/** PR #7208: freeing a pinned lease must return its clone to the integration branch. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = 'scripts/lane-pool.mjs';
export default {
  id: 'pinned-lane-release-recovery',
  title: 'pinned lanes recover moved HEAD with discard and reset during cross-pool release',
  card: 'PR #7208',
  fixedBy: { sha: 'HEAD', where: 'lane/lane-at-sha', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('function resetPinnedLaneForRelease(');
  },
  async run({ root = ROOT, log } = {}) {
    const scratch = mkdtempSync(join(tmpdir(), 'soak-pinned-release-'));
    const origin = join(scratch, 'origin.git'), reference = join(scratch, 'reference');
    const pool = join(scratch, 'pool'), lane = join(pool, 'recovery', 'lane-1');
    const violations = [];
    const git = (args, cwd = reference) => execFileSync('git', ['-c', 'commit.gpgsign=false',
      '-c', 'user.name=Soak', '-c', 'user.email=soak@example.invalid', ...args], {
      cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const run = (command, args) => spawnSync(process.execPath, [join(root, SOURCE), command,
      `--origin=${origin}`, `--reference=${reference}`, '--name=recovery', '--session=pinned-recovery',
      '--no-install', '--no-reap', ...args], { cwd: reference, encoding: 'utf8', timeout: 60_000,
      maxBuffer: 1024 * 1024, env: { ...process.env, LANE_POOL_ROOT: pool, LANE_POOL_AUTO_RECOVER: '0' } });
    try {
      git(['init', '--quiet', '--bare', '--initial-branch=main', origin], scratch);
      git(['clone', '--quiet', origin, reference], scratch);
      writeFileSync(join(reference, 'file.txt'), 'initial');
      git(['add', 'file.txt']); git(['commit', '--quiet', '-m', 'initial']);
      const main = git(['rev-parse', 'HEAD']);
      git(['push', '--quiet', 'origin', 'HEAD:main']);
      writeFileSync(join(reference, 'file.txt'), 'target'); git(['commit', '-am', 'target', '--quiet']);
      const at = git(['rev-parse', 'HEAD']);
      git(['push', '--quiet', 'origin', 'HEAD:lane/target']);
      if (run('provision', ['--count=1']).status !== 0) throw new Error('soak provision failed');
      for (const mode of ['discard', 'all-pools']) {
        if (run('acquire', ['--lane=1', `--at=${at}`, '--branch=lane/target']).status !== 0) {
          violations.push(`${mode}: acquire failed`); continue;
        }
        if (mode === 'discard') git(['commit', '--allow-empty', '-m', 'worker commit'], lane);
        const released = run('release', mode === 'discard' ? ['--lane=1', '--discard'] : ['--all-pools']);
        if (released.status !== 0) violations.push(`${mode}: release refused`);
        if (existsSync(join(lane, '.git', '.lane-lease'))) violations.push(`${mode}: lease remains`);
        const head = readFileSync(join(lane, '.git', 'HEAD'), 'utf8').trim();
        if (head !== 'ref: refs/heads/main' || git(['rev-parse', 'HEAD'], lane) !== main) {
          violations.push(`${mode}: lane did not return to main`);
        }
        // A failed first case retains its lease; stop rather than treating a second acquire as recovery proof.
        if (violations.length) break;
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    log?.(`pinned release recovery: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
