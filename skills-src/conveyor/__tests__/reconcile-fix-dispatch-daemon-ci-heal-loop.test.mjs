import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { runCiHealLoop, runCiHealPass, runDaemonLoop, runTickAllRepos, resolveFixPassBudgets, formatPassPhaseTiming, buildDaemonExits, startCiHealWorker } from '../reconcile-fix-dispatch-daemon.mjs';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const empty = () => ({ dispatched: [], refusals: [], applied: [], rows: [], notes: [], comments: [] });
const fixture = extra => ({ repos: ['a', 'b'], fixTick: empty, ciHealTick: empty,
  hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty, promoteDraftTick: empty,
  notesTick: empty, awaitVerifyTick: empty, stuckFixerTick: empty, supersedeTick: empty,
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
    execFileSync(process.execPath, [
      '--import', join(process.cwd(), 'skills-src/conveyor/__tests__/fixtures/ci-heal-worker-register.mjs'),
      join(process.cwd(), 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'),
    ], { timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI_HEAL_WORKER_PROBE_FILE: path } });
    const events = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const start = events.find(row => row.event === 'block-start');
    const end = events.find(row => row.event === 'block-end');
    expect(start).toBeDefined(); expect(end).toBeDefined();
    expect(start.threadId).toBe(0); expect(end.at - start.at).toBeGreaterThanOrEqual(750);
    const during = events.filter(row => row.event === 'admit' && row.at > start.at && row.at < end.at);
    expect(during.length).toBeGreaterThanOrEqual(3);
    expect(during.every(row => row.threadId > 0 && row.pid === start.pid)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20000);
