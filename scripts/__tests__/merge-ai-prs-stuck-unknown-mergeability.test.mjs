/**
 * RED contract for merge-ai-prs.mjs (no production changes in this task):
 * - revalidateWithUnknownRetry accepts repo?, num?, onPersistentUnknown and nudge.
 *   Exhausted transient UNKNOWN calls each hook once with {repo,num,verdict};
 *   neither hook's return value authorizes a merge. Other outcomes call neither.
 * - markStuckUnknown(marks,{repo,num,now}) returns a NEW Map keyed by `${repo}#${num}`,
 *   containing {repo,num,since}; repeated marks preserve the first timestamp.
 * - pruneStuckUnknown(marks,{prs}) returns a NEW Map. prs are fresh observations
 *   {repo,num,mergeable,state}; known non-UNKNOWN or CLOSED/MERGED clears a mark.
 *   Absent/unreadable evidence retains it. orderStuckUnknownFirst(prs,marks)
 *   returns a stable, non-mutating partition of {repo,num,...} rows.
 * - repollUnknownListings gains marks: marked listed PRs are read immediately,
 *   before retry sleeps/context/cascade, even if the listing says MERGEABLE.
 * - nudgeMergeability({repo,num,read}) calls read({repo,num,fields:['mergeable']})
 *   exactly once and returns that read's result; it performs no merge/write.
 * - decideStuckUnknownAlert(marks,{now,afterMinutes=30}) returns an array of
 *   {kind:'stuck-unknown-mergeability',repo,num,...} only strictly AFTER the bound.
 * All IO/time is injected; no gh, network, real sleeps, or CLI entry points.
 */
import { describe, it, expect, vi } from 'vitest';
import * as drain from '../merge-ai-prs.mjs';

const REPO = 'example/web';
const HEAD = 'a'.repeat(40);
const MINUTE = 60_000;
const opts = { requiredCheck: 'test', defaultBranch: 'main', expectedHeadSha: HEAD };
const pr = (extra = {}) => ({
  number: 42, title: 'Approved change', body: 'A concrete change summary.',
  headRefName: 'lane/approved', headRefOid: HEAD, baseRefName: 'main', state: 'OPEN',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  commits: [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }],
    messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }],
  ...extra,
});
const unknown = () => pr({ mergeable: 'UNKNOWN' });
const key = (repo, num) => `${repo}#${num}`;
const marksAt = (since = 0) => new Map([[key(REPO, 42), { repo: REPO, num: 42, since }]]);

async function retry(reads, extra = {}) {
  let index = 0;
  const read = vi.fn(async () => reads[Math.min(index++, reads.length - 1)]);
  const sleep = vi.fn(async () => {});
  const onPersistentUnknown = vi.fn();
  const nudge = vi.fn(async () => ({ mergeable: 'MERGEABLE' }));
  const verdict = await drain.revalidateWithUnknownRetry({
    repo: REPO, num: 42, read, opts, sleep, setting: { retries: 3, delayMs: 20_000 },
    onPersistentUnknown, nudge, ...extra,
  });
  return { verdict, read, sleep, onPersistentUnknown, nudge };
}

describe('persistent UNKNOWN recovery stays fail closed', () => {
  it('exhausts exactly 3 retries, marks and nudges once, returning the same UNKNOWN refusal', async () => {
    const result = await retry([unknown()]);
    expect(result.verdict).toEqual(drain.revalidateForMerge(unknown(), opts));
    expect(result.verdict.decision).toBe('skip');
    expect(drain.isTransientUnknownMergeability(result.verdict)).toBe(true);
    expect(result.read).toHaveBeenCalledTimes(4);
    expect(result.sleep.mock.calls).toEqual([[20_000], [20_000], [20_000]]);
    const payload = { repo: REPO, num: 42, verdict: result.verdict };
    expect(result.onPersistentUnknown.mock.calls).toEqual([[payload]]);
    expect(result.nudge.mock.calls).toEqual([[payload]]);
  });

  it('zero retries still escalates a persistent UNKNOWN once without sleeping', async () => {
    const result = await retry([unknown()], { setting: { retries: 0, delayMs: 20_000 } });
    expect(result.verdict.decision).toBe('skip');
    expect(result.read).toHaveBeenCalledTimes(1);
    expect(result.sleep).not.toHaveBeenCalled();
    expect(result.onPersistentUnknown).toHaveBeenCalledTimes(1);
    expect(result.nudge).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['red required check', pr({ statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] })],
    ['head moved', pr({ headRefOid: 'b'.repeat(40) })],
    ['conflict', pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })],
    ['unreadable PR', null],
  ])('%s after UNKNOWN stops retries without marking or nudging', async (_name, fresh) => {
    const result = await retry([unknown(), fresh, pr()]);
    expect(result.verdict).toEqual(drain.revalidateForMerge(fresh, opts));
    expect(result.verdict.decision).toBe('skip');
    expect(result.read).toHaveBeenCalledTimes(2);
    expect(result.onPersistentUnknown).not.toHaveBeenCalled();
    expect(result.nudge).not.toHaveBeenCalled();
  });

  it.each([[pr()], [unknown(), pr()]])('resolved MERGEABLE never marks or nudges (%j)', async (...reads) => {
    const result = await retry(reads);
    expect(result.verdict.decision).toBe('merge');
    expect(result.onPersistentUnknown).not.toHaveBeenCalled();
    expect(result.nudge).not.toHaveBeenCalled();
  });

  it('keeps both hooks optional for existing callers', async () => {
    const result = await retry([unknown()], { onPersistentUnknown: undefined, nudge: undefined });
    expect(result.verdict).toEqual(drain.revalidateForMerge(unknown(), opts));
  });
});

