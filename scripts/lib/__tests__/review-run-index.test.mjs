// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newReviewRunId, newRunRecord, readRun, writeRun } from '../../operations/run-store.mjs';
import { readDrainRedTeamEvidence, readRecoveryWitness } from '../drain-red-team-evidence.mjs';
import { backfillAllReviewRuns, readCompleteReviewRunsForPr, appendReviewRunIndex, backfillOpenReviewRuns, backfillReviewRunIndex, readReviewRunIndex, reviewRunIndexPath, readNamedCandidates } from '../review-run-index.mjs';

import { writeJsonAtomic } from '../atomic-json-file.mjs';
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
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('unchanged verification payload serves fallback within a one-read budget (%#)', reader => {
  const f = fixture(); completeIndex(f);
  const io = window(f);
  const result = reader({ ...f, ...io, list: () => [f.run.id],
    scanSettings: { file: { runs: { scan: { maxParses: 1 } } }, platform: {}, env: {} } });
  expect(result.loopPayload ?? result.newest).toEqual(f.run);
  expect(io.count()).toBe(1);
});
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('fallback rereads an atomic replacement even with unchanged mtime (%#)', reader => {
  for (const maxParses of [1, 2]) {
    const f = fixture();
    f.run.findings.read.netBasis.rev = 'b'.repeat(40);
    completeIndex(f);
    const rejection = { ...f.run, findings: { read: { netBasis: { rev: f.head } } }, verdict: { verdict: 'changes' } };
    let lists = 0, reads = 0;
    const result = reader({ ...f, warn: () => {},
      scanSettings: { file: { runs: { scan: { maxParses } } }, platform: {}, env: {} },
      list: () => {
        if (++lists === 2) {
          const replacement = join(f.runsDir, 'replacement');
          writeFileSync(replacement, JSON.stringify(rejection));
          utimesSync(replacement, 2, 2);
          renameSync(replacement, join(f.runsDir, `${f.run.id}.json`));
        }
        return [f.run.id];
      },
      read: id => { reads++; return readRun(id, f.runsDir); },
    });
    expect(lists).toBe(2);
    if (maxParses === 1) expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    else expect(result.loopPayload ?? result.newest).toEqual(rejection);
    expect(reads).toBe(maxParses);
  }
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
it('a new id behind staged progress is verified before publishing completeness', () => {
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
it.each(['deleted key', 'append after deleted key', 'missing row', 'deleted eviction', 'legacy proof without digest'])('full proof refuses %s and the next backfill repairs it', kind => {
  const n = negativeFixture();
  n.f.run.findings.read.netBasis.rev = n.f.head;
  n.records.push({ ...n.f.run, id: 'review-pr-another-head',
    findings: { read: { netBasis: { rev: 'b'.repeat(40) } } } });
  if (kind === 'deleted eviction') n.records.push(...Array.from({ length: 112 }, (_, i) => ({
    ...n.f.run, id: `review-pr-z-${i}`, input: { repo: 'extra/repo', pr: i + 1 },
  })));
  n.fill(); n.fill(); expect(n.fill().complete).toBe(true);
  const path = reviewRunIndexPath(n.f.runsDir), index = JSON.parse(readFileSync(path));
  const full = index.fullReviewRuns, key = `${n.f.repo}#${n.f.pr}`;
  if (kind.endsWith('deleted key')) delete full.entries[key];
  if (kind === 'missing row') full.entries[key] = full.entries[key].filter(row => row.id !== n.f.run.id);
  if (kind === 'legacy proof without digest') delete full.completeness.entriesDigest;
  if (kind === 'deleted eviction') {
    expect(full.evicted).toContain(key);
    full.evicted = full.evicted.filter(entry => entry !== key);
  }
  writeFileSync(path, JSON.stringify(index));
  if (kind === 'append after deleted key') expect(appendReviewRunIndex(n.records[1], n.f.runsDir, 2000)).toBe(true);
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(false);
  expect(n.fill()).toEqual({ complete: false, parsed: 200 });
  n.fill(); expect(n.fill().complete).toBe(true);
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(false);
});

function negativeFixture() {
  const f = fixture();
  f.run.findings.read.netBasis.rev = 'b'.repeat(40);
  f.scanSettings = { file: { runs: { scan: { maxParses: 5000 } } }, platform: {}, env: {} };
  const records = [f.run, ...Array.from({ length: 401 }, (_, i) => ({ ...f.run,
    id: `review-pr-unrelated-${i}`, input: { repo: 'else/where', pr: i + 1 } }))];
  let reads = [], listings = 0;
  const io = { list: () => { listings++; return records.map(r => r.id); },
    readdir: () => records.map(r => `${r.id}.json`),
    stat: path => ({ mtimeMs: 2000, ctimeMs: 2000, dev: 1, ino: 1,
      size: JSON.stringify(records.find(r => path === r.id || path.endsWith(`/${r.id}.json`))).length }),
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
it('named-candidate proof beyond 400 parses all legacy ids independently of the complete index', () => {
  const n = negativeFixture(); fullNegativeIndex(n);
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(true);
  expect(n.reads).toEqual(n.records.map(r => r.id).sort());
  expect(readCompleteReviewRunsForPr(n.f.runsDir, 'absent/repo', 99, n.io)).toEqual([]);
});
it.each(['missing', 'corrupt', 'poisoned', 'watermark absent', 'open only', 'new unindexed', 'old unindexed', 'listing failure', 'stat failure', 'overflow', 'evicted'])(
  '%s index proof does not control the independent named-candidate proof', kind => {
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
      n.io.stat = () => ({ mtimeMs: kind === 'old unindexed' ? 1000 : 3000,
        ctimeMs: 3000, dev: 1, size: 100, ino: 1 }); }
    if (kind === 'listing failure') n.io.list = () => { throw Error('listing unavailable'); };
    if (kind === 'stat failure') n.io.stat = () => { throw Error('stat unavailable'); };
    expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
    const unreadable = ['listing failure', 'stat failure'].includes(kind);
    expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(!unreadable);
    expect(n.reads).toHaveLength(unreadable ? 0 : n.records.length);
  });
it.each(['same head', 'unknown head', 'wrong PR', 'wrong repo', 'wrong op', 'missing', 'bad evidence', 'wrong id'])(
  'named proof validates %s evidence independently of indexed subject keys', kind => {
    const n = negativeFixture(); fullNegativeIndex(n);
    if (kind === 'same head') n.f.run.findings.read.netBasis.rev = n.f.head;
    if (kind === 'unknown head') delete n.f.run.findings.read.netBasis.rev;
    if (kind === 'wrong PR') n.f.run.input.pr++;
    if (kind === 'wrong repo') n.f.run.input.repo = 'wrong/repo';
    if (kind === 'wrong op') n.f.run.op = 'other';
    if (kind === 'bad evidence') delete n.f.run.effects;
    if (kind === 'missing') n.io.read = () => { throw Error('missing'); };
    if (kind === 'wrong id') n.io.read = () => ({ ...n.f.run, id: 'review-pr-wrong' });
    // Legacy records with a valid different subject/op no longer belong to this PR.
    // Missing/malformed identity, a mismatched id, and live/unknown subject heads still hold.
    const unrelated = ['wrong PR', 'wrong repo', 'wrong op'].includes(kind);
    expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(unrelated);
    expect(n.listings()).toBe(unrelated ? 2 : 1);
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
  expect(n.reads).toEqual(n.records.map(r => r.id).sort());
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
it('an unrelated malformed verdict blocks full completeness and retains the fallback hold until repaired', () => {
  const f = fixture(), warnings = [];
  const other = { ...f.run, id: 'review-pr-unrelated', input: { repo: 'else/where', pr: 99 }, verdict: {} };
  const path = join(f.runsDir, `${other.id}.json`);
  writeFileSync(path, JSON.stringify(other));
  expect(headNeverReviewedFromRuns(f)).toBe(false); // original scan refuses unrelated invalid evidence
  expect(backfillAllReviewRuns({ ...f, warn: message => warnings.push(message) }).complete).toBe(false);
  expect(warnings.join(' ')).toMatch(/bounded scan still applies.*inspect omitted runs/);
  expect(readCompleteReviewRunsForPr(f.runsDir, f.repo, f.pr)).toBeNull();
  expect(headNeverReviewedFromRuns(f)).toBe(false);
  other.verdict = { verdict: 'accept' };
  writeFileSync(path, JSON.stringify(other));
  expect(backfillAllReviewRuns(f)).toEqual({ complete: true, parsed: 1 });
  expect(readCompleteReviewRunsForPr(f.runsDir, f.repo, f.pr)).toEqual([]);
  expect(headNeverReviewedFromRuns(f)).toBe(true);
});
it.each([
  ['null run', () => null],
  ['array run', () => []],
  ['missing op', run => ({ ...run, op: undefined })],
  ['empty op', run => ({ ...run, op: '  ' })],
  ['missing input', run => ({ ...run, input: undefined })],
  ['empty repo', run => ({ ...run, input: { ...run.input, repo: '  ' } })],
  ['invalid pr', run => ({ ...run, input: { ...run.input, pr: true } })],
  ['zero pr', run => ({ ...run, input: { ...run.input, pr: 0 } })],
  ['unsafe pr', run => ({ ...run, input: { ...run.input, pr: Number.MAX_SAFE_INTEGER + 1 } })],
  ['missing effects', run => ({ ...run, effects: undefined })],
  ['array pending', run => ({ ...run, pending: [] })],
  ['missing verdict', run => ({ ...run, verdict: undefined })],
  ['array verdict', run => ({ ...run, verdict: [] })],
  ['empty verdict', run => ({ ...run, verdict: {} })],
  ['blank verdict', run => ({ ...run, verdict: { verdict: '  ' } })],
  ['non-string verdict', run => ({ ...run, verdict: { verdict: 1 } })],
  ['unreadable record', () => { throw Error('unreadable'); }],
])('unrelated %s refuses full backfill and falls back to the scan hold', (_kind, change) => {
  const f = fixture(), warnings = [];
  const other = { ...f.run, id: 'review-pr-unrelated', input: { repo: 'else/where', pr: 99 } };
  const io = { list: () => [other.id], stat: () => ({ mtimeMs: 2000 }), read: () => change(other) };
  expect(headNeverReviewedFromRuns({ ...f, ...io })).toBe(false);
  expect(backfillAllReviewRuns({ ...f, ...io, warn: message => warnings.push(message) }).complete).toBe(false);
  expect(warnings.join(' ')).toMatch(/bounded scan still applies.*inspect omitted runs/);
  expect(readCompleteReviewRunsForPr(f.runsDir, f.repo, f.pr, io)).toBeNull();
  expect(headNeverReviewedFromRuns({ ...f, ...io })).toBe(false);
});
it.each(['completed', 'staged'])('legacy %s full backfill revalidates records before proving absence', kind => {
  const n = negativeFixture(), warnings = [];
  if (kind === 'completed') fullNegativeIndex(n);
  else expect(n.fill()).toEqual({ complete: false, parsed: 200 });
  const path = reviewRunIndexPath(n.f.runsDir), index = JSON.parse(readFileSync(path));
  const proof = kind === 'completed' ? index.fullReviewRuns.completeness : index.fullReviewRuns.backfill;
  delete proof.validationVersion; // persisted before strict evidence validation
  writeFileSync(path, JSON.stringify(index));
  n.records[1].verdict = {}; // unrelated record already passed by the old cursor
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
  expect(backfillAllReviewRuns({ ...n.f, ...n.io, maxParsesPerCall: 200,
    warn: message => warnings.push(message) }).complete).toBe(false);
  expect(warnings.join(' ')).toMatch(/evidence unreadable.*bounded scan still applies/);
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(false);
  n.records[1].verdict = { verdict: 'accept' };
  expect(backfillAllReviewRuns({ ...n.f, ...n.io, maxParsesPerCall: 200, now: () => Date.now() + 60_001 }).complete).toBe(false);
  expect(n.fill().complete).toBe(false);
  expect(n.fill().complete).toBe(true);
  n.reset();
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(true);
});
it('full backfill eviction refuses index absence while an independent complete scan can prove it', () => {
  const n = negativeFixture();
  n.records.push(...Array.from({ length: 112 }, (_, i) => ({ ...n.f.run,
    id: `review-pr-z-${i}`, input: { repo: 'extra/repo', pr: i + 1 } })));
  n.fill(); n.fill();
  expect(n.fill().complete).toBe(true);
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
  expect(headNeverReviewedFromRuns({ ...n.f, ...n.io })).toBe(true);
});
it('full backfill retains verified progress if a file appears behind its cursor and publishes no partial proof', () => {
  const n = negativeFixture(); n.fill();
  n.records.push({ ...n.f.run, id: 'review-pr-a', findings: { read: { netBasis: { rev: n.f.head } } } });
  expect(n.fill()).toEqual({ complete: false, parsed: 200 });
  expect(readCompleteReviewRunsForPr(n.f.runsDir, n.f.repo, n.f.pr, n.io)).toBeNull();
  expect(n.fill()).toEqual({ complete: true, parsed: 3 });
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

it("an unrelated PR's new review run does not invalidate this PR's index hit", () => {
  const f = fixture(); completeIndex(f);
  const other = { ...f.run, id: 'review-pr-unrelated', input: { repo: f.repo, pr: 8 } };
  writeFileSync(join(f.runsDir, `${other.id}.json`), JSON.stringify(other));
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([f.run.id]);
  // Rewrites of known unrelated ids must also be verified without invalidating PR 7.
  backfillReviewRunIndex({ ...f, openPrs: new Set([7, 8]) });
  writeFileSync(join(f.runsDir, `${other.id}.json`), JSON.stringify({ ...other, verdict: null }));
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([f.run.id]);
});
it('a new run for the queried PR forces fallback', () => {
  const f = fixture(); completeIndex(f);
  writeFileSync(join(f.runsDir, 'review-pr-added.json'), JSON.stringify({ ...f.run, id: 'review-pr-added' }));
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr)).toEqual([]);
});
it('unknown listing ids require strict identity and at most 20 reads before fallback', () => {
  const f = fixture(); completeIndex(f);
  let reads = 0;
  const ids = Array.from({ length: 21 }, (_, i) => `review-pr-extra-${i}`);
  const io = { list: () => ids, stat: () => ({ mtimeMs: 3000 }),
    read: id => { reads++; return { ...f.run, id, input: { repo: f.repo, pr: 8 } }; } };
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr, io)).toEqual([]);
  expect(reads).toBe(20);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr, { ...io, list: () => ids.slice(0, 1),
    read: () => ({ ...f.run, id: 'review-pr-wrong', input: { repo: f.repo, pr: 8 } }) })).toEqual([]);
  expect(readReviewRunIndex(f.runsDir, f.repo, f.pr, { ...io, list: () => ids.slice(0, 1),
    read: () => { throw Error('unreadable'); } })).toEqual([]);
});
it.each(['open', 'full'].flatMap(plane =>
  ['read', 'read warning', 'persistence', 'listing churn', 'relisting'].map(failure => [plane, failure])))
('%s backfill preserves payload spend after %s', (plane, failure) => {
    const backfill = plane === 'open' ? backfillReviewRunIndex : backfillAllReviewRuns;
    const f = fixture();
    const records = Array.from({ length: 3 }, (_, i) => ({ ...f.run, id: `review-pr-budget-${i}` }));
    let reads = 0, lists = 0, warnings = 0;
    const result = backfill({ ...f, openPrs: new Set([f.pr]), maxParses: 3, maxParsesPerCall: 3,
      stat: () => ({ mtimeMs: 2000 }),
      list: () => {
        if (++lists > 1) {
          if (failure === 'relisting') throw Error('listing unavailable');
          if (failure === 'listing churn') return [];
        }
        return records.map(record => record.id);
      },
      read: id => {
        reads++;
        if (reads === 3) {
          if (failure.startsWith('read')) throw Error('payload unavailable after two successful reads');
          if (failure === 'persistence') mkdirSync(reviewRunIndexPath(f.runsDir));
        }
        return records.find(record => record.id === id);
      },
      warn: () => {
        if (++warnings === 1 && failure === 'read warning') throw Error('warning unavailable');
      },
    });
    expect(reads, failure).toBe(3);
    expect(result, failure).toEqual({ complete: false, parsed: reads });
    expect(warnings, failure).toBeGreaterThan(0);
});

it('unreadable backfill candidate aborts without publishing completeness', () => {
  const f = fixture(), io = window(f);
  const records = [ { ...f.run, id: 'review-pr-a' }, { ...f.run, id: 'review-pr-b' }, { ...f.run, id: 'review-pr-c' } ];
  let attempts = 0, clock = 0, bad = true;
  const args = { ...f, openPrs: new Set([7]), list: () => records.map(r => r.id),
    stat: () => ({ mtimeMs: 2000 }), now: () => clock, warn: () => {},
    read: id => { attempts++; if (id === records[1].id && bad) throw Error('unreadable'); return records.find(r => r.id === id); } };
  expect(backfillReviewRunIndex(args).complete).toBe(false);
  expect(attempts).toBe(2);
  expect(readReviewRunIndex(f.runsDir, f.repo, 7, args)).toEqual([]);
  const path = reviewRunIndexPath(f.runsDir);
  expect(() => readFileSync(path)).toThrow();
  const staged = JSON.parse(readFileSync(`${path}.backfill`, 'utf8'));
  expect(staged.completeness).toBeUndefined();
  expect(staged.blocked[records[1].id]).toBeDefined();
  expect(readDrainRedTeamEvidence({ ...f, ...io })).toMatchObject({ ok: false, reason: 'scan-capped' });
  expect(backfillReviewRunIndex(args).complete).toBe(false);
  expect(attempts).toBe(3); // cooldown lets the remaining candidate make progress
  bad = false; clock = 60_001;
  expect(backfillReviewRunIndex(args).complete).toBe(true);
  expect(attempts).toBe(4); // verified progress was retained
});
it('default backfill budget reads at most 50 records total across repositories', () => {
  const f = fixture(); let reads = 0;
  const records = Array.from({ length: 62 }, (_, i) => ({ ...f.run, id: `review-pr-${i}`, input: { repo: i % 2 ? 'x/y' : f.repo, pr: 7 } }));
  const context = { contextComplete: true, prsByRepo: new Map([[f.repo, [{ number: 7 }]], ['x/y', [{ number: 7 }]]]) };
  const args = { runsDir: f.runsDir, list: () => records.map(r => r.id), stat: () => ({ mtimeMs: 1 }),
    read: id => { reads++; return records.find(r => r.id === id); } };
  expect(backfillOpenReviewRuns(context, args)).toEqual({ complete: false, parsed: 50 });
  expect(reads).toBe(50);
  expect(backfillOpenReviewRuns(context, { ...args, maxParses: 1 })).toEqual({ complete: false, parsed: 1 });
  expect(reads).toBe(51);
  expect(backfillOpenReviewRuns(context, { ...args, maxParses: 301, warn: () => {} }).complete).toBe(false);
  expect(reads).toBe(51);
});
it('backfill eventually indexes an old open PR while unrelated reviews change between default-budget ticks', () => {
  const f = fixture();
  const records = Array.from({ length: 121 }, (_, i) => ({ ...f.run, id: `review-pr-${String(i).padStart(3, '0')}`, input: { repo: f.repo, pr: 8 } }));
  records.push(f.run);
  const times = new Map(records.map(r => [r.id, 2000]));
  let reads = 0;
  const args = { ...f, openPrs: new Set([7]), list: () => records.map(r => r.id), stat: id => ({ mtimeMs: times.get(id) }),
    read: id => { reads++; return records.find(r => r.id === id); } };
  expect(backfillReviewRunIndex(args).complete).toBe(false);
  times.set(records[0].id, 3000);
  records.push({ ...records[0], id: 'review-pr-added' }); times.set('review-pr-added', 3000);
  args.openPrs.add(8); // changing the open set must preserve verified identities too
  expect(backfillReviewRunIndex(args).complete).toBe(false);
  records.splice(1, 1); // deleted ids must be pruned
  times.set(records[0].id, 4000);
  expect(backfillReviewRunIndex(args).complete).toBe(true);
  expect(reads).toBeLessThan(150);
  expect(readReviewRunIndex(f.runsDir, f.repo, 7, args)).toEqual([f.run.id]);
  const newer = { ...f.run, id: 'review-pr-new-rejection', verdict: { verdict: 'changes' },
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(50_000).toISOString() }] };
  records.push(newer); times.set(newer.id, 100_000);
  expect(readReviewRunIndex(f.runsDir, f.repo, 7, args)).toEqual([]);
  const result = readDrainRedTeamEvidence({ ...f, list: args.list, read: args.read,
    stat: path => args.stat(path.split('/').at(-1).slice(0, -5)) });
  expect(result.loopPayload).toEqual(newer);
});


it.each([readDrainRedTeamEvidence, readRecoveryWitness])('unknown-id verification shares the fallback parse budget (%#)', reader => {
  const f = fixture(), io = window(f); completeIndex(f, io);
  const extra = Array.from({ length: 21 }, (_, i) => `review-pr-added-${i}`);
  let reads = 0;
  const args = { ...f, ...io, list: () => [...io.list(), ...extra],
    read: id => { reads++; return extra.includes(id) ? { ...f.run, id, input: { repo: f.repo, pr: 8 } } : io.read(id); } };
  expect(reader(args)).toMatchObject({ ok: false, reason: 'scan-capped' });
  expect(reads).toBe(300);
});
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('index identity change cannot reuse an unrelated payload over a newer rejection (%#)', reader => {
  for (const maxParses of [1, 3]) {
    const f = fixture(); completeIndex(f);
    const unrelated = { ...f.run, id: 'review-pr-added', input: { repo: f.repo, pr: 8 } };
    const rejection = { ...unrelated, input: f.run.input, verdict: { verdict: 'changes' },
      stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(50_000).toISOString() }] };
    const path = join(f.runsDir, `${unrelated.id}.json`);
    writeFileSync(path, JSON.stringify(unrelated)); utimesSync(path, 100, 100);
    let reads = 0, changed = false;
    const result = reader({ ...f,
      scanSettings: { file: { runs: { scan: { maxParses } } }, platform: {}, env: {} }, warn: () => {},
      read: id => {
        reads++;
        const payload = readRun(id, f.runsDir);
        if (id === unrelated.id && !changed) {
          changed = true;
          writeFileSync(path, JSON.stringify(rejection)); utimesSync(path, 101, 101);
        }
        return payload;
      },
    });
    expect(changed).toBe(true);
    expect(result.loopPayload ?? result.newest).not.toEqual(f.run);
    if (maxParses === 1) expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    else expect(result.loopPayload ?? result.newest).toEqual(rejection);
    expect(reads).toBeLessThanOrEqual(maxParses);
  }
});
it('an unreadable unknown id retains the fallback unreadable-record refusal', () => {
  const f = fixture(); completeIndex(f);
  const unknown = 'review-pr-unreadable'; let attempts = 0;
  expect(() => readDrainRedTeamEvidence({ ...f, list: () => [unknown, f.run.id], stat: () => ({ mtimeMs: 100_000 }),
    read: id => { if (id === unknown) { attempts++; throw Error('unreadable unknown'); } return f.run; },
  })).toThrow('unreadable unknown');
  expect(attempts).toBe(1);
});
it('a mismatched backfill identity blocks completeness and a changed file retries immediately', () => {
  const f = fixture(); let correct = false, mtimeMs = 1;
  const args = { ...f, openPrs: new Set([7]), list: () => [f.run.id], stat: () => ({ mtimeMs }),
    read: () => correct ? f.run : { ...f.run, id: 'review-pr-wrong' }, now: () => 0, warn: () => {} };
  expect(backfillReviewRunIndex(args).complete).toBe(false);
  expect(readReviewRunIndex(f.runsDir, f.repo, 7, args)).toEqual([]);
  correct = true; mtimeMs++;
  expect(backfillReviewRunIndex(args).complete).toBe(true);
  expect(readReviewRunIndex(f.runsDir, f.repo, 7, args)).toEqual([f.run.id]);
});


