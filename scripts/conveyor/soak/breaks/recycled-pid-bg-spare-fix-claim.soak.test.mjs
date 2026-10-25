import { expect, it } from 'vitest';
import b from './recycled-pid-bg-spare-fix-claim.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

// Share the expensive replay. Both tests require recovery; the companion must
// never accept a stuck PR merely because the runtime identity probe regressed.
let replay;
const run = () => (replay ??= b.run({}));
defineBreakTest({ ...b, run });

it('retains the working spare then recovers after process death, with a calm host and no scripted session completion', async () => {
  const report = await run();
  expect(report.violations).toEqual([]);
  expect(report.ctx).toMatchObject({ psChecks: 4, evidenceChecks: 4, hostGateChecks: 4, checked: 4,
    healthyChecks: 2, recoveryChecks: 2, unknownLeaseChecks: 4 });
  for (const tick of report.ticks) {
    expect([...(tick.result.refusals ?? []), ...(tick.result.reconcileRefusals ?? [])]
      .filter(r => r.kind === 'host-load')).toEqual([]);
  }
  expect(report.ctx.pidAlive).toBe(false);
  expect(report.ctx.claimReleased).toBe(true);
  expect(report.ctx.dispatched).toBe(true);
  expect(b.judge(report)).toEqual([]);
});

it('judges incomplete or unknown scenario evidence RED', () => {
  expect(b.judge({ violations: [{ invariant: 'recycled-pid-scenario', detail: 'incomplete PID evidence' }] }))
    .toEqual(['[recycled-pid-scenario] incomplete PID evidence']);
  expect(b.judge({ violations: [{ invariant: 'unknown-evidence', detail: 'unrecognized failure' }] }))
    .toEqual(['[unknown-evidence] unrecognized failure']);
});
