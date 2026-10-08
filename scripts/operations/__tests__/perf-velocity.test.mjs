/**
 * @file perf-velocity.test.mjs - held card 129: velocity in perf-snapshot. Pure decisions only; the git/model
 * shell is pinned in `perf-velocity-io.test.mjs`.
 */
import { describe, expect, it } from 'vitest';

import {
  buildCardIndex, calibrationStats, classifyMerges, prActualPoints, estimatedPointEvents, etParts, parseNameLog, parsePatchLog,
  realPointEvents, resolveEvents, snapFibonacci, velocityMetrics, ESTIMATED_SOURCE,
} from '../perf-velocity.mjs';
import { diffSnapshots, formatDiff, judge } from '../perf-snapshot.mjs';

const card = (name, fm) => ({ name, text: `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n# t\n` });
const sha = (n) => String(n).padStart(40, '0');
const patch = (hash, at, subject, files) => `\x01${hash}\t${at}\t${subject}\n\n${files.map((f) => [
  `diff --git a/${f.old ?? f.path} b/${f.path}`, ...(f.old ? [`rename from ${f.old}`, `rename to ${f.path}`] : []),
  `--- a/${f.old ?? f.path}`, `+++ b/${f.path}`, '@@ -1,0 +1,1 @@', ...(f.lines ?? []),
].join('\n')).join('\n')}\n`;

describe('resolve detection follows a card through its JIT rename', () => {
  const index = buildCardIndex([
    card('5319-pre-pr.md', { bornAs: 'xsjn0uf', kind: 'story', size: 3, status: 'resolved' }),
    card('5400-direct.md', { kind: 'story', size: 5, status: 'resolved' }),
    card('5401-no-size.md', { kind: 'story', status: 'resolved' }),
  ]);

  it('counts a card that resolved as x<hash> and was renamed to NNN (delete + add) exactly once, at the first resolve', () => {
    const log = parsePatchLog([
      patch(sha(1), '2026-10-07T14:00:00Z', 'Merge pull request #1 from x/lane/a', [{ path: 'backlog/xsjn0uf-pre-pr.md', lines: ['+status: resolved'] }]),
      // the drain's JIT numbering as git may show it without rename detection: a delete and an add
      patch(sha(2), '2026-10-07T15:00:00Z', 'drain: JIT-number xsjn0uf', [
        { path: 'backlog/xsjn0uf-pre-pr.md', lines: ['-status: resolved'] },
        { path: 'backlog/5319-pre-pr.md', lines: ['+bornAs: xsjn0uf', '+status: resolved'] },
      ]),
    ].join(''));
    const ev = resolveEvents(log, index);
    expect(ev).toEqual([{ id: 'xsjn0uf', at: '2026-10-07T14:00:00Z', hash: sha(1), size: 3 }]);
  });

  it('counts a card born open as x<hash>, numbered at land, resolved later under its NNN path (the bornAs link)', () => {
    const log = parsePatchLog([
      patch(sha(1), '2026-10-07T14:00:00Z', 'Merge pull request #1 from x/lane/a', [{ path: 'backlog/xsjn0uf-pre-pr.md', lines: ['+status: open'] }]),
      patch(sha(2), '2026-10-07T15:00:00Z', 'drain: JIT-number', [{ old: 'backlog/xsjn0uf-pre-pr.md', path: 'backlog/5319-pre-pr.md', lines: ['+bornAs: xsjn0uf'] }]),
      patch(sha(3), '2026-10-07T18:30:00Z', 'Merge pull request #2 from x/lane/b', [{ path: 'backlog/5319-pre-pr.md', lines: ['-status: open', '+status: resolved'] }]),
    ].join(''));
    expect(resolveEvents(log, index)).toEqual([{ id: 'xsjn0uf', at: '2026-10-07T18:30:00Z', hash: sha(3), size: 3 }]);
  });

  it('a pure rename of an already-resolved card is not a second resolve', () => {
    const log = parsePatchLog([
      patch(sha(1), '2026-10-07T14:00:00Z', 'm', [{ path: 'backlog/xsjn0uf-pre-pr.md', lines: ['+status: resolved'] }]),
      patch(sha(2), '2026-10-07T15:00:00Z', 'm', [{ old: 'backlog/xsjn0uf-pre-pr.md', path: 'backlog/5319-pre-pr.md', lines: ['+bornAs: xsjn0uf'] }]),
    ].join(''));
    expect(resolveEvents(log, index)).toHaveLength(1);
  });

  it('keeps an unsized resolve as size null (never zero, never guessed) and a reopen does not count', () => {
    const log = parsePatchLog([
      patch(sha(1), '2026-10-07T14:00:00Z', 'm', [{ path: 'backlog/5401-no-size.md', lines: ['+status: resolved'] }]),
      patch(sha(2), '2026-10-07T15:00:00Z', 'm', [{ path: 'backlog/5400-direct.md', lines: ['-status: resolved', '+status: open'] }]),
    ].join(''));
    expect(resolveEvents(log, index)).toEqual([{ id: '5401', at: '2026-10-07T14:00:00Z', hash: sha(1), size: null }]);
    expect(realPointEvents(resolveEvents(log, index))).toEqual([]);
  });
});

