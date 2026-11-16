import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireGhSlotSync, ghPointsBudgetStatePath } from '../../lib/gh-throttle.mjs';
import { awaitChecks, parseArgs, main } from '../await-checks.mjs';

// Mock before importing the operation and throttle: Vitest's transformed named
// imports can retain the original binding despite syncBuiltinESMExports().
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(),
  execFileSync: vi.fn(),
}));

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const view = (head, checks) => JSON.stringify({ headRefOid: head, url: 'https://github.com/o/r/pull/7', statusCheckRollup: checks });
const run = (status, conclusion, name = 'test') => ({ __typename: 'CheckRun', name, status, conclusion, detailsUrl: 'https://github.com/o/r/actions/runs/99' });
const context = (state) => ({ __typename: 'StatusContext', context: 'test', state, targetUrl: 'https://ci.example/test' });

describe('main through the production executor and shared throttle', () => {
  let root, t, calls, sleeps;
  const epoch = 1800000000000;
  const sleep = (ms) => { sleeps.push(ms); t += ms; };
  const invoke = (timeoutMin = 1) => {
    const lines = [];
    const code = main(['--pr=7', '--repo=o/r', '--check=test', `--timeoutMin=${timeoutMin}`], {
      now: () => t, sleep, out: (line) => lines.push(line),
    });
    return { code, lines };
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'await-checks-deadline-'));
    t = 0; calls = []; sleeps = [];
    vi.stubEnv('WE_GH_THROTTLE_LOCK_ROOT', root);
    vi.stubEnv('WE_GH_THROTTLE_PERSONAL_ROUTE', '0');
    vi.stubEnv('WE_GH_JSON_RETRIES', '1');
    vi.stubEnv('WE_GH_JSON_RETRY_BACKOFF_MS', '2000');
    vi.stubEnv('WE_GH_THROTTLE_CAP', '1');
    vi.spyOn(Date, 'now').mockImplementation(() => epoch + t);
    vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, ms) => { sleep(ms); return 'timed-out'; });
    vi.mocked(execFileSync).mockReset().mockImplementation(() => {
      throw new Error('unexpected subprocess in await-checks fixture');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const fail = (message) => Object.assign(new Error(message), { status: 1, stderr: message });

  it.each(['HTTP 504: Gateway Timeout', 'unexpected end of JSON input'])(
    'caps retry backoff at the deadline and starts no late read: %s', (message) => {
      execFileSync.mockImplementation((_file, _args, opts) => {
        calls.push({ at: t, timeout: opts.timeout });
        t += calls.length === 1 ? 59999 : opts.timeout;
        throw fail(message);
      });
      expect(invoke()).toEqual({ code: 75, lines: ['timeout unknown'] });
      expect({ elapsed: t, calls, sleeps }).toEqual({ elapsed: 60000, calls: [{ at: 0, timeout: 60000 }], sleeps: [1] });
    },
  );
  it('recomputes the subprocess timeout after retry backoff', () => {
    execFileSync.mockImplementation((_file, _args, opts) => {
      calls.push({ at: t, timeout: opts.timeout });
      t += calls.length === 1 ? 10000 : opts.timeout;
      throw fail('HTTP 504: Gateway Timeout');
    });
    expect(invoke().code).toBe(75);
    expect({ elapsed: t, calls }).toEqual({ elapsed: 60000, calls: [{ at: 0, timeout: 60000 }, { at: 12000, timeout: 48000 }] });
  });
  it('still accepts a successful retry completed within the deadline', () => {
    execFileSync.mockImplementation((_file, _args, opts) => {
      calls.push({ at: t, timeout: opts.timeout });
      t += 100;
      if (calls.length === 1) throw fail('HTTP 503: Service Unavailable');
      return view(SHA, [run('COMPLETED', 'SUCCESS')]);
    });
    expect(invoke()).toEqual({ code: 0, lines: [`pass ${SHA} https://github.com/o/r/actions/runs/99`] });
    expect(calls).toEqual([{ at: 0, timeout: 60000 }, { at: 2100, timeout: 57900 }]);
  });
  it.each(['points', 'slot'])('bounds %s admission waits and refuses a read even if expiry is caught by fail-open', (gate) => {
    if (gate === 'points') {
      writeFileSync(ghPointsBudgetStatePath(root), JSON.stringify({ windowStartMs: epoch, spent: 1000000000 }));
    } else {
      expect(acquireGhSlotSync({ lockRoot: root, cap: 1, owner: 'occupied', timeoutMs: 0 }).ok).toBe(true);
    }
    execFileSync.mockImplementation(() => view(SHA, [run('COMPLETED', 'SUCCESS')]));
    expect(invoke(0.5)).toEqual({ code: 75, lines: ['timeout unknown'] });
    expect(t).toBe(30000);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

function harness(replies, { pollMs = 60000 } = {}) {
  let t = 0; const sleeps = []; const calls = [];
  const io = {
    exec: (file, args) => { calls.push([file, ...args]); const r = replies.shift(); if (r instanceof Error) throw r; return r; },
    now: () => t,
    sleep: (ms) => { sleeps.push(ms); t += ms; },
  };
  return { io, sleeps, calls, opts: { pr: 7, repo: 'o/r', check: 'test', timeoutMin: 5, pollMs } };
}

describe('await-checks', () => {
  const statuses = ['COMPLETED', 'QUEUED', 'IN_PROGRESS', 'PENDING', 'REQUESTED', 'WAITING', '', null, undefined, 'UNKNOWN'];
  const conclusions = ['SUCCESS', 'FAILURE', 'NEUTRAL', 'CANCELLED', 'SKIPPED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE', '', null, undefined, 'UNKNOWN'];
  it.each(statuses.flatMap(status => conclusions.map(conclusion => ({
    status, conclusion,
    verdict: status !== 'COMPLETED' ? 'timeout' : conclusion === 'SUCCESS' ? 'pass' : 'fail',
  }))))('maps CheckRun status=$status conclusion=$conclusion to $verdict', ({ status, conclusion, verdict }) => {
    const h = harness([view(SHA, [run(status, conclusion)])]);
    expect(awaitChecks({ ...h.opts, timeoutMin: 1 }, h.io)).toMatchObject({ verdict, head: SHA, url: 'https://github.com/o/r/actions/runs/99' });
    expect(h.sleeps).toEqual(verdict === 'timeout' ? [60000] : []);
    expect(h.calls).toHaveLength(1);
  });

  const contextStates = [
    ['SUCCESS', 'pass'], ['PENDING', 'timeout'], ['EXPECTED', 'timeout'],
    ['ERROR', 'fail'], ['FAILURE', 'fail'], ['', 'timeout'], [null, 'timeout'],
    [undefined, 'timeout'], ['UNKNOWN', 'fail'], ['success', 'pass'], ['pending', 'timeout'], ['error', 'fail'],
  ];
  it.each(contextStates)('maps StatusContext state=%s to %s', (state, verdict) => {
    const h = harness([view(SHA, [context(state)])]);
    expect(awaitChecks({ ...h.opts, timeoutMin: 1 }, h.io)).toMatchObject({ verdict, head: SHA, url: 'https://ci.example/test' });
    expect(h.sleeps).toEqual(verdict === 'timeout' ? [60000] : []);
  });
  it.each(contextStates.filter(([state]) => state !== undefined))('maps a legacy context without __typename state=%s to %s', (state, verdict) => {
    const { __typename, ...legacy } = context(state);
    const h = harness([view(SHA, [legacy])]);
    expect(awaitChecks({ ...h.opts, timeoutMin: 1 }, h.io).verdict).toBe(verdict);
  });

  // Keep every pair and both entry orders when extending the precedence rules.
  const reruns = [
    { label: 'running CheckRun', check: run('IN_PROGRESS', ''), rank: 2 },
    { label: 'successful CheckRun', check: run('COMPLETED', 'SUCCESS'), rank: 0 },
    { label: 'failed CheckRun', check: run('COMPLETED', 'FAILURE'), rank: 1 },
    { label: 'pending StatusContext', check: context('PENDING'), rank: 2 },
    { label: 'successful StatusContext', check: context('SUCCESS'), rank: 0 },
    { label: 'failed StatusContext', check: context('ERROR'), rank: 1 },
  ];
  it.each(reruns.flatMap(a => reruns.map(b => ({
    label: `${a.label} then ${b.label}`, checks: [a.check, b.check],
    verdict: ['pass', 'fail', 'timeout'][Math.max(a.rank, b.rank)],
  }))))('uses strictest rerun state for $label', ({ checks, verdict }) => {
    const h = harness([view(SHA, checks)]);
    expect(awaitChecks({ ...h.opts, timeoutMin: 1 }, h.io).verdict).toBe(verdict);
    expect(h.sleeps).toEqual(verdict === 'timeout' ? [60000] : []);
  });

  it('normalizes lowercase CheckRun status and conclusion', () => {
    const h = harness([view(SHA, [run('completed', 'success')])]);
    expect(awaitChecks(h.opts, h.io).verdict).toBe('pass');
  });

  it('passes when the named check completes successfully, with head sha and run url', () => {
    const h = harness([view(SHA, [run('IN_PROGRESS', '')]), view(SHA, [run('COMPLETED', 'SUCCESS')])]);
    const r = awaitChecks(h.opts, h.io);
    expect(r).toMatchObject({ verdict: 'pass', head: SHA, url: 'https://github.com/o/r/actions/runs/99' });
    expect(h.sleeps).toEqual([60000]);
  });
  it('fails when the check concludes red', () => {
    const h = harness([view(SHA, [run('COMPLETED', 'FAILURE')])]);
    expect(awaitChecks(h.opts, h.io).verdict).toBe('fail');
  });
  it('returns head-moved immediately when the head sha changes', () => {
    const h = harness([view(SHA, [run('IN_PROGRESS', '')]), view(OTHER, [run('IN_PROGRESS', '')])]);
    const r = awaitChecks(h.opts, h.io);
    expect(r).toMatchObject({ verdict: 'head-moved', head: OTHER });
    expect(h.sleeps).toEqual([60000]);
  });
  it('times out with a hard deadline and never polls faster than 60 s', () => {
    const h = harness(Array.from({ length: 20 }, () => view(SHA, [run('IN_PROGRESS', '')])), { pollMs: 1000 });
    const r = awaitChecks(h.opts, h.io);
    expect(r.verdict).toBe('timeout');
    expect(Math.min(...h.sleeps)).toBeGreaterThanOrEqual(60000);
    expect(h.calls.length).toBeLessThanOrEqual(6);
  });
  it('reports check-not-found when the named check never appears', () => {
    const h = harness(Array.from({ length: 20 }, () => view(SHA, [run('COMPLETED', 'SUCCESS', 'lint')])));
    expect(awaitChecks(h.opts, h.io).verdict).toBe('check-not-found');
  });
  it('keeps polling through a failed or malformed read (fail closed, never a false pass)', () => {
    const h = harness([new Error('boom'), 'not json', view(SHA, [run('COMPLETED', 'SUCCESS')])]);
    expect(awaitChecks(h.opts, h.io).verdict).toBe('pass');
  });
  it('rejects bad flags and prints one verdict line', () => {
    expect(() => parseArgs(['--pr=x', '--repo=o/r', '--check=test'])).toThrow();
    expect(() => parseArgs(['--pr=1', '--repo=o/r'])).toThrow();
    const h = harness([view(SHA, [run('COMPLETED', 'SUCCESS')])]);
    const lines = [];
    const code = main(['--pr=7', '--repo=o/r', '--check=test'], { ...h.io, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pass /);
  });
});

describe('await-checks audit fixes', () => {
  it.each([
    { label: 'running check, one-minute budget', timeoutMin: 1, readMs: 10, reply: view(SHA, [run('IN_PROGRESS', '')]), verdict: 'timeout', head: SHA, reads: 1, sleeps: [59990] },
    { label: 'running check, final partial interval', timeoutMin: 2, readMs: 10, reply: view(SHA, [run('IN_PROGRESS', '')]), verdict: 'timeout', head: SHA, reads: 2, sleeps: [60000, 59980] },
    { label: 'missing check', timeoutMin: 1, readMs: 10, reply: view(SHA, []), verdict: 'check-not-found', head: SHA, reads: 1, sleeps: [59990] },
    { label: 'failed read', timeoutMin: 1, readMs: 10, reply: new Error('read failed'), verdict: 'timeout', head: 'unknown', reads: 1, sleeps: [59990] },
    { label: 'malformed read', timeoutMin: 1, readMs: 10, reply: 'not json', verdict: 'timeout', head: 'unknown', reads: 1, sleeps: [59990] },
    { label: 'read reaches deadline', timeoutMin: 1, readMs: 60000, reply: view(SHA, [run('IN_PROGRESS', '')]), verdict: 'timeout', head: SHA, reads: 1, sleeps: [] },
    { label: 'read exceeds deadline', timeoutMin: 1, readMs: 60001, reply: view(SHA, [run('COMPLETED', 'SUCCESS')]), verdict: 'timeout', head: 'unknown', reads: 1, sleeps: [] },
  ])('uses the remaining deadline budget: $label', ({ timeoutMin, readMs, reply, verdict, head, reads, sleeps }) => {
    let t = 0;
    const readTimes = []; const actualSleeps = []; const lines = [];
    const code = main(['--pr=7', '--repo=o/r', '--check=test', `--timeoutMin=${timeoutMin}`], {
      exec: () => {
        readTimes.push(t);
        t += readMs;
        if (reply instanceof Error) throw reply;
        return reply;
      },
      now: () => t,
      sleep: (ms) => { actualSleeps.push(ms); t += ms; },
      out: (line) => lines.push(line),
    });
    expect(t).toBe(Math.max(timeoutMin * 60000, readMs));
    expect(actualSleeps).toEqual(sleeps);
    expect(readTimes).toHaveLength(reads);
    expect(readTimes.every((time) => time < timeoutMin * 60000)).toBe(true);
    expect(readTimes.slice(1).every((time, i) => time - readTimes[i] >= 60000)).toBe(true);
    expect(code).toBe(verdict === 'check-not-found' ? 4 : 75);
    expect(lines).toEqual([`${verdict} ${head}${verdict === 'timeout' && head === SHA ? ' https://github.com/o/r/actions/runs/99' : ''}`]);
  });
  it.each([false, true])('fails when matching checks contain both success and failure (reversed=%s)', (reversed) => {
    const checks = [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'FAILURE')];
    const h = harness([view(SHA, reversed ? checks.reverse() : checks)]);
    expect(awaitChecks(h.opts, h.io).verdict).toBe('fail');
    expect(h.sleeps).toEqual([]);
  });
  it('does not pass while a rerun of the same check is still running', () => {
    const h = harness([view(SHA, [run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS', '')]), view(SHA, [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SUCCESS')])]);
    const r = awaitChecks(h.opts, h.io);
    expect(r.verdict).toBe('pass');
    expect(h.sleeps).toEqual([60000]);
  });
  it('a read that finishes after the deadline cannot pass', () => {
    let t = 0;
    const io = { exec: () => { t += 3 * 60000; return view(SHA, [run('COMPLETED', 'SUCCESS')]); }, now: () => t, sleep: (ms) => { t += ms; } };
    expect(awaitChecks({ pr: 7, repo: 'o/r', check: 'test', timeoutMin: 1 }, io).verdict).toBe('timeout');
  });
});
