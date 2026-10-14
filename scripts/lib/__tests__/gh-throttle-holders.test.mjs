import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireGhSlotSync, noteSlotTimeout, runGhSync, runGhCliPassthrough } from '../gh-throttle.mjs';
import { ghHolderMeta, readGhSlotHolders, loadGhThrottleSettings, ghExecOptions, ghCallerKey, redactGhArgs, acquireGhHolderSlot } from '../gh-throttle-holders.mjs';
import { readLockEntry, reserve, releaseLockDir } from '../../readiness/file-locks.mjs';
import { slotPath } from '../../readiness/heavy-admission.mjs';

let root, logPath;
const policy = { maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 4 };
const clock = 1_800_000_000_000;
function acquire(owner, caller = 'worker', extra = {}) {
  return acquireGhSlotSync({ lockRoot: root, logPath, cap: 6, owner, pid: process.pid, meta: ghHolderMeta({ caller, args: ['api', 'user'], nowMs: clock }), now: () => clock, sleep: () => {}, timeoutMs: 0, policy, warn: () => {}, ...extra });
}
function rows() { return readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse); }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gh-holders-')); logPath = join(root, 'calls.jsonl'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('gh holders', () => {
  it('writes redacted metadata and reads live holder attribution', () => {
    const args = ['api', 'user', '-H', 'Authorization: Bearer abc', '-f', 'client_secret=hidden', '-F', 'password=hidden', 'ghp_abcdef', 'github_pat_abcdef', 'token=hidden', '--field=client_secret=hidden', '--raw-field=password=hidden', 'Bearer', 'hidden', 'token="hidden words"', "Bearer 'hidden words'"];
    acquire('one', 'worker', { meta: ghHolderMeta({ caller: 'worker', args, nowMs: clock }) });
    const entry = readLockEntry(root, slotPath(0));
    expect(entry.meta).toMatchObject({ caller: 'worker', pid: process.pid, ppid: process.ppid, acquiredAt: new Date(clock).toISOString() });
    expect(entry.meta.op).not.toMatch(/hidden|abcdef|Bearer|abc/);
    expect(entry.meta.op).toContain('<redacted>');
    expect(redactGhArgs(['x'.repeat(500)])).toHaveLength(300);
    expect(readGhSlotHolders({ lockRoot: root, cap: 6, nowMs: clock + 95000 })[0]).toMatchObject({ slot: 0, alive: true, heldMs: 95000, caller: 'worker' });
  });
  it('logs holders and warns on slot timeout', () => {
    acquire('one', 'worker', { cap: 1 });
    const acq = acquire('two', 'other', { cap: 1 });
    const warn = vi.fn();
    noteSlotTimeout(logPath, acq, { caller: 'other' }, warn);
    expect(rows()[0]).toMatchObject({ outcome: 'slot_timeout', holders: [{ caller: 'worker', slot: 0 }] });
    expect(warn.mock.calls[0][0]).toContain('holders: worker(api user, 0s)');
  });
  it.each([[106000, 90, true], [104000, 90, false], [106000, 0, false]])('reaps only over-age enabled holds (%s, %s)', (age, maxHoldSeconds, reaped) => {
    acquire('one', 'worker', { cap: 1 });
    const r = acquire('two', 'other', { cap: 1, now: () => clock + age, policy: { ...policy, maxHoldSeconds } });
    expect(r.ok).toBe(reaped);
    if (reaped) expect(rows()[0]).toMatchObject({ outcome: 'slot_reaped', caller: 'worker', heldMs: age });
  });
  it('uses the heartbeat for legacy holders without metadata', () => {
    reserve(root, slotPath(0), 'old', clock, new Date(clock).toISOString(), process.pid);
    expect(acquire('next', 'other', { cap: 1, now: () => clock + 106000 }).ok).toBe(true);
  });
  it('caps a caller at four while allowing other callers, and zero disables', () => {
    for (let i = 0; i < 4; i++) expect(acquire('owner' + i).ok).toBe(true);
    expect(acquire('fifth').ok).toBe(false);
    expect(acquire('other', 'different').ok).toBe(true);
    expect(acquire('uncapped', 'worker', { policy: { ...policy, perCallerMax: 0 } }).ok).toBe(true);
    expect(ghCallerKey({ caller: 'node', ppid: 123 })).toBe('ppid:123');
  });
  it('does not reap a holder that changed owners after the snapshot', () => {
    acquire('one', 'worker', { cap: 1 });
    let calls = 0;
    const onReap = vi.fn();
    acquireGhHolderSlot({ lockRoot: root, cap: 1, owner: 'waiter', pid: process.pid, pollMs: 1, timeoutMs: 0,
      now: () => clock + 106000, sleep: () => {}, meta: ghHolderMeta({ caller: 'other', args: [] }), policy, onReap,
      trySlot: () => {
        if (++calls === 1) {
          releaseLockDir(root, slotPath(0));
          reserve(root, slotPath(0), 'replacement', clock, new Date(clock).toISOString(), process.pid);
        }
        return { ok: false };
      },
    });
    expect(onReap).not.toHaveBeenCalled();
    expect(readLockEntry(root, slotPath(0)).owner).toBe('replacement');
  });
  it('waits with the injected clock and sleep', () => {
    acquire('one', 'worker', { cap: 1 });
    let t = clock;
    const r = acquire('two', 'other', { cap: 1, now: () => t, sleep: (ms) => { t += ms; }, pollMs: 10, timeoutMs: 20 });
    expect(r.waitedMs).toBe(20);
  });
});

