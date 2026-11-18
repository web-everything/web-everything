// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, readRun, writeRun } from '../../operations/run-store.mjs';
import { readDrainRedTeamEvidence, readRecoveryWitness } from '../drain-red-team-evidence.mjs';
import { backfillAllReviewRuns, readCompleteReviewRunsForPr, appendReviewRunIndex, backfillOpenReviewRuns, backfillReviewRunIndex, readReviewRunIndex, reviewRunIndexPath } from '../review-run-index.mjs';

import { headNeverReviewedFromRuns } from '../review-red-team-on-skip.mjs';

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
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('index fallback shares one payload-read budget (%#)', reader => {
  for (const { indexedCount, overlap, throws } of [
    { indexedCount: 1 }, { indexedCount: 3 }, { indexedCount: 3, overlap: true }, { indexedCount: 1, throws: true },
  ]) {
    const f = fixture();
    f.run.findings.read.netBasis.rev = 'b'.repeat(40);
    const indexed = Array.from({ length: indexedCount }, (_, i) => ({ ...f.run, id: i ? `review-pr-index-${i}` : f.run.id }));
    let reads = 0, fail = false;
    const io = {
      list: () => [...indexed.map(run => run.id), ...Array.from({ length: 301 }, (_, i) => `review-pr-new-${i}`)],
      stat: path => ({ mtimeMs: indexed.some(run => path.endsWith(`${run.id}.json`)) ? (overlap ? 200_000 : 2000) : 100_000 }),
      read: id => {
        reads++;
        if (fail && throws && id === f.run.id) throw Error('unreadable indexed payload');
        return indexed.find(run => run.id === id) ?? null;
      },
      reset: () => { reads = 0; }, warn: () => {},
    };
    completeIndex(f, io);
    fail = true;
    expect(reader({ ...f, ...io, scanSettings: { file: { runs: { scan: { maxParses: 300 } } }, platform: {}, env: {} } }))
      .toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(reads).toBe(300);
  }
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
it.each(['changes', 'unfinished'])('evicted key recreated by an older accept falls back to the newer %s until backfill', verdict => {
  const f = fixture();
  const newer = { ...f.run, id: 'review-pr-newer', verdict: verdict === 'changes' ? { verdict } : null,
    pending: verdict === 'unfinished' ? { kind: 'confirm', step: 'confirm', stepIndex: 1 } : null,
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(50_000).toISOString() }] };
  const others = Array.from({ length: 512 }, (_, i) => ({ ...f.run, id: `review-pr-other-${i}`, input: { repo: f.repo, pr: i + 8 } }));
  const records = [f.run, newer, ...others];
  let oldMtime = 2000;
  const io = { list: () => records.map(run => run.id), read: id => records.find(run => run.id === id),
    stat: path => ({ mtimeMs: path.endsWith(`${f.run.id}.json`) ? oldMtime : path.endsWith(`${newer.id}.json`) ? 3000 : 100_000 }),
    warn: () => {} };
  const backfill = { ...f, openPrs: new Set([f.pr, ...others.slice(0, -1).map(run => run.input.pr)]),
    maxParses: 300, list: io.list, read: io.read, stat: id => io.stat(join(f.runsDir, `${id}.json`)) };
  expect(backfillReviewRunIndex(backfill).complete).toBe(false);
  expect(backfillReviewRunIndex(backfill).complete).toBe(true);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr, backfill)).toContain(newer.id);
  expect(appendReviewRunIndex(others.at(-1), f.runsDir, 100_000)).toBe(true);
  const path = reviewRunIndexPath(f.runsDir);
  expect(JSON.parse(readFileSync(path, 'utf8')).entries).not.toHaveProperty(`${f.repo}#${f.pr}`);
  // Rewriting an old acceptance gives it a fresh mtime, but keeps its older review start.
  oldMtime = 200_000;
  expect(appendReviewRunIndex(f.run, f.runsDir, oldMtime)).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8')).entries[`${f.repo}#${f.pr}`]).toEqual([{ id: f.run.id, mtimeMs: oldMtime }]);
  expect(readDrainRedTeamEvidence({ ...f, ...io })).toMatchObject({ ok: false, reason: 'scan-capped' });
  const result = readDrainRedTeamEvidence({ ...f, ...io,
    scanSettings: { file: { runs: { scan: { maxParses: 600 } } }, platform: {}, env: {} } });
  if (verdict === 'unfinished') expect(result).toMatchObject({ ok: false, reason: 'review-unfinished' });
  else expect(result.loopPayload).toEqual(newer);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr, backfill)).toEqual([]);
  expect(backfillReviewRunIndex(backfill).complete).toBe(false);
  expect(backfillReviewRunIndex(backfill).complete).toBe(true);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr, backfill)).toContain(newer.id);
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

