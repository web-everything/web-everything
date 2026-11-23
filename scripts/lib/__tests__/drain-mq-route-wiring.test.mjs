import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDrainMqRouteWiring } from '../drain-mq-route-wiring.mjs';

const guard = { hold: true, line: 'mq-same-head-failed: failed_checks' };
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
  it.each([false, true])('dryRun=%s keeps enqueue false and routes only live holds', async dryRun => {
    const route = vi.fn(async () => ({ routed: true }));
    const wiring = createDrainMqRouteWiring({ route });
    const result = enqueue(wiring, dryRun)({ repo: identity.repo, num: 42 }, identity.head, {});
    await wiring.settle();
    expect(result).toEqual({ enqueued: false, kind: 'mq-same-head-failed', reason: guard.line });
    expect(route).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    if (!dryRun) expect(route).toHaveBeenCalledWith(expect.objectContaining(identity));
  });
  it('a synchronous route throw retains the hold and reports operator inspection', async () => {
    const log = vi.fn();
    const wiring = createDrainMqRouteWiring({ log, route: () => { throw new Error('unavailable'); } });
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
    await wiring.settle();
    expect(route).not.toHaveBeenCalled();
  });
  it('bounds settlement and reports the held operator fallback', async () => {
    const log = vi.fn();
    const wiring = createDrainMqRouteWiring({ log, waitMs: 1, route: () => new Promise(() => {}) });
    wiring.start(identity);
    await wiring.settle();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/wait bound.*hold retained.*operator inspection/));
  });
  it('settles pending routes in the sweep finally, including early returns', () => {
    expect(source).toMatch(/const sweepOnce = async \(\) => \{\s*try \{/);
    expect(source).toMatch(/finally \{ await mqFixerRoutes\.settle\(\); \}\s*\}; \/\/ end sweepOnce/);
  });
});