describe('hold policy and execution', () => {
  it('resolves tool JSON and env provenance', () => {
    expect(loadGhThrottleSettings({ env: {} })).toMatchObject({ value: policy, sources: { maxHoldSeconds: 'tool', reapGraceSeconds: 'tool', perCallerMax: 'tool' } });
    expect(loadGhThrottleSettings({ env: { WE_GH_THROTTLE_MAX_HOLD_SECONDS: '0', WE_GH_THROTTLE_PER_CALLER_MAX: '2' } })).toMatchObject({ value: { maxHoldSeconds: 0, perCallerMax: 2 }, sources: { maxHoldSeconds: 'env', perCallerMax: 'env' } });
  });
  it('preserves explicit timeout, disables at zero and exempts all watch shapes', () => {
    expect(ghExecOptions({}, ['api'], policy)).toEqual({ timeout: 90000, killSignal: 'SIGTERM' });
    expect(ghExecOptions({ timeout: 7 }, ['api'], policy)).toEqual({ timeout: 7 });
    expect(ghExecOptions({}, ['api'], { ...policy, maxHoldSeconds: 0 })).toEqual({});
    for (const a of [['run', 'watch'], ['pr', 'checks', '--watch']]) expect(ghExecOptions({ timeout: 7 }, a, policy)).toEqual({});
  });
  it.each([90, 0])('applies the timeout to both real execution paths (%s)', (maxHoldSeconds) => {
    const env = { WE_GH_THROTTLE_MAX_HOLD_SECONDS: String(maxHoldSeconds), WE_GH_THROTTLE_COST_HEADERS: '1' };
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
    const throttle = { lockRoot: root, logPath, env, spawn, budgetPerMin: 100, caller: 'test' };
    runGhSync(['api', 'user'], { throttle });
    runGhCliPassthrough(['api', 'user'], { throttle, spawn });
    for (const [, , opts] of spawn.mock.calls) expect(opts.timeout).toBe(maxHoldSeconds ? 90000 : undefined);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('watch takes no slot, has no timeout, and logs its exemption', () => {
    const spawn = vi.fn(() => {
      expect(readGhSlotHolders({ lockRoot: root, cap: 6 })).toEqual([]);
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const throttle = { lockRoot: root, logPath, env: {}, spawn, budgetPerMin: 100 };
    runGhSync(['run', 'watch'], { timeout: 1, throttle });
    runGhCliPassthrough(['pr', 'checks', '--watch'], { throttle, spawn });
    expect(spawn.mock.calls.every((c) => c[2].timeout === undefined)).toBe(true);
    expect(rows().filter((r) => r.outcome === 'call').every((r) => r.unslotted === 'watch')).toBe(true);
  });
  it('preserves native subprocess timeout fields and logs both execution paths', () => {
    const args = ['-e', 'setInterval(() => {}, 1000)'];
    const nativeOpts = { timeout: 20, killSignal: 'SIGTERM', stdio: 'pipe' };
    let native;
    try { execFileSync(process.execPath, args, nativeOpts); } catch (e) { native = e; }
    const throttle = { lockRoot: root, logPath, bin: process.execPath, env: { WE_GH_THROTTLE_COST_HEADERS: '0', WE_GH_THROTTLE_MAX_HOLD_SECONDS: '1' }, budgetPerMin: 100 };
    let syncError, cliError;
    try { runGhSync(args, { ...nativeOpts, throttle }); } catch (e) { syncError = e; }
    try { runGhCliPassthrough(args, { bin: process.execPath, throttle }); } catch (e) { cliError = e; }
    expect(native.code).toBe('ETIMEDOUT');
    expect(syncError).toMatchObject({ code: native.code, signal: native.signal, status: native.status, stdout: native.stdout, stderr: native.stderr });
    expect(cliError.code).toBe(native.code);
    expect(rows().filter((r) => r.outcome === 'call')).toMatchObject([{ timedOut: true }, { timedOut: true }]);
  });
  it('logs timeout and throws the identical native error in both paths', () => {
    const error = Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
    const spawn = () => ({ error, status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const throttle = { lockRoot: root, logPath, env: {}, spawn, budgetPerMin: 100 };
    expect(() => runGhSync(['api', 'user'], { throttle })).toThrow(error);
    expect(() => runGhCliPassthrough(['api', 'user'], { throttle, spawn })).toThrow(error);
    expect(rows().filter((r) => r.outcome === 'call')).toMatchObject([{ timedOut: true }, { timedOut: true }]);
  });
});

describe('legacy holders without meta', () => {
  it('are named from the process table on timeout only', async () => {
    const { describeLegacyHolders } = await import('../gh-throttle-holders.mjs');
    const ps = (pid) => (pid === 10 ? ' 20 node gh-throttle.mjs api x' : ' 1 node drain-daemon.mjs');
    const out = describeLegacyHolders([{ slot: 0, pid: 10, alive: true, caller: 'unknown', op: '', parent: '', ppid: null, heldMs: 5 }, { slot: 1, pid: 11, alive: true, caller: 'w', op: 'pr list', parent: 'p', ppid: 2, heldMs: 1 }], ps);
    expect(out[0]).toMatchObject({ ppid: 20, op: 'node gh-throttle.mjs api x', parent: 'node drain-daemon.mjs' });
    expect(out[1]).toMatchObject({ caller: 'w', op: 'pr list' });
  });
});
