import { describe, it, expect } from 'vitest';
import { awaitChecks, parseArgs, main } from '../await-checks.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const view = (head, checks) => JSON.stringify({ headRefOid: head, url: 'https://github.com/o/r/pull/7', statusCheckRollup: checks });
const run = (status, conclusion, name = 'test') => ({ __typename: 'CheckRun', name, status, conclusion, detailsUrl: 'https://github.com/o/r/actions/runs/99' });

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
