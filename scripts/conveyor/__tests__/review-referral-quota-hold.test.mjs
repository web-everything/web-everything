import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as hold from '../review-referral-hold.mjs';
import { newSpanEnd } from '../../operations/telemetry.mjs';
import { newRunRecord } from '../../operations/run-store.mjs';

const { reviewRunEvidence, decideSameHeadHold, markQuotaOnlyFromSpans,
  readReviewFailureSpans, readQuotaFailureSpans, readReviewRunEvidence, REVIEW_EVIDENCE_CACHE_FILE } = hold;

const repo = 'example/repo';
const head = 'a'.repeat(40);
const at = Date.parse('2026-10-29T08:00:00Z');
const iso = n => new Date(n).toISOString();
const quotaError = "judge-spawn: the juror failed: You've hit your weekly limit · resets ...";
const genuineError = 'judge-spawn: the juror failed: schema invalid';
const pr = { number: 7, headRefOid: head, labels: [{ name: 'review:pending' }], comments: [],
  createdAt: iso(at - 24 * 3_600_000) };
const options = { repo, env: {}, now: at + 30 * 60_000 };

// Failure location follows review-pr-io.test.mjs's persisted mandatory-referral records:
// findings.mandatoryReferrals.effects[].result.records[].failure (not telemetry.failure).
function failedRun(failures, index = 0, { complete = false } = {}) {
  const time = at + index * 1_000;
  return { id: `review-${index}`, op: 'review-pr',
    findings: {
      read: { repo, pr: 7, netBasis: { rev: head } },
      mandatoryReferrals: { applied: true, effects: [{ type: 'review.mandatory-referrals', status: 'applied',
        result: { records: failures.map((failure, i) => ({ repo, pr: 7, head, runId: `review-${index}`,
          attempted: true, referrals: [{ key: `finding-${i}` }], rulings: [],
          ...(failure === null ? {} : { failure }) })) } }] },
    },
    stepTimings: [{ step: 'read', startedAt: iso(time), finishedAt: iso(time + 1) },
      ...(complete ? [{ step: 'advise', startedAt: iso(time + 2), finishedAt: iso(time + 3) }] : [])],
  };
}
const evidence = (failures, index, opts) => reviewRunEvidence(failedRun(failures, index, opts));
const history = (failures, count = 13) => Array.from({ length: count }, (_, i) => evidence(failures, i));

describe('quota-only review run evidence', () => {
  it.each([false, true])('records hasFailure for any recorded failure (completed: %s)', complete => {
    for (const failures of [[quotaError], [genuineError], [quotaError, genuineError]]) {
      expect(evidence(failures, 0, { complete })).toMatchObject({ hasFailure: true });
    }
  });

  it.each([false, true])('marks every recorded failure as quota-only (completed: %s)', complete => {
    const row = evidence([quotaError, 'HTTP 429', null], 0, { complete });
    expect(row).toMatchObject({ quotaOnly: true });
    expect(Boolean(row.incomplete)).toBe(!complete);
  });

  it.each([
    ['genuine failure', [genuineError]],
    ['mixed failures', [quotaError, genuineError]],
    ['no result text', ['judge-spawn: the juror failed with no result text']],
    ['no recorded failures', [null]],
    ['no records', []],
  ])('does not exempt %s', (_, failures) => {
    expect(evidence(failures).quotaOnly).not.toBe(true);
  });
});

describe('same-head quota attempt accounting', () => {
  it('13 quota-only incomplete runs never create a hold', () => {
    expect(decideSameHeadHold(pr, history([quotaError]), options)).toBeNull();
  });

  it('13 genuine incomplete failures still exhaust the no-verdict cap', () => {
    expect(decideSameHeadHold(pr, history([genuineError]), options)).toMatchObject({
      kind: 'same-head', count: 13, attemptsSinceWake: 13, retryAt: null,
      noVerdict: { exhausted: true },
    });
  });

  it('quota-only runs plus two genuine attempts remain below the cap', () => {
    const rows = [...history([quotaError]), evidence([genuineError], 13), evidence([quotaError, genuineError], 14)];
    expect(decideSameHeadHold(pr, rows, options)).toBeNull();
  });

  it('mixed-failure runs count, but quota-only runs do not count as attempts or last', () => {
    const genuine = history([quotaError, genuineError], 3);
    const expected = decideSameHeadHold(pr, genuine, options);
    expect(expected).toMatchObject({ count: 3, attemptsSinceWake: 3, retryAt: at + 2_000 + 3_600_000 });
    // These newer failures must not extend the cooldown or spend any release budget.
    const quotaOnly = Array.from({ length: 13 }, (_, i) => evidence([quotaError], i + 3));
    expect(decideSameHeadHold(pr, [...genuine, ...quotaOnly], options)).toEqual(expected);
  });

  it('a newer quota-only incomplete run cannot replace the last completed genuine review', () => {
    const acceptedPr = { ...pr, labels: [{ name: 'review:accept' }] };
    const genuine = evidence([genuineError], 0, { complete: true });
    const expected = decideSameHeadHold(acceptedPr, [genuine], options);
    expect(expected).toMatchObject({ kind: 'same-head', count: 1, attemptsSinceWake: 1 });
    expect(decideSameHeadHold(acceptedPr, [genuine, evidence([quotaError], 1)], options)).toEqual(expected);
  });
});

