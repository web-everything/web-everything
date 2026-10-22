import { afterEach, expect, it, vi } from 'vitest';
import { resolveDispatchRoute } from '../dispatch-routing-policy-io.mjs';
import { decideDispatchRoute } from '../dispatch-contracts.mjs';
import { DEFAULT_ROUTING_POLICY } from '../dispatch-routing-policy.mjs';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('logs direct-launch provider provenance once without changing any route fields', () => {
  vi.stubEnv('WE_DIRECT_LAUNCH_BUILD_PROVIDER', 'claude');
  const dispatch = { kind: 'build', size: 3, scopePaths: ['we:scripts/example.mjs'] };
  const options = { routingPolicy: DEFAULT_ROUTING_POLICY, scorecards: [], now: 0 };
  const log = vi.fn();
  const withoutLog = resolveDispatchRoute(dispatch, options);
  const withLog = resolveDispatchRoute(dispatch, { ...options, log });
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('direct launch build: provider claude (preference directLaunch.build.provider, source env)');
  expect(withLog).toEqual(withoutLog);
  expect(withLog).toEqual(decideDispatchRoute(dispatch, { ...options, availability: {} }));
});

it('keeps the default logger silent under the test runner', () => {
  vi.stubEnv('WE_UNDER_TEST', '1');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  resolveDispatchRoute({ kind: 'build', size: 3 }, { routingPolicy: DEFAULT_ROUTING_POLICY });
  expect(error).not.toHaveBeenCalled();
});


it('returns the selected route even when the preference logger throws', () => {
  const dispatch = { kind: 'build', size: 3, scopePaths: ['we:scripts/example.mjs'] };
  const options = { routingPolicy: DEFAULT_ROUTING_POLICY, scorecards: [], now: 0 };
  const expected = resolveDispatchRoute(dispatch, { ...options, log: () => {} });
  const log = vi.fn(() => { throw new Error('logger unavailable'); });
  expect(resolveDispatchRoute(dispatch, { ...options, log })).toEqual(expected);
  expect(log).toHaveBeenCalledTimes(1);
});
