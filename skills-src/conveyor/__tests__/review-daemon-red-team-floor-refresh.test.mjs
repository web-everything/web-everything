import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let directory;
let operatorFile;
let storeRead;
let queueRun;
let queueModule;
let production;
let log;

beforeEach(async () => {
  // Each case starts a fresh daemon, but both ticks use that same daemon instance.
  vi.resetModules();
  directory = mkdtempSync(join(process.env.TMPDIR, 'we-r907-floor-'));
  operatorFile = join(directory, 'operator.json');
  writeFileSync(operatorFile, JSON.stringify({ 'redTeamQueue.minConcurrent': 12 }));
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', 'on');
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', join(directory, 'queue.json'));
  // An oversized env minimum must return to the ordinary six-clamped bound on clear.
  vi.stubEnv('WE_RED_TEAM_QUEUE_MIN_CONCURRENT', '12');
  vi.stubEnv('WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT', '10');
  vi.stubEnv('WE_RED_TEAM_QUEUE_REVIEW_STARTS_WHILE_IDLE', '6');

  // The daemon has no operator-file argument. Redirect only the store reader's file
  // seam: keep the real parsing, policy filtering and floor loader on every tick.
  const store = await import('../../../scripts/lib/operator-override-store.mjs');
  const readOperatorOverrides = store.readOperatorOverrides;
  storeRead = vi.spyOn(store, 'readOperatorOverrides').mockImplementation(options =>
    readOperatorOverrides({ ...options, file: operatorFile }));
  queueModule = await import('../../../scripts/lib/red-team-dispatch-queue.mjs');
  queueRun = vi.spyOn(queueModule, 'runWithRedTeamQueue').mockReturnValue({ dispatched: [] });
  const labels = await import('../../../scripts/lib/red-team-result-label-sync.mjs');
  vi.spyOn(labels, 'syncResultOnHeadLabels').mockImplementation(({ rawPrs }) => ({ rawPrs }));
  const { cliReviewTickOpts } = await import('../review-daemon.mjs');
  log = { error: vi.fn() };
  production = cliReviewTickOpts({ log });
  // Construction also reads unrelated operator policies for the live-review budget.
  // Count only reads performed by the red-team-on-skip ticks below.
  storeRead.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function tick() {
  return production.redTeamOnSkip({
    repo: 'web-everything/web-everything',
    plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: 9071, headSha: 'a'.repeat(40) }] },
    rawPrs: [{ number: 9071, headRefOid: 'a'.repeat(40), labels: [], comments: [] }],
    lastDispatch: new Map(), paused: false,
    capacity: { lanes: 12, startsCeiling: 12, remainingStarts: 1, budget: { left: 12 }, take: vi.fn() },
  });
}

const passedMinimums = () => queueRun.mock.calls.map(([options]) => options.floor?.minConcurrent);
const floorLines = () => log.error.mock.calls.map(([line]) => line)
  .filter(line => line.startsWith('review-daemon: red-team queue floor minConcurrent='));

it('R907 lowering an operator override changes the floor passed to the queue on the next tick', () => {
  tick();
  writeFileSync(operatorFile, JSON.stringify({ 'redTeamQueue.minConcurrent': 3 }));
  tick();

  expect(passedMinimums()).toEqual([12, 3]);
  expect(storeRead).toHaveBeenCalledTimes(2);
});

it('R907 clearing an operator override restores the six-clamped env floor on the next tick', () => {
  tick();
  writeFileSync(operatorFile, '{}');
  tick();

  expect(passedMinimums()).toEqual([12, 6]);
  expect(storeRead).toHaveBeenCalledTimes(2);
});

it.each(['corrupt', 'unreadable'])('R907 a %s operator store disables floor raises on the next tick', state => {
  tick();
  if (state === 'corrupt') writeFileSync(operatorFile, '{broken json');
  else {
    // A directory deterministically fails a file read, including under privileged runners.
    rmSync(operatorFile);
    mkdirSync(operatorFile);
  }
  tick();

  const floor = queueRun.mock.calls[1][0].floor;
  const capacity = { lanes: 12, startsCeiling: 12, remainingStarts: 1, budget: { left: 12 } };
  queueModule.applyRedTeamQueueFloor(capacity, { floor, cpuIdlePct: 100 });
  expect.soft(passedMinimums()).toEqual([12, 0]);
  expect.soft(capacity.remainingStarts).toBe(1);
  expect.soft(queueModule.raiseReviewStartsPerTick(2, { floor, cpuIdlePct: 100 })).toBe(2);
  expect.soft(log.error.mock.calls.flat().join(' ')).toContain('operator-db-unreadable');
  expect(storeRead).toHaveBeenCalledTimes(2);
});

it('R907 unchanged resolved floors are reread every tick without repeating the floor log', () => {
  tick();
  tick();

  expect(passedMinimums()).toEqual([12, 12]);
  expect.soft(floorLines()).toHaveLength(1);
  expect(storeRead).toHaveBeenCalledTimes(2);
});

it('R907 logs each changed resolved floor once and suppresses the repeated value on the following tick', () => {
  tick();
  writeFileSync(operatorFile, JSON.stringify({ 'redTeamQueue.minConcurrent': 9 }));
  tick();
  tick();

  expect.soft(floorLines()).toEqual([
    expect.stringMatching(/floor minConcurrent=12 \(source: operator-db\)/),
    expect.stringMatching(/floor minConcurrent=9 \(source: operator-db\)/),
  ]);
  expect.soft(passedMinimums()).toEqual([12, 9, 9]);
  expect(storeRead).toHaveBeenCalledTimes(3);
});
