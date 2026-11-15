import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), cleanup: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal(), fork: mocks.fork }));
// The scenario's isolation snapshot must not inspect the developer's real state.
vi.mock('node:os', async (importOriginal) => ({ ...await importOriginal(), homedir: () => '/nonexistent-sim-home' }));
vi.mock('./sim/world.mjs', () => ({ createWorld: () => ({
  simCloneRoot: '/sim', env: {}, registerHost() {}, cleanup: mocks.cleanup,
  lanePoolRoot: '/nonexistent-sim-lanes', completionsDir: '/nonexistent-sim-completions',
  repos: {}, claude: { sessions: () => [], calls: () => [] }, gh: { calls: () => [] },
}) }));
import { runScenario } from './sim/scenario.mjs';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function host(onTick) {
  const child = new EventEmitter();
  Object.assign(child, { connected: true, exitCode: null, signalCode: null,
    kill: vi.fn(), send: vi.fn((message, callback) => {
      if (message.type === 'tick') onTick(child, callback);
      else callback?.(null);
    }),
  });
  mocks.fork.mockImplementation(() => {
    queueMicrotask(() => child.emit('message', { type: 'ready' }));
    return child;
  });
  return child;
}

describe('scenario tick IPC failures', () => {
  it('rejects an already exited host before sending another tick', async () => {
    vi.useFakeTimers();
    const child = host(c => c.emit('message', { type: 'result', result: 'ok' }));
    const run = runScenario({ play: ['tick review', () => {
      child.connected = false;
      child.exitCode = 0;
      child.emit('exit', 0);
    }, 'tick review'] }, { timeoutMs: 90_000 });
    const checked = expect(run).rejects.toThrow(/not connected|already exited/);
    await vi.advanceTimersByTimeAsync(90_000);
    await checked;
    expect(child.send.mock.calls.filter(([m]) => m.type === 'tick')).toHaveLength(1);
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it.each(['callback', 'error', 'throw'])('handles a send failure via %s instead of waiting for the tick timeout', async (mode) => {
    vi.useFakeTimers();
    const child = host((c, callback) => {
      const error = new Error('Channel closed');
      if (mode === 'throw') throw error;
      // Node emits an unhandled error when send has no callback; the old harness
      // instead times out here so the red proof itself does not crash Vitest.
      queueMicrotask(() => {
        if (mode === 'callback') callback?.(error);
        else if (c.listenerCount('error')) c.emit('error', error);
      });
    });
    const checked = expect(runScenario({ play: ['tick review'] }, { timeoutMs: 90_000 }))
      .rejects.toThrow('Channel closed');
    await vi.advanceTimersByTimeAsync(90_000);
    await checked;
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('still rejects a connected host that never completes its tick at the existing deadline', async () => {
    vi.useFakeTimers();
    const child = host(() => {});
    const checked = expect(runScenario({ play: ['tick review'] }, { timeoutMs: 90_000 }))
      .rejects.toThrow('tick timed out after 90000ms');
    await vi.advanceTimersByTimeAsync(90_000);
    await checked;
    for (const event of ['message', 'exit', 'error', 'disconnect']) expect(child.listenerCount(event)).toBe(0);
  });

  it('rejects a disconnected host even if it has not emitted exit yet', async () => {
    vi.useFakeTimers();
    host(c => queueMicrotask(() => { c.connected = false; c.emit('disconnect'); }));
    const checked = expect(runScenario({ play: ['tick review'] }, { timeoutMs: 90_000 }))
      .rejects.toThrow(/disconnected/);
    await vi.advanceTimersByTimeAsync(90_000);
    await checked;
  });

  it('retains successful results and clears listeners on completion', async () => {
    const child = host((c, callback) => {
      callback?.(null);
      queueMicrotask(() => c.emit('message', { type: 'result', result: { dispatched: [] } }));
    });
    const result = await runScenario({ play: ['tick review'] });
    expect(result.ticks('review')[0].result).toEqual({ dispatched: [] });
    for (const event of ['message', 'exit', 'error', 'disconnect']) expect(child.listenerCount(event)).toBe(0);
  });
});
