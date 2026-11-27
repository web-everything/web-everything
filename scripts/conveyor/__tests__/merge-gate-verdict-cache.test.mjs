import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { cacheEntryPath, validCachedVerdict, readMergeGateVerdictCache, writeOnce, main,
  CACHED_VERDICT_MAX_BYTES } from '../merge-gate-verdict-cache.mjs';
import gateSource from '../await-verify-pass.mjs?raw';
import writerSource from '../merge-gate-verdict-cache.mjs?raw';

const subject = { repo: 'web-everything/web-everything', pr: 6085, jobId: 777 };
const headSha = 'b'.repeat(40);
const NOW = Date.parse('2026-11-27T12:00:00Z');
const iso = n => new Date(n).toISOString();
const context = { ...subject, headSha, now: NOW };
const entry = () => ({ v: 1, ...subject, headSha,
  verdict: { num: subject.pr, ok: false, job_name: 'merge-gate', head_sha: headSha,
    completed_at: iso(NOW - 120_000), mainCiGreen: true,
    results: [{ id: 'candidate-label', status: 'hold', reason: 'review pending' }] },
  verdictReadAt: iso(NOW - 86400_000), labels: [], labelsHead: headSha, labelsReadAt: iso(NOW),
  freeze: { frozen: false, publishedAt: iso(NOW - 60_000) }, freezeReadAt: iso(NOW) });

let root;
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'verdict-cache-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const pathFor = () => cacheEntryPath(subject, { root });
function put(value) { const path = pathFor(); fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; }
function writerIo(extra = {}) {
  let clock = NOW;
  const env = { WE_GH_READ_MEMO_DIR: join(root, 'memo') };
  return { root, env, now: () => clock, log: vi.fn(),
    readVerdict: vi.fn(() => { clock += 1000; return entry().verdict; }),
    readHeadAndLabels: vi.fn(() => { clock += 2000; return { headRefOid: headSha, labels: [] }; }),
    readFreeze: vi.fn(() => { clock += 3000; return entry().freeze; }), ...extra };
}

describe('validCachedVerdict', () => {
  it('accepts bound evidence case-insensitively without aging the immutable verdict', () => {
    const e = entry(); e.repo = e.repo.toUpperCase(); e.headSha = headSha.toUpperCase();
    e.labelsHead = headSha.toUpperCase(); e.verdict.head_sha = headSha.toUpperCase();
    expect(validCachedVerdict(e, context)).toEqual({ ok: true });
  });
  it.each([
    ['v', e => { e.v = 2; }], ['repo', e => { e.repo = 'other/repo'; }], ['pr', e => { e.pr = 1; }],
    ['jobId', e => { e.jobId = 776; }], ['string pr', e => { e.pr = String(e.pr); }],
    ['string jobId', e => { e.jobId = String(e.jobId); }],
    ['headSha', e => { e.headSha = 'c'.repeat(40); }], ['head shape', e => { e.headSha = 'b'; }],
    ['labelsHead', e => { e.labelsHead = 'c'.repeat(40); }], ['labelsHead shape', e => { e.labelsHead = 'b'; }],
    ['verdict.head_sha', e => { e.verdict.head_sha = 'c'.repeat(40); }], ['verdict head shape', e => { e.verdict.head_sha = 'b'; }],
    ['job_name', e => { e.verdict.job_name = 'other'; }], ['verdict.error', e => { e.verdict.error = 'offline'; }],
    ['error present but null', e => { e.verdict.error = null; }], ['labels', e => { e.labels = null; }],
    ['freeze null', e => { e.freeze = null; }], ['freeze array', e => { e.freeze = []; }],
    ['labelsReadAt invalid', e => { e.labelsReadAt = 'yesterday'; }], ['freezeReadAt invalid', e => { e.freezeReadAt = 'yesterday'; }],
    ['labelsReadAt absent', e => { delete e.labelsReadAt; }], ['freezeReadAt absent', e => { delete e.freezeReadAt; }],
    ['verdict absent', e => { delete e.verdict; }], ['labels absent', e => { delete e.labels; }], ['freeze absent', e => { delete e.freeze; }],
  ])('refuses %s', (_name, change) => {
    const e = entry(); change(e); expect(validCachedVerdict(e, context)).toEqual({ ok: false, reason: 'mismatch' });
  });
  it.each([null, undefined, [], 1, 'entry'])('refuses malformed entry %s', e => expect(validCachedVerdict(e, context).ok).toBe(false));
  it('an invalid decision clock refuses', () => expect(validCachedVerdict(entry(), { ...context, now: NaN }).ok).toBe(false));
  it('evidence exactly 10 min old is accepted, +1 ms rejected', () => {
    for (const field of ['labelsReadAt', 'freezeReadAt']) {
      const e = entry(); e[field] = iso(NOW - 600_000); expect(validCachedVerdict(e, context)).toEqual({ ok: true });
      e[field] = iso(NOW - 600_001); expect(validCachedVerdict(e, context)).toEqual({ ok: false, reason: 'stale' });
    }
  });
  it('exactly 60 s future skew accepted, +1 ms rejected', () => {
    for (const field of ['labelsReadAt', 'freezeReadAt']) {
      const e = entry(); e[field] = iso(NOW + 60_000); expect(validCachedVerdict(e, context)).toEqual({ ok: true });
      e[field] = iso(NOW + 60_001); expect(validCachedVerdict(e, context)).toEqual({ ok: false, reason: 'stale' });
    }
  });
  it('freeze.error is valid shape evidence for the existing classifier', () => {
    const e = entry(); e.freeze = { error: 'offline' }; expect(validCachedVerdict(e, context)).toEqual({ ok: true });
  });
});

