/**
 * @file queue-scope-wiring.test.mjs — epic #3383. Proves the queue scope is actually WIRED into the repo-wide
 * mechanical passes THIS graduation slice (#3911) owns, not merely available as a module.
 *
 * WHY A SECOND FILE. `queue-scope.test.mjs` exercises the filter itself. THIS one exercises each pass's own
 * entry point with an injected `gh` reader, so a future edit that drops the `scopePrsToQueue(...)` call from
 * one pass reddens here rather than silently reintroducing the 2026-09-12 incident. Each pass gets BOTH cases:
 * unscoped (identical to today — the regression guard) and scoped (narrowed to queue membership).
 *
 * SCOPE NOTE (#3911 vs #3487). The prototype branch's own copy of this file also covers `reconcile-pass.mjs`
 * and `we:skills-src/conveyor/runner.mjs`'s `--scope-to-queue` flag. Neither is ported here: `main`'s
 * `reconcile-pass.mjs` and `skills-src/conveyor/runner.mjs` are NOT the prototype's files — they were authored
 * independently on `main` (#3296 / #3499) and have diverged into a different, actively-developed shape — and
 * both are explicitly `we:backlog/3487`'s own scope (which lists `we:scripts/conveyor/queue-scope.mjs`, i.e.
 * THIS item, as one of its own import blockers: #3911 lands the module first, #3487 wires it into the runner
 * and reconcile-pass afterward). Wiring them here would touch files outside this item's declared `scope:` and
 * duplicate work #3487 already owns. See `we:backlog/3486`'s own resolution note, which routes "queue scope"
 * in `runner.mjs` to #3487 by name.
 *
 * No `gh`, no subprocess, no lane pool, no marker file: `queueScope: { enabled, ids, log }` is injected at the
 * call, and every pass is run in `dryRun` where it has one, so nothing can reach a real write.
 */
import { describe, it, expect } from 'vitest';

import { watchDuplicatePrs } from '../duplicate-pr-watch.mjs';
import { watchParkedPrConflicts } from '../parked-pr-conflict-watch.mjs';
import { watchNeglectedPrs } from '../parked-pr-progress-watch.mjs';
import { laneNeedsVerifyDispatch, laneInQueueScope } from '../verify-dispatch.mjs';

const silent = () => {};

/** THE SCRATCH INSTANCE'S QUEUE — the shape of the 2026-09-12 incident: a small, explicitly seeded set. */
const QUEUE = ['3617', '3620'];

/** Two PRs for queued items… */
const MINE = [
  { number: 3001, headRefName: 'lane/3617-alpha', title: 'WE #3617: alpha' },
  { number: 3002, headRefName: 'lane/3620-beta', title: 'WE #3620: beta' },
];
/** …and the unrelated ones a repo-wide `gh pr list` also returns. */
const THEIRS = [
  { number: 2127, headRefName: 'lane/3371-native-deny-history-strip-isolation', title: 'WE #3371: deny history strip' },
  { number: 2131, headRefName: 'lane/3631-throttle-review-set-label-net-diff-exec', title: 'WE #3631: throttle' },
];

describe('duplicate-pr-watch', () => {
  // A duplicate pair on an UNRELATED item (#3371) plus a duplicate pair on a QUEUED item (#3617).
  const OPEN = [
    { number: 3001, headRefName: 'lane/3617-alpha', title: 'WE #3617: alpha', body: '', labels: [], files: [{ path: 'scripts/a.mjs' }] },
    { number: 3003, headRefName: 'lane/3617b-alpha-again', title: 'WE #3617: alpha again', body: '', labels: [], files: [{ path: 'scripts/a.mjs' }] },
    { number: 2127, headRefName: 'lane/3371-deny', title: 'WE #3371: deny', body: '', labels: [], files: [{ path: 'scripts/b.mjs' }] },
    { number: 2128, headRefName: 'lane/3371b-deny-again', title: 'WE #3371: deny again', body: '', labels: [], files: [{ path: 'scripts/b.mjs' }] },
  ];
  const run = (queueScope) => watchDuplicatePrs({ listPrs: () => OPEN, dryRun: true, queueScope });

  it('UNSCOPED: posts findings on BOTH duplicate pairs, including the unrelated one', () => {
    expect(run({ enabled: false, log: silent }).map((r) => r.pr).sort()).toEqual([2127, 2128, 3001, 3003]);
  });

  it('SCOPED: only the queued item\'s duplicate pair is judged', () => {
    expect(run({ enabled: true, ids: QUEUE, log: silent }).map((r) => r.pr).sort()).toEqual([3001, 3003]);
  });
});

