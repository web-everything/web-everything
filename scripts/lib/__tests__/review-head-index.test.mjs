import { describe, it, expect, beforeEach } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fork } from 'node:child_process';
import { withHeadIndexLock, seedFromReviewComments, recordReview, readHeadIndex, headReviewOwed, netPatchKey, resolveHeadIndexSettings, headIndexPaths } from '../review-head-index.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rhi-')); });
const rec = (o = {}) => recordReview({ dir, repo: 'o/r', pr: 7, head: H(1), netPatchHash: 'p1', verdict: 'accept', at: '2026-11-04T10:00:00Z', keepPerPr: 20, ...o });

describe('headReviewOwed', () => {
  it('new head -> owed', () => {
    rec();
    const d = headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(2), netPatchHash: 'p2' });
    expect(d).toMatchObject({ owed: true, reason: 'new-head' });
  });
  it('same head -> not owed', () => {
    rec();
    expect(headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(1), netPatchHash: 'p1' }))
      .toMatchObject({ owed: false, reason: 'same-head' });
  });
  it('same net patch on a new head -> verdict carried, not re-reviewed', () => {
    rec({ verdict: 'reject' });
    const d = headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(2), netPatchHash: 'p1' });
    expect(d).toMatchObject({ owed: false, carried: true, verdict: 'reject', fromHead: H(1) });
  });
  it('a PR with no record is owed (never silently nothing-owed)', () => {
    expect(headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 9, head: H(1), netPatchHash: 'p1' }))
      .toMatchObject({ owed: true, reason: 'no-record' });
  });
  it('no net patch key means no carry', () => {
    rec();
    expect(headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(2), netPatchHash: null }).owed).toBe(true);
  });
  it('unreadable index -> fail closed (held as unknown, never nothing-owed)', () => {
    rec(); rec({ head: H(2), netPatchHash: 'p2' });
    const { log } = headIndexPaths(dir);
    writeFileSync(log, readFileSync(log, 'utf8') + '{not json\n');
    const index = readHeadIndex({ dir });
    expect(index.ok).toBe(false);
    expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(2), netPatchHash: 'p2' }))
      .toMatchObject({ owed: null, held: true, reason: 'index-unreadable' });
    expect(headReviewOwed({ index: undefined, repo: 'o/r', pr: 7, head: H(2) })).toMatchObject({ owed: null, held: true });
  });
});

describe('durability and growth', () => {
  it('an old record is found no matter how many other records exist (no scan cap)', () => {
    rec({ pr: 1, head: H(1) });
    for (let i = 2; i < 400; i++) rec({ pr: i, head: H(i % 9), netPatchHash: `p${i}` });
    expect(headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 1, head: H(1) }).reason).toBe('same-head');
  });
  it('atomic write order: log append fsynced before the map temp write, temp fsynced before rename', () => {
    const ops = [];
    const kind = p => (String(p).endsWith('.tmp') ? 'tmp' : String(p).endsWith('lock') ? 'lock' : 'log');
    const fs = { ...nodeFs,
      openSync: (p, f) => { ops.push(`open:${f}:${kind(p)}`); return nodeFs.openSync(p, f); },
      fsyncSync: fd => { ops.push('fsync'); return nodeFs.fsyncSync(fd); },
      renameSync: (a, b) => { ops.push('rename'); return nodeFs.renameSync(a, b); } };
    rec({ fs });
    expect(ops).toEqual(['open:wx:lock', 'fsync', 'open:a:log', 'fsync', 'open:w:tmp', 'fsync', 'rename']);
    expect(existsSync(headIndexPaths(dir).map)).toBe(true);
  });
  it('a cached map with an invalid entry is rebuilt from the log, never trusted', () => {
    rec(); rec({ head: H(2), netPatchHash: 'p2' });
    const { map: mp, log } = headIndexPaths(dir);
    const stored = JSON.parse(readFileSync(mp, 'utf8'));
    stored.map['o/r#7'] = { lastReviewedHead: H(2) };
    writeFileSync(mp, JSON.stringify({ ...stored, logBytes: nodeFs.statSync(log).size }));
    const d = headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(2) });
    expect(d).toMatchObject({ owed: false, verdict: 'accept' });
  });
  it('compaction keeps keyless reviews and the current verdict exactly', () => {
    rec({ netPatchHash: 'p1', verdict: 'accept', at: '2026-11-04T10:00:01Z', logMaxLines: 2 });
    rec({ netPatchHash: null, verdict: 'reject', at: '2026-11-04T10:00:02Z', logMaxLines: 2 });
    rec({ head: H(2), netPatchHash: null, verdict: 'accept', at: '2026-11-04T10:00:03Z', logMaxLines: 2 });
    const before = readHeadIndex({ dir }).map;
    const rebuilt = JSON.parse(JSON.stringify(before));
    writeFileSync(headIndexPaths(dir).map, '{{');
    expect(readHeadIndex({ dir }).map).toEqual(rebuilt);
    expect(headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(2) })).toMatchObject({ owed: false, verdict: 'accept' });
  });
  it('a crash between append and rename is recovered from the log, not lost', () => {
    const fs = { ...nodeFs, renameSync: () => { throw Error('crash'); } };
    expect(() => rec({ fs })).toThrow();
    const index = readHeadIndex({ dir });
    expect(index.ok).toBe(true);
    expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(1) }).reason).toBe('same-head');
  });
  it('a corrupt map is rebuilt from the log', () => {
    rec(); writeFileSync(headIndexPaths(dir).map, '{{');
    expect(headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(1) }).reason).toBe('same-head');
  });
  it('compacts history to the latest N per PR and shrinks the log', () => {
    for (let i = 1; i <= 8; i++) rec({ head: H(i), netPatchHash: `p${i}`, at: `2026-11-04T10:00:0${i}Z`, keepPerPr: 3, logMaxLines: 5 });
    const index = readHeadIndex({ dir });
    const r = index.map['o/r#7'];
    expect(Object.keys(r.history).sort()).toEqual(['p6', 'p7', 'p8']);
    expect(r.lastReviewedHead).toBe(H(8));
    expect(readFileSync(headIndexPaths(dir).log, 'utf8').trim().split('\n').length).toBeLessThanOrEqual(5);
    expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(9), netPatchHash: 'p1' }).owed).toBe(true);
  });
  it('rejects malformed records instead of writing them', () => {
    expect(() => rec({ head: 'abc' })).toThrow(/head/);
    expect(() => rec({ verdict: '' })).toThrow(/verdict/);
  });
});

