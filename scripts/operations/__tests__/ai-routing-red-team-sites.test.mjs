import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAiRouting } from '../../lib/ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY } from '../../lib/dispatch-routing-policy.mjs';
import { createRoutingPolicyReader, resolveOperationRoute, resolveOperationEffort } from '../../lib/dispatch-routing-policy-io.mjs';
import * as routingPolicyIo from '../../lib/dispatch-routing-policy-io.mjs';
import { buildDelegationMarker } from '../../lib/delegation-marker.mjs';
import { selectReviewSeatProvider } from '../../lib/provider-routing.mjs';
import { createRedTeamIo, speculateRedTeam, reserveSeatCalls, RED_TEAM_MODELS, RECHECK_MODEL } from '../review-extra-seats.mjs';

const NOW = Date.parse('2026-11-16T15:00:00Z');
const read = { title: 'guard', body: '', diffText: 'diff --git a/x.mjs b/x.mjs\n+guard();',
  netChangedFiles: ['x.mjs'], netBasis: { rev: 'a'.repeat(40) } };
const setting = (role, coordinator, executors = 'inherit') => resolveAiRouting({ env: {}, platform: {},
  tool: { [role]: { coordinator, executors } }, accountMap: { accounts: {} }, log: false });
const empty = () => resolveAiRouting({ env: {}, platform: {}, tool: {}, accountMap: { accounts: {} }, log: false });
const inherit = { provider: 'inherit', model: 'inherit', effort: 'inherit', account: 'inherit' };
const route = { provider: 'agy-claude', model: 'claude-sonnet-5-5', effort: 'medium' };
const providerOnly = (role, provider) => () => ({ value: { [role]: { coordinator: { provider } } } });

async function seat(readAiRouting = empty, overrides = {}, env = {}, speculate = speculateRedTeam) {
  const calls = [], reservations = [], logs = [];
  const io = {
    readAiRouting, readRoutingPolicy: () => structuredClone(DEFAULT_ROUTING_POLICY),
    now: () => NOW, log: line => logs.push(line), readRecords: () => [], cliAvailable: () => true,
    reserveCalls: options => {
      reservations.push(options.provider);
      return reserveSeatCalls({ ...options, records: io.readRecords(), ledger: null, newId: () => 'test-call' });
    },
    makeScratch: () => join(tmpdir(), 'ai-routing-red-team-fixture'), removeScratch: () => {},
    writeFile: () => {}, readHeadMessage: () => '',
    runSeat: async options => {
      calls.push(options);
      const text = JSON.stringify({ lenses: { 'red-team': { verdict: 'accept', findings: [] } } });
      return { report: options.provider === 'codex' ? { lastMessage: text, exitCode: 0 } : { events: { finalResponse: text } } };
    },
    ...overrides,
  };
  const result = await speculate({ pr: 1, repo: 'test/repo', read, env, post: false, record: false }, io);
  return { result, calls, reservations, logs };
}

async function recheck(readAiRouting = empty, readsRepo = false, extra = {}) {
  const calls = [];
  const io = createRedTeamIo({ env: {}, readAiRouting, readRoutingPolicy: () => DEFAULT_ROUTING_POLICY,
    spawnRecheck: async options => { calls.push(options); return { value: { checks: [] } }; }, ...extra });
  await io.runRecheck({ pr: 1, readsRepo });
  return calls[0];
}

test('red-team empty and all-inherit match today’s provider, model and effort', async () => {
  const available = ['codex'];
  const configured = resolveOperationRoute({ operation: 'review-seat', taskType: 'red-team', available, policy: DEFAULT_ROUTING_POLICY });
  const provider = configured?.provider ?? selectReviewSeatProvider({ lens: 'red-team', available, scorecards: [] }).provider;
  for (const resolver of [empty, () => setting('red-team', inherit)]) {
    const { result, calls } = await seat(resolver);
    assert.equal(result.status, 'speculated');
    assert.equal(calls[0].provider, provider);
    assert.equal(calls[0].model, configured?.model ?? RED_TEAM_MODELS[provider].model);
    assert.equal(calls[0].effort, configured?.effort ?? resolveOperationEffort('review-seat', provider, 'red-team'));
  }
});

test('recheck empty and all-inherit match today’s model and effort', async () => {
  const configured = resolveOperationRoute({ operation: 'review-recheck', available: ['claude', 'codex', 'antigravity'] });
  for (const resolver of [empty, () => setting('red-team-recheck', inherit)]) {
    const call = await recheck(resolver);
    assert.equal(call.model, configured?.model ?? RECHECK_MODEL);
    assert.equal(call.effort, configured?.effort ?? resolveOperationEffort('review-recheck', 'claude'));
    assert.equal(call.allowedTools, undefined);
  }
});

