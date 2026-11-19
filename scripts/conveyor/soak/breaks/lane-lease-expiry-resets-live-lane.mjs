import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

// Replay the real takeover path with all external session/process listings empty.
// Fix presence depends on refusal and preserved bytes, never a source-string match.
export function replayExpiry(root) {
  const base = mkdtempSync(join(tmpdir(), 'soak-lease-expiry-'));
  const violations = [];
  const git = args => execFileSync('git', args, { cwd: base, stdio: 'pipe', timeout: 5000 });
  try {
    const reference = join(base, 'reference'), pool = join(base, 'pool');
    const lane = join(pool, 'fixture', 'lane-1'), bin = join(base, 'bin');
    mkdirSync(reference); mkdirSync(join(pool, 'fixture'), { recursive: true }); mkdirSync(bin);
    git(['init', '--quiet', '--initial-branch=main', reference]);
    writeFileSync(join(reference, 'file'), 'base');
    git(['-C', reference, 'add', '.']);
    git(['-C', reference, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'seed']);
    git(['clone', '--quiet', reference, lane]);
    for (const [name, body] of [['lsof', 'exit 0'], ['claude', 'echo "[]"'], ['gh', 'exit 1']]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    for (const kind of ['live', 'dirty']) {
      const marker = join(lane, '.git', '.lane-lease');
      const bytes = JSON.stringify({ session: 'old-holder', acquiredAt: '2020-01-01T00:00:00.000Z',
        ttlMinutes: 240, ...(kind === 'live' ? { pid: process.pid, host: hostname() } : {}) });
      writeFileSync(marker, bytes);
      if (kind === 'dirty') writeFileSync(join(lane, 'work'), 'uncommitted work');
      const result = spawnSync(process.execPath, [join(root, 'scripts/lane-pool.mjs'), 'acquire',
        '--lane=1', '--pool=fixture', `--origin=${reference}`, `--reference=${reference}`,
        '--session=new-holder', '--force', '--no-reset', '--no-reap', '--no-install'], {
        cwd: reference, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
        env: { ...process.env, LANE_POOL_ROOT: pool, PATH: `${bin}:${process.env.PATH}` },
      });
      if (result.error || !result.stderr?.includes(`stale-but-${kind}`) || result.status === 0
          || readFileSync(marker, 'utf8') !== bytes) violations.push(`${kind}: expired lease was not safely retained`);
      if (kind === 'dirty' && readFileSync(join(lane, 'work'), 'utf8') !== 'uncommitted work') {
        violations.push('dirty: uncommitted bytes lost');
      }
    }
  } catch (error) { violations.push(`scenario failed: ${error.message}`); }
  finally { rmSync(base, { recursive: true, force: true }); }
  return { violations };
}

export default {
  id: 'lane-lease-expiry-resets-live-lane',
  title: 'TTL expiry never takes over a live holder or dirty working tree',
  card: 'lane lease expiry data loss',
  fixedBy: { sha: 'working-tree', where: 'lane/lane-lease-heartbeat' },
  fixPresent(root) { return replayExpiry(root).violations.length === 0; },
  run() { return replayExpiry(new URL('../../../../', import.meta.url).pathname); },
  judge(report) { return report.violations; },
};