const dirs = [];
function temp() {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'quota-spans-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function quotaSpan(overrides = {}) {
  return newSpanEnd({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
    name: 'review.loop', status: 'error',
    statusMessage: "review-loop exit 1: error: judge-spawn: the juror failed: You've hit your weekly limit · resets Oct 30 at 4pm (America/Toronto)",
    startedAt: iso(at), endedAt: iso(at + 1_000),
    attributes: { pr: 7, repo: 'example/repo' }, ...overrides });
}

// Real interrupted runs contain a verdict flag, but no error text in their persisted findings.
function textlessRun(index = 0) {
  const id = `review-pr-${index}`;
  const run = { ...newRunRecord({ id, op: 'review-pr' }), ...failedRun([], index), id };
  delete run.findings.mandatoryReferrals;
  run.stepTimings = run.stepTimings.map((timing, stepIndex) => ({ ...timing, stepIndex, durationMs: 1 }));
  run.seatTimings = [{ seat: 'judge', verdict: 'error' }];
  return run;
}
const textlessRow = () => reviewRunEvidence(textlessRun());
function writeSpans(dir, spans, day = iso(at).slice(0, 10)) {
  const path = join(dir, `${day}.jsonl`);
  writeFileSync(path, spans.map(s => JSON.stringify(s)).join('\n') + '\n');
  return path;
}

