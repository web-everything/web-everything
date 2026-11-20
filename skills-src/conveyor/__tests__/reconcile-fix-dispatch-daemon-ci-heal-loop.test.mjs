import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RESOURCE_GATE_STANDARD } from '../../../scripts/lib/resource-gate.mjs';
import { listFixDispatchClaims } from '../../../scripts/conveyor/fix-claim-store.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { runCiHealLoop, runCiHealPass, runDaemonLoop, runTickAllRepos, resolveFixPassBudgets, formatPassPhaseTiming, buildDaemonExits, startCiHealWorker, buildCiHealWorkerEffects, createFixPassCoordination, buildFixThrottle } from '../reconcile-fix-dispatch-daemon.mjs';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const empty = () => ({ dispatched: [], refusals: [], applied: [], rows: [], notes: [], comments: [] });
const fixture = extra => ({ repos: ['a', 'b'], fixTick: empty, ciHealTick: empty,
  hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty, promoteDraftTick: empty,
  notesTick: empty, awaitVerifyTick: empty, stuckFixerTick: empty, supersedeTick: ({ repo }) => ({ repo, holds: [], applied: [] }),
  allowStandDownAutoProceed: false, budgetRotation: {}, prCursors: {}, ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

it('ci-heal cadence is independent of slow phases', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const passes = [];
  const main = runDaemonLoop({ tickOnce: () => sleep(40 * 60_000), sleep, maxTicks: 3 });
  const heal = runCiHealLoop({ passOnce: () => passes.push(Date.now()), now: Date.now, sleep, maxPasses: 61 });
  await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
  await heal;
  expect(passes).toHaveLength(61);
  expect(Math.max(...passes.slice(1).map((t, i) => t - passes[i]))).toBeLessThanOrEqual(120_000);
  expect(Math.max(...passes.slice(1).map((t, i) => t - passes[i]))).toBeLessThanOrEqual(10 * 60_000);
  await vi.runAllTimersAsync(); await main;
});

it('skips overlap including indeterminate pending state without stacking admissions', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const lines = []; let active = 0; let peak = 0; let calls = 0;
  const loop = runCiHealLoop({ passOnce: async () => {
    calls++; active++; peak = Math.max(peak, active);
    await sleep(300_000); active--;
  }, now: Date.now, sleep, maxPasses: 4, log: line => lines.push(line) });
  await vi.advanceTimersByTimeAsync(360_000); await loop;
  expect(calls).toBe(2); expect(peak).toBe(1);
  expect(lines.filter(x => x === 'ci-heal-pass-skipped overlap')).toHaveLength(2);
  await vi.runAllTimersAsync();
  const unknown = runCiHealLoop({ passOnce: () => new Promise(() => {}), now: Date.now, sleep,
    maxPasses: 3, log: line => lines.push(line) });
  await vi.advanceTimersByTimeAsync(240_000); await unknown;
  expect(lines.filter(x => x === 'ci-heal-pass-skipped overlap')).toHaveLength(4);
});

it('logs a throwing pass, admits nothing from it and retries next interval', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const lines = [], admits = []; let calls = 0;
  const loop = runCiHealLoop({ passOnce: () => { if (++calls === 1) throw Error('unreadable'); admits.push(Date.now()); },
    now: Date.now, sleep, maxPasses: 2, log: x => lines.push(x) });
  await vi.advanceTimersByTimeAsync(120_000); await loop;
  expect(admits).toEqual([120_000]); expect(lines.join(' ')).toContain('ci-heal-pass-failed unreadable');
});

it('main-red-rebase stops between repos at its budget and reports budgetHit', async () => {
  let time = 0; const seen = [];
  const result = await runTickAllRepos(fixture({ now: () => time,
    passBudgets: resolveFixPassBudgets({ env: {}, file: { fixPassBudget: { mainRedRebaseMs: 1000 } } }),
    mainRedRebaseTick: options => { seen.push(options); time += 1001; return empty(); } }));
  expect(seen).toHaveLength(1); expect(seen[0].deadlineAt).toBe(1000); expect(seen[0].applyBudgetMs).toBe(1000);
  expect(result.budgets['main-red-rebase']).toMatchObject({ hit: true, skipped: ['b'] });
  expect(formatPassPhaseTiming(result).join(' ')).toContain('phase=main-red-rebase ms=1001 budgetMs=1000 budgetHit=true');
  expect(resolveFixPassBudgets({ env: { WE_FIX_BUDGET_MAIN_RED_REBASE_MS: '9999999' }, file: {} }).mainRedRebaseMs)
    .toEqual({ value: 600000, source: 'env' });
  expect(resolveFixPassBudgets({ env: { WE_FIX_BUDGET_MAIN_RED_REBASE_MS: 'unknown' }, file: {} }).mainRedRebaseMs.value).toBe(120000);
});