describe('netPatchKey', () => {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  it('is stable for the same patch, differs for another patch and for another base', () => {
    const r = mkdtempSync(join(tmpdir(), 'rhi-git-'));
    git(r, 'init', '-q', '-b', 'main'); git(r, 'config', 'user.email', 'a@b'); git(r, 'config', 'user.name', 'a');
    writeFileSync(join(r, 'f'), 'one\n'); git(r, 'add', '.'); git(r, 'commit', '-qm', 'base');
    git(r, 'checkout', '-qb', 'x'); writeFileSync(join(r, 'g'), 'new\n'); git(r, 'add', '.'); git(r, 'commit', '-qm', 'a');
    const a = git(r, 'rev-parse', 'HEAD');
    writeFileSync(join(r, 'g'), 'new\n'); git(r, 'commit', '-qm', 'noop', '--allow-empty');
    const a2 = git(r, 'rev-parse', 'HEAD');
    writeFileSync(join(r, 'g'), 'other\n'); git(r, 'commit', '-qam', 'b'); const b = git(r, 'rev-parse', 'HEAD');
    const k = sha => netPatchKey({ exec: execFileSync, cwd: r, sha, mainRef: 'main' });
    expect(k(a).ok).toBe(true);
    expect(k(a).key).toBe(k(a2).key);
    expect(k(b).key).not.toBe(k(a).key);
    // same patch, new base: a rebase must not look like the same patch
    git(r, 'checkout', '-q', 'main'); writeFileSync(join(r, 'f'), 'two\n'); git(r, 'commit', '-qam', 'main moves');
    git(r, 'checkout', '-q', 'x'); git(r, 'checkout', '-qb', 'y', 'main'); writeFileSync(join(r, 'g'), 'new\n'); git(r, 'add', '.'); git(r, 'commit', '-qm', 'a again');
    expect(k(git(r, 'rev-parse', 'HEAD')).key).not.toBe(k(a).key);
    rmSync(r, { recursive: true, force: true });
  });
  it('fails closed (no key) on a bad sha or unreadable repo', () => {
    expect(netPatchKey({ exec: () => { throw Error('boom'); }, cwd: '.', sha: H(1) })).toMatchObject({ ok: false });
    expect(netPatchKey({ exec: () => '', cwd: '.', sha: 'nope' })).toMatchObject({ ok: false });
  });
});

describe('resolveHeadIndexSettings', () => {
  it('cascades standard -> tool with a source, and ignores invalid values', () => {
    expect(resolveHeadIndexSettings({ file: {}, platform: {}, env: {} }).value.keepPerPr).toBe(20);
    expect(resolveHeadIndexSettings({ file: { reviewHeadIndex: { keepPerPr: 5 } }, platform: {}, env: {} }).value.keepPerPr).toBe(5);
    expect(resolveHeadIndexSettings({ file: { reviewHeadIndex: { keepPerPr: -1 } }, platform: {}, env: {} }).value.keepPerPr).toBe(20);
  });
});

