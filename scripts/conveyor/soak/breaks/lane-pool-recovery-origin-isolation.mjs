/** PR #5859: replay cross-pool recovery and lane-controlled URL rewrites with local Git repositories. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const cases = ['release --lane=1', 'release --all-pools', 'gc', 'gc insteadOf', 'gc pushInsteadOf',
  'gc credential.helper', 'gc core.gitProxy', 'gc core.askpass', 'gc http.proxy'];

export function replayRecoveryOrigin(root = ROOT, mode) {
  const base = mkdtempSync(join(tmpdir(), 'soak-recovery-origin-'));
  const git = (args, cwd = base) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    const origin = join(base, 'project.git'), primary = join(base, 'project');
    const callerOrigin = join(base, 'caller.git'), caller = join(base, 'caller');
    const pool = join(base, 'pool'), lane = join(pool, 'project', 'lane-1');
    git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    git(['clone', '--quiet', origin, primary]);
    writeFileSync(join(primary, 'work.txt'), 'seed\n');
    git(['add', '.'], primary);
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
    git([...identity, 'commit', '--quiet', '-m', 'seed'], primary);
    git(['push', '--quiet', 'origin', 'main'], primary);
    git(['clone', '--quiet', '--bare', origin, callerOrigin]);
    git(['clone', '--quiet', callerOrigin, caller]);
    mkdirSync(join(pool, 'project'), { recursive: true });
    git(['clone', '--quiet', origin, lane]);
    writeFileSync(join(lane, 'work.txt'), 'unique lane work\n');
    git(['add', '.'], lane);
    git([...identity, 'commit', '--quiet', '-m', 'unique work'], lane);
    const sha = git(['rev-parse', 'HEAD'], lane);
    const rewrite = mode.includes('InsteadOf') || mode.includes('insteadOf');
    const transportConfig = mode.startsWith('gc ') && !rewrite ? mode.split(' ')[1] : null;
    let attacker;
    if (rewrite) {
      attacker = join(base, 'attacker.git');
      git(['clone', '--quiet', '--bare', lane, attacker]);
      git(['config', `url.${attacker}.${mode.split(' ')[1]}`, origin], lane);
    } else if (transportConfig) {
      // These options are unused by a file transport, so transport success would
      // expose a missing guard without executing a helper or contacting a network.
      git(['config', transportConfig, 'unused-lane-transport-setting'], lane);
    } else {
      // The lane's own configured remote is also not the pool's authority.
      git(['remote', 'set-url', 'origin', callerOrigin], lane);
    }
    const release = mode.startsWith('release');
    if (release) writeFileSync(join(lane, '.git', '.lane-lease'), JSON.stringify({
      session: 'origin-proof', holder: 'origin-proof', purpose: 'soak', acquiredAt: new Date().toISOString(),
    }));
    const bin = join(base, 'bin');
    mkdirSync(bin);
    for (const [name, body] of [['claude', 'echo "[]"'], ['lsof', 'exit 0'], ['gh', 'exit 1']]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    const preload = `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';
      os.userInfo = () => ({homedir:${JSON.stringify(base)}}); syncBuiltinESMExports();`;
    const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
      join(root, 'scripts/lane-pool.mjs'), ...(release ? mode.split(' ') : ['gc']),
      '--pool=project', '--branch=main', '--session=origin-proof', '--no-install'], {
      cwd: caller, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, LANE_POOL_ROOT: pool, LANE_POOL_AUTO_RECOVER: '1', LANE_POOL_NO_RECOVER: '0',
        WE_LANE_BACKUP_ROOT: join(base, 'backups'), WE_NEEDS_YOU_FEED: join(base, 'attention.jsonl'),
        WE_LANE_SALVAGE_QUIET_MIN: '0', VITEST: 'true', WE_TEST_HOST_LOAD1: '0', WE_TEST_HOST_MEMORY_MB: '999999',
        PATH: `${bin}:${process.env.PATH}` },
    });
    const violations = [];
    if (result.status !== 0) violations.push(`${mode}: CLI failed (${result.status}): ${String(result.error || result.stderr).slice(0, 500)}`);
    const saved = git(['ls-remote', '--heads', origin, 'refs/heads/salvage/*'], primary);
    const leaked = git(['ls-remote', '--heads', callerOrigin, 'refs/heads/salvage/*'], primary);
    if (leaked) violations.push(`${mode}: work sent to caller origin`);
    if (rewrite || transportConfig) {
      if (git(['rev-parse', 'HEAD'], lane) !== sha) violations.push(`${mode}: reset unpreserved work`);
      if (saved || (attacker && git(['ls-remote', '--heads', attacker, 'refs/heads/salvage/*'], primary))) {
        violations.push(`${mode}: refused rewrite still transported work`);
      }
      if (!result.stderr.includes('auto-recover: reclaimed 0, kept-unpushed 1')) {
        violations.push(`${mode}: did not exercise recovery refusal`);
      }
    } else if (!saved.startsWith(`${sha}\trefs/heads/salvage/lane-1-`)) {
      violations.push(`${mode}: selected canonical origin did not receive work`);
    }
    return { violations };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

export default {
  id: 'lane-pool-recovery-origin-isolation',
  title: 'pool selection and lane URL rewriting cannot redirect recovery preservation',
  card: 'we:PR#5859',
  fixedBy: { sha: 'HEAD', where: 'lane/lane-pool-cap-count-main',
    paths: ['scripts/lane-pool.mjs', 'scripts/lib/lane-pool-salvage-push.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8').includes('reference: join(dirname(topLevel), explicitPool)')
      && readFileSync(join(root, 'scripts/lib/lane-pool-salvage-push.mjs'), 'utf8').includes('URL rewriting configured')
      && readFileSync(join(root, 'scripts/lib/lane-pool-salvage-push.mjs'), 'utf8').includes('lane-controlled transport configuration');
  },
  async run({ root = ROOT, log } = {}) {
    const violations = [];
    for (const mode of cases) {
      const result = replayRecoveryOrigin(root, mode);
      violations.push(...result.violations);
      log?.(`${mode}: ${result.violations.length ? 'RED' : 'GREEN'}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
