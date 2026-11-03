/**
 * @file scripts/lib/__tests__/disk-cleanup.test.mjs
 * @description R498 — automatic disk cleanup. Each refusal is pinned: a snapshot a running job or a live
 *   registration still uses, a rebuild dir with a running job, and a lane with a lease / unpushed commits /
 *   a process cwd / a stash. Deletions are logged with size and reason; dry-run deletes nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DISK_CLEANUP_DEFAULTS, pruneSnapshots, pruneRebuildDirs, trimIdleLanes, runDiskCleanup } from '../disk-cleanup.mjs';

let root, jobs, state;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 16, 0, 0);

function snap(daemon, sub, key, ageH) {
  const d = join(jobs, daemon, '.snapshots', sub, key);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'f'), 'x');
  const t = new Date(NOW - ageH * HOUR);
  utimesSync(d, t, t);
}
function record(daemon, id, status, extra = {}) {
  mkdirSync(join(jobs, daemon), { recursive: true });
  writeFileSync(join(jobs, daemon, `${id}.json`), JSON.stringify({ id, job: { status, snapshotKeys: [], pid: null, ...extra } }));
}
function age(path, hours) { const t = new Date(NOW - hours * HOUR); utimesSync(path, t, t); }
const sizeOf = () => 1024;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'we-disk-cleanup-'));
  jobs = join(root, 'jobs'); state = join(root, 'state');
  mkdirSync(jobs); mkdirSync(state);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('settings', () => {
  it('has defaults for every knob', () => {
    expect(DISK_CLEANUP_DEFAULTS).toMatchObject({ keepSnapshots: 2, rebuildMaxAgeHours: expect.any(Number), laneCap: expect.any(Number) });
  });
});

describe('pruneSnapshots', () => {
  beforeEach(() => {
    for (const [i, k] of ['aaa', 'bbb', 'ccc', 'ddd'].entries()) snap('verify-daemon', 'code', k, i + 1);
  });
  it('keeps the newest N and logs size + reason for each deletion', () => {
    const log = [];
    const r = pruneSnapshots({ jobsDir: jobs, stateDir: state, keep: 2, dryRun: false, processCommands: [], sizeOf, log: (e) => log.push(e) });
    expect(r.removed.map((x) => x.ref).sort()).toEqual(['code:ccc', 'code:ddd']);
    expect(existsSync(join(jobs, 'verify-daemon/.snapshots/code/ddd'))).toBe(false);
    expect(existsSync(join(jobs, 'verify-daemon/.snapshots/code/aaa'))).toBe(true);
    expect(log[0]).toMatchObject({ bytes: 1024, reason: expect.stringContaining('keep') });
  });
  it('dry run deletes nothing but reports the same list', () => {
    const r = pruneSnapshots({ jobsDir: jobs, stateDir: state, keep: 2, dryRun: true, processCommands: [], sizeOf, log() {} });
    expect(r.removed).toHaveLength(2);
    expect(existsSync(join(jobs, 'verify-daemon/.snapshots/code/ddd'))).toBe(true);
  });
  it('REFUSES a snapshot pinned by a running job', () => {
    record('verify-daemon', 'job-1', 'running', { snapshotKeys: ['code:ddd'] });
    const r = pruneSnapshots({ jobsDir: jobs, stateDir: state, keep: 2, dryRun: false, processCommands: [], sizeOf, log() {} });
    expect(existsSync(join(jobs, 'verify-daemon/.snapshots/code/ddd'))).toBe(true);
    expect(r.removed.map((x) => x.ref)).not.toContain('code:ddd');
  });
  it('REFUSES a snapshot named by a live registration (daemon state file)', () => {
    writeFileSync(join(state, 'verify.ready.json'), JSON.stringify({ codeSha: 'ddd' }));
    pruneSnapshots({ jobsDir: jobs, stateDir: state, keep: 2, dryRun: false, processCommands: [], sizeOf, log() {} });
    expect(existsSync(join(jobs, 'verify-daemon/.snapshots/code/ddd'))).toBe(true);
  });
  it('REFUSES a snapshot a live process command line points into', () => {
    const cmd = `node ${join(jobs, 'verify-daemon/.snapshots/code/ccc')}/scripts/x.mjs`;
    pruneSnapshots({ jobsDir: jobs, stateDir: state, keep: 2, dryRun: false, processCommands: [cmd], sizeOf, log() {} });
    expect(existsSync(join(jobs, 'verify-daemon/.snapshots/code/ccc'))).toBe(true);
  });
});

describe('unknown pins fail closed', () => {
  it('skips snapshot pruning when a registration file is unreadable', () => {
    for (const [i, k] of ['aaa', 'bbb', 'ccc', 'ddd'].entries()) snap('verify-daemon', 'code', k, i + 1);
    writeFileSync(join(state, 'bad.json'), '{'.repeat(2_000_000));
    const r = pruneSnapshots({ jobsDir: jobs, stateDir: state, keep: 2, processCommands: [], sizeOf, log() {} });
    expect(r.removed).toEqual([]);
    expect(existsSync(join(jobs, 'verify-daemon/.snapshots/code/ddd'))).toBe(true);
  });
  it('skips a daemon with a malformed job record and refuses a null process list', () => {
    for (const [i, k] of ['aaa', 'bbb', 'ccc', 'ddd'].entries()) snap('verify-daemon', 'code', k, i + 1);
    writeFileSync(join(jobs, 'verify-daemon', 'job-x.json'), 'not json');
    expect(pruneSnapshots({ jobsDir: jobs, stateDir: state, keep: 2, processCommands: [], sizeOf, log() {} }).removed).toEqual([]);
    rmSync(join(jobs, 'verify-daemon', 'job-x.json'));
    expect(pruneSnapshots({ jobsDir: jobs, stateDir: state, keep: 2, processCommands: null, sizeOf, log() {} }).removed).toEqual([]);
  });
});

describe('pruneRebuildDirs', () => {
  const mk = (name, status, hours, extra) => {
    record(name, 'job-a', status, extra);
    age(join(jobs, name, 'job-a.json'), hours); age(join(jobs, name), hours);
  };
  const base = { stateDir: state, maxAgeHours: 12, now: NOW, sizeOf, isPidAlive: () => false, processCommands: [], log() {} };
  it('deletes a stale finished rebuild dir, logging size and reason', () => {
    mk('rebuild-old', 'succeeded', 30);
    const log = [];
    const r = pruneRebuildDirs({ jobsDir: jobs, dryRun: false, ...base, log: (e) => log.push(e) });
    expect(existsSync(join(jobs, 'rebuild-old'))).toBe(false);
    expect(r.removed[0]).toMatchObject({ bytes: 1024 });
    expect(log[0].reason).toMatch(/older than 12h/);
  });
  it('keeps a recent dir', () => {
    mk('rebuild-new', 'succeeded', 2);
    pruneRebuildDirs({ jobsDir: jobs, dryRun: false, ...base });
    expect(existsSync(join(jobs, 'rebuild-new'))).toBe(true);
  });
  it('REFUSES a dir with a non-terminal job even when old', () => {
    mk('rebuild-run', 'running', 48);
    pruneRebuildDirs({ jobsDir: jobs, dryRun: false, ...base });
    expect(existsSync(join(jobs, 'rebuild-run'))).toBe(true);
  });
  it('REFUSES a dir whose recorded pid is alive', () => {
    mk('rebuild-pid', 'succeeded', 48, { pid: 4242 });
    pruneRebuildDirs({ jobsDir: jobs, dryRun: false, ...base, isPidAlive: (p) => p === 4242 });
    expect(existsSync(join(jobs, 'rebuild-pid'))).toBe(true);
  });
  it('REFUSES a dir a live process command mentions', () => {
    mk('rebuild-cmd', 'succeeded', 48);
    pruneRebuildDirs({ jobsDir: jobs, dryRun: false, ...base, processCommands: [`tail ${join(jobs, 'rebuild-cmd')}/x.log`] });
    expect(existsSync(join(jobs, 'rebuild-cmd'))).toBe(true);
  });
  it('never touches non-rebuild dirs and honours dry run', () => {
    mk('verify-daemon', 'succeeded', 99); mk('rebuild-old', 'succeeded', 99);
    pruneRebuildDirs({ jobsDir: jobs, dryRun: true, ...base });
    expect(existsSync(join(jobs, 'rebuild-old'))).toBe(true);
    pruneRebuildDirs({ jobsDir: jobs, dryRun: false, ...base });
    expect(existsSync(join(jobs, 'verify-daemon'))).toBe(true);
  });
});

describe('trimIdleLanes', () => {
  const lanes = [1, 2, 3, 4].map((n) => ({ n, dir: `/lanes/lane-${n}` }));
  const idle = { lease: false, cwdInUse: false, unpushed: false, stash: false, dirty: false };
  const run = (inspectMap, cap = 2, dryRun = false) => {
    const removed = []; const log = [];
    const r = trimIdleLanes({ lanes, cap, dryRun, inspect: (l) => ({ ...idle, ...(inspectMap[l.n] || {}) }),
      sizeOf, removeLane: (l) => removed.push(l.n), log: (e) => log.push(e) });
    return { r, removed, log };
  };
  it('removes the highest-numbered idle lanes above the cap', () => {
    expect(run({}).removed).toEqual([4, 3]);
  });
  it('dry run removes nothing', () => {
    const { r, removed } = run({}, 2, true);
    expect(removed).toEqual([]); expect(r.removed).toHaveLength(2);
  });
  it.each([['lease'], ['unpushed'], ['cwdInUse'], ['stash'], ['dirty']])('REFUSES a lane with %s', (why) => {
    const { removed, r } = run({ 4: { [why]: true } });
    expect(removed).not.toContain(4);
    expect(removed).toEqual([3, 2]);
    expect(r.refused.find((x) => x.n === 4).reason).toContain(why);
  });
  it('REFUSES a lane that took a lease between the first look and the delete', () => {
    let calls = 0;
    const removed = [];
    trimIdleLanes({ lanes, cap: 3, inspect: (l) => ({ ...idle, lease: l.n === 4 && ++calls > 1 }), sizeOf, removeLane: (l) => removed.push(l.n) });
    expect(removed).not.toContain(4);
  });
  it('stops removing once enough space is free', () => {
    const removed = [];
    trimIdleLanes({ lanes, cap: 1, inspect: () => idle, sizeOf, removeLane: (l) => removed.push(l.n), enough: () => removed.length >= 1 });
    expect(removed).toEqual([4]);
  });
  it('does nothing at or under the cap', () => {
    expect(run({}, 4).removed).toEqual([]);
  });
});

describe('runDiskCleanup', () => {
  const deps = (over = {}) => ({ stateDir: state, jobsDir: jobs, processCommands: [], sizeOf, isPidAlive: () => false, now: NOW,
    lanes: [], inspectLane: () => ({}), removeLane() {}, log() {}, ...over });
  it('does nothing when free space is above the threshold and not forced', () => {
    snap('verify-daemon', 'code', 'a', 5); snap('verify-daemon', 'code', 'b', 4); snap('verify-daemon', 'code', 'c', 3);
    const r = runDiskCleanup({ ...deps(), freeGb: () => 80, minGb: 30, settings: DISK_CLEANUP_DEFAULTS, dryRun: false });
    expect(r.ran).toBe(false);
  });
  it('runs lanes (step c) only while still under the threshold after a and b', () => {
    let removed = 0;
    const lanes = [1, 2, 3].map((n) => ({ n, dir: `/l/${n}` }));
    const d = deps({ lanes, removeLane: () => { removed++; } });
    runDiskCleanup({ ...d, freeGb: () => 90, minGb: 30, settings: { ...DISK_CLEANUP_DEFAULTS, laneCap: 1 }, dryRun: false, force: true });
    expect(removed).toBe(0);
    runDiskCleanup({ ...d, freeGb: () => 5, minGb: 30, settings: { ...DISK_CLEANUP_DEFAULTS, laneCap: 1 }, dryRun: false });
    expect(removed).toBe(2);
  });
});