test('overlay model/effort warning logs once across both roles and repeated calls', async () => {
  // A fresh module represents a fresh process without exposing a reset hook in production.
  vi.resetModules();
  const fresh = await import('../review-extra-seats.mjs');
  const logs = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(line => { logs.push(line); return true; });
  try {
    const io = fresh.createRedTeamIo({ env: {},
      readAiRouting: () => setting('red-team-recheck', { provider: 'claude', model: 'claude-sonnet-4-6', effort: 'low' }),
      readRoutingPolicy: () => DEFAULT_ROUTING_POLICY,
      spawnRecheck: async () => ({ value: { checks: [] } }),
    });
    await io.runRecheck({ pr: 1, readsRepo: false });
    await io.runRecheck({ pr: 1, readsRepo: false });
    await seat(() => setting('red-team', route), { log: line => logs.push(line) }, {}, fresh.speculateRedTeam);
    assert.equal(logs.filter(line => line.includes('overlay model/effort ignored')).length, 1);
  } finally { stderr.mockRestore(); }
});

test('red-team overlay cannot select emergency agy-claude while ordinary budget remains', async () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['review-seat:red-team'] = { provider: 'codex', model: 'astra', effort: 'high', fallback: [] };
  const { calls, reservations, logs } = await seat(() => ({ value: { 'red-team': { coordinator: { provider: 'agy-claude' }, executors: ['codex'] } } }), { readRoutingPolicy: () => policy });
  assert.deepEqual(reservations, ['codex']);
  assert.equal(calls[0].provider, 'codex');
  assert.ok(logs.some(line => line.includes('agy-claude unavailable')));
});

for (const fallback of [[], [{ provider: 'agy-gemini', model: 'flash', effort: 'high' }]]) {
  test.each(['high', 'xhigh'])(`red-team emergency overlay preserves ordinary routing without a matching repository fallback (%s, ${fallback.length} fallbacks)`, async effort => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations['review-seat:red-team'] = {
      provider: 'codex', model: 'astra', effort, fallback,
    };
    const readRoutingPolicy = createRoutingPolicyReader({ env: {},
      read: () => JSON.stringify(policy),
      preferences: () => ({ errors: [], prefs: {} }), emit: () => {},
    });
    const resolved = setting('red-team', { provider: 'agy-claude', model: 'sonnet' });
    assert.deepEqual(resolved.invalid, []);
    const baseline = await seat(empty, { readRoutingPolicy });
    assert.deepEqual(readRoutingPolicy.operatorKeys(), []);
    assert.equal(baseline.result.status, 'speculated');
    assert.equal(baseline.calls[0].provider, 'codex');
    assert.equal(baseline.calls[0].effort, effort);
    const actual = await seat(() => resolved, { readRoutingPolicy });
    assert.equal(actual.result.status, 'speculated', actual.result.reason);
    assert.deepEqual(actual.reservations, baseline.reservations);
    assert.deepEqual(actual.calls, baseline.calls);
  });
}

test('red-team emergency overlay preserves ordinary routing even with a matching fallback', async () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['review-seat:red-team'] = {
    provider: 'codex', model: 'astra', effort: 'high',
    fallback: [{ provider: 'agy-claude', model: 'opus-5-5', effort: 'high' }],
  };
  const { result, calls } = await seat(() => setting('red-team', { provider: 'agy-claude', model: 'sonnet' }),
    { readRoutingPolicy: () => policy });
  assert.equal(result.status, 'speculated', result.reason);
  assert.equal(calls[0].provider, 'codex');
  assert.equal(calls[0].model, policy.aliases.codex.astra);
  assert.equal(calls[0].effort, 'high');
});

