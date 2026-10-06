/**
 * @file queue-prune.test.mjs
 * @description Prune planner, priority ordering, bulk-remove receipt, the CLI, and the daemon's automatic prune.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPrune, parseIdsFile, bulkRemovePlan, planDigest } from '../queue-prune.mjs';
import { makeCliPruneQueue, queuePruneEveryTicks } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'queue.mjs');
const OLD = '2020-01-01T00:00:00Z';
const items = [
  { num: '10', status: 'resolved' }, { num: '11', status: 'open' },
  { num: '12', status: 'open', bornAs: 'xaaaaaa' }, { num: '13', status: 'open', bornAs: 'xbbbbbb' },
];
const q = (...nums) => nums.map((num) => ({ num, addedAt: OLD }));

describe('planPrune', () => {
  it('drops resolved, missing-card and duplicate alias; renames a landed hash; keeps live cards', () => {
    const p = planPrune({ queue: q('10', '11', '12', 'xaaaaaa', 'xbbbbbb', 'x999999'), items });
    const by = Object.fromEntries(p.drop.map((d) => [d.num, d.reason]));
    expect(by).toEqual({ '10': 'resolved', xaaaaaa: 'duplicate', x999999: 'missing-card' });
    expect(p.rename).toEqual([{ from: 'xbbbbbb', to: '13' }]);
  });
  it('never drops an entry with an open PR or active claim', () => {
    const p = planPrune({ queue: q('10', 'x999999'), items, protectedNums: ['10', 'x999999'] });
    expect(p.drop).toEqual([]);
    expect(p.protectedKept).toHaveLength(2);
  });
  it('keeps a young missing-card entry (card may be in an open lane PR)', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const p = planPrune({ queue: [{ num: 'xnew1234', addedAt: '2026-01-01T00:00:00Z' }], items, nowMs: now });
    expect(p.drop).toEqual([]);
  });
  it('fails closed when the backlog did not load', () => {
    const p = planPrune({ queue: q('11'), items: [] });
    expect(p.ok).toBe(false);
    expect(p.drop).toEqual([]);
  });
});

describe('bulk remove', () => {
  it('parses ids with comments and plans only queued, unprotected ids', () => {
    const ids = parseIdsFile('1 2, #3\n# a comment\n4 # trailing note\n');
    expect(ids).toEqual(['1', '2', '3', '4']);
    const plan = bulkRemovePlan({ queue: q('1', '2', '9'), ids, protectedNums: ['2'] });
    expect(plan.drop.map((d) => d.num)).toEqual(['1']);
    expect(plan.protectedKept).toHaveLength(1);
    expect(plan.absent).toEqual(['3', '4']);
    expect(planDigest(plan, 'x')).toBe(planDigest(plan, 'x'));
  });
});

describe('queue.mjs CLI', () => {
  let dir; let side; let env;
  const run = (args) => {
    try { return { out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }; }
    catch (e) { return { out: String(e.stdout), code: e.status }; }
  };
  const read = () => JSON.parse(readFileSync(side, 'utf8'));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qprune-'));
    side = join(dir, 'queue.json');
    writeFileSync(side, JSON.stringify(q('1', '2', '3')));
    env = { ...process.env, CONVEYOR_QUEUE_FILE: side, CONVEYOR_PRUNE_PROTECTED: '3', CONVEYOR_NO_READY_CHECK: '1' };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('remove --ids-file matches a listed hash against its renamed landed NNN (bornAs)', () => {
    // CONVEYOR_BACKLOG_DIR-free: the loader reads the lane's real backlog, so pick a real landed pair.
    const items = JSON.parse(execFileSync('node', ['-e', "const l=require('./src/_data/backlog.js')();console.log(JSON.stringify(l.filter(i=>i.bornAs).slice(0,1).map(i=>({num:String(i.num),bornAs:i.bornAs}))))"], { encoding: 'utf8', cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..') }));
    writeFileSync(side, JSON.stringify(q(items[0].num)));
    const f = join(dir, 'ids2.txt'); writeFileSync(f, `${items[0].bornAs}\n`);
    const dry = JSON.parse(run(['remove', `--ids-file=${f}`, '--dry-run', '--json']).out);
    expect(dry.drop).toHaveLength(1);
  });
  it('remove --ids-file needs a matching dry-run, then applies and skips protected', () => {
    const f = join(dir, 'ids.txt'); writeFileSync(f, '1 3\n');
    expect(run(['remove', `--ids-file=${f}`]).code).toBe(1);
    expect(read()).toHaveLength(3);
    const dry = JSON.parse(run(['remove', `--ids-file=${f}`, '--dry-run', '--json']).out);
    expect(dry.drop.map((d) => d.num)).toEqual(['1']);
    expect(read()).toHaveLength(3);
    expect(run(['remove', `--ids-file=${f}`, '--json']).code).toBe(0);
    expect(read().map((e) => e.num)).toEqual(['2', '3']);
  });
});

describe('daemon automatic prune', () => {
  it('setting: default 5, 0 disables, junk falls back', () => {
    expect(queuePruneEveryTicks({})).toBe(5);
    expect(queuePruneEveryTicks({ WE_BUILD_DAEMON_QUEUE_PRUNE_EVERY_TICKS: '0' })).toBe(0);
    expect(queuePruneEveryTicks({ WE_BUILD_DAEMON_QUEUE_PRUNE_EVERY_TICKS: 'x' })).toBe(5);
  });
  it('prunes on cadence, applies the plan, and respects protected ids', async () => {
    let applied = null;
    const store = { readQueueFile: () => q('10', '11', '12'), resolveQueuePath: () => '/x' };
    const prune = { planPrune };
    const fx = makeCliPruneQueue({
      env: { WE_BUILD_DAEMON_QUEUE_PRUNE_EVERY_TICKS: '2' },
      io: { store, prune, items: () => items, path: '/x', apply: (plan) => { applied = plan; } },
    });
    const first = await fx({ protectedNums: [] });
    expect(first.dropped).toEqual([{ num: '10', reason: 'resolved' }]);
    expect(applied.drop).toHaveLength(1);
    expect(await fx({ protectedNums: [] })).toEqual({ skipped: 'cadence' });
    applied = null;
    const third = await fx({ protectedNums: ['10'] });
    expect(third.dropped).toEqual([]);
    expect(applied).toBeNull();
  });
});
