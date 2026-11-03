/**
 * @file scripts/lib/__tests__/gh-list-retry.test.mjs
 * @description A transient 5xx on an open-PR list is retried with backoff; a persistent failure is rethrown
 * (never an empty list / "0 owed") and, after several in a row, raises a `gh-list-failed` health event.
 */
import { describe, it, expect, vi } from 'vitest';
import { withListRetry } from '../gh-list-retry.mjs';

const e504 = () => Object.assign(new Error('gh pr list failed'), { stderr: 'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)' });
const wrapped504 = () => Object.assign(new Error('open-PR list unreadable'), { cause: e504() });
const mk = () => ({ sleep: vi.fn(), events: [], streaks: new Map() });
const run = (fn, o, extra = {}) => withListRetry(fn, { repo: 'o/r', op: 'reconcile', sleep: o.sleep,
  streaks: o.streaks, persist: false, onEvent: ev => o.events.push(ev), ...extra });

describe('withListRetry', () => {
  it('retries a 504 with growing backoff and returns the eventual rows', () => {
    const o = mk(); let n = 0;
    const out = run(() => { if (++n < 3) throw e504(); return [{ number: 1 }]; }, o);
    expect(out).toEqual([{ number: 1 }]);
    expect(n).toBe(3);
    expect(o.sleep.mock.calls.map(c => c[0])).toEqual([500, 1500]);
    expect(o.events).toEqual([]);
  });
  it('retries a wrapped (cause-chain) 502/503 too, but never a non-transient error', () => {
    const o = mk(); let n = 0;
    expect(run(() => { if (++n < 2) throw wrapped504(); return []; }, o)).toEqual([]);
    const o2 = mk(); let m = 0;
    expect(() => run(() => { m++; throw new Error('HTTP 401: Bad credentials'); }, o2)).toThrow(/401/);
    expect(m).toBe(1);
  });
  it('a persistent failure is rethrown, never turned into an empty list', () => {
    const o = mk(); let n = 0, err;
    try { run(() => { n++; throw e504(); }, o); } catch (e) { err = e; }
    expect(String(err?.stderr)).toMatch(/504/);
    expect(n).toBe(3);
  });
  it('emits gh-list-failed once the failure repeats several calls in a row, and a success resets the streak', () => {
    const o = mk();
    const fail = () => { try { run(() => { throw e504(); }, o); } catch { /* surfaced */ } };
    fail(); fail();
    expect(o.events).toEqual([]);
    fail();
    expect(o.events).toHaveLength(1);
    expect(o.events[0]).toMatchObject({ kind: 'gh-list-failed', repo: 'o/r', detail: { op: 'reconcile', consecutive: 3 } });
    run(() => [], o);
    fail(); fail();
    expect(o.events).toHaveLength(1);
  });
});
