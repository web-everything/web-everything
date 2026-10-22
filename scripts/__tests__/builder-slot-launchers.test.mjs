import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main as codexMain } from '../codex-direct-task.mjs';
import { main as geminiMain } from '../gemini-direct-task.mjs';
import { main as slotMain } from '../operations/agent-slot.mjs';
import { startBuilderLease } from '../lib/builder-slot-lease.mjs';
import { acquireSlot, listSlots } from '../lib/builder-slots.mjs';
import { BUILDER_SLOT_DEFAULTS as settings } from '../lib/builder-slots-settings.mjs';
let root, slotOptions, originalArgv;
beforeEach(() => {
  originalArgv = process.argv;
  root = mkdtempSync(join(tmpdir(), 'builder-launchers-'));
  slotOptions = { root, settings, inFlightRows: async () => [], waitMs: 0 };
  vi.stubEnv('WE_BUILDER_SLOT_HELD', '');
  vi.stubEnv('WE_BUILDER_SLOTS', 'on');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
});
afterEach(() => {
  process.argv = originalArgv;
  vi.useRealTimers();
  vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
});
const invokeCodex = runner => {
  process.argv = [process.execPath, resolve('scripts/codex-direct-task.mjs'), '--task=test', '--wait-ms=0', '--json'];
  return codexMain({ runner, slotOptions });
};
it.each(['codex', 'gemini'])('%s refuses unreadable slots with 75 without running a worker', async kind => {
  writeFileSync(join(root, 'bad.json'), '{');
  const runner = vi.fn();
  if (kind === 'codex') await invokeCodex(runner);
  else await geminiMain(['--task=test', '--wait-ms=0'], { taskFn: runner, slotOptions });
  expect(process.exitCode).toBe(75);
  expect(runner).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('builder slot store unreadable:'));
});
it.each(['codex', 'gemini'])('%s refuses a full daemon pool with 75 without running a worker', async kind => {
  slotOptions.inFlightRows = async () => Array.from({ length: 4 }, (_, num) => ({ num: String(num), executor: 'antigravity' }));
  const runner = vi.fn();
  if (kind === 'codex') await invokeCodex(runner);
  else await geminiMain(['--task=test', '--wait-ms=0'], { taskFn: runner, slotOptions });
  expect(process.exitCode).toBe(75); expect(runner).not.toHaveBeenCalled();
});
it('agent-slot returns 75 and names unreadable evidence', async () => {
  writeFileSync(join(root, 'bad.json'), '{}');
  expect(await slotMain(['acquire', '--class=codex', '--purpose=test'], slotOptions)).toBe(75);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('agent-slot: builder slot store unreadable:'));
});
it.each(['codex', 'gemini'])('%s releases the slot even when the worker throws', async kind => {
  const runner = vi.fn(async () => {
    expect(listSlots({ root })).toMatchObject([{ class: kind === 'codex' ? 'codex' : 'antigravity' }]);
    throw new Error('worker failed');
  });
  if (kind === 'codex') await invokeCodex(runner);
  else await expect(geminiMain(['--task=test', '--wait-ms=0'], { taskFn: runner, slotOptions })).rejects.toThrow('worker failed');
  expect(runner).toHaveBeenCalledOnce();
  expect(listSlots({ root })).toEqual([]);
});
it('gemini releases after a completed run', async () => {
  const report = { exitCode: 0, timedOut: false, events: { terminal: 'SUCCESS', toolErrors: [] }, gate: { pass: true } };
  await geminiMain(['--task=test', '--json'], { slotOptions, taskFn: async () => report });
  expect(listSlots({ root })).toEqual([]);
  expect(process.exitCode).toBe(0);
});
it.each(['codex', 'gemini'])('%s skips all slot IO with the switch off or a parent lease', async kind => {
  writeFileSync(join(root, 'bad.json'), '{}');
  slotOptions.inFlightRows = () => { throw new Error('must not read'); };
  for (const parent of [false, true]) {
    slotOptions.settings = { ...settings, enabled: parent };
    vi.stubEnv('WE_BUILDER_SLOT_HELD', parent ? 'parent' : '');
    const runner = vi.fn(async () => { throw new Error('reached worker'); });
    if (kind === 'codex') await invokeCodex(runner);
    else await expect(geminiMain(['--task=test'], { taskFn: runner, slotOptions })).rejects.toThrow('reached worker');
    expect(runner).toHaveBeenCalledOnce();
  }
});
it.each(['scripts/operations/agent-slot.mjs', 'scripts/codex-direct-task.mjs', 'scripts/gemini-direct-task.mjs'])('real CLI %s refuses corrupt evidence with exit 75', script => {
  writeFileSync(join(root, 'bad.json'), '{');
  const args = script.includes('agent-slot') ? ['acquire', '--class=codex', '--purpose=test'] : ['--task=test', '--wait-ms=0'];
  const result = spawnSync(process.execPath, [resolve(script), ...args], { encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WE_BUILDER_SLOTS: 'on', WE_BUILDER_SLOT_HELD: '', WE_BUILDER_SLOTS_ROOT: root } });
  expect(result.status).toBe(75);
  expect(result.stderr).toContain('builder slot store unreadable:');
});
it('a cold daemon import has no CLI output or slot writes', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./skills-src/conveyor/build-dispatch-daemon.mjs')"], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, WE_BUILDER_SLOTS_ROOT: root },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(''); expect(result.stderr.replace(/^.*(?:punycode|trace-deprecation).*\n?/gm, '')).toBe('');
  expect(listSlots({ root })).toEqual([]);
});
it('slot-only fallback still charges Antigravity to external', async () => {
  for (let i = 0; i < 4; i++) expect((await acquireSlot({ ...slotOptions, class: 'antigravity' })).ok).toBe(true);
  expect(await acquireSlot({ ...slotOptions, class: 'codex' })).toMatchObject({ ok: false, reason: 'full' });
});

