// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRunIds, newRunRecord, readRun, writeRun } from '../../operations/run-store.mjs';
import { writeJsonAtomic } from '../atomic-json-file.mjs';
import { readDrainRedTeamEvidence } from '../drain-red-team-evidence.mjs';
import * as journal from '../review-run-index.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const cli = fileURLToPath(new URL('../../review-run-journal.mjs', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-run-journal-')); roots.push(root);
  const runsDir = join(root, 'runs'); mkdirSync(runsDir);
  const f = { repo: 'o/r', pr: 7, head: 'a'.repeat(40), runsDir,
    env: { WE_SHARED_RUNS_DIR: runsDir, OPERATION_RUNS_DIR: runsDir }, readScorecards: () => [] };
  const run = newRunRecord({ id: 'review-pr-old', op: 'review-pr', input: { repo: f.repo, pr: f.pr } });
  run.findings = { read: { netBasis: { rev: f.head } } };
  run.verdict = { verdict: 'accept' };
  run.stepTimings = [{ step: 'read', stepIndex: 0, startedAt: new Date(1000).toISOString() }];
  return { ...f, run, journalPath: join(root, 'runs-review-index.jsonl') };
}
const key = f => `${f.repo}#${f.pr}`;
const identity = path => {
  const metadata = statSync(path);
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs];
};
const line = (f, id, target, at = Date.now()) => {
  let fileIdentity;
  try { fileIdentity = identity(join(f.runsDir, `${id}.json`)); } catch { /* Journal-only id. */ }
  return `${JSON.stringify({ id, key: target, at, identity: fileIdentity })}\n`;
};
const lines = f => readFileSync(f.journalPath, 'utf8').trimEnd().split('\n').map(text => JSON.parse(text));
function candidates(f) {
  return journal.readJournalCandidates(f.runsDir, f.repo, f.pr, { list: listRunIds });
}
function counter(f) {
  const ids = [];
  return { ids, read: (id, dir = f.runsDir) => { ids.push(id); return readRun(id, dir); } };
}
function evidence(f, io, maxParses = 3000) {
  return readDrainRedTeamEvidence({ ...f, read: io.read,
    scanSettings: { file: { runs: { scan: { maxParses } } }, platform: {}, env: {} } });
}
function expectFound(f, io, maxParses = 3000) {
  const result = evidence(f, io, maxParses);
  expect(result).not.toMatchObject({ ok: false });
  expect(result.loopPayload).toEqual(f.run);
  expect(result.loopPayload.verdict).toEqual({ verdict: 'accept' });
  expect(io.ids).toContain(f.run.id);
}
function oldTargetAndNewerUnrelated(f, count = 4) {
  writeRun(f.run, f.runsDir);
  utimesSync(join(f.runsDir, `${f.run.id}.json`), 1, 1);
  journal.appendReviewRunJournal(f.run, f.runsDir, Date.now(), statSync(join(f.runsDir, `${f.run.id}.json`)));
  for (let i = 0; i < count; i++) {
    const run = { ...f.run, id: `review-pr-new-${i}`, input: { repo: f.repo, pr: 800 + i } };
    writeRun(run, f.runsDir);
    utimesSync(join(f.runsDir, `${run.id}.json`), 100 + i, 100 + i);
    journal.appendReviewRunJournal(run, f.runsDir, Date.now(), statSync(join(f.runsDir, `${run.id}.json`)));
  }
}

it('places the JSONL journal beside runs and writeRun journals its real record', () => {
  const f = fixture();
  expect(journal.reviewRunJournalPath(f.runsDir)).toBe(f.journalPath);
  writeRun(f.run, f.runsDir);
  expect(lines(f)).toEqual([{ id: f.run.id, key: key(f), at: expect.any(Number), identity: expect.any(Array) }]);
  expect(Math.abs(lines(f)[0].at - Date.now())).toBeLessThan(10_000);
  expect(readRun(f.run.id, f.runsDir)).toEqual(f.run);
});

