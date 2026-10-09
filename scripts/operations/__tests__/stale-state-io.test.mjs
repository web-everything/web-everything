import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBareOrigin } from './helpers/real-repo.mjs';
import { createStaleStateReader } from '../stale-state-io.mjs';
import { createFileRunStore, newRunRecord } from '../run-store.mjs';
import { LEASE_FILENAME } from '../../lib/lane-lease.mjs';

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function snapshot(root) {
  const out = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else out[path] = { bytes: readFileSync(path).toString('base64'), mtime: statSync(path).mtimeMs };
    }
  }
  visit(root);
  return out;
}

it('retains real corrupt/unreadable lease files alongside normal leases; real CLI writes no state or telemetry', async () => {
  await withBareOrigin(async ({ tmp, clone, origin, git }) => {
    const pool = join(tmp, 'pools');
    const lane = join(pool, 'web-everything', 'lane-1');
    mkdirSync(join(pool, 'web-everything'), { recursive: true });
    git(['clone', '--quiet', origin, lane]);
    writeFileSync(join(lane, '.git', LEASE_FILENAME), JSON.stringify({
      session: 'fixture-owner', pid: process.pid, agentPid: process.pid, acquiredAt: '2026-09-15T00:00:00Z',
    }));
    const corruptLane = join(pool, 'web-everything', 'lane-2');
    const unreadableLane = join(pool, 'web-everything', 'lane-3');
    const emptyLane = join(pool, 'web-everything', 'lane-4');
    for (const path of [corruptLane, unreadableLane, emptyLane]) git(['clone', '--quiet', origin, path]);
    writeFileSync(join(corruptLane, '.git', LEASE_FILENAME), '{broken');
    // A directory at the marker path causes a real read error, even when tests run as root.
    mkdirSync(join(unreadableLane, '.git', LEASE_FILENAME));
    mkdirSync(join(clone, 'backlog'));
    writeFileSync(join(clone, 'backlog', '123-active.md'), '---\nstatus: active\nscaffoldedBy: fixture-person\ndateScaffolded: 2026-09-14\n---\n');
    symlinkSync(scripts, join(clone, 'scripts'));
    const runDir = join(tmp, 'runs');
    const runStore = createFileRunStore(runDir);
    runStore.write(newRunRecord({ id: 'existing-run', op: 'claim' }));
    writeFileSync(join(runDir, 'broken-run.json'), '{broken');
    const callsDir = join(tmp, 'calls');
    const before = snapshot(tmp);
    const readState = createStaleStateReader({ root: clone, runStore,
      run: (bin, argv, opts) => execFileSync(bin, argv, { ...opts, env: { ...opts.env, LANE_POOL_ROOT: pool } }),
    });
    const result = readState();
    expect(result.records.find((r) => r.kind === 'claim')).toMatchObject({ owner: 'fixture-person', pidAlive: null, hasUnsafeWork: null });
    expect(result.records.find((r) => r.kind === 'lane-lease')).toMatchObject({ ownerPidAlive: true, hasUnsafeWork: false });
    expect(result.records.filter((r) => r.kind === 'lane-lease')).toHaveLength(3);
    for (const path of [corruptLane, unreadableLane]) {
      expect(result.records.find((r) => r.id === path)).toMatchObject({
        kind: 'lane-lease', ownerPidAlive: null, readError: expect.any(String), lane: { path },
      });
    }
    expect(result.records.filter((r) => r.kind === 'session-run')).toHaveLength(2);
    expect(result.gaps.some((g) => g.includes('enumeration failed'))).toBe(false);
    const stdout = execFileSync(process.execPath, [resolve(scripts, 'operations/run.mjs'), 'stale-state', '--json'], {
      cwd: clone, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      // WE_DAEMON_MANAGED_CLONE exempts the runner-freshness check, which would otherwise read origin/main of the real
      // checkout that owns the symlinked scripts (hermetic tests forbid it; freshness is not what this test proves).
      env: { ...process.env, LANE_POOL_ROOT: pool, OPERATION_RUNS_DIR: runDir, OPERATION_CALLS_DIR: callsDir, WE_DAEMON_MANAGED_CLONE: '1' },
    });
    const report = JSON.parse(stdout).verdict;
    expect(report.records.find((r) => r.kind === 'lane-lease')).toMatchObject({ verdict: 'live', hasUnsafeWork: false });
    expect(report.records.filter((r) => r.kind === 'lane-lease')).toHaveLength(3);
    for (const path of [corruptLane, unreadableLane]) {
      expect(report.records.find((r) => r.id === path)).toMatchObject({
        kind: 'lane-lease', verdict: 'unknown', ownerPidAlive: null, readError: expect.stringMatching(/\S/),
      });
    }
    expect(report.records.find((r) => r.id === 'broken-run')).toMatchObject({ verdict: 'unknown' });
    expect(snapshot(tmp)).toEqual(before);
  });
}, 30000);