describe('local entry paths and bounded reads', () => {
  it('names entries by the canonical repoKey and positive safe integer identities', () => {
    expect(pathFor()).toBe(join(root, 'merge-gate-verdict-cache', 'we--6085--777.json'));
    expect(cacheEntryPath({ ...subject, repo: 'FRONTIER-UI/FRONTIERUI' }, { root })).toBe(join(root, 'merge-gate-verdict-cache', 'frontierui--6085--777.json'));
  });
  it.each([{ repo: '../' }, { repo: 'web-everything/../web-everything' }, { repo: 'unknown/repo' },
    { pr: 0 }, { pr: 1.5 }, { pr: '6085' }, { jobId: -1 }, { jobId: Number.MAX_SAFE_INTEGER + 1 }, { jobId: '777' }])('rejects unsafe path inputs %j before IO', patch => {
    expect(() => cacheEntryPath({ ...subject, ...patch }, { root })).toThrow();
  });
  it('entry of exactly 256 KiB is accepted, 256 KiB + 1 rejected', () => {
    const json = JSON.stringify(entry()); const padded = json + ' '.repeat(CACHED_VERDICT_MAX_BYTES - Buffer.byteLength(json));
    put(padded); expect(readMergeGateVerdictCache(subject, { root }).entry).toEqual(entry());
    put(padded + ' '); expect(readMergeGateVerdictCache(subject, { root })).toEqual({ reason: 'unreadable' });
  });
  it('missing file refuses as missing', () => expect(readMergeGateVerdictCache(subject, { root })).toEqual({ reason: 'missing' }));
  it('malformed JSON refuses as unreadable', () => { put('{'); expect(readMergeGateVerdictCache(subject, { root })).toEqual({ reason: 'unreadable' }); });
  it('a directory refuses as unreadable', () => { fs.mkdirSync(pathFor(), { recursive: true }); expect(readMergeGateVerdictCache(subject, { root })).toEqual({ reason: 'unreadable' }); });
  it('unreadable filesystem evidence refuses without an alternative read', () => {
    const read = vi.fn(); const io = { ...fs, statSync: () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); }, readSync: read };
    expect(readMergeGateVerdictCache(subject, { root, fs: io })).toEqual({ reason: 'unreadable' }); expect(read).not.toHaveBeenCalled();
  });
  it('a replacement larger than the initial stat is refused before reading', () => {
    put(entry()); const read = vi.fn(); const io = { ...fs, readSync: read,
      openSync: (...args) => { fs.writeFileSync(pathFor(), ' '.repeat(CACHED_VERDICT_MAX_BYTES + 1)); return fs.openSync(...args); } };
    expect(readMergeGateVerdictCache(subject, { root, fs: io })).toEqual({ reason: 'unreadable' }); expect(read).not.toHaveBeenCalled();
  });
});