it('full backfill retains progress under churn and never publishes while an unreadable record cools down', () => {
  const f = fixture();
  const records = Array.from({ length: 121 }, (_, i) => ({ ...f.run,
    id: `review-pr-${String(i).padStart(3, '0')}`, input: { repo: 'else/where', pr: i + 1 } }));
  const times = new Map(records.map(run => [run.id, 2000]));
  let clock = 0, bad = true, reads = 0;
  const args = { ...f, now: () => clock, warn: () => {}, list: () => records.map(run => run.id),
    stat: id => ({ mtimeMs: times.get(id) }), read: id => {
      reads++;
      if (id === records[1].id && bad) throw Error('unreadable');
      return records.find(run => run.id === id);
    } };
  expect(backfillAllReviewRuns(args)).toEqual({ complete: false, parsed: 2 });
  times.set(records[0].id, 3000);
  expect(backfillAllReviewRuns(args)).toEqual({ complete: false, parsed: 50 });
  expect(backfillAllReviewRuns(args)).toEqual({ complete: false, parsed: 50 });
  expect(backfillAllReviewRuns(args)).toEqual({ complete: false, parsed: 20 });
  const index = JSON.parse(readFileSync(reviewRunIndexPath(f.runsDir)));
  expect(index.fullReviewRuns.completeness).toBeUndefined();
  expect(index.fullReviewRuns.backfill.blocked[records[1].id]).toBeDefined();
  expect(readCompleteReviewRunsForPr(f.runsDir, f.repo, f.pr, args)).toBeNull();
  bad = false; clock = 60_001;
  expect(backfillAllReviewRuns(args)).toEqual({ complete: true, parsed: 1 });
  expect(reads).toBe(123);
  expect(readCompleteReviewRunsForPr(f.runsDir, f.repo, f.pr, args)).toEqual([]);
});

