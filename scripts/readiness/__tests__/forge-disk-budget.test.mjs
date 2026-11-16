// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_BUDGET, DEFAULT_BUDGET_PATH, parseBudget, loadBudget, runCli} from '../forge-disk-budget.mjs';

const TB = 1_000_000_000_000, GiB = 1024 ** 3;
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fdb-')); });
afterEach(() => { rmSync(dir, {recursive: true, force: true}); });
const put = (obj, raw) => { const p = join(dir, 'b.json'); writeFileSync(p, raw ?? JSON.stringify(obj)); return p; };
const clone = () => JSON.parse(JSON.stringify(DEFAULT_BUDGET));

describe('forge-disk-budget', () => {
  it('defaults match the design and the default path is /etc/forge-exec/disk-budget.json', () => {
    expect(DEFAULT_BUDGET_PATH).toBe('/etc/forge-exec/disk-budget.json');
    expect(DEFAULT_BUDGET.v).toBe(1);
    expect(DEFAULT_BUDGET.filesystem).toBe('/');
    expect(DEFAULT_BUDGET.alerts).toEqual({warnPct: 70, pagePct: 80, refuseRunsPct: 90});
    const c = DEFAULT_BUDGET.consumers;
    expect(c.cache).toEqual({pct: 20, maxAgeHours: 12, yieldAtPct: 65});
    expect(c.slots).toEqual({pct: 7, leakAgeHours: 3});
    expect(c.presync).toEqual({pct: 1, maxAgeHours: 72, minAgeHours: 24});
    expect(c.bases).toEqual({pct: 2});
    expect(c.receipts).toEqual({pct: 0.5, maxFiles: 5000, telemetryAgeHours: 48, consumedAgeHours: 24});
    expect(c.tmp).toEqual({pct: 2.5, maxAgeHours: 48});
    expect(c.ci.pct).toBe(12);
    expect(c.system).toEqual({pct: 4});
  });

  it('valid file -> source "file" with the file values', () => {
    const b = clone(); b.consumers.cache.pct = 25;
    const r = loadBudget({path: put(b), fsTotalBytes: TB});
    expect(r.source).toBe('file');
    expect(r.budget.consumers.cache.pct).toBe(25);
    expect(r.capsBytes.cache).toBe(250_000_000_000);
  });

  it('missing file -> defaults:missing-file', () => {
    const r = loadBudget({path: join(dir, 'nope.json'), fsTotalBytes: TB});
    expect(r.source).toBe('defaults:missing-file');
    expect(r.budget).toEqual(DEFAULT_BUDGET);
  });

  it('invalid JSON -> defaults:invalid-json', () => {
    expect(loadBudget({path: put(null, '{nope'), fsTotalBytes: TB}).source).toBe('defaults:invalid-json');
  });

  it('unknown key (top, consumer, nested) -> defaults with the reason naming the key', () => {
    for (const mut of [b => { b.extra = 1; }, b => { b.consumers.cache.bogus = 1; }, b => { b.consumers.mystery = {pct: 1}; }, b => { b.alerts.x = 1; }]) {
      const b = clone(); mut(b);
      const r = loadBudget({path: put(b), fsTotalBytes: TB});
      expect(r.source).toMatch(/^defaults:invalid:unknown-key/);
      expect(r.budget).toEqual(DEFAULT_BUDGET);
    }
  });

  it('shares over warnPct -> defaults:invalid:shares-exceed-warn', () => {
    const b = clone(); b.consumers.ci.pct = 40;
    expect(loadBudget({path: put(b), fsTotalBytes: TB}).source).toBe('defaults:invalid:shares-exceed-warn');
  });

  it('bad types, bad alert order, wrong version -> defaults', () => {
    for (const mut of [b => { b.consumers.cache.pct = '20'; }, b => { b.consumers.cache.pct = -1; }, b => { b.alerts.pagePct = 60; }, b => { b.v = 2; }, b => { delete b.consumers.tmp; }, b => { b.consumers.ci.paths = [1]; }]) {
      const b = clone(); mut(b);
      expect(loadBudget({path: put(b), fsTotalBytes: TB}).source).toMatch(/^defaults:invalid/);
    }
    expect(parseBudget([]).ok).toBe(false);
    expect(parseBudget(null).ok).toBe(false);
  });

  it('unreadable path (a directory) -> defaults, never throws', () => {
    expect(loadBudget({path: dir, fsTotalBytes: TB}).source).toMatch(/^defaults:/);
  });

  it('caps come from the real filesystem size, rounded down (1 TB and 1.8 TB)', () => {
    const a = loadBudget({path: join(dir, 'x'), fsTotalBytes: TB}).capsBytes;
    expect(a.cache).toBe(200_000_000_000);
    expect(a.receipts).toBe(5_000_000_000);
    expect(a.tmp).toBe(25_000_000_000);
    const big = loadBudget({path: join(dir, 'x'), fsTotalBytes: 1_800_000_000_000}).capsBytes;
    expect(big.cache).toBe(360_000_000_000);
    expect(big.slots).toBe(126_000_000_000);
    const odd = loadBudget({path: join(dir, 'x'), fsTotalBytes: 1001}).capsBytes;
    expect(odd.cache).toBe(200); // floor(200.2)
    expect(Number.isInteger(odd.receipts)).toBe(true);
    const gib = loadBudget({path: join(dir, 'x'), fsTotalBytes: 931 * GiB}).capsBytes;
    expect(gib.cache).toBe(Math.floor(931 * GiB * 0.2));
  });

  it('a bad fsTotalBytes yields no caps rather than NaN', () => {
    const r = loadBudget({path: join(dir, 'x'), fsTotalBytes: 0});
    expect(r.capsBytes).toBeNull();
  });

  it('CLI --json prints the resolved budget and returns 0', () => {
    let out = '';
    const code = runCli(['--json'], {write: s => { out += s; }, path: join(dir, 'x'), fsTotalBytes: TB});
    expect(code).toBe(0);
    const j = JSON.parse(out);
    expect(j.source).toBe('defaults:missing-file');
    expect(j.capsBytes.cache).toBe(200_000_000_000);
    expect(j.fsTotalBytes).toBe(TB);
  });

  it('yieldAtPct over 100 is invalid; tiny shares are not rounded up; unknown fs size fails the CLI', () => {
    const b = clone(); b.consumers.cache.yieldAtPct = 150;
    expect(loadBudget({path: put(b), fsTotalBytes: TB}).source).toBe('defaults:invalid:consumers.cache.yieldAtPct');
    const t = clone(); t.consumers.system.pct = 0.005;
    expect(loadBudget({path: put(t), fsTotalBytes: TB}).capsBytes.system).toBe(50_000_000);
    let out = '';
    expect(runCli(['--json'], {write: s => { out += s; }, path: join(dir, 'x'), fsTotalBytes: 0})).toBe(1);
    expect(JSON.parse(out).error).toBe('filesystem-size-unknown');
  });

  it('shares finer than 4 decimals are rejected; fallbacks are flagged degraded', () => {
    const t = clone(); t.consumers.system.pct = 0.0000006;
    const r = loadBudget({path: put(t), fsTotalBytes: TB});
    expect(r.source).toBe('defaults:invalid:consumers.system.pct-precision');
    expect(r.degraded).toBe(true);
    expect(loadBudget({path: put(clone()), fsTotalBytes: TB}).degraded).toBe(false);
  });
});