it('appends the journal BEFORE atomic rename: a refused rename leaves a harmless journal-only id', () => {
  const f = fixture();
  mkdirSync(join(f.runsDir, `${f.run.id}.json`));
  expect(() => writeRun(f.run, f.runsDir)).toThrow();
  expect(lines(f)).toContainEqual({ id: f.run.id, key: key(f), at: expect.any(Number), identity: expect.any(Array) });
  rmSync(join(f.runsDir, `${f.run.id}.json`), { recursive: true });
  expect(candidates(f)).toEqual({ ids: [], source: 'journal', unjournaled: 0 });
});

it('finds an exact-head verdict older than 3000 of 6000 real runs across 400 PRs, including post-seed writes', async () => {
  const f = fixture(), targetIds = [];
  // Reuse the minimal record; only the oldest target run has the requested head.
  for (let i = 0; i < 6000; i++) {
    const pr = i % 400 + 1;
    const id = `review-pr-bulk-${String(i).padStart(5, '0')}`;
    const run = { ...f.run, id, input: { repo: f.repo, pr },
      findings: { read: { netBasis: { rev: i === 6 ? f.head : 'b'.repeat(40) } } } };
    writeRun(run, f.runsDir);
    utimesSync(join(f.runsDir, `${id}.json`), 1000 + i, 1000 + i);
    if (pr === f.pr) targetIds.push(id);
    if (i === 6) f.run = run;
  }
  expect(targetIds).toHaveLength(15);
  expect(listRunIds(f.runsDir)).toHaveLength(6000);
  // Simulate migration of existing records, then exercise writeRun's ongoing maintenance.
  rmSync(f.journalPath, { force: true });
  const seeded = journal.seedReviewRunJournal({ runsDir: f.runsDir });
  expect(seeded).toMatchObject({ seeded: 6000 });
  await Promise.all(targetIds.slice(0, 8).map(id => Promise.resolve().then(() =>
    journal.appendReviewRunJournal(readRun(id, f.runsDir), f.runsDir, Date.now(), statSync(join(f.runsDir, `${id}.json`))))));
  expect(lines(f)).toHaveLength(6008);
  expect(lines(f).slice(-8).map(row => row.id).sort()).toEqual(targetIds.slice(0, 8).sort());
  expect(readFileSync(f.journalPath, 'utf8').endsWith('\n')).toBe(true);
  for (let i = 0; i < 40; i++) {
    const run = { ...f.run, id: `review-pr-after-seed-${i}`, input: { repo: f.repo, pr: i === 0 ? f.pr : 100 + i },
      findings: { read: { netBasis: { rev: 'c'.repeat(40) } } } };
    writeJsonAtomic(join(f.runsDir, `${run.id}.json`), run);
    utimesSync(join(f.runsDir, `${run.id}.json`), 8000 + i, 8000 + i);
    journal.appendReviewRunJournal(run, f.runsDir, Date.now(), statSync(join(f.runsDir, `${run.id}.json`)));
    if (i === 0) targetIds.push(run.id);
  }
  expect(lines(f)).toHaveLength(6048);
  const found = candidates(f);
  expect(found).toMatchObject({ source: 'journal', unjournaled: 0 });
  expect(found.ids.sort()).toEqual(targetIds.sort());
  const io = counter(f);
  expectFound(f, io);
  expect(io.ids.length).toBeLessThanOrEqual(targetIds.length + found.unjournaled);
}, 120_000);

it('includes and parses an unjournaled target written directly with writeJsonAtomic', () => {
  const f = fixture();
  writeFileSync(f.journalPath, '');
  writeJsonAtomic(join(f.runsDir, `${f.run.id}.json`), f.run);
  expect(candidates(f)).toEqual({ ids: [f.run.id], source: 'journal', unjournaled: 1 });
  const io = counter(f); expectFound(f, io);
  expect(io.ids.length).toBeLessThanOrEqual(1);
});

