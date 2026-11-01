/**
 * @file scripts/lib/__tests__/daemon-jobs-scan.test.mjs
 * @description perf item 5 — `store.scan` must answer exactly what `store.list` answers (live records in full,
 *   terminal ones as a projection, the same corrupt ids) while parsing a finished record once. Covers a
 *   crash mid-write, a torn replacement of a cached record, a vanishing file, the `list`-only fallback, and an
 *   old-reader vs new-reader equivalence run on a copy of the real store (path from JOB_STORE_COPY or a `.job-store-copy` pointer file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobStore, enqueueJob, scanStore } from '../daemon-jobs-runtime.mjs';
import { writeJsonAtomic } from '../atomic-json-file.mjs';
import { defineJobKind } from '../daemon-jobs.mjs';
import { TERMINAL_JOB_STATUSES } from '../../operations/job-record.mjs';
import { runPath } from '../../operations/run-store.mjs';

const noop = defineJobKind({ kind: 'noop', entry: 'x.mjs', codeMode: 'readonly-tree', maxAttempts: 1, resumable: false });
const project = (r) => Object.freeze({ id: r.id, kind: r.job.kind, status: r.job.status });
const NO_RACY = { racyWindowMs: 0 };
let dir; let store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-job-scan-')); store = createJobStore(dir); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mk = (status) => {
  const rec = enqueueJob({ store, kindDef: noop, codeSha: 'a'.repeat(40) });
  if (status === 'queued') return rec;
  return store.update(rec.id, (r) => ({ ...r, job: { ...r.job, status } }));
};

/** The old reader vs the new one: same answer, split by the terminal rule. */
function expectEquivalent(s) {
  const old = s.list();
  const now = s.scan(project, 'test', NO_RACY);
  const terminal = old.records.filter((r) => TERMINAL_JOB_STATUSES.includes(r.job.status));
  expect(now.live).toEqual(old.records.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)));
  expect(now.done).toEqual(terminal.map(project));
  expect(now.corrupt).toEqual(old.corrupt);
  return now;
}

describe('store.scan equals store.list', () => {
  it('splits live and finished records and reports the same corrupt ids', () => {
    mk('queued'); mk('queued'); mk('succeeded'); mk('failed');
    writeFileSync(join(dir, 'consumed.json'), '["a"]\n');
    writeFileSync(join(dir, 'job-noop-torn.json'), '{"v":1,"id":"job-noop-tor');
    writeFileSync(join(dir, 'stray.json.1.tmp'), '{"half');
    const now = expectEquivalent(store);
    expect(now.live).toHaveLength(2);
    expect(now.done).toHaveLength(2);
    expect(now.corrupt).toEqual(['job-noop-torn']);
  });

  it('parses a finished record once, and re-reads it the moment it changes', () => {
    const rec = mk('succeeded');
    let calls = 0;
    const counting = (r) => { calls += 1; return project(r); };
    store.scan(counting, 'count', NO_RACY); store.scan(counting, 'count', NO_RACY);
    expect(calls).toBe(1);
    store.update(rec.id, (r) => ({ ...r, job: { ...r.job, status: 'queued' } }));
    const now = store.scan(counting, 'count', NO_RACY);
    expect(now.live.map((r) => r.id)).toEqual([rec.id]);
    expect(now.done).toEqual([]);
    store.update(rec.id, (r) => ({ ...r, job: { ...r.job, status: 'failed' } }));
    expect(store.scan(counting, 'count', NO_RACY).done[0].status).toBe('failed');
  });

  it('crash before the rename: the old record stays whole and the temp file is ignored', () => {
    const rec = mk('succeeded');
    store.scan(project, 'crash', NO_RACY);
    const next = { ...store.read(rec.id), job: { ...store.read(rec.id).job, status: 'running' } };
    expect(() => writeJsonAtomic(runPath(rec.id, dir), next, { renameSyncFn: () => { throw new Error('crash'); } })).toThrow();
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false); // the writer cleans its own temp
    writeFileSync(join(dir, `${rec.id}.json.99.1.zz.tmp`), JSON.stringify(next).slice(0, 40)); // a leftover from a hard kill
    const now = expectEquivalent(store);
    expect(now.done.map((d) => d.id)).toEqual([rec.id]);
    expect(now.corrupt).toEqual([]);
  });

  it('a torn replacement of a cached record is corrupt (never the stale cache), and repair brings it back', () => {
    const rec = mk('succeeded');
    const path = runPath(rec.id, dir);
    const good = readFileSync(path, 'utf8');
    store.scan(project, 'torn', NO_RACY);
    writeFileSync(path, good.slice(0, 20)); // in-place torn write, different size
    let now = expectEquivalent(store);
    expect(now.corrupt).toEqual([rec.id]);
    expect(now.done).toEqual([]);
    writeFileSync(path, good);
    now = expectEquivalent(store);
    expect(now.corrupt).toEqual([]);
    expect(now.done.map((d) => d.id)).toEqual([rec.id]);
  });

  it('a record deleted after it was cached disappears', () => {
    const a = mk('succeeded'); const b = mk('succeeded');
    store.scan(project, 'gone', NO_RACY);
    unlinkSync(runPath(a.id, dir));
    expect(expectEquivalent(store).done.map((d) => d.id)).toEqual([b.id]);
  });

  it('scanStore falls back to list() for a store without scan', () => {
    mk('queued'); mk('succeeded');
    const listOnly = { list: () => store.list() };
    expect(scanStore(listOnly, project, 'k')).toEqual(store.scan(project, 'fallback'));
  });
});