it('the main tick skips ci-heal only when its own loop is active', async () => {
  const ciHealTick = vi.fn(empty);
  await runTickAllRepos(fixture({ ciHealTick, ciHealOwnLoop: true })); expect(ciHealTick).not.toHaveBeenCalled();
  await runTickAllRepos(fixture({ ciHealTick })); expect(ciHealTick).toHaveBeenCalledTimes(2);
});

it('the ci-heal-only pass preserves the auth pause and never runs slow phases', async () => {
  const ciHealTick = vi.fn(empty), fixTick = vi.fn(empty);
  const result = await runCiHealPass(fixture({ ciHealTick, fixTick, authGateOverride: () => ({ paused: true, reason: 'auth' }) }));
  expect(ciHealTick).not.toHaveBeenCalled(); expect(fixTick).not.toHaveBeenCalled();
  expect(result.authPaused).toBe(true); expect(result.dispatched).toEqual([]);
});

it.each([false, undefined, null])('refuses a new pass when lease liveness is %s', async alive => {
  const passOnce = vi.fn();
  expect(await runCiHealLoop({ passOnce, sleep: vi.fn(), heartbeat: () => alive, maxPasses: 1 }))
    .toMatchObject({ stoppedReason: 'lease-lost' });
  expect(passOnce).not.toHaveBeenCalled();
});

it('a requested stop prevents startup admission', async () => {
  const passOnce = vi.fn();
  await runCiHealLoop({ passOnce, sleep: vi.fn(), shouldStop: () => true });
  expect(passOnce).not.toHaveBeenCalled();
});

it.each(['shutdown', 'restartOntoNewCode', 'loopEnded'])('%s waits for the ci-heal thread to stop before releasing the lease', async method => {
  const calls = []; let finish;
  const stopping = new Promise(resolve => { finish = resolve; });
  const exits = buildDaemonExits({ ciHealLoop: { stop: () => { calls.push('ci-stop'); return stopping; } },
    awaitLoop: { stop: () => calls.push('await-stop') }, releaseLease: () => calls.push('release'),
    exit: () => calls.push('exit'), log: { error() {} } });
  const ended = exits[method]('test');
  expect(calls).toEqual(['ci-stop', 'await-stop']);
  finish(); await ended;
  expect(calls).toContain('release'); expect(exits.isStopping()).toBe(true);
});

it('starts the independent loop in a same-process thread and observes its loss', () => {
  const handlers = {}, terminate = vi.fn(), onLeaseLost = vi.fn();
  const createWorker = vi.fn((url, options) => {
    expect(url.pathname).toContain('reconcile-fix-dispatch-daemon.mjs');
    expect(options.workerData).toMatchObject({ ciHealOwnLoop: true, owner: 'owner' });
    return { on: (name, fn) => { handlers[name] = fn; }, terminate };
  });
  const worker = startCiHealWorker({ owner: 'owner', createWorker, onLeaseLost });
  handlers.exit(0); expect(onLeaseLost).toHaveBeenCalledTimes(1);
  worker.stop(); expect(terminate).toHaveBeenCalledTimes(1);
});

