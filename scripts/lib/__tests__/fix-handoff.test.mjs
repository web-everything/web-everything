import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signalFixDispatch, createFixHandoffSleep } from '../fix-handoff.mjs';
it('retains a send-back during a tick and wakes the following sleep', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-handoff-'));
  try {
    const sleep = createFixHandoffSleep({ dir });
    expect(signalFixDispatch({ repo: 'owner/repo', pr: 7, label: 'review:changes' }, { dir })).toBe(true);
    await expect(sleep(60_000)).resolves.toBe('handoff');
    expect(signalFixDispatch({ repo: 'owner/repo', pr: 7, label: 'review:accepted' }, { dir })).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
import { createResourceFixThrottle } from '../resource-gate.mjs';
it('keeps a send-back slot inside a reduced cap without bypassing host admission', () => {
  const throttle = createResourceFixThrottle({ listClaims: () => [], readSnap: () => null, readHeavyWait: () => 100,
    settings: { cutover: 'enforce', fixCap: { floor: 8, lowerBy: 4, lowerMinimum: 1, ceiling: 8 } },
    sendBackReservedSlots: 1, gate: () => ({ admit: true }), log: () => {} });
  for (let n = 0; n < 3; n++) expect(throttle.tryAdmit('ci-heal').admit).toBe(true);
  expect(throttle.tryAdmit('ci-heal').admit).toBe(false);
  expect(throttle.tryAdmit('fix', { sendBack: true }).admit).toBe(true);
  expect(throttle.tryAdmit('fix', { sendBack: true }).admit).toBe(false);
});
it('hands a CI-red label to the daemon in the label writer pass, only after success', async () => {
  const { writeLabelWithHandoff } = await import('../fix-handoff.mjs');
  const calls = [];
  writeLabelWithHandoff({ repo: 'owner/repo', pr: 8, label: 'ci:failed', write: () => calls.push('write') }, e => calls.push(e.label));
  expect(calls).toEqual(['write', 'ci:failed']);
  expect(() => writeLabelWithHandoff({ label: 'ci:failed', write: () => { throw Error('failed'); } }, () => calls.push('bad'))).toThrow('failed');
  expect(calls).toEqual(['write', 'ci:failed']);
});
it('wakes an already sleeping daemon from the real filesystem event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-handoff-'));
  try {
    const sleep = createFixHandoffSleep({ dir });
    const pending = sleep(60_000);
    signalFixDispatch({ repo: 'o/r', pr: 2, label: 'status:ci-red' }, { dir });
    await expect(pending).resolves.toBe('handoff');
    await expect(sleep(1)).resolves.toBe('interval');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('a send-back reservation never waives the host gate', () => {
  const throttle = createResourceFixThrottle({ sendBackReservedSlots: 1, listClaims: () => [], readSnap: () => null,
    settings: { cutover: 'enforce', fixCap: { floor: 1, ceiling: 1 } },
    gate: () => ({ admit: false, kind: 'host-load' }), log: () => {} });
  expect(throttle.tryAdmit('fix', { sendBack: true })).toMatchObject({ admit: false, kind: 'host-load' });
});
it('also checks local hand-offs when webhook waking is enabled', async () => {
  const { createEventWaker } = await import('../pr-events.mjs');
  let polled = false;
  const waker = createEventWaker({ role: 'fix', localWake: () => true,
    poll: async () => { polled = true; throw Error('should wake first'); } });
  await waker.sleep(60_000);
  expect(polled).toBe(false);
});
