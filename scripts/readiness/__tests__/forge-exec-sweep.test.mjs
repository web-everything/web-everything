// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect} from 'vitest';
import {mkdtemp, mkdir, writeFile, rm, utimes, stat, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {sweep, DEFAULT_BUDGET} from '../forge-exec-sweep.mjs';

// R951c S3: per-RUN cleaning of slot run dirs, presync keys and receipts.
const H = 3_600_000, now = Date.UTC(2026, 10, 15, 12);
const run = n => 'r-' + String(n).padStart(32, '0');
const key = n => String(n).padStart(32, 'a');
const exists = p => stat(p).then(() => true, () => false);
let tmp, root, receipts;
const age = async (path, hours) => { const t = new Date(now - hours * H); await utimes(path, t, t); };
async function runDir(slot, n, hours, bytes = 100) {
  const dir = join(root, 'slot-' + slot, run(n));
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'f'), 'x'.repeat(bytes));
  await age(join(dir, 'f'), hours); await age(dir, hours);
  return dir;
}
async function reserve(slot, n) {
  const dir = join(receipts, 'worker-active-' + slot);
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'reservation.json'), JSON.stringify({run: run(n), writerGuard: 1, slot: 'forge-exec-' + slot}));
}
async function receipt(name, hours) {
  const file = join(receipts, name); await writeFile(file, '{}'); await age(file, hours); return file;
}
async function presyncKey(n, hours) {
  const dir = join(root, 'presync', key(n));
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'blob'), 'y'.repeat(50));
  await age(join(dir, 'blob'), hours); await age(dir, hours);
  return dir;
}
const free = {lock: async () => ({release: async () => {}})};
const go = (extra = {}) => sweep({root, receipts, now, apply: true, ...free, ...extra});
beforeEach(async () => {
  tmp = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'forge-exec-sweep-'));
  root = join(tmp, 'exec'); receipts = join(tmp, 'receipts');
  await mkdir(join(root, 'slot-1'), {recursive: true}); await mkdir(join(root, 'slot-2'), {recursive: true});
  await mkdir(join(root, 'presync'), {recursive: true}); await mkdir(receipts, {recursive: true});
});
afterEach(async () => { await rm(tmp, {recursive: true, force: true}); });

describe('slot run dirs are cleaned per run, not per slot', () => {
  it('keeps the reserved run while other old runs in the same slot are deleted', async () => {
    const reserved = await runDir(1, 1, 50), old = await runDir(1, 2, 50), other = await runDir(2, 3, 50);
    await reserve(1, 1); await reserve(2, 9); // worker-active-K exists for every slot
    const summary = await go();
    expect(await exists(reserved)).toBe(true);
    expect(await exists(old)).toBe(false);
    expect(await exists(other)).toBe(false);
    expect(summary.counts.runDirs).toBe(2);
    expect(summary.bytes.runDirs).toBeGreaterThanOrEqual(200);
  });
  it('keeps a run with a live .prepared, .running or .receipt record', async () => {
    const dirs = [];
    for (const [i, phase] of ['prepared', 'running', 'receipt'].entries()) {
      dirs.push(await runDir(1, 10 + i, 50)); await receipt(run(10 + i) + '.' + phase, 50);
    }
    await go();
    for (const d of dirs) expect(await exists(d)).toBe(true);
  });
  it('keeps runs younger than the leak age (default 3 h) and deletes older', async () => {
    const young = await runDir(1, 20, 2), older = await runDir(1, 21, 4);
    await go();
    expect(await exists(young)).toBe(true);
    expect(await exists(older)).toBe(false);
    expect(DEFAULT_BUDGET.slots.leakAgeHours).toBe(3);
  });
  it('skips a slot whose lock is busy (a skip, not a refusal) and still cleans the others', async () => {
    const busy = await runDir(1, 30, 50), clean = await runDir(2, 31, 50);
    const summary = await go({lock: async name => name === 'worker-active-1' ? null : {release: async () => {}}});
    expect(await exists(busy)).toBe(true);
    expect(await exists(clean)).toBe(false);
    expect(summary.skips).toEqual([expect.objectContaining({consumer: 'slots', slot: 'slot-1'})]);
    expect(summary.refusals).toEqual([]);
  });
  it('reads the reservation under the lock and releases it afterwards', async () => {
    const events = [];
    await runDir(1, 40, 50);
    await go({lock: async name => { events.push('lock ' + name); return {release: async () => { events.push('release ' + name); }}; }});
    expect(events).toEqual(['lock worker-active-1', 'release worker-active-1', 'lock worker-active-2', 'release worker-active-2']);
  });
  it('keeps everything in a slot whose reservation is unreadable', async () => {
    const dir = await runDir(1, 50, 50);
    await mkdir(join(receipts, 'worker-active-1'));
    await writeFile(join(receipts, 'worker-active-1', 'reservation.json'), '{not json');
    const summary = await go();
    expect(await exists(dir)).toBe(true);
    expect(summary.skips.concat(summary.refusals).length).toBeGreaterThan(0);
  });
  it('does not follow a symlinked run entry', async () => {
    const outside = join(tmp, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'k');
    await symlink(outside, join(root, 'slot-1', run(60)));
    await go();
    expect(await exists(join(outside, 'keep'))).toBe(true);
  });
  it('also cleans old unreserved warm- run dirs (previous cron namespace) and keeps a reserved one', async () => {
    const warm = n => join(root, 'slot-1', 'warm-' + String(n).padStart(32, '0'));
    await mkdir(warm(1)); await mkdir(warm(2)); await age(warm(1), 50); await age(warm(2), 50);
    await mkdir(join(receipts, 'worker-active-1'), {recursive: true});
    await writeFile(join(receipts, 'worker-active-1', 'reservation.json'), JSON.stringify({run: 'warm-' + '2'.padStart(32, '0'), writerGuard: 1}));
    await go();
    expect(await exists(warm(1))).toBe(false);
    expect(await exists(warm(2))).toBe(true);
  });
  it('--dry-run (apply false) deletes nothing but reports the same candidates', async () => {
    const old = await runDir(1, 70, 50);
    const summary = await go({apply: false});
    expect(await exists(old)).toBe(true);
    expect(summary.apply).toBe(false);
    expect(summary.counts.runDirs).toBe(1);
    expect(summary.candidates.runDirs).toEqual([old.slice(root.length + 1)]);
  });
});