for (const unavailable of ['CLI', 'quota', 'cap']) {
  test(`red-team overlay supplies a route when the default provider is unavailable (${unavailable})`, async () => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations['review-seat:red-team'] = { provider: 'codex', model: 'astra', effort: 'high', fallback: [] };
    const overrides = { readRoutingPolicy: () => policy,
      ...(unavailable === 'CLI' ? { cliAvailable: provider => provider !== 'codex' }
        : unavailable === 'quota' ? { readRecords: () => [{ dispatchKind: 'review-seat', provider: 'codex',
          scoredAt: new Date(NOW).toISOString(), callStatus: 'quota', quotaUsedPercent: 100,
          quotaResetsAt: new Date(NOW + 3600000).toISOString() }] } : {}),
    };
    const env = { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '20', ...(unavailable === 'cap' ? { WE_REVIEW_SEAT_CAP_CODEX: '0' } : {}) };
    for (const resolver of [empty, () => setting('red-team', { provider: 'bogus', model: 'sonnet' }),
      () => setting('red-team', { provider: 'codex', model: 'astra' })]) {
      const baseline = await seat(resolver, overrides, env);
      assert.equal(baseline.result.status, 'skipped');
      assert.deepEqual(baseline.reservations, []);
      assert.deepEqual(baseline.calls, []);
      assert.match(baseline.result.reason, /no available route/);
    }
    const actual = await seat(() => setting('red-team', { provider: 'agy-claude', model: 'sonnet' }), overrides, env);
    assert.equal(actual.result.status, 'skipped');
    assert.deepEqual(actual.reservations, []);
    assert.deepEqual(actual.calls, []);
    assert.match(actual.result.reason, /no available route/);
  });
}

test('red-team Codex overlay uses provider defaults outside the repository route chain', async () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['review-seat:red-team'] = {
    provider: 'agy-claude', model: 'sonnet', effort: 'high', fallback: [],
  };
  const { result, calls, reservations } = await seat(() => setting('red-team', { provider: 'codex', model: 'sol' }),
    { readRoutingPolicy: () => policy });
  assert.equal(result.status, 'speculated', result.reason);
  assert.deepEqual(reservations, ['codex']);
  assert.equal(calls[0].provider, 'codex');
  assert.equal(calls[0].model, RED_TEAM_MODELS.codex.model);
  assert.equal(calls[0].effort, 'high');
});

for (const unavailable of ['policy cap', 'explicit cap', 'CLI', 'quota']) {
  for (const fallback of [[], [{ provider: 'codex', model: 'astra', effort: 'high' }]]) {
    test(`red-team overlay outside the repository route chain cannot enable a disabled provider (${unavailable}, ${fallback.length} fallbacks)`, async () => {
      const policy = structuredClone(DEFAULT_ROUTING_POLICY);
      policy.operations['review-seat:red-team'] = {
        provider: 'codex', model: 'astra', effort: 'high', fallback, disabledProviders: ['agy-claude'],
      };
      const resolved = setting('red-team', { provider: 'agy-claude', model: 'sonnet' });
      assert.deepEqual(resolved.invalid, []);
      const overrides = { readRoutingPolicy: () => policy,
        ...(unavailable === 'CLI' ? { cliAvailable: provider => provider !== 'agy-claude' }
          : unavailable === 'quota' ? { readRecords: () => [{ dispatchKind: 'review-seat', provider: 'agy-claude',
            scoredAt: new Date(NOW).toISOString(), callStatus: 'quota', quotaUsedPercent: 100,
            quotaResetsAt: new Date(NOW + 3600000).toISOString() }] } : {}),
      };
      const { result, calls, reservations } = await seat(() => resolved, overrides,
        unavailable === 'explicit cap' ? { WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '0' } : {});
      assert.equal(result.status, 'skipped');
      assert.match(result.reason, /no available route/);
      assert.deepEqual(calls, []);
      assert.deepEqual(reservations, []);
    });
  }
}

test.each(['high', 'xhigh'])('Claude recheck overlay uses seat defaults without a matching repository fallback (%s)', async effort => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['review-recheck'] = { provider: 'codex', model: 'astra', effort, fallback: [] };
  const baseline = resolveOperationRoute({ operation: 'review-recheck', policy });
  // The initial recheck read uses the module's global policy reader; inject its resolved snapshot.
  const resolved = vi.spyOn(routingPolicyIo, 'resolveOperationRoute').mockReturnValueOnce(baseline);
  try {
    const call = await recheck(() => setting('red-team-recheck', { provider: 'claude', model: 'sonnet' }),
      false, { readRoutingPolicy: () => policy });
    assert.equal(call.model, RECHECK_MODEL);
    assert.equal(call.effort, 'high');
    assert.equal(call.budget, 1);
  } finally { resolved.mockRestore(); }
});

