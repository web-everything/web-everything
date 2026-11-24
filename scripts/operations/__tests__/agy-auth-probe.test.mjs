import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { classifyAgyProbe, reduceAuthState, agyAuthOff, runProbe, fileCard } from '../agy-auth-probe.mjs';
import { selectProvider } from '../../lib/provider-routing.mjs';
const dirs = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const on = { state: 'on', goodStreak: 2, lastProbeAt: 1000, outageId: null };
const reply = (stdout = 'ok', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode });
async function fixture() {
  const dir = await mkdtemp(join(process.env.TMPDIR, 'agy-auth-')); dirs.push(dir);
  const statePath = join(dir, 'state.json'), lockDir = join(dir, 'lock');
  const spawn = vi.fn(() => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = vi.fn(); queueMicrotask(() => { child.stdout.emit('data', 'ok'); child.emit('close', 0); });
    return child;
  });
  return { statePath, lockDir, spawn, now: () => 1000, fileCard: vi.fn() };
}
it('a signed-out probe marks agy unavailable and the router skips it', () => {
  const record = reduceAuthState(on, classifyAgyProbe(reply('Authentication required')), 1001);
  expect(agyAuthOff(record, 1001, 100)).toBe(true);
  const route = selectProvider({ taskType: 'doc-fix' }, { agyAuth: record, now: 1001 });
  expect(route.alternateBackend).toBeNull(); expect(route.agyAlternateResult).toBe('auth-off');
});
it('an unreadable probe result counts as unavailable, not available', () => {
  expect(classifyAgyProbe(reply('%%%garbage'))).toBe('unreadable');
  expect(agyAuthOff(reduceAuthState(on, 'unreadable', 1001), 1001, 100)).toBe(true);
});
it.each([
  [reply(), 'signed-in'], [reply('Hello from agy!'), 'signed-in'], [reply('', 1, 'Authentication required'), 'signed-out'],
  [reply('https://accounts.google.com/o/oauth2/auth?secret=x'), 'signed-out'],
  [{ timedOut: true }, 'signed-out'], [reply(''), 'unreadable'], [reply('ok', 1), 'unreadable'],
  [reply('garbage'), 'unreadable'],
])('classifies probe fixture %j', (input, expected) => expect(classifyAgyProbe(input)).toBe(expected));
it('stale and malformed state fail closed', () => {
  for (const record of [null, '{', {}, { state: 'on' }, { ...on, lastProbeAt: 'bad' }, on])
    expect(agyAuthOff(record, 1201, 100)).toBe(true);
  expect(agyAuthOff(on, 1200, 100)).toBe(false);
});
it('requires 2-good-probes flapping guard and resets on failure', () => {
  const off = reduceAuthState(on, 'signed-out', 1001);
  const first = reduceAuthState(off, 'signed-in', 1002);
  expect(first).toMatchObject({ state: 'off', goodStreak: 1, outageId: off.outageId, cardNeeded: false });
  expect(reduceAuthState(first, 'signed-in', 1003)).toMatchObject({ state: 'on', outageId: null });
  expect(reduceAuthState(first, 'unreadable', 1003).goodStreak).toBe(0);
});
it('one action card per outage', async () => {
  const f = await fixture(); f.spawn.mockImplementation(() => { throw new Error('secret URL'); });
  await writeFile(f.statePath, JSON.stringify(on));
  await runProbe(f); await runProbe(f);
  expect(f.fileCard).toHaveBeenCalledTimes(1);
  expect(f.fileCard.mock.calls[0][0].title).toBe('agy signed out: sign in to agy on the Studio');
  f.spawn.mockReset().mockImplementation((await fixture()).spawn);
  await runProbe(f); await runProbe(f);
  f.spawn.mockImplementation(() => { throw new Error('unavailable'); }); await runProbe(f);
  expect(f.fileCard).toHaveBeenCalledTimes(2);
});
it('lock held skips without probing or changing previous state', async () => {
  const f = await fixture(); await writeFile(f.statePath, JSON.stringify(on)); await mkdir(f.lockDir);
  expect(await runProbe(f)).toMatchObject({ skipped: true }); expect(f.spawn).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.statePath, 'utf8'))).toEqual(on);
});
it('runs with ignored stdin, bounded output, and persists probe state', async () => {
  const f = await fixture(); await runProbe(f);
  expect(f.spawn).toHaveBeenCalledWith('agy', ['-p', 'reply with the single word ok', '--print-timeout', '30s'], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
  expect(JSON.parse(await readFile(f.statePath, 'utf8'))).toMatchObject({ lastProbeAt: 1000 });
});
it('hard timeout kills the probe and marks it off', async () => {
  vi.useFakeTimers(); const f = await fixture(); const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn();
  f.spawn.mockReturnValue(child); const pending = runProbe(f);
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled()); await vi.advanceTimersByTimeAsync(45000);
  expect(await pending).toMatchObject({ state: 'off' }); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});
it('oversized output fails closed with one operator card', async () => {
  const f = await fixture(); f.spawn.mockImplementation(() => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = vi.fn();
    queueMicrotask(() => c.stdout.emit('data', 'x'.repeat(65537))); return c;
  });
  expect(await runProbe(f)).toMatchObject({ state: 'off' }); expect(f.fileCard).toHaveBeenCalledTimes(1);
});
it('retries a failed card publication without losing the outage', async () => {
  const f = await fixture(); f.spawn.mockImplementation(() => { throw new Error('unavailable'); });
  f.fileCard.mockRejectedValueOnce(new Error('filing unavailable'));
  await expect(runProbe(f)).rejects.toThrow('filing unavailable');
  const previous = JSON.parse(await readFile(f.statePath, 'utf8'));
  expect(previous).toMatchObject({ state: 'off', cardNeeded: true });
  expect(await runProbe(f)).toMatchObject({ outageId: previous.outageId, cardNeeded: false });
  expect(f.fileCard).toHaveBeenCalledTimes(2);
});
it('files through file-item with a distinct outage reason and no captured agy output', async () => {
  const f = await fixture(); const exec = vi.fn();
  f.spawn.mockImplementation(() => { throw new Error('secret-token'); });
  await runProbe(f);
  fileCard(f.fileCard.mock.calls[0][0], exec);
  expect(exec).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([
    'scripts/operations/run.mjs', 'file-item', '--kind=task', '--queue=false',
    '--notDuplicateReason=New authentication outage 1000; a previous sign-in action does not resolve this outage.',
  ]), expect.objectContaining({ stdio: 'ignore', timeout: 45000, maxBuffer: 65536 }));
  expect(JSON.stringify(exec.mock.calls)).not.toContain('secret-token');
});
