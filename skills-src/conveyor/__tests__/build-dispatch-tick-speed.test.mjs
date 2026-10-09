// Card #5322 (build daemon tick overrun) — speed-only changes to one builder round. Each test pins that the faster
// path gives the SAME answer as the old one: the round reads its inputs once instead of once per call, or starts a
// read earlier, and nothing else changes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createFileRunStore, newRunRecord } from '../../../scripts/operations/run-store.mjs';
import { DISPATCH_EFFECT } from '../../../scripts/operations/dispatch-lane.mjs';
import { PLANNING_SNAPSHOT_ENV, planningRead } from '../../../scripts/lib/planning-snapshot.mjs';
import {
  cliListRunStoreInFlight, cliListSettledBuilds, readDispatchLaneRunRecords,
  createRoundRoutePredictor, startPlanningRound, cliPlanTick, PLANNING_LANE_POOL_ARGS,
} from '../build-dispatch-daemon.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '..', '..', '..', 'scripts');

describe('one run-store read per round (#5322)', () => {
  let runsDir;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'tick-speed-runs-'));
    process.env.OPERATION_RUNS_DIR = runsDir;
  });
  afterEach(() => {
    delete process.env.OPERATION_RUNS_DIR;
    rmSync(runsDir, { recursive: true, force: true });
  });

  function seed() {
    const store = createFileRunStore(runsDir);
    const write = (id, effects) => store.write({ ...newRunRecord({ id, op: 'dispatch-lane' }), pending: null, effects });
    const far = new Date(Date.now() + 3_600_000).toISOString();
    write('dispatch-lane-a', [
      { key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'in-flight', startedAt: new Date().toISOString(),
        payload: { num: '7001', launchKind: 'build', scope: ['we:a.mjs'], deadlineAt: far }, dispatch: { executor: 'codex' }, error: null },
      { key: 'dispatch:0:1', type: DISPATCH_EFFECT, stepIndex: 0, index: 1, status: 'applied', startedAt: '2026-01-01T00:00:00.000Z',
        payload: { num: '7002', launchKind: 'build' }, result: { outcome: 'gate-red' }, error: null },
    ]);
    write('dispatch-lane-b', [
      { key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'in-flight', startedAt: new Date().toISOString(),
        payload: { num: '7003', launchKind: 'prepare-item' }, handle: null, error: null },
    ]);
    write('review-pr-ignored', []);
  }

  it('lists only dispatch-lane runs, each once', () => {
    seed();
    const records = readDispatchLaneRunRecords();
    expect(records.map((r) => r.id)).toEqual(['dispatch-lane-a', 'dispatch-lane-b']);
  });

  it('gives the same rows from one shared read as from a fresh read per reader', async () => {
    seed();
    const records = readDispatchLaneRunRecords();
    const now = new Date();
    expect(await cliListRunStoreInFlight({ now, records })).toEqual(await cliListRunStoreInFlight({ now }));
    expect(await cliListSettledBuilds({ records })).toEqual(await cliListSettledBuilds());
    const fresh = await cliListRunStoreInFlight({ now, launchKind: 'prepare-item', listAgents: () => [] });
    const shared = await cliListRunStoreInFlight({ now, launchKind: 'prepare-item', listAgents: () => [], records });
    expect(shared).toEqual(fresh);
    expect(shared).toHaveLength(1);
  });

  it('degrades to no records, never a throw, when the run store is unreadable', () => {
    process.env.OPERATION_RUNS_DIR = join(runsDir, 'missing', 'x.json');
    expect(readDispatchLaneRunRecords()).toEqual([]);
  });
});