describe('presync keys', () => {
  it('deletes keys idle more than 72 h, keeps younger ones, never touches keys under 24 h', async () => {
    const stale = await presyncKey(1, 80), mid = await presyncKey(2, 30), young = await presyncKey(3, 5);
    const summary = await go();
    expect(await exists(stale)).toBe(false);
    expect(await exists(mid)).toBe(true);
    expect(await exists(young)).toBe(true);
    expect(summary.counts.presyncKeys).toBe(1);
  });
  it('with a byte cap, deletes oldest first but only keys idle at least 24 h', async () => {
    const a = await presyncKey(1, 60), b = await presyncKey(2, 40), c = await presyncKey(3, 2);
    await go({budget: {presync: {capBytes: 1}}});
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(false);
    expect(await exists(c)).toBe(true);
  });
  it('a key with a recently written file inside stays even if its dir mtime is old', async () => {
    const dir = await presyncKey(4, 100);
    await age(join(dir, 'blob'), 1);
    await go();
    expect(await exists(dir)).toBe(true);
  });
  it('ignores entries that are not 32-hex keys', async () => {
    const odd = join(root, 'presync', 'not-a-key'); await mkdir(odd); await age(odd, 500);
    await go();
    expect(await exists(odd)).toBe(true);
  });
});

describe('receipts', () => {
  it('deletes .telemetry older than 48 h and .consumed older than 24 h only', async () => {
    const oldT = await receipt(run(1) + '.telemetry', 49), newT = await receipt(run(2) + '.telemetry', 30);
    const oldC = await receipt(run(3) + '.consumed', 25), newC = await receipt(run(4) + '.consumed', 10);
    await go();
    expect([await exists(oldT), await exists(newT), await exists(oldC), await exists(newC)]).toEqual([false, true, false, true]);
  });
  it('never touches the reserved run records, worker-active dirs or .writer locks', async () => {
    await reserve(1, 7);
    const mine = await receipt(run(7) + '.telemetry', 100);
    const writer = join(receipts, '.worker-active-1.writer'); await writeFile(writer, ''); await age(writer, 500);
    await go();
    expect(await exists(mine)).toBe(true);
    expect(await exists(writer)).toBe(true);
    expect(await exists(join(receipts, 'worker-active-1', 'reservation.json'))).toBe(true);
  });
  it('holds a 5,000-file cap per sweep', async () => {
    for (let i = 0; i < 5_050; i++) await writeFile(join(receipts, run(i) + '.consumed'), '{}');
    const files = (await import('node:fs/promises')).readdir;
    const t = new Date(now - 100 * H);
    await Promise.all((await files(receipts)).map(f => utimes(join(receipts, f), t, t)));
    const summary = await go();
    expect(summary.counts.receiptFiles).toBe(5_000);
    expect((await files(receipts)).length).toBe(50);
  }, 60_000);
});

describe('consumers are independent', () => {
  it('a refusal in one consumer does not stop the others and is reported', async () => {
    await rm(join(root, 'presync'), {recursive: true}); await writeFile(join(root, 'presync'), 'not a directory');
    const old = await runDir(1, 80, 50), oldR = await receipt(run(81) + '.telemetry', 100);
    const summary = await go();
    expect(summary.refusals).toEqual([expect.objectContaining({consumer: 'presync'})]);
    expect(await exists(old)).toBe(false);
    expect(await exists(oldR)).toBe(false);
  });
});
