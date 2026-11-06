/**
 * @file free-lane-list.test.mjs — proof of the #4122 free-lane-list core: parse/freshness/build/candidate
 *   ordering (pure), plus the atomic-write/read IO shell round trip. See `free-lane-list.mjs`'s own header for
 *   the incident this exists to fix (`acquire` measured 240s / `list --acquirable` 66s under load, against
 *   acquire's 180s wait, while 30+ lanes sat free) and why the list is a HINT, never trusted alone.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { sharedRepos } from '../../__tests__/fixtures/shared-git-fixture.mjs';
import { laneStateSnapshot } from '../lane-history.mjs';
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
  isProvablyCleanAndPushed,
  touchFreeLaneList,
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

describe('isProvablyCleanAndPushed (the shared no-reset / release-publication bar)', () => {
  const ok = { workDirty: 0, unpushedCommits: 0, ahead: 0 };
  it.each([
    ['clean + pushed', ok, {}, true],
    ['litter-only dirt is already folded into workDirty=0', { ...ok, dirty: 2 }, {}, true],
    ['real dirt', { ...ok, workDirty: 1 }, {}, false],
    ['an unpushed commit', { ...ok, unpushedCommits: 1 }, {}, false],
    ['failed dirt probe (null)', { ...ok, workDirty: null }, {}, false],
    ['failed unpushed probe (null)', { ...ok, unpushedCommits: null }, {}, false],
    ['missing fields', {}, {}, false],
    ['no snapshot', null, {}, false],
    ['ahead of origin is fine without requireInSync', { ...ok, ahead: 2 }, {}, true],
    ['ahead of origin fails requireInSync', { ...ok, ahead: 2 }, { requireInSync: true }, false],
    ['unknown ahead fails requireInSync', { ...ok, ahead: null }, { requireInSync: true }, false],
  ])('%s', (_name, snap, opts, expected) => {
    expect(isProvablyCleanAndPushed(snap, opts)).toBe(expected);
  });
});

describe('touchFreeLaneList cost budget (runs on every acquire, release and trim)', () => {
  // PR #6357 send-back: the event refresh must stay cheap — one small read + one atomic write, never a pool rescan.
  // Budget: under 50ms per touch on average with a 35-lane list (measured well under 1ms locally). The list must
  // still hold all 35 entries at the end, so pruning cannot make the loop trivially fast.
  it('a touch on a 35-lane list averages under 50ms and keeps every entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-lane-touch-budget-'));
    try {
      const path = join(dir, 'free.json');
      const now = Date.now();
      writeFreeLaneListAtomic(path, buildFreeLaneList({ repoName: 'r', poolDir: dir, writtenAt: now, lanes: Array.from({ length: 35 }, (_, i) => ({ lane: i + 1, path: join(dir, `lane-${i + 1}`), at: now })) }));
      const touches = 20;
      const t0 = performance.now();
      for (let i = 0; i < touches; i++) expect(touchFreeLaneList({ path, repoName: 'r', poolDir: dir, lane: (i % 35) + 1, free: true, now: now + i })).toBe(true);
      const avgMs = (performance.now() - t0) / touches;
      expect(readFreeLaneList(path).lanes).toHaveLength(35);
      expect(avgMs).toBeLessThan(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The event-refresh logic in-process (PR #6357 send-back R547: these were real spawned lane-pool children before).
describe('touchFreeLaneList', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'free-lane-touch-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const touch = (lane, now, extra = {}) => touchFreeLaneList({ path: join(dir, 'l.json'), repoName: 'r', poolDir: '/p', lane, free: true, now, ...extra });
  const lanes = () => readFreeLaneList(join(dir, 'l.json')).lanes;

  it('adds/removes one entry, keeps the others, stamps now, and never throws', () => {
    expect(touch(3, 100)).toBe(true);
    touch(1, 200);
    touch(3, 300, { free: false });
    expect(lanes().map((x) => x.lane)).toEqual([1]);
    expect(readFreeLaneList(join(dir, 'l.json')).writtenAt).toBe(300);
    expect(lanes()[0]).toMatchObject({ lane: 1, path: join('/p', 'lane-1'), at: 200 });
    writeFileSync(join(dir, 'not-a-dir.json'), 'x'); // a file where a directory is needed: the write fails, never throws
    expect(touchFreeLaneList({ path: join(dir, 'not-a-dir.json', 'x.json'), repoName: 'r', poolDir: '/p', lane: 1, free: true })).toBe(false);
    expect(touch(-1, 400)).toBe(false); // not a lane number
  });

  it('a removal of a lane that is not listed still stamps the list fresh (the acquire/trim event)', () => {
    touch(2, 100);
    touch(5, 500, { free: false });
    expect(lanes().map((x) => x.lane)).toEqual([2]);
    expect(readFreeLaneList(join(dir, 'l.json')).writtenAt).toBe(500);
  });

  it('prunes carried entries older than the max age, so a touch never freshens old candidates', () => {
    touch(3, 0);
    touch(4, 30_000);
    touch(5, 700_000, { maxAgeMs: 600_000 });
    expect(lanes().map((x) => x.lane)).toEqual([5]);
  });

  it('unrelated touches preserve an entry\'s ORIGINAL timestamp, so it still expires at its original time', () => {
    touch(3, 0, { maxAgeMs: 600_000 });
    touch(4, 300_000, { maxAgeMs: 600_000 }); // unrelated touch: lane 3 must keep at=0
    expect(lanes().find((x) => x.lane === 3).at).toBe(0);
    touch(5, 700_000, { maxAgeMs: 600_000 }); // lane 3 (at 0) is past the limit and pruned; lane 4 (at 300,000) is not
    expect(lanes().map((x) => [x.lane, x.at])).toEqual([[4, 300_000], [5, 700_000]]);
  });

  it('drops a carried entry stamped in the future (clock skew cannot keep it alive)', () => {
    touch(3, 1_000_000);
    touch(4, 0);
    expect(lanes().map((x) => x.lane)).toEqual([4]);
  });
});

// The release publication bar on REAL git states (one shared origin + lane clone per file, restored after every
// test — never re-cloned). This is the exact pair lane-pool's release runs:
// `isProvablyCleanAndPushed(laneStateSnapshot(dir, 'origin/<branch>'), { requireInSync: true })`; a reserved lease
// passes no snapshot at all. The --no-reset acquire guard's own git cases run end to end in
// scripts/__tests__/lane-pool-free-list-event-refresh.test.mjs.
describe('release publication bar on real git states', () => {
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
  let root, origin, lane, fixture;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'free-lane-release-bar-'));
    origin = join(root, 'origin.git');
    lane = join(root, 'lane');
    git(['init', '-q', '--bare', '--initial-branch=trunk', origin], root);
    git(['clone', '-q', origin, lane], root);
    git(['config', 'user.email', 't@t'], lane);
    git(['config', 'user.name', 't'], lane);
    writeFileSync(join(lane, 'file.txt'), 'v1\n');
    git(['add', 'file.txt'], lane);
    git(['commit', '-q', '-m', 'v1'], lane);
    git(['push', '-q', 'origin', 'HEAD:refs/heads/trunk'], lane);
    git(['fetch', '-q', 'origin'], lane);
    fixture = sharedRepos(root, [origin, lane]);
  });
  afterEach(() => fixture.restore());
  afterAll(() => fixture.dispose());

  const publishes = () => isProvablyCleanAndPushed(laneStateSnapshot(lane, 'origin/trunk'), { requireInSync: true });
  const commit = (file, msg) => { writeFileSync(join(lane, file), `${msg}\n`); git(['add', file], lane); git(['commit', '-q', '-m', msg], lane); };

  it('a clean lane level with origin is published', () => {
    expect(publishes()).toBe(true);
  });
  it('a lane whose only dirt is known scratch litter is published', () => {
    writeFileSync(join(lane, '.pr-body.md'), 'scratch\n');
    expect(publishes()).toBe(true);
  });
  it('a dirty tracked file is not published', () => {
    writeFileSync(join(lane, 'file.txt'), 'dirty tracked edit\n');
    expect(publishes()).toBe(false);
  });
  it('an untracked non-litter file is not published', () => {
    writeFileSync(join(lane, 'notes.txt'), 'real work\n');
    expect(publishes()).toBe(false);
  });
  it('an unpushed commit is not published', () => {
    commit('new.txt', 'unpushed');
    expect(publishes()).toBe(false);
  });
  it('a commit pushed to a lane/* branch but not on the integration branch is not published (not in sync)', () => {
    commit('feat.txt', 'feature');
    git(['push', '-q', 'origin', 'HEAD:refs/heads/lane/feat'], lane);
    git(['fetch', '-q', 'origin'], lane);
    expect(publishes()).toBe(false);
  });
  it('a commit that survives only in a STALE tracking ref (branch deleted on origin) is not published', () => {
    commit('wip.txt', 'stale-ref-work');
    git(['push', '-q', 'origin', 'HEAD:refs/heads/lane/gone'], lane);
    git(['update-ref', '-d', 'refs/heads/lane/gone'], origin);
    expect(git(['rev-parse', 'refs/remotes/origin/lane/gone'], lane)).toBe(git(['rev-parse', 'HEAD'], lane));
    expect(publishes()).toBe(false);
  });
  it('a squash-merged commit whose branch was pruned is not published (release is stricter than the scan)', () => {
    commit('feat.txt', 'feature');
    const squash = join(root, 'squash');
    git(['clone', '-q', '--branch', 'trunk', origin, squash], root);
    try {
      writeFileSync(join(squash, 'feat.txt'), 'feature\n');
      git(['add', 'feat.txt'], squash);
      git(['-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-q', '-m', 'feature (squashed)'], squash);
      git(['push', '-q', 'origin', 'HEAD:refs/heads/trunk'], squash);
    } finally { rmSync(squash, { recursive: true, force: true }); }
    git(['fetch', '-q', '--prune', 'origin'], lane);
    expect(publishes()).toBe(false);
  });
  it('a lane that is not a git checkout at all fails closed', () => {
    expect(isProvablyCleanAndPushed(laneStateSnapshot(join(root, 'nope'), 'origin/trunk'), { requireInSync: true })).toBe(false);
  });
  it('a reserved lease passes no snapshot and is never published', () => {
    expect(isProvablyCleanAndPushed(null, { requireInSync: true })).toBe(false);
  });
});
