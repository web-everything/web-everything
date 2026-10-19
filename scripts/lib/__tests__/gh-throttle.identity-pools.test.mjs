import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { acquireGhSlotSync, releaseGhSlotSync, ghAuthIdentity, ghThrottleStatus, runGhSync, runGhCliPassthrough, writeBudgetBlock, resolveGhSlotPools } from '../gh-throttle.mjs';
import { readGhSlotHolders } from '../gh-throttle-holders.mjs';

const roots = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'gh-identity-pools-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Synthetic personal credentials provide distinct resolved identities without reading any real credentials.
const envFor = (root, name) => ({ GH_TOKEN: `gho_synthetic_${name}`, WE_PLATFORM_PREFERENCES_FILE: join(root, 'prefs.json'), WE_GH_THROTTLE_COST_HEADERS: '0' });
function fixture(settings = {}) {
  const lockRoot = temp();
  writeFileSync(join(lockRoot, 'prefs.json'), JSON.stringify({ ghThrottle: { slotsPerIdentity: 2, hostMaxSlots: 4, reservedBackgroundSlots: 0, ...settings } }));
  const a = envFor(lockRoot, 'a'), b = envFor(lockRoot, 'b');
  const hold = (env, owner, cls = 'priority') => acquireGhSlotSync({ lockRoot, cap: settings.slotsPerIdentity ?? 2, hostMaxSlots: settings.hostMaxSlots ?? 4, reservedBackgroundSlots: settings.reservedBackgroundSlots ?? 0, identity: ghAuthIdentity(env), class: cls, owner, timeoutMs: 0 });
  const call = (env, caller = 'review-daemon') => {
    const exec = vi.fn(() => 'ok');
    const result = () => runGhSync(['pr', 'list'], { env, throttle: { env, lockRoot, caller, exec, personalRoute: false, acquireTimeoutMs: 0, warn: () => {} } });
    return { exec, result };
  };
  return { lockRoot, a, b, hold, call };
}

it('saturates one identity without blocking another and reports pool attribution', () => {
  const f = fixture();
  expect(f.hold(f.a, 'a1').ok).toBe(true);
  expect(f.hold(f.a, 'a2').ok).toBe(true);
  expect(f.call(f.a).result).toThrow('no gh slot');
  expect(f.call(f.b).result()).toBe('ok');
  expect(readGhSlotHolders({ lockRoot: f.lockRoot, cap: 4 })).toEqual(expect.arrayContaining([expect.objectContaining({ pool: ghAuthIdentity(f.a) })]));
  expect(ghThrottleStatus({ lockRoot: f.lockRoot, cap: 4 }).held).toEqual(expect.arrayContaining([expect.objectContaining({ pool: ghAuthIdentity(f.a) })]));
});

it('reserves background capacity, permits background borrowing, and includes pool/class on refusal', () => {
  const f = fixture({ reservedBackgroundSlots: 1 });
  expect(f.hold(f.a, 'priority').ok).toBe(true);
  const refused = f.call(f.a);
  let error;
  try { refused.result(); } catch (e) { error = e; }
  expect(error?.ghThrottled).toMatchObject({ pool: ghAuthIdentity(f.a), class: 'priority' });
  expect(error?.message).toContain(`pool=${ghAuthIdentity(f.a)}`);
  expect(refused.exec).not.toHaveBeenCalled();
  expect(f.hold(f.a, 'background', 'background').ok).toBe(true);
  expect(f.hold(f.a, 'background-full', 'background').ok).toBe(false);
  releaseGhSlotSync({ lockRoot: f.lockRoot, cap: 4, owner: 'priority' });
  expect(f.hold(f.a, 'background-shared', 'background').ok).toBe(true);
  expect(readFileSync(join(f.lockRoot, 'calls.jsonl'), 'utf8')).toContain(`"pool":"${ghAuthIdentity(f.a)}"`);
});

it('enforces the host ceiling across identities and releases a slot beyond the pool cap', () => {
  const f = fixture({ hostMaxSlots: 3 });
  expect(f.hold(f.a, 'a1').ok).toBe(true);
  expect(f.hold(f.a, 'a2').ok).toBe(true);
  const b = f.call(f.b);
  expect(b.result()).toBe('ok');
  expect(b.result()).toBe('ok'); // release scans the host span, including slot 2
  expect(f.hold(f.b, 'b1').ok).toBe(true);
  expect(f.call(f.b).result).toThrow('no gh slot');
  const spawn = vi.fn();
  const result = runGhCliPassthrough(['pr', 'list'], { env: f.b, throttle: { env: f.b, lockRoot: f.lockRoot, acquireTimeoutMs: 0, personalRoute: false, warn: () => {} }, spawn });
  expect(result.stderr.toString()).toContain(`pool=${ghAuthIdentity(f.b)}`);
  expect(spawn).not.toHaveBeenCalled();
});

