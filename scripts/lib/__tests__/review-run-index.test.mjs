// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    read: id => { reads++; return id === f.run.id ? f.run : null; }, count: () => reads, reset: () => { reads = 0; }, warn: () => {} };
}
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('index hit finds and verifies a review older than the scan window (%#)', reader => {
  const f = fixture(), io = window(f);
  completeIndex(f, io);
  const result = reader({ ...f, ...io });
  expect(result.ok).not.toBe(false);
  expect(result.loopPayload ?? result.newest).toEqual(f.run);
  expect(io.count()).toBe(1);
});
it.each(['miss', 'corrupt', 'other PR', 'other head', 'missing record'])('%s index falls back and preserves scan-capped', kind => {
  const f = fixture(), io = window(f);
  if (kind !== 'miss') completeIndex(f, io);
  if (kind === 'corrupt') writeFileSync(reviewRunIndexPath(f.runsDir), '{');
  if (kind === 'other PR') f.run.input.pr++;
  if (kind === 'other head') f.run.findings.read.netBasis.rev = 'b'.repeat(40);
  if (kind === 'missing record') io.read = id => { if (id === f.run.id) throw Error('missing'); return null; };
  expect(readDrainRedTeamEvidence({ ...f, ...io })).toMatchObject({ ok: false, reason: 'scan-capped' });
});
it('run writer populates the index and index write failure never fails the run', () => {
  const f = fixture(); writeRun(f.run, f.runsDir);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]); // appending alone proves no completeness
  expect(backfillReviewRunIndex({ ...f, openPrs: new Set([f.pr]) }).complete).toBe(true);
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
  const proof = JSON.parse(before).completeness;
  expect(proof.completeThroughMtimeMs).toBeTypeOf('number');
  expect(proof.files.map(row => row.id).sort()).toEqual(['review-pr-closed', f.run.id].sort());
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
  const indexedIo = { ...io, list: () => [...io.list(), newer.id], read: id => id === newer.id ? newer : id === f.run.id ? f.run : null };
  completeIndex(f, indexedIo);
  const result = readDrainRedTeamEvidence({ ...f, ...indexedIo });
  if (verdict === 'unfinished') expect(result).toMatchObject({ ok: false, reason: 'review-unfinished' });
  else expect(result.loopPayload).toEqual(newer);
});
it('writer overflow stays a fallback sentinel instead of dropping a review', () => {
  const f = fixture();
  for (let i = 0; i < 34; i++) appendReviewRunIndex({ ...f.run, id: `review-pr-${i}` }, f.runsDir, i);
  expect(JSON.parse(readFileSync(reviewRunIndexPath(f.runsDir), 'utf8')).entries).toEqual({ [`${f.repo}#${f.pr}`]: [] });
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
});

function completeIndex(f, io) {
  writeFileSync(join(f.runsDir, `${f.run.id}.json`), JSON.stringify(f.run));
  utimesSync(join(f.runsDir, `${f.run.id}.json`), 2, 2);
  const args = { ...f, openPrs: new Set([f.pr]), maxParses: 300,
    ...(io ? { list: io.list, read: id => io.read(id) ?? { ...f.run, id, input: { repo: f.repo, pr: 8 } }, stat: id => io.stat(join(f.runsDir, `${id}.json`)) } : {}) };
  const result = backfillReviewRunIndex(args);
  if (!result.complete) expect(backfillReviewRunIndex(args).complete).toBe(true);
  io?.reset?.();
}
it.each([['changes', false], ['changes', true], ['unfinished', false], ['unfinished', true]])('lost append never accepts an older indexed review (%s, capped=%s)', (verdict, capped) => {
  const f = fixture(); completeIndex(f);
  const newer = { ...f.run, id: 'review-pr-newer', verdict: verdict === 'changes' ? { verdict } : null,
    pending: verdict === 'unfinished' ? { kind: 'confirm', step: 'confirm', stepIndex: 1 } : null,
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(50_000).toISOString() }] };
  writeFileSync(join(f.runsDir, `${newer.id}.json`), JSON.stringify(newer));
  utimesSync(join(f.runsDir, `${newer.id}.json`), 100, 100);
  const io = capped ? window(f) : {};
  const result = readDrainRedTeamEvidence({ ...f, ...io });
  if (capped) expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  else if (verdict === 'unfinished') expect(result).toMatchObject({ ok: false, reason: 'review-unfinished' });
  else expect(result.loopPayload).toEqual(newer);
});
it('lock contention poisons even an existing indexed id until a complete backfill', () => {
  const f = fixture(); completeIndex(f);
  const path = reviewRunIndexPath(f.runsDir);
  writeFileSync(`${path}.lock`, `${process.pid}\n`);
  expect(appendReviewRunIndex(f.run, f.runsDir, 2000)).toBe(false);
  rmSync(`${path}.lock`);
  expect(readDrainRedTeamEvidence({ ...f, ...window(f) })).toMatchObject({ ok: false, reason: 'scan-capped' });
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
  expect(backfillReviewRunIndex({ ...f, openPrs: new Set([f.pr]) }).complete).toBe(true);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([f.run.id]);
});
it('a stat-only listing failure refuses an otherwise complete index', () => {
  const f = fixture(); completeIndex(f);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr, { list: () => { throw Error('unreadable'); } })).toEqual([]);
});
it('a clean complete index parses only indexed ids', () => {
  const f = fixture(); completeIndex(f);
  const io = window(f);
  const result = readDrainRedTeamEvidence({ ...f, ...io, list: () => [f.run.id] });
  expect(result.loopPayload).toEqual(f.run);
  expect(io.count()).toBe(1);
});