// Negative evidence requires a full-store proof, independently of the open-PR hint.
function negativeFixture() {
  const f = fixture();
  f.run.findings.read.netBasis.rev = 'b'.repeat(40);
  const records = [f.run, ...Array.from({ length: 401 }, (_, i) => ({ ...f.run,
    id: `review-pr-unrelated-${i}`, input: { repo: 'else/where', pr: i + 1 } }))];
  let reads = [], listings = 0;
  const io = { list: () => { listings++; return records.map(r => r.id); }, stat: () => ({ mtimeMs: 2000 }),
    read: id => { reads.push(id); return records.find(r => r.id === id); } };
  const fill = () => backfillAllReviewRuns({ ...f, ...io, maxParsesPerCall: 200 });
  return { f, io, records, fill, reads, listings: () => listings, reset: () => { reads.length = 0; listings = 0; } };
}
function fullNegativeIndex(n) {
  expect(n.fill()).toEqual({ complete: false, parsed: 200 });
  expect(n.fill()).toEqual({ complete: false, parsed: 200 });
  expect(n.fill()).toEqual({ complete: true, parsed: 2 });
  n.reset();
}
it('full backfill resumes from the index in bounded batches and stamps only a complete watermark', () => {
  const n = negativeFixture(), path = reviewRunIndexPath(n.f.runsDir);
  expect(n.fill()).toEqual({ complete: false, parsed: 200 });
  expect(n.reads).toHaveLength(200);
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
  expect(JSON.parse(readFileSync(path)).fullReviewRuns.backfill.after).toBeTypeOf('string');
  expect(n.fill()).toEqual({ complete: false, parsed: 200 });
  expect(n.fill()).toEqual({ complete: true, parsed: 2 });
  n.reset();
  expect(n.fill()).toEqual({ complete: true, parsed: 0 });
  expect(n.reads).toHaveLength(0);
  expect(readCompleteReviewRunsForPr(n.f.runsDir, 'else/where', 401, n.io)).toEqual(['review-pr-unrelated-400']);
});
it('complete index proves never reviewed beyond 400 ids parsing only this PR', () => {
  const n = negativeFixture(); fullNegativeIndex(n);
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(true);
  expect(n.reads).toEqual([n.f.run.id]);
  expect(readCompleteReviewRunsForPr(n.f.runsDir, 'absent/repo', 99, n.io)).toEqual([]);
});
it.each(['missing', 'corrupt', 'poisoned', 'watermark absent', 'open only', 'new unindexed', 'old unindexed', 'listing failure', 'stat failure', 'overflow', 'evicted'])(
  '%s full proof falls back to the unchanged capped scan', kind => {
    const n = negativeFixture(); fullNegativeIndex(n);
    const path = reviewRunIndexPath(n.f.runsDir);
    const index = JSON.parse(readFileSync(path));
    if (kind === 'missing') rmSync(path);
    if (kind === 'corrupt') writeFileSync(path, '{');
    if (kind === 'poisoned') { mkdirSync(`${path}.poison`); writeFileSync(join(`${path}.poison`, 'failure'), ''); }
    if (kind === 'watermark absent') { delete index.fullReviewRuns.completeness; writeFileSync(path, JSON.stringify(index)); }
    if (kind === 'open only') { delete index.fullReviewRuns; writeFileSync(path, JSON.stringify(index)); }
    if (kind === 'overflow') { index.fullReviewRuns.entries['o/r#7'] = []; writeFileSync(path, JSON.stringify(index)); }
    if (kind === 'evicted') { delete index.fullReviewRuns.entries['o/r#7']; index.fullReviewRuns.evicted.push('o/r#7'); writeFileSync(path, JSON.stringify(index)); }
    if (kind.includes('unindexed')) { n.records.push({ ...n.f.run, id: 'review-pr-lost' });
      n.io.stat = () => ({ mtimeMs: kind === 'old unindexed' ? 1000 : 3000 }); }
    if (kind === 'listing failure') n.io.list = () => { throw Error('listing unavailable'); };
    if (kind === 'stat failure') n.io.stat = () => { throw Error('stat unavailable'); };
    expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
    expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(false);
    expect(n.reads).toHaveLength(0);
  });
