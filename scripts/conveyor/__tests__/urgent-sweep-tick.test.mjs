import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:child_process', async original => ({ ...await original(), execFileSync: vi.fn(() => ''), spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })) }));
vi.mock('../branch-sync.mjs', async original => ({ ...await original(), notifyDesktopChecked: vi.fn(() => ({ ok: true })) }));
vi.mock('../pr-sweep-job.mjs', async original => {
  const real = await original();
  return { ...real, prSweepTickAllowed: (flags, config) => flags['urgent-test-live']
    ? real.prSweepTickAllowed({}, config) : real.prSweepTickAllowed(flags, config) };
});
import { runUrgentSweepTick, resolveUrgentSweepSettings } from '../urgent-sweep-tick.mjs';
import { tick, healthDir } from '../health-watch.mjs';

it.each(['state-root', 'dry-run', 'logs-dir', 'lock-root', 'no-gh', 'tmp-sweep-root', 'claude-jobs-root', 'lane-pool-root', 'future-fixture'])(
  'never sweeps urgent host loads in %s ticks', async flag => {
    const sweep = vi.fn(), settings = vi.fn();
    await runUrgentSweepTick({ flags: { [flag]: true }, now: 1000, sweep, settings });
    expect(sweep).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
  });
it('uses five minutes and logs the effective interval and source; env overrides tool', () => {
  const log = vi.fn();
  const defaults = resolveUrgentSweepSettings({ env: {}, log });
  expect(defaults.value.intervalMinutes).toBe(5);
  expect(defaults.sources.intervalMinutes).toBe('tool');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('intervalMinutes'));
  const override = resolveUrgentSweepSettings({ env: { WE_URGENT_SWEEP_INTERVAL_MINUTES: '7' }, log });
  expect(override.value.intervalMinutes).toBe(7); expect(override.sources.intervalMinutes).toBe('env');
});
it('swallows and logs thrown errors and unsuccessful reports, throttling each attempt', async () => {
  const sweep = vi.fn().mockRejectedValueOnce(new Error('sweep unavailable')).mockResolvedValueOnce({ ok: false, detail: 'unreadable ledger' });
  const settings = () => ({ value: { intervalMinutes: 5 } }), log = vi.fn();
  const state = await runUrgentSweepTick({ now: 1000, sweep, settings, log });
  expect(state).toEqual({ lastAttemptAt: 1000, error: 'sweep unavailable' });
  expect(log).toHaveBeenCalledWith('urgent-sweep: sweep unavailable');
  await runUrgentSweepTick({ now: 300999, state, sweep, settings, log }); expect(sweep).toHaveBeenCalledTimes(1);
  expect(await runUrgentSweepTick({ now: 301000, state, sweep, settings, log })).toMatchObject({ error: 'unreadable ledger' });
  expect(log).toHaveBeenCalledWith('urgent-sweep: unreadable ledger');
});
it('treats future or malformed persisted timestamps as due', async () => {
  const sweep = vi.fn(async () => ({ ok: true })), settings = () => ({ value: { intervalMinutes: 5 } });
  for (const lastAttemptAt of [999999, 'bad']) {
    expect(await runUrgentSweepTick({ now: 1000, state: { lastAttemptAt }, sweep, settings })).toEqual({ lastAttemptAt: 1000 });
  }
  expect(sweep).toHaveBeenCalledTimes(2);
});
it('health tick invokes urgent-sweep on cadence, persists its stamp and survives failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'urgent-sweep-health-'));
  const dir = healthDir(root); mkdirSync(dir, { recursive: true });
  const ps = join(root, 'ps.txt'); writeFileSync(ps, '');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ prSweep: { enabled: false }, tmpSweepEnabled: false, claudeJobsArchiveEnabled: false }));
  const flags = { 'urgent-test-live': true, 'state-root': root, 'logs-dir': join(root, 'logs'), 'lock-root': join(root, 'locks'), 'self-sync-dir': join(root, 'sync'), 'ps-fixture': ps, 'no-gh': true, 'no-diagnose': true, 'no-investigate': true, 'no-file': true, 'no-notify': true };
  const urgentSweep = vi.fn(async () => ({ ok: true }));
  const at = Date.parse('2026-11-18T12:00:00Z');
  const run = now => tick({ ...flags, now: new Date(now).toISOString() }, { urgentSweep });
  try {
    await run(at); expect(urgentSweep).toHaveBeenCalledTimes(1);
    await run(at + 299999); expect(urgentSweep).toHaveBeenCalledTimes(1);
    urgentSweep.mockRejectedValueOnce(new Error('sweep failed'));
    const out = await run(at + 300000);
    expect(urgentSweep).toHaveBeenCalledTimes(2); expect(out.probeErrors.urgentSweep).toBe('sweep failed');
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).urgentSweep).toEqual({ lastAttemptAt: at + 300000, error: 'sweep failed' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
