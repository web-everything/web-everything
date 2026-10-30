import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredCheckStates, contradictingChecks, notCiBreakContradicted, unsettledRequiredChecks, ciGreenForEscalation, resolveVoidNeedsHumanWhenCiGreen, resolveCiHealVerdictSettings } from '../ci-heal-verdict-recheck.mjs';
import * as verdictRecheck from '../ci-heal-verdict-recheck.mjs';
import { checkNeedsHumanEscalable, checkNotCiBreakRecordable, notCiBreakRecordRefusal } from '../ci-heal-escalation-mark.mjs';
import { excuseMergeGateRows } from '../../lib/merge-gate-hold-class.mjs';
import { latestCheckNamed } from '../../lib/rollup-collapse.mjs';
import { latestAttempts } from '../../lib/check-state-predicate.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ci-heal-verdict/pr4535-2026-10-09.json'), 'utf8'));
const input = { escalation: { outcome: 'not-a-ci-break', headSha: fixture.headRefOid }, headSha: fixture.headRefOid,
  rollup: fixture.statusCheckRollup, requiredChecks: fixture.requiredChecks };
const green = fixture.requiredChecks.map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));

describe('R272 shared every-row evidence contract', () => {
  it('retains every original row without mutation in both compatibility exports', () => {
    const older = Object.freeze({ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS',
      run_attempt: 2, id: 100, completedAt: '2026-10-28T01:00:00Z' });
    const newer = Object.freeze({ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
      run_attempt: 1, id: 200, completedAt: '2026-10-28T02:00:00Z' });
    for (const rows of [Object.freeze([older, newer]), Object.freeze([newer, older])]) {
      expect(latestAttempts(rows)).toEqual(rows);
      expect(verdictRecheck.latestRollupAttempts(rows)).toEqual(rows);
      expect(requiredCheckStates({ rollup: rows, requiredChecks: ['test'] }).red).toEqual(['test']);
    }
  });

  it.each(['startedAt', 'started_at', 'createdAt', 'created_at'])(
    'invalid completion evidence and %s metadata cannot hide failure', key => {
      const older = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS',
        id: 200, completedAt: '2026-10-28T01:00:00Z' };
      const newer = { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
        id: 100, completedAt: 'invalid', completed_at: '1970-01-01T00:00:00Z',
        [key]: '2026-10-28T02:00:00Z' };
      for (const rollup of [[older, newer], [newer, older]]) {
        expect(requiredCheckStates({ rollup, requiredChecks: ['test'] }).red).toEqual(['test']);
      }
    },
  );
});

