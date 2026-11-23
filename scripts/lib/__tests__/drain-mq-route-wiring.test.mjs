import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrainMqRouteWiring } from '../drain-mq-route-wiring.mjs';

const guard = { hold: true, line: 'mq-same-head-failed: #42 head x — failed_checks' };
const identity = { repo: 'acme/web', pr: 42, head: 'a'.repeat(40), guard, dryRun: false };
const source = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
// Execute the shipped enqueue wrapper with hermetic guard/strategy ports.
function enqueue(wiring, dryRun = false) {
  const start = source.indexOf('  function enqueueWithSameHeadGuard(');
  const end = source.indexOf('\n    return result;\n  }', start) + '\n    return result;\n  }'.length;
  return new Function('mqFixerRoutes', 'DRY_RUN', 'assertCapability', 'createMqSameHeadRefreshOptions',
    'mqSameHeadRefreshStore', 'localSlug', 'mqSameHeadGuard', 'mergeStrategy',
    `${source.slice(start, end)}; return enqueueWithSameHeadGuard;`)(wiring, dryRun, () => null,
    () => ({}), {}, identity.repo, () => structuredClone(guard),
    { enqueue: () => { throw new Error('hold must prevent enqueue'); } });
}
describe('drain same-head route wiring', () => {
  afterEach(() => vi.useRealTimers());
  it.each([false, true])('dryRun=%s keeps enqueue false and routes only live holds', async dryRun => {
    const route = vi.fn(async () => ({ routed: true }));
    const wiring = createDrainMqRouteWiring({ route });
    const result = enqueue(wiring, dryRun)({ repo: identity.repo, num: 42 }, identity.head, {});
    await wiring.settle();
    expect(result).toEqual({ enqueued: false, kind: 'mq-same-head-failed', reason: guard.line });
    expect(route).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    if (!dryRun) expect(route).toHaveBeenCalledWith(expect.objectContaining(identity));
  });
  it.each(['synchronous', 'asynchronous'])('%s route failure retains the hold and reports operator inspection', async kind => {
    const log = vi.fn();
    const wiring = createDrainMqRouteWiring({ log, route: () => {
      if (kind === 'asynchronous') return Promise.reject(new Error('unavailable'));
      throw new Error('unavailable');
    } });
    const result = enqueue(wiring)({ num: 42 }, identity.head, {});
    await wiring.settle();
    expect(result).toMatchObject({ enqueued: false, reason: guard.line });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/hold retained.*operator inspection/));
  });
  it('ignores nonmatching guards', async () => {
    const route = vi.fn();
    const wiring = createDrainMqRouteWiring({ route });
    wiring.start({ ...identity, guard: { hold: false, line: guard.line } });
    wiring.start({ ...identity, guard: { hold: true, line: 'other hold' } });
    wiring.start({ ...identity, guard: { hold: true,
      line: 'mq-same-head-failed: #42 head x — unreadable or mismatched live merge-queue state; inspect queue before retrying' } });
    await wiring.settle();
    expect(route).not.toHaveBeenCalled();
  });
  it('awaits delayed mutations so nothing publishes after settlement returns', async () => {
    vi.useFakeTimers();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const mutate = vi.fn();
    const wiring = createDrainMqRouteWiring({ route: async () => { await gate; mutate(); } });
    wiring.start(identity);
    let settled = false;
    const settlement = wiring.settle().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5001);
    expect(settled).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    release();
    await settlement;
    expect(mutate).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
  it('caps each sweep at three routes, logs deferred holds, and resets after settlement', async () => {
    const route = vi.fn(async () => ({ routed: true })), log = vi.fn();
    const wiring = createDrainMqRouteWiring({ route, log });
    for (let pr = 1; pr <= 5; pr++) wiring.start({ ...identity, pr });
    await wiring.settle();
    expect(route.mock.calls.map(([args]) => args.pr)).toEqual([1, 2, 3]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/cap reached.*hold retained.*next sweep/));
    wiring.start({ ...identity, pr: 4 });
    await wiring.settle();
    expect(route).toHaveBeenCalledTimes(4);
    expect(guard).toEqual({ hold: true, line: identity.guard.line });
  });
  it('repeated sweeps of the same five holds give every PR a turn even without publication', async () => {
    const route = vi.fn(async () => ({ routed: false }));
    const wiring = createDrainMqRouteWiring({ route });
    for (let sweep = 0; sweep < 3; sweep++) {
      for (let pr = 1; pr <= 5; pr++) wiring.start({ ...identity, pr });
      await wiring.settle();
      expect(route).toHaveBeenCalledTimes((sweep + 1) * 3);
    }
    const attempts = route.mock.calls.map(([args]) => args.pr);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 1, 2, 3, 4]);
    expect(new Set(attempts)).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(guard).toEqual({ hold: true, line: identity.guard.line });
  });
  it('settles pending routes in the sweep finally, including early returns', () => {
    expect(source).toMatch(/const sweepOnce = async \(\) => \{\s*try \{/);
    expect(source).toMatch(/finally \{ await mqFixerRoutes\.settle\(\); \}\s*\}; \/\/ end sweepOnce/);
  });
});
