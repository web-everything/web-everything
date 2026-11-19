import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Exercise the production timer wiring without booting the CLI, auth, or clone IO.
const source = readFileSync(resolve('skills-src/conveyor/review-daemon.mjs'), 'utf8');
const timerSource = source.slice(source.indexOf('  let drainBusy = false;'), source.indexOf('  let stoppedReason;'));

describe('review daemon independent queue timer', () => {
  it('routes every drain through self-sync outside App auth, honoring skipped ticks and restart options', async () => {
    let timer, guardedTick, syncOptions;
    let blocked = true;
    const drain = vi.fn();
    const authTick = vi.fn(async () => guardedTick());
    const authOptions = { perOwner: true };
    const withGithubAppAuth = vi.fn(effects => {
      guardedTick = effects.tickOnce;
      return { tickOnce: authTick };
    });
    const withSelfSync = vi.fn((effects, options) => {
      syncOptions = options;
      return { tickOnce: () => blocked ? { skipped: true } : effects.tickOnce() };
    });
    const restart = vi.fn(), staleRefusal = vi.fn();
    const install = new Function('withSelfSync', 'withGithubAppAuth', 'cliRedTeamQueueDrain',
      'REVIEW_DAEMON_APP_AUTH_OPTS', 'selfRoot', 'restartOntoNewCode', 'hasStaleMainRefusal',
      'setInterval', 'process', 'console', 'stopping', timerSource);
    install(withSelfSync, withGithubAppAuth, drain, authOptions, 'fixture-clone', restart, staleRefusal,
      (callback, ms) => { timer = callback; expect(ms).toBe(60_000); }, { env: {} }, { error: vi.fn() }, false);

    expect(withSelfSync).toHaveBeenCalledTimes(1);
    expect(withGithubAppAuth).toHaveBeenCalledWith({ tickOnce: guardedTick }, authOptions);
    expect(syncOptions).toEqual({ root: 'fixture-clone', onRestart: restart, hasStaleRefusal: staleRefusal });
    await timer();
    expect(authTick).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    blocked = false;
    await timer();
    expect(authTick).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });
});


it('timer uses the planner queue runner, fresh PR reader, shared live budget, and cached head evidence', async () => {
  const drainSource = source.slice(source.indexOf('export function cliRedTeamQueueDrain('),
    source.indexOf('export function cliReviewTickOpts(')).replace('export ', '');
  const cacheSource = source.slice(source.indexOf('function cachedQueuePrReader('),
    source.indexOf('/** Both the planner and timer'));
  const queue = { entries: () => [{ repo: 'example/one' }, { repo: 'example/two' }] };
  const budget = { live: 2, max: 6, left: 4 };
  const host = { admitted: true, maxPerTick: 2, take: vi.fn() };
  const readPrs = vi.fn(), readLivePr = vi.fn(() => ({ state: 'OPEN', isDraft: false }));
  const sharedRun = vi.fn((options, { readLivePr }) => {
    const key = { repo: 'example/one', pr: 1 };
    readLivePr(key); readLivePr(key);
    return { dispatched: [] };
  });
  const drain = vi.fn(options => {
    expect(options.readPrs).toBe(readPrs);
    expect(options.capacity.budget).toBe(budget);
    expect(options.capacity).toMatchObject({ lanes: 3, remainingStarts: 2, startsCeiling: 2 });
    expect(options.alertAfterMin).toBe(60);
    options.capacity.take();
    return options.runQueue({ repo: 'example/one', drain: true });
  });
  const make = new Function('redTeamDispatchQueue', 'createRedTeamDispatchQueue',
    'loadRedTeamQueueDrainSettings', 'liveReviewRoundBudget', 'defaultReviewHostAdmission',
    'planClaudeAuthDispatchGate', 'defaultRecoveryLaneNumbers', 'readLiveRedTeamPr',
    'drainRedTeamQueue', 'defaultReadPrs', 'cliRunRedTeamQueue', 'process',
    `${cacheSource}\nreturn (${drainSource});`);
  const tick = make(queue, vi.fn(), () => ({ alertAfterMin: 60 }), () => budget, () => host,
    () => ({ paused: false }), ({ repo }) => repo === 'example/one' ? [1, 2, 3] : [1, 2, 3, 4],
    readLivePr, drain, readPrs, sharedRun, { env: {} });
  const log = { error: vi.fn() };
  await tick({ log });
  expect(sharedRun).toHaveBeenCalledWith({ repo: 'example/one', drain: true },
    { log, readLivePr: expect.any(Function) });
  expect(readLivePr).toHaveBeenCalledTimes(1);
  expect(host.take).toHaveBeenCalledWith(1);
});
