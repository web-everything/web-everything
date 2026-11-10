import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { seedFromReviewComments, recordReview, readHeadIndex, headReviewOwed, netPatchKey, resolveHeadIndexSettings, headIndexPaths, defaultHeadIndexDir } from '../review-head-index.mjs';
import { COORDINATION_ROOT_ENV } from '../../operations/coordination-root.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rhi-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
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
  it('a non-string head or seed head (array/object that SHA.test would coerce) is held, never carried or suppressed', () => {
    rec({ verdict: 'reject' });
    const index = readHeadIndex({ dir });
    // [H(2)] stringifies to a valid sha: it must not read as a new head carrying p1's verdict, nor as a same-head match
    for (const head of [[H(2)], [H(1)], { toString: () => H(2) }, new String(H(2))]) {
      expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head, netPatchHash: 'p1' }))
        .toMatchObject({ owed: null, held: true, reason: 'head-unreadable' });
    }
    // an array-valued seed head (pre-index PR) is not a seed: the review stays owed
    const empty = readHeadIndex({ dir: join(dir, 'empty') });
    for (const lastReviewedHead of [[H(2)], new String(H(2))]) {
      expect(headReviewOwed({ index: empty, repo: 'o/r', pr: 9, head: H(2), seed: { lastReviewedHead, verdict: 'marker' } }))
        .toMatchObject({ owed: true, reason: 'no-record' });
    }
    // netPatchKey refuses a non-string sha before running git
    const exec = vi.fn();
    expect(netPatchKey({ exec, cwd: dir, sha: [H(2)] })).toMatchObject({ ok: false });
    expect(exec).not.toHaveBeenCalled();
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
  it('a net-patch key that names an inherited property is never carried: __proto__, constructor, toString, hasOwnProperty -> owed', () => {
    rec();
    const index = readHeadIndex({ dir });
    for (const netPatchHash of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])
      expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(2), netPatchHash }), netPatchHash).toMatchObject({ owed: true, reason: 'new-head' });
    // a PR key that names an inherited property is no record either
    expect(headReviewOwed({ index, repo: 'constructor', pr: 7, head: H(2) })).toMatchObject({ owed: true, reason: 'no-record' });
  });
  it('a net-patch key that would set the history prototype is refused on write and fails closed on replay', () => {
    for (const bad of ['__proto__', '', ' x', 'a'.repeat(129), 'a b', 5, {}]) {
      expect(() => rec({ netPatchHash: bad }), String(bad)).toThrow(/invalid record/);
    }
    expect(existsSync(headIndexPaths(dir).log)).toBe(false);
    rec();
    const { log } = headIndexPaths(dir);
    writeFileSync(log, readFileSync(log, 'utf8') + `${JSON.stringify({ repo: 'o/r', pr: 7, head: H(2), netPatchHash: '__proto__', verdict: 'accept', at: '2026-11-04T10:00:01Z' })}\n`);
    expect(readHeadIndex({ dir }).ok).toBe(false);
  });
  it('a netPatchHash in the keyless namespace ("head:<sha>") is rejected by the validator and never stored', () => {
    for (const bad of [`head:${H(1)}`, 'head:abc', 'head:']) {
      expect(() => rec({ netPatchHash: bad }), bad).toThrow(/invalid record/);
    }
    expect(existsSync(headIndexPaths(dir).log)).toBe(false);
    // a hand-written log row carrying such a key is refused on replay (fails closed), never folded into history
    rec();
    const { log } = headIndexPaths(dir);
    writeFileSync(log, readFileSync(log, 'utf8') + `${JSON.stringify({ repo: 'o/r', pr: 7, head: H(2), netPatchHash: `head:${H(1)}`, verdict: 'accept', at: '2026-11-04T10:00:01Z' })}\n`);
    expect(readHeadIndex({ dir }).ok).toBe(false);
  });
  it('a keyless review (netPatchHash null) is never carried to a later head and survives compaction as keyless', () => {
    rec({ head: H(1), netPatchHash: null, verdict: 'accept', at: '2026-11-04T10:00:01Z', logMaxLines: 2 });
    rec({ head: H(2), netPatchHash: 'p2', verdict: 'reject', at: '2026-11-04T10:00:02Z', logMaxLines: 2 });
    rec({ head: H(3), netPatchHash: 'p3', verdict: 'reject', at: '2026-11-04T10:00:03Z', logMaxLines: 2 }); // 3 rows > 2: compacts
    const index = readHeadIndex({ dir });
    // the keyless head-1 review is still held after compaction, under the keyless key, with no patch key
    expect(index.map['o/r#7'].history[`head:${H(1)}`]).toMatchObject({ head: H(1), verdict: 'accept' });
    const rows = readFileSync(headIndexPaths(dir).log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows.find(r => r.head === H(1))).toMatchObject({ netPatchHash: null });
    // never carried: neither a null key nor the keyless key string carries it to a later head
    for (const netPatchHash of [null, undefined, `head:${H(1)}`])
      expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(4), netPatchHash }), String(netPatchHash)).toMatchObject({ owed: true, reason: 'new-head' });
  });
  it('the latest verdict for a head supersedes its earlier entries under any key: a later keyless reject never leaves the keyed accept carryable', () => {
    rec({ head: H(1), netPatchHash: 'p1', verdict: 'accept', at: '2026-11-04T10:00:01Z' });
    rec({ head: H(1), netPatchHash: null, verdict: 'reject', at: '2026-11-04T10:00:02Z' });
    const check = index => {
      expect(Object.keys(index.map['o/r#7'].history)).toEqual([`head:${H(1)}`]); // one entry per head, the latest
      expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(1) })).toMatchObject({ owed: false, reason: 'same-head', verdict: 'reject' });
      const later = headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(2), netPatchHash: 'p1' });
      expect(later).toMatchObject({ owed: true, reason: 'new-head' });
      expect(later.carried).toBeUndefined();
    };
    check(readHeadIndex({ dir }));
    // log-replay variant: the cached map is gone, so the index is rebuilt from the log rows alone
    writeFileSync(headIndexPaths(dir).map, '{{');
    check(readHeadIndex({ dir }));
  });
  it('a later keyed record for a head supersedes its earlier keyless entry, and survives compaction and replay', () => {
    rec({ head: H(1), netPatchHash: null, verdict: 'reject', at: '2026-11-04T10:00:01Z', logMaxLines: 2 });
    rec({ head: H(1), netPatchHash: 'p1', verdict: 'accept', at: '2026-11-04T10:00:02Z', logMaxLines: 2 });
    rec({ head: H(2), netPatchHash: 'p2', verdict: 'accept', at: '2026-11-04T10:00:03Z', logMaxLines: 2 }); // 3 rows > 2: compacts
    writeFileSync(headIndexPaths(dir).map, '{{');
    const index = readHeadIndex({ dir });
    expect(Object.keys(index.map['o/r#7'].history).sort()).toEqual(['p1', 'p2']);
    expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(3), netPatchHash: 'p1' })).toMatchObject({ owed: false, carried: true, verdict: 'accept', fromHead: H(1) });
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
  it('a cached map whose entry fields are arrays (coerced by the sha regex) is rejected and rebuilt, never carried', () => {
    rec(); // log: H(1) / p1 / accept
    const { map: mp, log } = headIndexPaths(dir);
    const stored = JSON.parse(readFileSync(mp, 'utf8'));
    const shapes = {
      'history head as array': m => { m['o/r#7'].history.p1.head = [H(1)]; },
      'lastReviewedHead as array': m => { m['o/r#7'].lastReviewedHead = [H(1)]; },
      'history at as array': m => { m['o/r#7'].history.p1.at = [m['o/r#7'].history.p1.at]; },
      'entry at as array': m => { m['o/r#7'].at = [m['o/r#7'].at]; },
    };
    for (const [name, mutate] of Object.entries(shapes)) {
      const bad = JSON.parse(JSON.stringify(stored));
      mutate(bad.map);
      writeFileSync(mp, JSON.stringify({ ...bad, logHash: stored.logHash })); // matching logHash: only validation can reject it
      expect(nodeFs.statSync(log).size, name).toBeGreaterThan(0);
      const index = readHeadIndex({ dir });
      expect(index.rebuilt, name).toBe(true);
      expect(index.map['o/r#7'].lastReviewedHead, name).toBe(H(1));
      const d = headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(2), netPatchHash: 'p1' });
      expect(typeof d.fromHead, name).toBe('string'); // a rebuilt (string) head, never the array
      expect(d.fromHead, name).toBe(H(1));
    }
    // the array-head map is never served: with the cache mutated, the carry decision comes from the log's string head
    const bad = JSON.parse(JSON.stringify(stored));
    bad.map['o/r#7'].history.p1.head = [H(1)];
    writeFileSync(mp, JSON.stringify({ ...bad, logHash: stored.logHash }));
    expect(readHeadIndex({ dir }).map['o/r#7'].history.p1.head).toBe(H(1));
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