// The hermetic test env strips ambient variables, so the copy's path comes from a one-line pointer file in the
// checkout root (untracked; absent in CI, which skips this block) or, outside the hermetic runner, JOB_STORE_COPY.
const POINTER = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), '.job-store-copy');
describe('store.scan hardening (audit)', () => {
  it('never trusts a just-touched file from cache: an equal-size in-place rewrite is still seen', () => {
    const rec = mk('succeeded');
    const path = runPath(rec.id, dir);
    store.scan(project, 'racy'); // default window: fresh file, so nothing is cached
    const text = readFileSync(path, 'utf8');
    const flipped = text.replace('"status": "succeeded"', '"status": "launching"'.padEnd('"status": "succeeded"'.length, ' '));
    expect(flipped.length).toBe(text.length);
    writeFileSync(path, flipped); // same inode, same size, within one timestamp quantum
    const old = store.list();
    const now = store.scan(project, 'racy');
    expect(now.live.map((r) => r.id)).toEqual(old.records.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)).map((r) => r.id));
    expect(now.live.map((r) => r.id)).toEqual([rec.id]);
  });

  it('a stat failure that is not "absent" is judged by the read path like list() does', () => {
    mk('succeeded');
    symlinkSync('job-noop-loop.json', join(dir, 'job-noop-loop.json')); // stat -> ELOOP, not ENOENT
    const now = expectEquivalent(store);
    expect(now.done).toHaveLength(1);
  });

  it('walks in listing (filename) order even when a record id differs from its filename', () => {
    const a = mk('queued'); const b = mk('queued');
    const [first, second] = [a.id, b.id].sort();
    const pa = runPath(first, dir); const pb = runPath(second, dir);
    const ra = JSON.parse(readFileSync(pa, 'utf8')); const rb = JSON.parse(readFileSync(pb, 'utf8'));
    writeFileSync(pa, JSON.stringify({ ...ra, id: second }));
    writeFileSync(pb, JSON.stringify({ ...rb, id: first }));
    expect(store.scan(project, 'order', NO_RACY).ordered.map((e) => e.live.id)).toEqual(store.list().records.map((r) => r.id));
  });
});

const REAL = process.env.JOB_STORE_COPY || (existsSync(POINTER) ? readFileSync(POINTER, 'utf8').trim() : undefined);
describe.skipIf(!REAL || !existsSync(REAL))('old reader vs new reader on a copy of the real store', () => {
  it('returns the same answer', () => {
    const real = createJobStore(REAL);
    expect(statSync(REAL).isDirectory()).toBe(true);
    for (let pass = 0; pass < 2; pass += 1) expectEquivalent(real); // cold, then warm
  }, 120_000);
});