import {CONSUMER_NAMES, applyOutcome, runCleaners, writeStateAtomic, runBudget} from '../forge-disk-budget.mjs';

describe('refusal counter', () => {
  it('counts up on refused, resets on ok, keeps lastRefusal text', () => {
    let s = applyOutcome(undefined, { outcome: 'refused', reason: 'lock busy' }, 1000);
    expect(s.consecutiveRefused).toBe(1);
    s = applyOutcome(s, { outcome: 'refused', reason: 'bad reservation' }, 2000);
    expect(s.consecutiveRefused).toBe(2);
    expect(s.lastRefusal).toEqual({ reason: 'bad reservation', atMs: 2000 });
    s = applyOutcome(s, { outcome: 'ok', reclaimedBytes: 5 }, 3000);
    expect(s.consecutiveRefused).toBe(0);
    expect(s.outcome).toBe('ok');
    expect(s.reclaimedBytes).toBe(5);
    expect(s.lastRefusal).toEqual({ reason: 'bad reservation', atMs: 2000 });
  });
  it('a skip neither counts as a refusal nor resets it', () => {
    let s = applyOutcome(undefined, { outcome: 'refused', reason: 'r' }, 1);
    s = applyOutcome(s, { outcome: 'skipped' }, 2);
    expect(s.consecutiveRefused).toBe(1);
  });
  it('a throw counts as a refusal', () => {
    const s = applyOutcome(undefined, { outcome: 'error', reason: 'boom' }, 1);
    expect(s.consecutiveRefused).toBe(1);
  });
});

