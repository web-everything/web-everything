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
    // a LIVE owner is never displaced, however old the lock is
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 't', at: 0 }));
    nodeFs.utimesSync(lock, new Date(0), new Date(0));
    expect(() => withHeadIndexLock(dir, () => 'old', { waitMs: 60, staleMs: 1 })).toThrow(/lock busy/);
  });
  const takeoverLeftovers = () => nodeFs.readdirSync(dir).filter(f => /\.(takeover|new|stale)/.test(f));
  it('takeover: an owner that re-creates the lock before the serialised re-read keeps it (never displaced)', () => {
    const { lock } = headIndexPaths(dir);
    nodeFs.mkdirSync(dir, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
    let swapped = false;
    // the live owner re-creates the lock right after the contender takes the takeover mutex, i.e. before its re-read
    const fs = { ...nodeFs, openSync: (p, f) => {
      const fd = nodeFs.openSync(p, f);
      if (!swapped && p === `${lock}.takeover`) { swapped = true; writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live', at: Date.now() })); }
      return fd;
    } };
    expect(() => withHeadIndexLock(dir, () => 'no', { fs, waitMs: 60 })).toThrow(/lock busy/);
    expect(swapped).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('live'); // the live owner's fence would still pass
    expect(takeoverLeftovers()).toEqual([]);
  });
  it('takeover of an unreadable (never-written) holder file: a live owner that replaces it before the re-read keeps its lock', () => {
    const { lock } = headIndexPaths(dir);
    nodeFs.mkdirSync(dir, { recursive: true });
    writeFileSync(lock, ''); // no readable owner: judged stale only by age
    nodeFs.utimesSync(lock, new Date(0), new Date(0));
    let swapped = false;
    const fs = { ...nodeFs, openSync: (p, f) => {
      const fd = nodeFs.openSync(p, f);
      if (!swapped && p === `${lock}.takeover`) { swapped = true; writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live', at: Date.now() })); }
      return fd;
    } };
    expect(() => withHeadIndexLock(dir, () => 'no', { fs, waitMs: 60, staleMs: 1000 })).toThrow(/lock busy/);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('live');
    expect(takeoverLeftovers()).toEqual([]);
  });
  it('takeover replaces the lock atomically: it is never unlinked and never absent while a takeover runs', () => {
    const { lock } = headIndexPaths(dir);
    nodeFs.mkdirSync(dir, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
    const seen = [];
    const fs = { ...nodeFs,
      unlinkSync: p => { seen.push({ op: 'unlink', p }); return nodeFs.unlinkSync(p); },
      renameSync: (a, b) => { seen.push({ op: 'rename', p: b, lockPresent: existsSync(lock) }); return nodeFs.renameSync(a, b); } };
    expect(withHeadIndexLock(dir, fence => { fence(); return 'ok'; }, { fs })).toBe('ok');
    const renamed = seen.findIndex(e => e.op === 'rename' && e.p === lock);
    expect(renamed).toBeGreaterThanOrEqual(0);                      // our lock lands by rename over the old one
    expect(seen[renamed].lockPresent).toBe(true);                   // the old lock was still in place: no window without a lock
    expect(seen.findIndex(e => e.op === 'unlink' && e.p === lock)).toBeGreaterThan(renamed); // lock is only unlinked at our own release
    expect(takeoverLeftovers()).toEqual([]);
  });
  it('takeover is serialised: a live contender holding the takeover file blocks, a dead one is cleared', () => {
    const { lock } = headIndexPaths(dir);
    const takeover = `${lock}.takeover`;
    nodeFs.mkdirSync(dir, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
    writeFileSync(takeover, JSON.stringify({ pid: process.pid, token: 'other', at: Date.now() }));
    expect(() => withHeadIndexLock(dir, () => 'no', { waitMs: 60 })).toThrow(/lock busy/);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('dead'); // untouched while another takeover runs
    writeFileSync(takeover, JSON.stringify({ pid: 999998, token: 'crashed', at: 0 }));
    expect(withHeadIndexLock(dir, () => 'ok')).toBe('ok');
    expect(takeoverLeftovers()).toEqual([]);
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
  it('fencing: a writer that lost its lock refuses to publish', () => {
    const { lock } = headIndexPaths(dir);
    expect(() => withHeadIndexLock(dir, fence => { writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other', at: Date.now() })); fence(); })).toThrow(/lock lost/);
    rmSync(lock, { force: true });
    const fs = { ...nodeFs, openSync: (p, f) => { if (f === 'a') writeFileSync(headIndexPaths(dir).lock, JSON.stringify({ pid: process.pid, token: 'thief', at: 1 })); return nodeFs.openSync(p, f); } };
    // the swap happens as the append opens; the next fence (before the map publish) must refuse
    expect(() => rec({ fs })).toThrow(/lock lost/);
    expect(existsSync(headIndexPaths(dir).map)).toBe(false);
    expect(existsSync(headIndexPaths(dir).log)).toBe(false); // the rejected record is rolled back out of the source-of-truth log
  });
  it('fencing: a writer whose lock is stolen between the fence and the append leaves the log bytes unchanged and the map unpublished', () => {
    rec();
    const { log, map, lock } = headIndexPaths(dir);
    const [logBefore, mapBefore] = [readFileSync(log, 'utf8'), readFileSync(map, 'utf8')];
    // the lock is stolen as the append opens, i.e. after the pre-append fence and before the line lands
    const fs = { ...nodeFs, openSync: (p, f) => { if (f === 'a') writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'thief', at: 1 })); return nodeFs.openSync(p, f); } };
    expect(() => rec({ fs, head: H(2), netPatchHash: 'p2' })).toThrow(/lock lost/);
    expect(readFileSync(log, 'utf8')).toBe(logBefore);
    expect(readFileSync(map, 'utf8')).toBe(mapBefore);
    const owed = headReviewOwed({ index: readHeadIndex({ dir }), repo: 'o/r', pr: 7, head: H(2), netPatchHash: 'p2' });
    expect(owed).toMatchObject({ owed: true });                  // readers cannot see the rejected review
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('thief'); // the new holder's lock is left alone
  });
  it('fencing rollback never truncates away a record another writer appended after ours', () => {
    rec();
    const { log, lock } = headIndexPaths(dir);
    const theirs = `${JSON.stringify({ repo: 'o/r', pr: 8, head: H(3), netPatchHash: 'p9', verdict: 'accept', at: '2026-11-04T11:00:00Z' })}\n`;
    const fs = { ...nodeFs, openSync: (p, f) => {
      const fd = nodeFs.openSync(p, f);
      if (f === 'a') { writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'thief', at: 1 })); nodeFs.appendFileSync(log, theirs); }
      return fd;
    } };
    expect(() => rec({ fs, head: H(2), netPatchHash: 'p2' })).toThrow(/lock lost/);
    expect(readFileSync(log, 'utf8')).toContain(theirs);        // the other holder's record survives the rollback
  });
  it('fencing: a writer that loses its lock before the append never touches the log or the map', () => {
    rec();
    const { log, map, lock } = headIndexPaths(dir);
    const [logBefore, mapBefore] = [readFileSync(log, 'utf8'), readFileSync(map, 'utf8')];
    let stolen = false;
    const fs = { ...nodeFs, readFileSync: (p, ...a) => { // first log read is readHeadIndex's, which precedes the pre-append fence
      if (!stolen && p === log) { stolen = true; writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'thief', at: 1 })); }
      return nodeFs.readFileSync(p, ...a); } };
    expect(() => rec({ fs, head: H(2), netPatchHash: 'p2' })).toThrow(/lock lost/);
    expect(readFileSync(log, 'utf8')).toBe(logBefore);
    expect(readFileSync(map, 'utf8')).toBe(mapBefore);
  });
  it('fencing: a writer that loses its lock before the compaction rewrite never replaces the log or publishes the map', () => {
    rec(); rec({ head: H(2), netPatchHash: 'p2' });
    const { log, map, lock } = headIndexPaths(dir);
    const [logBefore, mapBefore] = [readFileSync(log, 'utf8'), readFileSync(map, 'utf8')];
    let appended = false;
    const fs = { ...nodeFs,
      openSync: (p, f) => { if (f === 'a') appended = true; return nodeFs.openSync(p, f); },
      readFileSync: (p, ...a) => { if (appended && p === log) { appended = false; writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'thief', at: 1 })); } return nodeFs.readFileSync(p, ...a); } };
    // logMaxLines=1 forces compaction; the steal lands right before the pre-rewrite fence, which must refuse
    expect(() => rec({ fs, head: H(3), netPatchHash: 'p3', logMaxLines: 1 })).toThrow(/lock lost/);
    expect(readFileSync(log, 'utf8')).toBe(logBefore);              // not replaced from a stale map, and our line rolled back
    expect(readFileSync(map, 'utf8')).toBe(mapBefore);              // map never published
  });
  it('fencing: a writer that loses its lock right after the compaction rewrite restores the log it replaced and publishes nothing', () => {
    rec(); rec({ head: H(2), netPatchHash: 'p2' });
    const { log, map, lock } = headIndexPaths(dir);
    const [logBefore, mapBefore] = [readFileSync(log, 'utf8'), readFileSync(map, 'utf8')];
    let stolen = false;
    const fs = { ...nodeFs, renameSync: (a, b) => { // the compacted log lands, then the lock is lost before the next fence
      const r = nodeFs.renameSync(a, b);
      if (!stolen && b === log) { stolen = true; writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'thief', at: 1 })); }
      return r; } };
    expect(() => rec({ fs, head: H(3), netPatchHash: 'p3', logMaxLines: 1 })).toThrow(/lock lost/);
    expect(stolen).toBe(true);
    expect(readFileSync(log, 'utf8')).toBe(logBefore);
    expect(readFileSync(map, 'utf8')).toBe(mapBefore);
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
});
