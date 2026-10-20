// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { acquireLease } from '../card-batch-io.mjs';
import { drainStatePath, drainWorkPending, runDrainJob, startDrainJob } from '../card-batch-drain-io.mjs';
import { main as jobMain } from '../card-batch-drain-job.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture({ pending = true } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'batch-drain-')); roots.push(stateDir);
  if (pending) { mkdirSync(join(stateDir, 'pending-prevention')); writeFileSync(join(stateDir, 'pending-prevention/a.json'), '{}'); }
  const statePath = drainStatePath(stateDir);
  const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
  return { stateDir, statePath, lockPath: `${statePath}.lock`, read };
}
/** A spawn double: reports an OS launch immediately and never finishes (a job still running). */
function fakeSpawn(pid = 4242) {
  const calls = [];
  const spawn = vi.fn((cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter(); child.pid = pid; child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  return { spawn, calls };
}

describe('startDrainJob (the tick side)', () => {
  it('launches a detached job with its output on <state>.drain.log and returns without waiting for it', async () => {
    const f = fixture(); const { spawn, calls } = fakeSpawn();
    const started = Date.now();
    const results = await startDrainJob({ stateDir: f.stateDir, spawn });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results).toEqual([expect.objectContaining({ action: 'started', step: 'drain' })]);
    expect(calls[0].options.detached).toBe(true);
    expect(calls[0].args[0]).toMatch(/card-batch-drain-job\.mjs$/);
    expect(calls[0].args).toContain(`--state-dir=${f.stateDir}`);
    expect(typeof calls[0].options.stdio[1]).toBe('number');
    expect(existsSync(`${f.statePath}.drain.log`)).toBe(true);
    expect(f.read()).toMatchObject({ status: 'running' });
  });

  it('is single-flight: while a job is running a second probe reports it and spawns nothing', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    await startDrainJob({ stateDir: f.stateDir, spawn });
    // The job records its own pid once it is up.
    writeFileSync(f.statePath, JSON.stringify({ ...f.read(), pid: process.pid }));
    const again = await startDrainJob({ stateDir: f.stateDir, spawn });
    expect(again).toEqual([{ action: 'running', step: 'drain', reason: expect.stringMatching(/^drain running since \d{4}-/) }]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('is single-flight against a held lease even before the job has recorded a pid', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    expect(acquireLease(f.lockPath, 'other', Date.now(), 60_000)).toBeTruthy();
    const results = await startDrainJob({ stateDir: f.stateDir, spawn });
    expect(results[0]).toMatchObject({ action: 'running', step: 'drain' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('surfaces a job that vanished without a result as an error once, frees the slot and relaunches', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    await startDrainJob({ stateDir: f.stateDir, spawn });
    writeFileSync(f.statePath, JSON.stringify({ ...f.read(), pid: 999_999 }));
    const results = await startDrainJob({ stateDir: f.stateDir, spawn, alive: () => false });
    expect(results[0]).toMatchObject({ action: 'error', step: 'drain', reason: expect.stringContaining('died without finishing') });
    expect(results[1]).toMatchObject({ action: 'started' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('surfaces a recorded job failure exactly once', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    writeFileSync(f.statePath, JSON.stringify({ status: 'failed', startedAt: 'T', error: 'lane unavailable', reported: false }));
    const first = await startDrainJob({ stateDir: f.stateDir, spawn, launch: false });
    expect(first).toEqual([{ action: 'error', step: 'drain', reason: expect.stringContaining('drain job failed: lane unavailable') }]);
    expect(await startDrainJob({ stateDir: f.stateDir, spawn, launch: false })).toEqual([]);
  });

  it('reports a hung job (past twice its budget) as an error', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    writeFileSync(f.statePath, JSON.stringify({ status: 'running', startedAt: new Date(0).toISOString(), pid: process.pid, token: 't' }));
    const results = await startDrainJob({ stateDir: f.stateDir, spawn, clock: () => 10 * 60 * 60_000 });
    expect(results[0]).toMatchObject({ action: 'error', reason: expect.stringContaining('exceeded its budget') });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a launch failure as an error and releases the lease', async () => {
    const f = fixture();
    const spawn = () => { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('error', new Error('EAGAIN'))); return child; };
    const results = await startDrainJob({ stateDir: f.stateDir, spawn });
    expect(results).toEqual([{ action: 'error', step: 'drain', reason: 'drain job launch failed: EAGAIN' }]);
    expect(existsSync(f.lockPath)).toBe(false);
  });

  it('launch:false (paused or nothing to do) spawns nothing', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    expect(await startDrainJob({ stateDir: f.stateDir, spawn, launch: false })).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('runDrainJob (the detached job)', () => {
  const settings = () => ({ filingEnabled: true });
  it('drains within the scoped state dir, records ok and releases the lease', async () => {
    const f = fixture(); const lease = acquireLease(f.lockPath, 'probe', Date.now(), 60_000);
    const batch = vi.fn(async () => ({ batched: true }));
    const drain = vi.fn(async (input, options) => { await options.batch({ cardPath: 'backlog/x.md' }, {}); return { ok: true }; });
    const logs = [];
    expect(await runDrainJob({ stateDir: f.stateDir, token: lease.token, drain, batch, loadFilingSettings: settings, log: l => logs.push(l) })).toEqual({ ok: true });
    expect(drain.mock.calls[0][0].drainPending).toBe(true);
    expect(batch).toHaveBeenCalledWith({ cardPath: 'backlog/x.md' }, { stateDir: f.stateDir });
    expect(f.read()).toMatchObject({ status: 'ok', pid: process.pid });
    expect(existsSync(f.lockPath)).toBe(false);
  });

  it('stops starting new cards once its budget is spent; they stay in the spool', async () => {
    const f = fixture(); let t = 0; const batch = vi.fn(async () => ({ batched: true }));
    const drain = vi.fn(async (input, options) => {
      const first = await options.batch({ cardPath: 'a' }, {});
      t = 1_000; // 1s later, past the 500ms budget
      const second = await options.batch({ cardPath: 'b' }, {});
      expect(first).toEqual({ batched: true });
      expect(second).toEqual({ batched: false, deferred: 'budget' });
      return { ok: true };
    });
    await runDrainJob({ stateDir: f.stateDir, budgetMs: 500, clock: () => t, drain, batch, loadFilingSettings: settings, log: () => {} });
    expect(batch).toHaveBeenCalledOnce();
  });

  it('a crash is recorded as failed/unreported with its message, and the lease is still released', async () => {
    const f = fixture(); const lease = acquireLease(f.lockPath, 'probe', Date.now(), 60_000);
    const drain = vi.fn(async () => { throw new Error('boom'); });
    const logs = [];
    expect(await runDrainJob({ stateDir: f.stateDir, token: lease.token, drain, loadFilingSettings: settings, log: l => logs.push(l) })).toEqual({ ok: false, reason: 'boom' });
    expect(f.read()).toMatchObject({ status: 'failed', error: 'boom', reported: false });
    expect(logs.join('\n')).toContain('drain failed: boom');
    expect(existsSync(f.lockPath)).toBe(false);
  });

  it('a not-ok drain result and owed failures fail the job; the probe then reports them', async () => {
    const f = fixture({ pending: true });
    const result = await runDrainJob({ stateDir: f.stateDir, drain: async () => ({ ok: false, reason: 'lane unavailable' }),
      owedStep: async () => [], loadFilingSettings: settings, log: () => {} });
    expect(result).toEqual({ ok: false, reason: 'lane unavailable' });
    const { spawn } = fakeSpawn();
    const seen = await startDrainJob({ stateDir: f.stateDir, spawn, launch: false });
    expect(seen).toEqual([{ action: 'error', step: 'drain', reason: expect.stringContaining('lane unavailable') }]);
  });

  it('runs the owed filings with the scoped state dir', async () => {
    const f = fixture({ pending: false });
    const fileOwed = vi.fn(async () => ({ ok: true }));
    const owedStep = vi.fn(async ({ file }) => [await file({ title: 't' })]);
    await runDrainJob({ stateDir: f.stateDir, fileOwed, owedStep, loadFilingSettings: settings, log: () => {} });
    expect(owedStep).toHaveBeenCalledWith(expect.objectContaining({ stateDir: f.stateDir }));
    expect(fileOwed).toHaveBeenCalledWith({ title: 't' }, expect.objectContaining({ owedClaimed: true }));
  });

  it('does nothing while filing is paused', async () => {
    const f = fixture(); const drain = vi.fn();
    expect(await runDrainJob({ stateDir: f.stateDir, drain, loadFilingSettings: () => ({ filingEnabled: false }), log: () => {} })).toEqual({ ok: true });
    expect(drain).not.toHaveBeenCalled();
  });

  it('the job entry parses its flags', async () => {
    const f = fixture({ pending: false });
    const result = await jobMain([`--state-dir=${f.stateDir}`, '--token=x', '--budget-ms=1000'],
      { loadFilingSettings: settings, log: () => {}, owedStep: async () => [] });
    expect(result).toEqual({ ok: true });
  });
});

describe('drainWorkPending', () => {
  it('sees a pending spool and ignores completed owed tombstones', () => {
    const f = fixture({ pending: false });
    expect(drainWorkPending(f.stateDir)).toEqual({ pending: false, owed: false });
    const owedDir = join(f.stateDir, 'owed-prevention'); mkdirSync(owedDir);
    const key = 'a'.repeat(64);
    writeFileSync(join(owedDir, `${key}.json`), JSON.stringify({ status: 'done' }));
    expect(drainWorkPending(f.stateDir).owed).toBe(false);
    writeFileSync(join(owedDir, `${key}.json`), JSON.stringify({ status: 'owed' }));
    expect(drainWorkPending(f.stateDir).owed).toBe(true);
  });
});
