/**
 * @file scripts/lib/__tests__/review-ledger-history.test.mjs
 * @description #3930 — "7 clean days per label family" is a query over the checker's run records.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeRun } from '../../operations/run-store.mjs';
import { buildCheckRunRecord, summarizeDerived } from '../../review-ledger-check.mjs';
import {
  DEFAULT_REPOS, cleanDaysPerFamily, dailyFamilyStatus, dayBefore, etDay, readCheckRuns, renderCleanDays, runFamilyVerdict,
} from '../review-ledger-history.mjs';

const WE = 'web-everything/web-everything';
const FUI = 'frontier-ui/frontierui';
const PA = 'plateauapp/plateau-app';
let seq = 0;

/** A run record as the checker writes it. `drift` names the families with a disagreement. */
function run({ repo = WE, at, drift = [], unreadable = 0 }) {
  const summary = summarizeDerived([]);
  for (const f of drift) summary.perFamily[f] = { compared: 1, agree: 0, disagree: 1 };
  summary.unreadable = unreadable;
  return buildCheckRunRecord({ id: `review-ledger-check-t${seq++}`, repo, at, summary, phase1: {} });
}
/** One clean run per constellation repo at 15:00 UTC (11:00 ET) on `day`. */
const cleanDay = (day, extra = {}) => DEFAULT_REPOS.map((repo) => run({ repo, at: `${day}T15:00:00Z`, ...extra[repo] }));
const NOW = new Date('2026-10-09T18:00:00Z'); // 14:00 ET on 2026-10-09

describe('ET day arithmetic', () => {
  it('buckets an instant by America/New_York, not UTC', () => {
    expect(etDay('2026-10-09T02:00:00Z')).toBe('2026-10-08'); // 22:00 ET the previous evening
    expect(etDay('nope')).toBeNull();
  });
  it('steps across a DST change one calendar day at a time', () => {
    expect(dayBefore('2026-11-02')).toBe('2026-11-01');
    expect(dayBefore('2026-03-01', 1)).toBe('2026-02-28');
    expect(dayBefore('2026-10-09', 6)).toBe('2026-10-03');
  });
});

describe('runFamilyVerdict', () => {
  it('drift beats everything; unreadable PRs are unknown, never clean; no data is unknown', () => {
    expect(runFamilyVerdict(run({ at: NOW.toISOString(), drift: ['review'] }), 'review')).toBe('drift');
    expect(runFamilyVerdict(run({ at: NOW.toISOString(), unreadable: 1 }), 'review')).toBe('unknown');
    expect(runFamilyVerdict(run({ at: NOW.toISOString() }), 'review')).toBe('clean');
    expect(runFamilyVerdict({ op: 'review-ledger-check', findings: {} }, 'review')).toBe('unknown');
  });
});

describe('dailyFamilyStatus', () => {
  it('a day is incomplete when an expected repo has no run, and drift when any run drifts', () => {
    const runs = [run({ repo: WE, at: '2026-10-08T15:00:00Z' }), run({ repo: FUI, at: '2026-10-08T15:00:00Z', drift: ['ci-failed'] })];
    const { days } = dailyFamilyStatus(runs);
    expect(days['2026-10-08'].review).toMatchObject({ status: 'incomplete', repos: { [WE]: 'clean', [FUI]: 'clean', [PA]: 'missing' } });
    expect(days['2026-10-08']['ci-failed'].status).toBe('drift');
  });
  it('any drifting run on a day makes that repo drift, even after a clean one', () => {
    const runs = [...cleanDay('2026-10-08'), run({ repo: WE, at: '2026-10-08T20:00:00Z', drift: ['review'] })];
    expect(dailyFamilyStatus(runs).days['2026-10-08'].review.status).toBe('drift');
  });
});

describe('cleanDaysPerFamily — THE QUERY', () => {
  const week = (end, n) => Array.from({ length: n }, (_, i) => dayBefore(end, i));

  it('7 consecutive clean days across all repos is ready, per family', () => {
    const runs = week('2026-10-09', 7).flatMap((d) => cleanDay(d));
    const q = cleanDaysPerFamily(runs, { now: NOW });
    expect(Object.keys(q.families)).toEqual(['review', 'ruling-needed', 'ready-to-merge', 'ci-failed']);
    for (const f of Object.values(q.families)) expect(f).toMatchObject({ streak: 7, cleanInWindow: 7, ready: true });
  });

  it('a drift day resets only the family that drifted', () => {
    const runs = week('2026-10-09', 7).flatMap((d) => cleanDay(d, d === '2026-10-06' ? { [WE]: { drift: ['ruling-needed'] } } : {}));
    const q = cleanDaysPerFamily(runs, { now: NOW });
    expect(q.families['ruling-needed']).toMatchObject({ streak: 3, cleanInWindow: 6, ready: false });
    expect(q.families.review).toMatchObject({ streak: 7, ready: true });
  });

  it('a day with no run breaks the streak; a missing repo breaks it too', () => {
    const runs = [...week('2026-10-09', 3).flatMap((d) => cleanDay(d)), ...week('2026-10-05', 4).flatMap((d) => cleanDay(d))];
    expect(cleanDaysPerFamily(runs, { now: NOW }).families.review.streak).toBe(3); // 2026-10-06 has no run
    const partial = week('2026-10-09', 7).flatMap((d) => cleanDay(d)).filter((r) => !(r.input.repo === PA && r.input.at.startsWith('2026-10-08')));
    expect(cleanDaysPerFamily(partial, { now: NOW }).families.review.streak).toBe(1);
  });

  it('counts from yesterday when today has no run yet', () => {
    const runs = week('2026-10-08', 7).flatMap((d) => cleanDay(d));
    expect(cleanDaysPerFamily(runs, { now: NOW }).families.review).toMatchObject({ streak: 7, ready: true });
  });

  it('unreadable PRs never count as clean', () => {
    const runs = week('2026-10-09', 7).flatMap((d) => cleanDay(d, { [FUI]: { unreadable: 1 } }));
    expect(cleanDaysPerFamily(runs, { now: NOW }).families.review).toMatchObject({ streak: 0, ready: false });
  });

  it('the repo set is a parameter, so one repo can be queried alone', () => {
    const runs = week('2026-10-09', 7).map((d) => run({ repo: WE, at: `${d}T15:00:00Z` }));
    expect(cleanDaysPerFamily(runs, { now: NOW }).families.review.ready).toBe(false);
    expect(cleanDaysPerFamily(runs, { now: NOW, repos: [WE] }).families.review.ready).toBe(true);
  });

  it('renders a scannable line per family', () => {
    const q = cleanDaysPerFamily(week('2026-10-09', 7).flatMap((d) => cleanDay(d)), { now: NOW });
    expect(renderCleanDays(q, { runCount: 21 })).toMatch(/review\s+streak  7\/7 · clean in window 7\/7 {2}\[✓✓✓✓✓✓✓\] {2}READY/);
    expect(renderCleanDays(cleanDaysPerFamily([], { now: NOW }))).toContain('no run records yet');
  });
});

describe('readCheckRuns', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rlh-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads only check runs, and skips (and counts) a corrupt one', () => {
    writeRun(run({ at: NOW.toISOString() }), dir);
    writeRun({ ...run({ at: NOW.toISOString() }), id: 'other-op-1', op: 'other-op' }, dir);
    writeFileSync(join(dir, 'review-ledger-check-broken.json'), '{not json');
    const { runs, corrupt } = readCheckRuns({ dir });
    expect(runs).toHaveLength(1);
    expect(corrupt).toBe(1);
  });
});
