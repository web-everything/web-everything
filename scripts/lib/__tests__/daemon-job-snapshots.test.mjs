import { removeReadonlyTree } from '../readonly-tree.mjs';
/**
 * @file scripts/lib/__tests__/daemon-job-snapshots.test.mjs
 * @description #4125 — pinned code snapshots and lockfile-keyed `node_modules` stores: built once, never
 *   used half-built, the store keyed by the lockfile (two commits with one lockfile share it), a real
 *   `git archive` snapshot, and eviction (unreferenced stores go, at most 2 kept).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, chmodSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { finishRunTmpRoot } from '../test-tmp-root.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codeRef, ensureCodeSnapshot, ensureNodeModulesStore, evictSnapshots, linkNodeModules, lockfileKey, nodeModulesRef, snapshotsRoot,
} from '../daemon-job-snapshots.mjs';

let jobsDir;
beforeEach(() => { jobsDir = mkdtempSync(join(tmpdir(), 'we-job-snapshots-')); });
afterEach(() => { removeReadonlyTree(jobsDir); });

describe('read-only tree cleanup', () => {
  it('global temp teardown removes nested frozen stores and tolerates an absent root', () => {
    const root = join(jobsDir, 'run');
    const bin = join(root, 'jobs/.snapshots/node-modules/key/node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'tool'), 'fixture');
    chmodSync(bin, 0o555);
    chmodSync(join(bin, '..'), 0o555);
    expect(() => finishRunTmpRoot({ root, policy: { mode: 'off', keep: false } })).not.toThrow();
    expect(existsSync(root)).toBe(false);
    expect(() => removeReadonlyTree(root)).not.toThrow();
  });

  it('removes directory and dangling symlinks without thawing their targets', () => {
    const target = join(jobsDir, 'external');
    const root = join(jobsDir, 'owned');
    mkdirSync(target);
    writeFileSync(join(target, 'payload'), 'untouched');
    chmodSync(target, 0o555);
    mkdirSync(root);
    symlinkSync(target, join(root, 'node_modules'), 'dir');
    symlinkSync(join(jobsDir, 'missing'), join(root, 'dangling'), 'dir');
    removeReadonlyTree(root);
    expect(existsSync(root)).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o555);
    expect(readFileSync(join(target, 'payload'), 'utf8')).toBe('untouched');
    const link = join(jobsDir, 'root-link');
    symlinkSync(target, link, 'dir');
    removeReadonlyTree(link);
    expect(statSync(target).mode & 0o777).toBe(0o555);
  });
});

describe('code snapshots', () => {
  it('builds once and reuses the finished snapshot', () => {
    let builds = 0;
    const materialize = (into) => { builds += 1; writeFileSync(join(into, 'a.txt'), 'v1'); };
    const dir = ensureCodeSnapshot({ jobsDir, codeSha: 'abc', materialize });
    ensureCodeSnapshot({ jobsDir, codeSha: 'abc', materialize });
    expect(builds).toBe(1);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('v1');
  });

  it('never leaves a half-built snapshot in place', () => {
    expect(() => ensureCodeSnapshot({ jobsDir, codeSha: 'bad', materialize: (into) => { writeFileSync(join(into, 'x'), ''); throw new Error('tar died'); } })).toThrow(/tar died/);
    expect(existsSync(join(snapshotsRoot(jobsDir), 'code', 'bad'))).toBe(false);
  });

  it('refuses a codeSha that is not a safe directory name', () => {
    expect(() => ensureCodeSnapshot({ jobsDir, codeSha: '../x', materialize: () => {} })).toThrow(/codeSha/);
  });

  it('extracts a real commit with git archive', () => {
    const repo = join(jobsDir, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(repo, 'f.txt'), 'pinned');
    git('add', 'f.txt');
    git('commit', '-qm', 'one');
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'f.txt'), 'moved on');
    const dir = ensureCodeSnapshot({ jobsDir, codeSha: sha, repoDir: repo });
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('pinned');
  });
});

describe('node_modules stores', () => {
  const source = (lock) => {
    const d = mkdtempSync(join(jobsDir, 'src-'));
    writeFileSync(join(d, 'package.json'), '{}');
    writeFileSync(join(d, 'package-lock.json'), lock);
    return d;
  };

  it('keys the store by the lockfile, so two snapshots with one lockfile share one install', () => {
    let installs = 0;
    const install = (into) => { installs += 1; mkdirSync(join(into, 'node_modules')); };
    const a = ensureNodeModulesStore({ jobsDir, sourceDir: source('{"v":1}'), install });
    const b = ensureNodeModulesStore({ jobsDir, sourceDir: source('{"v":1}'), install });
    const c = ensureNodeModulesStore({ jobsDir, sourceDir: source('{"v":2}'), install });
    expect(a.key).toBe(lockfileKey('{"v":1}'));
    expect(b.dir).toBe(a.dir);
    expect(c.key).not.toBe(a.key);
    expect(installs).toBe(2);
    const snap = ensureCodeSnapshot({ jobsDir, codeSha: 's1', materialize: () => {} });
    expect(readlinkSync(linkNodeModules(snap, a.dir))).toBe(join(a.dir, 'node_modules'));
  });
});

describe('evictSnapshots', () => {
  it('removes unreferenced stores beyond two, never a referenced one', () => {
    const shas = ['s1', 's2', 's3', 's4'];
    shas.forEach((sha, i) => {
      const dir = ensureCodeSnapshot({ jobsDir, codeSha: sha, materialize: () => {} });
      utimesSync(dir, 1000 + i, 1000 + i);
    });
    const { evicted } = evictSnapshots({ jobsDir, referenced: [codeRef('s1'), nodeModulesRef('none')] });
    expect([...evicted].sort()).toEqual([codeRef('s2'), codeRef('s3')]);
    const left = shas.filter((s) => existsSync(join(snapshotsRoot(jobsDir), 'code', s)));
    expect(left).toEqual(['s1', 's4']);
  });

  it('dry run reports without deleting', () => {
    for (const sha of ['a', 'b', 'c']) ensureCodeSnapshot({ jobsDir, codeSha: sha, materialize: () => {} });
    const { evicted } = evictSnapshots({ jobsDir, referenced: [], dryRun: true });
    expect(evicted).toHaveLength(1);
    expect(['a', 'b', 'c'].every((s) => existsSync(join(snapshotsRoot(jobsDir), 'code', s)))).toBe(true);
  });
});
