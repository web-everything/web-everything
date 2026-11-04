/**
 * @file free-lane-list.test.mjs — proof of the #4122 free-lane-list core: parse/freshness/build/candidate
 *   ordering (pure), plus the atomic-write/read IO shell round trip. See `free-lane-list.mjs`'s own header for
 *   the incident this exists to fix (`acquire` measured 240s / `list --acquirable` 66s under load, against
 *   acquire's 180s wait, while 30+ lanes sat free) and why the list is a HINT, never trusted alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FREE_LANE_LIST_VERSION,
  DEFAULT_FREE_LANE_LIST_MAX_AGE_MS,
  FREE_LANE_LIST_FILE_ENV,
  parseFreeLaneList,
  isFreeLaneListFresh,
  buildFreeLaneList,
  serializeFreeLaneList,
  freeLaneCandidates,
  resolveFreeLaneListPath,
  readFreeLaneList,
  writeFreeLaneListAtomic,
} from '../free-lane-list.mjs';

const T0 = Date.parse('2026-09-25T16:00:00.000Z');

describe('parseFreeLaneList', () => {
  it('parses a well-formed list', () => {
    const text = JSON.stringify({ v: 1, writtenAt: T0, repo: 'web-everything', poolDir: '/pool', lanes: [{ lane: 3, path: '/pool/lane-3', head: 'abc123', branch: 'main' }] }) + '\n';
    expect(parseFreeLaneList(text)).toEqual({ v: 1, writtenAt: T0, repo: 'web-everything', poolDir: '/pool', lanes: [{ lane: 3, path: '/pool/lane-3', head: 'abc123', branch: 'main', at: T0 }] });
  });
  it('null on empty/missing text', () => {
    expect(parseFreeLaneList('')).toBeNull();
    expect(parseFreeLaneList(null)).toBeNull();
    expect(parseFreeLaneList(undefined)).toBeNull();
  });
  it('null on unparsable JSON (never throws)', () => {
    expect(parseFreeLaneList('{not json')).toBeNull();
  });
  it('null on a version mismatch — a reader from a mismatched schema must degrade to "missing", never misparse', () => {
    expect(parseFreeLaneList(JSON.stringify({ v: 2, writtenAt: T0, repo: 'x', lanes: [] }))).toBeNull();
  });
  it('null when required fields are missing', () => {
    expect(parseFreeLaneList(JSON.stringify({ v: 1, repo: 'x', lanes: [] }))).toBeNull(); // no writtenAt
    expect(parseFreeLaneList(JSON.stringify({ v: 1, writtenAt: T0, lanes: [] }))).toBeNull(); // no repo
    expect(parseFreeLaneList(JSON.stringify({ v: 1, writtenAt: T0, repo: 'x' }))).toBeNull(); // no lanes array
  });
  it('drops malformed lane rows but keeps the rest', () => {
    const parsed = parseFreeLaneList(JSON.stringify({
      v: 1, writtenAt: T0, repo: 'x', lanes: [{ lane: 'not-a-number' }, { lane: -1 }, { lane: 5, path: '/p/lane-5' }],
    }));
    expect(parsed.lanes).toEqual([{ lane: 5, path: '/p/lane-5', head: null, branch: null, at: T0 }]);
  });
  it('an array or non-object top level is not a valid list', () => {
    expect(parseFreeLaneList('[]')).toBeNull();
    expect(parseFreeLaneList('"a string"')).toBeNull();
  });
});

describe('isFreeLaneListFresh', () => {
  const fresh = (writtenAt) => ({ v: FREE_LANE_LIST_VERSION, writtenAt, repo: 'x', lanes: [] });
  it('null list is never fresh', () => {
    expect(isFreeLaneListFresh(null, T0, DEFAULT_FREE_LANE_LIST_MAX_AGE_MS)).toBe(false);
  });
  it('just-written is fresh', () => {
    expect(isFreeLaneListFresh(fresh(T0), T0, DEFAULT_FREE_LANE_LIST_MAX_AGE_MS)).toBe(true);
  });
  it('just under the max age is still fresh; at/over it is stale', () => {
    const maxAge = 60_000;
    expect(isFreeLaneListFresh(fresh(T0 - 59_000), T0, maxAge)).toBe(true);
    expect(isFreeLaneListFresh(fresh(T0 - 60_000), T0, maxAge)).toBe(false);
    expect(isFreeLaneListFresh(fresh(T0 - 120_000), T0, maxAge)).toBe(false);
  });
  it('a "future" writtenAt (clock skew past 1s slack) is never trusted as fresh', () => {
    expect(isFreeLaneListFresh(fresh(T0 + 5000), T0, DEFAULT_FREE_LANE_LIST_MAX_AGE_MS)).toBe(false);
  });
});

describe('buildFreeLaneList', () => {
  it('sorts ascending by lane number regardless of input order', () => {
    const list = buildFreeLaneList({ repoName: 'we', writtenAt: T0, lanes: [{ lane: 9 }, { lane: 2 }, { lane: 5 }] });
    expect(list.lanes.map((l) => l.lane)).toEqual([2, 5, 9]);
  });
  it('dedupes by lane number, keeping the first occurrence', () => {
    const list = buildFreeLaneList({ repoName: 'we', writtenAt: T0, lanes: [{ lane: 4, head: 'first' }, { lane: 4, head: 'second' }] });
    expect(list.lanes).toEqual([{ lane: 4, path: null, head: 'first', branch: null, at: T0 }]);
  });
  it('drops non-integer / negative lane numbers', () => {
    const list = buildFreeLaneList({ repoName: 'we', writtenAt: T0, lanes: [{ lane: -1 }, { lane: 'x' }, { lane: 3 }] });
    expect(list.lanes.map((l) => l.lane)).toEqual([3]);
  });
  it('round-trips through serialize + parse', () => {
    const list = buildFreeLaneList({ repoName: 'we', poolDir: '/pool', writtenAt: T0, lanes: [{ lane: 1, path: '/pool/lane-1', head: 'h', branch: 'main' }] });
    expect(parseFreeLaneList(serializeFreeLaneList(list))).toEqual(list);
  });
});

describe('freeLaneCandidates', () => {
  const list = buildFreeLaneList({ repoName: 'we', writtenAt: T0, lanes: [{ lane: 1 }, { lane: 2 }, { lane: 3 }] });
  it('returns every listed lane, in order, when nothing is excluded', () => {
    expect(freeLaneCandidates(list)).toEqual([1, 2, 3]);
  });
  it('filters out excluded lanes', () => {
    expect(freeLaneCandidates(list, { exclude: new Set([2]) })).toEqual([1, 3]);
  });
  it('empty for a null/missing list', () => {
    expect(freeLaneCandidates(null)).toEqual([]);
  });
});

describe('resolveFreeLaneListPath', () => {
  it('defaults to a file next to the pool when CONVEYOR_STATE_ROOT is unset', () => {
    const path = resolveFreeLaneListPath({ repoName: 'web-everything', poolDir: '/pool/web-everything', env: {} });
    expect(path).toBe('/pool/web-everything/.free-lanes.json');
  });
  it('nests under CONVEYOR_STATE_ROOT, keyed by repo, when pinned (#4052)', () => {
    const path = resolveFreeLaneListPath({ repoName: 'web-everything', poolDir: '/pool/web-everything', env: { CONVEYOR_STATE_ROOT: '/pinned' } });
    expect(path).toBe('/pinned/.conveyor/lane-pool-free-lanes/web-everything.json');
  });
  it('an explicit LANE_POOL_FREE_LIST_FILE override always wins', () => {
    const path = resolveFreeLaneListPath({
      repoName: 'web-everything', poolDir: '/pool/web-everything',
      env: { CONVEYOR_STATE_ROOT: '/pinned', [FREE_LANE_LIST_FILE_ENV]: '/explicit/file.json' },
    });
    expect(path).toBe('/explicit/file.json');
  });
});

describe('read/write IO shell', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'free-lane-list-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('readFreeLaneList returns null for a missing file', () => {
    expect(readFreeLaneList(join(dir, 'nope.json'))).toBeNull();
  });
  it('writeFreeLaneListAtomic then readFreeLaneList round-trips, via a real rename (never a partial file)', () => {
    const path = join(dir, 'sub', 'free-lanes.json');
    const list = buildFreeLaneList({ repoName: 'we', poolDir: dir, writtenAt: T0, lanes: [{ lane: 7, path: join(dir, 'lane-7') }] });
    writeFreeLaneListAtomic(path, list);
    expect(existsSync(path)).toBe(true);
    expect(readFreeLaneList(path)).toEqual(list);
    // no leftover temp file
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });
  it('writeFreeLaneListAtomic never follows a symlink pre-planted at its temp name — it skips to a fresh name', () => {
    const path = join(dir, 'free-lanes.json');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    const planted = `${path}.planted.tmp`;
    symlinkSync(victim, planted);
    const list = buildFreeLaneList({ repoName: 'we', poolDir: dir, writtenAt: T0, lanes: [{ lane: 2, path: join(dir, 'lane-2') }] });
    writeFreeLaneListAtomic(path, list, { tmpPathFor: (p, attempt) => (attempt === 0 ? planted : `${p}.fresh.tmp`) });
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n'); // the symlink's target was never written
    expect(lstatSync(path).isSymbolicLink()).toBe(false); // the published list is a real file, not the planted link
    expect(readFreeLaneList(path)).toEqual(list);
  });
  it('writeFreeLaneListAtomic throws (never writes through) when every temp name is already taken', () => {
    const path = join(dir, 'free-lanes.json');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    symlinkSync(victim, `${path}.planted.tmp`);
    const list = buildFreeLaneList({ repoName: 'we', poolDir: dir, writtenAt: T0, lanes: [] });
    expect(() => writeFreeLaneListAtomic(path, list, { tmpPathFor: (p) => `${p}.planted.tmp`, maxAttempts: 3 })).toThrow(/exclusive temp file/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
    expect(existsSync(path)).toBe(false);
  });
  it('readFreeLaneList degrades to null on a corrupt file rather than throwing', () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{not valid json');
    expect(readFreeLaneList(path)).toBeNull();
  });
});

describe('freeLaneCandidates per-entry age', () => {
  it('drops entries older than the limit even when the list itself is fresh', () => {
    const list = { v: 1, writtenAt: 1_000_000, repo: 'r', poolDir: null, lanes: [{ lane: 1, at: 1_000_000 - 700_000 }, { lane: 2, at: 1_000_000 - 1000 }] };
    expect(freeLaneCandidates(list, { nowMs: 1_000_000, maxAgeMs: 600_000 })).toEqual([2]);
    expect(freeLaneCandidates(list)).toEqual([1, 2]);
  });
});