it('retains per-identity budget refusal ahead of slot admission', () => {
  const f = fixture();
  writeBudgetBlock(f.lockRoot, ghAuthIdentity(f.a), 'graphql', { nowMs: Date.now(), untilMs: Date.now() + 60000 });
  const blocked = f.call(f.a);
  expect(blocked.result).toThrow();
  expect(blocked.exec).not.toHaveBeenCalled();
  expect(f.call(f.b).result()).toBe('ok');
  expect(ghThrottleStatus({ lockRoot: f.lockRoot, cap: 4 }).heldCount).toBe(0);
  expect(readFileSync(join(f.lockRoot, 'calls.jsonl'), 'utf8')).toContain('budget_blocked');
});

it('resolves pool settings through the cascade, validates values and clamps the reservation', () => {
  const f = fixture({ slotsPerIdentity: 3, reservedBackgroundSlots: 9, hostMaxSlots: 7 });
  expect(resolveGhSlotPools(f.a)).toMatchObject({ slotsPerIdentity: 3, hostMaxSlots: 7, reservedBackgroundSlots: 2, source: { slotsPerIdentity: 'platform', hostMaxSlots: 'platform' } });
  expect(resolveGhSlotPools({ ...f.a, WE_GH_THROTTLE_CAP: '1', WE_GH_THROTTLE_HOST_MAX_SLOTS: '0' })).toMatchObject({ slotsPerIdentity: 1, hostMaxSlots: 7, reservedBackgroundSlots: 0 });
});

it('keys App pools by resolved installation identity across token rotations', () => {
  const f = fixture();
  const bound = (id, token) => ({ GH_TOKEN: token, WE_GH_AUTH_INSTALLATION: id,
    WE_GH_AUTH_TOKEN_HASH: createHash('sha256').update(token).digest('hex') });
  const first = bound('123', 'ghs_synthetic_first');
  const rotated = bound('123', 'ghs_synthetic_rotated');
  const other = bound('456', 'ghs_synthetic_other');
  expect(f.hold(first, 'first').ok).toBe(true);
  expect(f.hold(rotated, 'rotated').ok).toBe(true);
  expect(f.hold(first, 'full').ok).toBe(false);
  expect(f.hold(other, 'other').ok).toBe(true);
});

it('logs effective pool setting sources once alongside holder policy resolution', async () => {
  const { ghHolderPolicy } = await import('../gh-throttle-holders.mjs');
  const { resetCascadeLogForTest } = await import('../policy-cascade.mjs');
  resetCascadeLogForTest();
  const f = fixture();
  const env = { ...f.a, WE_POLICY_CASCADE_LOG: '1' };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    resolveGhSlotPools(env);
    ghHolderPolicy(env);
    resolveGhSlotPools(env);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('slotsPerIdentity=2 (platform)');
    expect(resolveGhSlotPools(env, { ghThrottle: { slotsPerIdentity: 5 } })).toMatchObject({ slotsPerIdentity: 5, source: { slotsPerIdentity: 'tool' } });
  } finally { log.mockRestore(); resetCascadeLogForTest(); }
});

it('atomically enforces pool quotas and the host ceiling across racing processes', async () => {
  const root = temp();
  const moduleUrl = pathToFileURL(resolve('scripts/lib/gh-throttle.mjs')).href;
  const code = `
    const { acquireGhSlotSync } = await import(process.argv[1]);
    process.on('message', identity => {
      const result = acquireGhSlotSync({ lockRoot: process.argv[2], cap: 2, hostMaxSlots: 3,
        reservedBackgroundSlots: 0, identity, owner: String(process.pid), pollMs: 5, timeoutMs: 400 });
      process.send({ ...result, identity });
    });
    process.send('ready');
  `;
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', code, moduleUrl, root], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { PATH: process.env.PATH, WE_POLICY_CASCADE_LOG: '0' },
  }));
  try {
    await Promise.all(children.map(child => Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`slot worker exited ${code} before ready`); })])));
    const pending = children.map(child => once(child, 'message'));
    children.forEach((child, i) => child.send(i % 2 ? 'app-installation-123' : 'app-installation-456'));
    const admitted = (await Promise.all(pending)).map(([result]) => result).filter(result => result.ok);
    expect(admitted).toHaveLength(3);
    for (const identity of ['app-installation-123', 'app-installation-456']) {
      expect(admitted.filter(result => result.identity === identity).length).toBeLessThanOrEqual(2);
    }
    expect(ghThrottleStatus({ lockRoot: root, hostMaxSlots: 3 }).heldCount).toBe(3);
  } finally {
    await Promise.all(children.map(child => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill(); return exited; }));
  }
}, 15000);