it('heartbeats the foreground lease and removes the timer/listeners on close', async () => {
  vi.useFakeTimers();
  const exits = process.listenerCount('exit'), interrupts = process.listenerCount('SIGINT');
  const lease = await startBuilderLease({ ...slotOptions, class: 'codex', settings: { ...settings, ttlMs: 3000 } });
  try {
    expect(lease.ok).toBe(true);
    const started = listSlots({ root })[0].heartbeatAt;
    await vi.advanceTimersByTimeAsync(1000);
    expect(listSlots({ root })[0].heartbeatAt).toBe(started + 1000);
  } finally { lease.close(); }
  lease.close();
  expect(listSlots({ root })).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  expect(process.listenerCount('exit')).toBe(exits);
  expect(process.listenerCount('SIGINT')).toBe(interrupts);
});

it.each(['SIGINT', 'SIGTERM'])('%s stops the tracked process group, waits for close, releases, then re-raises', async signal => {
  vi.useFakeTimers();
  const signalProcess = new EventEmitter(); signalProcess.pid = 999;
  const child = new EventEmitter(); child.pid = 123;
  const kill = vi.fn((pid) => {
    // The lease must still be held when termination is requested.
    expect(listSlots({ root })).toHaveLength(pid === 999 ? 0 : 1);
  });
  const lease = await startBuilderLease({ ...slotOptions, class: 'codex', signalProcess, kill });
  lease.track(child);
  const handling = signalProcess.listeners(signal)[0]();
  expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');
  expect(listSlots({ root })).toHaveLength(1);
  lease.close(); // Even another cleanup path cannot free a live child's slot.
  expect(listSlots({ root })).toHaveLength(1);
  child.emit('close', null, signal);
  await handling;
  expect(kill.mock.calls.at(-1)).toEqual([999, signal]);
  expect(vi.getTimerCount()).toBe(0);
});
it('escalates a child that ignores SIGTERM without releasing before close', async () => {
  vi.useFakeTimers();
  const signalProcess = new EventEmitter(); signalProcess.pid = 999;
  const child = new EventEmitter(); child.pid = 123;
  const kill = vi.fn();
  const lease = await startBuilderLease({ ...slotOptions, class: 'codex', signalProcess, kill });
  lease.track(child);
  const handling = signalProcess.listeners('SIGTERM')[0]();
  await vi.advanceTimersByTimeAsync(5000);
  expect(kill).toHaveBeenCalledWith(-123, 'SIGKILL');
  expect(listSlots({ root })).toHaveLength(1);
  child.emit('close'); await handling;
  expect(listSlots({ root })).toEqual([]);
});

it('falls back to terminating the child when it has no process group', async () => {
  const signalProcess = new EventEmitter(); signalProcess.pid = 999;
  const child = new EventEmitter(); child.pid = 123; child.kill = vi.fn();
  const kill = vi.fn(pid => { if (pid < 0) throw Object.assign(new Error('no group'), { code: 'ESRCH' }); });
  const lease = await startBuilderLease({ ...slotOptions, class: 'codex', signalProcess, kill });
  lease.track(child);
  const handling = signalProcess.listeners('SIGINT')[0]();
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(listSlots({ root })).toHaveLength(1);
  child.emit('close'); await handling;
  expect(kill.mock.calls.at(-1)).toEqual([999, 'SIGINT']);
});
