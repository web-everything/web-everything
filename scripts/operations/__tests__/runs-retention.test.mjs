/** @file runs-retention.test.mjs — R549 archive-then-delete retention on a fixture runs dir. */
import { renameSync, writeFileSync, symlinkSync, mkdtempSync, mkdirSync, rmSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { newRunRecord } from '../run-record.mjs';
import { listRunIds, writeRun } from '../run-store.mjs';
import { runsRetention, defaultTarCreate, resolveRetentionSettings } from '../runs-retention-core.mjs';

const DAY = 86400000;
let root, runs, drive, settings;
const NOW = Date.parse('2026-11-03T12:00:00-05:00');
const put = (id, ageDays, patch = {}) => {
  writeRun({ ...newRunRecord({ id, op: patch.op ?? 'x' }), cursor: 1, ...patch }, runs);
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(join(runs, `${id}.json`), t, t);
};
const base = (extra = {}) => runsRetention({ runsDir: runs, now: NOW, settings, dryRun: false, freeGiB: () => 500, isComplete: () => true, ...extra });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'we-runs-ret-'));
  runs = join(root, 'runs'); mkdirSync(runs);
  mkdirSync(join(root, 'My Drive'));
  drive = join(root, 'My Drive', 'WE-archive', 'runs');
  settings = { keepDays: 14, archiveDir: drive, minFreeGiB: 30, batchMaxGiB: 4, batchMaxCompressedGiB: 2 };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runsRetention', () => {
  it('archives an old terminal record, verifies read-back, then deletes it', () => {
    put('run-old', 30); put('run-new', 1);
    const r = base();
    expect(r.errors).toEqual([]);
    expect(r.archived).toBe(1); expect(r.deleted).toBe(1);
    expect(listRunIds(runs)).toEqual(['run-new']);
    expect(r.archives).toHaveLength(1);
    expect(existsSync(r.archives[0])).toBe(true);
    expect(r.archives[0]).toMatch(/\/2026-10\/runs-2026-10-001\.tar\.(zst|gz)$/);
  });

  it('dry-run (the default) reports counts and bytes and changes nothing', () => {
    put('run-old', 30);
    const r = runsRetention({ runsDir: runs, now: NOW, settings, isComplete: () => true });
    expect(r.dryRun).toBe(true); expect(r.eligible).toBe(1); expect(r.eligibleBytes).toBeGreaterThan(0);
    expect(listRunIds(runs)).toEqual(['run-old']);
    expect(existsSync(drive)).toBe(false);
  });

  it('keeps non-terminal records however old, and parked review runs a resume could need', () => {
    put('run-live', 90, { effects: [{ key: 'a', type: 'dispatch', stepIndex: 0, index: 0, status: 'in-flight', handle: 'h' }] });
    put('run-pend', 90, { effects: [{ key: 'b', type: 'dispatch', stepIndex: 0, index: 0, status: 'pending' }] });
    put('run-parked', 90, { op: 'review-pr', verdict: { verdict: 'needs-human' } });
    const r = base();
    expect(r.archived).toBe(0);
    expect(listRunIds(runs).sort()).toEqual(['run-live', 'run-parked', 'run-pend']);
    expect(r.kept.nonTerminal).toBe(2); expect(r.kept.resumable).toBe(1);
  });

  it('a failed read-back means NO delete (and no final archive left behind)', () => {
    put('run-old', 30);
    const r = base({ tarList: () => ['./run-other.json'] });
    expect(r.deleted).toBe(0);
    expect(r.errors.join()).toMatch(/read-back mismatch/);
    expect(listRunIds(runs)).toEqual(['run-old']);
    expect(readdirSync(join(drive, '2026-10'))).toEqual([]);
  });

  it('pauses on low free disk and touches nothing', () => {
    put('run-old', 30);
    const r = base({ freeGiB: () => 5 });
    expect(r.status).toBe('paused-low-disk');
    expect(listRunIds(runs)).toEqual(['run-old']);
  });

  it('retains originals when the archive target is not mounted', () => {
    put('run-old', 30);
    const r = base({ settings: { ...settings, archiveDir: join(root, 'no-mount', 'WE-archive', 'runs') } });
    expect(r.status).toBe('skipped');
    expect(listRunIds(runs)).toEqual(['run-old']);
  });

  it('a record rewritten after selection is archived but NOT deleted', () => {
    put('run-old', 30);
    const r = base({ tarCreate: (dest, dir, names, codec) => {
      defaultTarCreate(dest, dir, names, codec);
      writeFileSync(join(dir, names[0]), '{"changed":true}');
    } });
    expect(r.deleted).toBe(0); expect(listRunIds(runs)).toEqual(['run-old']);
  });

  it('keeps records with PR evidence unless the setting opts in', () => {
    put('run-pr', 30, { effects: [{ key: 'a', type: 'open-pr', stepIndex: 0, index: 0, status: 'applied', result: { pr: 7 } }] });
    expect(base().archived).toBe(0);
    expect(listRunIds(runs)).toEqual(['run-pr']);
    expect(base({ settings: { ...settings, archivePrEvidence: true } }).deleted).toBe(1);
  });

  it('a concurrent lock refuses to run (never two archivers)', () => {
    put('run-old', 30);
    mkdirSync(join(drive, '..'), { recursive: true }); mkdirSync(join(drive, '..', '.runs-retention.lock'));
    const r = base();
    expect(r.status).toBe('skipped'); expect(listRunIds(runs)).toEqual(['run-old']);
  });

  it('keeps a never-advanced (cursor 0) record and skips symlinks', () => {
    put('run-zero', 30, { cursor: 0 });
    put('run-real', 30);
    symlinkSync(join(runs, 'run-real.json'), join(runs, 'run-link.json'));
    const r = base({ isComplete: rec => rec.cursor > 0 });
    expect(listRunIds(runs).sort()).toEqual(['run-link', 'run-zero']);
    expect(r.deleted).toBe(1);
  });

  it('a content mismatch in the archive blocks deletion', () => {
    put('run-old', 30);
    const r = base({ verifyContents: () => { throw new Error('archive content mismatch'); } });
    expect(r.deleted).toBe(0); expect(listRunIds(runs)).toEqual(['run-old']);
  });

  it('keeps a record whose cursor has not reached the declared last step', () => {
    put('run-mid', 30);
    const r = base({ isComplete: () => false });
    expect(r.deleted).toBe(0); expect(listRunIds(runs)).toEqual(['run-mid']);
  });

  it('restores a record parked by an interrupted pass', () => {
    put('run-x', 1);
    renameSync(join(runs, 'run-x.json'), join(runs, '.retiring-run-x.123e4567-e89b-12d3-a456-426614174000'));
    base();
    expect(listRunIds(runs)).toEqual(['run-x']);
  });

  it('settings: defaults to 14 days / 30 GiB; env overrides; invalid throws', () => {
    expect(resolveRetentionSettings({ env: {}, tool: {} }).keepDays).toBe(14);
    expect(resolveRetentionSettings({ env: { WE_RUNS_RETENTION_KEEP_DAYS: '3' }, tool: {} }).keepDays).toBe(3);
    expect(() => resolveRetentionSettings({ env: { WE_RUNS_RETENTION_MIN_FREE_GIB: '-1' }, tool: {} })).toThrow(/invalid/);
  });
});