describe('telemetry quota overlay', () => {
  it('marks a textless incomplete row by PR and exact full repo without mutating either input', () => {
    const rows = [textlessRow()];
    const spans = [quotaSpan()];
    const before = structuredClone({ rows, spans });
    expect(rows[0]).toMatchObject({ incomplete: true, quotaOnly: false, startedAt: at });
    expect(markQuotaOnlyFromSpans(rows, spans)).toEqual([{ ...rows[0], quotaOnly: true }]);
    expect({ rows, spans }).toEqual(before);
  });

  it.each([-30_000, 31_000])('includes the 30-second window boundary at offset %i', offset => {
    const row = { ...textlessRow(), startedAt: at + offset };
    expect(markQuotaOnlyFromSpans([row], [quotaSpan()])[0].quotaOnly).toBe(true);
  });

  it.each([
    [repo, false],
    [repo, true],
  ])('does not mark mixed failures for exact repo %s (non-quota first: %s)', (spanRepo, nonQuotaFirst) => {
    const row = textlessRow();
    const quota = quotaSpan();
    const nonQuota = quotaSpan({ spanId: 'c'.repeat(16), statusMessage: 'schema invalid',
      attributes: { pr: row.pr, repo: spanRepo },
      startedAt: iso(at - 500), endedAt: iso(at + 500) });
    const spans = nonQuotaFirst ? [nonQuota, quota] : [quota, nonQuota];

    expect(row).toMatchObject({ incomplete: true, quotaOnly: false });
    expect(markQuotaOnlyFromSpans([row], [quota])[0].quotaOnly).toBe(true);
    expect(markQuotaOnlyFromSpans([row], spans)).toEqual([row]);
  });

  it('demotes an incomplete row with recorded quota-only failures when an overlapping non-quota review.loop error matches its PR and exact repo', () => {
    const row = evidence([quotaError]);
    const nonQuota = quotaSpan({ statusMessage: genuineError,
      attributes: { pr: row.pr, repo: row.repo },
      startedAt: iso(at - 500), endedAt: iso(at + 500) });

    expect(row).toMatchObject({ incomplete: true, quotaOnly: true, startedAt: at, pr: 7, repo });
    expect(markQuotaOnlyFromSpans([row], [nonQuota])).toEqual([{ ...row, quotaOnly: false }]);
  });

  it.each(['other/repo', 'repo', 'example/other', 'another-owner/other'])('never matches quota telemetry without the exact full repo: %s', spanRepo => {
    const row = textlessRow();
    const span = quotaSpan({ attributes: { pr: row.pr, repo: spanRepo } });
    expect(markQuotaOnlyFromSpans([row], [span])).toEqual([row]);
  });

  it.each(['other/repo', 'repo', 'example/other', 'another-owner/other'])('does not mix in non-quota telemetry from another repo: %s', spanRepo => {
    const row = textlessRow();
    const unrelated = quotaSpan({ spanId: 'c'.repeat(16), statusMessage: 'schema invalid',
      attributes: { pr: row.pr, repo: spanRepo } });
    expect(markQuotaOnlyFromSpans([row], [quotaSpan(), unrelated])).toEqual([{ ...row, quotaOnly: true }]);
  });

  it.each([
    ['genuine failure', [genuineError]],
    ['mixed failures', [quotaError, genuineError]],
  ])('never overlays a row with its own recorded %s', (_, failures) => {
    const row = evidence(failures);
    const before = structuredClone(row);
    expect(row).toMatchObject({ incomplete: true, quotaOnly: false });
    expect(markQuotaOnlyFromSpans([row], [quotaSpan()])).toEqual([before]);
    expect(row).toEqual(before);
  });

  it.each([
    ['completed row', { incomplete: false, completedAt: at + 500 }, {}],
    ['another PR', { pr: 8 }, {}],
    ['another repo basename', { repo: 'example/other' }, {}],
    ['non-quota error', {}, { statusMessage: genuineError }],
    ['another span name', {}, { name: 'review.seat' }],
    ['successful span', {}, { status: 'ok' }],
    ['before the window', { startedAt: at - 30_001 }, {}],
    ['after the window', { startedAt: at + 31_001 }, {}],
    ['missing PR identity', {}, { attributes: { repo } }],
    ['missing repo identity', {}, { attributes: { pr: 7 } }],
    ['invalid span start', {}, { startedAt: 'invalid' }],
    ['invalid span end', {}, { endedAt: 'invalid' }],
  ])('fails closed for %s', (_, rowOverrides, spanOverrides) => {
    const row = { ...textlessRow(), ...rowOverrides };
    expect(markQuotaOnlyFromSpans([row], [quotaSpan(spanOverrides)])).toEqual([row]);
  });

  it('leaves rows unchanged when telemetry is absent', () => {
    const rows = [textlessRow()];
    expect(markQuotaOnlyFromSpans(rows, [])).toEqual(rows);
  });
});

describe('quota failure telemetry reader', () => {
  it('reads quota review.loop errors from each of the last three daily jsonl files only', () => {
    const dir = temp();
    const spans = [0, 1, 2].map(daysAgo => quotaSpan({
      startedAt: iso(at - daysAgo * 86_400_000), endedAt: iso(at - daysAgo * 86_400_000 + 1_000),
    }));
    for (const span of spans) writeSpans(dir, [span], span.startedAt.slice(0, 10));
    writeSpans(dir, [quotaSpan({ spanId: 'c'.repeat(16) })], '2026-10-26');
    writeFileSync(join(dir, 'ignored.txt'), JSON.stringify(quotaSpan()));
    expect(readQuotaFailureSpans({ dir, now: options.now })).toEqual(expect.arrayContaining(spans));
    expect(readQuotaFailureSpans({ dir, now: options.now })).toHaveLength(3);
  });

  it('filters unrelated valid events while retaining quota evidence', () => {
    const dir = temp();
    const span = quotaSpan();
    writeSpans(dir, [span,
      quotaSpan({ statusMessage: genuineError }), quotaSpan({ name: 'review.seat' }),
      quotaSpan({ status: 'ok' }), { ...span, event: 'span.start' }]);
    expect(readQuotaFailureSpans({ dir, now: options.now })).toEqual([span]);
  });

  // Deliberate contract change: any rejected line invalidates the entire scan,
  // rather than silently dropping a potentially genuine failure from the overlay.
  describe.each([
    ['readReviewFailureSpans', readReviewFailureSpans],
    ['readQuotaFailureSpans', readQuotaFailureSpans],
  ])('%s fails closed', (_, readSpans) => {
    it.each([
      ['unparseable JSON', '{torn json'],
      ['corrupt event', JSON.stringify({ ...quotaSpan({ statusMessage: genuineError }), event: 'unknown' })],
      ['unknown version', JSON.stringify({ ...quotaSpan({ statusMessage: genuineError }), v: 999 })],
    ].flatMap(([label, badLine]) => [0, 1, 2].map(daysAgo => [label, daysAgo, badLine])))(
      'returns [] for %s in scanned day offset %i', (_, daysAgo, badLine) => {
        const dir = temp();
        const span = quotaSpan();
        const day = iso(at - daysAgo * 86_400_000).slice(0, 10);
        writeSpans(dir, [span]);
        const path = join(dir, `${day}.jsonl`);
        // Keep valid evidence on both sides to catch partial results as well.
        writeFileSync(path, `${JSON.stringify(span)}\n${badLine}\n${JSON.stringify(span)}\n`);
        const spans = readSpans({ dir, now: options.now });
        expect(spans, `corrupt day offset ${daysAgo}`).toEqual([]);
        expect(markQuotaOnlyFromSpans([textlessRow()], spans)).toEqual([textlessRow()]);
      });
  });

  it('returns no quota evidence for a missing telemetry directory', () => {
    expect(readQuotaFailureSpans({ dir: join(temp(), 'missing'), now: options.now })).toEqual([]);
  });
});

