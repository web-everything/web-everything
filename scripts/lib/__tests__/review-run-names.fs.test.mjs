// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../../operations/run-store.mjs';
import * as index from '../review-run-index.mjs';
import { readDrainRedTeamEvidence } from '../drain-red-team-evidence.mjs';
import { archiveClosedReviewRuns } from '../archive-closed-review-runs.mjs';

// Keep runs and any sibling discovery files under one disposable parent.
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const cli = fileURLToPath(new URL('../../review-run-probe.mjs', import.meta.url));
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19);
const UUID = '12345678-abcd-abcd-abcd-123456789abc';
function fixture(pr = 7) {
  const root = mkdtempSync(join(tmpdir(), 'review-run-names-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir);
  return { root, runsDir, repo: 'o/r', pr, head: 'a'.repeat(40),
    env: { WE_SHARED_RUNS_DIR: runsDir, OPERATION_RUNS_DIR: runsDir }, readScorecards: () => [] };
}
function record(f, { pr = f.pr, repo = f.repo, id = store.newReviewRunId(pr), head = f.head,
  verdict = 'accept', startedAt = 1000 } = {}) {
  const run = store.newRunRecord({ id, op: 'review-pr', input: { repo, pr } });
  run.findings = { read: { netBasis: { rev: head } } };
  run.verdict = { verdict };
  run.stepTimings = [{ step: 'read', stepIndex: 0, startedAt: new Date(startedAt).toISOString() }];
  return run;
}
const pathOf = (f, id) => join(f.runsDir, `${id}.json`);
function persist(f, options) {
  const run = record(f, options);
  store.writeRun(run, f.runsDir);
  return run;
}
function counter(f, afterRead) {
  const ids = [];
  return { ids, read(id, dir = f.runsDir) {
    ids.push(id); // A failed real read is charged too.
    const run = store.readRun(id, dir);
    afterRead?.(run, ids.length);
    return run;
  } };
}
function evidence(f, io = counter(f), maxParses = 3000, extra = {}) {
  return readDrainRedTeamEvidence({ ...f, read: io.read, now: NOW,
    scanSettings: { file: { runs: { scan: { maxParses } } }, platform: {}, env: {} }, ...extra });
}
const candidates = (f, extra = {}) => index.readNamedCandidates(f.runsDir, f.repo, f.pr,
  { list: store.listRunIds, readdir: readdirSync, ...extra });
function found(f, run, io = counter(f), cap = 3000, extra = {}) {
  const result = evidence(f, io, cap, extra);
  expect(result.ok).not.toBe(false);
  expect(result.loopPayload).toEqual(run);
  expect(io.ids).toContain(run.id);
  return result;
}
const hold = result => expect(result).toMatchObject({ ok: false });
function probe(f) {
  return execFileSync(process.execPath, [cli, '--probe', `${f.repo}#${f.pr}`,
    `--head=${f.head}`, `--runs-dir=${f.runsDir}`], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
}
function bulk(f) {
  const target = [];
  let exact;
  for (let i = 0; i < 6000; i++) {
    const pr = i % 400 + 1;
    const run = persist(f, { pr, head: i === f.pr - 1 ? f.head : 'b'.repeat(40) });
    utimesSync(pathOf(f, run.id), 100 + i, 100 + i);
    if (pr === f.pr) target.push(run.id);
    if (i === f.pr - 1) exact = run;
  }
  return { target, exact };
}

it('T1 exports the exact PR-name grammar and mints keyed ids, with legacy fallback for invalid PRs', () => {
  expect(store.NAME_RE).toEqual(/^review-pr-pr([1-9]\d{0,9})-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  expect(store.newReviewRunId).toBeTypeOf('function');
  expect(index.readNamedCandidates).toBeTypeOf('function');
  for (const pr of [1, 7155, 9999999999]) {
    const id = store.newReviewRunId(pr);
    expect(id.match(store.NAME_RE)?.[1]).toBe(String(pr));
    expect(store.newReviewRunId(pr)).not.toBe(id);
  }
  for (const pr of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7']) {
    const id = store.newReviewRunId(pr);
    expect(id).toMatch(/^review-pr-/);
    expect(store.NAME_RE.test(id)).toBe(false);
  }
});

it('T1 scans all 6000 runs like main: finds the target with sufficient budget and HOLDs below the count', () => {
  const f = fixture(), { exact } = bulk(f), io = counter(f);
  const ids = store.listRunIds(f.runsDir);
  expect(ids).toHaveLength(6000);
  expect(candidates(f)).toEqual({ ids: ids.slice().sort(), source: 'names', legacy: 0, mismatch: 0 });
  found(f, exact, io, 6000);
  expect(new Set(io.ids)).toEqual(new Set(ids));
  const capped = counter(f);
  expect(evidence(f, capped, 3000)).toMatchObject({ ok: false, reason: 'scan-capped' });
  expect(capped.ids).toHaveLength(3000);
  const stdout = probe(f);
  expect(stdout).toContain('source: names');
  expect(stdout).toMatch(/^parses: \d+$/m);
  expect(stdout).toMatch(/^legacy: 0$/m);
  expect(stdout).toMatch(/^mismatch: 0$/m);
}, 120_000);

it.each(['corrupt', 'rejection'])('parses a PR-8 name during PR-7 lookup: %s refuses older acceptance', kind => {
  const f = fixture(); persist(f);
  const misplaced = record(f, { id: store.newReviewRunId(8), startedAt: 2000, verdict: 'reject' });
  writeFileSync(pathOf(f, misplaced.id), kind === 'corrupt' ? '{' : JSON.stringify(misplaced));
  const io = counter(f);
  const result = evidence(f, io);
  hold(result);
  expect(result.loopPayload?.verdict?.verdict).not.toBe('accept');
  expect(io.ids).toContain(misplaced.id);
  if (kind === 'rejection') expect(probe(f)).toMatch(/^mismatch: 1$/m);
});

it('T2 refuses a fresh mismatched keyed write without creating a file', () => {
  const f = fixture(), run = record(f);
  run.input.pr++;
  expect(() => store.writeRun(run, f.runsDir)).toThrow();
  expect(existsSync(pathOf(f, run.id))).toBe(false);
});

it.each(['resume payload', 'startRun --run-id fresh payload', 'wrong operation'])(
  'T2 refuses %s over an X-named id and preserves its bytes and X lookup', kind => {
    const f = fixture(), run = persist(f), before = readFileSync(pathOf(f, run.id));
    const replacement = kind === 'startRun --run-id fresh payload'
      ? store.newRunRecord({ id: run.id, op: 'review-pr', input: { repo: f.repo, pr: f.pr + 1 } })
      : { ...run, ...(kind === 'wrong operation' ? { op: 'other' } : { input: { ...run.input, pr: f.pr + 1 } }) };
    expect(() => store.writeRun(replacement, f.runsDir)).toThrow();
    expect(readFileSync(pathOf(f, run.id))).toEqual(before);
    found(f, run);
  });

it('T3 holds Y after an in-place X rejection immediately following Y publication; probe counts the mismatch', () => {
  const f = fixture(8), run = persist(f);
  // writeRun has returned from its atomic rename; bypass it on the published inode.
  const rejection = { ...run, input: { ...run.input, pr: 7 }, verdict: { verdict: 'reject' } };
  const inode = statSync(pathOf(f, run.id)).ino;
  writeFileSync(pathOf(f, run.id), JSON.stringify(rejection));
  expect(statSync(pathOf(f, run.id)).ino).toBe(inode);
  hold(evidence(f));
  expect(probe(f)).toMatch(/^mismatch: 1$/m);
  expect(readdirSync(f.root)).toEqual(['runs', 'runs-review-index.json']);
  expect(readdirSync(f.runsDir)).toEqual([`${run.id}.json`]);
});

it('T4 same-inode same-size restored-mtime rejection wins', () => {
  const f = fixture(), older = persist(f), newer = persist(f, { startedAt: 2000, verdict: 'reject' });
  // Equal-length valid verdict strings keep the serialized size fixed.
  const placeholder = { ...newer, verdict: { verdict: 'accept' } };
  store.writeRun(placeholder, f.runsDir);
  const path = pathOf(f, newer.id), before = statSync(path);
  // Restore the original byte length with whitespace, without replacing the inode.
  const compact = JSON.stringify(newer);
  expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(before.size);
  writeFileSync(path, compact.padEnd(before.size, ' '));
  utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);
  const after = statSync(path);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBeCloseTo(before.mtimeMs, 2);
  found(f, newer);
  expect(older.id).not.toBe(newer.id);
});

it('T5 parses and finds a legacy X payload among 6000 keyed runs', () => {
  const f = fixture(); bulk(f);
  const legacy = persist(f, { id: 'review-pr-legacy', startedAt: 5000 });
  utimesSync(pathOf(f, legacy.id), 1, 1);
  expect(candidates(f).legacy).toBe(1);
  const io = counter(f);
  found(f, legacy, io, 6001);
  expect(io.ids).toHaveLength(6001);
}, 120_000);

it('T5 legacy count above the parse cap gives scan-capped and HOLD even with an accept', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) persist(f, { id: `review-pr-legacy-${i}` });
  const io = counter(f);
  expect(evidence(f, io, 3)).toMatchObject({ ok: false, reason: 'scan-capped' });
  expect(io.ids).toHaveLength(3);
});

it('T6 parses every keyed name and counts malformed near-matches as legacy', () => {
  const f = fixture(7155);
  const legacyIds = [`review-pr-pr07155-${UUID}`, `review-pr-pr7155-${UUID.toUpperCase()}`,
    `review-pr-pr7155x-${UUID}`, `review-pr-pr7155-${UUID}-suffix`];
  for (const id of legacyIds) persist(f, { id });
  const own = persist(f, { startedAt: 2000 }), other = persist(f, { pr: 71, startedAt: 2000 });
  expect(candidates(f)).toEqual({ ids: [...legacyIds, own.id, other.id].sort(), source: 'names', legacy: 4, mismatch: 0 });
  const io = counter(f); found(f, own, io);
  expect(new Set(io.ids)).toEqual(new Set([...legacyIds, own.id, other.id]));
  const small = { ...f, pr: 71 };
  expect(candidates(small).ids).toEqual([...legacyIds, own.id, other.id].sort());
  const smallIo = counter(small); found(small, other, smallIo);
  expect(smallIo.ids).toContain(own.id);
});

it('T7 parses the same PR number in another repo without matching its payload', () => {
  const f = fixture(), other = persist(f, { repo: 'another/repo' }), io = counter(f);
  expect(candidates(f).ids).toEqual([other.id]);
  const result = evidence(f, io);
  expect(result.loopPayload ?? null).toBeNull();
  expect(io.ids).toEqual([other.id]);
});

it.each(['op', 'id'])('T7 name-N record with wrong %s holds despite a valid accept', field => {
  const f = fixture(); persist(f);
  const corrupt = persist(f, { startedAt: 2000 });
  const payload = { ...corrupt, [field]: field === 'op' ? 'other' : 'review-pr-impostor' };
  writeFileSync(pathOf(f, corrupt.id), JSON.stringify(payload));
  const io = counter(f); hold(evidence(f, io));
  expect(io.ids).toContain(corrupt.id);
});

it('T8 discovery performs one real readdir and no stat; an unreadable readdir returns null', () => {
  const f = fixture(), run = persist(f);
  let calls = 0;
  expect(candidates(f, { readdir: (...args) => { calls++; return readdirSync(...args); },
    stat: () => { throw Error('must not stat'); } })).toEqual({ ids: [run.id], source: 'names', legacy: 0, mismatch: 0 });
  expect(calls).toBe(1);
  expect(candidates(f, { readdir: () => { throw Error('unreadable'); } })).toBeNull();
});

it.each(['keyed', 'legacy'])('T8 new %s names during both parse snapshots retry then HOLD within budget', kind => {
  const f = fixture(); persist(f);
  let arrivals = 0;
  const io = counter(f, () => {
    // Mutate only after a real payload read; each attempt sees a new directory name.
    persist(f, { ...(kind === 'legacy' ? { id: `review-pr-arrival-${arrivals}` } : {}), startedAt: 2000 + arrivals++ });
  });
  hold(evidence(f, io, 20));
  expect(arrivals).toBeGreaterThanOrEqual(2);
  expect(io.ids.length).toBeLessThanOrEqual(20);
});

it('T8 an archiving claim makes discovery null and even a successful fallback accept HOLD', () => {
  const f = fixture(), run = persist(f);
  writeFileSync(join(f.runsDir, `.${run.id}.archiving-123-${UUID}`), readFileSync(pathOf(f, run.id)));
  expect(candidates(f)).toBeNull();
  const io = counter(f); hold(evidence(f, io, 3));
  expect(io.ids.length).toBeLessThanOrEqual(3);
});

it('T8 a torn target file is charged and HOLDs despite a valid accept', () => {
  const f = fixture(); persist(f);
  const torn = persist(f);
  writeFileSync(pathOf(f, torn.id), '{');
  const io = counter(f); hold(evidence(f, io, 2));
  expect(io.ids).toContain(torn.id);
  expect(io.ids.length).toBeLessThanOrEqual(2);
});

it.each(['legacy', 'same-PR named', 'invalid id'])('T9 flat %s archived evidence requires restoration and HOLD', kind => {
  const f = fixture();
  persist(f);
  const archived = record(f, kind === 'legacy' ? { id: 'review-pr-legacy-flat' } : {});
  const directory = join(f.runsDir, 'archive', 'review-pr');
  mkdirSync(directory, { recursive: true });
  const filename = kind === 'invalid id' ? 'review-pr-invalid\nname.json' : `${archived.id}.json`;
  writeFileSync(join(directory, filename), JSON.stringify(archived));
  expect(candidates(f)).toBeNull();
  hold(evidence(f));
});

it.each(['other PR', 'target PR rejection'])('T9 flat other-N filename with %s payload requires restoration and HOLD', kind => {
  const f = fixture(); persist(f);
  const archived = record(f, { id: store.newReviewRunId(f.pr + 1),
    pr: kind === 'other PR' ? f.pr + 1 : f.pr, verdict: 'reject' });
  const directory = join(f.runsDir, 'archive', 'review-pr');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${archived.id}.json`), JSON.stringify(archived));
  expect(candidates(f)).toBeNull();
  hold(evidence(f));
});

it('T9 an unreadable flat archive directory gives HOLD', () => {
  const f = fixture();
  persist(f);
  mkdirSync(join(f.runsDir, 'archive'));
  // ENOTDIR is deterministic even when the test process can bypass permissions.
  writeFileSync(join(f.runsDir, 'archive', 'review-pr'), 'not a directory');
  expect(candidates(f)).toBeNull();
  hold(evidence(f));
});

it.each([undefined, 14, 21])('T9 archive age %s uses repo/PR directories; reopened evidence holds until restored', minAgeDays => {
  const f = fixture(), old = persist(f), young = persist(f, { pr: 8 }), open = persist(f, { pr: 9 });
  const middle = persist(f, { pr: 10 });
  for (const run of [old, open]) utimesSync(pathOf(f, run.id), (NOW - 30 * DAY) / 1000, (NOW - 30 * DAY) / 1000);
  utimesSync(pathOf(f, young.id), (NOW - DAY) / 1000, (NOW - DAY) / 1000);
  utimesSync(pathOf(f, middle.id), (NOW - 18 * DAY) / 1000, (NOW - 18 * DAY) / 1000);
  const result = archiveClosedReviewRuns({ runsDir: f.runsDir, dryRun: false, now: () => NOW,
    ...(minAgeDays === undefined ? {} : { minAgeDays }), prState: (_repo, pr) => pr === 9 ? 'open' : 'closed' });
  expect(result.archived.slice().sort()).toEqual((minAgeDays === 21 ? [old.id] : [old.id, middle.id]).sort());
  expect(existsSync(pathOf(f, middle.id))).toBe(minAgeDays === 21);
  expect(existsSync(pathOf(f, young.id))).toBe(true);
  expect(existsSync(pathOf(f, open.id))).toBe(true);
  const archived = join(f.runsDir, 'archive', 'review-pr', 'o', 'r', String(f.pr), `${old.id}.json`);
  expect(JSON.parse(readFileSync(archived, 'utf8'))).toEqual(old);
  expect(candidates(f)).toBeNull();
  hold(evidence(f)); // Reopened PR: archive presence forbids proving absence.
  renameSync(archived, pathOf(f, old.id));
  // Empty archive directories must not hold after the operator restores evidence.
  found(f, old);
});

it('T9 rewrite between classification and claim stays live and is not archived under a stale key', () => {
  const f = fixture(), old = persist(f, { id: 'review-pr-legacy-archive-race' });
  utimesSync(pathOf(f, old.id), (NOW - 30 * DAY) / 1000, (NOW - 30 * DAY) / 1000);
  const newer = { ...old, input: { repo: 'new/repo', pr: 19 }, verdict: { verdict: 'reject' } };
  const result = archiveClosedReviewRuns({ runsDir: f.runsDir, dryRun: false, now: () => NOW,
    prState: () => 'closed', beforeMove: () => store.writeRun(newer, f.runsDir) });
  expect(result.archived).toEqual([]);
  expect(store.readRun(old.id, f.runsDir)).toEqual(newer);
  expect(result.kept.changed).toContain(old.id);
});

it('T10 writeRun keeps the existing JSON index, creates no JSONL or seals, and ignores leftover tmp files', () => {
  const f = fixture(), run = persist(f);
  expect(readdirSync(f.root)).toEqual(['runs', 'runs-review-index.json']);
  expect(readdirSync(f.runsDir)).toEqual([`${run.id}.json`]);
  writeFileSync(join(f.runsDir, `${run.id}.json.tmp-leftover`), '{');
  expect(candidates(f)).toEqual({ ids: [run.id], source: 'names', legacy: 0, mismatch: 0 });
  const io = counter(f); found(f, run, io);
  expect(io.ids).toEqual([run.id]);
});
