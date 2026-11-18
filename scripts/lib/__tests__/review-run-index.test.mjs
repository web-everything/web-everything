// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, readRun, writeRun } from '../../operations/run-store.mjs';
import { readDrainRedTeamEvidence, readRecoveryWitness } from '../drain-red-team-evidence.mjs';
import { appendReviewRunIndex, backfillOpenReviewRuns, backfillReviewRunIndex, readReviewRunIndex, reviewRunIndexPath } from '../review-run-index.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-run-index-')); roots.push(root);
  const runsDir = join(root, 'runs'); mkdirSync(runsDir);
  const f = { repo: 'o/r', pr: 7, head: 'a'.repeat(40), runsDir, env: { WE_SHARED_RUNS_DIR: runsDir }, readScorecards: () => [] };
  const run = newRunRecord({ id: 'review-pr-old', op: 'review-pr', input: { repo: f.repo, pr: f.pr } });
  run.findings = { read: { netBasis: { rev: f.head } } }; run.verdict = { verdict: 'accept' };
  run.stepTimings = [{ step: 'read', stepIndex: 0, startedAt: new Date(1000).toISOString() }];
  return { ...f, run };
}
function window(f) {
  let reads = 0;
  return { list: () => [...Array.from({ length: 301 }, (_, i) => `review-pr-new-${i}`), f.run.id],
    stat: path => ({ mtimeMs: path.endsWith('old.json') ? 2000 : 100_000 }),
    read: id => { reads++; return id === f.run.id ? f.run : null; }, count: () => reads, warn: () => {} };
}
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('index hit finds and verifies a review older than the scan window (%#)', reader => {
  const f = fixture(), io = window(f);
  appendReviewRunIndex(f.run, f.runsDir, 2000);
  const result = reader({ ...f, ...io });
  expect(result.ok).not.toBe(false);
  expect(result.loopPayload ?? result.newest).toEqual(f.run);
  expect(io.count()).toBe(1);
});
it.each(['miss', 'corrupt', 'other PR', 'other head', 'missing record'])('%s index falls back and preserves scan-capped', kind => {
  const f = fixture(), io = window(f);
  if (kind !== 'miss') appendReviewRunIndex(f.run, f.runsDir, 2000);
  if (kind === 'corrupt') writeFileSync(reviewRunIndexPath(f.runsDir), '{');
  if (kind === 'other PR') f.run.input.pr++;
  if (kind === 'other head') f.run.findings.read.netBasis.rev = 'b'.repeat(40);
  if (kind === 'missing record') io.read = id => { if (id === f.run.id) throw Error('missing'); return null; };
  expect(readDrainRedTeamEvidence({ ...f, ...io })).toMatchObject({ ok: false, reason: 'scan-capped' });
});
it('run writer populates the index and index write failure never fails the run', () => {
  const f = fixture(); writeRun(f.run, f.runsDir);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([f.run.id]);
  rmSync(reviewRunIndexPath(f.runsDir)); mkdirSync(reviewRunIndexPath(f.runsDir));
  expect(() => writeRun(f.run, f.runsDir)).not.toThrow();
  expect(readRun(f.run.id, f.runsDir)).toEqual(f.run);
});
it('backfill resumes within its parse budget, is idempotent, and indexes only open PRs and review ids', () => {
  const f = fixture();
  const records = [f.run, { ...f.run, id: 'review-pr-closed', input: { repo: f.repo, pr: 8 } }, { ...f.run, id: 'other' }];
  for (const row of records) writeFileSync(join(f.runsDir, `${row.id}.json`), JSON.stringify(row));
  let reads = 0;
  const args = { ...f, openPrs: new Set([7]), maxParses: 1, read: id => { reads++; return records.find(row => row.id === id); } };
  expect(backfillReviewRunIndex(args).complete).toBe(false);
  expect(reads).toBe(1);
  expect(readReviewRunIndex(f.runsDir, f.repo, 7)).toEqual([]); // no partial snapshot
  expect(backfillReviewRunIndex(args).complete).toBe(true);
  expect(readReviewRunIndex(f.runsDir, f.repo, 7)).toEqual([f.run.id]);
  expect(readReviewRunIndex(f.runsDir, f.repo, 8)).toEqual([]);
  const before = readFileSync(reviewRunIndexPath(f.runsDir), 'utf8');
  backfillReviewRunIndex({ ...args, maxParses: 10 });
  expect(readFileSync(reviewRunIndexPath(f.runsDir), 'utf8')).toBe(before);
});
it('oversized per-PR index refuses lookup and falls back to the capped scan', () => {
  const f = fixture(), io = window(f);
  writeFileSync(reviewRunIndexPath(f.runsDir), JSON.stringify({ [`${f.repo}#${f.pr}`]: Array.from({ length: 1000 }, () => ({ id: f.run.id, mtimeMs: 2000 })) }));
  expect(readDrainRedTeamEvidence({ ...f, ...io })).toMatchObject({ ok: false, reason: 'scan-capped' });
});
it('drain tick shares one backfill budget across repositories and refuses incomplete context', () => {
  const f = fixture();
  const context = { contextComplete: false, prsByRepo: new Map([['o/r', [{ number: 7 }]], ['x/y', [{ number: 7 }]]]) };
  const options = { runsDir: f.runsDir, maxParses: 1, list: () => { throw Error('must not list'); } };
  expect(backfillOpenReviewRuns(context, options)).toEqual({ complete: false, parsed: 0 });
  context.contextComplete = true;
  writeFileSync(join(f.runsDir, `${f.run.id}.json`), JSON.stringify(f.run));
  expect(backfillOpenReviewRuns(context, { runsDir: f.runsDir })).toEqual({ complete: true, parsed: 1 });
  expect(readReviewRunIndex(f.runsDir, f.repo, 7)).toEqual([f.run.id]);
});
it.each(['changes', 'unfinished'])('indexed older acceptance never hides a newer %s review', verdict => {
  const f = fixture(), io = window(f);
  const newer = { ...f.run, id: 'review-pr-newer', verdict: verdict === 'changes' ? { verdict } : null,
    pending: verdict === 'unfinished' ? { kind: 'confirm', step: 'confirm', stepIndex: 1 } : null,
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(50_000).toISOString() }] };
  appendReviewRunIndex(f.run, f.runsDir, 2000);
  appendReviewRunIndex(newer, f.runsDir, 100_000);
  const result = readDrainRedTeamEvidence({ ...f, ...io, read: id => id === newer.id ? newer : f.run });
  if (verdict === 'unfinished') expect(result).toMatchObject({ ok: false, reason: 'review-unfinished' });
  else expect(result.loopPayload).toEqual(newer);
});
it('writer overflow stays a fallback sentinel instead of dropping a review', () => {
  const f = fixture();
  for (let i = 0; i < 34; i++) appendReviewRunIndex({ ...f.run, id: `review-pr-${i}` }, f.runsDir, i);
  expect(JSON.parse(readFileSync(reviewRunIndexPath(f.runsDir), 'utf8'))).toEqual({ [`${f.repo}#${f.pr}`]: [] });
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
});