for (const key of ['review-seat', 'review-seat:red-team']) {
  for (const fallback of [[], [{ provider: 'agy-claude', model: 'sonnet' }]]) {
    test(`red-team conflicting overlay preserves operator pin ${key} with ${fallback.length} fallbacks`, async () => {
      const policy = structuredClone(DEFAULT_ROUTING_POLICY);
      // Exercise an effective operation-wide pin rather than the more specific repo default.
      if (key === 'review-seat') delete policy.operations['review-seat:red-team'];
      const readRoutingPolicy = createRoutingPolicyReader({ env: {},
        read: () => JSON.stringify(policy),
        preferences: () => ({ errors: [], prefs: { routingOverrides: {
          [key]: { provider: 'codex', model: 'astra', fallback },
        } } }),
        emit: () => {},
      });
      const resolved = setting('red-team', route);
      assert.deepEqual(resolved.invalid, []);
      const baseline = await seat(empty, { readRoutingPolicy });
      assert.deepEqual(readRoutingPolicy.operatorKeys(), [key]);
      assert.equal(baseline.result.status, 'speculated');
      assert.equal(baseline.calls[0].provider, 'codex');
      const actual = await seat(() => resolved, { readRoutingPolicy });
      assert.equal(actual.result.status, 'speculated', actual.result.reason);
      assert.deepEqual(actual.reservations, ['codex']);
      assert.deepEqual(actual.calls, baseline.calls);
    });
  }
}

for (const model of ['claude-opus-5-5', 'claude-sonnet-4-6',
  ...['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(suffix => `${route.model}-${suffix}`)]) {
  test(`both roles ignore overlay model ${model} and effort`, async () => {
    // Raw input also covers values outside the settings reader's model catalog.
    const raw = (role, provider, effort) => () => ({ value: { [role]: { coordinator: { provider, model, effort } } } });
    const baseline = await seat(providerOnly('red-team', 'agy-claude'));
    const baselineRecheck = await recheck(providerOnly('red-team-recheck', 'claude'));
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      assert.deepEqual((await seat(raw('red-team', 'agy-claude', effort))).calls, baseline.calls);
      const call = await recheck(raw('red-team-recheck', 'claude', effort));
      assert.deepEqual({ ...call, runId: baselineRecheck.runId, spawnFn: baselineRecheck.spawnFn }, baselineRecheck);
    }
  });
}

test('catalog-valid overlay model and effort are ignored through the settings reader for both roles', async () => {
  const baseline = await seat(providerOnly('red-team', 'agy-claude'));
  assert.deepEqual((await seat(() => setting('red-team', { ...route, model: 'claude-sonnet-4-6', effort: 'max' }))).calls, baseline.calls);
  const baselineRecheck = await recheck();
  const call = await recheck(() => setting('red-team-recheck', { provider: 'claude', model: 'claude-sonnet-4-6', effort: 'max' }));
  assert.deepEqual({ ...call, runId: baselineRecheck.runId, spawnFn: baselineRecheck.spawnFn }, baselineRecheck);
});

test('model and effort without a provider retain inherited options for both roles', async () => {
  const baseline = await seat();
  assert.deepEqual((await seat(() => setting('red-team', { model: 'claude-sonnet-4-6', effort: 'max' }))).calls, baseline.calls);
  const baselineRecheck = await recheck();
  const call = await recheck(() => setting('red-team-recheck', { model: 'claude-sonnet-4-6', effort: 'max' }));
  assert.deepEqual({ ...call, runId: baselineRecheck.runId, spawnFn: baselineRecheck.spawnFn }, baselineRecheck);
});

test('recheck provider overlay ignores executors', async () => {
  const baseline = await recheck();
  const call = await recheck(() => ({ value: { 'red-team-recheck': { coordinator: { provider: 'claude' }, executors: ['codex'] } } }));
  assert.deepEqual({ ...call, runId: baseline.runId, spawnFn: baseline.spawnFn }, baseline);
});

for (const reason of ['held', 'capped', 'CLI unavailable', 'reservation denied']) {
  test(`red-team overlay cannot use a provider that is ${reason}`, async () => {
    const overrides = reason === 'held' ? { readRecords: () => [{ dispatchKind: 'review-seat', provider: 'agy-gemini',
      scoredAt: new Date(NOW).toISOString(), callStatus: 'quota', quotaUsedPercent: 100,
      quotaResetsAt: new Date(NOW + 3600000).toISOString() }] }
      : reason === 'CLI unavailable' ? { cliAvailable: provider => provider !== 'agy-gemini' }
        : reason === 'reservation denied' ? { reserveCalls: ({ provider }) => ({ used: 200, callIds: provider === 'agy-gemini' ? [] : ['fallback'] }) } : {};
    const resolved = setting('red-team', { provider: 'agy-gemini', model: RED_TEAM_MODELS['agy-gemini'].model, effort: 'high' });
    assert.deepEqual(resolved.invalid, []);
    const { calls: baselineCalls } = await seat(empty, overrides,
      { WE_REVIEW_SHADOW_AGY_PROMOTED: 'true', WE_REVIEW_SEAT_CAP_AGY_GEMINI: reason === 'capped' ? '0' : '20' });
    const { calls, logs } = await seat(() => resolved, overrides,
      { WE_REVIEW_SHADOW_AGY_PROMOTED: 'true', WE_REVIEW_SEAT_CAP_AGY_GEMINI: reason === 'capped' ? '0' : '20' });
    assert.deepEqual(calls, baselineCalls);
    assert.equal(calls[0].provider, 'codex');
    assert.ok(logs.some(line => line.includes('agy-gemini unavailable')));
  });
}

test('valid but unavailable recheck overlay logs and inherits today’s route', async () => {
  const resolved = setting('red-team-recheck', route);
  assert.deepEqual(resolved.invalid, []);
  const baseline = await recheck();
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const call = await recheck(() => resolved);
    assert.deepEqual({ ...call, runId: baseline.runId, spawnFn: baseline.spawnFn }, baseline);
    assert.ok(stderr.mock.calls.some(([line]) => line.includes('aiRouting.red-team-recheck: agy-claude cannot enforce')));
  } finally { stderr.mockRestore(); }
});