it.each(['no trailing newline', 'invalid JSON'])('parses the target hidden by a torn last line (%s)', kind => {
  const f = fixture(); writeRun(f.run, f.runsDir);
  // A torn wrong-key line must not exclude the actual target record.
  const torn = kind === 'no trailing newline' ? line(f, f.run.id, 'o/r#999').trimEnd() : `{"id":"${f.run.id}","key":\n`;
  writeFileSync(f.journalPath, torn);
  expect(candidates(f)).toEqual({ ids: [f.run.id], source: 'journal', unjournaled: 1 });
  expectFound(f, counter(f));
});

it('parses an id with conflicting key lines, even when the last line names another PR', () => {
  const f = fixture(); writeRun(f.run, f.runsDir);
  writeFileSync(f.journalPath, line(f, f.run.id, key(f)) + line(f, f.run.id, 'o/r#999'));
  expect(candidates(f)).toEqual({ ids: [f.run.id], source: 'journal', unjournaled: 1 });
  expectFound(f, counter(f));
});

it.each([0, 5, 20])('parses an atomic replacement %s seconds after its other-PR journal row, including within the tolerance window', gap => {
  const f = fixture(); oldTargetAndNewerUnrelated(f, 40);
  const id = 'review-pr-new-0', path = join(f.runsDir, `${id}.json`);
  // Every other-PR row matches its file mtime, including the last line for this id.
  writeFileSync(f.journalPath, listRunIds(f.runsDir).map(id => {
    const run = readRun(id, f.runsDir);
    return line(f, id, `${run.input.repo}#${run.input.pr}`, statSync(join(f.runsDir, `${id}.json`)).mtimeMs);
  }).join(''));
  const unchanged = counter(f); expectFound(f, unchanged, 2);
  expect(unchanged.ids).toEqual([f.run.id]);
  const replacement = { ...f.run, id, verdict: { verdict: 'reject' },
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(120_000).toISOString() }] };
  writeJsonAtomic(path, replacement);
  utimesSync(path, 100 + gap, 100 + gap); // Includes identical mtimes: inode replacement must invalidate exclusion.
  expect(candidates(f)).toEqual({ ids: [id, f.run.id].sort(), source: 'journal', unjournaled: 1 });
  const io = counter(f);
  expect(evidence(f, io, 2).loopPayload).toEqual(replacement);
  expect(io.ids).toContain(id);
  expect(io.ids.length).toBeLessThanOrEqual(2);
});

it('uses the last timestamp for repeated same-key lines when checking replacement freshness', () => {
  const f = fixture(); writeRun(f.run, f.runsDir);
  utimesSync(join(f.runsDir, `${f.run.id}.json`), 120, 120);
  writeFileSync(f.journalPath, line(f, f.run.id, 'o/r#999', 120_000) + line(f, f.run.id, 'o/r#999', 100_000));
  expect(candidates(f)).toEqual({ ids: [f.run.id], source: 'journal', unjournaled: 1 });
  expectFound(f, counter(f));
});

it.each(['missing', 'non-finite', 'stat failure', 'missing identity'])('parses an other-PR hint with an unverifiable timestamp (%s)', kind => {
  const f = fixture(); writeRun(f.run, f.runsDir);
  const row = { id: f.run.id, key: 'o/r#999' };
  if (kind === 'non-finite') row.at = 'Infinity';
  if (kind === 'stat failure' || kind === 'missing identity') row.at = Date.now();
  writeFileSync(f.journalPath, `${JSON.stringify(row)}\n`);
  const options = kind === 'stat failure' ? { stat: () => { throw Error('stat failed'); } } : {};
  expect(journal.readJournalCandidates(f.runsDir, f.repo, f.pr, options))
    .toEqual({ ids: [f.run.id], source: 'journal', unjournaled: 1 });
  if (kind !== 'stat failure') expectFound(f, counter(f));
});

