import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexDirectExec } from '../codex-direct-task.mjs';
import { runUnderAdmission, heldSlots, ADMISSION_HELD_ENV } from '../readiness/heavy-admission.mjs';
import { startLaneLeaseHeartbeat } from '../lib/lane-lease-heartbeat.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lease-runners-')); mkdirSync(join(dir, '.git')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it.each(['close', 'error', 'throw'])('Codex keeps the heartbeat until child %s and stops in finally', async outcome => {
  const stop = vi.fn();
  const startHeartbeat = vi.fn(() => ({ stop }));
  const child = new EventEmitter();
  const spawnFn = () => {
    expect(startHeartbeat).toHaveBeenCalledOnce();
    expect(startHeartbeat).toHaveBeenCalledWith({ cwd: dir });
    expect(stop).not.toHaveBeenCalled();
    if (outcome === 'throw') throw Error('spawn failed');
    return child;
  };
  const pending = runCodexDirectExec({ dir, task: 'test', logFile: join(dir, '.git', 'log'),
    spawnFn, startHeartbeat, stream: false, timeoutMs: 0 });
  if (outcome === 'close') {
    expect(stop).not.toHaveBeenCalled();
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ code: 0 });
  } else {
    if (outcome === 'error') child.emit('error', Error('spawn failed'));
    await expect(pending).rejects.toThrow('spawn failed');
  }
  expect(stop).toHaveBeenCalledOnce();
});

it.each([null, 'held'])('heavy command allows periodic renewals during an actual child (bypass=%s)', async bypass => {
  const renew = vi.fn();
  const stop = vi.fn();
  const startHeartbeat = ({ cwd }) => {
    expect(cwd).toBe(dir);
    const heartbeat = startLaneLeaseHeartbeat({ cwd, intervalMs: 10, renew });
    return { stop() { heartbeat.stop(); stop(); } };
  };
  const lockRoot = join(dir, 'admission');
  const result = await runUnderAdmission({ env: { ...process.env, [ADMISSION_HELD_ENV]: '1' }, lockRoot, cap: 1, owner: 'heartbeat-test',
    command: 'sleep 0.15', cwd: dir, bypass, startHeartbeat, log: () => {} });
  expect(result.exitCode).toBe(0);
  expect(renew.mock.calls.length).toBeGreaterThan(1);
  expect(stop).toHaveBeenCalledOnce();
  if (!bypass) expect(heldSlots({ lockRoot, cap: 1 })).toHaveLength(0);
  const count = renew.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(renew).toHaveBeenCalledTimes(count);
});

it.each([null, 'held'])('heavy command stops its heartbeat on failure (bypass=%s)', async bypass => {
  const stop = vi.fn();
  const result = await runUnderAdmission({ env: { ...process.env, [ADMISSION_HELD_ENV]: '1' }, lockRoot: join(dir, 'admission'), cap: 1, owner: 'failure-test',
    command: 'test', cwd: dir, bypass, log: () => {}, startHeartbeat: () => ({ stop }),
    exec: async () => { throw Object.assign(Error('failed'), { status: 7 }); } });
  expect(result.exitCode).toBe(7);
  expect(stop).toHaveBeenCalledOnce();
});