describe('merges: code vs card-only (ci-card-only definition) and sized-card coverage', () => {
  const index = buildCardIndex([card('5400-direct.md', { kind: 'story', size: 5, status: 'resolved' })]);
  const merges = classifyMerges(parseNameLog([
    `\x01${sha(1)}\t2026-10-07T14:10:00Z\tMerge pull request #10 from x/lane/a\n\nbacklog/5400-direct.md\nscripts/a.mjs\n`,
    `\x01${sha(2)}\t2026-10-07T14:20:00Z\tMerge pull request #11 from x/lane/b\n\nbacklog/5400-direct.md\n`,
    `\x01${sha(3)}\t2026-10-07T14:30:00Z\tMerge pull request #12 from x/lane/c\n\nscripts/b.mjs\n`,
    `\x01${sha(4)}\t2026-10-07T14:40:00Z\tdrain: JIT-number xsjn0uf→#5319 at land (#2288)\n\nbacklog/5400-direct.md\n`,
    `\x01${sha(5)}\t2026-10-07T14:50:00Z\tMerge pull request #12 from x/lane/c again\n\nscripts/b.mjs\n`,
  ].join('')), index);

  it('splits code from card-only, skips non-PR commits, and marks a PR that touches a sized card as covered', () => {
    expect(merges.map((m) => [m.pr, m.kind, m.covered])).toEqual([[10, 'code', true], [11, 'card-only', true], [12, 'code', false]]);
  });

  it('estimates only the uncovered code PRs, from the estimate rows', () => {
    const est = new Map([[10, { size: 8 }], [11, { size: 8 }], [12, { size: 3 }]]);
    expect(estimatedPointEvents(merges, est)).toEqual([{ at: '2026-10-07T14:30:00Z', points: 3 }]);
  });
});

