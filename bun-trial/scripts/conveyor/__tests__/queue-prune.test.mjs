/**
 * @file queue-prune.test.mjs
 * @description Prune planner, priority ordering, bulk-remove receipt, the CLI, and the daemon's automatic prune.
 */
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/conveyor/__tests__/queue-prune.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planPrune, parseIdsFile, bulkRemovePlan, planDigest, applyPlan, collectProtectedNums, protectedOverride,
  makeConfirmMissingOnMain,
} from '../../../../scripts/conveyor/queue-prune.mjs';
import { bornAsIndexFromItems } from '../../../../scripts/conveyor/queue-store.mjs';
import { makeCliPruneQueue, queuePruneEveryTicks } from '../../../../skills-src/conveyor/build-dispatch-daemon.mjs';

const CLI = join(dirname(fileURLToPath(__ORIG_URL)), '..', 'queue.mjs');
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
  // Protection is compared by canonical id: queue spelling × protected spelling, both directions.
  it.each([
    ['numbered row, hash-protected', '14', 'xcccccc'],
    ['hash row, number-protected', 'xcccccc', '14'],
    ['numbered row, number-protected', '14', '14'],
    ['hash row, hash-protected', 'xcccccc', 'xcccccc'],
  ])('keeps a resolved card queued as/protected as: %s', (_label, queued, protectedId) => {
    const withLanded = [...items, { num: '14', status: 'resolved', bornAs: 'xcccccc' }];
    const p = planPrune({ queue: q(queued), items: withLanded, protectedNums: [protectedId] });
    expect(p.drop).toEqual([]);
    expect(p.protectedKept).toEqual([{ num: queued }]);
  });
  it('missing-card needs the origin/main confirmation when one is given (a lagging checkout is not evidence)', () => {
    const seen = [];
    const none = planPrune({ queue: q('x999999'), items, confirmMissing: (n) => { seen.push(n); return false; } });
    expect(none.drop).toEqual([]);
    expect(seen).toEqual(['x999999']);
    const some = planPrune({ queue: q('x999999'), items, confirmMissing: () => true });
    expect(some.drop).toEqual([expect.objectContaining({ num: 'x999999', reason: 'missing-card' })]);
  });
});

describe('makeConfirmMissingOnMain (origin/main evidence, fail-safe)', () => {
  const lsTree = ['backlog/014-thing.md', 'backlog/xaaaaaa-other.md', ''].join('\0');
  /** exec stub: `grep` exit status decides the bornAs probe; `fail` makes the named git subcommand throw. */
  const execFor = ({ grepStatus = 1, fail = null, listing = lsTree, calls = [] } = {}) => (_git, args) => {
    const sub = args.find((a) => ['fetch', 'ls-tree', 'grep'].includes(a));
    calls.push(sub);
    if (fail === sub) throw Object.assign(new Error('git failed'), { status: 128 });
    if (sub === 'grep') { if (grepStatus === 0) return ''; throw Object.assign(new Error('no match'), { status: grepStatus }); }
    return sub === 'ls-tree' ? listing : '';
  };
  it('true only when neither a filename nor a bornAs line on origin/main names the card', () => {
    const confirm = makeConfirmMissingOnMain({ exec: execFor() });
    expect(confirm('x999999')).toBe(true);
    expect(confirm('14')).toBe(false); // zero-padded filename id 014 ≡ 14
    expect(confirm('xaaaaaa')).toBe(false); // filename
    expect(makeConfirmMissingOnMain({ exec: execFor({ grepStatus: 0 }) })('x999999')).toBe(false); // bornAs match
  });
  it('keeps (false) on any git failure, an unreadable listing or an unknown grep status', () => {
    expect(makeConfirmMissingOnMain({ exec: execFor({ fail: 'fetch' }) })('x999999')).toBe(false);
    expect(makeConfirmMissingOnMain({ exec: execFor({ fail: 'ls-tree' }) })('x999999')).toBe(false);
    expect(makeConfirmMissingOnMain({ exec: execFor({ listing: '' }) })('x999999')).toBe(false);
    expect(makeConfirmMissingOnMain({ exec: execFor({ grepStatus: 128 }) })('x999999')).toBe(false);
    expect(makeConfirmMissingOnMain({ exec: execFor() })('x99 9;rm')).toBe(false); // never shells an unsafe id
  });
  it('after a failure it never retries git (no repeated blocking fetches)', () => {
    const calls = [];
    const confirm = makeConfirmMissingOnMain({ exec: execFor({ fail: 'fetch', calls }) });
    confirm('x999999'); confirm('x888888'); confirm('x777777');
    expect(calls).toEqual(['fetch']);
  });
});