describe('foreground --once writer', () => {
  it('writes atomically, logs the entry, and leaves no temporary files', async () => {
    const io = writerIo(); const out = await main(['--once', '--repo', subject.repo, '--pr', '6085', '--job', '777'], io);
    expect(out.ok).toBe(true); expect(out.path).toBe(pathFor());
    expect(fs.readdirSync(dirname(pathFor()))).toEqual(['we--6085--777.json']);
    expect(io.log).toHaveBeenCalledWith('merge-gate-verdict-cache: wrote ' + pathFor());
    expect(readMergeGateVerdictCache(subject, { root }).entry).toMatchObject({ v: 1, ...subject, headSha, labelsHead: headSha });
  });
  it('each ReadAt is taken immediately before its corresponding read', async () => {
    const io = writerIo(); await writeOnce(subject, io);
    expect(readMergeGateVerdictCache(subject, { root }).entry).toMatchObject({
      verdictReadAt: iso(NOW), labelsReadAt: iso(NOW + 1000), freezeReadAt: iso(NOW + 3000) });
  });
  it('old memoized labels cannot receive a fresh labelsReadAt', async () => {
    const io = writerIo(); fs.mkdirSync(io.env.WE_GH_READ_MEMO_DIR); const old = join(io.env.WE_GH_READ_MEMO_DIR, 'old-labels.json');
    fs.writeFileSync(old, JSON.stringify({ headRefOid: headSha, labels: [] }));
    io.readHeadAndLabels = vi.fn(() => io.env.WE_GH_READ_MEMO_DIR
      ? JSON.parse(fs.readFileSync(old, 'utf8')) : { headRefOid: headSha, labels: ['ready-to-merge'] });
    await writeOnce(subject, io);
    expect(io.env.WE_GH_READ_MEMO_DIR).toBeUndefined();
    expect(readMergeGateVerdictCache(subject, { root }).entry.labels).toEqual(['ready-to-merge']);
  });
  it('preserves the readers default routing without run, token or transport overrides', async () => {
    const io = writerIo(); await writeOnce(subject, io);
    expect(io.readVerdict).toHaveBeenCalledExactlyOnceWith({ repo: subject.repo, jobId: 777, prNumber: 6085 });
    expect(io.readHeadAndLabels).toHaveBeenCalledExactlyOnceWith({ repo: subject.repo, pr: 6085 });
    expect(io.readFreeze).toHaveBeenCalledExactlyOnceWith();
  });
  it.each(['readVerdict', 'readHeadAndLabels', 'readFreeze'])('stores %s errors as unusable evidence and names the failure', async reader => {
    const io = writerIo({ [reader]: () => { throw Error('offline'); } }); await writeOnce(subject, io);
    const e = readMergeGateVerdictCache(subject, { root }).entry;
    if (reader === 'readVerdict') expect(e.verdict.error).toBe('offline');
    if (reader === 'readHeadAndLabels') expect(e.labels).toBeNull();
    if (reader === 'readFreeze') expect(e.freeze.error).toBe('offline');
    expect(io.log.mock.calls.flat().join('\n')).toContain('offline');
  });
  it('rename failure preserves the old entry and removes the temp file', async () => {
    put(entry()); const io = writerIo({ fs: { ...fs, renameSync: () => { throw Error('rename failed'); } } });
    await expect(writeOnce(subject, io)).rejects.toThrow('rename failed');
    expect(readMergeGateVerdictCache(subject, { root }).entry).toEqual(entry());
    expect(fs.readdirSync(dirname(pathFor()))).toEqual(['we--6085--777.json']);
  });
  it('a failed temporary write never renames or replaces an entry', async () => {
    put(entry()); const rename = vi.fn(); const io = writerIo({ fs: { ...fs, renameSync: rename,
      writeFileSync: () => { throw Error('disk full'); } } });
    await expect(writeOnce(subject, io)).rejects.toThrow('disk full'); expect(rename).not.toHaveBeenCalled();
    expect(readMergeGateVerdictCache(subject, { root }).entry).toEqual(entry());
  });
  it('oversized evidence publishes nothing and names the refusal', async () => {
    const io = writerIo({ readFreeze: () => ({ error: 'x'.repeat(CACHED_VERDICT_MAX_BYTES) }) });
    await expect(writeOnce(subject, io)).rejects.toThrow('entry-too-large'); expect(fs.existsSync(pathFor())).toBe(false);
  });
  it('concurrent --once replacement: the gate reads a whole old or new entry; a rejected entry leaves rows unchanged', async () => {
    const old = entry(); put(old); const observed = [];
    const ioFor = label => writerIo({ readHeadAndLabels: () => ({ headRefOid: headSha, labels: [label] }),
      fs: { ...fs, renameSync: (...args) => {
        observed.push(readMergeGateVerdictCache(subject, { root }).entry);
        fs.renameSync(...args); observed.push(readMergeGateVerdictCache(subject, { root }).entry);
      } } });
    await Promise.all([writeOnce(subject, ioFor('old')), writeOnce(subject, ioFor('new'))]);
    expect(observed).toHaveLength(4);
    for (const e of observed) { expect(validCachedVerdict(e, { ...context, now: NOW + 10_000 }).ok).toBe(true);
      expect(e.labels).toEqual(expect.any(Array)); expect(e.labels).toSatisfy(labels => JSON.stringify([[], ['old'], ['new']]).includes(JSON.stringify(labels))); }
    const rejected = entry(); rejected.headSha = 'c'.repeat(40); put(rejected);
    expect(validCachedVerdict(readMergeGateVerdictCache(subject, { root }).entry, context).ok).toBe(false);
    expect(fs.readdirSync(dirname(pathFor()))).toEqual(['we--6085--777.json']);
  });
  it.each([[], ['--once'], ['--once', '--repo', '../', '--pr', '1', '--job', '777'],
    ['--once', '--repo', subject.repo, '--pr', '1', '--job', '777', '--watch'],
    ['--once', '--repo', subject.repo, '--pr', '1', '--pr', '2', '--job', '777']])('invalid CLI arguments refuse before readers: %j', async argv => {
    const io = writerIo(); const out = await main(argv, io); expect(out.ok).toBe(false);
    expect(io.readVerdict).not.toHaveBeenCalled(); expect(io.log.mock.calls.flat().join('\n')).toContain('refused');
  });
});

it('the file-only gate has no GitHub evidence imports, request port, grace or spawn', () => {
  // Raw imports keep these source assertions in Vitest's related-test dependency graph.
  expect(gateSource).not.toMatch(/\breadMergeGateVerdict\b(?!Cache)|\breadSharedFreeze\b|\brunGhSync\b|gh-throttle\.mjs/);
  expect(gateSource).not.toMatch(/requestMergeGateVerdict|verdictRequest|CACHED_VERDICT_GRACE|\bspawn\s*\(/);
});
it('the one-shot writer contains no GitHub write verbs or process topology', () => {
  expect(writerSource).not.toMatch(/pr[ '\",]+edit|api[^\n]+-X[ '\",]+(?:POST|PATCH|PUT|DELETE)|\bspawn\s*\(|--watch|--read/);
});