describe('stuck UNKNOWN marks across passes', () => {
  it('exports the pure mark, prune, order, nudge and alert helpers', () => {
    for (const name of ['markStuckUnknown', 'pruneStuckUnknown', 'orderStuckUnknownFirst',
      'nudgeMergeability', 'decideStuckUnknownAlert']) expect(drain[name], name).toBeTypeOf('function');
  });

  it('preserves continuous age and distinguishes the same PR number in different repos', () => {
    const empty = new Map();
    const first = drain.markStuckUnknown(empty, { repo: REPO, num: 42, now: 0 });
    const again = drain.markStuckUnknown(first, { repo: REPO, num: 42, now: 80 * MINUTE });
    const other = drain.markStuckUnknown(again, { repo: 'example/other', num: 42, now: MINUTE });
    expect(empty.size).toBe(0);
    expect(first).not.toBe(again);
    expect(again.get(key(REPO, 42))).toEqual({ repo: REPO, num: 42, since: 0 });
    expect(other.size).toBe(2);
    expect(again.size).toBe(1);
  });

  it.each([
    { mergeable: 'MERGEABLE', state: 'OPEN' },
    { mergeable: 'CONFLICTING', state: 'OPEN' },
    { mergeable: 'UNKNOWN', state: 'CLOSED' },
    { mergeable: 'UNKNOWN', state: 'MERGED' },
  ])('clears a mark after fresh evidence %j without mutating the input', fresh => {
    const marks = marksAt();
    const next = drain.pruneStuckUnknown(marks, { prs: [{ repo: REPO, num: 42, ...fresh }] });
    expect(next.size).toBe(0);
    expect(marks.size).toBe(1);
    const renewed = drain.markStuckUnknown(next, { repo: REPO, num: 42, now: 90 * MINUTE });
    expect(renewed.get(key(REPO, 42)).since).toBe(90 * MINUTE);
  });

  it.each([
    { prs: [] },
    { prs: [{ repo: REPO, num: 42 }] },
    { prs: [{ repo: REPO, num: 42, mergeable: 'UNKNOWN', state: 'OPEN' }] },
    { prs: [{ repo: 'example/other', num: 42, mergeable: 'MERGEABLE' }] },
  ])('retains marks on absent/unreadable/UNKNOWN or unrelated evidence (%j)', ({ prs }) => {
      const marks = marksAt();
      expect(drain.pruneStuckUnknown(marks, { prs })).toEqual(marks);
    });

  it('stably puts marked repo/number pairs first in cascade order without mutating rows', () => {
    const rows = [{ repo: REPO, num: 1 }, { repo: REPO, num: 42 },
      { repo: 'example/other', num: 42 }, { repo: REPO, num: 7 }];
    const marks = drain.markStuckUnknown(marksAt(), { repo: REPO, num: 7, now: 1 });
    const original = [...rows];
    expect(drain.orderStuckUnknownFirst(rows, marks)).toEqual([rows[1], rows[3], rows[0], rows[2]]);
    expect(rows).toEqual(original);
  });

  it('re-reads marked PRs at next pass start before waits, context and cascade', async () => {
    const events = [];
    const rows = new Map([[REPO, [pr({ number: 1 }), pr()]]]);
    const read = vi.fn(async (repo, num) => { events.push(`read:${repo}#${num}`); return pr(); });
    await drain.repollThenCollectContext({
      repoll: () => drain.repollUnknownListings({ prsByRepo: rows, marks: marksAt(), read,
        setting: { retries: 3, delayMs: 20_000 }, sleep: async () => { events.push('sleep'); } }),
      collect: () => { events.push('context'); },
    });
    events.push('cascade');
    expect(events).toEqual([`read:${REPO}#42`, 'context', 'cascade']);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('operator fallback for a continuously stuck UNKNOWN', () => {
  it('defaults to 30 minutes, with a strict threshold and a distinct non-red-main kind', () => {
    const marks = marksAt();
    expect(drain.decideStuckUnknownAlert(marks, { now: 30 * MINUTE })).toEqual([]);
    const alerts = drain.decideStuckUnknownAlert(marks, { now: 30 * MINUTE + 1 });
    expect(alerts).toEqual([expect.objectContaining({ kind: 'stuck-unknown-mergeability', repo: REPO, num: 42 })]);
    expect(JSON.stringify(alerts)).not.toContain('red-main');
    expect(marks).toEqual(marksAt());
  });

  it('uses configured continuous age; an 80-minute stuck PR alerts while fresh marks do not', () => {
    const marks = new Map([...marksAt(), [key(REPO, 7), { repo: REPO, num: 7, since: 75 * MINUTE }]]);
    expect(drain.decideStuckUnknownAlert(marks, { now: 80 * MINUTE, afterMinutes: 10 }))
      .toEqual([expect.objectContaining({ kind: 'stuck-unknown-mergeability', num: 42 })]);
    expect(drain.decideStuckUnknownAlert(new Map(), { now: 80 * MINUTE })).toEqual([]);
  });
});

it('nudges recomputation with one injected mergeable-only read, even when still UNKNOWN', async () => {
  const result = { mergeable: 'UNKNOWN' };
  const read = vi.fn(async () => result);
  expect(await drain.nudgeMergeability({ repo: REPO, num: 42, read })).toBe(result);
  expect(read.mock.calls).toEqual([[{ repo: REPO, num: 42, fields: ['mergeable'] }]]);
});
