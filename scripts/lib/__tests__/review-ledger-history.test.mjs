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
function run({ repo = WE, at, drift = [], unreadable = 0, scan = { limit: 200, listed: 3, truncated: false, storeShared: true } }) {
  const summary = summarizeDerived([]);
  summary.total = scan?.listed ?? 0; // the scored total matches the listed PR count, as the checker writes it
  for (const f of drift) summary.perFamily[f] = { compared: 1, agree: 0, disagree: 1 };
  summary.unreadable = unreadable;
  return buildCheckRunRecord({ id: `review-ledger-check-t${seq++}`, repo, at, summary, phase1: {}, scan });
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

  it('a missing or non-numeric unreadable count is unknown; an explicit zero is clean', () => {
    const clean = run({ at: NOW.toISOString() });
    expect(runFamilyVerdict(clean, 'review')).toBe('clean');
    for (const bad of [undefined, null, '0', -1, 1.5, Number.NaN]) {
      const rec = structuredClone(clean);
      if (bad === undefined) delete rec.findings.derived.unreadable; else rec.findings.derived.unreadable = bad;
      expect(runFamilyVerdict(rec, 'review')).toBe('unknown');
    }
  });

  it('a truncated scan, or a record with no scan evidence, is never clean (a partial --limit run proves nothing)', () => {
    expect(runFamilyVerdict(run({ at: NOW.toISOString(), scan: { limit: 1, listed: 1, truncated: true } }), 'review')).toBe('unknown');
    expect(runFamilyVerdict(run({ at: NOW.toISOString(), scan: null }), 'review')).toBe('unknown');
    const noFlag = run({ at: NOW.toISOString() });
    delete noFlag.findings.scan.truncated;
    expect(runFamilyVerdict(noFlag, 'review')).toBe('unknown');
    // drift is still drift on a truncated scan: the disagreement it did see is real.
    expect(runFamilyVerdict(run({ at: NOW.toISOString(), drift: ['review'], scan: { limit: 1, listed: 1, truncated: true } }), 'review')).toBe('drift');
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

  it('a partially covered today is in progress: the clean week ending yesterday still counts', () => {
    const runs = [...week('2026-10-08', 7).flatMap((d) => cleanDay(d)), run({ repo: WE, at: '2026-10-09T10:00:00Z' })];
    expect(cleanDaysPerFamily(runs, { now: NOW }).families.review).toMatchObject({ streak: 7, ready: true });
  });

  it('a drifting or unknown today still breaks the streak, even when other repos have not run yet', () => {
    const week7 = week('2026-10-08', 7).flatMap((d) => cleanDay(d));
    const drifted = cleanDaysPerFamily([...week7, run({ repo: WE, at: '2026-10-09T10:00:00Z', drift: ['review'] })], { now: NOW });
    expect(drifted.families.review).toMatchObject({ streak: 0, ready: false });
    expect(drifted.families['ci-failed'].streak).toBe(7); // only the drifting family resets
    const unknown = cleanDaysPerFamily([...week7, ...cleanDay('2026-10-09', { [FUI]: { unreadable: 1 } })], { now: NOW });
    expect(unknown.families.review).toMatchObject({ streak: 0, ready: false });
    // partly covered today: WE already ran with an unreadable PR, the other repos have not run yet
    const partialUnknown = cleanDaysPerFamily([...week7, run({ repo: WE, at: '2026-10-09T10:00:00Z', unreadable: 1 })], { now: NOW });
    expect(partialUnknown.families.review).toMatchObject({ streak: 0, ready: false });
    const partialTruncated = cleanDaysPerFamily([...week7, run({ repo: WE, at: '2026-10-09T10:00:00Z', scan: { limit: 1, listed: 1, truncated: true } })], { now: NOW });
    expect(partialTruncated.families.review).toMatchObject({ streak: 0, ready: false });
  });

  it('a scan with no truncated field is recorded truncated (the writer fails closed too)', () => {
    const rec = run({ at: NOW.toISOString(), scan: { limit: 200, listed: 3 } });
    expect(rec.findings.scan.truncated).toBe(true);
    expect(runFamilyVerdict(rec, 'review')).toBe('unknown');
  });

  it('a run against an unshared ledger store, or whose scored total disagrees with the listed PRs, is unknown', () => {
    const clean = run({ at: NOW.toISOString() });
    expect(runFamilyVerdict(clean, 'review')).toBe('clean');
    for (const storeShared of [false, undefined, 'true']) {
      expect(runFamilyVerdict(run({ at: NOW.toISOString(), scan: { limit: 200, listed: 3, truncated: false, storeShared } }), 'review')).toBe('unknown');
    }
    const skewed = structuredClone(clean);
    skewed.findings.derived.total = 2; // 3 PRs listed, 2 scored
    expect(runFamilyVerdict(skewed, 'review')).toBe('unknown');
    const noListed = structuredClone(clean);
    delete noListed.findings.scan.listed;
    expect(runFamilyVerdict(noListed, 'review')).toBe('unknown');
  });

  it('pinned families ignore family names a record brings (retired, unrelated repo, __proto__)', () => {
    const week7 = week('2026-10-08', 7).flatMap((d) => cleanDay(d));
    const odd = run({ repo: 'x/unrelated', at: '2026-10-08T15:00:00Z' });
    odd.findings.derived.perFamily = JSON.parse('{"__proto__":{"disagree":0},"\\u001b[31mRED":{"disagree":0},"retired":{"disagree":9}}');
    const q = cleanDaysPerFamily([...week7, odd], { now: NOW, families: ['review'] });
    expect(Object.keys(q.families)).toEqual(['review']);
    expect(Object.getPrototypeOf(q.families)).toBe(Object.prototype);
    expect(q.families.review).toMatchObject({ streak: 7, ready: true });
  });

  it('runs from unselected repos never shape a scoped query (cannot reset or extend the streak)', () => {
    const wePast = week('2026-10-08', 7).map((d) => run({ repo: WE, at: `${d}T15:00:00Z` }));
    const others = [run({ repo: FUI, at: '2026-10-09T10:00:00Z', drift: ['review'] }), run({ repo: 'someone/else', at: '2026-10-09T10:00:00Z' })];
    expect(cleanDaysPerFamily([...wePast, ...others], { now: NOW, repos: [WE] }).families.review).toMatchObject({ streak: 7, ready: true });
    // and an unselected repo's clean run cannot manufacture a day for the selected one
    expect(cleanDaysPerFamily(week('2026-10-09', 7).map((d) => run({ repo: FUI, at: `${d}T15:00:00Z` })), { now: NOW, repos: [WE] }).families.review.streak).toBe(0);
    expect(dailyFamilyStatus(others, { repos: [WE] }).days).toEqual({});
  });

  it('a pinned family set makes a family absent from the records unknown instead of omitting it', () => {
    const runs = week('2026-10-09', 7).flatMap((d) => cleanDay(d));
    for (const r of runs) delete r.findings.derived.perFamily['ci-failed'];
    const q = cleanDaysPerFamily(runs, { now: NOW, families: ['review', 'ruling-needed', 'ready-to-merge', 'ci-failed'] });
    expect(q.families['ci-failed']).toMatchObject({ streak: 0, ready: false });
    expect(q.families.review.ready).toBe(true);
    expect(Object.keys(cleanDaysPerFamily(runs, { now: NOW }).families)).not.toContain('ci-failed'); // unpinned: omitted
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
