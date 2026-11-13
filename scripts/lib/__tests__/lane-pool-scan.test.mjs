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

describe('firstProvenFreeLanes (acquire fast path while another caller holds the shared scan lock)', () => {
  it('returns the first free lanes without probing the rest of a 90-lane pool', async () => {
    const { firstProvenFreeLanes } = await import('../lane-pool-scan.mjs');
    const lanes = Array.from({ length: 90 }, (_, i) => i + 1);
    const probed = [];
    const probe = (n) => { probed.push(n); return n > 20; }; // 1..20 held, 21+ free
    expect(firstProvenFreeLanes(lanes, { probe, limit: 3 })).toEqual([21, 22, 23]);
    expect(probed.length).toBe(23); // a long full-pool scan is never needed when free lanes exist
  });

  it('skips excluded lanes and stops at the deadline, keeping what it proved', async () => {
    const { firstProvenFreeLanes } = await import('../lane-pool-scan.mjs');
    let now = 0;
    const probe = (n) => { now += 10; return true; };
    const out = firstProvenFreeLanes([1, 2, 3, 4, 5, 6], { probe, limit: 5, exclude: new Set([1, 2]), deadlineMs: 25, nowFn: () => now });
    expect(out).toEqual([3, 4, 5]); // 3 probes of 10ms hit the 25ms budget; the rest are not probed
  });

  it('a probe that throws is "not proven free", never a hand-out', async () => {
    const { firstProvenFreeLanes } = await import('../lane-pool-scan.mjs');
    const probe = (n) => { if (n === 1) throw new Error('git hung'); return n === 2; };
    expect(firstProvenFreeLanes([1, 2, 3], { probe, limit: 2 })).toEqual([2]);
  });
});