it.each(['same head', 'unknown head', 'wrong PR', 'wrong repo', 'wrong op', 'missing', 'bad evidence', 'wrong id'])(
  'indexed %s cannot establish never reviewed', kind => {
    const n = negativeFixture(); fullNegativeIndex(n);
    if (kind === 'same head') n.f.run.findings.read.netBasis.rev = n.f.head;
    if (kind === 'unknown head') delete n.f.run.findings.read.netBasis.rev;
    if (kind === 'wrong PR') n.f.run.input.pr++;
    if (kind === 'wrong repo') n.f.run.input.repo = 'wrong/repo';
    if (kind === 'wrong op') n.f.run.op = 'other';
    if (kind === 'bad evidence') delete n.f.run.effects;
    if (kind === 'missing') n.io.read = () => { throw Error('missing'); };
    if (kind === 'wrong id') n.io.read = () => ({ ...n.f.run, id: 'review-pr-wrong' });
    expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(false);
    if (!['same head', 'unknown head'].includes(kind)) expect(n.listings()).toBe(2);
  });
it('open-PR refresh preserves full-backfill progress and its completed proof', () => {
  const n = negativeFixture();
  expect(n.fill().parsed).toBe(200);
  const open = () => backfillReviewRunIndex({ ...n.f, ...n.io, openPrs: new Set([n.f.pr]), maxParses: 300 });
  open(); open();
  expect(n.fill().parsed).toBe(200);
  expect(n.fill().complete).toBe(true);
  open(); open(); n.reset();
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(true);
  expect(n.reads).toEqual([n.f.run.id]);
});

it('full backfill uses the default parser and refuses corrupt payloads without stamping completeness', () => {
  const f = fixture(), path = join(f.runsDir, `${f.run.id}.json`), warnings = [];
  writeFileSync(path, '{');
  expect(backfillAllReviewRuns({ ...f, warn: m => warnings.push(m) }).complete).toBe(false);
  expect(warnings.join(' ')).toMatch(/bounded scan still applies.*inspect omitted runs/);
  expect(readCompleteReviewRunsForPr(f.runsDir, f.repo, f.pr)).toBeNull();
  writeFileSync(path, JSON.stringify(f.run));
  expect(backfillAllReviewRuns(f)).toEqual({ complete: true, parsed: 1 });
  expect(readCompleteReviewRunsForPr(f.runsDir, f.repo, f.pr)).toEqual([f.run.id]);
});
it('full backfill eviction cannot turn a lost key into a proof of absence', () => {
  const n = negativeFixture();
  n.records.push(...Array.from({ length: 112 }, (_, i) => ({ ...n.f.run,
    id: `review-pr-z-${i}`, input: { repo: 'extra/repo', pr: i + 1 } })));
  n.fill(); n.fill();
  expect(n.fill().complete).toBe(true);
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(false);
});
it('full backfill restarts if a file appears behind its cursor and publishes no partial proof', () => {
  const n = negativeFixture(); n.fill();
  n.records.push({ ...n.f.run, id: 'review-pr-a', findings: { read: { netBasis: { rev: n.f.head } } } });
  expect(n.fill()).toEqual({ complete: false, parsed: 200 });
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
  n.fill(); expect(n.fill().complete).toBe(true);
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(false);
});
it('full backfill does not acknowledge poison created during a staged pass', () => {
  const n = negativeFixture(); n.fill();
  const path = reviewRunIndexPath(n.f.runsDir);
  mkdirSync(`${path}.poison`); writeFileSync(join(`${path}.poison`, 'racing-failure'), '');
  n.fill(); expect(n.fill().complete).toBe(true);
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
  n.fill(); n.fill(); expect(n.fill().complete).toBe(true);
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(true);
});
it('full and open snapshots fit a 3012-file run store within the bounded index', () => {
  const n = negativeFixture();
  n.records.push(...Array.from({ length: 2610 }, (_, i) => ({ ...n.f.run,
    id: `review-pr-2026-11-18T000000Z-historical-${i}`, input: { repo: 'history/repo', pr: 1 } })));
  const stat = () => ({ mtimeMs: 2000, dev: 16777234, ino: 123456789, size: 12345,
    ctimeMs: 1795000000000.123, birthtimeMs: 1795000000000.123 });
  const args = { ...n.f, ...n.io, stat, maxParsesPerCall: 300, warn: message => { throw Error(message); } };
  for (let i = 0; i < 10; i++) expect(backfillAllReviewRuns(args).complete).toBe(false);
  expect(backfillAllReviewRuns(args)).toEqual({ complete: true, parsed: 12 });
  const open = { ...args, maxParses: 300, openPrs: new Set([n.f.pr]) };
  for (let i = 0; i < 10; i++) expect(backfillReviewRunIndex(open).complete).toBe(false);
  expect(backfillReviewRunIndex(open).complete).toBe(true);
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, { ...n.io, stat })).toEqual([n.f.run.id]);
});
