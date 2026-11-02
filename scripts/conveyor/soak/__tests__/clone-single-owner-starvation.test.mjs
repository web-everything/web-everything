import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lock from '../../../lib/daemon-clone-lock.mjs';
import b, { runReaderPressure } from '../breaks/clone-single-owner-starvation.mjs';
let scratch;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
describe('clone single-owner starvation soak break', () => {
  it('runs the real continuous-reader scenario and proves exclusive writer acquisition', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'single-owner-soak-'));
    expect(await runReaderPressure(lock, join(scratch, 'clone'), join(scratch, 'locks'))).toMatchObject({ ok: true, reason: 'writer-won' });
  });
  it('reproduces reader-priority starvation when the hard-claim fix is absent', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'single-owner-soak-red-'));
    const legacy = { ...lock, acquireWrite: (root, opts) => lock.acquireWrite(root, { ...opts, hardClaim: false }) };
    expect(await runReaderPressure(legacy, join(scratch, 'clone'), join(scratch, 'locks')))
      .toMatchObject({ ok: false, reason: 'writer-starved:reader-priority' });
  });
  it('judge reports starvation and crashes, including fatal harness failures', () => {
    expect(b.judge({ fatal: 'harness failed', violations: [{ invariant: 'clone-writer-starved', detail: 'deadline' }] }))
      .toEqual(['harness failed', 'clone-writer-starved: deadline']);
  });
});
