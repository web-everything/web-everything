import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepReviewTmp, probeDiskSpace } from '../review-tmp-health.mjs';
import disk from '../health-smells/disk-space.mjs';
import { runHealthTick, emptyHealthState } from '../health-watch-core.mjs';
const busyScan = vi.hoisted(() => vi.fn(() => new Set()));
vi.mock('../tmp-sweep.mjs', () => ({ readBusyTopLevel: busyScan }));
const roots = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), 'we-review-tmp-test-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); busyScan.mockReset(); busyScan.mockReturnValue(new Set()); });
describe('review temporary storage health', () => {
  it('removes only expired seats and smoke dirs, preserving live owners and cwd holders', () => {
    const tmpRoot = root(); const now = Date.now();
    const make = (name, age) => {
      const p = join(tmpRoot, name); mkdirSync(p); writeFileSync(join(p, 'data'), '1234');
      utimesSync(p, new Date(now - age), new Date(now - age)); return p;
    };
    const expired = make('we-review-seat-abcdef', 121 * 60000);
    const smoke = make('we-overlay-dispatch-smoke-abcdef', 121 * 60000);
    const recheck = make('we-red-team-recheck-abcdef', 121 * 60000);
    const young = make('we-review-seat-young1', 119 * 60000);
    const busy = make('we-review-seat-busy12', 121 * 60000);
    const live = make('we-review-seat-live12', 121 * 60000);
    writeFileSync(`${live}.owner.json`, JSON.stringify({ pid: process.pid }));
    utimesSync(live, new Date(now - 121 * 60000), new Date(now - 121 * 60000));
    const other = make('unrelated-abcdef', 999 * 60000);
    const result = sweepReviewTmp({ tmpRoot, now, busy: new Set(['we-review-seat-busy12']), log: () => {} });
    expect(result.directories).toBe(3); expect(result.bytesFreed).toBe(12);
    for (const p of [expired, smoke, recheck]) expect(existsSync(p)).toBe(false);
    for (const p of [young, busy, live, other]) expect(existsSync(p)).toBe(true);
  });
  it('does not scan busy cwds until an expired scratch candidate needs it', () => {
    const tmpRoot = root(); mkdirSync(join(tmpRoot, 'we-review-seat-young'));
    sweepReviewTmp({ tmpRoot, log: () => {} });
    expect(busyScan).not.toHaveBeenCalled();
    for (const name of ['we-review-seat-old', 'we-red-team-recheck-old']) {
      const p = join(tmpRoot, name); mkdirSync(p); utimesSync(p, new Date(0), new Date(0));
    }
    expect(sweepReviewTmp({ tmpRoot, log: () => {} }).directories).toBe(2);
    expect(busyScan).toHaveBeenCalledTimes(1);
  });
  it('preserves checkouts when cwd observation fails while still capping caches', () => {
    const tmpRoot = root(); const seat = join(tmpRoot, 'we-review-seat-old'); mkdirSync(seat);
    utimesSync(seat, new Date(0), new Date(0));
    const cache = join(tmpRoot, 'we-backlog-index-test'); mkdirSync(cache); writeFileSync(join(cache, 'index'), 'cache');
    busyScan.mockImplementation(() => { throw new Error('lsof failed'); });
    const r = sweepReviewTmp({ tmpRoot, config: { tmp: { backlogIndexMaxMb: 0 } }, log: () => {} });
    expect(r.busy).toBe(1); expect(r.files).toBe(1); expect(existsSync(seat)).toBe(true);
  });
  it('never follows a scratch symlink or trusts a marker in the PR tree', () => {
    const tmpRoot = root(); const target = root();
    symlinkSync(target, join(tmpRoot, 'we-review-seat-link'));
    const seat = join(tmpRoot, 'we-review-seat-old'); mkdirSync(seat);
    writeFileSync(join(seat, '.we-review-owner.json'), JSON.stringify({ pid: process.pid }));
    utimesSync(seat, new Date(0), new Date(0));
    expect(sweepReviewTmp({ tmpRoot, busy: new Set(), log: () => {} }).directories).toBe(1);
    expect(existsSync(target)).toBe(true); expect(existsSync(seat)).toBe(false);
  });
  it('caps all backlog indexes together, evicting oldest files first', () => {
    const tmpRoot = root();
    const files = ['we-backlog-index-501', 'we-backlog-index-502'].map((name, i) => {
      const dir = join(tmpRoot, name); mkdirSync(dir); const f = join(dir, 'index.bin');
      writeFileSync(f, Buffer.alloc(1024)); utimesSync(f, new Date(1000 + i), new Date(1000 + i)); return f;
    });
    const r = sweepReviewTmp({ tmpRoot, config: { tmp: { backlogIndexMaxMb: 1 / 1024 } }, busy: new Set(), log: () => {} });
    expect(r.files).toBe(1); expect(r.bytesFreed).toBe(1024);
    expect(existsSync(files[0])).toBe(false); expect(existsSync(files[1])).toBe(true);
  });
  it('honors TTL overrides and dry run', () => {
    const tmpRoot = root(); const p = join(tmpRoot, 'we-review-seat-abcdef'); mkdirSync(p);
    const r = sweepReviewTmp({ tmpRoot, config: { tmp: { reviewSeatTtlMin: 0 } }, now: Date.now() + 1000, busy: new Set(), dryRun: true, log: () => {} });
    expect(r.directories).toBe(1); expect(existsSync(p)).toBe(true);
  });
  it.each([[30, false, false], [29.9, true, false], [10, true, false], [9.9, true, true]])('disk %s GiB thresholds', (freeGb, breach, critical) => {
    const [r] = disk.evaluate({ diskSpace: { freeGb } });
    expect(r.breach).toBe(breach); expect(r.measure.critical).toBe(critical);
    expect(r.escalation.status).toBe('needs-you');
  });
  it('uses the configured warning threshold and filesystem available blocks', () => {
    expect(disk.evaluate({ diskSpace: { freeGb: 35 } }, { config: { health: { diskFreeMinGb: 40 } } })[0].breach).toBe(true);
    expect(probeDiskSpace({ statfs: () => ({ bavail: 1024 ** 2, bsize: 1024 }) }).freeGb).toBe(1);
  });
  it('opens an immediate notifying human-only health episode', () => {
    const r = runHealthTick(emptyHealthState(), { diskSpace: { freeGb: 9 } }, [disk], Date.now());
    const ep = Object.values(r.state.episodes)[0];
    expect(ep.status).toBe('open'); expect(ep.measure.critical).toBe(true);
    expect(ep.escalation.humanOnly).toBe(true);
    expect(r.transitions.some(t => t.type === 'opened')).toBe(true);
  });
});
