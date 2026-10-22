import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
it('CLI acquires, lists, refuses at cap with 75, and releases idempotently', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-slot-'));
  const run = (...args) => spawnSync(process.execPath, [resolve('scripts/operations/agent-slot.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, WE_COORDINATION_ROOT: join(root, 'coordination'), OPERATION_RUNS_DIR: join(root, 'runs'), WE_BUILDER_SLOTS_ROOT: root, WE_BUILDER_SLOTS: 'on', WE_BUILDER_SLOTS_MAX_CLAUDE: '1' } });
  try {
    const first = run('acquire', '--class=claude', '--purpose=test');
    expect(first.status).toBe(0); expect(first.stdout).toMatch(/^slot [a-f0-9]+\n$/);
    const id = first.stdout.trim().split(' ')[1];
    expect(JSON.parse(run('list', '--json').stdout)).toMatchObject([{ id, class: 'claude' }]);
    expect(run('acquire', '--class=claude', '--purpose=blocked').status).toBe(75);
    expect(run('heartbeat', id).status).toBe(0);
    expect(run('release', id).status).toBe(0); expect(run('release', id).status).toBe(0);
    expect(JSON.parse(run('list', '--json').stdout)).toEqual([]);
    expect(run('--help').stdout).toContain('usage:');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('CLI kill switch prints disabled and touches no slot files', () => {
  const root = join(tmpdir(), `agent-slot-disabled-${process.pid}`);
  const env = { ...process.env, WE_COORDINATION_ROOT: join(root, 'coordination'), OPERATION_RUNS_DIR: join(root, 'runs'), WE_BUILDER_SLOTS_ROOT: root, WE_BUILDER_SLOTS: 'off' };
  const run = (...args) => spawnSync(process.execPath, [resolve('scripts/operations/agent-slot.mjs'), ...args], { encoding: 'utf8', env });
  expect(run('acquire', '--class=codex', '--purpose=test').stdout).toBe('slot disabled\n');
  expect(run('release', 'disabled').status).toBe(0);
  expect(JSON.parse(run('list', '--json').stdout)).toEqual([]);
});