for (const provider of ['codex', 'antigravity', 'agy-claude']) {
  test(`non-Claude ${provider} recheck overlay logs and inherits even without repository reads`, async () => {
    const baseline = await recheck();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const call = await recheck(() => setting('red-team-recheck', { provider,
        model: provider === 'codex' ? 'gpt-6-astra' : provider === 'antigravity' ? 'gemini-3.1-pro' : route.model,
        effort: 'high' }));
      assert.deepEqual({ ...call, runId: baseline.runId, spawnFn: baseline.spawnFn }, baseline);
      assert.ok(stderr.mock.calls.some(([line]) => line.includes(`${provider} cannot enforce Claude's tool, budget and environment restrictions; inheriting today's route`)));
    } finally { stderr.mockRestore(); }
  });
}

test('non-Claude configured recheck route still refuses repository reads before spawning', async () => {
  let spawned = false;
  const resolved = vi.spyOn(routingPolicyIo, 'resolveOperationRoute').mockReturnValueOnce({ provider: 'codex', model: 'gpt-6-astra', effort: 'high' });
  try {
    await assert.rejects(recheck(empty, true,
      { spawnRecheck: async () => { spawned = true; } }), /repo re-check requires the Claude read-only tool allow-list/);
    assert.equal(spawned, false);
  } finally { resolved.mockRestore(); }
});

test('red-team roster rejects native Claude so counting Claude review seats remain separate', async () => {
  const { calls, logs } = await seat(() => setting('red-team', { provider: 'claude', model: 'sonnet' }));
  assert.deepEqual(calls, (await seat()).calls);
  assert.notEqual(calls[0].provider, 'claude');
  assert.ok(logs.some(line => line.includes('claude unavailable')));
});

for (const role of ['red-team', 'red-team-recheck']) {
  for (const input of ['invalid', 'unreadable']) {
    test(`${role} ${input} settings log and inherit today’s route`, async () => {
      const resolver = ({ log }) => {
        if (input === 'unreadable') throw new Error('unreadable settings');
        assert.equal(typeof log, 'function');
        return resolveAiRouting({ env: {}, platform: {}, log, accountMap: { accounts: {} },
          tool: { [role]: { coordinator: { provider: role === 'red-team' ? 'codex' : 'claude', model: 'not-a-model' } } } });
      };
      const expected = input === 'invalid'
        ? `aiRouting.${role}: ignored invalid settings: tool.${role}.coordinator.model`
        : `aiRouting.${role}: invalid routing (unreadable settings); inheriting today's route`;
      if (role === 'red-team') {
        const baseline = await seat();
        const actual = await seat(resolver);
        assert.deepEqual(actual.calls, baseline.calls);
        assert.ok(actual.logs.some(line => line.includes(expected)));
      } else {
        const baseline = await recheck();
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
          const call = await recheck(resolver);
          assert.deepEqual({ ...call, runId: baseline.runId, spawnFn: baseline.spawnFn }, baseline);
          assert.ok(stderr.mock.calls.some(([line]) => line.includes(expected)));
        } finally { stderr.mockRestore(); }
      }
    });
  }
}