describe('defaultHeadIndexDir', () => {
  it('is a sibling of the coordination root: the default root and an overridden root both place it beside, never inside, the root', () => {
    expect(defaultHeadIndexDir({})).toBe(join(homedir(), 'workspace', '.operations', 'review-head-index'));
    expect(defaultHeadIndexDir({ [COORDINATION_ROOT_ENV]: '/a/b/coordination' })).toBe(join('/a/b', 'review-head-index'));
    expect(defaultHeadIndexDir({ [COORDINATION_ROOT_ENV]: '  /x/y/root  ' })).toBe(join('/x/y', 'review-head-index')); // trimmed like the root itself
    expect(defaultHeadIndexDir({ [COORDINATION_ROOT_ENV]: '/a/b/coordination' })).not.toContain(join('coordination', 'review-head-index'));
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
  it('patches that differ only in invalid UTF-8 bytes get different keys (the diff is hashed as raw bytes)', () => {
    const r = mkdtempSync(join(tmpdir(), 'rhi-git-'));
    git(r, 'init', '-q', '-b', 'main'); git(r, 'config', 'user.email', 'a@b'); git(r, 'config', 'user.name', 'a');
    writeFileSync(join(r, 'f'), 'one\n'); git(r, 'add', '.'); git(r, 'commit', '-qm', 'base');
    const variant = (branch, byte) => {
      git(r, 'checkout', '-q', 'main'); git(r, 'checkout', '-qb', branch);
      writeFileSync(join(r, 'g'), Buffer.from([0x61, byte, 0x62, 0x0a])); // no NUL: git diffs it as text; 0xff/0xfe are invalid UTF-8
      git(r, 'add', '.'); git(r, 'commit', '-qm', branch);
      return git(r, 'rev-parse', 'HEAD');
    };
    const [a, b] = [variant('bin-a', 0xff), variant('bin-b', 0xfe)];
    const k = sha => netPatchKey({ exec: execFileSync, cwd: r, sha, mainRef: 'main' });
    expect(k(a).ok && k(b).ok).toBe(true);
    expect(k(a).key).not.toBe(k(b).key);
    expect(k(a).key).toBe(k(a).key);                              // still deterministic
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
  it('settings preserve standard < platform < tool precedence for both fields and report each source', () => {
    const r = resolveHeadIndexSettings({ file: { reviewHeadIndex: { keepPerPr: 5 } }, platform: { keepPerPr: 7, logMaxLines: 70 }, env: {} });
    expect(r.value).toEqual({ keepPerPr: 5, logMaxLines: 70 });
    expect(r.sources).toMatchObject({ keepPerPr: 'tool', logMaxLines: 'platform' });
    const std = resolveHeadIndexSettings({ file: {}, platform: {}, env: {} });
    expect(std.value).toEqual({ keepPerPr: 20, logMaxLines: 2000 });
    expect(std.sources).toMatchObject({ keepPerPr: 'standard', logMaxLines: 'standard' });
    const bad = resolveHeadIndexSettings({ file: { reviewHeadIndex: { logMaxLines: 0 } }, platform: {}, env: {} });
    expect(bad.value.logMaxLines).toBe(2000);
  });
  it('settings ignore environment overrides', () => {
    // Whatever name an override might use, every env key reads back '3': none may change either field.
    const env = new Proxy({}, { get: () => '3', has: () => true, ownKeys: () => [] });
    const r = resolveHeadIndexSettings({ file: { reviewHeadIndex: { keepPerPr: 5, logMaxLines: 50 } }, platform: {}, env });
    expect(r.value).toEqual({ keepPerPr: 5, logMaxLines: 50 });
    expect(Object.values(r.sources)).not.toContain('env');
    expect(resolveHeadIndexSettings({ file: {}, platform: {}, env }).value).toEqual({ keepPerPr: 20, logMaxLines: 2000 });
  });
  it('the shipped settings file parses, declares reviewHeadIndex, and resolves to valid settings', () => {
    const shipped = JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'settings', 'review-head-index.json'), 'utf8'));
    expect(shipped).toHaveProperty('reviewHeadIndex');
    const r = resolveHeadIndexSettings({ file: shipped, platform: {}, env: {} });
    expect(r.invalid).toEqual([]);
    expect(Number.isSafeInteger(r.value.keepPerPr) && r.value.keepPerPr > 0).toBe(true);
    expect(Number.isSafeInteger(r.value.logMaxLines) && r.value.logMaxLines > 0).toBe(true);
  });
});

describe('version and pre-index seeding', () => {
  it('a short fs.writeSync is completed, never renamed half-written into the log', () => {
    const shortFs = { ...nodeFs, writeSync: (fd, buf, off, len, ...r) => typeof buf === 'string' ? nodeFs.writeSync(fd, buf.slice(0, 5)) : nodeFs.writeSync(fd, buf, off, Math.min(7, len), ...r) };
    rec({ fs: shortFs });
    const text = readFileSync(headIndexPaths(dir).log, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(text.trim())).not.toThrow();
    expect(readHeadIndex({ dir }).ok).toBe(true);
  });
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
    // no write lost (24 log rows); history keeps ONE entry per head, the latest (each writer's n=5 record), since a head's latest verdict supersedes its earlier ones
    expect(Object.keys(fromMap.map['o/r#7'].history).sort()).toEqual(['p0-5', 'p1-5', 'p2-5', 'p3-5']);
    writeFileSync(headIndexPaths(dir).map, '{{');
    expect(readHeadIndex({ dir, keepPerPr: 100 }).map).toEqual(fromMap.map); // the writers' keepPerPr: replay applies the same bound
  }, 60000);
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
    writeFileSync(mp, JSON.stringify({ version: 2, logHash: 'bad', map: {} }));
    expect(readHeadIndex({ dir }).rebuilt).toBe(true);
  });
  it('a same-size corrupted log is never served from the cache; an unreadable log fails closed', () => {
    rec({ verdict: 'accept' });
    const { log } = headIndexPaths(dir);
    const before = nodeFs.statSync(log).size;
    writeFileSync(log, readFileSync(log, 'utf8').replace('"accept"', '"xxxxxx"'.slice(0, 8)));
    expect(nodeFs.statSync(log).size).toBe(before);
    expect(readHeadIndex({ dir }).ok).toBe(true); // rebuilt from the log text, not the stale cache
    expect(readHeadIndex({ dir }).map['o/r#7'].verdict).toBe('xxxxxx');
    rmSync(log); nodeFs.mkdirSync(log); // unreadable: stat works, read throws
    expect(headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(1) })).toMatchObject({ owed: null, held: true });
  });
  it('the cache digest covers raw log bytes: a log whose invalid bytes decode to the same text is not served from the cache', () => {
    rec({ verdict: 'ok�x' });                               // valid UTF-8: EF BF BD
    const { log } = headIndexPaths(dir);
    expect(readHeadIndex({ dir }).rebuilt).toBeUndefined();      // served from the cache
    const bytes = nodeFs.readFileSync(log);
    const at = bytes.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    writeFileSync(log, Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)])); // 0xFF also decodes to U+FFFD
    expect(Buffer.from(nodeFs.readFileSync(log, 'utf8')).equals(bytes)).toBe(true); // identical decoded text, different bytes
    expect(readHeadIndex({ dir }).rebuilt).toBe(true);           // so the cache must not be trusted
  });
  it('a compaction triggered by a write keeps the writer row last and replays to the published map across PRs and keyless records', () => {
    const base = { keepPerPr: 5, logMaxLines: 4 };
    rec({ ...base, head: H(1), netPatchHash: 'p1', at: '2026-11-04T10:00:01Z' });
    rec({ ...base, pr: 8, head: H(2), netPatchHash: 'q1', at: '2026-11-04T10:00:02Z' });
    rec({ ...base, head: H(3), netPatchHash: null, at: '2026-11-04T10:00:03Z' });
    rec({ ...base, pr: 8, head: H(4), netPatchHash: 'q1', at: '2026-11-04T10:00:04Z' }); // same patch again
    const r = rec({ ...base, head: H(5), netPatchHash: 'p2', at: '2026-11-04T10:00:05Z' }); // 5 rows > 4: compacts
    const { log, map: mp } = headIndexPaths(dir);
    const rows = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(r.lines).toBe(rows.length);
    expect(rows.length).toBeLessThan(5);
    expect(rows[rows.length - 1]).toMatchObject({ pr: 7, head: H(5), netPatchHash: 'p2' }); // the writer's own row stays last
    const published = JSON.parse(readFileSync(mp, 'utf8')).map;
    writeFileSync(mp, '{{');
    expect(readHeadIndex({ dir, keepPerPr: 5 }).map).toEqual(published);
    expect(published['o/r#8'].history.q1.head).toBe(H(4));
    expect(published['o/r#7'].lastReviewedHead).toBe(H(5));
  });
  it('rebuild from an uncompacted log honors keepPerPr: evicted history is not resurrected and the map equals the published one', () => {
    for (let i = 1; i <= 6; i++) rec({ head: H(i), netPatchHash: `p${i}`, at: `2026-11-04T10:00:0${i}Z`, keepPerPr: 3 });
    const { map: mp } = headIndexPaths(dir);
    const published = JSON.parse(readFileSync(mp, 'utf8')).map;
    expect(Object.keys(published['o/r#7'].history).sort()).toEqual(['p4', 'p5', 'p6']);
    writeFileSync(mp, '{{');                                   // the cache is lost: the reader rebuilds from the log
    const rebuilt = readHeadIndex({ dir, keepPerPr: 3 });      // an unreadable cache carries no keepPerPr: the caller's (settings) value applies
    expect(rebuilt.rebuilt).toBe(true);
    expect(Object.keys(rebuilt.map['o/r#7'].history).sort()).toEqual(['p4', 'p5', 'p6']);
    expect(rebuilt.map).toEqual(published);
    expect(headReviewOwed({ index: rebuilt, repo: 'o/r', pr: 7, head: H(9), netPatchHash: 'p1' }).owed).toBe(true); // p1 stays evicted
    // a stale map (crash between append and rename) still carries the writer's keepPerPr for the rebuild
    writeFileSync(mp, JSON.stringify({ version: 2, logHash: 'stale', keepPerPr: 3, map: {} }));
    expect(readHeadIndex({ dir }).map).toEqual(published);
  });
  it('keyless current record: replay of a compacted log equals the published map and stays within retained history', () => {
    // out-of-order timestamps: the keyless CURRENT record (latest written) is the oldest by `at`, so keepPerPr evicts its history entry
    const base = { keepPerPr: 2, logMaxLines: 3 };
    rec({ ...base, head: H(1), netPatchHash: 'p1', at: '2026-11-04T10:00:05Z' });
    rec({ ...base, head: H(2), netPatchHash: 'p2', at: '2026-11-04T10:00:06Z' });
    rec({ ...base, head: H(3), netPatchHash: 'p3', at: '2026-11-04T10:00:07Z' });
    rec({ ...base, head: H(4), netPatchHash: null, at: '2026-11-04T10:00:01Z' }); // keyless, oldest, current -> compacts
    const { map: mp, log } = headIndexPaths(dir);
    const published = JSON.parse(readFileSync(mp, 'utf8')).map;
    expect(published['o/r#7']).toMatchObject({ lastReviewedHead: H(4), netPatchHash: null });
    expect(Object.keys(published['o/r#7'].history).length).toBeLessThanOrEqual(2);
    expect(readFileSync(log, 'utf8').trim().split('\n').length).toBeLessThanOrEqual(3); // it did compact
    writeFileSync(mp, '{{');
    const rebuilt = readHeadIndex({ dir, keepPerPr: 2 });
    expect(rebuilt.rebuilt).toBe(true);
    expect(rebuilt.map).toEqual(published);
    expect(Object.keys(rebuilt.map['o/r#7'].history).length).toBeLessThanOrEqual(2);
    // and a keyless current that is NOT evicted replays exactly too
    rec({ ...base, head: H(5), netPatchHash: null, at: '2026-11-04T10:00:09Z' });
    const published2 = JSON.parse(readFileSync(mp, 'utf8')).map;
    writeFileSync(mp, '{{');
    expect(readHeadIndex({ dir, keepPerPr: 2 }).map).toEqual(published2);
  });
  it('stat failures fail closed: a non-ENOENT stat error on the map (log missing) or on the log is an error, never an empty index', () => {
    const { log, map: mp } = headIndexPaths(dir);
    nodeFs.mkdirSync(dir, { recursive: true });
    const eacces = () => Object.assign(Error('EACCES'), { code: 'EACCES' });
    const statFail = target => ({ ...nodeFs, statSync: (p, ...a) => { if (p === target) throw eacces(); return nodeFs.statSync(p, ...a); } });
    expect(readHeadIndex({ dir })).toEqual({ ok: true, map: {} });                          // genuinely absent: empty
    writeFileSync(mp, JSON.stringify({ version: 2, logHash: 'x', map: {} }));
    expect(readHeadIndex({ dir })).toMatchObject({ ok: false });                           // map without a log: not a state we write
    rmSync(mp);
    expect(readHeadIndex({ dir, fs: statFail(mp) })).toMatchObject({ ok: false, reason: 'index-unreadable' }); // log absent, map stat EACCES
    expect(headReviewOwed({ index: readHeadIndex({ dir, fs: statFail(mp) }), repo: 'o/r', pr: 7, head: H(1) })).toMatchObject({ owed: null, held: true });
    expect(readHeadIndex({ dir, fs: statFail(log) })).toMatchObject({ ok: false });        // log stat EACCES
    expect(() => rec({ fs: statFail(mp) })).toThrow(/unreadable/);                          // and a write refuses
    expect(existsSync(log)).toBe(false);
  });
  it('rebuild honors the RESOLVED retention setting (value.keepPerPr), not the standard 20', () => {
    for (let i = 1; i <= 6; i++) rec({ head: H(i), netPatchHash: `p${i}`, at: `2026-11-04T10:00:0${i}Z`, keepPerPr: 6 });
    const { map: mp } = headIndexPaths(dir);
    writeFileSync(mp, '{{');                                   // no cache and no stored keepPerPr: the resolved setting decides
    const settingsFile = { reviewHeadIndex: { keepPerPr: 3 } };
    expect(resolveHeadIndexSettings({ file: settingsFile }).value.keepPerPr).toBe(3);
    const rebuilt = readHeadIndex({ dir, settingsFile });
    expect(rebuilt.rebuilt).toBe(true);
    expect(Object.keys(rebuilt.map['o/r#7'].history).sort()).toEqual(['p4', 'p5', 'p6']); // 3 kept, not 6 (standard would keep all 6)
  });
  it('log rows must carry string head and at (an array or a number is not coerced into a valid record)', () => {
    nodeFs.mkdirSync(dir, { recursive: true });
    const row = { repo: 'o/r', pr: 7, head: H(1), netPatchHash: 'p1', verdict: 'accept', at: '2026-11-04T10:00:00Z' };
    for (const bad of [{ ...row, head: [H(1)] }, { ...row, at: 1793890331573 }]) {
      writeFileSync(headIndexPaths(dir).log, `${JSON.stringify(bad)}\n`);
      expect(readHeadIndex({ dir })).toMatchObject({ ok: false, reason: 'index-unreadable' });
    }
  });
  it('pr must be a positive integer: null, empty, zero, boolean and non-numeric values are rejected on write and fail closed on replay', () => {
    for (const pr of [null, undefined, '', 0, -3, true, 'x', '7.5', 1.5]) expect(() => rec({ pr })).toThrow(/invalid record/);
    expect(existsSync(headIndexPaths(dir).log)).toBe(false);
    expect(rec({ pr: '12' })).toMatchObject({ ok: true });         // a decimal string is still accepted and stored as the number
    expect(readHeadIndex({ dir }).map['o/r#12']).toBeDefined();
    for (const pr of [null, '7', true]) {                           // a corrupt log row is never coerced into a PR number
      writeFileSync(headIndexPaths(dir).log, `${JSON.stringify({ repo: 'o/r', pr, head: H(1), netPatchHash: 'p1', verdict: 'accept', at: '2026-11-04T10:00:00Z' })}\n`);
      writeFileSync(headIndexPaths(dir).map, '{{');
      expect(readHeadIndex({ dir })).toMatchObject({ ok: false, reason: 'index-unreadable' });
    }
  });
  it('headReviewOwed fails closed on a missing or malformed head', () => {
    rec();
    const index = readHeadIndex({ dir });
    for (const head of [undefined, null, '', 'abc', 'A'.repeat(40), `${H(1)}0`]) {
      expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head, netPatchHash: 'p1' })).toEqual({ owed: null, held: true, reason: 'head-unreadable' });
    }
    expect(headReviewOwed({ index, repo: 'o/r', pr: 7, head: H(1), netPatchHash: 'p1', seed: { lastReviewedHead: 'not-a-sha', verdict: 'marker' } }).owed).toBe(false); // a recorded PR ignores the seed
    expect(headReviewOwed({ index: readHeadIndex({ dir: join(dir, 'none') }), repo: 'o/r', pr: 99, head: H(1), seed: { lastReviewedHead: 'not-a-sha', verdict: 'marker' } })).toMatchObject({ owed: true, reason: 'no-record' });
  });
  it('recordReview refuses an unreadable existing index and leaves the log and map bytes unchanged', () => {
    rec();
    const { log, map } = headIndexPaths(dir);
    writeFileSync(log, readFileSync(log, 'utf8') + '{not json\n');
    const [logBefore, mapBefore] = [readFileSync(log, 'utf8'), readFileSync(map, 'utf8')];
    expect(() => rec({ head: H(2), netPatchHash: 'p2' })).toThrow(/unreadable/);
    expect(readFileSync(log, 'utf8')).toBe(logBefore);
    expect(readFileSync(map, 'utf8')).toBe(mapBefore);
  });
  it('pre-index PR: a one-line changes-requested comment with no trailing newline withdraws an earlier accept', () => {
    const A = '1'.repeat(40);
    const accept = { viewerDidAuthor: true, body: `✅ review — accepted\n\n<!-- reviewed-sha: ${A} -->\n` };
    const idx = readHeadIndex({ dir });
    for (const body of ['review — changes requested', '🔁 review — changes requested', 'human review — changes requested\r\n', 'review — changes requested\n']) {
      const seed = seedFromReviewComments([accept, { viewerDidAuthor: true, body }]);
      expect(seed, body).toBeNull();
      expect(headReviewOwed({ index: idx, repo: 'o/r', pr: 5, head: A, seed }).owed, body).toBe(true);
    }
    expect(seedFromReviewComments([accept])?.lastReviewedHead).toBe(A);
  });
  it('pre-index PR: a reviewed-sha marker inside pre/code/script/style/textarea is example text and never replaces the reviewed head', () => {
    const [A, B] = ['1'.repeat(40), '2'.repeat(40)];
    const mk = body => [{ viewerDidAuthor: true, body }];
    const m = s => `<!-- reviewed-sha: ${s} -->`;
    const head = `✅ review — accepted\n\n${m(A)}\n`;
    const idx = readHeadIndex({ dir });
    for (const tag of ['pre', 'code', 'PRE', 'script', 'style', 'textarea']) {
      const seed = seedFromReviewComments(mk(`${head}<${tag}>\n${m(B)}\n</${tag}>\n`));
      expect(seed?.lastReviewedHead, tag).toBe(A);
      expect(headReviewOwed({ index: idx, repo: 'o/r', pr: 5, head: B, seed }).owed, tag).toBe(true);
    }
    expect(seedFromReviewComments(mk(`${head}<pre>${m(B)}</pre>\n`))?.lastReviewedHead).toBe(A);
    expect(seedFromReviewComments(mk(`${head}<code>${m(B)}</code>\n`))?.lastReviewedHead).toBe(A);
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n<pre>\n${m(B)}\n</pre>\n`))).toBeNull();
    // a tag that merely starts with the name is not a container
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n<prefix>\n${m(A)}\n`))?.lastReviewedHead).toBe(A);
  });
  it('pre-index PR: a mismatched closing tag never closes another container, so a quoted marker cannot suppress review', () => {
    const [A, B] = ['1'.repeat(40), '2'.repeat(40)];
    const mk = body => [{ viewerDidAuthor: true, body }];
    const m = s => `<!-- reviewed-sha: ${s} -->`;
    const head = `✅ review — accepted\n\n${m(A)}\n`;
    const idx = readHeadIndex({ dir });
    // red-team input: </code> inside an open <pre> must not close it
    const seed = seedFromReviewComments(mk(`${head}<pre>\n</code>\n${m(B)}\n</pre>\n`));
    expect(seed?.lastReviewedHead).toBe(A);
    expect(headReviewOwed({ index: idx, repo: 'o/r', pr: 5, head: B, seed }).owed).toBe(true);
    for (const [o, c] of [['pre', 'blockquote'], ['blockquote', 'pre'], ['script', 'style'], ['textarea', 'code']]) {
      expect(seedFromReviewComments(mk(`${head}<${o}>\n</${c}>\n${m(B)}\n</${o}>\n`))?.lastReviewedHead, `${o}/${c}`).toBe(A);
    }
    // closing the outer element after an unmatched closer still ends the quote
    expect(seedFromReviewComments(mk(`${head}<pre>\n</code>\n</pre>\n${m(B)}\n`))?.lastReviewedHead).toBe(B);
    // a nested pair closes in order
    expect(seedFromReviewComments(mk(`${head}<pre><code>\nx\n</code></pre>\n${m(B)}\n`))?.lastReviewedHead).toBe(B);
  });
  it('pre-index PR: a reviewed-sha marker inside an HTML blockquote is quoted text and never seeds the head', () => {
    const [A, B] = ['1'.repeat(40), '2'.repeat(40)];
    const mk = body => [{ viewerDidAuthor: true, body }];
    const m = s => `<!-- reviewed-sha: ${s} -->`;
    const head = `✅ review — accepted\n\nRecorded by bot.\n`;
    const idx = readHeadIndex({ dir });
    // exact operator repro: A outside, B inside <blockquote>
    const body = `${head}${m(A)}\n<blockquote>\n${m(B)}\n</blockquote>\n`;
    const seed = seedFromReviewComments(mk(body));
    expect(seed?.lastReviewedHead).toBe(A);
    expect(headReviewOwed({ index: idx, repo: 'o/r', pr: 5, head: B, seed: null }).owed).toBe(true);
    expect(headReviewOwed({ index: idx, repo: 'o/r', pr: 5, head: B, seed })).toMatchObject({ owed: true, reason: 'new-head', lastReviewedHead: A });
    // B only inside a blockquote: no seed at all
    for (const [name, text] of Object.entries({
      single: `<blockquote>\n${m(B)}\n</blockquote>`,
      nested: `<blockquote>\n<blockquote>\n${m(B)}\n</blockquote>\n${m(B)}\n</blockquote>`, // inner closer leaves depth 1
      'same-line pair then marker outside is allowed only after close': `<blockquote>x</blockquote><blockquote>\n${m(B)}\n</blockquote>`,
      'uppercase / attributes': `<BLOCKQUOTE class="q">\n${m(B)}\n</BlockQuote >`,
      'unclosed quotes the rest': `<blockquote>\n${m(B)}`,
      'two openers on one line': `<blockquote><blockquote>\n${m(B)}\n</blockquote>\n${m(B)}\n</blockquote>`,
    })) expect(seedFromReviewComments(mk(`${head}${text}\n`)), name).toBeNull();
    // same-line open+close does not leave a depth behind: a marker after it still seeds
    expect(seedFromReviewComments(mk(`${head}<blockquote>quoted</blockquote>\n${m(A)}\n`))?.lastReviewedHead).toBe(A);
    // a stray closer does not go negative: the marker after it still seeds, and a later opener still quotes
    expect(seedFromReviewComments(mk(`${head}</blockquote>\n${m(A)}\n<blockquote>\n${m(B)}\n</blockquote>\n`))?.lastReviewedHead).toBe(A);
    // a tag in prose that is not a blockquote element does not quote
    expect(seedFromReviewComments(mk(`${head}<blockquotes>\n${m(A)}\n`))?.lastReviewedHead).toBe(A);
  });
  it('pre-index PR: seeds only from an accept-shaped verdict with a whole-line marker; anything else is owed', () => {
    const mk = body => [{ viewerDidAuthor: true, body }];
    const good = `✅ review — accepted\n\nRecorded by bot.\n<!-- reviewed-sha: ${H(3)} -->\n`;
    const idx = readHeadIndex({ dir });
    const base = { index: idx, repo: 'o/r', pr: 5 };
    const seed = seedFromReviewComments(mk(good));
    expect(seed).not.toBeNull();
    expect(headReviewOwed({ ...base, head: H(3), seed })).toMatchObject({ owed: false, seeded: true });
    expect(headReviewOwed({ ...base, head: H(4), seed })).toMatchObject({ owed: true, reason: 'new-head', seeded: true });
    expect(seedFromReviewComments([{ author: { login: 'rando' }, body: good }])).toBeNull();
    expect(seedFromReviewComments(mk(`🔁 review — changes requested\n\nRecorded by bot.\nexample: <!-- reviewed-sha: ${H(3)} -->`))).toBeNull();
    expect(seedFromReviewComments([...mk(good), ...mk(`🔁 review — changes requested\n\nRecorded by bot.\n`)])).toBeNull();
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n> <!-- reviewed-sha: ${H(3)} -->\n`))).toBeNull();
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n\`\`\`\n<!-- reviewed-sha: ${H(3)} -->\n\`\`\`\n`))).toBeNull();
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\nsee <!-- reviewed-sha: ${H(3)} --> here\n`))).toBeNull();
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n<!-- reviewed-sha: abc1234 -->\n`))).toBeNull();
    expect(seedFromReviewComments([])).toBeNull();
    // a later control comment from a trusted author withdraws an earlier accept
    for (const control of [
      '🔧 conveyor fix — re-armed for re-review\n\nThe bounce was repaired.',
      '🛑 conveyor fix — stood down, human judgment needed\n\nreason: needs-judgment',
      '⏸ conveyor fix — paused for a concurrent author, re-arms on the next head\n',
      '⏳ conveyor fix — fix ready, verify red only on host-load timeouts; re-verifies when the host is quiet\n',
      '🚧 review on hold pending operator\n\nsome unknown future hold',
      'review paused: referral hold\n',
      'ℹ️ conveyor — note\n',
      String.fromCharCode(0xfeff) + '**🛑 stood down** pending operator\n',
      '🧭 standing ruling — hold this PR\n',
      '🛑 stood-down pending\n', '🔁 re armed\n', '⏸ holding for operator\n', 'Please do not merge, wrong approach\n',
      '🚫 blocked on #12\n', 'withdrawn: needs rework\n', '<!-- m -->\n⏸ paused for author\n', '---\n🛑 stand down\n',
    ]) expect(seedFromReviewComments([...mk(good), ...mk(control)])).toBeNull();
    // a later heading nobody listed also withdraws it: symbol-led trusted comments are control comments whatever they say, and new reject-ish prose is listed
    for (const unlisted of ['❌ review — rejected\n\nsee findings', '🟥 verdict\n', '⚠️ something the daemon has not said before\n', '[bot] notice\n', '(auto) result recorded\n',
      '- queued\n', '“quoted” heading\n', 'needs more work\n', 'Not accepted, see thread\n', 'the check failed\n', 'Declined by the owner\n']) {
      expect(seedFromReviewComments([...mk(good), ...mk(unlisted)])).toBeNull();
    }
    // ...but a control comment BEFORE the accept does not
    expect(seedFromReviewComments([...mk('🛑 conveyor fix — stood down, human judgment needed\n'), ...mk(good)])).not.toBeNull();
    // ...and an untrusted control comment does not
    expect(seedFromReviewComments([...mk(good), { author: { login: 'rando' }, body: '🛑 conveyor fix — stood down\n' }])).not.toBeNull();
    // fences: a ``` line inside a ~~~ block, and inside a 4-backtick block, does not close it
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n~~~\n\`\`\`\n<!-- reviewed-sha: ${H(3)} -->\n~~~\n`))).toBeNull();
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n\`\`\`\`\n\`\`\`\n<!-- reviewed-sha: ${H(3)} -->\n\`\`\`\`\n`))).toBeNull();
    // a 4-space-indented fence line is not a closer (CommonMark), so the marker stays inside the block
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n\`\`\`\n    \`\`\`\n<!-- reviewed-sha: ${H(3)} -->\n`))).toBeNull();
    // a benign non-control trusted comment after the accept does not void it
    expect(seedFromReviewComments([...mk(good), ...mk('thanks, merging soon\n')])).not.toBeNull();
    // a closer with an info string does not close; a proper longer closer does, so a marker after it is accepted
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n\`\`\`\n\`\`\`js\n<!-- reviewed-sha: ${H(3)} -->\n\`\`\`\n`))).toBeNull();
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n\`\`\`\ncode\n\`\`\`\`\n<!-- reviewed-sha: ${H(3)} -->\n`))).not.toBeNull();
    // a closer followed by U+00A0 is not a closer (CommonMark allows only spaces/tabs), so the marker stays fenced
    expect(seedFromReviewComments(mk(`✅ review — accepted\n\n\`\`\`\n\`\`\`${String.fromCharCode(0xa0)}\n<!-- reviewed-sha: ${H(3)} -->\n`))).toBeNull();
    expect(headReviewOwed({ ...base, head: H(3), seed: null }).owed).toBe(true);
    expect(headReviewOwed({ index: { ok: false }, repo: 'o/r', pr: 5, head: H(3), seed })).toMatchObject({ owed: null, held: true });
  });
  it('seed markers after line 12 never suppress review; line 12 still seeds', () => {
    const mk = body => [{ viewerDidAuthor: true, body }];
    const marker = `<!-- reviewed-sha: ${H(3)} -->`;
    // the accept heading is line 1, so `filler` more non-empty lines put the marker on line filler + 2
    const withMarkerOnLine = n => `✅ review — accepted\n${Array.from({ length: n - 2 }, (_, i) => `note ${i}`).join('\n')}\n${marker}\n`;
    expect(seedFromReviewComments(mk(withMarkerOnLine(12)))?.lastReviewedHead).toBe(H(3));
    for (const n of [13, 14, 40]) {
      const seed = seedFromReviewComments(mk(withMarkerOnLine(n)));
      expect(seed, `marker on line ${n}`).toBeNull();
      expect(headReviewOwed({ index: { ok: true, map: {} }, repo: 'o/r', pr: 5, head: H(3), seed })).toMatchObject({ owed: true, reason: 'no-record' });
    }
    // a late marker does not displace an earlier whole-line one inside the window either
    expect(seedFromReviewComments(mk(`✅ review — accepted\n${marker}\n${'x\n'.repeat(12)}<!-- reviewed-sha: ${H(4)} -->\n`))?.lastReviewedHead).toBe(H(3));
  });
  it('an acceptance heading with any prefix is not accept-shaped and leaves review owed', () => {
    const mk = body => [{ viewerDidAuthor: true, body }];
    const tail = `\n\nRecorded by bot.\n<!-- reviewed-sha: ${H(3)} -->\n`;
    expect(seedFromReviewComments(mk(`✅ review — accepted${tail}`))?.lastReviewedHead).toBe(H(3)); // positive control
    for (const prefix of [' ', '\n', 'note: ', 'Re: ', '> ', '**', String.fromCharCode(0xfeff), String.fromCharCode(0x200b), '🔁 ']) {
      const seed = seedFromReviewComments(mk(`${prefix}✅ review — accepted${tail}`));
      expect(seed, `prefix ${JSON.stringify(prefix)}`).toBeNull();
      expect(headReviewOwed({ index: { ok: true, map: {} }, repo: 'o/r', pr: 5, head: H(3), seed })).toMatchObject({ owed: true });
    }
  });
});