describe('operator send-back exact check identity', () => {
  it('required test FAILURE plus a distinct TEST SUCCESS must stay red', async () => {
    for (const legacy of [false, true]) {
      const failed = legacy
        ? { __typename: 'StatusContext', context: 'test', state: 'FAILURE' }
        : { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' };
      const rows = [
        { ...failed, completedAt: '2026-10-30T10:00:00Z' },
        { name: 'TEST', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-30T10:01:00Z' },
        { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
      ];
      for (const rollup of [rows, rows.toReversed()]) {
        const evidence = { ...input, rollup, requiredChecks: ['test'] };
        const drainRow = latestCheckNamed(rollup, 'test');
        expect(drainRow.conclusion ?? drainRow.state).toBe('FAILURE');
        expect(requiredCheckStates(evidence)).toEqual({ red: ['test'], pending: [], missing: [], green: [] });
        expect(ciGreenForEscalation(evidence)).toBe(false);
        expect(contradictingChecks(evidence)).toEqual(['test']);
        expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
        expect(notCiBreakRecordRefusal({ headSha: input.headSha,
          pr: { headRefOid: input.headSha, statusCheckRollup: rollup }, requiredChecks: ['test'] })).not.toBeNull();
        expect(await checkNeedsHumanEscalable({
          pr: 6042, headSha: input.headSha, outcome: 'needs-human', settings: { recheckNotCiBreak: true },
          readPr: () => ({ headRefOid: input.headSha, statusCheckRollup: rollup }),
          readRequired: () => ({ checks: ['test'] }),
        })).toEqual({ refusal: null });
      }
    }
  });

  it('a differently cased success cannot satisfy a missing required check', () => {
    expect(requiredCheckStates({ requiredChecks: ['test'], rollup: [
      { name: 'TEST', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ] })).toEqual({ red: [], pending: [], missing: ['test'], green: [] });
  });

  it('a distinct CODEQL success cannot hide a drain-blocking CodeQL failure', () => {
    const rollup = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-30T10:00:00Z' },
      { name: 'CODEQL', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-30T10:01:00Z' },
    ];
    expect(verdictRecheck.gateOnlyRedStates({ rollup, requiredChecks: ['test'],
      drainGateSettings: { drainBlocksOnCodeQL: true } })).toEqual({ gateOnlyRed: false, red: ['review-gate', 'CodeQL'] });
  });

  it('a differently cased required gate is ordinary CI evidence', () => {
    const evidence = { requiredChecks: ['MERGE-GATE', 'REVIEW-GATE'], rollup: [
      { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', mergeGateReviewHold: true },
      { name: 'MERGE-GATE', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'REVIEW-GATE', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] };
    expect(requiredCheckStates(evidence).red).toEqual(['MERGE-GATE', 'REVIEW-GATE']);
    expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
  });
});

describe('R10 escalation send-back regressions', () => {
  it.each([false, true])('a failed rerun of an older workflow run stays red (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', run_id: 100, run_attempt: 2, id: 300, status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-29T03:00:00Z' },
      { name: 'test', run_id: 200, run_attempt: 1, id: 200, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-29T02:00:00Z' },
    ];
    const rollup = reverse ? rows.toReversed() : rows;
    const evidence = { ...input, rollup, requiredChecks: ['test'] };
    expect.soft(requiredCheckStates(evidence).red).toEqual(['test']);
    expect.soft(notCiBreakRecordRefusal({ headSha: input.headSha,
      pr: { headRefOid: input.headSha, statusCheckRollup: rollup }, requiredChecks: ['test'] })).not.toBeNull();
    expect.soft(contradictingChecks(evidence)).toEqual(['test']);
  });

  it('R10 item 1: a merge-gate job failure stays red alongside a review-hold rerun', async () => {
    const requiredChecks = ['test', 'merge-gate'];
    const held = excuseMergeGateRows([
      { name: 'merge-gate', id: 123, run_id: 100, run_attempt: 3, status: 'COMPLETED', conclusion: 'FAILURE' },
    ], {
      prNumber: 6042, headSha: fixture.headRefOid, labels: ['ready-to-merge'], setting: 'on',
      readVerdict: () => ({ num: 6042, head_sha: fixture.headRefOid, ok: false,
        results: [{ id: 'review-acceptance', status: 'hold', reason: 'review pending' }] }),
    });
    expect(held.reviewHold).toBe(true);
    for (const reverse of [false, true]) {
      const gates = [...held.rows,
        { name: 'merge-gate', id: 234, run_id: 200, run_attempt: 1, status: 'COMPLETED',
          conclusion: 'FAILURE', output: { summary: 'npm ci failed' } },
      ];
      const rollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ...(reverse ? gates.toReversed() : gates)];
      const evidence = { ...input, requiredChecks, rollup };
      expect.soft(requiredCheckStates(evidence).red).toEqual(['merge-gate']);
      expect.soft(contradictingChecks(evidence)).toEqual(['merge-gate']);
      expect.soft(ciGreenForEscalation(evidence)).toBe(false);
      expect.soft(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
      expect.soft(await checkNeedsHumanEscalable({
        pr: 6042, headSha: fixture.headRefOid, outcome: 'needs-human', settings: { recheckNotCiBreak: true },
        readPr: () => ({ headRefOid: fixture.headRefOid, statusCheckRollup: rollup }),
        readRequired: () => ({ checks: requiredChecks }),
      })).toEqual({ refusal: null });
    }
  });

  it('R10 item 2: a CodeQL failure stays red alongside a successful rerun', async () => {
    const requiredChecks = ['test'];
    for (const reverse of [false, true]) {
      const scans = [
        { name: 'CodeQL', id: 123, run_id: 100, run_attempt: 3, status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'CodeQL', id: 234, run_id: 200, run_attempt: 1, status: 'COMPLETED', conclusion: 'FAILURE' },
      ];
      const rollup = [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
        ...(reverse ? scans.toReversed() : scans),
      ];
      const result = verdictRecheck.gateOnlyRedStates({ requiredChecks, rollup,
        drainGateSettings: { drainBlocksOnCodeQL: true } });
      expect.soft(result.gateOnlyRed).toBe(false);
      expect.soft(result.red).toContain('CodeQL');
      expect.soft(await checkNeedsHumanEscalable({
        pr: 6042, headSha: fixture.headRefOid, outcome: 'needs-human', settings: { recheckNotCiBreak: true },
        readPr: () => ({ headRefOid: fixture.headRefOid, statusCheckRollup: rollup }),
        readRequired: () => ({ checks: requiredChecks }),
      })).toEqual({ refusal: null });
    }
  });

  it('keeps a required merge-gate npm ci failure red and allows needs-human escalation', async () => {
    const requiredChecks = ['test', 'merge-gate'];
    const rollup = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', output: { summary: 'npm ci failed' } },
    ];
    const evidence = { ...input, requiredChecks, rollup };
    expect.soft(requiredCheckStates(evidence).red).toEqual(['merge-gate']);
    expect.soft(contradictingChecks(evidence)).toEqual(['merge-gate']);
    expect.soft(ciGreenForEscalation(evidence)).toBe(false);
    expect.soft(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
    expect(await checkNeedsHumanEscalable({
      pr: 6042, headSha: fixture.headRefOid, outcome: 'needs-human', settings: { recheckNotCiBreak: true },
      readPr: () => ({ headRefOid: fixture.headRefOid, statusCheckRollup: rollup }),
      readRequired: () => ({ checks: requiredChecks }),
    })).toEqual({ refusal: null });
  });

  it('counts a drain-blocking CodeQL failure alongside review-gate and allows needs-human escalation', async () => {
    const requiredChecks = ['test'];
    const rollup = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    const result = verdictRecheck.gateOnlyRedStates({ requiredChecks, rollup });
    expect.soft(verdictRecheck.gateOnlyRedStates({ drainGateSettings: { drainBlocksOnCodeQL: true }, requiredChecks, rollup }).gateOnlyRed).toBe(false);
    expect.soft(result.gateOnlyRed).toBe(false);
    expect.soft(result.red).toContain('CodeQL');
    expect(await checkNeedsHumanEscalable({
      pr: 6042, headSha: fixture.headRefOid, outcome: 'needs-human', settings: { recheckNotCiBreak: true },
      readPr: () => ({ headRefOid: fixture.headRefOid, statusCheckRollup: rollup }),
      readRequired: () => ({ checks: requiredChecks }),
    })).toEqual({ refusal: null });
  });

  it('exempts only a review hold positively classified for the current merge-gate job', () => {
    const row = { name: 'merge-gate', id: 123, status: 'COMPLETED', conclusion: 'FAILURE' };
    for (const readable of [false, true]) {
      const classified = excuseMergeGateRows([row], {
        prNumber: 6042, headSha: fixture.headRefOid, labels: ['ready-to-merge'], setting: 'on',
        readVerdict: () => readable ? { num: 6042, head_sha: fixture.headRefOid, ok: false,
          results: [{ id: 'review-acceptance', status: 'hold', reason: 'review pending' }] }
          : { error: 'job log unreadable' },
      });
      expect(Boolean(classified.reviewHold)).toBe(readable);
      const evidence = { ...input, requiredChecks: ['test', 'merge-gate'], rollup: [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, ...classified.rows,
      ] };
      expect(requiredCheckStates(evidence).red).toEqual(readable ? [] : ['merge-gate']);
      expect(ciGreenForEscalation(evidence)).toBe(readable);
      expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(readable);
    }
  });

  it('CodeQL failure is never excused by another attempt or the drain switch', () => {
    for (const conclusion of ['SUCCESS', 'FAILURE', 'CANCELLED']) {
      const evidence = { requiredChecks: ['test'], rollup: [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', run_attempt: 1, completedAt: '2026-10-28T12:00:00-04:00' },
        { name: 'CodeQL', status: 'COMPLETED', conclusion, run_attempt: 2, completedAt: '2026-10-28T13:00:00-04:00' },
      ] };
      for (const drainBlocksOnCodeQL of [false, true]) {
        expect(verdictRecheck.gateOnlyRedStates({ ...evidence, drainGateSettings: { drainBlocksOnCodeQL } }).gateOnlyRed)
          .toBe(false);
      }
    }
  });
});

describe('requiredCheckStates shared predicate regressions', () => {
  it.each([false, true])('partial attempt metadata cannot hide newer rollup evidence (reverse=%s)', reverse => {
    for (const [olderMetadata, newerMetadata] of [
      [{ run_attempt: 1, id: 100 }, {}],
      [{ run_id: 100, id: 100 }, {}],
      [{ run_attempt: '1', id: '100' }, {}],
      [{ run_attempt: 'invalid', id: 100 }, {}],
      [{}, { run_attempt: 1, id: 100 }],
      [{ run_attempt: 1, id: 100 }, { run_attempt: null }],
      [{ run_attempt: 1, id: 100 }, { run_attempt: 'invalid' }],
      [{ run_attempt: 1, id: 100 }, { run_id: 200 }],
      [{ run_attempt: 1, id: 100 }, { run_attempt: 1 }],
      [{ run_id: 100, run_attempt: 1, id: 100 }, { run_id: 100 }],
    ]) {
      for (const conclusion of ['FAILURE', 'CANCELLED', 'SUCCESS']) {
        const rows = [
          { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: conclusion === 'SUCCESS' ? 'FAILURE' : 'SUCCESS',
            completedAt: '2026-10-28T01:00:00Z', ...olderMetadata },
          { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion,
            completedAt: '2026-10-28T02:00:00Z', ...newerMetadata },
        ];
        const evidence = { ...input, requiredChecks: ['test'], rollup: [
          ...(reverse ? rows.toReversed() : rows),
          { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
        ] };
        const expected = { red: [], pending: [], missing: [], green: [] };
        expected[conclusion === 'CANCELLED' ? 'pending' : 'red'] = ['test'];
        expect(requiredCheckStates(evidence)).toEqual(expected);
        expect(contradictingChecks(evidence)).toEqual(expected.red);
        expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(conclusion === 'CANCELLED');
        expect(ciGreenForEscalation(evidence)).toBe(false);
      }
    }
  });

  it.each([false, true])('partial attempt metadata cannot hide an in-flight required check (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 1, id: 100, completedAt: '2026-10-28T01:00:00Z' },
      { name: 'test', status: 'IN_PROGRESS', conclusion: null },
    ];
    const evidence = { ...input, requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows };
    expect(requiredCheckStates(evidence)).toEqual({ red: [], pending: ['test'], missing: [], green: [] });
    expect(ciGreenForEscalation(evidence)).toBe(false);
    expect(contradictingChecks(evidence)).toEqual([]);
  });

  it.each([false, true])('unrelated attempt metadata cannot hide a timestamped required failure (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T01:00:00Z' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T02:00:00Z' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    for (const optional of [[], [{ name: 'unrelated-optional', status: 'COMPLETED', conclusion: 'SUCCESS', id: 100, run_attempt: 1 }]]) {
      const rollup = [...(reverse ? rows.toReversed() : rows), ...optional];
      const evidence = { ...input, requiredChecks: ['test'], rollup };
      expect(requiredCheckStates(evidence)).toEqual({ red: ['test'], pending: [], missing: [], green: [] });
      expect(contradictingChecks(evidence)).toEqual(['test']);
      expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
      expect(ciGreenForEscalation(evidence)).toBe(false);
    }
  });

  it.each([false, true])('partial metadata and newer success cannot hide failure (reverse=%s)', reverse => {
    for (const [olderMetadata, newerMetadata] of [
      [{ run_attempt: 1, id: 100 }, { run_attempt: 2 }],
      [{ run_id: 100, run_attempt: 1, id: 100 }, { run_id: 100, run_attempt: 2 }],
      [{ run_id: 100, run_attempt: 2, id: 100 }, { id: 200 }],
    ]) {
      const rows = [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T02:00:00Z', ...olderMetadata },
        { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T01:00:00Z', ...newerMetadata },
      ];
      expect(requiredCheckStates({ requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows }))
        .toEqual({ red: ['test'], pending: [], missing: [], green: [] });
    }
  });

  it.each([false, true])('cross-run completion times and partial check ids cannot hide failure (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', run_id: 100, run_attempt: 2, id: 100, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T02:00:00Z' },
      { name: 'test', run_id: 200, status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T01:00:00Z' },
    ];
    expect(requiredCheckStates({ requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows }))
      .toEqual({ red: ['test'], pending: [], missing: [], green: [] });
  });

  it.each([false, true])('R1b: a failure in a different workflow run stays red across verdict readers (reverse=%s)', reverse => {
    const runs = [
      { name: 'test', run_id: 100, run_attempt: 2, id: 1001, completedAt: '2026-10-28T12:00:00-04:00', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test', run_id: 200, run_attempt: 1, id: 2001, completedAt: '2026-10-28T13:00:00-04:00', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    const evidence = { ...input, requiredChecks: ['test'], rollup: [
      ...(reverse ? runs.toReversed() : runs),
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] };
    expect(requiredCheckStates(evidence)).toEqual({ red: ['test'], pending: [], missing: [], green: [] });
    expect(contradictingChecks(evidence)).toEqual(['test']);
    expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
    expect(ciGreenForEscalation(evidence)).toBe(false);
  });

  it.each([false, true])('timestamps and check-run ids cannot hide failures per exact name (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T01:00:00Z' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T02:00:00Z' },
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 2, id: 1 },
      { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', run_attempt: 1, id: 99 },
      { __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS', completedAt: '2026-10-28T01:00:00Z' },
      { __typename: 'StatusContext', context: 'legacy', state: 'FAILURE', completedAt: '2026-10-28T02:00:00Z' },
    ];
    expect(requiredCheckStates({ requiredChecks: ['test', 'build', 'legacy'], rollup: reverse ? rows.toReversed() : rows }))
      .toEqual({ red: ['test', 'build', 'legacy'], pending: [], missing: [], green: [] });
  });

  it.each([false, true])('legacy success cannot hide a CheckRun failure (reverse=%s)', reverse => {
    const rows = [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T01:00:00Z' },
      { context: 'test', state: 'SUCCESS', id: 100, run_attempt: 2 },
    ];
    expect(requiredCheckStates({ requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows }))
      .toEqual({ red: ['test'], pending: [], missing: [], green: [] });
  });

  it.each([false, true])('CheckRun failure stays red beside an untagged named success (reverse=%s)', reverse => {
    const rows = [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T01:00:00Z' },
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T02:00:00Z' },
    ];
    expect(requiredCheckStates({ requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows }))
      .toEqual({ red: ['test'], pending: [], missing: [], green: [] });
  });

  it.each(['FAILURE', 'STARTUP_FAILURE'])('undated %s blocks false CI-green verdicts across readers', async conclusion => {
    for (const kind of ['CheckRun', 'untagged', 'StatusContext']) {
      const rows = [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T01:00:00Z' },
        { name: 'test', status: 'COMPLETED', conclusion },
      ].map(row => kind === 'StatusContext'
        ? { __typename: kind, context: row.name, state: row.conclusion, completedAt: row.completedAt }
        : kind === 'CheckRun' ? { ...row, __typename: kind } : row);
      for (const pair of [rows, rows.toReversed()]) {
        const evidence = { ...input, requiredChecks: ['test'], rollup: [
          ...pair, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
        ] };
        expect(requiredCheckStates(evidence)).toEqual({ red: ['test'], pending: [], missing: [], green: [] });
        expect(contradictingChecks(evidence)).toEqual(['test']);
        expect(ciGreenForEscalation(evidence)).toBe(false);
        expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
        const pr = { headRefOid: input.headSha, statusCheckRollup: evidence.rollup };
        expect(notCiBreakRecordRefusal({ headSha: input.headSha, pr, requiredChecks: ['test'] })).toBeTruthy();
        const options = { headSha: input.headSha, settings: { recheckNotCiBreak: true },
          readPr: async () => pr, readRequired: async () => ({ checks: ['test'] }) };
        expect(await checkNeedsHumanEscalable({ ...options, outcome: 'needs-human' })).toEqual({ refusal: null });
        expect(await checkNotCiBreakRecordable({ ...options, outcome: 'not-a-ci-break' }))
          .toEqual({ refusal: expect.stringContaining('red: test') });
      }
    }
  });

  // Every completed outcome, undated in every way, against a dated opposite, in every tier and input order.
  const undatedShapes = [
    ['no timestamp', {}],
    ['invalid completion time', { completedAt: 'not-a-date' }],
    ['epoch completion time', { completedAt: '1970-01-01T00:00:00Z' }],
    ['pre-2000 completion time', { completed_at: '1999-12-31T23:59:59Z' }],
    ['invalid start and creation times', { startedAt: 'garbage', created_at: '0' }],
    // Date.parse reads these as year 2000-2026 dates in local time; none is a real timestamp.
    ['bare-number strings', { completedAt: '12', startedAt: '1', createdAt: '2026' }],
    ['numeric values', { completedAt: 0, started_at: 1793192400000 }],
    ['zone-less and impossible dates', { completedAt: '2026-10-28T02:00:00', startedAt: '2026-02-31T02:00:00Z' }],
    ['far-future times', { completedAt: '9999-12-31T23:59:59Z', startedAt: new Date(Date.now() + 2 * 86400000).toISOString() }],
  ];
  const tierRow = (kind, { conclusion, ...rest }) => kind === 'StatusContext'
    ? { __typename: kind, context: 'test', state: conclusion, ...rest }
    : { ...(kind === 'CheckRun' ? { __typename: kind } : {}), name: 'test', status: 'COMPLETED', conclusion, ...rest };
  const assertUndatedPair = async ({ dated, undated, bucket }) => {
    for (const kind of ['CheckRun', 'untagged', 'StatusContext']) {
      for (const [, timestamps] of undatedShapes) {
        const rows = [
          tierRow(kind, { conclusion: dated, completedAt: '2026-10-28T01:00:00Z' }),
          tierRow(kind, { conclusion: undated, ...timestamps }),
        ];
        for (const pair of [rows, rows.toReversed()]) {
          const evidence = { ...input, requiredChecks: ['test'], rollup: [
            ...pair, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
          ] };
          const expected = { red: [], pending: [], missing: [], green: [] };
          expected[bucket] = ['test'];
          expect(requiredCheckStates(evidence), `${kind} ${dated}/${undated} ${JSON.stringify(timestamps)}`)
            .toEqual(expected);
          expect(contradictingChecks(evidence)).toEqual(expected.red);
          expect(ciGreenForEscalation(evidence)).toBe(bucket === 'green');
          expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(bucket !== 'red');
          const pr = { headRefOid: input.headSha, statusCheckRollup: evidence.rollup };
          expect(Boolean(notCiBreakRecordRefusal({ headSha: input.headSha, pr, requiredChecks: ['test'] })))
            .toBe(bucket !== 'green');
        }
      }
    }
  };

  it.each(['SUCCESS', 'NEUTRAL', 'SKIPPED'])('dated failure stays red beside undated %s in both input orders', async undated => {
    await assertUndatedPair({ dated: 'FAILURE', undated, bucket: 'red' });
  });

  it.each(['TIMED_OUT', 'ACTION_REQUIRED', 'FUTURE_UNKNOWN_CONCLUSION', '', null])(
    'undated %j outcome stays red beside a dated success in both input orders', async undated => {
      await assertUndatedPair({ dated: 'SUCCESS', undated, bucket: 'red' });
    },
  );

  it.each(['CANCELLED', 'STALE'])('undated %s stays pending beside a dated success in both input orders', async undated => {
    await assertUndatedPair({ dated: 'SUCCESS', undated, bucket: 'pending' });
  });

  it.each(['2026-10-28T02:00:00.5Z', '2026-10-27T22:00:00-04:00', '2026-10-28t02:00:00z'])(
    'a zoned ISO timestamp %s cannot hide failure in both input orders', completedAt => {
      const rows = [
        { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T01:00:00Z' },
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt },
      ];
      for (const rollup of [rows, rows.toReversed()]) {
        expect(requiredCheckStates({ requiredChecks: ['test'], rollup }))
          .toEqual({ red: ['test'], pending: [], missing: [], green: [] });
      }
    },
  );

  it('timestamps around the former future-skew bound never discard a failure', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const failure = { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T11:00:00Z' };
    for (const completedAt of [
      '2026-10-29T11:59:59Z', '2026-10-29T12:00:00Z', '2026-10-29T12:00:01Z',
    ]) {
      const success = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt };
      for (const rollup of [[failure, success], [success, failure]]) {
        expect(verdictRecheck.latestRollupAttempts(rollup, { now })).toEqual(rollup);
        expect(requiredCheckStates({ rollup, requiredChecks: ['test'] }).red).toEqual(['test']);
      }
    }
  });

  it('undated success under a dated success stays green in both input orders', async () => {
    await assertUndatedPair({ dated: 'SUCCESS', undated: 'SUCCESS', bucket: 'green' });
  });

  it.each([false, true])('an untagged failure stays red beside a legacy StatusContext success (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T01:00:00Z' },
      { __typename: 'StatusContext', context: 'test', state: 'SUCCESS', id: 100 },
    ];
    expect(requiredCheckStates({ requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows }))
      .toEqual({ red: ['test'], pending: [], missing: [], green: [] });
  });

  it.each([false, true])('an undated PENDING StatusContext blocks green beside a dated SUCCESS (reverse=%s)', reverse => {
    const rows = [
      { __typename: 'StatusContext', context: 'test', state: 'SUCCESS', completedAt: '2026-10-28T01:00:00Z' },
      { __typename: 'StatusContext', context: 'test', state: 'PENDING' },
    ];
    expect(requiredCheckStates({ requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows }))
      .toEqual({ red: [], pending: ['test'], missing: [], green: [] });
  });

  it.each(['CANCELLED', 'STALE'])('required %s is pending, never red or missing', conclusion => {
    expect(requiredCheckStates({ ...input, requiredChecks: ['Test'], rollup: [
      { name: 'Test', status: 'COMPLETED', conclusion },
    ] })).toEqual({ red: [], pending: ['Test'], missing: [], green: [] });
  });

  it.each([false, true])('timestamps beat numeric run_attempt in either row order (reverse=%s)', reverse => {
    const rollup = [
      { name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 2, id: 10,
        startedAt: '2026-10-09T02:00:00Z', completedAt: '2026-10-09T02:01:00Z' },
      { name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE', run_attempt: 1, id: 99,
        startedAt: '2026-10-09T04:00:00Z', completedAt: '2026-10-09T04:01:00Z' },
    ];
    expect(requiredCheckStates({ ...input, requiredChecks: ['Test'], rollup: reverse ? rollup.toReversed() : rollup }))
      .toEqual({ red: ['Test'], pending: [], missing: [], green: [] });
  });

  it('the latest failed attempt cannot be hidden by an older green attempt', () => {
    const older = { name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 1,
      completedAt: '2026-10-28T01:00:00Z' };
    const newer = { name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE', run_attempt: 2,
      completedAt: '2026-10-28T02:00:00Z' };
    for (const rollup of [[older, newer], [newer, older]]) {
      expect(requiredCheckStates({ ...input, requiredChecks: ['Test'], rollup }))
        .toEqual({ red: ['Test'], pending: [], missing: [], green: [] });
    }
  });

  it.each(['created_at', 'createdAt', 'startedAt'])(
    'legacy StatusContext failures stay red despite %s metadata in both input orders', field => {
      const older = { __typename: 'StatusContext', context: 'Test', state: 'SUCCESS',
        [field]: '2026-10-28T01:00:00Z' };
      const newer = { __typename: 'StatusContext', context: 'Test', state: 'FAILURE',
        [field]: '2026-10-28T02:00:00Z' };
      for (const rollup of [[older, newer], [newer, older]]) {
        expect(requiredCheckStates({ ...input, requiredChecks: ['Test'], rollup }))
          .toEqual({ red: ['Test'], pending: [], missing: [], green: [] });
      }
    },
  );

  it('an unknown completed conclusion fails closed red with its original-case name', () => {
    expect(requiredCheckStates({ ...input, requiredChecks: ['Test'], rollup: [
      { name: 'Test', status: 'COMPLETED', conclusion: 'FUTURE_UNKNOWN_CONCLUSION' },
    ] })).toEqual({ red: ['Test'], pending: [], missing: [], green: [] });
  });

  it.each([
    ['SUCCESS', 'green'], ['FAILURE', 'red'], ['ERROR', 'red'], ['PENDING', 'pending'], ['EXPECTED', 'pending'],
  ])('legacy StatusContext %s remains %s and preserves original case', (state, bucket) => {
    const expected = { red: [], pending: [], missing: [], green: [] };
    expected[bucket] = ['Legacy-CI'];
    expect(requiredCheckStates({ ...input, requiredChecks: ['Legacy-CI'], rollup: [
      { __typename: 'StatusContext', context: 'Legacy-CI', state },
    ] })).toEqual(expected);
  });

  it('missing contains only required names with no row, preserving all result names and the four-field shape', () => {
    expect(requiredCheckStates({ ...input, requiredChecks: ['Test', 'Build', 'Absent'], rollup: [
      { name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Build', status: 'IN_PROGRESS', conclusion: null },
      { name: 'Optional', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] })).toEqual({ red: [], pending: ['Build'], missing: ['Absent'], green: ['Test'] });
  });
});

