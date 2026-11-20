/** PR #7208: pinned lane switches preserve ignored files and recover the integration branch. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = 'scripts/lane-pool.mjs';
export default {
  id: 'pinned-lane-release-recovery',
  title: 'pinned lanes recover moved HEAD and refuse ignored configuration collisions',
  card: 'PR #7208',
  fixedBy: { sha: 'HEAD', where: 'lane/lane-at-sha', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('function resetPinnedLaneForRelease(')
      && source.includes("['checkout', '--no-overwrite-ignore', '--detach', flags.at");
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
      writeFileSync(join(reference, '.gitignore'), '.env\n');
      git(['add', 'file.txt', '.gitignore']); git(['commit', '--quiet', '-m', 'initial']);
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
      if (!violations.length) {
        writeFileSync(join(reference, '.env'), 'target configuration');
        git(['add', '--force', '.env']); git(['commit', '--quiet', '-m', 'track target configuration']);
        const collisionTip = git(['rev-parse', 'HEAD']);
        git(['push', '--quiet', 'origin', 'HEAD:lane/target']);
        writeFileSync(join(lane, '.env'), 'precious local configuration');
        if (git(['status', '--porcelain'], lane)) throw new Error('ignored collision fixture must be clean');
        const acquired = run('acquire', ['--lane=1', `--at=${collisionTip}`, '--branch=lane/target']);
        if (acquired.status === 0) violations.push('ignored collision: acquisition accepted');
        if (!existsSync(join(lane, '.env')) || readFileSync(join(lane, '.env'), 'utf8') !== 'precious local configuration') {
          violations.push('ignored collision: local configuration lost');
        }
        if (existsSync(join(lane, '.git', '.lane-lease'))) violations.push('ignored collision: lease remains');
        if (readFileSync(join(lane, '.git', 'HEAD'), 'utf8').trim() !== 'ref: refs/heads/main'
          || git(['rev-parse', 'HEAD'], lane) !== main) violations.push('ignored collision: main not restored');
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    log?.(`pinned release recovery: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
