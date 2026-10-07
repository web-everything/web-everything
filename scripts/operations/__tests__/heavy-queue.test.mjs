/**
 * @file scripts/operations/__tests__/heavy-queue.test.mjs
 * @description Card xb0iuxq — pure-core proof for `heavy-queue.mjs`: KIND classification from a live command
 *   line, per-row minutes/who assembly, the projected-wait heuristic, and the declared-operation shape. No fs/
 *   process/clock — every input is a plain object, mirroring `daemon-status.test.mjs`'s own pure-core suite.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyHeavyJobKind, assessHeavyQueueRow, projectedWaitMinutesForNewJob, assessHeavyQueue,
  heavyQueueOperation, HEAVY_QUEUE_OP, SELECTED_GATE_MERGE_SHA, STANDARD_MINUTES_BY_KIND,
} from '../heavy-queue.mjs';

describe('classifyHeavyJobKind — from the LIVE command line, never a stored field', () => {
  it('a verify-lane.mjs holder on a base that already has PR #2680 is "selected"', () => {
    expect(classifyHeavyJobKind({ command: 'node scripts/verify-lane.mjs run --repo=.', isSelectedBase: true })).toBe('selected');
  });

  it('a verify-lane.mjs holder on an OLD base (pre-#2680) is "FULL" — the unconditional full-suite shape', () => {
    expect(classifyHeavyJobKind({ command: 'node scripts/verify-lane.mjs run --repo=.', isSelectedBase: false })).toBe('FULL');
  });

  it('check:standards routed through the wrapper is "standards"', () => {
    expect(classifyHeavyJobKind({ command: "node scripts/readiness/heavy-admission.mjs run -- node scripts/check-standards.mjs" })).toBe('standards');
    expect(classifyHeavyJobKind({ command: 'npm run check:standards -- --local --files=a.ts,b.ts' })).toBe('standards');
  });

  it('vitest related <files> (explicit files, no check:standards half) is "files"', () => {
    expect(classifyHeavyJobKind({ command: 'node scripts/readiness/heavy-admission.mjs run -- npx vitest related a.test.ts b.test.ts --run' })).toBe('files');
  });

  it('a bare "vitest run" (no explicit files) is "FULL"', () => {
    expect(classifyHeavyJobKind({ command: 'node scripts/readiness/heavy-admission.mjs run -- vitest run' })).toBe('FULL');
  });

  it('npm test / npm run test:unit typed directly are "FULL"', () => {
    expect(classifyHeavyJobKind({ command: 'npm run test:unit' })).toBe('FULL');
    expect(classifyHeavyJobKind({ command: 'npm test' })).toBe('FULL');
  });

  it('item 100 — a build is "build"; only a truly unknown command is "other"', () => {
    expect(classifyHeavyJobKind({ command: "sh -c 'npm run build:docs && npm run build:demo'" })).toBe('build');
    expect(classifyHeavyJobKind({ command: 'node scripts/mystery.mjs' })).toBe('other');
  });

  it('a null/empty command (the pid already exited) is "other", never a guess', () => {
    expect(classifyHeavyJobKind({ command: null })).toBe('other');
    expect(classifyHeavyJobKind({})).toBe('other');
  });

  it('SELECTED_GATE_MERGE_SHA names the real PR #2680 merge commit, not a placeholder', () => {
    expect(SELECTED_GATE_MERGE_SHA).toBe('14a3d0dff');
  });
});

describe('assessHeavyQueueRow — minutes + who assembly, pure', () => {
  const observedAt = '2026-09-25T12:30:00.000Z';

  it('a RUN row reads minutes from heartbeatAt (the acquire-time proxy — no separate acquiredAt field exists)', () => {
    const row = assessHeavyQueueRow(
      { heartbeatAt: '2026-09-25T12:15:00.000Z', lane: '16', lease: { purpose: 'ci-heal-2636' }, command: 'npm test' },
      { state: 'RUN', observedAt },
    );
    expect(row).toMatchObject({ state: 'RUN', lane: '16', who: 'ci-heal-2636', kind: 'FULL', minutes: 15 });
  });

  it('a WAIT row reads minutes from requestedAt', () => {
    const row = assessHeavyQueueRow(
      { requestedAt: '2026-09-25T12:29:00.000Z', lane: '16', lease: { session: 'chat-abc123' }, command: null },
      { state: 'WAIT', observedAt },
    );
    expect(row).toMatchObject({ state: 'WAIT', who: 'chat-abc123', kind: 'other', minutes: 1 });
  });

  it('who falls back to session when the lease carries no purpose', () => {
    const row = assessHeavyQueueRow({ heartbeatAt: observedAt, lease: { session: 'sess-1' } }, { state: 'RUN', observedAt });
    expect(row.who).toBe('sess-1');
  });

  it('who is null with no lease at all (not a lane, or the lease has already gone)', () => {
    const row = assessHeavyQueueRow({ heartbeatAt: observedAt, lease: null }, { state: 'RUN', observedAt });
    expect(row.who).toBeNull();
  });
});

describe('projectedWaitMinutesForNewJob — a rough estimate, 0 whenever a slot is already free', () => {
  // The list-scheduling ALGORITHM is what these cases pin, so they run against a fixed table (the pre-xkyw1x4
  // constants) passed explicitly — independent of the seeds / rolling standard times card xkyw1x4 introduced.
  const STD = { selected: 15, FULL: 35, standards: 8, files: 5, other: 20 };

  it('with no table passed, uses the xkyw1x4 seeds (STANDARD_MINUTES_BY_KIND)', () => {
    expect(STANDARD_MINUTES_BY_KIND.FULL).toBe(18);
    expect(projectedWaitMinutesForNewJob({ rows: [{ state: 'RUN', kind: 'FULL', minutes: 3 }], freeCount: 0 })).toBe(15);
  });
  it('is 0 the moment a slot is free', () => {
    expect(projectedWaitMinutesForNewJob({ rows: [], freeCount: 1 })).toBe(0);
  });

  it('with the cap full and no waiters, projects the soonest holder finishing its kind\'s standard time', () => {
    const rows = [{ state: 'RUN', kind: 'standards', minutes: 3 }]; // standard 8m, 3m elapsed → 5m left
    expect(projectedWaitMinutesForNewJob({ rows, freeCount: 0, standardMinutes: STD })).toBe(STD.standards - 3);
  });

  it('a new job queues BEHIND every already-waiting job (mirrors the FCFS fix this same card ships)', () => {
    const rows = [
      { state: 'RUN', kind: 'standards', minutes: 0 }, // 8m left
      { state: 'RUN', kind: 'selected', minutes: 0 }, // 15m left
      { state: 'WAIT', kind: 'other', minutes: 1, since: '2026-01-01T00:00:00.000Z' }, // one job ahead
    ];
    // The one waiter is assigned to whichever machine frees soonest (the 8m one), pushing it to 8+20=28; the
    // new arrival gets the OTHER machine, still free at 15m — never the raw 8m holder alone.
    expect(projectedWaitMinutesForNewJob({ rows, freeCount: 0, standardMinutes: STD })).toBe(15);
  });

  it('a crashed/stale waiter (live: false) is shown but never adds a wave to the projection', () => {
    const rows = [
      { state: 'RUN', kind: 'standards', minutes: 7 }, // 1m left
      { state: 'WAIT', kind: 'other', minutes: 4, live: false },
      { state: 'WAIT', kind: 'other', minutes: 3, live: false },
      { state: 'WAIT', kind: 'standards', minutes: 1 },
    ];
    expect(projectedWaitMinutesForNewJob({ rows, freeCount: 0, standardMinutes: STD })).toBe(1 + STD.standards);
  });

  it('never goes negative — a holder already past its kind\'s standard time floors at 0', () => {
    const rows = [{ state: 'RUN', kind: 'files', minutes: 999 }];
    expect(projectedWaitMinutesForNewJob({ rows, freeCount: 0, standardMinutes: STD })).toBe(0);
  });

  it('#2692 independent-review finding: waiting jobs at/past capacity ALL contribute their own duration, not just the current holder\'s remaining time', () => {
    // cap=1 (one holder), one holder 1 minute from done, three waiting `standards` jobs (8m standard each) —
    // the exact scenario both the codex-correctness and antigravity-review findings named. The old code
    // reported ~1m (the holder's own remaining time alone); the real queue this new arrival joins is
    // 1 + 8 + 8 + 8 = 25m.
    const rows = [
      { state: 'RUN', kind: 'other', minutes: STD.other - 1 }, // 1m left
      { state: 'WAIT', kind: 'standards', minutes: 3, since: '2026-01-01T00:00:00.000Z' },
      { state: 'WAIT', kind: 'standards', minutes: 2, since: '2026-01-01T00:01:00.000Z' },
      { state: 'WAIT', kind: 'standards', minutes: 1, since: '2026-01-01T00:02:00.000Z' },
    ];
    expect(projectedWaitMinutesForNewJob({ rows, freeCount: 0, standardMinutes: STD })).toBe(1 + STD.standards * 3);
  });

  it('with cap > 1, waiting jobs load-balance across whichever machine frees soonest', () => {
    const rows = [
      { state: 'RUN', kind: 'other', minutes: STD.other - 1 }, // machine A: 1m left
      { state: 'RUN', kind: 'other', minutes: STD.other - 2 }, // machine B: 2m left
      { state: 'WAIT', kind: 'standards', minutes: 1, since: '2026-01-01T00:00:00.000Z' }, // → A (1 < 2): A=1+8=9
      { state: 'WAIT', kind: 'standards', minutes: 1, since: '2026-01-01T00:01:00.000Z' }, // → B (2 < 9): B=2+8=10
    ];
    // Soonest-free machine after both waiters are placed is A at 9m.
    expect(projectedWaitMinutesForNewJob({ rows, freeCount: 0, standardMinutes: STD })).toBe(9);
  });
});

describe('assessHeavyQueue — the whole envelope', () => {
  it('joins held + waiting into one rows array with a headline', () => {
    const read = {
      observedAt: '2026-09-25T12:30:00.000Z', cap: 2, heldCount: 2, freeCount: 0,
      held: [
        { heartbeatAt: '2026-09-25T12:15:00.000Z', lane: '21', lease: { purpose: 'conveyor-fix' }, command: 'node scripts/verify-lane.mjs run', isSelectedBase: false },
        { heartbeatAt: '2026-09-25T12:20:00.000Z', lane: '11', lease: null, command: 'node scripts/verify-lane.mjs run', isSelectedBase: true },
      ],
      waiting: [
        { requestedAt: '2026-09-25T12:29:00.000Z', lane: '16', lease: { purpose: 'ci-heal-2636' }, command: 'npm run check:standards' },
      ],
    };
    const verdict = assessHeavyQueue(read);
    expect(verdict.heldCount).toBe(2);
    expect(verdict.waitingCount).toBe(1);
    expect(verdict.rows).toHaveLength(3);
    expect(verdict.rows[0]).toMatchObject({ state: 'RUN', kind: 'FULL' });
    expect(verdict.rows[1]).toMatchObject({ state: 'RUN', kind: 'selected' });
    expect(verdict.rows[2]).toMatchObject({ state: 'WAIT', kind: 'standards', who: 'ci-heal-2636' });
    expect(verdict.headline).toMatch(/2 of 2 held, 1 waiting/);
  });

  it('throws on an unreadable snapshot rather than silently reporting an empty queue', () => {
    expect(() => assessHeavyQueue(null)).toThrow(TypeError);
    expect(() => assessHeavyQueue({ held: [] })).toThrow(TypeError); // no `waiting` array
  });
});

describe('heavyQueueOperation — the declared shape', () => {
  it('requires a collect() reader', () => {
    expect(() => heavyQueueOperation({})).toThrow(TypeError);
  });

  it('registers under the exported op name and derives its verdict from `assess`', () => {
    const declaration = heavyQueueOperation({ collect: () => ({ observedAt: '2026-01-01T00:00:00.000Z', cap: 1, heldCount: 0, freeCount: 1, held: [], waiting: [] }) });
    expect(declaration.name).toBe(HEAVY_QUEUE_OP);
    expect(declaration.verdictFrom).toBe('assess');
  });
});