// These integration cases intentionally use the default lookup, list, read and stat:
// a complete filename scan is authoritative even when it finds no exact-head record.
// Retired journal files are inert, including conflicting and torn rows.
const reviewRunJournalPath = dir => `${dir}-review-index.jsonl`;
const journalReaders = [
  { name: 'drain', reader: readDrainRedTeamEvidence },
  { name: 'recovery', reader: readRecoveryWitness },
];
// Historical journal rows are inert; every live review ID remains a scan candidate.
const journalLine = (f, id, key) => {
  const metadata = statSync(join(f.runsDir, `${id}.json`));
  return `${JSON.stringify({ id, key, seal: [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs, metadata.birthtimeMs] })}\n`;
};
function journalPayload(f, run, at) {
  writeFileSync(join(f.runsDir, `${run.id}.json`), JSON.stringify(run));
  utimesSync(join(f.runsDir, `${run.id}.json`), at, at);
}
const journalBudget = maxParses => ({ file: { runs: { scan: { maxParses } } }, platform: {}, env: {} });

it.each(journalReaders)('$name default name lookup keeps completed absence without an exact-head fallback', ({ reader }) => {
  const f = fixture();
  const differentHead = { ...f.run, findings: { read: { netBasis: { rev: 'b'.repeat(40) } } } };
  const unrelated = { ...f.run, id: newReviewRunId(8), input: { repo: f.repo, pr: 8 } };
  journalPayload(f, differentHead, 2);
  journalPayload(f, unrelated, 100);
  writeFileSync(reviewRunJournalPath(f.runsDir), journalLine(f, f.run.id, 'o/r#7') + journalLine(f, unrelated.id, 'o/r#8'));
  const result = reader({ ...f, scanSettings: journalBudget(2), warn: () => {} });
  expect(result.ok).not.toBe(false);
  expect(result.loopPayload ?? result.newest ?? null).toBeNull();
});