describe('gateOnlyRedStates', () => {
  it.each(['review-gate', 'merge-gate'])('includes proven review hold %s even when absent from the required roster', name => {
    expect(verdictRecheck.gateOnlyRedStates({ ...input, rollup: [
      ...green, { name, status: 'COMPLETED', conclusion: 'FAILURE',
        ...(name === 'merge-gate' ? { mergeGateReviewHold: { holds: ['review-acceptance'], jobId: 123 } } : {}) },
    ] })).toEqual({ gateOnlyRed: true, red: [name] });
  });

  it('recognizes both gates red together', () => {
    const result = verdictRecheck.gateOnlyRedStates({ ...input, rollup: [
      ...green, ...['review-gate', 'merge-gate'].map(name => ({ name, status: 'COMPLETED', conclusion: 'FAILURE',
        ...(name === 'merge-gate' ? { mergeGateReviewHold: { holds: ['review-acceptance'], jobId: 123 } } : {}) })),
    ] });
    expect(result.gateOnlyRed).toBe(true);
    expect(result.red.toSorted()).toEqual(['merge-gate', 'review-gate']);
  });

  it('a real required failure alongside a red gate is not gate-only red', () => {
    const result = verdictRecheck.gateOnlyRedStates({ requiredChecks: ['test'], rollup: [
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] });
    expect(result.gateOnlyRed).toBe(false);
    expect(result.red.toSorted()).toEqual(['review-gate', 'test']);
  });

  it('no red checks is not gate-only red', () => {
    expect(verdictRecheck.gateOnlyRedStates({ ...input, rollup: green }))
      .toEqual({ gateOnlyRed: false, red: [] });
  });
});