describe('runCleaners (scheduler)', () => {
  it('runs in order and one throwing cleaner does not stop the next', async () => {
    const order = [];
    const cleaners = [
      { name: 'a', run: async () => { order.push('a'); return { outcome: 'ok', reclaimedBytes: 1 }; } },
      { name: 'b', run: async () => { order.push('b'); throw new Error('boom'); } },
      { name: 'c', run: async () => { order.push('c'); return { outcome: 'refused', reason: 'locked' }; } },
      { name: 'd', run: () => { order.push('d'); return { outcome: 'ok' }; } },
    ];
    const out = await runCleaners({ cleaners, budget: DEFAULT_BUDGET, prev: {}, now: () => 10 });
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(out.cleaners.b.outcome).toBe('error');
    expect(out.cleaners.b.lastRefusal.reason).toMatch(/boom/);
    expect(out.cleaners.c.consecutiveRefused).toBe(1);
    expect(out.cleaners.d.outcome).toBe('ok');
    expect(out.anyFailed).toBe(true);
  });
  it('carries counters from previous state and resets on ok', async () => {
    const prev = { cleaners: { a: { consecutiveRefused: 2, outcome: 'refused' } } };
    const out = await runCleaners({
      cleaners: [{ name: 'a', run: () => ({ outcome: 'ok' }) }],
      budget: DEFAULT_BUDGET, prev, now: () => 5,
    });
    expect(out.cleaners.a.consecutiveRefused).toBe(0);
    expect(out.anyFailed).toBe(false);
  });
  it('an unrecognised outcome is treated as a refusal (fail closed)', async () => {
    const out = await runCleaners({
      cleaners: [{ name: 'a', run: () => ({ outcome: 'weird' }) }],
      budget: DEFAULT_BUDGET, prev: {}, now: () => 1,
    });
    expect(out.cleaners.a.consecutiveRefused).toBe(1);
  });
});

describe('writeStateAtomic', () => {
  const memfs = () => {
    const calls = [];
    return {
      calls,
      mkdirSync: (p) => calls.push(['mkdir', p]),
      writeFileSync: (p, d) => calls.push(['write', p, d]),
      renameSync: (a, b) => calls.push(['rename', a, b]),
      unlinkSync: (p) => calls.push(['unlink', p]),
    };
  };
  it('writes a temp file in the same dir then renames onto the target', () => {
    const fs = memfs();
    writeStateAtomic('/var/lib/forge-disk/state.json', { a: 1 }, fs);
    const w = fs.calls.find((c) => c[0] === 'write');
    const r = fs.calls.find((c) => c[0] === 'rename');
    expect(w[1]).not.toBe('/var/lib/forge-disk/state.json');
    expect(w[1].startsWith('/var/lib/forge-disk/')).toBe(true);
    expect(JSON.parse(w[2])).toEqual({ a: 1 });
    expect(r[1]).toBe(w[1]);
    expect(r[2]).toBe('/var/lib/forge-disk/state.json');
    expect(fs.calls.indexOf(w)).toBeLessThan(fs.calls.indexOf(r));
  });
  it('on write failure removes the temp file and never renames; the error propagates', () => {
    const fs = memfs();
    fs.writeFileSync = () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); };
    expect(() => writeStateAtomic('/s/state.json', {}, fs)).toThrow(/full/);
    expect(fs.calls.some((c) => c[0] === 'rename')).toBe(false);
  });
});