for (const kind of ['omitted', 'conflicting', 'stale-key', 'torn', 'invalid JSON']) {
  it.each(journalReaders)(`$name default name lookup cannot hide a newer rejection with ${kind} lines`, ({ reader }) => {
    const f = fixture();
    const newer = { ...f.run, id: 'review-pr-rejection', verdict: { verdict: 'changes' },
      stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(50_000).toISOString() }] };
    journalPayload(f, f.run, 2);
    journalPayload(f, newer, 100);
    const current = journalLine(f, newer.id, 'o/r#7'), stale = journalLine(f, newer.id, 'o/r#8');
    const suffix = { omitted: '', conflicting: current + stale, 'stale-key': stale + current,
      torn: stale.trimEnd(), 'invalid JSON': `{"id":"${newer.id}","key":\n` }[kind];
    writeFileSync(reviewRunJournalPath(f.runsDir), journalLine(f, f.run.id, 'o/r#7') + suffix);
    const result = reader({ ...f, scanSettings: journalBudget(2), warn: () => {} });
    expect(result.ok).not.toBe(false);
    expect(result.loopPayload ?? result.newest).toEqual(newer);
    expect((result.loopPayload ?? result.newest).verdict).toEqual({ verdict: 'changes' });
  });
}

for (const field of ['id', 'op', 'repo', 'pr', 'unjournaled id']) {
  it.each(journalReaders)(`$name default name lookup refuses a mismatched ${field} payload before proving absence`, ({ reader }) => {
    const f = fixture();
    if (field !== 'unjournaled id') f.run.id = newReviewRunId(f.pr);
    const impostor = structuredClone(f.run);
    if (field === 'id' || field === 'unjournaled id') impostor.id = 'review-pr-impostor';
    if (field === 'op') impostor.op = 'fix-pr';
    if (field === 'repo') impostor.input.repo = 'other/repo';
    if (field === 'pr') impostor.input.pr = 999;
    const unrelated = { ...f.run, id: newReviewRunId(8), input: { repo: f.repo, pr: 8 } };
    // Publish under the candidate filename even when the payload claims another id.
    writeFileSync(join(f.runsDir, `${f.run.id}.json`), JSON.stringify(impostor));
    utimesSync(join(f.runsDir, `${f.run.id}.json`), 2, 2);
    journalPayload(f, unrelated, 100);
    writeFileSync(reviewRunJournalPath(f.runsDir),
      (field === 'unjournaled id' ? '' : journalLine(f, f.run.id, 'o/r#7')) + journalLine(f, unrelated.id, 'o/r#8'));
    const result = reader({ ...f, scanSettings: journalBudget(2), warn: () => {} });
    if (field === 'repo') expect(result.ok).not.toBe(false); // Names encode PR, not repository.
    else expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(result.loopPayload ?? result.newest ?? null).toBeNull();
  });
}