describe('lock, version and pre-index seeding', () => {
  it('concurrent writers (separate processes) lose no record and leave a map equal to the log', async () => {
    const mod = pathToFileURL(join(process.cwd(), 'scripts/lib/review-head-index.mjs')).href;
    const script = join(dir, 'w.mjs');
    writeFileSync(script, `import { recordReview } from ${JSON.stringify(mod)};
const [d, i] = process.argv.slice(2);
for (let n = 0; n < 6; n++) recordReview({ dir: d, repo: 'o/r', pr: 7, head: String(Number(i) + 1).repeat(40).slice(0, 40), netPatchHash: 'p' + i + '-' + n, verdict: n % 2 ? 'reject' : 'accept', at: new Date(Date.UTC(2026, 10, 4, 10, Number(i), n)).toISOString(), keepPerPr: 100 });
`);
    const run = i => new Promise((res, rej) => { const c = fork(script, [dir, String(i)]); c.on('exit', code => (code === 0 ? res() : rej(Error(`writer ${i} exit ${code}`)))); });
    await Promise.all([0, 1, 2, 3].map(run));
    const fromMap = readHeadIndex({ dir });
    const lines = readFileSync(headIndexPaths(dir).log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(24);
    expect(Object.keys(fromMap.map['o/r#7'].history)).toHaveLength(24);
    writeFileSync(headIndexPaths(dir).map, '{{');
    expect(readHeadIndex({ dir }).map).toEqual(fromMap.map);
  }, 60000);
  it('a stale lock (dead owner or old) is taken over; a live fresh lock blocks until timeout', () => {
    const { lock } = headIndexPaths(dir);
    nodeFs.mkdirSync(dir, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999999, token: 't', at: 0 }));
    expect(withHeadIndexLock(dir, () => 'ok')).toBe('ok');
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 't', at: Date.now() }));
    expect(() => withHeadIndexLock(dir, () => 'no', { waitMs: 60 })).toThrow(/lock busy/);
    expect(existsSync(lock)).toBe(true);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 't', at: 0 }));
    expect(withHeadIndexLock(dir, () => 'old', { staleMs: -1 })).toBe('old');
  });
  it('releases the lock when the transaction throws', () => {
    const fs = { ...nodeFs, renameSync: () => { throw Error('crash'); } };
    expect(() => rec({ fs })).toThrow();
    expect(existsSync(headIndexPaths(dir).lock)).toBe(false);
  });
  it('a map older than the log (or an unversioned map) is rejected and rebuilt', () => {
    rec(); const { map: mp } = headIndexPaths(dir);
    const stored = JSON.parse(readFileSync(mp, 'utf8'));
    const stale = JSON.stringify({ ...stored, map: {} });
    rec({ head: H(2), netPatchHash: 'p2', verdict: 'reject', at: '2026-11-04T10:05:00Z' });
    writeFileSync(mp, stale); // a stale map left by a lost race, with an old log size
    expect(headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(2) })).toMatchObject({ owed: false, verdict: 'reject' });
    writeFileSync(mp, JSON.stringify({ logBytes: nodeFs.statSync(headIndexPaths(dir).log).size, map: {} }));
    expect(readHeadIndex({ dir }).rebuilt).toBe(true);
  });
  it('pre-index PR: seeds from the latest reviewed-sha marker; no marker or unreadable is never nothing-owed', () => {
    const idx = readHeadIndex({ dir });
    const comments = [{ viewerDidAuthor: true, body: `verdict\n<!-- reviewed-sha: ${H(3)} -->` }];
    const seed = seedFromReviewComments(comments);
    const base = { index: idx, repo: 'o/r', pr: 5 };
    expect(seed).not.toBeNull();
    expect(headReviewOwed({ ...base, head: H(3), seed })).toMatchObject({ owed: false, seeded: true });
    expect(headReviewOwed({ ...base, head: H(4), seed })).toMatchObject({ owed: true, reason: 'new-head', seeded: true });
    expect(seedFromReviewComments([{ author: { login: 'rando' }, body: comments[0].body }])).toBeNull();
    expect(seedFromReviewComments([])).toBeNull();
    expect(headReviewOwed({ ...base, head: H(3), seed: null }).owed).toBe(true);
    expect(headReviewOwed({ index: { ok: false }, repo: 'o/r', pr: 5, head: H(3), seed })).toMatchObject({ owed: null, held: true });
  });
});