it('production CLI worker admissions continue during a synchronous main-thread child phase', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'ci-heal-worker-wiring-'));
  const path = join(dir, 'admissions.jsonl');
  try {
    const child = spawnSync(process.execPath, [
      '--import', join(process.cwd(), 'skills-src/conveyor/__tests__/fixtures/ci-heal-worker-register.mjs'),
      join(process.cwd(), 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'),
    ], { timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI_HEAL_WORKER_PROBE_FILE: path } });
    expect(child.status, String(child.stderr || child.error || child.stdout)).toBe(0);
    let recorded;
    try { recorded = readFileSync(path, 'utf8'); }
    catch (error) { throw new Error(`worker probe missing: ${String(child.stderr)} ${String(child.stdout)}`, { cause: error }); }
    const events = recorded.trim().split('\n').map(line => JSON.parse(line));
    const start = events.find(row => row.event === 'block-start');
    const end = events.find(row => row.event === 'block-end');
    expect(start).toBeDefined(); expect(end).toBeDefined();
    expect(start.threadId).toBe(0); expect(end.at - start.at).toBeGreaterThanOrEqual(750);
    const during = events.filter(row => row.event === 'admit' && row.at > start.at && row.at < end.at);
    expect(during.length).toBeGreaterThanOrEqual(3);
    expect(during.every(row => row.threadId > 0 && row.pid === start.pid)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20000);

// Audit findings 1–3: exercise composition, including wrapper refusal and ordering.
it.each(['quarantined', 'reclone', 'adoption-yield', 'head-moved'])('worker never dispatches when self-sync refuses %s', async reason => {
  const tick = vi.fn(), refresh = vi.fn();
  const worker = buildCiHealWorkerEffects({ tick, refresh, heartbeat: () => true,
    auth: effects => effects, selfSync: () => ({ tickOnce: () => ({ reason }) }) });
  expect(await worker.tickOnce()).toEqual({ reason });
  expect(refresh).not.toHaveBeenCalled(); expect(tick).not.toHaveBeenCalled();
});

it('worker refreshes claims before each independent pass, including while a main tick is pending', async () => {
  const calls = [];
  const worker = buildCiHealWorkerEffects({ tick: () => calls.push('dispatch'), heartbeat: () => true,
    refresh: () => { calls.push('refresh'); return { refreshed: [] }; },
    selfSync: effects => effects, auth: effects => effects });
  await worker.tickOnce(); await worker.tickOnce();
  expect(calls).toEqual(['refresh', 'dispatch', 'refresh', 'dispatch']);
});

it('worker starts managed even when the parent has no managed-clone environment', () => {
  vi.stubEnv('WE_DAEMON_MANAGED_CLONE', undefined);
  startCiHealWorker({ createWorker: (_url, options) => {
    expect(options.env.WE_DAEMON_MANAGED_CLONE).toBe('1');
    expect(options.env.GIT_OPTIONAL_LOCKS).toBe('0');
    return { on() {}, terminate() {} };
  } });
});

it('each admission re-reads sibling claims and refuses unreadable claim evidence', () => {
  let claims = [];
  const now = Date.now();
  const throttle = buildFixThrottle({ slotClaims: () => { if (claims === null) throw Error('unreadable'); return claims; },
    settings: { cutover: 'enforce', fixCap: { ...RESOURCE_GATE_STANDARD.fixCap, floor: 2, ceiling: 2 } },
    sendBackReservedSlots: 0, env: {}, gate: () => ({ admit: true }), log() {},
    readSnap: () => ({ sampledAt: new Date(now).toISOString(), freshUntil: new Date(now + 1000).toISOString(), memory: { metric: 'available', availableMb: 10000, pressureLevel: 1 } }),
    resolveFloor: () => ({ metric: 'available', floorMb: 1 }), nowMs: () => now });
  expect(throttle.tryAdmit('fix').admit).toBe(true);
  claims = [{ meta: { kind: 'fix' } }, { meta: { kind: 'ci-heal' } }];
  expect(throttle.tryAdmit('ci-heal')).toMatchObject({ admit: false, kind: 'fix-cap' });
  claims = null;
  expect(throttle.tryAdmit('fix')).toMatchObject({ admit: false, kind: 'claims-unreadable' });
});

it('strict live claim reads refuse corrupt persisted old state instead of counting zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heal-claims-'));
  try {
    mkdirSync(join(dir, 'old')); writeFileSync(join(dir, 'old', 'lock.json'), '{');
    expect(() => listFixDispatchClaims(dir, { strict: true, liveOnly: true })).toThrow('incomplete fix claim');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('concurrent phases cannot consume the same fixer seat and log an overlap skip', async () => {
  const log = vi.fn(), main = createFixPassCoordination(undefined, log);
  const worker = createFixPassCoordination(main.buffer, log);
  let release; const pending = main.dispatch(() => new Promise(resolve => { release = resolve; }));
  const dispatch = vi.fn();
  expect(worker.dispatch(dispatch).refusals[0].kind).toBe('admission-held');
  expect(dispatch).not.toHaveBeenCalled(); expect(log).toHaveBeenCalledWith('ci-heal-pass-skipped overlap');
  release(); await pending;
});

it('fix and healer budgets share charges across overlapping passes and fail closed on unknown or oversized projections', async () => {
  const main = createFixPassCoordination(), worker = createFixPassCoordination(main.buffer);
  const baseline = { slots: 1, backlogMinutes: 0, maxWaitMinutes: 15, standardMinutes: { selected: 5, standards: 5 } };
  await main.withPass(async () => {
    expect(main.dispatch(() => main.queueBudget(baseline).tryAdmit('fix')).admit).toBe(true);
    await worker.withPass(() => {
      expect(worker.dispatch(() => worker.queueBudget(baseline).tryAdmit('ci-heal')).admit).toBe(false);
      expect(worker.dispatch(() => worker.queueBudget(null).tryAdmit('ci-heal'))).toMatchObject({ admit: false, why: expect.stringContaining('retry next pass') });
      expect(worker.dispatch(() => worker.queueBudget({ bypassed: 'unknown' }).tryAdmit('ci-heal')).admit).toBe(false);
      expect(worker.dispatch(() => worker.queueBudget({ ...baseline, maxWaitMinutes: 1e12, standardMinutes: { selected: 1e10, standards: 1 } }).tryAdmit('fix'))).toMatchObject({ admit: false, why: expect.stringContaining('restart daemon after checking queue') });
    });
  });
  main.resetIfIdle();
  expect(main.dispatch(() => main.queueBudget(baseline).tryAdmit('ci-heal')).admit).toBe(true);
});

it.each([
  { error: 'unreadable' }, { bodyEditFailures: 1 },
  { holds: [{ pr: 1 }], applied: [{ pr: 1, ok: false }] },
  { holds: [{ pr: 1 }], applied: [{ pr: 1, ok: true, labeled: false }] },
])('healer refuses incomplete supersede evidence %j', async evidence => {
  const ciHealTick = vi.fn(empty);
  const result = await runCiHealPass(fixture({ ciHealTick,
    supersedeTick: ({ repo }) => ({ repo, holds: [], applied: [], ...evidence }) }));
  expect(ciHealTick).not.toHaveBeenCalled();
  expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'supersede-unknown' }));
});