describe('applyPlan', () => {
  it('renames a landed hash IN PLACE (queue order and addedAt survive; matches migrate-bornas)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qprune-apply-'));
    try {
      const path = join(dir, 'queue.json');
      writeFileSync(path, JSON.stringify([{ num: 'xbbbbbb', addedAt: 'T1' }, { num: '20', addedAt: 'T2' }, { num: '21', addedAt: 'T3' }]));
      const plan = planPrune({ queue: JSON.parse(readFileSync(path, 'utf8')), items: [...items, { num: '20' }, { num: '21' }], nowMs: 0 });
      expect(plan.rename).toEqual([{ from: 'xbbbbbb', to: '13' }]);
      const after = applyPlan(plan, path);
      expect(after).toEqual([{ num: '13', addedAt: 'T1' }, { num: '20', addedAt: 'T2' }, { num: '21', addedAt: 'T3' }]);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(after);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('collectProtectedNums', () => {
  const prNum = (pr) => pr.headRefName.replace(/^lane\/(\w+)-.*/, '$1');
  it('feeds all four sources: open PRs, build claims, fix claims (resolved via their PR) and in-flight runs', () => {
    const set = collectProtectedNums({
      prs: [{ number: 701, headRefName: 'lane/501-a' }, { number: 702, headRefName: 'lane/502-b' }],
      claims: [{ meta: { num: '503' } }],
      fixClaims: [{ pr: 702, scope: ['x'] }, { meta: { pr: 701 } }, { num: '505' }],
      runs: [{ num: '504' }],
      prNum,
    });
    expect([...set].sort()).toEqual(['501', '502', '503', '504', '505']);
  });
  it('drops each source independently (no source is silently ignored)', () => {
    const base = { prs: [{ number: 701, headRefName: 'lane/501-a' }], claims: [{ meta: { num: '503' } }], fixClaims: [{ num: '505' }], runs: [{ num: '504' }], prNum };
    for (const [omit, gone] of [['prs', '501'], ['claims', '503'], ['fixClaims', '505'], ['runs', '504']]) {
      expect(collectProtectedNums({ ...base, [omit]: [] }).has(gone)).toBe(false);
    }
  });
  it('a fix claim whose PR is not open adds nothing (and never throws)', () => {
    expect([...collectProtectedNums({ prs: [], fixClaims: [{ pr: 9 }], prNum })]).toEqual([]);
  });
  it('a blank CONVEYOR_PRUNE_PROTECTED override is ignored, never an empty protected set', () => {
    expect(protectedOverride('')).toBeNull();
    expect(protectedOverride(' , ')).toBeNull();
    expect(protectedOverride(undefined)).toBeNull();
    expect([...protectedOverride('3, 4')].sort()).toEqual(['3', '4']);
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
  // queue spelling × list spelling × protected spelling, all via the card's bornAs index.
  const bornAsIndex = bornAsIndexFromItems([{ num: '13', bornAs: 'xbbbbbb' }]);
  it.each([
    ['hash row, hash listed', ['xbbbbbb'], 'xbbbbbb'],
    ['hash row, number listed', ['xbbbbbb'], '13'],
    ['number row, hash listed', ['13'], 'xbbbbbb'],
    ['number row, number listed', ['13'], '13'],
  ])('removes the card: %s', (_l, queued, listed) => {
    const plan = bulkRemovePlan({ queue: q(...queued), ids: [listed], bornAsIndex });
    expect(plan.drop.map((d) => d.num)).toEqual(queued);
    expect(plan.absent).toEqual([]);
  });
  it('drops BOTH rows when the queue holds the card under both spellings (listed once)', () => {
    const plan = bulkRemovePlan({ queue: q('xbbbbbb', '13', '7'), ids: ['xbbbbbb', '13'], bornAsIndex });
    expect(plan.drop.map((d) => d.num)).toEqual(['xbbbbbb', '13']);
  });
  it.each([['xbbbbbb'], ['13']])('protection by %s covers the card under either spelling', (prot) => {
    const plan = bulkRemovePlan({ queue: q('xbbbbbb', '13'), ids: ['xbbbbbb'], protectedNums: [prot], bornAsIndex });
    expect(plan.drop).toEqual([]);
    expect(plan.protectedKept.map((p) => p.num)).toEqual(['xbbbbbb', '13']);
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
    const items = JSON.parse(execFileSync('node', ['-e', "const l=require('./src/_data/backlog.js')();console.log(JSON.stringify(l.filter(i=>i.bornAs).slice(0,1).map(i=>({num:String(i.num),bornAs:i.bornAs}))))"], { encoding: 'utf8', cwd: join(dirname(fileURLToPath(__ORIG_URL)), '..', '..', '..') }));
    writeFileSync(side, JSON.stringify(q(items[0].num)));
    const f = join(dir, 'ids2.txt'); writeFileSync(f, `${items[0].bornAs}\n`);
    const dry = JSON.parse(run(['remove', `--ids-file=${f}`, '--dry-run', '--json']).out);
    expect(dry.drop).toHaveLength(1);
  });
  it('prune refuses (exit 1) and leaves the queue untouched when the open-PR list cannot be read', () => {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'gh'), 0o755);
    const failing = { ...env, PATH: bin };
    delete failing.CONVEYOR_PRUNE_PROTECTED;
    let code = 0; let out = '';
    try { execFileSync(process.execPath, [CLI, 'prune', '--json'], { encoding: 'utf8', env: failing, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { code = e.status; out = String(e.stdout); }
    expect(code).toBe(1);
    expect(JSON.parse(out).error).toMatch(/refusing to prune/);
    expect(read().map((e) => e.num)).toEqual(['1', '2', '3']);
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
      io: { store, prune, items: () => items, path: '/x', apply: (plan) => { applied = plan; }, confirmMissing: () => true },
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
  it('a card absent from the local backlog but PRESENT on origin/main is never dropped as missing-card', async () => {
    let applied = null;
    const store = { readQueueFile: () => q('x999999'), resolveQueuePath: () => '/x' };
    const run = (confirmMissing) => makeCliPruneQueue({
      env: {}, io: { store, prune: { planPrune }, items: () => items, path: '/x', apply: (plan) => { applied = plan; }, confirmMissing },
    })({ protectedNums: [] });
    expect((await run(() => false)).dropped).toEqual([]); // main has it (or cannot be read) → keep
    expect(applied).toBeNull();
    expect((await run(() => true)).dropped).toEqual([{ num: 'x999999', reason: 'missing-card' }]);
  });
});
