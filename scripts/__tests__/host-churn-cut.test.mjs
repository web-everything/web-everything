/**
 * @file scripts/__tests__/host-churn-cut.test.mjs
 * @description Host churn cut (2026-10-04) — the two health-watch-pass git cuts:
 *   1. `watchLanePoolHealth` no longer re-runs `git status --porcelain` for a lane its own `status` scan just
 *      reported `clean: true` (a dirty/unknown row is still re-read fresh; env knob restores the old re-read).
 *   2. `refreshSalvageIndex` re-judges an unlanded salvage entry only when its lane's branch tip moved (or its
 *      snapshot tips changed) — not ~1,400 git children every pass over ~300 entries. A memo can only delay a
 *      "landed" mark, never make one.
 *   Both fail on main before this change (re-read count / verdict call count).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchLanePoolHealth } from '../conveyor/lane-pool-health-watch.mjs';
import { refreshSalvageIndex, readSalvageIndex, landedCheckKey, branchShaReader } from '../lib/salvage-index.mjs';
import { readLaneLeases } from '../operations/agent-activity-io.mjs';

describe('health-watch: no porcelain re-read for a lane status just reported clean', () => {
  const lanes = [
    { lane: 1, path: '/p/lane-1', exists: true, leased: false, clean: true },
    { lane: 2, path: '/p/lane-2', exists: true, leased: false, clean: false },
    { lane: 3, path: '/p/lane-3', exists: true, leased: true, clean: true },
  ];
  const run = (extra = {}) => {
    const reads = [];
    const result = watchLanePoolHealth({
      listStatus: () => ({ lanes }), readPorcelain: (p) => { reads.push(p); return '?? stuff.txt\n'; },
      reap: () => ({ complete: true }), trimPool: () => null, listAcquirable: () => null, listWhois: () => null,
      reclaimEnabled: false, dryRun: true, ...extra,
    });
    return { reads, result };
  };
  it('re-reads only the dirty unleased lane', () => {
    const { reads, result } = run();
    expect(reads).toEqual(['/p/lane-2']);
    expect(result.plan.find((p) => p.lane === 1).action).toBe('already-clean');
  });
  it('rereadClean restores the old behaviour', () => {
    expect(run({ rereadClean: true }).reads).toEqual(['/p/lane-1', '/p/lane-2']);
  });
});

describe('salvage index: landed verdict memoised per branch tip', () => {
  let root;
  const laneDir = () => join(root, 'lane-7');
  const writeRef = (sha) => {
    mkdirSync(join(laneDir(), '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(join(laneDir(), '.git', 'refs', 'remotes', 'origin', 'main'), `${sha}\n`);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'salvage-memo-'));
    writeRef('a'.repeat(40));
    const entry = { ts: new Date().toISOString(), lane: 7, stamp: '20261004-1200', dir: laneDir(), snapshots: [{ headSha: 'b'.repeat(40) }] };
    writeFileSync(join(root, 'index.jsonl'), `${JSON.stringify(entry)}\n`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('judges once per branch tip; re-judges when the tip moves', () => {
    let calls = 0;
    const isLanded = () => { calls++; return false; };
    refreshSalvageIndex({ root, isLanded, memo: true });
    refreshSalvageIndex({ root, isLanded, memo: true });
    expect(calls).toBe(1);
    expect(readSalvageIndex(root)[0].landedCheck).toBe(`${'a'.repeat(40)}:${'b'.repeat(40)}`);
    writeRef('c'.repeat(40));
    refreshSalvageIndex({ root, isLanded, memo: true });
    expect(calls).toBe(2);
  });

  it('memo off (WE_SALVAGE_LANDED_MEMO=0) judges every pass', () => {
    let calls = 0;
    const isLanded = () => { calls++; return false; };
    refreshSalvageIndex({ root, isLanded, memo: false });
    refreshSalvageIndex({ root, isLanded, memo: false });
    expect(calls).toBe(2);
  });

  it('a landed verdict is still marked, and never memoised as not-landed', () => {
    const r = refreshSalvageIndex({ root, isLanded: () => true, memo: true });
    expect(r.landed).toHaveLength(1);
    const e = readSalvageIndex(root)[0];
    expect(e.landed).toBe(true);
    expect(e.landedCheck).toBeUndefined();
  });

  it('key covers the snapshot tips; reader falls back to packed-refs', () => {
    expect(landedCheckKey({ snapshots: [{ headSha: 'h', wipSha: 'w' }, { headSha: 'h2' }] }, 'S')).toBe('S:w,h2');
    rmSync(join(laneDir(), '.git', 'refs'), { recursive: true });
    writeFileSync(join(laneDir(), '.git', 'packed-refs'), `# pack-refs\n${'d'.repeat(40)} refs/remotes/origin/main\n`);
    expect(branchShaReader('origin/main')(laneDir())).toBe('d'.repeat(40));
  });
});

describe('agent-activity lease read skips the git probe for unleased lanes', () => {
  it('asks lane-pool status for --leased-only (lease fields are identical; only git fields drop)', () => {
    let argv = null;
    const run = (_bin, args) => { argv = args; return JSON.stringify({ lanes: [{ lane: 1, lease: { session: 's' } }, { lane: 2, lease: null }] }); };
    expect(readLaneLeases({ run, root: '/r' })).toEqual([{ session: 's' }]);
    expect(argv).toEqual(['/r/scripts/lane-pool.mjs', 'status', '--json', '--leased-only']);
  });
});