it('worker publishes supersede holds before healer planning', async () => {
  const calls = [];
  await runCiHealPass(fixture({ supersedeTick: ({ repo }) => { calls.push('hold'); return { repo, holds: [{ pr: 1 }], applied: [{ pr: 1, ok: true, labeled: true }] }; },
    ciHealTick: () => { calls.push('heal'); return empty(); } }));
  expect(calls).toEqual(['hold', 'hold', 'heal', 'heal']);
});

it('lease loss fences pending asynchronous work before it can dispatch again', async () => {
  vi.useFakeTimers();
  const coordination = createFixPassCoordination();
  let alive = true; const dispatch = vi.fn(); const lost = vi.fn(() => coordination.fence());
  const loop = runCiHealLoop({ sleep, maxPasses: 3, heartbeat: () => alive, onLeaseLost: lost,
    passOnce: async () => { await sleep(150000); coordination.dispatch(dispatch); } });
  await vi.advanceTimersByTimeAsync(1); alive = false;
  await vi.advanceTimersByTimeAsync(150000); await loop;
  expect(lost).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled();
});

it('dispatch boundary refuses lease loss after asynchronous preparation', async () => {
  let alive = true, allowed;
  const restart = vi.fn();
  const worker = buildCiHealWorkerEffects({ heartbeat: () => alive, onRestart: restart, coordination: createFixPassCoordination(),
    tick: options => { allowed = options.dispatchAllowed; }, refresh: () => ({}),
    selfSync: effects => effects, auth: effects => effects });
  await worker.tickOnce(); expect(allowed()).toBe(true); alive = false;
  expect(allowed()).toBe(false); expect(restart).toHaveBeenCalled();
});

it('phase allowance never extends the configured recovery apply budget', async () => {
  vi.stubEnv('WE_RECOVERY_APPLY_BUDGET_MS', '5');
  const tick = vi.fn(empty);
  await runTickAllRepos(fixture({ mainRedRebaseTick: tick }));
  expect(tick.mock.calls.every(([options]) => options.applyBudgetMs === 5)).toBe(true);
});

it('worker carries the self-sync adoption probe into its own pass', async () => {
  const probe = () => true, tick = vi.fn();
  const worker = buildCiHealWorkerEffects({ tick, heartbeat: () => true, refresh: () => ({}), auth: effects => effects,
    selfSync: effects => { effects.setAdoptYieldProbe(probe); return effects; } });
  await worker.tickOnce();
  expect(tick.mock.calls[0][0].adoptYieldProbe).toBe(probe);
});

it('worker fence notification terminates outstanding work before waiting for worker exit', () => {
  const handlers = {}, terminate = vi.fn(), onLeaseLost = vi.fn();
  startCiHealWorker({ onLeaseLost, createWorker: () => ({ on: (key, fn) => { handlers[key] = fn; }, terminate }) });
  handlers.message('ci-heal-fenced');
  expect(terminate).toHaveBeenCalledTimes(1); expect(onLeaseLost).toHaveBeenCalledTimes(1);
});
