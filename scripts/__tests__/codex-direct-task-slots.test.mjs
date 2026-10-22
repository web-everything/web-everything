import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../codex-direct-task.mjs';
import { acquireSlot, listSlots } from '../lib/builder-slots.mjs';
import { BUILDER_SLOT_DEFAULTS as settings } from '../lib/builder-slots-settings.mjs';
let root, slotOptions, oldArgv, oldExit;
beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'codex-slots-')); let time = 10000;
  slotOptions = { root, settings, now: () => time, sleep: async ms => { time += ms; }, isPidAlive: () => true };
  oldArgv = process.argv; oldExit = process.exitCode;
  process.argv = ['node', 'test', '--task=test', '--dir=.', '--json', '--wait-ms=1'];
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('WE_BUILDER_SLOT_HELD', '');
});
afterEach(() => { process.argv = oldArgv; process.exitCode = oldExit; vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('exits 75 without running Codex when four external slots remain live', async () => {
  for (let i = 0; i < 4; i++) await acquireSlot({ ...slotOptions, class: 'codex' });
  const runner = vi.fn(); await main({ slotOptions, runner });
  expect(process.exitCode).toBe(75); expect(runner).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('within 1ms (cap 4'));
});
it.each([false, true])('holds during the runner and releases after success/failure=%s', async failure => {
  const exits = process.listenerCount('exit'), signals = process.listenerCount('SIGTERM');
  const runner = vi.fn(async () => {
    expect(listSlots(slotOptions)).toHaveLength(1);
    if (failure) throw new Error('fixture');
    return { exitCode: 0, timedOut: false, gate: { pass: true } };
  });
  await main({ slotOptions, runner });
  expect(runner).toHaveBeenCalledOnce(); expect(listSlots(slotOptions)).toEqual([]);
  expect(process.exitCode).toBe(failure ? 1 : 0);
  expect(process.listenerCount('exit')).toBe(exits); expect(process.listenerCount('SIGTERM')).toBe(signals);
});
it.each(['off', 'held'])('preserves untracked launches with switch %s', async mode => {
  if (mode === 'off') slotOptions.settings = { ...settings, enabled: false };
  else vi.stubEnv('WE_BUILDER_SLOT_HELD', 'yes');
  const runner = vi.fn(async () => { expect(listSlots(slotOptions)).toEqual([]); return { exitCode: 0, gate: { pass: true } }; });
  await main({ slotOptions, runner }); expect(runner).toHaveBeenCalledOnce();
});

it.each(['SIGINT', 'SIGTERM', 'exit'])('releases on %s and restores default signal handling', async event => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const runner = vi.fn(async () => {
    expect(listSlots(slotOptions)).toHaveLength(1);
    process.listeners(event).at(-1)();
    expect(listSlots(slotOptions)).toEqual([]);
    if (event !== 'exit') expect(kill).toHaveBeenCalledWith(process.pid, event);
    return { exitCode: 0, gate: { pass: true } };
  });
  await main({ slotOptions, runner });
  expect(runner).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(0);
});
it('heartbeats a running foreground task every third of its TTL', async () => {
  let at = 10000; slotOptions.now = () => at;
  await main({ slotOptions, runner: async () => {
    at += settings.ttlMs / 3;
    await vi.advanceTimersByTimeAsync(settings.ttlMs / 3);
    expect(listSlots(slotOptions)[0].heartbeatAt).toBe(at);
    return { exitCode: 0, gate: { pass: true } };
  } });
  expect(listSlots(slotOptions)).toEqual([]);
  expect(process.exitCode).toBe(0);
});