test('incomplete aiRouting settings inherit at both sites', async () => {
  const resolver = () => ({});
  assert.deepEqual((await seat(resolver)).calls, (await seat()).calls);
  const baseline = await recheck();
  const call = await recheck(resolver);
  assert.deepEqual({ ...call, runId: baseline.runId, spawnFn: baseline.spawnFn }, baseline);
});

test('executor-only settings do not alter either single seat', async () => {
  assert.deepEqual((await seat(() => setting('red-team', inherit, ['claude']))).calls, (await seat()).calls);
  assert.equal((await recheck(() => setting('red-team-recheck', inherit, ['codex']))).model, (await recheck()).model);
});

test('all-inherit retains byte-identical red-team call options', async () => {
  assert.equal(JSON.stringify((await seat(() => setting('red-team', inherit))).calls), JSON.stringify((await seat()).calls));
});

test('all-inherit retains byte-identical recheck call options apart from per-call identity', async () => {
  const baseline = await recheck();
  const call = await recheck(() => setting('red-team-recheck', inherit));
  assert.equal(JSON.stringify({ ...call, runId: baseline.runId }), JSON.stringify(baseline));
});

test('provider-only overlay preserves today’s resolved model and xhigh effort', async () => {
  const today = { provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh' };
  const resolved = vi.spyOn(routingPolicyIo, 'resolveOperationRoute').mockReturnValueOnce(today);
  try {
    const { calls } = await seat(() => setting('red-team', { provider: 'codex', model: 'gpt-6-sol', effort: 'max' }));
    assert.equal(calls[0].model, today.model);
    assert.equal(calls[0].effort, today.effort);
  } finally { resolved.mockRestore(); }
});

test('overlay validation preserves the mandatory counting-Claude-seat rule', async () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  // An incomplete shadow policy must never be legitimized by the new overlay.
  policy.operations['review-seat:mandatory:correctness'] = {
    provider: 'agy-claude', model: 'sonnet', mode: 'shadow', fallback: [],
  };
  const { result, calls, reservations } = await seat(() => setting('red-team', { provider: 'codex', model: 'gpt-6-astra' }),
    { readRoutingPolicy: () => policy });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /claude route in fallback to count/);
  assert.deepEqual(calls, []);
  assert.deepEqual(reservations, []);
});

test('recheck overlay validation refuses an incomplete counting-Claude-seat policy before spawning', async () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['review-seat:mandatory:correctness'] = {
    provider: 'agy-claude', model: 'sonnet', mode: 'shadow', fallback: [],
  };
  let spawned = false;
  await assert.rejects(recheck(providerOnly('red-team-recheck', 'claude'), false, {
    readRoutingPolicy: () => policy,
    spawnRecheck: async () => { spawned = true; },
  }), /claude route in fallback to count/);
  assert.equal(spawned, false);
});

const builderSeat = (builder, overrides = {}, env = {}) => seat(empty, overrides, env,
  (args, io) => speculateRedTeam({ ...args, read: { ...args.read,
    body: buildDelegationMarker({ provider: builder, model: 'gpt-6-astra', taskType: 'bugfix' }) } }, io));

test.each(['policy', 'overlay'])('unpromoted Carbon from %s falls back before reservation', async source => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.aliases['agy-gemini']['probation-model'] = RED_TEAM_MODELS['agy-gemini'].model;
  if (source === 'policy') policy.operations['review-seat:red-team'] = {
    provider: 'agy-gemini', model: 'probation-model', effort: 'high',
    fallback: [{ provider: 'codex', model: 'sol', effort: 'high' }],
  };
  const actual = await seat(source === 'overlay' ? providerOnly('red-team', 'agy-gemini') : empty,
    { readRoutingPolicy: () => policy }, { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '20', WE_REVIEW_SHADOW_AGY_PROMOTED: 'false' });
  assert.equal(actual.result.status, 'speculated', actual.result.reason);
  assert.deepEqual(actual.reservations, ['codex']);
  assert.equal(actual.calls[0].provider, 'codex');
  assert.ok(actual.logs.some(line => /Carbon not promoted.*fallback/.test(line)));
});

