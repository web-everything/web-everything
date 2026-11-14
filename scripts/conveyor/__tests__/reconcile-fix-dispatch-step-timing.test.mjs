import { describe, expect, it } from 'vitest';
import { runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';

describe('runReconcileFixDispatch — per-step timing lines', () => {
  it('logs plan, stacks, scope-filter and per-PR resume/dispatch steps with name, pr, ms and startedAt', () => {
    let time = 5000;
    const lines = [];
    const tick = ms => { time += ms; };
    runReconcileFixDispatch({ root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
      stepNow: () => time, stepLog: line => lines.push(line),
      reconcile: () => { tick(11); return { dispatch: [1764, 1765].map(prNumber => ({ kind: 'fix', prNumber,
        headRefName: `fix-branch-${prNumber}` })), refusals: [] }; },
      netScope: value => { tick(21); return value; },
      prStack: () => { tick(31); return { pairs: [] }; },
      findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: pr => { tick(41); return [`src/${pr}.ts`]; },
      pickFreeLanes: () => [2, 9, 10], listBuildClaims: () => [], listFixClaims: () => [],
      priorityShadow: null, tryResumeRound: null,
      dispatch: entry => { tick(51); return { pr: entry.pr }; } });
    const text = lines.join('\n');
    expect(text).toMatch(/fix-step name=net-scope ms=21 startedAt=/);
    expect(text).toMatch(/fix-step name=plan-fixes ms=\d+ startedAt=/);
    expect(text).toMatch(/fix-step name=stacks ms=31 startedAt=/);
    expect(text).toMatch(/fix-step name=scope-filter ms=\d+ startedAt=/);
    expect(text).toMatch(/fix-step name=dispatch pr=1764 ms=51 startedAt=/);
    expect(text).toMatch(/fix-step name=dispatch pr=1765 ms=51 startedAt=/);
  });
});
