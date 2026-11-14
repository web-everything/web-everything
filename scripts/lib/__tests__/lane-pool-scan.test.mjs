/**
 * @file lane-pool-scan.test.mjs — the shared host-wide pool walk must skip, never throw on, a non-directory
 * entry (live 2026-10-04: `~/workspace/.lanes/.metadata_never_index` failed every verify-daemon tick with ENOTDIR).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { laneIndicesIn, poolsWithLanes } from '../lane-pool-scan.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lane-pool-scan-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('lane-pool-scan', () => {
  it('skips files, empty dirs and dangling symlinks at the root; returns only pools with lane-N children', () => {
    mkdirSync(join(root, 'web-everything', 'lane-10'), { recursive: true });
    mkdirSync(join(root, 'web-everything', 'lane-2'), { recursive: true });
    mkdirSync(join(root, 'frontierui', 'lane-1'), { recursive: true });
    mkdirSync(join(root, 'scratch-empty'));
    writeFileSync(join(root, '.metadata_never_index'), '');
    writeFileSync(join(root, 'web-everything', '.DS_Store'), '');
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));
    expect(poolsWithLanes(root)).toEqual(['frontierui', 'web-everything']);
    expect(laneIndicesIn(join(root, 'web-everything'))).toEqual([2, 10]);
  });

  it('never throws: a file, a missing path, or an unreadable dir is simply []', () => {
    writeFileSync(join(root, 'f'), '');
    expect(laneIndicesIn(join(root, 'f'))).toEqual([]);
    expect(laneIndicesIn(join(root, 'missing'))).toEqual([]);
    expect(poolsWithLanes(join(root, 'missing'))).toEqual([]);
    const readdir = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
    expect(laneIndicesIn(root, { readdir })).toEqual([]);
  });
});

describe('partial free-lane hand-off (a waiter takes lanes a running scan already proved free)', () => {
  const owner = { pid: 4242, host: 'h', startedAt: 1000 };

  it('a waiter reads the lanes the lock holder has proven so far, without scanning anything itself', async () => {
    const { publishPartialFree, readPartialFree } = await import('../lane-pool-scan.mjs');
    const lockDir = join(root, 'lock'); mkdirSync(lockDir);
    expect(readPartialFree(lockDir, owner)).toEqual([]); // nothing proven yet
    publishPartialFree(lockDir, owner, ['/p/lane-21', '/p/lane-22']);
    expect(readPartialFree(lockDir, owner)).toEqual(['/p/lane-21', '/p/lane-22']);
    publishPartialFree(lockDir, owner, ['/p/lane-21', '/p/lane-22', '/p/lane-23']);
    expect(readPartialFree(lockDir, owner)).toHaveLength(3);
  });

  it('ignores a partial written by a different (earlier) lock holder, a corrupt file, or a missing dir', async () => {
    const { publishPartialFree, readPartialFree } = await import('../lane-pool-scan.mjs');
    const lockDir = join(root, 'lock2'); mkdirSync(lockDir);
    publishPartialFree(lockDir, { pid: 1, host: 'h', startedAt: 5 }, ['/p/lane-1']);
    expect(readPartialFree(lockDir, owner)).toEqual([]);
    writeFileSync(join(lockDir, 'partial.json'), '{not json');
    expect(readPartialFree(lockDir, owner)).toEqual([]);
    expect(readPartialFree(join(root, 'missing'), owner)).toEqual([]);
    expect(() => publishPartialFree(join(root, 'missing'), owner, ['/p/lane-1'])).not.toThrow();
  });
});

describe('resetBlockedByProbe (reset-time re-verify fails closed on an unknown tree)', () => {
  it('a failed status probe reads as dirty even when it reported zero uncommitted files', async () => {
    const { resetBlockedByProbe } = await import('../lane-pool-scan.mjs');
    expect(resetBlockedByProbe({ dirty: false, probeFailed: true })).toBe(true);
    expect(resetBlockedByProbe({ dirty: true, probeFailed: false })).toBe(true);
    expect(resetBlockedByProbe({ dirty: false, probeFailed: false })).toBe(false);
    expect(resetBlockedByProbe({ dirty: false })).toBe(false);
  });
});