describe('required check verdict recheck', () => {
  it('contradicts the real #4535 verdict only for test', () => {
    expect(contradictingChecks(input)).toEqual(['test']);
    expect(notCiBreakContradicted(input)).toBe(true);
    expect(requiredCheckStates(input).red).toEqual(['test']);
  });
  it('review-gate red alone never contradicts', () => {
    const rollup = [...fixture.statusCheckRollup.filter((r) => r.name === 'review-gate' && r.conclusion === 'FAILURE'), ...green];
    expect(contradictingChecks({ ...input, rollup, requiredChecks: [...fixture.requiredChecks, 'review-gate'] })).toEqual([]);
  });
  it.each([{ outcome: 'needs-human', headSha: fixture.headRefOid }, { outcome: 'not-a-ci-break', headSha: 'abcdef0123456789' }])('ignores unrelated escalation %j', (escalation) => {
    expect(contradictingChecks({ ...input, escalation })).toEqual([]);
  });
  it('matches an abbreviated escalation head', () => expect(contradictingChecks({ ...input, escalation: { ...input.escalation, headSha: fixture.headRefOid.slice(0, 9) } })).toEqual(['test']));
  it('a newer success cannot hide an old red appearing last in the array', () => {
    const rollup = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-09T04:00:00Z', completedAt: '2026-10-09T04:01:00Z' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-09T02:00:00Z', completedAt: '2026-10-09T02:01:00Z' },
    ];
    expect(contradictingChecks({ ...input, rollup, requiredChecks: ['test'] })).toEqual(['test']);
  });
  it('cannot declare not-a-ci-break while the fixture checks are unfinished', () => {
    const rollup = fixture.statusCheckRollup.filter((r) => r.startedAt <= fixture.escalationAt)
      .map((r) => r.completedAt > fixture.escalationAt ? { ...r, status: 'IN_PROGRESS', conclusion: null } : r);
    const result = unsettledRequiredChecks({ ...input, rollup });
    expect([...result.pending, ...result.missing]).toEqual(expect.arrayContaining(['test', 'daemon-soak']));
    expect(result.red).toEqual([]);
  });
  it('unknown required set claims nothing red', () => expect(contradictingChecks({ ...input, requiredChecks: [] })).toEqual([]));
  it('legacy StatusContext failures count', () => {
    expect(contradictingChecks({ ...input, rollup: [{ __typename: 'StatusContext', context: 'test', state: 'FAILURE' }] })).toEqual(['test']);
  });
});