// Mutation targets for the caller's red-first run (no tests run by the builder):
// - bypass withFileLock: the blocked-writer handshake below never arrives;
// - publish the log before the temp fsync/rename: byte-identity and step-reader assertions fail;
// - drop txn / reconstruct rows without writer fields: the identity assertions fail;
// - trust a stale map without logHash equality: the post-rename recovery assertion fails.
describe('single-writer acceptance', () => {
  const rows = () => readFileSync(headIndexPaths(dir).log, 'utf8').trim().split('\n').map(JSON.parse);


  it('a contender between the final log read and rename cannot take over and both accepted reviews survive', () => {
    rec();
    const { log, lock } = headIndexPaths(dir);
    let reads = 0, attempted = false;
    const fs = { ...nodeFs, readFileSync: (p, ...args) => {
      const bytes = nodeFs.readFileSync(p, ...args);
      if (p === log && ++reads === 2) {
        attempted = true;
        // Model a stale takeover decision targeting A's lock exactly after A has
        // read its final snapshot. Even apparently abandoned locks cannot be moved.
        writeFileSync(lock, '2147483647\n');
        nodeFs.utimesSync(lock, new Date(0), new Date(0));
        const now = vi.spyOn(Date, 'now').mockReturnValueOnce(60_000).mockReturnValue(65_001);
        try {
          expect(() => rec({ pr: 9, head: H(3), netPatchHash: 'B' })).toThrow(/lock acquisition timed out/);
        } finally { now.mockRestore(); }
        expect(readFileSync(lock, 'utf8')).toBe('2147483647\n');
      }
      return bytes;
    } };
    expect(rec({ fs, pr: 8, head: H(2), netPatchHash: 'A' })).toMatchObject({ ok: true });
    expect(attempted).toBe(true);
    // B may commit only after A releases the single lock; both rows then survive.
    expect(rec({ pr: 9, head: H(3), netPatchHash: 'B' })).toMatchObject({ ok: true });
    expect(rows().map(r => r.pr)).toEqual([7, 8, 9]);
    expect(readHeadIndex({ dir }).map).toMatchObject({
      'o/r#8': { lastReviewedHead: H(2) }, 'o/r#9': { lastReviewedHead: H(3) }
    });
  });

  it('two writers whose lock was displaced never overwrite each other (temp paths are unique)', () => {
    rec();
    const { log, map, lock } = headIndexPaths(dir);
    const opened = { A: [], B: [] };
    // Displace A while its map temp exists. B must retain A's accepted log row,
    // and neither writer may truncate, rename or clean up the other's temp files.
    let mapFd, aTemp;
    const bFs = { ...nodeFs, openSync: (p, ...args) => {
      if (String(p).endsWith('.tmp')) opened.B.push(p);
      return nodeFs.openSync(p, ...args);
    } };
    const fs = { ...nodeFs,
      openSync: (p, ...args) => {
        const fd = nodeFs.openSync(p, ...args);
        if (String(p).endsWith('.tmp')) opened.A.push(p);
        if (String(p).startsWith(`${map}.`) && String(p).endsWith('.tmp')) { mapFd = fd; aTemp = p; }
        return fd;
      },
      fsyncSync: fd => {
        nodeFs.fsyncSync(fd);
        if (fd === mapFd) {
          mapFd = undefined;
          const before = readFileSync(aTemp);
          rmSync(lock);
          rec({ fs: bFs, pr: 9, head: H(3), netPatchHash: 'B' });
          expect(readFileSync(aTemp)).toEqual(before);
        }
      }
    };
    expect(rec({ fs, pr: 8, head: H(2), netPatchHash: 'A' })).toMatchObject({ ok: true });
    expect(opened.A).toHaveLength(2);
    expect(opened.B).toHaveLength(2);
    expect(new Set([...opened.A, ...opened.B]).size).toBe(4);
    for (const paths of Object.values(opened)) {
      expect(paths.some(p => p.startsWith(`${log}.`))).toBe(true);
      expect(paths.some(p => p.startsWith(`${map}.`))).toBe(true);
    }
    expect(rows().map(r => r.pr)).toEqual([7, 8, 9]);
    expect(readHeadIndex({ dir }).map).toMatchObject({
      'o/r#8': { lastReviewedHead: H(2) }, 'o/r#9': { lastReviewedHead: H(3) }
    });
    expect(nodeFs.readdirSync(dir).filter(p => p.endsWith('.tmp'))).toEqual([]);
  });

  it('a writer whose log changed under it aborts and leaves the log intact', () => {
    rec();
    const { log, map, lock } = headIndexPaths(dir);
    let tempFd, changedLog, changedMap, attemptedRename = false;
    const temps = [];
    const fs = { ...nodeFs,
      openSync: (p, ...args) => {
        const fd = nodeFs.openSync(p, ...args);
        if (String(p).endsWith('.tmp')) { temps.push(p); tempFd = fd; }
        return fd;
      },
      fsyncSync: fd => {
        nodeFs.fsyncSync(fd);
        if (fd === tempFd) {
          // B enters through the same shared lock while A is displaced.
          const ownTemp = readFileSync(temps[0]);
          rmSync(lock);
          rec({ head: H(3), netPatchHash: 'B' });
          changedLog = readFileSync(log); changedMap = readFileSync(map);
          expect(readFileSync(temps[0])).toEqual(ownTemp);
        }
      },
      renameSync: (from, to) => { attemptedRename = true; return nodeFs.renameSync(from, to); }
    };
    expect(() => rec({ fs, head: H(2), netPatchHash: 'A' })).toThrow(/log changed/);
    expect(attemptedRename).toBe(false);
    expect(readFileSync(log)).toEqual(changedLog);
    expect(readFileSync(map)).toEqual(changedMap);
    expect(rows().map(r => r.head)).toEqual([H(1), H(3)]);
    expect(readHeadIndex({ dir }).map['o/r#7'].lastReviewedHead).toBe(H(3));
    expect(temps).toHaveLength(1);
    expect(temps.every(p => !existsSync(p))).toBe(true);
    expect(nodeFs.readdirSync(dir).filter(p => p.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['EACCES', 'ENOENT'])('a log re-read failure (%s) refuses replacement and cleans its own temps', code => {
    rec();
    const { log, map } = headIndexPaths(dir);
    const before = [readFileSync(log), readFileSync(map)];
    const temps = [];
    let reads = 0, renamed = false;
    const fs = { ...nodeFs,
      readFileSync: (p, ...args) => {
        if (p === log && ++reads === 2) throw Object.assign(Error('log re-read failed'), { code });
        return nodeFs.readFileSync(p, ...args);
      },
      openSync: (p, ...args) => {
        if (String(p).endsWith('.tmp')) temps.push(p);
        return nodeFs.openSync(p, ...args);
      },
      renameSync: (from, to) => { renamed = true; return nodeFs.renameSync(from, to); }
    };
    expect(() => rec({ fs, head: H(2) })).toThrow(/log changed/);
    expect(renamed).toBe(false);
    expect([readFileSync(log), readFileSync(map)]).toEqual(before);
    expect(temps).toHaveLength(1);
    expect(temps.every(p => !existsSync(p))).toBe(true);
  });

  it("a rollback during compaction waits: concurrent writer B is blocked until A's compaction rename completes", async () => {
    rec();
    const before = readFileSync(headIndexPaths(dir).log);
    const barrier = new SharedArrayBuffer(4);
    const code = `
      import fs from 'node:fs';
      import { parentPort, workerData } from 'node:worker_threads';
      const { recordReview, headIndexPaths } = await import(workerData.moduleURL);
      const { dir, mode, barrier } = workerData;
      const { log, lock } = headIndexPaths(dir);
      const open = fs.openSync.bind(fs);
      let sent = false, tempFd;
      fs.openSync = (path, flags, ...args) => {
        try { return open(path, flags, ...args); }
        catch (e) {
          if (mode === 'B' && path === lock && e.code === 'EEXIST' && !sent) {
            sent = true; parentPort.postMessage('blocked');
          }
          throw e;
        }
      };
      const io = { ...fs,
        openSync(path, flags, ...args) {
          const fd = fs.openSync(path, flags, ...args);
          if (String(path).startsWith(log + '.') && String(path).endsWith('.tmp')) tempFd = fd;
          return fd;
        },
        fsyncSync(fd) {
          if (mode === 'B' && fd === tempFd) throw Error('B rejected before rename');
          return fs.fsyncSync(fd);
        },
        renameSync(from, to) {
          if (mode === 'A' && to === log) {
            parentPort.postMessage('ready');
            if (Atomics.wait(new Int32Array(barrier), 0, 0, 10000) === 'timed-out') throw Error('barrier timeout');
          }
          return fs.renameSync(from, to);
        }
      };
      try {
        recordReview({ dir, repo: 'o/r', pr: 7, head: (mode === 'A' ? '2' : '3').repeat(40),
          netPatchHash: mode, verdict: 'accept', at: '2026-11-04T11:00:00Z', logMaxLines: 1, fs: io });
        parentPort.postMessage('accepted');
      } catch (e) { parentPort.postMessage({ error: e.message }); }
    `;
    const start = mode => new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), {
      workerData: { dir, mode, barrier, moduleURL: pathToFileURL(join(process.cwd(), 'scripts/lib/review-head-index.mjs')).href }
    });
    const next = worker => new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
    });
    const a = start('A'); let b;
    try {
      expect(await next(a)).toBe('ready');
      // Red on the append-first implementation: A's candidate is already in the readable log.
      expect(readFileSync(headIndexPaths(dir).log)).toEqual(before);
      b = start('B');
      expect(await next(b)).toBe('blocked');
      expect(readFileSync(headIndexPaths(dir).log)).toEqual(before);
      const aDone = next(a), bDone = next(b);
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      expect(await aDone).toBe('accepted');
      expect(await bDone).toEqual({ error: 'B rejected before rename' });
      expect(readHeadIndex({ dir }).map['o/r#7'].lastReviewedHead).toBe(H(2));
      expect(rows().some(r => r.netPatchHash === 'B')).toBe(false);
    } finally {
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      await a.terminate(); if (b) await b.terminate();
    }
  }, 15000);

  it("compaction keeps each row's txn: a delayed failure of writer A removes nothing of writer B's identical-content review", () => {
    rec();
    const { log } = headIndexPaths(dir);
    const original = rows()[0];
    // A has written candidate bytes but fails before they can replace the log.
    let candidate;
    const fs = { ...nodeFs, renameSync: (from, to) => {
      if (to === log) { candidate = JSON.parse(readFileSync(from, 'utf8').trim().split('\n').at(-1)); throw Error('A delayed failure'); }
      return nodeFs.renameSync(from, to);
    } };
    expect(() => rec({ fs })).toThrow(/A delayed failure/);
    // Red on append-first: even a rejected row must never change the readable bytes.
    expect(rows()).toEqual([original]);
    rec(); // B's review has exactly A's content, with a different transaction identity.
    const b = rows().at(-1);
    expect(b.txn).not.toBe(candidate.txn);
    expect(b.txn).toMatch(/^[0-9a-f-]{36}$/);
    // Preserve fields belonging to the original writer, including fields unknown to the map schema.
    b.writer = { pid: 42, actor: 'B' };
    writeFileSync(log, `${JSON.stringify(b)}\n`);
    rec({ pr: 8, head: H(3), netPatchHash: 'p3', logMaxLines: 1 });
    expect(rows().find(r => r.pr === 7)).toEqual(b);
    expect(readHeadIndex({ dir }).map['o/r#7'].txn).toBe(b.txn);
  });

  it('a failed write (error injected before the rename) leaves the log byte-identical and the prior review still current', () => {
    rec();
    const { log } = headIndexPaths(dir), before = readFileSync(log);
    let fd;
    const fs = { ...nodeFs,
      openSync: (p, flags) => { const out = nodeFs.openSync(p, flags); if (String(p).startsWith(`${log}.`) && String(p).endsWith('.tmp')) fd = out; return out; },
      fsyncSync: f => { if (f === fd) throw Error('temp fsync failed'); return nodeFs.fsyncSync(f); }
    };
    expect(() => rec({ fs, head: H(2), netPatchHash: 'p2' })).toThrow(/temp fsync failed/);
    expect(readFileSync(log)).toEqual(before);
    expect(readHeadIndex({ dir }).map['o/r#7'].lastReviewedHead).toBe(H(1));
    expect(existsSync(headIndexPaths(dir).lock)).toBe(false);
  });

  it('compaction never folds an uncommitted row', () => {
    rec({ keepPerPr: 1 });
    const { log } = headIndexPaths(dir), before = readFileSync(log);
    const fs = { ...nodeFs, renameSync: (from, to) => {
      if (to === log) {
        const candidateRows = readFileSync(from, 'utf8').trim().split('\n').map(JSON.parse);
        // The candidate cannot evict the committed predecessor before it is accepted.
        expect(candidateRows.map(r => r.head)).toEqual([H(1), H(2)]);
        expect(readFileSync(log)).toEqual(before);
        throw Error('compaction rejected');
      }
      return nodeFs.renameSync(from, to);
    } };
    expect(() => rec({ fs, head: H(2), netPatchHash: 'p2', keepPerPr: 1, logMaxLines: 1 })).toThrow(/compaction rejected/);
    rec({ pr: 8, head: H(3), netPatchHash: 'p3', keepPerPr: 1, logMaxLines: 1 });
    expect(rows().some(r => r.head === H(2))).toBe(false);
    expect(readHeadIndex({ dir }).map['o/r#7'].lastReviewedHead).toBe(H(1));
  });

  it('a reader never observes a rejected review: reads at every fs step during a failing write see only the prior state', () => {
    rec();
    const { log } = headIndexPaths(dir), before = readFileSync(log);
    const prior = readHeadIndex({ dir }).map;
    const steps = [];
    const fs = { ...nodeFs };
    for (const name of ['mkdirSync', 'statSync', 'readFileSync', 'openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync']) {
      fs[name] = (...args) => {
        const observe = () => {
          steps.push(name);
          expect(readHeadIndex({ dir }).map).toEqual(prior);
          expect(readFileSync(log)).toEqual(before);
        };
        observe();
        try {
          if (name === 'renameSync' && args[1] === log) throw Error('rejected at rename');
          return nodeFs[name](...args);
        } finally { observe(); }
      };
    }
    expect(() => rec({ fs, head: H(2), netPatchHash: 'p2', logMaxLines: 1 })).toThrow(/rejected at rename/);
    expect(steps).toContain('writeSync');
    expect(steps).toContain('renameSync');
    expect(readHeadIndex({ dir }).map).toEqual(prior);
  });

  it('an abandoned lock refuses writes until the operator stops writers and removes it', () => {
    rec();
    const { log, map, lock } = headIndexPaths(dir);
    const before = [readFileSync(log), readFileSync(map)];
    writeFileSync(lock, '2147483647\n');
    nodeFs.utimesSync(lock, new Date(0), new Date(0));
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(60_000).mockReturnValue(65_001);
    try {
      expect(() => rec({ head: H(2) })).toThrow(/stop all index writers.*remove.*lock.*retry/i);
    } finally { now.mockRestore(); }
    expect(readFileSync(lock, 'utf8')).toBe('2147483647\n');
    expect([readFileSync(log), readFileSync(map)]).toEqual(before);
    // This isolated fixture has no active writers; model the explicit operator recovery.
    rmSync(lock);
    expect(rec({ head: H(2) })).toMatchObject({ ok: true });
    expect(readHeadIndex({ dir }).map['o/r#7'].lastReviewedHead).toBe(H(2));
  });

  it('a failure after the log rename is accepted and readers rebuild until the map is published', () => {
    rec();
    const { log, map } = headIndexPaths(dir);
    let dirFd, dirSynced = false;
    const fs = { ...nodeFs,
      openSync: (p, ...args) => { const fd = nodeFs.openSync(p, ...args); if (p === dir) dirFd = fd; return fd; },
      fsyncSync: fd => { if (fd === dirFd) dirSynced = true; return nodeFs.fsyncSync(fd); },
      renameSync: (from, to) => {
        if (to === map) throw Error('map publish failed');
        return nodeFs.renameSync(from, to);
      }
    };
    expect(() => rec({ fs, head: H(2), netPatchHash: 'p2' })).toThrow(/map publish failed/);
    expect(readHeadIndex({ dir })).toMatchObject({ ok: true, rebuilt: true,
      map: { 'o/r#7': { lastReviewedHead: H(2) } } });
    expect(rows().at(-1).head).toBe(H(2));
    expect(dirSynced).toBe(true);
    expect(nodeFs.readdirSync(dir).filter(p => p.endsWith('.tmp'))).toEqual([]);
  });

  it('flushes the temp log before acceptance, then the temp map before publication, then the directory', () => {
    const { log, map } = headIndexPaths(dir), ops = [], names = new Map();
    const fs = { ...nodeFs,
      openSync: (p, flags) => { const fd = nodeFs.openSync(p, flags); names.set(fd, p); return fd; },
      fsyncSync: fd => { ops.push(`sync:${names.get(fd)}`); return nodeFs.fsyncSync(fd); },
      renameSync: (from, to) => { ops.push(`rename:${to}`); return nodeFs.renameSync(from, to); }
    };
    rec({ fs });
    expect(ops).toEqual([expect.stringMatching(/^sync:.*log\.jsonl\.\d+\.[\w-]+\.tmp$/),
      `rename:${log}`, expect.stringMatching(/^sync:.*map\.json\.\d+\.[\w-]+\.tmp$/), `rename:${map}`, `sync:${dir}`]);
  });

  it('an unreadable committed log fails closed before any replacement is written', () => {
    rec();
    const { log, map } = headIndexPaths(dir);
    const before = [readFileSync(log), readFileSync(map)];
    let openedTemp = false;
    const fs = { ...nodeFs,
      readFileSync: (p, ...args) => {
        if (p === log) throw Object.assign(Error('read denied'), { code: 'EACCES' });
        return nodeFs.readFileSync(p, ...args);
      },
      openSync: (p, ...args) => { openedTemp = true; return nodeFs.openSync(p, ...args); }
    };
    expect(() => rec({ fs })).toThrow(/existing index unreadable/);
    expect(openedTemp).toBe(false);
    expect([readFileSync(log), readFileSync(map)]).toEqual(before);
  });

  it('directory fsync IO failure is reported after acceptance without retracting the review', () => {
    rec();
    let dirFd;
    const fs = { ...nodeFs,
      openSync: (p, ...args) => { const fd = nodeFs.openSync(p, ...args); if (p === dir) dirFd = fd; return fd; },
      fsyncSync: fd => { if (fd === dirFd) throw Object.assign(Error('directory IO failure'), { code: 'EIO' }); return nodeFs.fsyncSync(fd); }
    };
    expect(() => rec({ fs, head: H(2), netPatchHash: 'p2' })).toThrow(/directory IO failure/);
    expect(readHeadIndex({ dir }).map['o/r#7'].lastReviewedHead).toBe(H(2));
  });

  it.each(['EINVAL', 'ENOTSUP', 'EISDIR'])('unsupported directory fsync (%s) preserves successful acceptance', code => {
    rec();
    let dirFd, dirSyncs = 0;
    const fs = { ...nodeFs,
      openSync: (p, ...args) => { const fd = nodeFs.openSync(p, ...args); if (p === dir) dirFd = fd; return fd; },
      fsyncSync: fd => { if (fd === dirFd) { dirSyncs++; throw Object.assign(Error('directory fsync unsupported'), { code }); } return nodeFs.fsyncSync(fd); }
    };
    expect(rec({ fs, head: H(2), netPatchHash: 'p2' })).toMatchObject({ ok: true });
    expect(dirSyncs).toBe(1); // the tolerated branch was actually reached
    const idx = readHeadIndex({ dir });
    expect(idx.map['o/r#7'].lastReviewedHead).toBe(H(2));
    expect(headReviewOwed({ index: idx, repo: 'o/r', pr: 7, head: H(2) })).toMatchObject({ owed: false });
  });

});
