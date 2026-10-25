import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRoundSnapshot, writeRoundSnapshot, roundSnapshotPath, readRoundSnapshotSetting } from '../drain-round-snapshot.mjs';

describe('catch-up round snapshot', () => {
  const withDir = fn => { const dir = mkdtempSync(join(tmpdir(), 'round-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
  it('reuses rows only for the same repo, wanted fields, and an age under the max', () => withDir(dir => {
    const path = join(dir, 'r.json');
    const rows = [{ number: 1 }];
    expect(readRoundSnapshot({ path, repo: 'o/r', fields: 'number', maxAgeSec: 120 })).toEqual({ rows: null, why: 'not written yet' });
    expect(writeRoundSnapshot({ path, repo: 'o/r', fields: 'number,files,updatedAt', rows, now: 1_000_000 })).toBe(true);
    expect(readRoundSnapshot({ path, repo: 'o/r', fields: 'number,updatedAt', maxAgeSec: 120, now: 1_060_000 })).toEqual({ rows, ageMs: 60_000 });
    expect(readRoundSnapshot({ path, repo: 'o/r', fields: 'number', maxAgeSec: 120, now: 1_120_000 }).why).toMatch(/^stale/);
    expect(readRoundSnapshot({ path, repo: 'x/y', fields: 'number', maxAgeSec: 120, now: 1_010_000 }).why).toBe('unusable file');
    expect(readRoundSnapshot({ path, repo: 'o/r', fields: 'number,labels', maxAgeSec: 120, now: 1_010_000 }).why).toBe('missing fields labels');
    expect(readRoundSnapshot({ path, repo: 'o/r', fields: 'number', maxAgeSec: 120, now: 999_000 }).why).toBe('bad captured-at');
    expect(readRoundSnapshot({ path, repo: 'o/r', fields: 'number', maxAgeSec: 0, now: 1_010_000 }).why).toBe('disabled');
    writeFileSync(path, '{');
    expect(readRoundSnapshot({ path, repo: 'o/r', fields: 'number', maxAgeSec: 120 }).rows).toBeNull();
  }));
  it('names one file per daemon round and prunes files older than an hour', () => withDir(dir => {
    const old = join(dir, 'o_r-1-r1.json');
    const foreign = join(dir, 'keep.json');
    for (const f of [old, foreign]) { writeFileSync(f, '{}'); utimesSync(f, new Date(0), new Date(0)); }
    expect(roundSnapshotPath({ dir, repo: 'o/r', round: 3, pid: 7 })).toBe(join(dir, 'o_r-7-r3.json'));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  }));
  it('resolves the max age through the cascade', () => {
    expect(readRoundSnapshotSetting({ env: { VITEST: '1' }, tool: {}, platform: {} })).toEqual({ maxAgeSec: 120, source: 'standard' });
    expect(readRoundSnapshotSetting({ env: { VITEST: '1', WE_DRAIN_ROUND_SNAPSHOT_MAX_AGE_SEC: '0' }, tool: {}, platform: {} }).maxAgeSec).toBe(0);
  });
});
