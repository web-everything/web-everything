import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAiRouting } from '../../lib/ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY } from '../../lib/dispatch-routing-policy.mjs';
import { resolveOperationRoute, resolveOperationEffort } from '../../lib/dispatch-routing-policy-io.mjs';
import * as routingPolicyIo from '../../lib/dispatch-routing-policy-io.mjs';
import { selectReviewSeatProvider } from '../../lib/provider-routing.mjs';
import { createRedTeamIo, speculateRedTeam, reserveSeatCalls, RED_TEAM_MODELS, RECHECK_MODEL } from '../review-extra-seats.mjs';

const NOW = Date.parse('2026-11-16T15:00:00Z');
const read = { title: 'guard', body: '', diffText: 'diff --git a/x.mjs b/x.mjs\n+guard();',
  netChangedFiles: ['x.mjs'], netBasis: { rev: 'a'.repeat(40) } };
const setting = (role, coordinator, executors = 'inherit') => resolveAiRouting({ env: {}, platform: {},
  tool: { [role]: { coordinator, executors } }, accountMap: { accounts: {} }, log: false });
const empty = () => resolveAiRouting({ env: {}, platform: {}, tool: {}, accountMap: { accounts: {} }, log: false });
const inherit = { provider: 'inherit', model: 'inherit', effort: 'inherit', account: 'inherit' };
const route = { provider: 'agy-claude', model: 'claude-sonnet-5-5-medium', effort: 'medium' };

async function seat(readAiRouting = empty, overrides = {}, env = {}) {
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
  const result = await speculateRedTeam({ pr: 1, repo: 'test/repo', read, env, post: false, record: false }, io);
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
  const available = ['codex', 'agy-claude'];
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

test('red-team overlays provider/model/effort and ignores executors', async () => {
  const { calls, reservations } = await seat(() => setting('red-team', { ...route, effort: 'high' }, ['codex']));
  assert.deepEqual(reservations, ['agy-claude']);
  assert.equal(calls[0].provider, 'agy-claude');
  assert.equal(calls[0].model, 'claude-sonnet-5-5-medium');
  assert.equal(calls[0].effort, 'high');
});

test('recheck overlays provider/model/effort and ignores executors', async () => {
  const call = await recheck(() => setting('red-team-recheck', { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, ['codex']));
  assert.equal(call.model, 'claude-opus-5-5');
  assert.equal(call.effort, 'high');
});

for (const reason of ['held', 'capped', 'CLI unavailable', 'reservation denied']) {
  test(`red-team overlay cannot use a provider that is ${reason}`, async () => {
    const overrides = reason === 'held' ? { readRecords: () => [{ dispatchKind: 'review-seat', provider: 'agy-claude',
      scoredAt: new Date(NOW).toISOString(), callStatus: 'quota', quotaUsedPercent: 100,
      quotaResetsAt: new Date(NOW + 3600000).toISOString() }] }
      : reason === 'CLI unavailable' ? { cliAvailable: provider => provider !== 'agy-claude' }
        : reason === 'reservation denied' ? { reserveCalls: ({ provider }) => ({ used: 300, callIds: provider === 'agy-claude' ? [] : ['fallback'] }) } : {};
    const { calls, logs } = await seat(() => setting('red-team', route), overrides,
      reason === 'capped' ? { WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '0' } : {});
    assert.equal(calls[0].provider, 'codex');
    assert.ok(logs.some(line => line.includes('agy-claude unavailable')));
  });
}

test('recheck overlay outside available inherits today’s route', async () => {
  const call = await recheck(() => setting('red-team-recheck', route));
  const baseline = await recheck();
  assert.equal(call.model, baseline.model);
  assert.equal(call.effort, baseline.effort);
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

for (const effort of ['low', 'medium']) {
  test(`red-team ${effort} overlay retains today's effort and logs the floor`, async () => {
    const baseline = await seat();
    const { calls, logs } = await seat(() => setting('red-team', { ...route, effort }));
    assert.equal(calls[0].provider, route.provider);
    assert.equal(calls[0].model, route.model);
    assert.equal(calls[0].effort, baseline.calls[0].effort);
    assert.ok(logs.some(line => line.includes(`effort ${effort} below today's ${baseline.calls[0].effort}; keeping today's effort`)));
  });

  test(`recheck ${effort} overlay retains today's effort and logs the floor`, async () => {
    const baseline = await recheck();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const call = await recheck(() => setting('red-team-recheck', { provider: 'claude', model: 'claude-opus-5-5', effort }));
      assert.equal(call.model, 'claude-opus-5-5');
      assert.equal(call.effort, baseline.effort);
      assert.ok(stderr.mock.calls.some(([line]) => line.includes(`effort ${effort} below today's ${baseline.effort}; keeping today's effort`)));
    } finally { stderr.mockRestore(); }
  });
}

test('red-team roster rejects native Claude so counting Claude review seats remain separate', async () => {
  const { calls, logs } = await seat(() => setting('red-team', { provider: 'claude', model: 'sonnet' }));
  assert.deepEqual(calls, (await seat()).calls);
  assert.notEqual(calls[0].provider, 'claude');
  assert.ok(logs.some(line => line.includes('claude unavailable')));
});

for (const resolver of [() => { throw new Error('unreadable'); }, () => ({}),
  () => setting('red-team', { provider: 'codex', model: 'not-a-model' }),
  () => ({ value: { 'red-team': { coordinator: { provider: 'codex', model: 'not-a-model' } } } })]) {
  test('invalid or throwing resolution inherits at both sites', async () => {
    const baseline = await seat();
    const actual = await seat(resolver);
    assert.deepEqual(actual.calls, baseline.calls);
    const baselineRecheck = await recheck();
    const actualRecheck = await recheck(resolver);
    assert.equal(actualRecheck.model, baselineRecheck.model);
    assert.equal(actualRecheck.effort, baselineRecheck.effort);
  });
}

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

test('red-team effort floor follows today’s resolved xhigh effort rather than a fixed high floor', async () => {
  const resolved = vi.spyOn(routingPolicyIo, 'resolveOperationRoute').mockReturnValueOnce({ provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
  try {
    const { calls, logs } = await seat(() => setting('red-team', { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }));
    assert.equal(calls[0].effort, 'xhigh');
    assert.ok(logs.some(line => line.includes("effort high below today's xhigh; keeping today's effort")));
  } finally { resolved.mockRestore(); }
});

test('red-team overlay may raise effort above today’s floor', async () => {
  const { calls } = await seat(() => setting('red-team', { provider: 'codex', model: 'gpt-6-astra', effort: 'max' }));
  assert.equal(calls[0].effort, 'max');
});

test('overlay validation preserves the mandatory counting-Claude-seat rule', async () => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  // An incomplete shadow policy must never be legitimized by the new overlay.
  policy.operations['review-seat:mandatory:correctness'] = {
    provider: 'agy-claude', model: 'sonnet', mode: 'shadow', fallback: [],
  };
  const { calls, logs } = await seat(() => setting('red-team', { provider: 'codex', model: 'gpt-6-astra' }),
    { readRoutingPolicy: () => policy });
  assert.deepEqual(calls, (await seat()).calls);
  assert.ok(logs.some(line => line.includes('claude route in fallback to count')));
});
