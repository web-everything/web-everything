import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Replay the real takeover path with all external session/process listings empty.
// Fix presence depends on refusal and preserved bytes, never a source-string match.
export function replayExpiry(root) {
  const base = mkdtempSync(join(tmpdir(), 'soak-lease-expiry-'));
  const violations = [];
  const git = args => execFileSync('git', args, { cwd: base, stdio: 'pipe', timeout: 5000, maxBuffer: 1024 * 1024 });
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
      const refresh = spawnSync(process.execPath, [join(root, 'scripts/lane-pool.mjs'), 'refresh',
        '--lane=1', '--pool=fixture', `--origin=${reference}`, `--reference=${reference}`,
        '--force', '--no-install'], {
        cwd: reference, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
        env: { ...process.env, LANE_POOL_ROOT: pool, PATH: `${bin}:${process.env.PATH}` },
      });
      if (refresh.error || refresh.status !== 0 || !refresh.stderr?.includes(`stale-but-${kind}`)
          || readFileSync(marker, 'utf8') !== bytes) violations.push(`${kind}: forced refresh did not retain the stale lease`);
      if (kind === 'dirty' && readFileSync(join(lane, 'work'), 'utf8') !== 'uncommitted work') {
        violations.push('dirty: forced refresh lost uncommitted bytes');
      }
    }
    // The reaper's read-only planning path runs before release scrubs lane config.
    // A real clean filter must never run, even when it would only report dirtiness.
    const filterConfig = join(base, 'filters.config');
    writeFileSync(filterConfig, '[filter "redteam"]\n\tclean = "printf executed > filter-executed; cat"\n');
    git(['-C', lane, 'config', 'include.path', filterConfig]);
    writeFileSync(join(lane, '.git', 'info', 'attributes'), 'file filter=redteam\n');
    writeFileSync(join(lane, 'file'), 'modified tracked content');
    const runFilterProbe = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { applyReclaimSafety, laneQuietSincePr } = await import(process.argv[1]);
      const candidate = { dir: process.argv[2], lease: {
        acquiredAt: '2020-01-01T00:00:00.000Z', ttlMinutes: 240, pid: 2147483646,
      }, reason: 'pr-merged' };
      const quiet = laneQuietSincePr(candidate.dir, {
        prMergeSha: 'a'.repeat(40), prMergedAt: candidate.lease.acquiredAt,
        leaseAcquiredAt: candidate.lease.acquiredAt, nowMs: Date.now(),
      });
      console.log(JSON.stringify({ quiet, plan: applyReclaimSafety({ reap: [candidate], keep: [] }) }));
    `, pathToFileURL(join(root, 'scripts/conveyor/lease-reaper.mjs')).href, lane], {
      cwd: reference, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
    });
    const filterProbe = runFilterProbe();
    if (existsSync(join(lane, 'filter-executed'))) violations.push('filter: reclaim safety executed a lane clean driver');
    if (filterProbe.error || filterProbe.status !== 0) violations.push('filter: reaper planning probe failed');
    else {
      const { quiet, plan } = JSON.parse(filterProbe.stdout);
      if (quiet !== null || plan.reap.length || plan.keep[0]?.reason !== 'stale-but-dirty') {
        violations.push('filter: lane-defined driver did not refuse reclamation');
      }
    }
    // Parent config is now clean, but a nested repository can define its own driver.
    git(['-C', lane, 'config', '--unset-all', 'include.path']);
    git(['-C', lane, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', reference, 'nested']);
    const nested = join(lane, 'nested');
    git(['-C', nested, 'config', 'filter.redteam.clean', 'printf executed > filter-executed; cat']);
    writeFileSync(join(nested, '.gitattributes'), 'file filter=redteam\n');
    writeFileSync(join(nested, 'file'), 'modified nested content');
    const nestedProbe = runFilterProbe();
    if (existsSync(join(nested, 'filter-executed'))) violations.push('submodule: reclaim safety executed a nested clean driver');
    if (nestedProbe.error || nestedProbe.status !== 0) violations.push('submodule: reaper planning probe failed');
    else {
      const { quiet, plan } = JSON.parse(nestedProbe.stdout);
      if (quiet !== null || plan.reap.length || plan.keep[0]?.reason !== 'stale-but-dirty') {
        violations.push('submodule: nested filter inspection did not refuse reclamation');
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
