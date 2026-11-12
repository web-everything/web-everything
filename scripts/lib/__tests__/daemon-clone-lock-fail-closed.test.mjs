/** Unknown reader state must never be mistaken for an empty working tree. */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRead, acquireWrite, releaseWrite, cloneLockDirs, inspectCloneLock } from '../daemon-clone-lock.mjs';
let scratch, root, lockRoot, t, opts;
const T = 1_800_000_000_000;
beforeEach(() => {
  scratch = fs.mkdtempSync(join(tmpdir(), 'clone-reader-closed-'));
  root = join(scratch, 'clone'); fs.mkdirSync(root);
  lockRoot = join(scratch, 'locks'); t = T;
  opts = { lockRoot, owner: 'writer', probe: () => 'alive', readerPriorityAfter: 0, writerPriorityAfter: 0,
    now: () => t, sleep: async (ms) => { t += ms; }, waitMs: 2, pollMs: 1 };
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(scratch, { recursive: true, force: true }); });
const write = (extra = {}) => acquireWrite(root, { ...opts, ...extra });
const readers = () => cloneLockDirs(root, lockRoot).readersRoot;
function brokenDir() {
  const dir = join(readers(), 'unreadable'); fs.mkdirSync(dir, { recursive: true }); return dir;
}
describe('clone writer drain fails closed on unknown readers', () => {
  it('ENOENT readers root means no readers and allows a writer', async () => {
    expect(fs.existsSync(readers())).toBe(false);
    expect(await write()).toEqual({ ok: true });
    releaseWrite(root, opts);
  });
  it.each(['EACCES', 'EIO'])('readdir %s is a blocker even if a probe would report dead', async (code) => {
    const actual = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation((path, ...args) => {
      if (String(path) === readers()) throw Object.assign(new Error(code), { code });
      return actual(path, ...args);
    });
    const result = await write({ probe: () => 'dead', ignoreOwners: ['<unreadable-readers>'] });
    expect(result).toMatchObject({ ok: false, reason: 'tick-in-progress', heldBy: '<unreadable-readers>' });
    expect(inspectCloneLock(root, { lockRoot }).readers).toMatchObject([{ unreadable: true, live: true }]);
  });
  it('an existing reader directory with missing lock.json blocks until the directory is gone', async () => {
    const dir = brokenDir();
    expect(await write()).toMatchObject({ ok: false, reason: 'tick-in-progress' });
    fs.rmSync(dir, { recursive: true });
    expect(await write()).toEqual({ ok: true }); releaseWrite(root, opts);
  });
  it.each(['{broken', '{}', '{"owner":"reader","heartbeatAt":"invalid"}'])('corrupt lock.json %s is a blocker', async (text) => {
    fs.writeFileSync(join(brokenDir(), 'lock.json'), text);
    expect(await write()).toMatchObject({ ok: false, reason: 'tick-in-progress' });
    expect(inspectCloneLock(root, { lockRoot }).writerLive).toBe(false);
  });
  it('unreadable lock.json is a blocker', async () => {
    fs.mkdirSync(join(brokenDir(), 'lock.json')); // EISDIR, independent of uid or filesystem permission policy.
    expect(await write()).toMatchObject({ ok: false, reason: 'tick-in-progress' });
  });
  it('a reader directory that disappears during lock.json read is provably absent', async () => {
    const dir = brokenDir();
    const actual = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) => {
      if (String(path) === join(dir, 'lock.json')) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }
      return actual(path, ...args);
    });
    expect(await write()).toEqual({ ok: true }); releaseWrite(root, opts);
  });
  it.each(['dead', 'expired'])('a valid reader record can be reclaimed when provably %s', async (proof) => {
    expect(acquireRead(root, { lockRoot, owner: 'reader', nowMs: T, probe: () => 'alive' }).ok).toBe(true);
    if (proof === 'expired') t += 61_000;
    expect(await write({ leaseMinutes: 1, probe: (entry) => proof === 'dead' && entry?.owner === 'reader' ? 'dead' : 'alive' }))
      .toEqual({ ok: true });
    expect(inspectCloneLock(root, { lockRoot }).readers).toEqual([]);
    releaseWrite(root, opts);
  });
});
