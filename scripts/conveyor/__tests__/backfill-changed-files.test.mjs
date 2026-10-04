import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  needsBackfill, planBackfill, resolveFileLists, applyBackfill,
} from '../backfill-changed-files.mjs';
import { readStore, writeStore } from '../run-scorecard-store.mjs';

const dirs = [];
function tempStorePath(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'we-backfill-test-'));
  dirs.push(dir);
  const path = join(dir, 'run-scorecards.json');
  writeStore(initial, { path });
  return path;
}

afterEach(() => {
  while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ } }
});

const missRow = (over = {}) => ({
  provider: 'codex', model: 'gpt-6-astra', dispatchKind: 'session-delegation', outcome: 'reworked',
  taskType: 'bugfix', taskDescription: 'x', scoredAt: '2026-09-15T03:40:00.000Z', pr: null, ...over,
});

describe('needsBackfill', () => {
  it('is true for a row with a real pr and no changedFiles', () => {
    expect(needsBackfill({ pr: 2223 })).toBe(true);
  });
  it('is false when changedFiles is already an array (idempotent skip), even an empty one', () => {
    expect(needsBackfill({ pr: 2223, changedFiles: [] })).toBe(false);
    expect(needsBackfill({ pr: 2223, changedFiles: ['a.mjs'] })).toBe(false);
  });
  it('is false with no pr, a null pr, or a non-positive pr', () => {
    expect(needsBackfill({})).toBe(false);
    expect(needsBackfill({ pr: null })).toBe(false);
    expect(needsBackfill({ pr: 0 })).toBe(false);
    expect(needsBackfill({ pr: -1 })).toBe(false);
  });
});

