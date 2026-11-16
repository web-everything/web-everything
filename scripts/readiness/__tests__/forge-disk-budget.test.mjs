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
});
