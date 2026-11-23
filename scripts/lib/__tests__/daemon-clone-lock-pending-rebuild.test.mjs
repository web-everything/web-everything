import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { acquireRead, acquireWrite, releaseRead, cloneLockDirs, readPendingRebuild, defaultOwner } from '../daemon-clone-lock.mjs';
import { runCiHealLoopIteration } from '../../conveyor/ci-heal-loop.mjs';

const temps = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR, 'pending-rebuild-'));
  temps.push(root);
  return { root, lockRoot: join(root, 'locks'), nowMs: 1000, probe: () => 'alive' };
}
async function claim(f, owner = 'writer') {
  expect(acquireRead(f.root, { ...f, owner: 'blocker' }).ok).toBe(true);
  expect(await acquireWrite(f.root, { ...f, owner, waitMs: 0, now: () => f.nowMs, writerPriorityAfter: 1 }))
    .toMatchObject({ reason: 'tick-in-progress' });
  releaseRead(f.root, { ...f, owner: 'blocker' });
}

it('returns the first live foreign writer claim without changing it or admitting a reader', async () => {
  const f = fixture();
  await claim(f);
  const file = join(cloneLockDirs(f.root, f.lockRoot).starvedRoot, '..', 'writer-claim.json');
  const before = readFileSync(file, 'utf8');
  expect(readPendingRebuild(f.root, { ...f, owner: 'reader' })).toMatchObject({ owner: 'writer', count: 1 });
  expect(readFileSync(file, 'utf8')).toBe(before);
});

it('returns null for absent and own claims, including the default owner', async () => {
  const f = fixture();
  expect(readPendingRebuild(f.root, f)).toBeNull();
  await claim(f, defaultOwner());
  expect(readPendingRebuild(f.root, f)).toBeNull();
});

it.each(['dead', 'expired'])('removes a %s claim and returns null', async mode => {
  const f = fixture();
  await claim(f);
  expect(readPendingRebuild(f.root, { ...f, owner: 'reader',
    probe: () => mode === 'dead' ? 'dead' : 'alive', nowMs: 2000, ttlMs: mode === 'expired' ? 999 : 10000 })).toBeNull();
  expect(existsSync(join(cloneLockDirs(f.root, f.lockRoot).starvedRoot, '..', 'writer-claim.json'))).toBe(false);
});

it('treats unknown writer liveness as live within the TTL', async () => {
  const f = fixture();
  await claim(f);
  expect(readPendingRebuild(f.root, { ...f, owner: 'reader', probe: () => 'unknown' })).toMatchObject({ count: 1 });
});

it.each([false, true])('CI-heal proceeds with own claim=%s and no foreign claim', async own => {
  const f = fixture();
  if (own) await claim(f, defaultOwner());
  const tick = vi.fn(async () => ({ healed: true }));
  const acquire = vi.fn(() => acquireRead(f.root, { ...f, owner: defaultOwner() }));
  expect(await runCiHealLoopIteration({
    root: f.root, pendingRebuild: () => readPendingRebuild(f.root, f),
    locks: { acquireRead: acquire, releaseRead: () => releaseRead(f.root, { ...f, owner: defaultOwner() }), heartbeatRead() {} },
    lock: { reserve: () => ({ ok: true }), release() {}, heartbeat() {} },
    dispatchBlock: () => null, ensureAuth() {}, tick, write() {},
  })).toEqual({ healed: true });
  expect(acquire).toHaveBeenCalledOnce();
  expect(tick).toHaveBeenCalledOnce();
});
