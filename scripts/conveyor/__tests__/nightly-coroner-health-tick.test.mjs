/**
 * @file scripts/conveyor/__tests__/nightly-coroner-health-tick.test.mjs
 * @description health tick wiring with an isolated fixture and injected job, no external commands.
 */
import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:child_process', async (original) => ({ ...await original(), execFileSync: vi.fn(() => ''), spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })) }));
vi.mock('../branch-sync.mjs', async (original) => ({ ...await original(), notifyDesktopChecked: vi.fn(() => ({ ok: true })) }));
// Exercise the live-tick branch over fixture directories. The unmodified predicate's complete fixture/dry-run
// rejection contract is tested separately in nightly-coroner-job.test.mjs.
vi.mock('../nightly-coroner-job.mjs', async (original) => {
  const real = await original();
  return { ...real, nightlyCoronerTickAllowed: (flags, config) => real.nightlyCoronerTickAllowed({ 'dry-run': flags['dry-run'] }, config) };
});
import { tick, healthDir } from '../health-watch.mjs';
it('queues only on enabled live ticks and records a failure without crashing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nightly-coroner-health-'));
  const dir = healthDir(root); mkdirSync(dir, { recursive: true });
  const ps = join(root, 'ps.txt'); writeFileSync(ps, '');
  const flags = { 'state-root': root, 'logs-dir': join(root, 'logs'), 'lock-root': join(root, 'locks'), 'self-sync-dir': join(root, 'sync'), 'ps-fixture': ps, 'no-gh': true, 'no-diagnose': true, 'no-investigate': true, 'no-file': true };
  const publish = vi.fn();
  const job = vi.fn(async () => ({ enqueued: 'nightly-coroner-2026-10-16', failures: [] }));
  const config = (enabled) => writeFileSync(join(dir, 'config.json'), JSON.stringify({ prSweep: { enabled: false }, coroner: { nightly: { enabled } }, tmpSweepEnabled: false, claudeJobsArchiveEnabled: false }));
  try {
    config(false); await tick(flags, { runNightlyCoronerJob: job, publishCoronerFailure: publish }); expect(job).not.toHaveBeenCalled();
    config(true); await tick(flags, { runNightlyCoronerJob: job, publishCoronerFailure: publish }); expect(job).toHaveBeenCalledOnce();
    expect(job.mock.calls[0][0].config.at).toBe('22:17');
    await tick({ ...flags, 'dry-run': true }, { runNightlyCoronerJob: job, publishCoronerFailure: publish }); expect(job).toHaveBeenCalledOnce();
    job.mockRejectedValueOnce(new Error('coroner enqueue failed'));
    const out = await tick(flags, { runNightlyCoronerJob: job, publishCoronerFailure: publish }); expect(out.probeErrors.nightlyCoronerJob).toBe('coroner enqueue failed');
    expect(publish).not.toHaveBeenCalled();
    job.mockRejectedValue(new Error('coroner enqueue failed'));
    await tick(flags, { runNightlyCoronerJob: job, publishCoronerFailure: publish });
    expect(publish).not.toHaveBeenCalled();
    await tick(flags, { runNightlyCoronerJob: job, publishCoronerFailure: publish });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toMatchObject({ error: 'coroner enqueue failed', reason: 'nightlyCoronerJob probe failed 3 consecutive times' });
    job.mockResolvedValue({ failures: [] });
    await tick(flags, { runNightlyCoronerJob: job, publishCoronerFailure: publish });
    job.mockRejectedValue(new Error('new failure'));
    await tick(flags, { runNightlyCoronerJob: job, publishCoronerFailure: publish });
    expect(publish).toHaveBeenCalledOnce();

  } finally { rmSync(root, { recursive: true, force: true }); }
});
