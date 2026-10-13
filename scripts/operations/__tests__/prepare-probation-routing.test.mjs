import { selectProbationWorker } from '../../lib/provider-routing.mjs';
import { describe, it, expect } from 'vitest';
import { decideDispatchRoute } from '../../lib/dispatch-contracts.mjs';
import { routeDispatchProvider } from '../dispatch-lane-io.mjs';
import { probationWorkerDetachedProvider } from '../dispatch-providers/probation-worker.mjs';

describe('prepare probation routing', () => {
  it.each(['build', 'ci-heal', 'fix', 'investigate', 'prepare-decision'])('%s refuses grouped probation requests before spawning', launchKind => {
    const spawnDetached = () => { throw new Error('must not spawn'); };
    expect(() => probationWorkerDetachedProvider({ launchKind, num: '123', pr: '42', sessionSlug: 'group',
      groupMembers: ['124', '125'], probationWorker: { id: 'codex', provider: 'codex', model: 'model', taskType: 'doc-fix' },
    }, { spawnDetached })).toThrow(/group.*prepare/i);
  });
  it('routes prepare-item to Codex with Sonnet fallback and launches prepare mode', () => {
    const route = decideDispatchRoute({ kind: 'prepare-item', scopePaths: ['we:scripts/lib/example.mjs'] });
    expect(route).toMatchObject({ tier: 'sonnet', probationWorker: { id: 'codex', taskType: 'prepare' } });
    const request = { launchKind: 'prepare-item', probationWorker: route.probationWorker, num: '123', sessionSlug: 'prepare-123', runId: 'original-run', effectKey: 'original-key', groupMembers: ['124', '125'] };
    expect(routeDispatchProvider(request, { probationLaunch: 'on', scriptExists: () => true, probation: () => 'probation', agent: () => 'claude' })).toBe('probation');
    let argv;
    probationWorkerDetachedProvider(request, { spawnDetached: (a) => { argv = a; return { pid: 123 }; }, logPathFor: () => '/tmp/unused' });
    expect(argv).toContain('--taskType=prepare');
    expect(argv).toContain('--group-members=124,125');
    expect(argv).toContain('--run-id=original-run');
    expect(argv).toContain('--effect-key=original-key');
    expect(argv[0]).toMatch(/probation-build-run.mjs$/);
    expect(routeDispatchProvider({ ...request, probationWorker: null }, { agent: () => 'claude' })).toBe('claude');
  });
  it('offers Gemini only for simple preparation when Codex is vetoed', () => {
    const codex = selectProbationWorker({ taskType: 'prepare' }).worker;
    const vetoes = [{ provider: codex.provider, model: codex.model, taskType: 'prepare' }];
    expect(selectProbationWorker({ taskType: 'prepare', vetoes }).worker).toBeNull();
    expect(selectProbationWorker({ taskType: 'prepare', vetoes, simple: true }).worker).toMatchObject({ id: 'antigravity-gemini', checker: 'codex' });
  });
  it('routes prepare-decision to Astra at high effort', () => {
    const route = decideDispatchRoute({ kind: 'prepare-decision', scopePaths: ['we:backlog/9001-card.md'] });
    expect(route).toMatchObject({ tier: 'opus', outcome: 'role' });
    expect(route.probationWorker).toBeNull();
    expect(route.policyRoute).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', effort: 'high' });
  });
});

it.each(['prepare-item', 'prepare-decision', 'investigate'])('%s fails closed with unknown scope', kind => {
  expect(decideDispatchRoute({ kind }).policyRoute.provider).toBe('claude');
});