describe('runBudget (end to end, injected IO and clock)', () => {
  const mkIo = (over = {}) => {
    const written = {};
    return {
      written,
      io: {
        readFile: (p) => { if (p.endsWith('disk-budget.json')) return over.budget ?? JSON.stringify(DEFAULT_BUDGET); if (written[p]) return written[p]; throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
        fs: {
          mkdirSync() {}, unlinkSync() {},
          writeFileSync: (p, d) => { written[p] = d; },
          renameSync: (a, b) => { written[b] = written[a]; delete written[a]; },
        },
        ...over.io,
      },
    };
  };
  const opts = (io, extra = {}) => ({
    budgetPath: '/etc/forge-exec/disk-budget.json',
    statePath: '/var/lib/forge-disk/state.json',
    io,
    now: () => 1_000_000,
    usedPct: () => 39,
    totalBytes: 1_000_000_000_000,
    measure: async (name) => ({ bytes: 100, measured: true }),
    cleaners: [{ name: 'cache', run: async () => ({ outcome: 'ok', reclaimedBytes: 7 }) }],
    ...extra,
  });
  it('writes state listing all 8 consumers with bytes + cap, cache ok, budgetSource file', async () => {
    const { io, written } = mkIo();
    const r = await runBudget(opts(io));
    const state = JSON.parse(written['/var/lib/forge-disk/state.json']);
    expect(Object.keys(state.consumers).sort()).toEqual([...CONSUMER_NAMES].sort());
    expect(state.consumers.cache.bytes).toBe(100);
    expect(state.consumers.cache.pct).toBe(20);
    expect(state.budgetSource).toBe('file');
    expect(state.cleaners.cache.outcome).toBe('ok');
    expect(state.measuredAtMs).toBe(1_000_000);
    expect(state.usedPct).toBe(39);
    expect(r.exitCode).toBe(0);
  });
  it('invalid budget file: cleaners still run on defaults, flagged, exit non-zero', async () => {
    const { io, written } = mkIo({ budget: '{bad' });
    let ran = false;
    const r = await runBudget(opts(io, { cleaners: [{ name: 'cache', run: () => { ran = true; return { outcome: 'ok' }; } }] }));
    const state = JSON.parse(written['/var/lib/forge-disk/state.json']);
    expect(ran).toBe(true);
    expect(state.budgetSource).toBe('defaults:invalid-json');
    expect(r.exitCode).not.toBe(0);
  });
  it('a measurement that throws marks that consumer measured:false and others continue', async () => {
    const { io, written } = mkIo();
    await runBudget(opts(io, { measure: async (n) => { if (n === 'ci') throw new Error('timeout'); return { bytes: 1, measured: true }; } }));
    const state = JSON.parse(written['/var/lib/forge-disk/state.json']);
    expect(state.consumers.ci.measured).toBe(false);
    expect(state.consumers.tmp.measured).toBe(true);
  });
  it('refusal counter persists across runs via state.json and resets on ok', async () => {
    const { io, written } = mkIo();
    const refuse = { cleaners: [{ name: 'cache', run: () => ({ outcome: 'refused', reason: 'x' }) }] };
    await runBudget(opts(io, refuse));
    let r = await runBudget(opts(io, refuse));
    expect(JSON.parse(written['/var/lib/forge-disk/state.json']).cleaners.cache.consecutiveRefused).toBe(2);
    expect(r.exitCode).not.toBe(0);
    r = await runBudget(opts(io));
    expect(JSON.parse(written['/var/lib/forge-disk/state.json']).cleaners.cache.consecutiveRefused).toBe(0);
    expect(r.exitCode).toBe(0);
  });
  it('a corrupt previous state does not stop the run', async () => {
    const { io, written } = mkIo();
    written['/var/lib/forge-disk/state.json'] = '{corrupt';
    const r = await runBudget(opts(io));
    expect(r.exitCode).toBe(0);
  });
});