it.each(['journal', 'index'])('refuses a filename/payload ID mismatch through %s fallback despite an older same-head accept and ample budget', source => {
  const f = fixture(); writeRun(f.run, f.runsDir);
  utimesSync(join(f.runsDir, `${f.run.id}.json`), 1, 1);
  const id = 'review-pr-new-rejection';
  const run = { ...f.run, id, verdict: { verdict: 'reject' },
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(120_000).toISOString() }] };
  if (source === 'index') {
    writeRun(run, f.runsDir);
    expect(journal.backfillReviewRunIndex({ runsDir: f.runsDir, repo: f.repo, openPrs: new Set([f.pr]) }).complete).toBe(true);
  }
  writeJsonAtomic(join(f.runsDir, `${id}.json`), { ...run, id: 'review-pr-impostor' });
  utimesSync(join(f.runsDir, `${id}.json`), 120, 120);
  journal.appendReviewRunJournal(run, f.runsDir);
  if (source === 'index') {
    rmSync(f.journalPath);
  }
  const io = counter(f);
  expect(() => evidence(f, io, 100)).toThrow('unverified review index entry');
  expect(io.ids.filter(readId => readId === id)).toHaveLength(1);
});

it.each(['archive claim', 'missing journal', 'oversized journal'])('%s refuses journal discovery and HOLDs at the fallback parse cap', kind => {
  const f = fixture(); oldTargetAndNewerUnrelated(f);
  // Use a real journal independently of writeRun's not-yet-implemented maintenance.
  writeFileSync(f.journalPath, listRunIds(f.runsDir).map(id => {
    const run = readRun(id, f.runsDir); return line(f, id, `${run.input.repo}#${run.input.pr}`);
  }).join(''));
  if (kind === 'archive claim') writeFileSync(join(f.runsDir, '.review-pr-x.archiving-1-abc'), 'claim');
  if (kind === 'missing journal') rmSync(f.journalPath);
  if (kind === 'oversized journal') appendFileSync(f.journalPath, ' '.repeat(8 * 1024 * 1024 + 1));
  expect(candidates(f)).toBeNull();
  const io = counter(f);
  expect(evidence(f, io, 1)).toMatchObject({ ok: false, reason: 'scan-capped' });
  expect(io.ids).toHaveLength(1);
  expect(io.ids).not.toContain(f.run.id);
});

it.each(['id', 'op', 'repo', 'pr'])('does not trust a journal-listed record with mismatching %s', field => {
  const f = fixture();
  const record = structuredClone(f.run);
  if (field === 'id') record.id = 'review-pr-impostor';
  if (field === 'op') record.op = 'fix-pr';
  if (field === 'repo') record.input.repo = 'other/repo';
  if (field === 'pr') record.input.pr = 999;
  writeJsonAtomic(join(f.runsDir, `${f.run.id}.json`), record);
  writeFileSync(f.journalPath, line(f, f.run.id, key(f)));
  expect(candidates(f)).toEqual({ ids: [f.run.id], source: 'journal', unjournaled: 0 });
  const io = counter(f);
  if (field === 'id') {
    expect(() => evidence(f, io)).toThrow('unverified review index entry');
    expect(io.ids).toEqual([f.run.id]);
    return;
  }
  const result = evidence(f, io);
  expect(io.ids).toContain(f.run.id);
  expect(result.loopPayload ?? null).toBeNull();
  // A mismatch can be rejected with HOLD or discarded after verified parsing, never used as a verdict.
  expect(result.loopPayload?.verdict).toBeUndefined();
});

it('ignores journal-only ids and excludes verified other-key ids from candidates', () => {
  const f = fixture(); writeRun(f.run, f.runsDir);
  const other = { ...f.run, id: 'review-pr-other', input: { repo: f.repo, pr: 8 } };
  writeRun(other, f.runsDir);
  writeFileSync(f.journalPath, line(f, f.run.id, key(f)) + line(f, other.id, 'o/r#8') + line(f, 'review-pr-gone', key(f)));
  expect(candidates(f)).toEqual({ ids: [f.run.id], source: 'journal', unjournaled: 0 });
  const io = counter(f); expectFound(f, io);
  expect(io.ids).toEqual([f.run.id]);
});