it('legacy nonempty index without a watermark takes the bounded fallback', () => {
  const f = fixture();
  writeFileSync(reviewRunIndexPath(f.runsDir), JSON.stringify({ [`${f.repo}#${f.pr}`]: [{ id: f.run.id, mtimeMs: 2000 }] }));
  expect(readDrainRedTeamEvidence({ ...f, ...window(f) })).toMatchObject({ ok: false, reason: 'scan-capped' });
});
it('corruption on append poisons the index even after its old bytes are restored', () => {
  const f = fixture(); completeIndex(f);
  const path = reviewRunIndexPath(f.runsDir), before = readFileSync(path);
  writeFileSync(path, '{');
  expect(appendReviewRunIndex(f.run, f.runsDir, 2000)).toBe(false);
  writeFileSync(path, before);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
});
it('failed poison creation still detects an unindexed file even with an older mtime', () => {
  const f = fixture(); completeIndex(f);
  const path = reviewRunIndexPath(f.runsDir), newer = { ...f.run, id: 'review-pr-lost' };
  writeFileSync(`${path}.poison`, 'cannot create markers here');
  writeFileSync(`${path}.lock`, `${process.pid}\n`);
  writeFileSync(join(f.runsDir, `${newer.id}.json`), JSON.stringify(newer));
  utimesSync(join(f.runsDir, `${newer.id}.json`), 1, 1);
  expect(appendReviewRunIndex(newer, f.runsDir, 1000)).toBe(false);
  rmSync(`${path}.poison`); rmSync(`${path}.lock`);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
});
it('a new id behind the persisted cursor restarts backfill before publishing completeness', () => {
  const f = fixture();
  writeFileSync(join(f.runsDir, `${f.run.id}.json`), JSON.stringify(f.run));
  const z = { ...f.run, id: 'review-pr-z' };
  writeFileSync(join(f.runsDir, `${z.id}.json`), JSON.stringify(z));
  const args = { ...f, openPrs: new Set([f.pr]), maxParses: 1 };
  expect(backfillReviewRunIndex(args).complete).toBe(false);
  const a = { ...f.run, id: 'review-pr-a', verdict: { verdict: 'changes' } };
  writeFileSync(join(f.runsDir, `${a.id}.json`), JSON.stringify(a));
  expect(backfillReviewRunIndex(args).complete).toBe(false);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
  expect(backfillReviewRunIndex({ ...args, maxParses: 3 }).complete).toBe(true);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toContain(a.id);
});
it('oversized completeness snapshots leave the bounded scan in charge with an operator warning', () => {
  const f = fixture(), warnings = [];
  const result = backfillReviewRunIndex({ ...f, openPrs: new Set([f.pr]), maxParses: 1,
    list: () => Array.from({ length: 25000 }, (_, i) => `review-pr-${i}`),
    stat: () => ({ mtimeMs: 2000 }), read: id => ({ ...f.run, id, input: { repo: f.repo, pr: 8 } }), warn: message => warnings.push(message) });
  expect(result.complete).toBe(false);
  expect(warnings.join(' ')).toMatch(/oversized.*inspect omitted runs/);
  expect(readDrainRedTeamEvidence({ ...f, ...window(f) })).toMatchObject({ ok: false, reason: 'scan-capped' });
});

it('main index I/O failure leaves an independent poison marker', () => {
  const f = fixture(); completeIndex(f);
  const path = reviewRunIndexPath(f.runsDir), before = readFileSync(path);
  rmSync(path); mkdirSync(path);
  expect(appendReviewRunIndex(f.run, f.runsDir, 2000)).toBe(false);
  rmSync(path, { recursive: true }); writeFileSync(path, before);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
});
it('a poison created during a staged backfill remains untrusted after that pass', () => {
  const f = fixture(); completeIndex(f);
  const z = { ...f.run, id: 'review-pr-z' };
  writeFileSync(join(f.runsDir, `${z.id}.json`), JSON.stringify(z));
  const args = { ...f, openPrs: new Set([f.pr]), maxParses: 1 };
  expect(backfillReviewRunIndex(args).complete).toBe(false);
  const path = reviewRunIndexPath(f.runsDir);
  writeFileSync(`${path}.lock`, `${process.pid}\n`);
  expect(appendReviewRunIndex(f.run, f.runsDir, 2000)).toBe(false);
  rmSync(`${path}.lock`);
  expect(backfillReviewRunIndex(args).complete).toBe(true);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
  expect(backfillReviewRunIndex({ ...args, maxParses: 3 }).complete).toBe(true);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toContain(f.run.id);
});
it('a failed stat refuses a complete index without parsing any payload', () => {
  const f = fixture(); completeIndex(f);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr, { stat: () => { throw Error('stat failed'); } })).toEqual([]);
});
it('a missed append cannot reuse completeness after an unindexed record is replaced at the same mtime', () => {
  const f = fixture(), path = reviewRunIndexPath(f.runsDir);
  const other = { ...f.run, id: 'review-pr-other', input: { repo: f.repo, pr: 8 } };
  const otherPath = join(f.runsDir, `${other.id}.json`);
  writeFileSync(otherPath, JSON.stringify(other)); utimesSync(otherPath, 2, 2);
  completeIndex(f);
  // Emulate an atomic run-store replacement whose index and poison writes both failed.
  writeFileSync(`${otherPath}.tmp`, JSON.stringify({ ...other, input: f.run.input, verdict: { verdict: 'changes' } }));
  renameSync(`${otherPath}.tmp`, otherPath);
  utimesSync(otherPath, 2, 2);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
  expect(readFileSync(path, 'utf8')).toContain('completeness');
});