it.each(journalReaders.flatMap(reader => [0, 5000].map(gapMs => ({ ...reader, gapMs }))))(
  '$name default name lookup returns a rejection replacing an other-PR file within the 10-second allowance (gap=$gapMs ms)',
  ({ reader, gapMs }) => {
    const f = fixture();
    writeRun(f.run, f.runsDir);
    const other = { ...f.run, id: 'review-pr-replaced-other', input: { repo: f.repo, pr: 8 } };
    writeRun(other, f.runsDir);
    const atBefore = statSync(join(f.runsDir, `${other.id}.json`)).mtimeMs;
    expect(readNamedCandidates(f.runsDir, f.repo, f.pr).ids).toEqual([f.run.id, other.id].sort());
    const rejection = { ...f.run, id: other.id, verdict: { verdict: 'changes' },
      stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(Date.now()).toISOString() }] };
    const path = join(f.runsDir, `${other.id}.json`);
    writeJsonAtomic(path, rejection); // Directly replace a legacy payload; no name can exclude it.
    const at = (atBefore + gapMs) / 1000;
    utimesSync(path, at, at);
    expect(Math.abs(statSync(path).mtimeMs - atBefore)).toBeLessThan(10_000);
    expect(readNamedCandidates(f.runsDir, f.repo, f.pr)).toMatchObject({
      ids: [f.run.id, other.id].sort(), legacy: 2,
    });
    const result = reader({ ...f, scanSettings: journalBudget(2), warn: () => {} });
    expect(result.ok).not.toBe(false);
    expect(result.loopPayload ?? result.newest).toEqual(rejection);
  },
);
