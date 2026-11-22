import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDrainMqRouteWiring } from '../lib/drain-mq-route-wiring.mjs';
import { routeMqFailureOnHold } from '../lib/drain-mq-failure-recovery-io.mjs';
import { createMqFailureLedger } from '../lib/mq-failure-ledger.mjs';

const identity = { repo: 'example/project', pr: 42, head: 'a'.repeat(40) };
const guard = { hold: true, recoveryAction: 'fixer', line: 'mq-same-head-failed: real failure observed' };
const args = { ...identity, guard, dryRun: false };

function fixture() {
  let state = {};
  const ledger = createMqFailureLedger({ io: { atomicUpdate(update) {
    const next = update(state);
    state = next.state;
    return next.result;
  } } });
  const io = {
    ledger,
    readTimeline: async () => ({ hasPreviousPage: false, nodes: [{
      __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-01T12:00:00Z',
      beforeCommit: { oid: 'b'.repeat(40), parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: identity.head }] } },
    }] }),
    readRefreshCount: async () => 0,
    readPr: async () => ({ headRefOid: identity.head, mergeStateStatus: 'CLEAN', baseRefName: 'main' }),
    collectEvidence: async () => ({ failedJobs: ['unit'], testFiles: ['src/example.test.mjs'],
      assertions: ['AssertionError: expected true'], complete: true }),
    readLabels: async () => ({ labels: [], complete: true, head: identity.head }),
    postComment: vi.fn(async () => {}),
    addLabel: vi.fn(async () => {}),
  };
  const route = vi.fn(options => routeMqFailureOnHold({ ...options, io }));
  return { io, route, wiring: createDrainMqRouteWiring({ route }) };
}

afterEach(() => vi.useRealTimers());

describe('drain same-head fixer route wiring', () => {
  it('routes a real-failure hold once with the exact repo, PR and head', async () => {
    const { wiring, route, io } = fixture();
    const original = structuredClone(guard);
    expect(wiring.start(args)).toBeUndefined();
    await wiring.settle();
    expect(route).toHaveBeenCalledOnce();
    expect(route).toHaveBeenCalledWith({ ...args, log: expect.any(Function) });
    expect(io.postComment).toHaveBeenCalledOnce();
    expect(io.addLabel).toHaveBeenCalledOnce();
    expect(io.addLabel).toHaveBeenCalledWith({ repo: identity.repo, pr: identity.pr, label: 'mq-failure-recovery' });
    expect(guard).toEqual(original);
  });

  it('repeat evaluation uses the existing ledger to refuse a second comment or label', async () => {
    const { wiring, route, io } = fixture();
    wiring.start(args);
    await wiring.settle();
    wiring.start(args);
    await wiring.settle();
    expect(route).toHaveBeenCalledTimes(2);
    expect(await route.mock.results[1].value).toMatchObject({ routed: false, reason: 'Already routed this head' });
    expect(io.postComment).toHaveBeenCalledOnce();
    expect(io.addLabel).toHaveBeenCalledOnce();
  });

  it.each([
    { ...args, guard: { ...guard, recoveryAction: 'refresh-first' } },
    { ...args, dryRun: true },
    { ...args, guard: { ...guard, hold: false } },
    { ...args, guard: { ...guard, recoveryAction: undefined } },
  ])('does not call the route for ineligible evidence: %j', async options => {
    const { wiring, route } = fixture();
    wiring.start(options);
    await wiring.settle();
    expect(route).not.toHaveBeenCalled();
  });

  it.each(['sync', 'async'])('swallows %s route failures without changing the hold', async mode => {
    const log = vi.fn();
    const wiring = createDrainMqRouteWiring({ log, route: () => {
      if (mode === 'sync') throw new Error('unavailable');
      return Promise.reject(new Error('unavailable'));
    } });
    const original = structuredClone(guard);
    expect(() => wiring.start(args)).not.toThrow();
    await expect(wiring.settle()).resolves.toBeUndefined();
    expect(guard).toEqual(original);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('operator inspection required'));
  });

  it('bounds an unfinished route wait and logs the operator fallback, retaining the hold', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const wiring = createDrainMqRouteWiring({ log, route: () => new Promise(() => {}) });
    wiring.start(args);
    const settled = vi.fn();
    const wait = wiring.settle().then(settled);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/wait bound reached.*hold retained, operator inspection required/));
    expect(guard.hold).toBe(true);
    await wiring.settle();
  });

  it('wires the synchronous hold branch and awaits routes in every sweep finalizer', () => {
    const source = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    expect(source).toContain("import { createDrainMqRouteWiring } from './lib/drain-mq-route-wiring.mjs'");
    expect(source).toContain('const mqFixerRoutes = createDrainMqRouteWiring({ log: line => process.stderr.write(`${line}\\n`) });');
    expect(source).toMatch(/if \(guard.hold\) \{\s*mqFixerRoutes.start\(\{ repo: c.repo \?\? localSlug, pr: c.num, head: sha, guard, dryRun: DRY_RUN \}\);\s*return \{ enqueued: false, kind: 'mq-same-head-failed', reason: shown.line \};\s*\}/);
    expect(source).toMatch(/const sweepOnce = async \(\) => \{\s*try \{/);
    expect(source).toMatch(/\} finally \{ await mqFixerRoutes.settle\(\); \}\s*\}; \/\/ end sweepOnce/);
  });
});
