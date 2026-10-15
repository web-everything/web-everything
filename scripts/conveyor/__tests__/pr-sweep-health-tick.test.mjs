/**
 * @file scripts/conveyor/__tests__/pr-sweep-health-tick.test.mjs
 * @description Card 335 — health tick wiring with an isolated fixture and injected job, no external commands.
 */
import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:child_process', async (original) => ({ ...await original(), execFileSync: vi.fn(() => ''), spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })) }));
vi.mock('../branch-sync.mjs', async (original) => ({ ...await original(), notifyDesktopChecked: vi.fn(() => ({ ok: true })) }));
// Exercise the live-tick branch over fixture directories. The unmodified predicate's complete fixture/dry-run
// rejection contract is tested separately in pr-sweep-job.test.mjs.
vi.mock('../pr-sweep-job.mjs', async (original) => {
  const real = await original();
  return { ...real, prSweepTickAllowed: (flags, config) => real.prSweepTickAllowed({ 'dry-run': flags['dry-run'] }, config) };
});
import { tick, healthDir } from '../health-watch.mjs';
it('calls only when enabled; persists job state and records failure without crashing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-sweep-health-'));
  const dir = healthDir(root); mkdirSync(dir, { recursive: true });
  const ps = join(root, 'ps.txt'); writeFileSync(ps, '');
  const flags = { 'state-root': root, 'logs-dir': join(root, 'logs'), 'lock-root': join(root, 'locks'), 'self-sync-dir': join(root, 'sync'), 'ps-fixture': ps, 'no-gh': true, 'no-diagnose': true, 'no-investigate': true, 'no-file': true };
  const job = vi.fn(async () => ({ state: { consumed: ['done'], lastEnqueuedAt: 123 }, failures: [] }));
  const config = (enabled) => writeFileSync(join(dir, 'config.json'), JSON.stringify({ prSweep: { enabled }, tmpSweepEnabled: false, claudeJobsArchiveEnabled: false }));
  try {
    config(false); await tick(flags, { runPrSweepJob: job }); expect(job).not.toHaveBeenCalled();
    config(true); await tick(flags, { runPrSweepJob: job }); expect(job).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).prSweep.consumed).toEqual(['done']);
    await tick({ ...flags, 'dry-run': true }, { runPrSweepJob: job }); expect(job).toHaveBeenCalledOnce();
    job.mockRejectedValueOnce(new Error('enqueue failed'));
    const out = await tick(flags, { runPrSweepJob: job }); expect(out.probeErrors.prSweepJob).toBe('enqueue failed');
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).prSweep.consumed).toEqual(['done']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
