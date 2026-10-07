/**
 * @file scripts/lib/__tests__/gh-throttle.nested-slot.test.mjs
 * @description Live 2026-10-07 13:39-14:06Z conveyor stall. A daemon's in-process `runGhSync` holds a gh
 *   concurrency slot while its real `gh` (the App shim) runs `runGhCliPassthrough`, which asked for a SECOND slot.
 *   Five such holders plus one `gh run watch` filled the cap (6): every nested child waited for a slot only its own
 *   parent could free, so every gh call on the host paid the full 2-minute acquire timeout — silently. The fix
 *   daemon's tick ran 25+ min with its log silent and the drain's live smoke took 25 min and was rejected.
 *   Proves: (1) a nested passthrough (the outer invocation id is set) never waits for a slot — it rides the
 *   outer's; (2) an un-nested call that does time out on a full pool leaves a `slot_timeout` line and a warning.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGhCliPassthrough, acquireGhSlotSync, ghThrottleLogPath, GH_OUTER_INV_ENV } from '../gh-throttle.mjs';

const made = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gh-nested-')); made.push(d); return d; };
afterEach(() => { while (made.length) rmSync(made.pop(), { recursive: true, force: true }); });
const ok = () => ({ status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) });

/** Fill every slot with a LIVE holder (this test process), exactly like the outer `runGhSync` callers did. */
function fillPool(lockRoot, cap) {
  for (let i = 0; i < cap; i += 1) {
    const r = acquireGhSlotSync({ lockRoot, cap, owner: `${process.pid}:outer-${i}`, pid: process.pid, timeoutMs: 0, sleep: () => {} });
    expect(r.ok).toBe(true);
  }
}

/** A clock that advances on every read, so a waiting acquire reaches its timeout in a bounded number of polls. */
function tickingClock(stepMs = 1000) {
  let t = Date.parse('2026-10-07T13:40:00Z');
  return () => { t += stepMs; return t; };
}

function logLines(lockRoot) {
  try { return readFileSync(ghThrottleLogPath(lockRoot), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

const BASE_ENV = { HOME: '/h', WE_GH_THROTTLE_COST_HEADERS: '0' };

describe('nested gh call (shim under a runGhSync that already holds a slot)', () => {
  it('runs immediately on a FULL pool — never waits for a second slot', () => {
    const lockRoot = tmp();
    fillPool(lockRoot, 2);
    const sleep = vi.fn();
    const spawn = vi.fn(ok);
    const warn = vi.fn();
    const r = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, cap: 2, env: { ...BASE_ENV, [GH_OUTER_INV_ENV]: 'outer-inv-1' }, now: tickingClock(), sleep, acquireTimeoutMs: 120_000, warn },
      spawn,
    });
    expect(r.status).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled(); // old code polled the full pool until the 2-minute timeout
    expect(logLines(lockRoot).some((e) => e.outcome === 'slot_timeout')).toBe(false);
    expect(logLines(lockRoot).find((e) => e.outcome === 'call')?.outer).toBe('outer-inv-1');
  });
});

describe('un-nested gh call on a full pool', () => {
  it('still waits (the cap is real) and, when it times out, says so in calls.jsonl and on stderr', () => {
    const lockRoot = tmp();
    fillPool(lockRoot, 2);
    const sleep = vi.fn();
    const spawn = vi.fn(ok);
    const warn = vi.fn();
    const r = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, cap: 2, env: { ...BASE_ENV }, now: tickingClock(), sleep, acquireTimeoutMs: 5_000, warn },
      spawn,
    });
    expect(r.status).toBe(0); // fail OPEN after the timeout — unchanged
    expect(sleep).toHaveBeenCalled();
    const timeout = logLines(lockRoot).find((e) => e.outcome === 'slot_timeout');
    expect(timeout).toBeTruthy();
    expect(timeout.waitedMs).toBeGreaterThanOrEqual(5_000);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gh concurrency slot/));
  });
});
