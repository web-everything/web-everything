import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lock from '../../../lib/daemon-clone-lock.mjs';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';
import b, { runOwnerPressure } from '../breaks/clone-single-owner-starvation.mjs';
let scratch;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
describe('clone single-owner starvation soak break', () => {
  it('continuous pass-daemons never rebuild or take write slots and the owner moves exclusively within the bound', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'single-owner-soak-'));
    const result = await runOwnerPressure(lock, withSelfSync, join(scratch, 'clone'), join(scratch, 'locks'));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, reason: 'owner-moved', moved: true, nonOwnerRebuilds: 0, nonOwnerWriterSlots: 0 });
    expect(result.passTicks).toBeGreaterThanOrEqual(10);
    expect(result.ownerRebuilds).toBeGreaterThan(0);
    expect(result.elapsed).toBeLessThan(5000);
  }, 8000);
  it('reproduces the root cause and fails when a non-owner acquires a writer slot', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'single-owner-soak-red-'));
    const brokenOwnership = (effects, options) => withSelfSync(effects, { ...options, entries: ['review-daemon.mjs'] });
    const result = await runOwnerPressure(lock, brokenOwnership, join(scratch, 'clone'), join(scratch, 'locks'));
    expect(result).toMatchObject({ ok: false, reason: 'non-owner-writer' });
    expect(result.nonOwnerWriterSlots).toBeGreaterThan(0);
    expect(result.nonOwnerRebuilds).toBeGreaterThan(0);
  });
  it('fails when owner movement never succeeds instead of passing on non-owner inactivity alone', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'single-owner-soak-blocked-'));
    const noMove = { ...lock, acquireWrite: async () => ({ ok: false, reason: 'tick-in-progress' }) };
    const result = await runOwnerPressure(noMove, withSelfSync, join(scratch, 'clone'), join(scratch, 'locks'), { boundMs: 100 });
    expect(result).toMatchObject({ ok: false, reason: 'owner-starved', moved: false, nonOwnerRebuilds: 0, nonOwnerWriterSlots: 0 });
  });
  it('judge reports starvation and crashes, including fatal harness failures', () => {
    expect(b.judge({ fatal: 'harness failed', violations: [{ invariant: 'clone-writer-starved', detail: 'deadline' }] }))
      .toEqual(['harness failed', 'clone-writer-starved: deadline']);
  });
});