test('unpromoted Carbon cannot escape an operator route with no allowed fallback', async () => {
  const readRoutingPolicy = createRoutingPolicyReader({ env: {}, read: () => JSON.stringify(DEFAULT_ROUTING_POLICY),
    preferences: () => ({ errors: [], prefs: { routingOverrides: {
      'review-seat:red-team': { provider: 'agy-gemini', model: RED_TEAM_MODELS['agy-gemini'].model, effort: 'high', fallback: [] },
    } } }), emit: () => {},
  });
  const actual = await builderSeat('codex', { readRoutingPolicy }, {
    WE_REVIEW_SEAT_CAP_AGY_GEMINI: '20', WE_REVIEW_SHADOW_AGY_PROMOTED: 'false',
  });
  assert.equal(actual.result.status, 'skipped');
  assert.match(actual.result.reason, /Carbon not promoted/);
  assert.deepEqual(actual.reservations, []);
  assert.deepEqual(actual.calls, []);
});

test('builder preference preserves policy model and effort in both directions', async () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['review-seat:red-team'] = { provider: 'codex', model: 'sol', effort: 'xhigh',
    fallback: [{ provider: 'agy-gemini', model: 'flash', effort: 'medium' }] };
  for (const [builder, provider, model, effort] of [
    ['codex', 'agy-gemini', policy.aliases['agy-gemini'].flash, 'medium'],
    ['claude', 'codex', policy.aliases.codex.sol, 'xhigh'],
  ]) {
    const actual = await builderSeat(builder, { readRoutingPolicy: () => policy }, {
      WE_REVIEW_SEAT_CAP_AGY_GEMINI: '20', WE_REVIEW_SHADOW_AGY_PROMOTED: 'false',
    });
    assert.equal(actual.result.status, 'speculated', actual.result.reason);
    assert.deepEqual([actual.calls[0].provider, actual.calls[0].model, actual.calls[0].effort], [provider, model, effort]);
  }
});

test.each(['review-seat:red-team', 'review-seat', '*'])('explicit %s operator route admits agy-claude before emergency', async key => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  if (key !== 'review-seat:red-team') delete policy.operations['review-seat:red-team'];
  if (key === '*') delete policy.operations['review-seat'];
  const readRoutingPolicy = createRoutingPolicyReader({ env: {}, read: () => JSON.stringify(policy),
    preferences: () => ({ errors: [], prefs: { routingOverrides: {
      [key]: { provider: 'agy-claude', model: 'sonnet', effort: 'high', fallback: [] },
    } } }), emit: () => {},
  });
  const actual = await builderSeat('claude', { readRoutingPolicy });
  assert.deepEqual(readRoutingPolicy.operatorKeys(), [key]);
  assert.equal(actual.result.status, 'speculated', actual.result.reason);
  assert.deepEqual(actual.reservations, ['agy-claude']);
  assert.deepEqual([actual.calls[0].provider, actual.calls[0].model, actual.calls[0].effort],
    ['agy-claude', policy.aliases['agy-claude'].sonnet, 'high']);
  assert.ok(!actual.logs.some(line => line.includes('emergency fallback')));
});

test('explicit operator fallback admits agy-claude when Codex CLI is absent but its budget remains', async () => {
  const readRoutingPolicy = createRoutingPolicyReader({ env: {}, read: () => JSON.stringify(DEFAULT_ROUTING_POLICY),
    preferences: () => ({ errors: [], prefs: { routingOverrides: {
      'review-seat:red-team': { provider: 'codex', model: 'sol', effort: 'high',
        fallback: [{ provider: 'agy-claude', model: 'sonnet', effort: 'high' }] },
    } } }), emit: () => {},
  });
  const actual = await builderSeat('claude', { readRoutingPolicy, cliAvailable: provider => provider !== 'codex' });
  assert.equal(actual.result.status, 'speculated', actual.result.reason);
  assert.deepEqual(actual.reservations, ['agy-claude']);
  assert.equal(actual.calls[0].provider, 'agy-claude');
});

