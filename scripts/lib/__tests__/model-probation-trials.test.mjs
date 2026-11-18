/**
 * #4290 — a probation launch becomes a judged trial once its PR's review verdict lands, through the real path:
 * the launcher's own launch row, the shared scorecard store, and the graduation report that reads it.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  graduationProgress, judgePendingTrials, judgedTrialRow, pendingProbationLaunches, trialOutcomeFromPr, runJudge,
} from '../model-probation.mjs';
import { launchScorecardRow } from '../probation-launcher.mjs';
import { appendScorecard, readStore, writeStore } from '../../conveyor/run-scorecard-store.mjs';
import { criticalMissesFor, isCriticalMiss } from '../critical-work.mjs';

const worker = { id: 'codex', provider: 'codex', model: 'gpt-6-astra', executor: 'codex', taskType: 'ci-heal' };
const launch = (o = {}) => launchScorecardRow({ worker, pr: 101, repo: 'o/r', handle: 'heal-101', launchOutcome: 'healed', diff: { files: 1, loc: 4 }, scoredAt: '2026-09-27T00:00:00Z', ...o });

describe('trialOutcomeFromPr', () => {
  it.each([
    [{ state: 'MERGED', labels: [] }, 'landed'],
    [{ state: 'OPEN', mergedAt: '2026-09-28T00:00:00Z' }, 'landed'],
    [{ state: 'CLOSED', mergedAt: null, labels: [{ name: 'review:accepted' }] }, 'rejected'],
    [{ state: 'OPEN', labels: [{ name: 'review:changes' }] }, 'reworked'],
    [{ state: 'OPEN', labels: ['review:changes'] }, 'reworked'],
    [{ state: 'OPEN', labels: [{ name: 'review:accepted' }] }, null],
    [{ state: 'OPEN', labels: [{ name: 'review:pending' }] }, null],
    [{ state: 'OPEN', labels: [{ name: 'review:human' }] }, null],
    [{ state: 'OPEN' }, null],
    [null, null],
    ['MERGED', null],
  ])('%j → %s', (pr, want) => expect(trialOutcomeFromPr(pr)).toBe(want));
});

describe('pendingProbationLaunches', () => {
  it('only pushed heals with a PR and no trial yet', () => {
    const rows = [
      launch(),
      launch({ handle: 'h-gate-red', launchOutcome: 'gate-red' }),
      launch({ handle: 'h-no-pr', pr: null }),
      launch({ handle: 'h-done' }),
      judgedTrialRow(launch({ handle: 'h-done' }), { outcome: 'landed', reviewed: true, isCriticalMiss }),
    ];
    expect(pendingProbationLaunches(rows).map((r) => r.handle)).toEqual(['heal-101']);
    expect(pendingProbationLaunches(null)).toEqual([]);
  });
});

describe('judgedTrialRow', () => {
  it('refuses an outcome outside landed|reworked|rejected', () => {
    expect(() => judgedTrialRow(launch(), { outcome: 'healed' })).toThrow(/landed\|reworked\|rejected/);
  });

  it('never infers informative, and stamps the critical-miss answer on the PR\'s real scope', () => {
    const safe = judgedTrialRow(launch(), { outcome: 'reworked', changedFiles: ['docs/a.md'], isCriticalMiss });
    expect(safe).toMatchObject({ outcome: 'reworked', informative: false, verifiedBy: 'independent-claude', filesTouched: ['docs/a.md'], criticalMiss: false });
    const unscoped = judgedTrialRow(launch(), { outcome: 'rejected', isCriticalMiss });
    expect(unscoped.criticalMiss).toBe(true); // no scope on record ⇒ fail closed
    expect(unscoped).not.toHaveProperty('filesTouched');
  });
});

describe('judgePendingTrials through the real scorecard store', () => {
  let dir;
  let io;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'probation-trials-')); io = { path: join(dir, 'run-scorecards.json') }; writeStore({ version: 1, records: [] }, io); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('converts a reviewed launch into a verified trial the report counts, once', () => {
    appendScorecard(launch(), io);
    appendScorecard(launch({ handle: 'heal-102', pr: 102 }), io);
    const prs = {
      101: { state: 'MERGED', labels: [{ name: 'review:accepted' }], files: [{ path: 'docs/a.md' }] },
      102: { state: 'OPEN', labels: [{ name: 'review:pending' }], files: [] },
    };
    const sweep = () => judgePendingTrials(readStore(io).records, {
      lookupPr: (l) => prs[l.pr], append: (row) => appendScorecard(row, io), isCriticalMiss, now: () => '2026-09-28T00:00:00Z',
    });

    const before = graduationProgress(readStore(io).records, { criticalMissesFor }).triples[0];
    expect(before).toMatchObject({ launched: 2, verified: 0 });

    const first = sweep();
    expect(first.judged.map((r) => [r.pr, r.outcome])).toEqual([[101, 'landed']]);
    expect(first.pending.map((r) => r.pr)).toEqual([102]);

    const after = graduationProgress(readStore(io).records, { criticalMissesFor }).triples[0];
    expect(after).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', taskType: 'ci-heal', launched: 1, verified: 1, outcomes: { landed: 1 } });

    // Idempotent: a second sweep adds nothing for 101; 102 is judged once its review sends it back.
    prs[102] = { reviewLabelAt: '2026-09-28T00:00:00Z', state: 'OPEN', labels: [{ name: 'review:changes' }], files: [{ path: 'scripts/review-set-label.mjs' }] };
    const second = sweep();
    expect(second.judged.map((r) => [r.pr, r.outcome, r.criticalMiss])).toEqual([[102, 'reworked', true]]);
    expect(sweep().judged).toEqual([]);

    const final = graduationProgress(readStore(io).records, { criticalMissesFor }).triples[0];
    expect(final).toMatchObject({ launched: 0, verified: 2, outcomes: { landed: 1, reworked: 1 } });
    expect(final.criteria.criticalMisses).toMatchObject({ have: 1, met: false });
  });

  it('a failed PR lookup leaves the launch pending — never a guessed outcome', () => {
    appendScorecard(launch(), io);
    const r = judgePendingTrials(readStore(io).records, { lookupPr: () => { throw new Error('gh down'); }, append: (row) => appendScorecard(row, io) });
    expect(r).toMatchObject({ judged: [], pending: [], failed: [{ pr: 101 }] });
    expect(readStore(io).records).toHaveLength(1);
  });
});


describe('#4439 prevention guards', () => {
  const fresh = '2026-09-28T00:00:00Z';
  const changes = { state: 'OPEN', labels: ['review:changes'], reviewLabelAt: fresh };
  it.each([undefined, 'invalid', '2026-09-26T00:00:00Z', '2026-09-27T00:00:00Z'])(
    'keeps missing, invalid, stale and equal label times pending (%s)', (reviewLabelAt) => {
      expect(judgePendingTrials([launch()], { lookupPr: () => ({ ...changes, reviewLabelAt }) }))
        .toMatchObject({ judged: [], pending: [launch()], failed: [] });
      expect(judgePendingTrials([launch()], { lookupPr: () => changes }).judged[0].outcome).toBe('reworked');
    });
  it.each(['rejected', 'reworked'])('requires a direct evaluator and fails closed through the sweep: %s', (outcome) => {
    expect(() => judgedTrialRow(launch(), { outcome })).toThrow(TypeError);
    const pr = outcome === 'rejected' ? { state: 'CLOSED' } : changes;
    expect(judgePendingTrials([launch()], { lookupPr: () => pr }).judged[0]).toMatchObject({ outcome, criticalMiss: true });
  });
  it.each([[100, undefined], [100, 130], [2, 3]])('fails closed for incomplete file scope (%s/%s)', (count, changedFiles) => {
    const pr = { ...changes, files: Array.from({ length: count }, (_, i) => ({ path: `docs/${i}.md` })), changedFiles };
    const row = judgePendingTrials([launch()], { lookupPr: () => pr }).judged[0];
    expect(row).not.toHaveProperty('filesTouched');
    expect(row.criticalMiss).toBe(true);
  });
  it('does not count a direct unreviewed merge or consume its pending launch', () => {
    const row = judgedTrialRow(launch(), { outcome: 'landed', isCriticalMiss });
    expect(row.verifiedBy).toBe('unreviewed-merge');
    expect(graduationProgress([row]).triples[0].verified).toBe(0);
    const records = [launch()];
    const sweep = (labels) => judgePendingTrials(records, { lookupPr: () => ({ state: 'MERGED', labels }), append: r => records.push(r) });
    expect(sweep([])).toMatchObject({ judged: [], pending: [launch()] });
    expect(graduationProgress(records).triples[0].verified).toBe(0);
    expect(sweep(['review:accepted']).judged[0]).toMatchObject({ outcome: 'landed', verifiedBy: 'independent-claude' });
    expect(graduationProgress(records).triples[0].verified).toBe(1);
  });
  it('counts a skipped append separately from judged evidence', () => {
    expect(judgePendingTrials([launch()], { lookupPr: () => changes, append: () => null }))
      .toMatchObject({ judged: [], pending: [], failed: [], skipped: [launch()] });
  });
  it('runJudge dry-runs without writing, appends once, and separates failed lookups', () => {
    let store = { version: 1, records: [launch(), launch({ pr: 102 }), launch({ pr: 103 }), launch({ pr: 104 })] };
    let writes = 0;
    const io = { exists: () => true, read: () => JSON.stringify(store), write: (_, text) => { writes++; store = JSON.parse(text); } };
    const lookupPr = ({ pr }) => { if (pr === 102) throw Error('gh down'); return pr === 103 ? null : pr === 104 ? { state: 'OPEN' } : changes; };
    const logs = [];
    const run = (dryRun) => runJudge({ lookupPr, io, dryRun, log: text => logs.push(text) });
    expect(run(true)).toEqual({ judged: 1, pending: 1, failed: 2 });
    expect(writes).toBe(0);
    expect(run(false)).toEqual({ judged: 1, pending: 1, failed: 2 });
    expect(run(false)).toEqual({ judged: 0, pending: 1, failed: 2 });
    expect(writes).toBe(1);
    expect(logs).toContain('1 judged, 1 awaiting a verdict, 2 lookups failed');
  });
});


it('#4439 real CLI reads paginated current verdict events, fails closed and reports lookup errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-cli-'));
  try {
    const io = { path: join(dir, 'store.json') };
    writeStore({ version: 1, records: [] }, io);
    const cli = resolve(import.meta.dirname, '../model-probation.mjs');
    const stub = `#!${process.execPath}
const args = process.argv.slice(2);
const { readFileSync, appendFileSync } = require('node:fs');
const data = JSON.parse(readFileSync(process.env.JUDGE_FIXTURE));
appendFileSync(process.env.JUDGE_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  if (data.failEvents) process.exit(1);
  console.log(JSON.stringify(data.pages));
} else {
  if (args[2] === '102') process.exit(1);
  console.log(JSON.stringify(data.pr));
}
`;
    writeFileSync(join(dir, 'gh'), stub, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, JUDGE_FIXTURE: join(dir, 'fixture.json'), JUDGE_CALLS: join(dir, 'calls.jsonl') };
    const run = (fixture, dryRun = true) => {
      writeFileSync(env.JUDGE_FIXTURE, JSON.stringify(fixture));
      return execFileSync(process.execPath, [cli, 'judge', ...(dryRun ? ['--dry-run'] : []), `--store=${io.path}`], { env, encoding: 'utf8' });
    };
    appendScorecard(launch(), io);
    const merged = { pr: { state: 'MERGED', labels: [], files: [], changedFiles: 0 }, pages: [] };
    expect(run(merged)).toBe('0 judged, 1 awaiting a verdict, 0 lookups failed\n');
    appendScorecard(launch({ pr: 102 }), io);
    expect(run(merged)).toBe('0 judged, 1 awaiting a verdict, 1 lookups failed\n');
    const event = (name, created_at) => ({ event: 'labeled', label: { name }, created_at });
    const review = { pr: { state: 'OPEN', labels: [{ name: 'review:changes' }], files: [{ path: 'docs/a.md' }], changedFiles: 2 },
      pages: [[event('review:changes', '2026-09-26T00:00:00Z')], [event('review:changes', '2026-09-28T00:00:00Z')]] };
    expect(run(review)).toContain('reworked (critical miss)');
    expect(readStore(io).records).toHaveLength(2);
    expect(run({ ...review, pages: [[event('review:changes', '2026-09-26T00:00:00Z'), event('review:accepted', '2026-09-29T00:00:00Z')]] }))
      .toBe('0 judged, 1 awaiting a verdict, 1 lookups failed\n');
    expect(run({ ...review, failEvents: true })).toBe('0 judged, 0 awaiting a verdict, 2 lookups failed\n');
    expect(run(review, false)).toContain('1 judged, 0 awaiting a verdict, 1 lookups failed');
    expect(run(review, false)).toBe('0 judged, 0 awaiting a verdict, 1 lookups failed\n');
    expect(readStore(io).records).toHaveLength(3);
    const calls = readFileSync(env.JUDGE_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls).toContainEqual(['api', '--paginate', '--slurp', 'repos/o/r/issues/101/events']);
    expect(calls.find(args => args[0] === 'pr')).toContain('state,mergedAt,labels,files,changedFiles');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