describe('route prediction reads its inputs once per round (#5322)', () => {
  it('loads the backlog and routing inputs once for many predictions, and passes the same inputs each time', async () => {
    let loads = 0;
    const inputs = { loadItems: () => [{ num: '1' }], scorecards: { s: 1 }, sizePolicy: { p: 1 }, promotions: { q: 1 } };
    const seen = [];
    const predict = async (num, scope, opts) => { seen.push([num, scope, opts]); return { executor: `x${num}` }; };
    const route = createRoundRoutePredictor({ predict, loadInputs: () => { loads += 1; return inputs; } });
    expect(await route('1', ['a'])).toEqual({ executor: 'x1' });
    expect(await route('2', [])).toEqual({ executor: 'x2' });
    expect(await route('3', ['b'])).toEqual({ executor: 'x3' });
    expect(loads).toBe(1);
    expect(seen.map((s) => s[2])).toEqual([inputs, inputs, inputs]);
  });

  it('falls back to the unshared per-call read when loading the shared inputs fails', async () => {
    const seen = [];
    const predict = async (num, scope, opts) => { seen.push(opts); return { error: 'missing item' }; };
    const route = createRoundRoutePredictor({ predict, loadInputs: () => { throw new Error('backlog unreadable'); } });
    expect(await route('1', [])).toEqual({ error: 'missing item' });
    expect(await route('2', [])).toEqual({ error: 'missing item' });
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe('the lane-pool read starts at the top of the round (#5322)', () => {
  const key = (args) => createHash('sha256').update(JSON.stringify(args)).digest('hex');

  it('uses the exact command tick-core prefetches, so tick-core and dispatch-plan find it in the snapshot', () => {
    expect(PLANNING_LANE_POOL_ARGS).toEqual([join(SCRIPTS, 'lane-pool.mjs'), 'list', '--acquirable', '--json']);
    // tick-core builds its path as join(scripts/conveyor, '..', 'lane-pool.mjs'): the same normalised string.
    expect(join(SCRIPTS, 'conveyor', '..', 'lane-pool.mjs')).toBe(PLANNING_LANE_POOL_ARGS[0]);
  });

  it('stores a successful read in the round snapshot where planningRead finds it, then removes the snapshot', async () => {
    const value = ['/lanes/lane-1', '/lanes/lane-4'];
    const round = startPlanningRound({ readLanePool: async () => value });
    await round.prefetch;
    const file = join(round.dir, `${key(PLANNING_LANE_POOL_ARGS)}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(value);
    let reread = false;
    const got = planningRead(PLANNING_LANE_POOL_ARGS, () => { reread = true; return []; }, { env: { [PLANNING_SNAPSHOT_ENV]: round.dir } });
    expect(got).toEqual(value);
    expect(reread).toBe(false);
    await round.end();
    expect(existsSync(round.dir)).toBe(false);
  });

  it('caches nothing when the read fails, so the plan makes its own read exactly as before', async () => {
    const round = startPlanningRound({ readLanePool: async () => { throw new Error('scan timed out'); } });
    await round.prefetch;
    expect(existsSync(join(round.dir, `${key(PLANNING_LANE_POOL_ARGS)}.json`))).toBe(false);
    await round.end();
    expect(existsSync(round.dir)).toBe(false);
  });

  it('end() waits for a read still running before it removes the snapshot', async () => {
    let finish;
    const round = startPlanningRound({ readLanePool: () => new Promise((r) => { finish = r; }) });
    let ended = false;
    const ending = round.end().then(() => { ended = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toBe(false);
    finish(['/lanes/lane-2']);
    await ending;
    expect(existsSync(round.dir)).toBe(false);
  });

  it('cliPlanTick plans inside the round snapshot it is given and leaves it for the round to remove', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tick-speed-snap-'));
    try {
      let seenDir = null;
      const exec = (_cmd, _args, opts) => { seenDir = opts.env[PLANNING_SNAPSHOT_ENV]; return JSON.stringify({ decisions: {}, nextState: {} }); };
      expect(cliPlanTick({}, { exec, snapshotDir: dir })).toEqual({ decisions: {}, nextState: {} });
      expect(seenDir).toBe(dir);
      expect(existsSync(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('cliPlanTick with no round snapshot still makes and removes its own, as before', () => {
    let seenDir = null;
    const exec = (_cmd, _args, opts) => { seenDir = opts.env[PLANNING_SNAPSHOT_ENV]; return JSON.stringify({ decisions: {}, nextState: {} }); };
    cliPlanTick({}, { exec });
    expect(seenDir).toBeTruthy();
    expect(existsSync(seenDir)).toBe(false);
  });
});
