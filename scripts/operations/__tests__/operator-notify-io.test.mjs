/** @file Filesystem and queue subprocess boundaries, with no real gh or desktop delivery. */
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, readQueue, DEFAULT_STATE_PATH, notifyDesktopChecked } from '../operator-notify-io.mjs';
import { notifyDesktopChecked as sharedNotifier } from '../../conveyor/branch-sync.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { main } from '../operator-notify-cli.mjs';
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'notify-io-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it('uses the external default and reuses checked desktop delivery', () => {
  expect(DEFAULT_STATE_PATH).toBe(process.env.OPERATOR_NOTIFY_STATE || join(homedir(), 'workspace/.operations/operator-notify-state.json'));
  expect(notifyDesktopChecked).toBe(sharedNotifier);
});
it('reads missing state and atomically replaces nested state without temp remnants', () => {
  const path = join(dir, 'nested/state.json');
  expect(readState(path)).toEqual({ notified: {} });
  writeState(path, { notified: { x: { title: 'one' } } });
  writeState(path, { notified: {} });
  expect(readState(path)).toEqual({ notified: {} });
  expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json']);
});
it('refuses corrupt state before notifying, including via CLI', async () => {
  const path = join(dir, 'state.json'); writeFileSync(path, '{broken');
  expect(() => readState(path)).toThrow();
  const notify = vi.fn(), stderr = vi.fn(), stdout = vi.fn();
  expect(await main([`--state=${path}`, '--once'], { readQueue: () => ({ ready: [{ repo: 'x/y', number: 1, title: 'x' }] }), notify, stderr, stdout })).toBe(1);
  expect(stderr).toHaveBeenCalled(); expect(stdout).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
});
it('invokes the authoritative queue with bounded synchronous node and parses JSON', () => {
  const report = { ready: [], pending: [], notReady: [], errors: ['fetch failed'] };
  const spawnSyncFn = vi.fn(() => ({ status: 0, stdout: JSON.stringify(report) }));
  expect(readQueue({ spawnSyncFn })).toEqual(report);
  expect(spawnSyncFn).toHaveBeenCalledWith(process.execPath, [expect.stringMatching(/\/operations\/operator-queue\.mjs$/), '--json'], expect.objectContaining({ timeout: 120000, encoding: 'utf8' }));
});
it.each([
  { status: 1, stderr: 'fetch failed' },
  { status: null, error: Error('ETIMEDOUT'), stderr: 'fetch failed' },
  { status: 0, stdout: 'not json', stderr: 'fetch failed' },
])('surfaces queue failures with stderr: %j', (result) => {
  expect(() => readQueue({ spawnSyncFn: () => result })).toThrow(/fetch failed/);
});
it('prints parseable JSON and ignores runner repo scoping', async () => {
  const stdout = vi.fn(), stderr = vi.fn(), notify = vi.fn(() => ({ ok: true }));
  const readQueue = vi.fn(() => ({ ready: [] }));
  expect(await main(['--once', '--json', '--repo=ignored', `--state=${join(dir, 'state')}`], { readQueue, notify, stdout, stderr })).toBe(0);
  expect(JSON.parse(stdout.mock.calls[0][0])).toEqual({ notified: [], failed: [], queueErrors: [], exitCode: 0 });
  expect(readQueue).toHaveBeenCalledWith(); expect(stderr).not.toHaveBeenCalled();
});

it('persists delivery state outside a real checkout without dirtying it', async () => {
  await withRealRepo(async ({ tmp, git }) => {
    const path = join(tmp, '.operations/operator-notify-state.json');
    const notify = vi.fn(() => ({ ok: true }));
    const dependencies = {
      readQueue: () => ({ ready: [{ repo: 'x/y', number: 1, title: 'ready' }], errors: [] }),
      notify, stdout: vi.fn(), stderr: vi.fn(),
    };
    expect(await main(['--once', `--state=${path}`], dependencies)).toBe(0);
    expect(readState(path).notified['x/y#1'].title).toBe('ready');
    expect(await main(['--once', `--state=${path}`], dependencies)).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(git(['status', '--porcelain'])).toBe('');
  });
});

it('keeps the ready rows of a partial queue read: exit 1 with incomplete JSON is not a total failure', () => {
  const report = { ready: [{ repo: 'x/y', number: 1, title: 'ready' }], errors: ['x/z: 404'], incomplete: true };
  const spawnSyncFn = vi.fn(() => ({ status: 1, stdout: JSON.stringify(report), stderr: 'ERROR x/z: 404' }));
  expect(readQueue({ spawnSyncFn })).toEqual(report);
});
it.each([
  { status: 1, stdout: JSON.stringify({ ready: [], errors: [] }), stderr: 'boom' },
  { status: 1, stdout: 'not json', stderr: 'boom' },
  { status: 2, stdout: JSON.stringify({ ready: [], incomplete: false }), stderr: 'boom' },
  { status: null, error: Error('ETIMEDOUT'), stdout: JSON.stringify({ ready: [], incomplete: true }), stderr: 'boom' },
])('still throws on a non-zero exit without incomplete:true JSON: %j', (result) => {
  expect(() => readQueue({ spawnSyncFn: () => result })).toThrow(/boom|ETIMEDOUT/);
});
