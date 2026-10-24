import { expect, it } from 'vitest';
import b from './recycled-pid-bg-spare-fix-claim.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

// Share the expensive replay. defineBreakTest uses it.fails when fixPresent is
// false; the independent evidence test must still PASS in that state, otherwise
// a broken setup could masquerade as the expected reproduction.
let replay;
const run = () => (replay ??= b.run({}));
defineBreakTest({ ...b, run });

it('reaches all four PID/claim decisions with a calm host and without scripted session completion in either fix state', async () => {
  const report = await run();
  expect(report.violations.filter(v => v.invariant !== 'recycled-pid-live')).toEqual([]);
  expect(report.ctx).toMatchObject({ psChecks: 4, evidenceChecks: 4, hostGateChecks: 4, checked: 4 });
  for (const tick of report.ticks) {
    expect([...(tick.result.refusals ?? []), ...(tick.result.reconcileRefusals ?? [])]
      .filter(r => r.kind === 'host-load')).toEqual([]);
  }
  expect(typeof report.ctx.pidAlive).toBe('boolean');
  expect(report.ctx.dispatched).toBe(!report.ctx.pidAlive);
  expect(report.violations.map(v => v.invariant)).toEqual(report.ctx.pidAlive ? ['recycled-pid-live'] : []);
  expect(b.judge(report).length).toBe(report.ctx.pidAlive ? 1 : 0);
});

it('judges incomplete or unknown scenario evidence RED', () => {
  expect(b.judge({ violations: [{ invariant: 'recycled-pid-scenario', detail: 'incomplete PID evidence' }] }))
    .toEqual(['[recycled-pid-scenario] incomplete PID evidence']);
  expect(b.judge({ violations: [{ invariant: 'unknown-evidence', detail: 'unrecognized failure' }] }))
    .toEqual(['[unknown-evidence] unrecognized failure']);
});