describe('resolveCiHealVerdictSettings', () => {
  it.each([['off', 'on', false], ['on', 'off', true]])('env %s overrides file %s', (env, file, value) => {
    expect(resolveCiHealVerdictSettings({ WE_CI_HEAL_RECHECK_NOT_CI_BREAK: env }, { read: () => JSON.stringify({ ciHealVerdict: { recheckNotCiBreak: file } }) })).toMatchObject({ recheckNotCiBreak: value });
  });
  it('malformed settings fail closed', () => expect(resolveCiHealVerdictSettings({}, { read: () => '{' })).toMatchObject({ recheckNotCiBreak: false }));
  it('checked-in settings enable rechecking', () => expect(resolveCiHealVerdictSettings({})).toMatchObject({ recheckNotCiBreak: true }));
});


describe('void needs-human settings and green evidence', () => {
  const resolve = (platform, repo, env = {}) => resolveVoidNeedsHumanWhenCiGreen(env, {
    platformPath: 'platform', path: 'repo',
    read: path => JSON.stringify({ ciHealVerdict: { voidNeedsHumanWhenCiGreen: path === 'platform' ? platform : repo } }),
  });
  it('cascades standard → platform → repo → env', () => {
    expect(resolve()).toMatchObject({ value: true, source: 'standard' });
    expect(resolve('off')).toMatchObject({ value: false, source: 'platform' });
    expect(resolve('off', 'on')).toMatchObject({ value: true, source: 'repo' });
    expect(resolve('on', 'on', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'off' })).toMatchObject({ value: false, source: 'env' });
  });
  it('fails closed on invalid layers with reasons', () => {
    const result = resolve('off', 'invalid', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'bad' });
    expect(result).toMatchObject({ value: false, source: 'repo' });
    expect(result.ignored).toEqual([expect.objectContaining({ source: 'repo', reason: expect.any(String) }), expect.objectContaining({ source: 'env', reason: expect.any(String) })]);
    expect(resolveVoidNeedsHumanWhenCiGreen({}, { read: () => '{' })).toMatchObject({ value: false, source: 'platform' });
  });
  it.each(['{', 'null', '[]', '{"ciHealVerdict":null}', '{"ciHealVerdict":[]}', '{"ciHealVerdict":{"voidNeedsHumanWhenCiGreen":true}}'])('invalid document %s cannot be overridden on', document => {
    expect(resolveVoidNeedsHumanWhenCiGreen({ WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'on' }, {
      platformPath: 'platform', path: 'repo', read: path => path === 'platform' ? document : '{}',
    }).value).toBe(false);
  });
  it.each(['EACCES', 'EIO'])('unreadable platform %s cannot be overridden on', code => {
    expect(resolveVoidNeedsHumanWhenCiGreen({ WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'on' }, {
      read: () => { throw Object.assign(new Error(code), { code }); },
    }).value).toBe(false);
  });
  it('allows absent optional platform preferences but fails closed on a missing repo file', () => {
    const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    expect(resolveVoidNeedsHumanWhenCiGreen({}, { platformPath: 'platform', read: path => path === 'platform' ? missing() : '{}' }).value).toBe(true);
    expect(resolveVoidNeedsHumanWhenCiGreen({}, { read: missing }).value).toBe(false);
  });
  it('exposes the resolved boolean and source', () => {
    expect(resolveCiHealVerdictSettings({ WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'off' })).toMatchObject({ voidNeedsHumanWhenCiGreen: false, voidNeedsHumanSource: 'env' });
  });
  it('invalid repo or env cannot silently restore the default on', () => {
    expect(resolve('on', 'invalid').value).toBe(false);
    expect(resolve('on', 'on', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'invalid' }).value).toBe(false);
    expect(resolve('invalid', 'on', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'on' }).value).toBe(false);
  });
  it('requires a known, settled required set, excluding review-gate', () => {
    const checks = ['test', 'review-gate'];
    const rollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }];
    expect(ciGreenForEscalation({ rollup, requiredChecks: checks })).toBe(true);
    for (const conclusion of ['FAILURE', 'TIMED_OUT']) expect(ciGreenForEscalation({ rollup: [{ ...rollup[0], conclusion }], requiredChecks: checks })).toBe(false);
    expect(ciGreenForEscalation({ rollup: [{ ...rollup[0], status: 'IN_PROGRESS' }], requiredChecks: checks })).toBe(false);
    expect(ciGreenForEscalation({ rollup: [], requiredChecks: checks })).toBe(false);
    expect(ciGreenForEscalation({ rollup, requiredChecks: [] })).toBe(false);
  });
});


