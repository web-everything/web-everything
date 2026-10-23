import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_POLICY_STANDARD, classifyWaiterPriority, markWaiting, clearWaiting, isOldestLiveWaiter,
  acquireSlotBlocking, tryAcquireSlot, heldSlots, listWaiting, releaseOwnedSlot, slotOrderFor,
  resolveAdmissionPolicy, formatAdmissionPolicy } from '../heavy-admission.mjs';

let lockRoot;
const T0 = Date.parse('2026-10-22T12:00:00Z');
const evidence = [{ repo: 'web-everything/web-everything', pr: 5806, session: 'fix-5806', freshness: 'dispatchedFreshMs=86400000 (source: standard)' }];
const priority = ADMISSION_POLICY_STANDARD.priority;
const policy = { settings: { ...ADMISSION_POLICY_STANDARD, fastSlots: 0 }, sources: { 'priority.mode': 'platform', onTimeout: 'standard' } };
beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'heavy-send-back-')); });
afterEach(() => rmSync(lockRoot, { recursive: true, force: true }));
const marker = (owner, kind, cls, offset) => markWaiting({ lockRoot, owner, kind, priority: cls,
  nowIso: new Date(T0 + offset).toISOString(), pid: process.pid });
const next = owner => isOldestLiveWaiter({ lockRoot, owner, nowMs: T0 + 10000, kind: owner === 'BUILD' ? 'files' : 'FULL' });

describe('send-back heavy queue priority', () => {
  it('classifies exact send-back session/lane/holder identities as P1 below P0; normal fixes stay P3', () => {
    for (const field of ['purpose', 'session', 'holder', 'envSession']) {
      expect(classifyWaiterPriority({ [field]: 'fix-5806-lane-10-ab12' }, priority, { sendBackFixes: evidence }).class).toBe('P1');
    }
    expect(classifyWaiterPriority({ session: 'fix-5806' }, priority, { sendBackFixes: evidence }).class).toBe('P1');
    expect(classifyWaiterPriority({ purpose: 'main-fix-abcdef123', session: 'fix-5806' }, priority, { sendBackFixes: evidence }).class).toBe('P0');
    for (const session of ['fix-5807', 'fix-58060', 'fix-5806-other']) {
      expect(classifyWaiterPriority({ session }, priority, { sendBackFixes: evidence }).class).toBe('P3');
    }
    expect(classifyWaiterPriority({ session: 'fix-5806' }, priority).class).toBe('P3');
    expect(classifyWaiterPriority({ session: 'fix-5806' }, { ...priority, mode: 'off' }, { sendBackFixes: evidence }).class).toBe('P3');
  });
  it('orders P0 across lanes and P1 before P3 within its lane, with FCFS among send-backs', () => {
    marker('BUILD', 'files', 'P3', 0); marker('TEST', 'FULL', 'P3', 1);
    marker('FIX', 'FULL', 'P1', 2); marker('FIX2', 'FULL', 'P1', 3);
    expect(next('BUILD')).toBe(true); expect(next('TEST')).toBe(false); expect(next('FIX')).toBe(true); expect(next('FIX2')).toBe(false);
    marker('REPAIR', 'FULL', 'P0', 4);
    expect(next('REPAIR')).toBe(true); expect(next('FIX')).toBe(false); expect(next('BUILD')).toBe(false);
    clearWaiting({ lockRoot, owner: 'REPAIR' }); expect(next('FIX')).toBe(true);
    clearWaiting({ lockRoot, owner: 'FIX' }); expect(next('FIX2')).toBe(true);
    expect(isOldestLiveWaiter({ lockRoot, owner: 'BUILD', kind: 'files', nowMs: T0 + 10000, priorityMode: 'off' })).toBe(true);
    expect(slotOrderFor('FULL', 1, 1, 'P1')).toEqual(slotOrderFor('FULL', 1, 1, 'P3'));
  });
  it('admits an ordinary short command to a free short-only slot while a FULL P1 waits', async () => {
    marker('FIX', 'FULL', 'P1', 0);
    expect(tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0,
      nowIso: new Date(T0).toISOString(), slots: [0] }).ok).toBe(true);
    expect(slotOrderFor('FULL', 1, 1, 'P1')).toEqual([0]);
    const result = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'BUILD', kind: 'files',
      policy: { ...policy, settings: { ...policy.settings, fastSlots: 1,
        fastScale: { ...policy.settings.fastScale, maxSlots: 1 } } },
      env: {}, now: () => T0 + 10000, hostAdmission: () => ({ admitted: true }),
      readLease: () => null, readSendBackFixes: () => [], log() {}, ceilingMs: 1000,
      sleep: async () => { throw new Error('short command must not wait for the FULL P1'); },
    });
    expect(result).toMatchObject({ ok: true, slot: 1, waitedMs: 0 });
    expect(listWaiting(lockRoot)).toContainEqual(expect.objectContaining({ owner: 'FIX', priority: 'P1' }));
    expect(heldSlots({ lockRoot, cap: 1, fastSlots: 1 }).map(h => h.owner)).toEqual(['HOLDER', 'BUILD']);
  });
  it('records the classification through acquireSlotBlocking and never preempts a running holder', async () => {
    expect(tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: new Date(T0).toISOString(), slots: [0] }).ok).toBe(true);
    let clock = T0; let polls = 0; const logs = [];
    const result = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'FIX', repo: '/fixture/lane', kind: 'FULL', policy,
      env: {}, now: () => clock, hostAdmission: () => ({ admitted: true }),
      readLease: () => ({ session: 'fix-5806' }), readSendBackFixes: () => evidence, log: line => logs.push(line),
      pollMs: 10, ceilingMs: 1000, sleep: async ms => {
        clock += ms; polls++;
        expect(heldSlots({ lockRoot, cap: 1 }).map(h => h.owner)).toEqual(['HOLDER']);
        expect(listWaiting(lockRoot)[0]).toMatchObject({ priority: 'P1' });
        if (polls === 2) releaseOwnedSlot({ lockRoot, cap: 1, owner: 'HOLDER' });
      } });
    expect(result).toMatchObject({ ok: true, slot: 0, waitedMs: 20 });
    expect(logs.join('')).toContain('class P1');
    expect(logs.join('')).toContain('priority.mode=enforce (platform)');
    expect(logs.join('')).toContain('source: standard');
    expect(heldSlots({ lockRoot, cap: 1 }).map(h => h.owner)).toEqual(['FIX']);
  });
  it('uses the existing host priority cascade and logs the source of off mode', () => {
    const resolved = resolveAdmissionPolicy({ platform: { priority: { mode: 'off' } }, env: {} });
    expect(resolved.settings.priority.mode).toBe('off');
    expect(formatAdmissionPolicy(resolved)).toContain('priority.mode=off (platform)');
    expect(resolved.settings.cap).toBe(ADMISSION_POLICY_STANDARD.cap);
  });
});
