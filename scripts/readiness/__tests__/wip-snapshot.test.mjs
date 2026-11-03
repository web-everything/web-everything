// @vitest-environment node
// R497 step 2: the shadow WIP snapshot builds a tree without touching the lane (index, HEAD, refs, objects).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shadowSnapshot, shadowSnapshotStage, shadowSnapshotEnabled } from '../wip-snapshot.mjs';

let root, lane;
const git = (args, cwd = lane) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout; };
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const laneState = () => ({
  head: git(['rev-parse', 'HEAD']),
  refs: git(['for-each-ref']),
  index: spawnSync('shasum', ['-a', '256', join(lane, '.git/index')], { encoding: 'utf8' }).stdout,
  objects: walk(join(lane, '.git/objects')).sort().join('\n'),
  status: git(['status', '--porcelain', '--ignored']),
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wip-snap-')));
  lane = join(root, 'lane'); mkdirSync(lane);
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(lane, '.gitignore'), 'ignored/\nnode_modules/\n');
  writeFileSync(join(lane, 'a.txt'), 'a\n');
  git(['add', '.']); git(['-c', 'user.name=f', '-c', 'user.email=f@x.invalid', 'commit', '-qm', 'base']);
  // WIP: modified tracked, untracked, deleted, ignored test-shaped + ignored junk + node_modules
  writeFileSync(join(lane, 'a.txt'), 'changed\n');
  writeFileSync(join(lane, 'new.mjs'), 'x\n');
  mkdirSync(join(lane, 'ignored/__tests__'), { recursive: true });
  writeFileSync(join(lane, 'ignored/__tests__/t.test.mjs'), 't\n');
  writeFileSync(join(lane, 'ignored/junk.bin'), 'j\n');
  mkdirSync(join(lane, 'node_modules/p/__tests__'), { recursive: true });
  writeFileSync(join(lane, 'node_modules/p/__tests__/x.test.js'), 'n\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const readTree = (r) => spawnSync('git', ['ls-tree', '-r', '--name-only', r.tree], { cwd: lane, encoding: 'utf8', env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: r.scratchObjects } }).stdout.split('\n').filter(Boolean).sort();

describe('shadowSnapshot', () => {
  it('builds the WIP tree incl. untracked and force-added ignored test files, never node_modules/junk', async () => {
    const r = await shadowSnapshot({ cwd: lane, keepScratch: true });
    expect(r.ok).toBe(true);
    expect(r.ignoredAdded).toBe(1);
    expect(readTree(r)).toEqual(['.gitignore', 'a.txt', 'ignored/__tests__/t.test.mjs', 'new.mjs']);
    expect(r.fileCount).toBe(4);
    rmSync(join(r.scratchObjects, '..'), { recursive: true, force: true });
  });

  it('leaves the lane index, HEAD, refs, objects and status untouched', async () => {
    const before = laneState();
    const r = await shadowSnapshot({ cwd: lane });
    expect(r.ok).toBe(true);
    expect(laneState()).toEqual(before);
    expect(() => git(['cat-file', '-e', r.tree])).toThrow(); // the snapshot objects never reached the lane ODB
  });

  it('ignores GIT_* redirection inherited from the caller', async () => {
    const before = laneState();
    const r = await shadowSnapshot({ cwd: lane, env: { ...process.env, GIT_INDEX_FILE: join(lane, '.git/index'), GIT_OBJECT_DIRECTORY: join(lane, '.git/objects') } });
    expect(r.ok).toBe(true);
    expect(laneState()).toEqual(before);
  });

  it('never throws: a non-repo is recorded as an error', async () => {
    const r = await shadowSnapshot({ cwd: root });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/git/);
    expect(typeof r.durationMs).toBe('number');
  });

  it('never throws when git itself throws, and cleans its scratch dir', async () => {
    const r = await shadowSnapshot({ cwd: lane, git: async () => { throw new Error('boom'); } });
    expect(r).toMatchObject({ ok: false, error: 'boom' });
  });
});

describe('shadowSnapshotStage', () => {
  it('records the duration through begin() and stays shadow-only', async () => {
    const stages = [];
    const begin = (stage) => { const item = { stage }; stages.push(item); return (extra) => Object.assign(item, extra); };
    const r = await shadowSnapshotStage({ cwd: lane, begin, env: {} });
    expect(r.ok).toBe(true);
    expect(stages).toEqual([{ stage: 'wip-snapshot-shadow', shadow: true, ok: true, ignoredAdded: 1, fileCount: 4, tree: r.tree }]);
  });
  it('records errors and continues', async () => {
    const stages = [];
    const begin = (stage) => { const item = { stage }; stages.push(item); return (extra) => Object.assign(item, extra); };
    const r = await shadowSnapshotStage({ cwd: root, begin, env: {} });
    expect(r.ok).toBe(false);
    expect(stages[0]).toMatchObject({ stage: 'wip-snapshot-shadow', ok: false });
    expect(stages[0].error).toBeTruthy();
  });
  it('survives a throwing begin/closer', async () => {
    const r = await shadowSnapshotStage({ cwd: lane, begin: () => { throw new Error('x'); }, env: {} });
    expect(r.ok).toBe(true);
    const r2 = await shadowSnapshotStage({ cwd: lane, begin: () => () => { throw new Error('y'); }, env: {} });
    expect(r2.ok).toBe(true);
  });
  it('is settings-gated: default on, off via WE_REMOTE_SHADOW_SNAPSHOT=0 or enabled:false', async () => {
    expect(shadowSnapshotEnabled({})).toBe(true);
    expect(shadowSnapshotEnabled({ WE_REMOTE_SHADOW_SNAPSHOT: '0' })).toBe(false);
    expect(shadowSnapshotEnabled({ WE_REMOTE_SHADOW_SNAPSHOT: 'off' })).toBe(false);
    expect(shadowSnapshotEnabled({}, false)).toBe(false);
    const stages = [];
    expect(await shadowSnapshotStage({ cwd: lane, begin: (s) => { stages.push(s); return () => {}; }, env: { WE_REMOTE_SHADOW_SNAPSHOT: '0' } })).toBeNull();
    expect(stages).toEqual([]);
  });
});