function runFixture(count = 1) {
  const root = temp();
  const dir = join(root, 'runs');
  const spansDir = join(root, 'spans');
  mkdirSync(dir);
  mkdirSync(spansDir);
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `review-pr-${i}.json`), JSON.stringify(textlessRun(i)));
  }
  return { dir, spansDir, now: options.now };
}

describe('run evidence telemetry integration', () => {
  it('overlays newly arrived spans after memory and disk cache reads without caching the overlay', () => {
    const fixture = runFixture();
    const memo = new Map();
    const baseline = readReviewRunEvidence({ ...fixture, memo });
    expect(baseline[0].quotaOnly).toBe(false);
    const diskBefore = readFileSync(join(fixture.dir, REVIEW_EVIDENCE_CACHE_FILE), 'utf8');
    const path = writeSpans(fixture.spansDir, [quotaSpan()]);
    expect(readQuotaFailureSpans({ dir: fixture.spansDir, now: fixture.now })).toHaveLength(1);
    const readRun = vi.fn(() => { throw new Error('unchanged run must come from cache'); });
    expect(readReviewRunEvidence({ ...fixture, memo, readRun })[0].quotaOnly).toBe(true);
    expect(readReviewRunEvidence({ ...fixture, memo: new Map(), readRun })[0].quotaOnly).toBe(true);
    expect(readRun).not.toHaveBeenCalled();
    expect(baseline[0].quotaOnly).toBe(false);
    expect([...memo.values()].every(entry => entry.evidence.quotaOnly === false)).toBe(true);
    expect(readFileSync(join(fixture.dir, REVIEW_EVIDENCE_CACHE_FILE), 'utf8')).toBe(diskBefore);
    rmSync(path);
    expect(readReviewRunEvidence({ ...fixture, memo, readRun })).toEqual(baseline);
    expect(readReviewRunEvidence({ ...fixture, memo: new Map(), readRun })).toEqual(baseline);
  });

  it.each([true, false])('13 textless incomplete runs with quota spans: %s', quota => {
    const fixture = runFixture(13);
    const spans = Array.from({ length: 13 }, (_, i) => quotaSpan({
      spanId: i.toString(16).padStart(16, '0'), startedAt: iso(at + i * 1_000),
      endedAt: iso(at + i * 1_000 + 500), ...(quota ? {} : { statusMessage: genuineError }),
    }));
    writeSpans(fixture.spansDir, spans);
    expect(readQuotaFailureSpans({ dir: fixture.spansDir, now: fixture.now })).toHaveLength(quota ? 13 : 0);
    const rows = readReviewRunEvidence({ ...fixture, memo: new Map() });
    expect(rows).toHaveLength(13);
    expect(rows.every(row => row.incomplete && row.quotaOnly === quota)).toBe(true);
    const result = decideSameHeadHold(pr, rows, options);
    if (quota) expect(result).toBeNull();
    else expect(result).toMatchObject({ kind: 'same-head', count: 13, attemptsSinceWake: 13,
      retryAt: null, noVerdict: { exhausted: true } });
  });
});