describe('parked-pr-conflict-watch', () => {
  const conflicting = (pr) => ({ ...pr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', labels: [{ name: 'review:pending' }], files: [{ path: 'scripts/x.mjs' }] });
  const OPEN = [conflicting(MINE[0]), conflicting(THEIRS[0])];
  const run = (queueScope) => watchParkedPrConflicts({
    listPrs: () => OPEN, dryRun: true,
    provider: { currentRepo: () => 'web-everything/web-everything' }, queueScope,
  });

  it('UNSCOPED: labels the unrelated conflicted PR too', () => {
    expect(run({ enabled: false, log: silent }).map((r) => r.num).sort()).toEqual([2127, 3001]);
  });

  it('SCOPED: touches only the queued item\'s PR', () => {
    expect(run({ enabled: true, ids: QUEUE, log: silent }).map((r) => r.num)).toEqual([3001]);
  });
});

describe('parked-pr-progress-watch', () => {
  const parked = (pr) => ({ ...pr, labels: [{ name: 'review:pending' }] });
  const OPEN = [parked(MINE[0]), parked(THEIRS[0])];
  const LONG_AGO = '2026-01-01T00:00:00Z';
  const run = (queueScope) => watchNeglectedPrs({
    listPrs: () => OPEN,
    listAgents: () => [],
    listLabelEvents: () => [{ createdAt: LONG_AGO, labelName: 'review:pending' }],
    now: Date.parse('2026-09-12T12:00:00Z'),
    dryRun: true,
    queueScope,
  });

  it('UNSCOPED: judges the unrelated parked PR too', () => {
    expect(run({ enabled: false, log: silent }).map((r) => r.pr).sort()).toEqual([2127, 3001]);
  });

  it('SCOPED: judges only the queued item\'s PR — and never pays for its label-timeline fetch', () => {
    const fetched = [];
    const results = watchNeglectedPrs({
      listPrs: () => OPEN,
      listAgents: () => [],
      listLabelEvents: ({ number }) => { fetched.push(number); return [{ createdAt: LONG_AGO, labelName: 'review:pending' }]; },
      now: Date.parse('2026-09-12T12:00:00Z'),
      dryRun: true,
      queueScope: { enabled: true, ids: QUEUE, log: silent },
    });
    expect(results.map((r) => r.pr)).toEqual([3001]);
    expect(fetched).toEqual([3001]);
  });
});

describe('verify-dispatch — the OTHER leak axis (host-wide lane pool, not `gh pr list`)', () => {
  const RUNNING = { status: 'running', sha: 'abc123' };

  it('the marker rule itself is untouched by scoping', () => {
    expect(laneNeedsVerifyDispatch(RUNNING, 'abc123')).toBe(true);
    expect(laneNeedsVerifyDispatch(RUNNING, 'other')).toBe(false);
  });

  it('UNSCOPED: every lane with a pending marker is in scope — today\'s behavior, pinned', () => {
    expect(laneInQueueScope('lane/3371-someone-elses-work', { enabled: false })).toBe(true);
    expect(laneInQueueScope(null, { enabled: false })).toBe(true);
  });

  it('SCOPED: a sibling instance\'s lane is skipped, and this instance\'s own is still gated', () => {
    expect(laneInQueueScope('lane/3617-alpha', { enabled: true, ids: QUEUE })).toBe(true);
    expect(laneInQueueScope('lane/3371-someone-elses-work', { enabled: true, ids: QUEUE })).toBe(false);
  });

  it('SCOPED: an unreadable branch is OUT of scope — a scoped instance only touches what it can identify', () => {
    expect(laneInQueueScope(null, { enabled: true, ids: QUEUE })).toBe(false);
    expect(laneInQueueScope('HEAD', { enabled: true, ids: QUEUE })).toBe(false);
  });
});
