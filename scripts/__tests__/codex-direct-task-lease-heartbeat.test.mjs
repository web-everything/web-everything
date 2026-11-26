/** @file RS-7179-1: codex-direct-task renews the lane lease while it runs, and stops after (also on throw). */
import { describe, it, expect } from 'vitest';
import { withLaneLeaseHeartbeat } from '../codex-direct-task.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('codex-direct-task CLI lease renewal', () => {
  it('renews both cwd and --dir leases before the stub Codex runs', () => {
    const base = mkdtempSync(join(tmpdir(), 'direct-heartbeat-'));
    const cwd = join(base, 'caller'), dir = join(base, 'task');
    const script = resolve('scripts/codex-direct-task.mjs');
    const initial = { session: 'fixture', ownerSession: 'caller', acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
    for (const target of [cwd, dir]) {
      mkdirSync(join(target, '.git'), { recursive: true });
      writeFileSync(join(target, '.git', '.lane-lease'), JSON.stringify(initial));
    }
    const preload = `import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { EventEmitter } from 'node:events';
      import { readFileSync, writeFileSync } from 'node:fs';
      cp.execFileSync = (_bin, args) => args.includes('--absolute-git-dir') ? ${JSON.stringify(join(dir, '.git'))} : args.includes('rev-parse') ? 'sha' : '';
      const realSpawn = cp.spawn;
      cp.spawn = (bin, args, options) => {
        if (bin === process.execPath) return realSpawn(bin, args, options);
        const renewed = ${JSON.stringify([cwd, dir])}.map(p => JSON.parse(readFileSync(p + '/.git/.lane-lease', 'utf8')).renewedAt || null);
        writeFileSync(${JSON.stringify(join(base, 'observed.json'))}, JSON.stringify(renewed));
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { on() {}, end() { setTimeout(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\\n'));
          child.emit('close', 0);
        }, 0); } };
        child.kill = () => {};
        return child;
      };
      syncBuiltinESMExports();`;
    try {
      const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
        script, '--task=fixture', `--dir=${dir}`, '--json', '--no-stream', '--ephemeral', '--gate=none', '--no-self-review'],
      { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'caller', LANE_SESSION: '', CODEX_JOBS_DIR: join(base, 'jobs'),
          WE_COORDINATION_ROOT: join(base, 'coordination'), WE_CODEX_TRANSCRIPT_CHECK_MODE: 'off' } });
      expect(result.status, result.stderr).toBe(0);
      const renewed = JSON.parse(readFileSync(join(base, 'observed.json'), 'utf8'));
      expect(renewed).toHaveLength(2);
      for (const stamp of renewed) expect(Number.isFinite(Date.parse(stamp))).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('withLaneLeaseHeartbeat', () => {
  it('runs the heartbeat during the task and stops it after', async () => {
    const log = [];
    const out = await withLaneLeaseHeartbeat(['a', 'b'], async () => { log.push('run'); return 7; },
      ({ cwds }) => { log.push(`start:${cwds.join(',')}`); return () => log.push('stop'); });
    expect(out).toBe(7);
    expect(log).toEqual(['start:a,b', 'run', 'stop']);
  });
  it('stops the heartbeat when the task throws', async () => {
    const log = [];
    await expect(withLaneLeaseHeartbeat(['a'], async () => { throw new Error('boom'); }, () => () => log.push('stop'))).rejects.toThrow('boom');
    expect(log).toEqual(['stop']);
  });
  it('refuses to run the task when the heartbeat cannot start', async () => {
    let ran = false;
    await expect(withLaneLeaseHeartbeat(['a'], async () => { ran = true; }, () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(ran).toBe(false);
  });
});

it('does not enter task code when the heartbeat child readiness fails', async () => {
  let ran = false, stopped = false;
  const stop = () => { stopped = true; };
  stop.ready = Promise.reject(new Error('child startup failed'));
  await expect(withLaneLeaseHeartbeat(['lane'], () => { ran = true; }, () => stop)).rejects.toThrow('child startup failed');
  expect(ran).toBe(false);
  expect(stopped).toBe(true);
});
