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
