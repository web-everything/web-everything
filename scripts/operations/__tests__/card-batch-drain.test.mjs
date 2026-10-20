// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { drainStatePath, drainWorkPending, runDrainJob, startDrainJob } from '../card-batch-drain-io.mjs';
import { main as jobMain } from '../card-batch-drain-job.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture({ pending = true } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'batch-drain-')); roots.push(stateDir);
  if (pending) { mkdirSync(join(stateDir, 'pending-prevention')); writeFileSync(join(stateDir, 'pending-prevention/a.json'), '{}'); }
  const statePath = drainStatePath(stateDir);
  const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const write = record => writeFileSync(statePath, JSON.stringify(record));
  return { stateDir, statePath, read, write };
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
const tokenOfArgs = call => call.args.find(arg => arg.startsWith('--token=')).slice(8);
const settings = () => ({ filingEnabled: true });

describe('startDrainJob (the tick side)', () => {
  it('launches a detached job with its output on <state>.drain.log, records its pid and returns without waiting', async () => {
    const f = fixture(); const { spawn, calls } = fakeSpawn();
    const started = Date.now();
    const results = await startDrainJob({ stateDir: f.stateDir, spawn });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results).toEqual([expect.objectContaining({ action: 'started', step: 'drain' })]);
    expect(calls[0].options.detached).toBe(true);
    expect(calls[0].args[0]).toMatch(/card-batch-drain-job\.mjs$/);
    expect(typeof calls[0].options.stdio[1]).toBe('number');
    expect(existsSync(`${f.statePath}.drain.log`)).toBe(true);
    expect(f.read()).toMatchObject({ status: 'running', pid: 4242, token: tokenOfArgs(calls[0]) });
  });

  it('is single-flight: while a job is alive a second probe reports it and spawns nothing', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    await startDrainJob({ stateDir: f.stateDir, spawn });
    const again = await startDrainJob({ stateDir: f.stateDir, spawn, alive: () => true });
    expect(again).toEqual([{ action: 'running', step: 'drain', reason: expect.stringMatching(/^drain running since \d{4}-/) }]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('never launches beside a live job even long past the budget (it reports it hung instead)', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    f.write({ status: 'running', startedAt: new Date(0).toISOString(), pid: process.pid, token: 't', budgetMs: 1000 });
    const results = await startDrainJob({ stateDir: f.stateDir, spawn, clock: () => 10 * 60 * 60_000 });
    expect(results).toEqual([expect.objectContaining({ action: 'error', reason: expect.stringContaining('exceeded its budget') })]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a launch with no pid yet is still in flight inside its grace, and presumed lost after it', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    const at = Date.parse('2026-10-20T12:00:00Z'); const iso = new Date(at).toISOString();
    f.write({ status: 'running', startedAt: iso, launchedAt: iso, pid: null, token: 't', budgetMs: 1000 });
    expect(await startDrainJob({ stateDir: f.stateDir, spawn, clock: () => at + 30_000 })).toEqual([expect.objectContaining({ action: 'running' })]);
    expect(spawn).not.toHaveBeenCalled();
    const later = await startDrainJob({ stateDir: f.stateDir, spawn, clock: () => at + 10 * 60_000 });
    expect(later[0]).toMatchObject({ action: 'error', reason: expect.stringContaining('died without finishing') });
    expect(later[1]).toMatchObject({ action: 'started' });
  });

  it('two overlapping probes: only one claims the slot', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    const [a, b] = await Promise.all([startDrainJob({ stateDir: f.stateDir, spawn }), startDrainJob({ stateDir: f.stateDir, spawn })]);
    expect(spawn).toHaveBeenCalledOnce();
    expect([a[0].action, b[0].action].sort()).toEqual(['running', 'started']);
  });

  it('surfaces a job that vanished without a result as an error once, frees the slot and relaunches', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    await startDrainJob({ stateDir: f.stateDir, spawn });
    const results = await startDrainJob({ stateDir: f.stateDir, spawn, alive: () => false });
    expect(results[0]).toMatchObject({ action: 'error', step: 'drain', reason: expect.stringContaining('died without finishing') });
    expect(results[1]).toMatchObject({ action: 'started' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('surfaces a recorded failure exactly once, and a failed record never holds the slot', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    f.write({ status: 'failed', startedAt: 'T', error: 'lane unavailable', reported: false });
    const first = await startDrainJob({ stateDir: f.stateDir, spawn, launch: false });
    expect(first).toEqual([{ action: 'error', step: 'drain', reason: expect.stringContaining('drain job failed: lane unavailable') }]);
    expect(await startDrainJob({ stateDir: f.stateDir, spawn, launch: false })).toEqual([]);
    f.write({ status: 'failed', startedAt: 'T', error: 'again', reported: false });
    const relaunch = await startDrainJob({ stateDir: f.stateDir, spawn });
    expect(relaunch.map(result => result.action)).toEqual(['error', 'started']);
  });

  it('reports a launch failure as an error and frees the slot', async () => {
    const f = fixture();
    const spawn = () => { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('error', new Error('EAGAIN'))); return child; };
    const results = await startDrainJob({ stateDir: f.stateDir, spawn });
    expect(results).toEqual([{ action: 'error', step: 'drain', reason: 'drain job launch failed: EAGAIN' }]);
    expect(f.read()).toMatchObject({ status: 'failed', reported: true });
    expect((await startDrainJob({ stateDir: f.stateDir, spawn: fakeSpawn().spawn }))[0]).toMatchObject({ action: 'started' });
  });

  it('launch:false (nothing to do) spawns nothing', async () => {
    const f = fixture(); const { spawn } = fakeSpawn();
    expect(await startDrainJob({ stateDir: f.stateDir, spawn, launch: false })).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('runDrainJob (the detached job)', () => {
  const claim = async (f, spawnPid) => {
    const { spawn, calls } = fakeSpawn(spawnPid); await startDrainJob({ stateDir: f.stateDir, spawn });
    return tokenOfArgs(calls[0]);
  };

  it('drains within the scoped state dir and records ok', async () => {
    const f = fixture(); const token = await claim(f);
    const batch = vi.fn(async () => ({ batched: true }));
    const drain = vi.fn(async (input, options) => { await options.batch({ cardPath: 'backlog/x.md' }, {}); return { ok: true }; });
    expect(await runDrainJob({ stateDir: f.stateDir, token, drain, batch, loadFilingSettings: settings, log: () => {} })).toEqual({ ok: true });
    expect(drain.mock.calls[0][0].drainPending).toBe(true);
    expect(batch).toHaveBeenCalledWith({ cardPath: 'backlog/x.md' }, { stateDir: f.stateDir });
    expect(f.read()).toMatchObject({ status: 'ok', pid: process.pid });
  });

  it('a superseded or late worker does nothing (fencing by token)', async () => {
    const f = fixture(); await claim(f);
    const drain = vi.fn();
    const result = await runDrainJob({ stateDir: f.stateDir, token: 'someone-elses', drain, loadFilingSettings: settings, log: () => {} });
    expect(result).toMatchObject({ ok: true, superseded: true });
    expect(drain).not.toHaveBeenCalled();
    expect(f.read().status).toBe('running');
  });

  it('a worker that lost its slot mid-run does not overwrite the successor record', async () => {
    const f = fixture(); const token = await claim(f);
    const drain = vi.fn(async () => { f.write({ status: 'running', token: 'successor', pid: 1, startedAt: 'T' }); return { ok: true }; });
    await runDrainJob({ stateDir: f.stateDir, token, drain, loadFilingSettings: settings, log: () => {} });
    expect(f.read()).toMatchObject({ token: 'successor', status: 'running' });
  });

  it('stops starting new cards once its budget is spent; they stay in the spool', async () => {
    const f = fixture(); let t = 0; const batch = vi.fn(async () => ({ batched: true }));
    const drain = vi.fn(async (input, options) => {
      const first = await options.batch({ cardPath: 'a' }, {});
      t = 1_000; // past the 500ms budget
      const second = await options.batch({ cardPath: 'b' }, {});
      expect(first).toEqual({ batched: true });
      expect(second).toEqual({ batched: false, deferred: 'budget' });
      return { ok: true };
    });
    await runDrainJob({ stateDir: f.stateDir, budgetMs: 500, clock: () => t, drain, batch, loadFilingSettings: settings, log: () => {} });
    expect(batch).toHaveBeenCalledOnce();
  });

  it('checks the budget before EVERY owed filing and inside a filing\'s own nested drain', async () => {
    const f = fixture({ pending: false });
    let t = 0; const batch = vi.fn(async () => ({ batched: true }));
    const fileOwed = vi.fn(async (input, options) => { await options.batch({ cardPath: 'n1' }, {}); t = 1_000; await options.batch({ cardPath: 'n2' }, {}); return { ok: true }; });
    const owedStep = vi.fn(async ({ file }) => { const out = []; for (const id of ['o1', 'o2', 'o3']) out.push(await file({ id })); return out; });
    mkdirSync(join(f.stateDir, 'owed-prevention'));
    writeFileSync(join(f.stateDir, 'owed-prevention', `${'b'.repeat(64)}.json`), JSON.stringify({ status: 'owed' }));
    const result = await runDrainJob({ stateDir: f.stateDir, budgetMs: 500, clock: () => t, fileOwed, owedStep, batch, loadFilingSettings: settings, log: () => {} });
    expect(result).toEqual({ ok: true });
    expect(fileOwed).toHaveBeenCalledTimes(1); // o2 and o3 are deferred, not started
    expect(batch).toHaveBeenCalledTimes(1); // n2 deferred
    expect(f.read().remaining.owed).toBe(true); // still owed, so the next tick relaunches
  });

  it('a crash is recorded as failed/unreported with its message and the slot is free for the next launch', async () => {
    const f = fixture(); const token = await claim(f);
    const logs = [];
    expect(await runDrainJob({ stateDir: f.stateDir, token, drain: async () => { throw new Error('boom'); }, loadFilingSettings: settings, log: l => logs.push(l) }))
      .toEqual({ ok: false, reason: 'boom' });
    expect(f.read()).toMatchObject({ status: 'failed', error: 'boom', reported: false });
    expect(logs.join('\n')).toContain('drain failed: boom');
    const { spawn } = fakeSpawn();
    expect((await startDrainJob({ stateDir: f.stateDir, spawn })).map(result => result.action)).toEqual(['error', 'started']);
  });

  it('a not-ok drain result fails the job and the probe reports it', async () => {
    const f = fixture();
    expect(await runDrainJob({ stateDir: f.stateDir, drain: async () => ({ ok: false, reason: 'lane unavailable' }),
      owedStep: async () => [], loadFilingSettings: settings, log: () => {} })).toEqual({ ok: false, reason: 'lane unavailable' });
    const seen = await startDrainJob({ stateDir: f.stateDir, spawn: fakeSpawn().spawn, launch: false });
    expect(seen).toEqual([{ action: 'error', step: 'drain', reason: expect.stringContaining('lane unavailable') }]);
  });

  it('runs the owed filings with the scoped state dir', async () => {
    const f = fixture({ pending: false });
    mkdirSync(join(f.stateDir, 'owed-prevention'));
    writeFileSync(join(f.stateDir, 'owed-prevention', `${'b'.repeat(64)}.json`), JSON.stringify({ status: 'owed' }));
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
    const result = await jobMain([`--state-dir=${f.stateDir}`, '--budget-ms=1000'],
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
