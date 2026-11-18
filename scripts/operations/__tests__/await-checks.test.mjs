import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireGhSlotSync, ghPointsBudgetStatePath, resetPersonalGhTokenCacheForTest, runGhCliPassthrough, GH_OUTER_INV_ENV, GH_OUTER_TIMEOUT_ENV, GH_OUTER_KILL_SIGNAL_ENV } from '../../lib/gh-throttle.mjs';
import { readGhSlotHolders } from '../../lib/gh-throttle-holders.mjs';
import { awaitChecks, parseArgs, main, EXIT } from '../await-checks.mjs';

// Inject only the subprocess boundary; the operation's default executor and
// shared throttle stay real, including credential discovery and retry handling.
// Pass a function explicitly: a module mock may miss cached throttle imports.
const childExec = vi.fn();

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
      childExec, now: () => t, sleep, out: (line) => lines.push(line),
    });
    return { code, lines };
  };
  beforeEach(() => {
    resetPersonalGhTokenCacheForTest();
    root = mkdtempSync(join(tmpdir(), 'await-checks-deadline-'));
    t = 0; calls = []; sleeps = [];
    vi.stubEnv('WE_GH_THROTTLE_LOCK_ROOT', root);
    vi.stubEnv('WE_GH_THROTTLE_PERSONAL_ROUTE', '0');
    vi.stubEnv('WE_GH_JSON_RETRIES', '1');
    vi.stubEnv('WE_GH_JSON_RETRY_BACKOFF_MS', '2000');
    vi.stubEnv('WE_GH_THROTTLE_CAP', '1');
    vi.stubEnv('WE_GH_THROTTLE_COST_HEADERS', '0');
    vi.spyOn(Date, 'now').mockImplementation(() => epoch + t);
    vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, ms) => { sleep(ms); return 'timed-out'; });
    childExec.mockReset().mockImplementation(() => {
      throw new Error('unexpected subprocess in await-checks fixture');
    });
  });
  afterEach(() => {
    resetPersonalGhTokenCacheForTest();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const fail = (message) => Object.assign(new Error(message), { status: 1, stderr: message });

  it('passes through the worker shim with cap=1 while the outer slot is held, preserving execution limits', () => {
    const outer = [];
    const nestedSpawn = vi.fn(() => ({
      status: 0, stdout: Buffer.from(view(SHA, [run('COMPLETED', 'SUCCESS')])), stderr: Buffer.alloc(0),
    }));
    const nestedSleep = vi.fn();
    childExec.mockImplementation((file, args, opts) => {
      outer.push({ file, opts, holders: readGhSlotHolders({ lockRoot: root, cap: 1, nowMs: epoch + t }) });
      const result = runGhCliPassthrough(args, {
        throttle: {
          lockRoot: root, env: { ...process.env, ...opts.env, WE_GH_THROTTLE_ON_SLOT_TIMEOUT: 'throttled' },
          acquireTimeoutMs: 0, personalRoute: false, sleep: nestedSleep, warn: () => {},
        },
        spawn: nestedSpawn,
      });
      if (result.status !== 0) throw fail(String(result.stderr));
      return result.stdout.toString();
    });

    expect(invoke()).toEqual({ code: 0, lines: [`pass ${SHA} https://github.com/o/r/actions/runs/99`] });
    expect(outer).toHaveLength(1);
    expect(outer[0].file).toBe('gh');
    expect(outer[0].opts).not.toHaveProperty('throttle');
    expect(outer[0].holders).toHaveLength(1);
    expect(outer[0].opts.env).toMatchObject({
      [GH_OUTER_INV_ENV]: expect.any(String),
      [GH_OUTER_TIMEOUT_ENV]: '60000',
      [GH_OUTER_KILL_SIGNAL_ENV]: 'SIGKILL',
    });
    expect(nestedSpawn).toHaveBeenCalledTimes(1);
    expect(nestedSpawn.mock.calls[0][2]).toMatchObject({ timeout: 60000, killSignal: 'SIGKILL' });
    expect(nestedSleep).not.toHaveBeenCalled();
    expect(readGhSlotHolders({ lockRoot: root, cap: 1, nowMs: epoch + t })).toEqual([]);
  });

  it('bounds personal credential lookup by the operation deadline', () => {
    vi.stubEnv('WE_GH_THROTTLE_PERSONAL_ROUTE', '1');
    vi.stubEnv('WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS', 'reads');
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    childExec.mockImplementation((_file, args, opts) => {
      calls.push({ args, timeout: opts.timeout, killSignal: opts.killSignal });
      if (args[0] === 'auth') {
        t += opts.timeout ?? 120000;
        throw fail('credential lookup timed out');
      }
      return view(SHA, [run('COMPLETED', 'SUCCESS')]);
    });
    expect(invoke()).toEqual({ code: 75, lines: ['timeout unknown'] });
    expect(t).toBe(60000);
    expect(calls).toEqual([{ args: ['auth', 'token'], timeout: 60000, killSignal: 'SIGKILL' }]);
  });
  it.each([true, false])('subtracts credential lookup time from the read budget (token found=%s)', (found) => {
    vi.stubEnv('WE_GH_THROTTLE_PERSONAL_ROUTE', '1');
    vi.stubEnv('WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS', 'reads');
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    childExec.mockImplementation((_file, args, opts) => {
      calls.push({ args, timeout: opts.timeout });
      if (args[0] === 'auth') { t += 10000; return found ? 'gho_fixture' : ''; }
      return view(SHA, [run('COMPLETED', 'SUCCESS')]);
    });
    expect(invoke().code).toBe(0);
    expect(calls.map(c => c.timeout)).toEqual([60000, 50000]);
  });
  it('shares the deadline and output bound across rollup, REST pages, and head recheck', () => {
    childExec.mockImplementation((_file, args, opts) => {
      calls.push({ args, timeout: opts.timeout, maxBuffer: opts.maxBuffer });
      if (args[0] === 'api') {
        t += 30000;
        return JSON.stringify([{ check_runs: [{ id: 1, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success' }] }]);
      }
      t += 5000;
      return view(SHA, Array.from({ length: 100 }, () => run('COMPLETED', 'SUCCESS')));
    });
    expect(invoke().code).toBe(0);
    expect(calls.map(c => c.timeout)).toEqual([60000, 55000, 25000]);
    expect(calls.every(c => c.maxBuffer === 4 * 1024 * 1024)).toBe(true);
  });
  it('cannot pass cached rollup success when paginated output exceeds the buffer limit', () => {
    childExec.mockImplementation((_file, args) => {
      if (args[0] === 'api') throw Object.assign(new Error('buffer exceeded'), { code: 'ENOBUFS' });
      return view(SHA, Array.from({ length: 100 }, () => run('COMPLETED', 'SUCCESS')));
    });
    expect(invoke()).toEqual({ code: 75, lines: [`timeout ${SHA}`] });
  });

  it.each(['HTTP 504: Gateway Timeout', 'unexpected end of JSON input'])(
    'caps retry backoff at the deadline and starts no late read: %s', (message) => {
      childExec.mockImplementation((_file, _args, opts) => {
        calls.push({ at: t, timeout: opts.timeout });
        t += calls.length === 1 ? 59999 : opts.timeout;
        throw fail(message);
      });
      expect(invoke()).toEqual({ code: 75, lines: ['timeout unknown'] });
      expect({ elapsed: t, calls, sleeps }).toEqual({ elapsed: 60000, calls: [{ at: 0, timeout: 60000 }], sleeps: [1] });
    },
  );
  it('recomputes the subprocess timeout after retry backoff', () => {
    childExec.mockImplementation((_file, _args, opts) => {
      calls.push({ at: t, timeout: opts.timeout });
      t += calls.length === 1 ? 10000 : opts.timeout;
      throw fail('HTTP 504: Gateway Timeout');
    });
    expect(invoke().code).toBe(75);
    expect({ elapsed: t, calls }).toEqual({ elapsed: 60000, calls: [{ at: 0, timeout: 60000 }, { at: 12000, timeout: 48000 }] });
  });
  it('still accepts a successful retry completed within the deadline', () => {
    childExec.mockImplementation((_file, _args, opts) => {
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
    childExec.mockImplementation(() => view(SHA, [run('COMPLETED', 'SUCCESS')]));
    expect(invoke(0.5)).toEqual({ code: 75, lines: ['timeout unknown'] });
    expect(t).toBe(30000);
    expect(childExec).not.toHaveBeenCalled();
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

  // IDs establish creation order. CheckRun is authoritative over a same-name
  // legacy context, per the shared resolver; ID-less duplicates use REST below.
  const reruns = [
    { label: 'running CheckRun', check: run('IN_PROGRESS', ''), rank: 2 },
    { label: 'successful CheckRun', check: run('COMPLETED', 'SUCCESS'), rank: 0 },
    { label: 'failed CheckRun', check: run('COMPLETED', 'FAILURE'), rank: 1 },
    { label: 'pending StatusContext', check: context('PENDING'), rank: 2 },
    { label: 'successful StatusContext', check: context('SUCCESS'), rank: 0 },
    { label: 'failed StatusContext', check: context('ERROR'), rank: 1 },
  ];
  it.each(reruns.flatMap(a => reruns.map(b => ({
    label: `${a.label} then ${b.label}`, checks: [{ ...a.check, id: 1 }, { ...b.check, id: 2 }],
    verdict: ['pass', 'fail', 'timeout'][a.check.__typename === 'CheckRun' && b.check.__typename === 'StatusContext' ? a.rank : b.rank],
  }))))('resolves the current check for $label', ({ checks, verdict }) => {
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
  it('reports check-not-yet-created-timeout, naming the checks seen, when the named check never appears', () => {
    const h = harness(Array.from({ length: 5 }, () => [view(SHA, [run('COMPLETED', 'SUCCESS', 'lint')]), JSON.stringify([{ check_runs: [] }]), '[[]]']).flat());
    const r = awaitChecks(h.opts, h.io);
    expect(r.verdict).toBe('check-not-yet-created-timeout');
    expect(r.seenNames).toEqual(['lint']);
  });
  it('waits while the aggregate check is absent, then returns its conclusion once created', () => {
    const none = [JSON.stringify([{ check_runs: [] }]), '[[]]'];
    const h = harness([
      view(SHA, [run('IN_PROGRESS', '', 'test-shard (1)')]), ...none,
      view(SHA, [run('IN_PROGRESS', '', 'test-shard (1)')]), ...none,
      view(SHA, [run('IN_PROGRESS', '')]),
      view(SHA, [run('COMPLETED', 'SUCCESS')]),
    ]);
    const r = awaitChecks({ ...h.opts, timeoutMin: 10 }, h.io);
    expect(r).toMatchObject({ verdict: 'pass', head: SHA });
    expect(h.sleeps).toEqual([60000, 60000, 60000]);
  });
  it('maps the new timeout to its own exit code, keeping pass/fail/head-moved/timeout codes', () => {
    expect(EXIT).toMatchObject({ pass: 0, fail: 1, 'head-moved': 3, 'check-not-found': 4, timeout: 75, 'check-not-yet-created-timeout': 5 });
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
  it.each([false, true].flatMap(capped => [false, true].flatMap(reversed => [false, true].map(newerFailed => ({
    capped, reversed, newerFailed,
  })))))('orders overlapping reruns by creation id, not completion (capped=$capped reversed=$reversed newerFailed=$newerFailed)', ({ capped, reversed, newerFailed }) => {
    const checks = [
      { ...run('COMPLETED', newerFailed ? 'SUCCESS' : 'FAILURE'), startedAt: '2026-11-16T08:00:00Z', completedAt: '2026-11-16T10:00:00Z' },
      { ...run('COMPLETED', newerFailed ? 'FAILURE' : 'SUCCESS'), startedAt: '2026-11-16T09:00:00Z', completedAt: '2026-11-16T09:30:00Z' },
    ];
    const rest = checks.map((c, i) => ({
      id: i + 1, name: c.name, head_sha: SHA, status: 'completed', conclusion: c.conclusion.toLowerCase(),
      started_at: c.startedAt, completed_at: c.completedAt, html_url: `https://ci.example/${i + 1}`,
    }));
    if (reversed) { checks.reverse(); rest.reverse(); }
    if (capped) checks.push(...Array.from({ length: 98 }, (_, i) => run('COMPLETED', 'SUCCESS', `other-${i}`)));
    const h = harness([view(SHA, checks), JSON.stringify([{ check_runs: rest }]), view(SHA, [])]);
    const lines = [];
    expect(main(['--pr=7', '--repo=o/r', '--check=test'], { ...h.io, out: line => lines.push(line) })).toBe(newerFailed ? 1 : 0);
    expect(lines).toEqual([`${newerFailed ? 'fail' : 'pass'} ${SHA} https://ci.example/2`]);
    expect(h.calls).toHaveLength(3);
  });
  it.each([new Error('read failed'), 'not json', '[]'])('cannot certify ambiguous uncapped success after a failed authoritative read: %s', (reply) => {
    const h = harness([view(SHA, [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SUCCESS')]), reply]);
    expect(awaitChecks({ ...h.opts, timeoutMin: 1 }, h.io).verdict).toBe('timeout');
  });
  it('main accepts a successful rerun after its superseded failure', () => {
    const h = harness([view(SHA, [run('COMPLETED', 'FAILURE'), run('COMPLETED', 'SUCCESS')]), JSON.stringify([{ check_runs: [
      { id: 1, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/99' },
    ] }]), view(SHA, [])]);
    const lines = [];
    expect(main(['--pr=7', '--repo=o/r', '--check=test'], { ...h.io, out: line => lines.push(line) })).toBe(0);
    expect(lines).toEqual([`pass ${SHA} https://github.com/o/r/actions/runs/99`]);
  });
  it('fetches all check-run pages before certifying a capped rollup', () => {
    const capped = [run('COMPLETED', 'SUCCESS'), ...Array.from({ length: 99 }, (_, i) => run('COMPLETED', 'SUCCESS', `other-${i}`))];
    const rest = (id, conclusion) => ({ id, name: 'test', head_sha: SHA, status: 'completed', conclusion, html_url: `https://ci.example/${id}` });
    const h = harness([view(SHA, capped), JSON.stringify([{ check_runs: [rest(1, 'success')] }, { check_runs: [rest(2, 'failure')] }]), view(SHA, [])]);
    expect(awaitChecks(h.opts, h.io)).toMatchObject({ verdict: 'fail', head: SHA, url: 'https://ci.example/2' });
    expect(h.calls[1]).toEqual(['gh', 'api', `repos/o/r/commits/${SHA}/check-runs?check_name=test&filter=latest&per_page=100`, '--paginate', '--slurp']);
  });
  it.each([false, true])('uses REST creation order for ID-less completed reruns (reversed=%s)', (reversed) => {
    const checks = [
      { ...run('COMPLETED', 'FAILURE'), completedAt: '2026-11-16T08:00:00Z' },
      { ...run('COMPLETED', 'SUCCESS'), completedAt: '2026-11-16T09:00:00Z', detailsUrl: 'https://ci.example/new' },
    ];
    const h = harness([view(SHA, reversed ? checks.reverse() : checks), JSON.stringify([{ check_runs: [
      { id: 1, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success', html_url: 'https://ci.example/new' },
    ] }]), view(SHA, [])]);
    expect(awaitChecks(h.opts, h.io)).toMatchObject({ verdict: 'pass', url: 'https://ci.example/new' });
  });
  it.each([false, true])('resolves duplicate legacy contexts from every status page by id (capped=%s)', (capped) => {
    const checks = [context('SUCCESS'), context('SUCCESS')];
    if (capped) checks.push(...Array.from({ length: 98 }, (_, i) => run('COMPLETED', 'SUCCESS', `other-${i}`)));
    const h = harness([view(SHA, checks), JSON.stringify([{ check_runs: [] }]), JSON.stringify([
      [{ id: 9, context: 'test', state: 'failure', target_url: 'https://ci.example/new' }],
      [{ id: 1, context: 'test', state: 'success', target_url: 'https://ci.example/old' }],
    ]), view(SHA, [])]);
    expect(awaitChecks(h.opts, h.io)).toMatchObject({ verdict: 'fail', url: 'https://ci.example/new' });
    expect(h.calls[2]).toEqual(['gh', 'api', `repos/o/r/commits/${SHA}/statuses?per_page=100`, '--paginate', '--slurp']);
  });
  it.each([
    new Error('read failed'), 'not json', '[]', JSON.stringify([{ check_runs: null }]),
    JSON.stringify([{ check_runs: [{ id: 1, name: 'test', head_sha: OTHER, status: 'completed', conclusion: 'success' }] }]),
  ])('never passes a capped success when the complete read fails: %s', (reply) => {
    const checks = Array.from({ length: 100 }, () => run('COMPLETED', 'SUCCESS'));
    const h = harness([view(SHA, checks), reply]);
    expect(awaitChecks({ ...h.opts, timeoutMin: 1 }, h.io).verdict).toBe('timeout');
  });
  it.each([new Error('status read failed'), '[]', '[{}]', '[[{}]]'])('does not trust capped status success after malformed REST evidence: %s', (reply) => {
    const checks = Array.from({ length: 100 }, () => context('SUCCESS'));
    const h = harness([view(SHA, checks), JSON.stringify([{ check_runs: [] }]), reply]);
    expect(awaitChecks({ ...h.opts, timeoutMin: 1 }, h.io).verdict).toBe('timeout');
  });
  it('does not pass a REST fallback that finishes past the shared deadline', () => {
    let t = 0;
    const calls = [];
    const result = awaitChecks({ pr: 7, repo: 'o/r', check: 'test', timeoutMin: 1 }, {
      now: () => t, sleep: ms => { t += ms; }, exec: (_file, args) => {
        calls.push(args);
        if (args[0] === 'pr') return view(SHA, Array.from({ length: 100 }, () => run('COMPLETED', 'SUCCESS')));
        t = 60001;
        return JSON.stringify([{ check_runs: [{ id: 1, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success' }] }]);
      },
    });
    expect(result.verdict).toBe('timeout');
    expect(calls).toHaveLength(2);
  });
  it.each([false, true].flatMap(capped => [
    { status: 'completed', conclusion: 'success', head: SHA, verdict: 'pass' },
    { status: 'in_progress', conclusion: null, head: SHA, verdict: 'timeout' },
    { status: 'completed', conclusion: 'success', head: OTHER, verdict: 'head-moved' },
    { status: 'completed', conclusion: 'success', head: 'invalid', verdict: 'timeout' },
  ].map(row => ({ ...row, capped }))))('resolves complete evidence and rechecks head: $status $head capped=$capped', ({ status, conclusion, head, verdict, capped }) => {
    const checks = Array.from({ length: capped ? 100 : 2 }, () => run('COMPLETED', 'FAILURE'));
    const h = harness([view(SHA, checks), JSON.stringify([{ check_runs: [
      { id: 2, name: 'test', head_sha: SHA, status, conclusion, html_url: 'https://ci.example/current' },
    ] }]), view(head, [])]);
    expect(awaitChecks({ ...h.opts, timeoutMin: 1 }, h.io).verdict).toBe(verdict);
    expect(h.calls).toHaveLength(status === 'in_progress' ? 2 : 3);
  });
  it.each([
    { label: 'running check, one-minute budget', timeoutMin: 1, readMs: 10, reply: view(SHA, [run('IN_PROGRESS', '')]), verdict: 'timeout', head: SHA, reads: 1, sleeps: [59990] },
    { label: 'running check, final partial interval', timeoutMin: 2, readMs: 10, reply: view(SHA, [run('IN_PROGRESS', '')]), verdict: 'timeout', head: SHA, reads: 2, sleeps: [60000, 59980] },
    { label: 'missing check', timeoutMin: 1, readMs: 10, reply: view(SHA, []), verdict: 'check-not-yet-created-timeout', head: SHA, reads: 3, sleeps: [59970] },
    { label: 'failed read', timeoutMin: 1, readMs: 10, reply: new Error('read failed'), verdict: 'timeout', head: 'unknown', reads: 1, sleeps: [59990] },
    { label: 'malformed read', timeoutMin: 1, readMs: 10, reply: 'not json', verdict: 'timeout', head: 'unknown', reads: 1, sleeps: [59990] },
    { label: 'read reaches deadline', timeoutMin: 1, readMs: 60000, reply: view(SHA, [run('IN_PROGRESS', '')]), verdict: 'timeout', head: SHA, reads: 1, sleeps: [] },
    { label: 'read exceeds deadline', timeoutMin: 1, readMs: 60001, reply: view(SHA, [run('COMPLETED', 'SUCCESS')]), verdict: 'timeout', head: 'unknown', reads: 1, sleeps: [] },
  ])('uses the remaining deadline budget: $label', ({ timeoutMin, readMs, reply, verdict, head, reads, sleeps }) => {
    let t = 0;
    const readTimes = []; const pollTimes = []; const actualSleeps = []; const lines = [];
    const code = main(['--pr=7', '--repo=o/r', '--check=test', `--timeoutMin=${timeoutMin}`], {
      exec: (_file, args) => {
        readTimes.push(t);
        if (args[0] === 'pr') pollTimes.push(t);
        t += readMs;
        if (reply instanceof Error) throw reply;
        if (args[0] === 'api') return JSON.stringify(args[1].includes('/check-runs?') ? [{ check_runs: [] }] : [[]]);
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
    // Supplemental pages belong to one poll; only repeated PR polls have a floor.
    expect(pollTimes.slice(1).every((time, i) => time - pollTimes[i] >= 60000)).toBe(true);
    expect(code).toBe(verdict === 'check-not-yet-created-timeout' ? 5 : 75);
    expect(lines).toEqual([`${verdict} ${head}${verdict === 'timeout' && head === SHA ? ' https://github.com/o/r/actions/runs/99' : ''}`]);
  });
  it.each([false, true])('fails when the newer rerun failed after a success (reversed=%s)', (reversed) => {
    const checks = [{ ...run('COMPLETED', 'SUCCESS'), id: 1 }, { ...run('COMPLETED', 'FAILURE'), id: 2 }];
    const h = harness([view(SHA, reversed ? checks.reverse() : checks)]);
    expect(awaitChecks(h.opts, h.io).verdict).toBe('fail');
    expect(h.sleeps).toEqual([]);
  });
  it('does not pass while a rerun of the same check is still running', () => {
    const h = harness([
      view(SHA, [run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS', '')]),
      JSON.stringify([{ check_runs: [{ id: 2, name: 'test', head_sha: SHA, status: 'in_progress', conclusion: null }] }]),
      view(SHA, [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SUCCESS')]),
      JSON.stringify([{ check_runs: [{ id: 2, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success' }] }]),
      view(SHA, []),
    ]);
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
