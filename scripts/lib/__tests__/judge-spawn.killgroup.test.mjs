import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { judgeSpawn, JudgeTimeoutError } from '../judge-spawn.mjs';

const request = { mandate: 'review', input: 'diff', shape: { type: 'object' }, retries: 0 };

it('falls back to child.kill when the process group cannot be signalled', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
  const child = new EventEmitter();
  child.pid = 987654321;
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); });
  try {
    await expect(judgeSpawn({ ...request, timeoutMs: 5, spawnFn: () => child }))
      .rejects.toBeInstanceOf(JudgeTimeoutError);
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  } finally { kill.mockRestore(); }
});

describe.skipIf(process.platform === 'win32')('real juror process group cleanup', () => {
  it('kills the juror and its running grandchild on timeout', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'judge-group-'));
    const cli = join(dir, 'fake-cli');
    const pidFile = join(dir, 'grandchild.pid');
    let pid;
    let child;
    let descendantsClosed;
    let exited;
    let deadline;
    const spawnFn = (command, argv, options) => {
      expect(options.detached).toBe(true);
      child = spawn(command, argv, { ...options, stdio: [...options.stdio, 'pipe'] });
      descendantsClosed = once(child.stdio[3], 'close');
      exited = once(child, 'exit');
      return child;
    };
    try {
      writeFileSync(cli, `#!${process.execPath}\n` +
        `const {spawn} = require('node:child_process');\n` +
        `const {writeFileSync} = require('node:fs');\n` +
        `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(), 30000)'], {stdio: ['ignore', 'ignore', 'ignore', 3]});\n` + // keepalive-helper-ok: grandchild killed by timeout and finally, with a hard lifetime bound
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
        `setInterval(() => {}, 1000); setTimeout(() => process.exit(), 30000);\n`, // keepalive-helper-ok: fake juror killed by timeout and finally, with a hard lifetime bound
        { mode: 0o755 });
      const outcome = await judgeSpawn({ ...request, cli, spawnFn, timeoutMs: 1500, log: () => {} }).catch(e => e);
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(outcome).toBeInstanceOf(JudgeTimeoutError);
      expect(await exited).toEqual([null, 'SIGKILL']);
      // Both processes inherit fd 3. Its closure proves the grandchild died too,
      // without mistaking an unreaped zombie for a still-running process.
      await Promise.race([
        descendantsClosed,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('grandchild survived the timeout')), 2000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      if (!pid) { try { pid = Number(readFileSync(pidFile, 'utf8')); } catch {} }
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
});