it('seeds only missing readable records, reports the count, and is idempotent', () => {
  const f = fixture();
  writeJsonAtomic(join(f.runsDir, `${f.run.id}.json`), f.run);
  writeFileSync(join(f.runsDir, 'review-pr-unreadable.json'), '{');
  const io = counter(f);
  expect(journal.seedReviewRunJournal({ runsDir: f.runsDir, read: io.read })).toMatchObject({ seeded: 1 });
  expect(io.ids).toContain(f.run.id);
  expect(io.ids).toContain('review-pr-unreadable');
  expect(lines(f)).toEqual([{ id: f.run.id, key: key(f),
    at: statSync(join(f.runsDir, `${f.run.id}.json`)).mtimeMs,
    identity: identity(join(f.runsDir, `${f.run.id}.json`)) }]);
  const before = readFileSync(f.journalPath, 'utf8');
  expect(journal.seedReviewRunJournal({ runsDir: f.runsDir })).toMatchObject({ seeded: 0 });
  expect(readFileSync(f.journalPath, 'utf8')).toBe(before);
});

it('seed refuses to bind a journal key to a payload replaced during its read', () => {
  const f = fixture(), path = join(f.runsDir, `${f.run.id}.json`);
  writeJsonAtomic(path, f.run);
  expect(journal.seedReviewRunJournal({ runsDir: f.runsDir, read: () => {
    writeJsonAtomic(path, { ...f.run, input: { repo: f.repo, pr: 8 } });
    return f.run;
  } })).toEqual({ seeded: 0, already: 0, skipped: 1 });
  expect(readFileSync(f.journalPath, 'utf8')).toBe('');
  expect(candidates(f)).toEqual({ ids: [f.run.id], source: 'journal', unjournaled: 1 });
});

it('seed migrates identity-less journal rows instead of preserving unverifiable exclusions', () => {
  const f = fixture(); writeRun(f.run, f.runsDir);
  writeFileSync(f.journalPath, `${JSON.stringify({ id: f.run.id, key: key(f), at: Date.now() })}\n`);
  expect(journal.seedReviewRunJournal({ runsDir: f.runsDir })).toMatchObject({ seeded: 1 });
  expect(lines(f).at(-1).identity).toEqual(identity(join(f.runsDir, `${f.run.id}.json`)));
  expect(candidates(f)).toEqual({ ids: [f.run.id], source: 'journal', unjournaled: 0 });
});

it('real CLI seeds idempotently and probes the journal within 40 parses', () => {
  const f = fixture(); oldTargetAndNewerUnrelated(f, 39);
  rmSync(f.journalPath, { force: true });
  const runCli = args => execFileSync(process.execPath, [cli, ...args, `--runs-dir=${f.runsDir}`],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env,
      WE_SHARED_RUNS_DIR: f.runsDir, OPERATION_RUNS_DIR: f.runsDir } });
  expect(runCli(['seed'])).toMatch(/seeded\s*[:=]?\s*40\b/i);
  expect(lines(f)).toHaveLength(40);
  const before = readFileSync(f.journalPath, 'utf8');
  expect(runCli(['seed'])).toMatch(/seeded\s*[:=]?\s*0\b/i);
  expect(readFileSync(f.journalPath, 'utf8')).toBe(before);
  const stdout = runCli(['--probe', key(f), `--head=${f.head}`]);
  expect(stdout).toContain('source: journal');
  const parses = stdout.match(/parses:\s*(\d+)\b/);
  expect(parses).not.toBeNull();
  expect(Number(parses[1])).toBeGreaterThan(0);
  expect(Number(parses[1])).toBeLessThanOrEqual(40);
}, 60_000);
