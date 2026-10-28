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
  it.each(['é.test.mjs\nï¿½.test.mjs', 'é.test.mjs\0ï¿½.test.mjs\0', '𐐀.test.mjs\0'])('preserves UTF-8 inventory bytes across every chunk boundary: %j', async inventory => {
    const bytes = Buffer.from(inventory);
    for (let split = 1; split < bytes.length; split++) {
      const child = capturedChild();
      const pending = defaultExec({ file: 'git', args: ['ls-files', '-z'] });
      child.stdout.emit('data', bytes.subarray(0, split));
      child.stdout.emit('data', bytes.subarray(split));
      child.emit('close', 0);
      await expect(pending, `split at byte ${split}`).resolves.toEqual({ code: 0, stdout: inventory });
    }
  });

  it('does not spawn for an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(defaultExec({ file: 'ssh', args: [], signal: controller.signal })).resolves.toEqual({ mode: 'cancelled', terminated: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['ssh', 'rsync'])('kills %s on abort but waits for close before acknowledging termination', async file => {
    const child = capturedChild();
    const controller = new AbortController();
    let settled = false;
    const pending = defaultExec({ file, args: [], signal: controller.signal }).then(value => { settled = true; return value; });
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('error', new Error('transport interrupted'));
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGKILL');
    expect(await pending).toEqual({ mode: 'cancelled', terminated: true });
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

  it('counts multi-byte stdout against the raw byte limit, not decoded character length', async () => {
    const child = capturedChild();
    const pending = defaultExec({ file: 'git', args: ['ls-files', '-z'] });
    child.stdout.emit('data', Buffer.from('é'.repeat(2 * 1024 * 1024)));
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr.emit('data', Buffer.from('!'));
    child.emit('close', 0);
    await expect(pending).rejects.toThrow('Captured output limit exceeded');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