describe('planBackfill', () => {
  it('groups rows by (repo, pr) into ONE target, even when several rows share a PR', () => {
    const store = {
      records: [
        { dispatchKind: 'session-delegation', pr: 2223, outcome: 'landed' },
        { dispatchKind: 'review-seat', pr: 2223, repo: 'o/n', outcome: null },
        { dispatchKind: 'review-seat', pr: 2223, repo: 'o/n', outcome: null },
      ],
    };
    const { targets, rows } = planBackfill(store, 'o/n');
    expect(targets).toEqual([{ repo: 'o/n', pr: 2223 }]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('falls back to the default repo for a row that carries none of its own (session-delegation shape)', () => {
    const { targets } = planBackfill({ records: [{ pr: 9, outcome: 'landed' }] }, 'fallback/repo');
    expect(targets).toEqual([{ repo: 'fallback/repo', pr: 9 }]);
  });

  it('skips a row that already has changedFiles — idempotent', () => {
    const { targets, rows } = planBackfill({ records: [{ pr: 9, changedFiles: ['a.mjs'] }] }, 'o/n');
    expect(targets).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('reports a reworked/rejected row with pr:null under noPr, and writes nothing for it', () => {
    const { targets, rows, noPr } = planBackfill({ records: [missRow()] }, 'o/n');
    expect(targets).toEqual([]);
    expect(rows).toEqual([]);
    expect(noPr).toHaveLength(1);
    expect(noPr[0].outcome).toBe('reworked');
  });

  it('never lists a clean (landed) row with no pr under noPr — only reworked/rejected misses are informative there', () => {
    const { noPr } = planBackfill({ records: [{ outcome: 'landed', pr: null }] }, 'o/n');
    expect(noPr).toEqual([]);
  });

  it('reproduces the real store shape: the two 2026-09-15 astra bugfix misses have pr:null and land in noPr', () => {
    const rowsFromRealStore = [
      missRow({ taskDescription: 'Harden codex-direct-task.mjs / gemini-direct-task.mjs — round 1 of 3' }),
      missRow({ taskDescription: 'Harden codex-direct-task.mjs / gemini-direct-task.mjs — round 2 of 3' }),
    ];
    const { rows, noPr } = planBackfill({ records: rowsFromRealStore }, 'web-everything/web-everything');
    expect(rows).toEqual([]);
    expect(noPr).toHaveLength(2);
    expect(noPr.every((n) => n.model === 'gpt-6-astra' && n.taskType === 'bugfix')).toBe(true);
  });
});

describe('resolveFileLists', () => {
  it('records the files a successful lookup returns', () => {
    const map = resolveFileLists([{ repo: 'o/n', pr: 1 }], { listFiles: () => ['a.mjs', 'b.mjs'] });
    expect(map.get('o/n#1')).toEqual({ files: ['a.mjs', 'b.mjs'], reason: null });
  });
  it('records a reason, never throws, when the lookup fails', () => {
    const map = resolveFileLists([{ repo: 'o/n', pr: 1 }], { listFiles: () => { throw new Error('gh: not found'); } });
    expect(map.get('o/n#1').files).toBeNull();
    expect(map.get('o/n#1').reason).toMatch(/gh: not found/);
  });
  it('records a reason for an empty result rather than treating it as "touched nothing"', () => {
    const map = resolveFileLists([{ repo: 'o/n', pr: 1 }], { listFiles: () => [] });
    expect(map.get('o/n#1')).toEqual({ files: null, reason: expect.any(String) });
  });
});

describe('applyBackfill', () => {
  it('writes changedFiles onto the planned rows and backs up the store first', () => {
    const path = tempStorePath({ version: 1, records: [{ pr: 2223, outcome: 'landed', dispatchKind: 'session-delegation' }] });
    const { rows } = planBackfill(readStore({ path }), 'o/n');
    const fileLists = new Map([['o/n#2223', { files: ['a.mjs', 'b.mjs'], reason: null }]]);
    let backedUp = null;
    const result = applyBackfill({ rows, fileLists, path, backup: (p) => { backedUp = p; } });
    expect(result.applied).toBe(true);
    expect(result.patched).toBe(1);
    expect(backedUp).toBe(path);
    const after = readStore({ path });
    expect(after.records[0].changedFiles).toEqual(['a.mjs', 'b.mjs']);
    // every OTHER field is untouched
    expect(after.records[0].outcome).toBe('landed');
    expect(after.records[0].dispatchKind).toBe('session-delegation');
  });

  it('never writes a row it could not resolve files for', () => {
    const path = tempStorePath({ version: 1, records: [{ pr: 2223, outcome: 'landed' }] });
    const { rows } = planBackfill(readStore({ path }), 'o/n');
    const fileLists = new Map([['o/n#2223', { files: null, reason: 'gh failed' }]]);
    const result = applyBackfill({ rows, fileLists, path, backup: () => {} });
    expect(result.patched).toBe(0);
    expect(result.skippedNoFiles).toHaveLength(1);
    expect(readStore({ path }).records[0].changedFiles).toBeUndefined();
  });

  it('is idempotent — a second apply over the same store patches nothing further', () => {
    const path = tempStorePath({ version: 1, records: [{ pr: 2223, outcome: 'landed' }] });
    const first = planBackfill(readStore({ path }), 'o/n');
    const fileLists = new Map([['o/n#2223', { files: ['a.mjs'], reason: null }]]);
    applyBackfill({ rows: first.rows, fileLists, path, backup: () => {} });

    const second = planBackfill(readStore({ path }), 'o/n');
    expect(second.rows).toEqual([]); // already filled — nothing left to plan
  });

  it('skips (never clobbers) a row that changed since the plan was built', () => {
    const path = tempStorePath({ version: 1, records: [{ pr: 2223, outcome: 'landed' }] });
    const { rows } = planBackfill(readStore({ path }), 'o/n');
    // Simulate a concurrent writer editing the row between plan and apply.
    const mid = readStore({ path });
    mid.records[0] = { ...mid.records[0], outcome: 'reworked' };
    writeStore(mid, { path });

    const fileLists = new Map([['o/n#2223', { files: ['a.mjs'], reason: null }]]);
    const result = applyBackfill({ rows, fileLists, path, backup: () => {} });
    expect(result.patched).toBe(0);
    expect(result.skippedStale).toBe(1);
    expect(readStore({ path }).records[0].outcome).toBe('reworked'); // the concurrent write survives, untouched by us
  });

  it('backs up the real file on disk (default backup) before writing', () => {
    const path = tempStorePath({ version: 1, records: [{ pr: 2223, outcome: 'landed' }] });
    const { rows } = planBackfill(readStore({ path }), 'o/n');
    const fileLists = new Map([['o/n#2223', { files: ['a.mjs'], reason: null }]]);
    applyBackfill({ rows, fileLists, path }); // default backup this time
    const dir = path.slice(0, path.lastIndexOf('/'));
    const entries = readdirSync(dir);
    expect(entries.some((f) => f.includes('pre-backfill-4034b'))).toBe(true);
  });
});