describe('R4 metadata regressions across verdict readers', () => {
  it.each([false, true])('older-run rerun failure completed later stays red (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', run_id: 200, run_attempt: 1, id: 2001, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T12:00:00-04:00' },
      { name: 'test', run_id: 100, run_attempt: 2, id: 1001, status: 'COMPLETED', conclusion: 'FAILURE', completed_at: '2026-10-28T13:00:00-04:00' },
    ];
    const evidence = { ...input, requiredChecks: ['test'], rollup: [
      ...(reverse ? rows.toReversed() : rows),
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] };
    expect(requiredCheckStates(evidence)).toEqual({ red: ['test'], pending: [], missing: [], green: [] });
    expect(contradictingChecks(evidence)).toEqual(['test']);
    expect(ciGreenForEscalation(evidence)).toBe(false);
    expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
  });

  it.each([false, true])('equal timestamps and adjacent large ids cannot hide a failure (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', id: '9007199254740992', run_attempt: 99, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T12:00:00-04:00' },
      { name: 'test', id: '9007199254740993', status: 'COMPLETED', conclusion: 'FAILURE', completed_at: '2026-10-28T12:00:00-04:00' },
    ];
    expect(requiredCheckStates({ requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows }).red).toEqual(['test']);
  });
});


describe('R272 fail-closed evidence across every row', () => {
  it.each([
    ['all successes', { status: 'COMPLETED', conclusion: 'SUCCESS' }, 'green'],
    ['mixed success and failure', { status: 'COMPLETED', conclusion: 'FAILURE' }, 'red'],
    ['pending alongside success', { status: 'PENDING' }, 'pending'],
    ['in-progress alongside success', { status: 'IN_PROGRESS' }, 'pending'],
    ['queued alongside success', { status: 'QUEUED' }, 'pending'],
    ['cancelled alongside success', { status: 'COMPLETED', conclusion: 'CANCELLED' }, 'pending'],
    ['undated unknown alongside success', {}, 'red'],
  ])('%s respects every source type and input order', (_label, evidence, bucket) => {
    for (const kind of ['CheckRun', 'untagged', 'StatusContext']) {
      const blocker = kind === 'StatusContext'
        ? { __typename: kind, context: 'test', state: evidence.conclusion ?? evidence.status }
        : { ...(kind === 'CheckRun' ? { __typename: kind } : {}), name: 'test', ...evidence };
      const success = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS',
        run_id: 999, run_attempt: 999, id: 999, completedAt: '2099-01-01T00:00:00Z' };
      for (const rollup of [[success, blocker], [blocker, success]]) {
        const expected = { red: [], pending: [], missing: [], green: [] };
        // Legacy contexts have no IN_PROGRESS/QUEUED state: unknown values stay red.
        const expectedBucket = kind === 'StatusContext' && ['IN_PROGRESS', 'QUEUED'].includes(evidence.status)
          ? 'red' : bucket;
        expected[expectedBucket] = ['test'];
        expect(requiredCheckStates({ rollup, requiredChecks: ['test'] })).toEqual(expected);
        expect(ciGreenForEscalation({ rollup, requiredChecks: ['test'] })).toBe(bucket === 'green');
      }
    }
  });

  it.each([false, true])('CodeQL failure never counts as gate-only with drainBlocksOnCodeQL=%s', drainBlocksOnCodeQL => {
    for (const reverse of [false, true]) {
      const rows = [
        { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', run_attempt: 1 },
        { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 2 },
        { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ];
      const rollup = reverse ? rows.toReversed() : rows;
      expect(verdictRecheck.gateOnlyRedStates({ rollup, requiredChecks: ['test'],
        drainGateSettings: { drainBlocksOnCodeQL } }).gateOnlyRed).toBe(false);
      expect(notCiBreakRecordRefusal({ headSha: input.headSha,
        pr: { headRefOid: input.headSha, statusCheckRollup: rollup }, requiredChecks: ['test'] }))
        .toContain('red: CodeQL');
    }
  });
});