describe('velocity metrics: ET buckets, real and estimated kept apart', () => {
  const window = { since: '2026-10-07T04:00:00Z', until: '2026-10-08T04:00:00Z' };
  const now = '2026-10-08T01:00:00Z'; // 21:00 EDT on 2026-10-07
  const events = [
    { id: 'a', at: '2026-10-07T01:00:00Z', size: 5 }, // 21:00 ET on the 6th: yesterday
    { id: 'b', at: '2026-10-07T14:00:00Z', size: 3 }, // 10:00 ET
    { id: 'c', at: '2026-10-07T14:30:00Z', size: 2 }, // 10:30 ET
  ];
  const merges = [
    { pr: 1, at: '2026-10-07T14:00:00Z', kind: 'code', covered: false },
    { pr: 2, at: '2026-10-07T14:05:00Z', kind: 'code', covered: false },
    { pr: 3, at: '2026-10-07T15:00:00Z', kind: 'card-only', covered: false },
  ];
  const m = velocityMetrics({ events, merges, estimates: new Map([[1, { size: 5 }]]), window, now });

  it('uses the ET calendar day, not UTC', () => {
    expect(etParts('2026-10-07T01:00:00Z')).toEqual({ date: '2026-10-06', hour: 21 });
    expect(m['velocity.points.yesterday.real'].v).toBe(5);
    expect(m['velocity.points.today.real'].v).toBe(5);
  });

  it('reports points per day and per hour over the window, with the peak ET hour', () => {
    expect(m['velocity.points.perDay.real'].v).toBe(5); // 3 + 2 inside the window, 24 h
    expect(m['velocity.points.perHour.real'].v).toBe(0.21);
    expect(m['velocity.points.peakHour.real'].v).toBe(5);
  });

  it('keeps estimated points under their own keys and source, never added to real', () => {
    expect(m['velocity.points.today.estimated']).toEqual({ v: 5, unit: 'pts', source: ESTIMATED_SOURCE });
    expect(m['velocity.points.today.real'].source).toBe('computed');
    expect(m['velocity.points.perDay.real'].v).toBe(5);
  });

  it('counts PRs merged per hour, code vs card-only, and the PRs still missing an estimate', () => {
    expect(m['velocity.prs.code.merged'].v).toBe(2);
    expect(m['velocity.prs.cardOnly.merged'].v).toBe(1);
    expect(m['velocity.prs.code.perHour'].v).toBe(0.08);
    expect(m['velocity.estimate.missingPrs'].v).toBe(1);
  });
});

describe('the snapshot diff labels real vs estimated points', () => {
  const row = (real, est) => ({ metrics: {
    'velocity.points.perDay.real': { v: real, unit: 'pts/day', source: 'computed' },
    'velocity.points.perDay.estimated': { v: est, unit: 'pts/day', source: ESTIMATED_SOURCE },
    'velocity.prs.code.perHour': { v: 2, unit: 'PRs/h', source: 'computed' },
  } });
  it('prints each velocity line with its label, and a rise reads as better', () => {
    const lines = formatDiff('t', row(10, 20), row(20, 40), []).join('\n');
    expect(lines).toMatch(/better\s+velocity\.points\.perDay\.real \[real, sized cards\]: 10 -> 20 pts\/day/);
    expect(lines).toMatch(/velocity\.points\.perDay\.estimated \[estimated from brief\]: 20 -> 40 pts\/day/);
    expect(judge('velocity.points.perDay.real', 10, 5)).toBe('worse');
    expect(diffSnapshots(row(10, 20), row(20, 40)).find((c) => c.key.endsWith('estimated')).source).toBe(ESTIMATED_SOURCE);
  });
});

describe('the real size of a PR comes from the sized cards only it built, resolved later by the drain', () => {
  it('sums resolved sized cards touched by exactly one code PR', () => {
    const merges = [
      { pr: 1, kind: 'code', cardIds: ['a', 'b'] }, { pr: 2, kind: 'code', cardIds: ['b', 'c'] },
      { pr: 3, kind: 'card-only', cardIds: ['c'] }, { pr: 4, kind: 'code', cardIds: ['d'] },
    ];
    const events = [{ id: 'a', size: 3 }, { id: 'b', size: 5 }, { id: 'c', size: 2 }];
    expect([...prActualPoints(merges, events)]).toEqual([[1, 3], [2, 2]]);
  });
});

describe('estimator calibration maths', () => {
  it('reports mean absolute error and bias (estimate - actual)', () => {
    expect(calibrationStats([{ actual: 3, estimate: 5 }, { actual: 5, estimate: 3 }, { actual: 3, estimate: 8 }])).toEqual({ n: 3, mae: 3, bias: 1.67 });
    expect(calibrationStats([])).toEqual({ n: 0, mae: null, bias: null });
  });
  it('snaps a model answer onto the Fibonacci scale', () => {
    expect([snapFibonacci(4), snapFibonacci(6), snapFibonacci(10), snapFibonacci(40)]).toEqual([3, 5, 8, 13]);
  });
});