test.each(['cap', 'CLI', 'quota', 'reservation'])('explicit agy-claude operator route still refuses %s without escaping its chain', async blocked => {
  const readRoutingPolicy = createRoutingPolicyReader({ env: {}, read: () => JSON.stringify(DEFAULT_ROUTING_POLICY),
    preferences: () => ({ errors: [], prefs: { routingOverrides: {
      'review-seat:red-team': { provider: 'agy-claude', model: 'sonnet', effort: 'high', fallback: [] },
    } } }), emit: () => {},
  });
  const actual = await builderSeat('claude', { readRoutingPolicy,
    ...(blocked === 'CLI' ? { cliAvailable: provider => provider !== 'agy-claude' }
      : blocked === 'quota' ? { readRecords: () => [{ dispatchKind: 'review-seat', provider: 'agy-claude',
        scoredAt: new Date(NOW).toISOString(), callStatus: 'quota', quotaUsedPercent: 100,
        quotaResetsAt: new Date(NOW + 3600000).toISOString() }] }
      : blocked === 'reservation' ? { reserveCalls: () => ({ used: 10, callIds: [] }) } : {}),
  }, blocked === 'cap' ? { WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '0' } : {});
  assert.equal(actual.result.status, 'skipped');
  assert.deepEqual(actual.calls, []);
  if (blocked !== 'reservation') assert.deepEqual(actual.reservations, []);
});

test('operator review-seat:red-team override wins over builder preference', async () => {
  const readRoutingPolicy = createRoutingPolicyReader({ env: {}, read: () => JSON.stringify(DEFAULT_ROUTING_POLICY),
    preferences: () => ({ errors: [], prefs: { routingOverrides: {
      'review-seat:red-team': { provider: 'codex', model: 'sol', effort: 'xhigh', fallback: [] },
    } } }), emit: () => {},
  });
  const actual = await builderSeat('codex', { readRoutingPolicy }, { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '20' });
  assert.equal(actual.result.status, 'speculated', actual.result.reason);
  assert.deepEqual([actual.calls[0].provider, actual.calls[0].model, actual.calls[0].effort],
    ['codex', DEFAULT_ROUTING_POLICY.aliases.codex.sol, 'xhigh']);
});

for (const defect of ['model', 'effort']) {
  test(`builder routing refuses invalid policy ${defect} without dispatch`, async () => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations['review-seat:red-team'] = { provider: 'codex', model: 'sol', effort: 'high', fallback: [], [defect]: 'bogus' };
    const actual = await builderSeat('claude', { readRoutingPolicy: () => policy });
    assert.equal(actual.result.status, 'skipped');
    assert.match(actual.result.reason, /unknown model|unknown effort/);
    assert.deepEqual(actual.calls, []);
    assert.deepEqual(actual.reservations, []);
  });
}

for (const blocked of ['zero cap', 'operator disabled', 'outside chain']) {
  test(`builder cap fallback refuses Gemini when ${blocked} and emergency is unavailable`, async () => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    if (blocked === 'operator disabled') policy.operations['review-seat:red-team'].disabledProviders = ['agy-gemini'];
    if (blocked === 'outside chain') policy.operations['review-seat:red-team'] = {
      provider: 'codex', model: 'astra', effort: 'high', fallback: [],
    };
    const actual = await builderSeat('claude', { readRoutingPolicy: () => policy }, {
      WE_REVIEW_SEAT_CAP_CODEX: '0', WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '0',
      WE_REVIEW_SEAT_CAP_AGY_GEMINI: blocked === 'zero cap' ? '0' : '20',
    });
    assert.equal(actual.result.status, 'skipped');
    assert.match(actual.result.reason, /daily-cap|no available route/);
    assert.deepEqual(actual.calls, []);
    assert.deepEqual(actual.reservations, []);
  });
}

test('operator-disabled emergency provider is never dispatched at ordinary caps', async () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['review-seat:red-team'].disabledProviders = ['agy-claude'];
  const actual = await builderSeat('codex', { readRoutingPolicy: () => policy }, { WE_REVIEW_SEAT_CAP_CODEX: '0' });
  assert.equal(actual.result.status, 'skipped');
  assert.deepEqual(actual.calls, []);
  assert.deepEqual(actual.reservations, []);
});

test('emergency provider at its standard ten-call cap refuses dispatch and logs the reason', async () => {
  const actual = await builderSeat('codex', { readRecords: () => Array.from({ length: 10 }, (_, index) => ({
    dispatchKind: 'review-seat', provider: 'agy-claude', callId: `spent-${index}`,
    scoredAt: new Date(NOW).toISOString(), status: 'ok',
  })) }, { WE_REVIEW_SEAT_CAP_CODEX: '0' });
  assert.equal(actual.result.status, 'skipped');
  assert.match(actual.result.reason, /agy-claude: daily-cap: 10\/10/);
  assert.ok(actual.logs.some(line => /red team skipped:.*10\/10/.test(line)));
  assert.deepEqual(actual.calls, []);
  assert.deepEqual(actual.reservations, []);
});
