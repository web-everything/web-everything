import scenario from './red-team-dead-owner-never-redispatched.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
defineBreakTest(scenario);

it('daemon tick resumes interrupted abandonment and publishes exactly once', async () => {
  expect(scenario.judge(await scenario.run({ interruptAbandonment: true }))).toEqual([]);
});

it('daemon tick recovers a dead status-write claim and publishes exactly once', async () => {
  expect(scenario.judge(await scenario.run({ staleClaim: true }))).toEqual([]);
});

it('daemon tick recovers and publishes once when OPERATION_RUNS_DIR overrides the shared run store', async () => {
  expect(scenario.judge(await scenario.run({ operationRunsOverride: true }))).toEqual([]);
});
