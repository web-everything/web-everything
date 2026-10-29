// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultExec } from '../remote-exec.mjs';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

beforeEach(() => spawn.mockReset());

function capturedChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  spawn.mockReturnValue(child);
  return child;
}

describe('remote-exec captured output boundary', () => {
  it('preserves multibyte inventory names split across stdout chunks', async () => {
    const child = capturedChild();
    const result = defaultExec({file:'git',args:['ls-files','-z']});
    const inventory = 'fixtures/é😀\u2028.txt\0';
    for (const byte of Buffer.from(inventory)) child.stdout.emit('data',Buffer.from([byte]));
    child.emit('close',0);
    await expect(result).resolves.toEqual({code:0,stdout:inventory});
  });
  it('accepts exactly 4 MiB combined across stdout and stderr without terminating', async () => {
    const child = capturedChild();
    const result = defaultExec({ file: 'ssh', args: ['forge', 'true'] });
    child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024, 'a'));
    child.stderr.emit('data', Buffer.alloc(2 * 1024 * 1024, 'b'));
    child.emit('close', 0);

    await expect(result).resolves.toEqual({ code: 0, stdout: 'a'.repeat(2 * 1024 * 1024) });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['stdout', 'stderr'])('terminates and rejects when combined output exceeds 4 MiB on %s', async (overflowStream) => {
    const child = capturedChild();
    const result = defaultExec({ file: 'ssh', args: ['forge', 'true'] });
    child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024, 'a'));
    child.stderr.emit('data', Buffer.alloc(2 * 1024 * 1024, 'b'));
    expect(child.kill).not.toHaveBeenCalled();

    // Neither individual stream exceeds the bound; the combined byte count does.
    child[overflowStream].emit('data', Buffer.from('!'));
    // Even a success status must not turn an overflow into accepted evidence.
    child.emit('close', 0);

    await expect(result.then(() => undefined)).rejects.toThrow('Captured output limit exceeded');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
