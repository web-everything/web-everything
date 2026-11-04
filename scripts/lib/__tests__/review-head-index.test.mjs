import { describe, it, expect, beforeEach } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { recordReview, readHeadIndex, headReviewOwed, netPatchKey, resolveHeadIndexSettings, headIndexPaths } from '../review-head-index.mjs';

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
    const kind = p => (String(p).endsWith('.tmp') ? 'tmp' : 'log');
    const fs = { ...nodeFs,
      openSync: (p, f) => { ops.push(`open:${f}:${kind(p)}`); return nodeFs.openSync(p, f); },
      fsyncSync: fd => { ops.push('fsync'); return nodeFs.fsyncSync(fd); },
      renameSync: (a, b) => { ops.push('rename'); return nodeFs.renameSync(a, b); } };
    rec({ fs });
    expect(ops).toEqual(['open:a:log', 'fsync', 'open:w:tmp', 'fsync', 'rename']);
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
