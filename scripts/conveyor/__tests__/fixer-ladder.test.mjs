import { describe, expect, it, vi } from 'vitest';
import { loadFixerLadder, readFixerEscalationOverride } from '../fixer-ladder.mjs';
import { fixerTableFor, withRulingNotAddressed } from '../reconcile-fix-dispatch.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { enrichPrsWithIgnoredRulings } from '../reconcile-pass.mjs';
import { buildAgentArgv } from '../../operations/dispatch-lane-io.mjs';
import { readRoutingPolicy } from '../../lib/dispatch-routing-policy-io.mjs';
import { resolveOperationRoute } from '../../lib/dispatch-routing-policy.mjs';
import { H1, H2, H3, H4, record, recordComment, ignoredRulingThread, BLOCK } from './ruling-fixtures.mjs';

const thread = (n) => [...ignoredRulingThread(),
  ...(n > 2 ? [recordComment(record({ head: H3, runId: 'run-3' }), 40)] : []),
  ...(n > 3 ? [recordComment(record({ head: H4, runId: 'run-4' }), 60)] : [])];
const heads = [null, H1, H2, H3, H4];
const plan = (n, ladder) => {
  const [pr] = enrichPrsWithIgnoredRulings([{ number: 3794, state: 'OPEN', headRefName: 'lane/x', headRefOid: heads[n], labels: [{ name: 'review:human' }, { name: 'advisory:changes' }],
    mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments: thread(n) }], { humanAt: ladder.humanAt });
  return planReconcile({ repo: 'we', prs: [pr], agents: [], now: Date.parse('2026-10-04T12:00:00Z'), requiredChecks: ['test'], fixerLadder: ladder });
};
const rungOf = (p) => p.dispatch[0]?.rulingNotAddressed?.rung?.id ?? (p.refusals[0]?.kind === 'ruling-dispute' ? 'human' : null);

describe('ladder loaded from the routing policy', () => {
  const ladder = loadFixerLadder({ override: null });
  it('models come from the routing policy, never hand-set: the stronger rung resolves to opus', () => {
    expect(ladder.routes['stronger-model']).toMatchObject({ provider: 'claude', model: 'claude-opus-5', source: 'routing-policy' });
    expect(ladder.routes.resend).toBeNull();
  });
  it('the critical-work gate keeps fix on Claude, so the cross-provider rung is dormant and the ladder asks the operator at miss 3', () => {
    expect(ladder.available({ id: 'cross-provider', action: 'dispatch', taskType: 'ruling-escalation-cross-provider', provider: 'codex' })).toBe(false);
    expect(ladder.humanAt).toBe(3);
  });
  it('with a launcher wired and the gate open for it, the cross-provider rung becomes available (humanAt 4)', () => {
    const open = structuredClone(readRoutingPolicy());
    open.criticalWorkGate.kinds = open.criticalWorkGate.kinds.filter((k) => k !== 'fix');
    const wired = loadFixerLadder({ override: null, routingPolicy: open, externalFixProviders: new Set(['codex']) });
    expect(wired.routes['cross-provider']).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
    expect(wired.humanAt).toBe(4);
  });
  it('the routing policy entries exist for both escalation task types', () => {
    const policy = readRoutingPolicy();
    expect(resolveOperationRoute({ operation: 'fix', taskType: 'ruling-escalation-stronger', available: ['claude'], gateClosed: true, policy }).model).toBe('claude-opus-5');
    expect(resolveOperationRoute({ operation: 'fix', taskType: 'ruling-escalation-cross-provider', available: ['claude', 'codex'], gateClosed: false, policy }).provider).toBe('codex');
  });
  it('a local override is read, merged, and an invalid one is reported and ignored', () => {
    const good = loadFixerLadder({ override: { rungs: { 'stronger-model': { at: 3 }, 'cross-provider': { at: 2, taskType: 'ruling-escalation-stronger', provider: 'claude' } } } });
    expect(good.error).toBeNull();
    expect(good.policy.rungs.map((r) => r.id)).toEqual(['resend', 'cross-provider', 'stronger-model', 'human']);
    const bad = loadFixerLadder({ override: { rungs: { resend: { at: -1 } } } });
    expect(bad.error).toMatch(/positive integer/);
    expect(bad.policy.rungs).toHaveLength(4);
    const missing = readFixerEscalationOverride({ read: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } });
    expect(missing).toEqual({ override: null });
    expect(readFixerEscalationOverride({ read: () => '{not json' }).error).toMatch(/not JSON/);
  });
});

describe('each rung of the ladder, planned', () => {
  const ladder = loadFixerLadder({ override: null });
  it('rung 1 (miss 1): resend to the same fixer, no model override', () => {
    const p = plan(2, ladder);
    expect(rungOf(p)).toBe('resend');
    expect(p.dispatch[0].rulingNotAddressed.route).toBeNull();
    expect(p.dispatch[0].rulingNotAddressed.rung.instruction).toBeNull();
  });
  it('rung 2 (miss 2): stronger model from the routing policy, failing test first', () => {
    const p = plan(3, ladder);
    expect(rungOf(p)).toBe('stronger-model');
    const r = p.dispatch[0].rulingNotAddressed;
    expect(r.route).toMatchObject({ provider: 'claude', model: 'claude-opus-5' });
    expect(r.rung).toMatchObject({ instruction: 'test-first', model: 'claude-opus-5' });
    expect(p.dispatch[0].why).toMatch(/escalation rung 2 \(stronger-model\)/);
  });
  it('rung 3 (miss 3): operator, because the cross-provider rung is unavailable by default', () => {
    const p = plan(4, ladder);
    expect(rungOf(p)).toBe('human');
    expect(p.notes.find((n) => n.kind === 'ruling-dispute').text).toMatch(/Ladder so far: resend > stronger-model/);
  });
  it('rung 3 (miss 3) is the cross-provider fixer when it is available', () => {
    const open = structuredClone(readRoutingPolicy());
    open.criticalWorkGate.kinds = open.criticalWorkGate.kinds.filter((k) => k !== 'fix');
    const wired = loadFixerLadder({ override: null, routingPolicy: open, externalFixProviders: new Set(['codex']) });
    const p = plan(4, wired);
    expect(rungOf(p)).toBe('cross-provider');
    expect(p.dispatch[0].rulingNotAddressed.route.provider).toBe('codex');
    expect(p.dispatch[0].rulingNotAddressed.rung.instruction).toBe('test-first');
  });
  it('rung 4 (miss 4 with codex available): operator', () => {
    const open = structuredClone(readRoutingPolicy());
    open.criticalWorkGate.kinds = open.criticalWorkGate.kinds.filter((k) => k !== 'fix');
    const wired = loadFixerLadder({ override: null, routingPolicy: open, externalFixProviders: new Set(['codex']) });
    const comments5 = [...thread(4), recordComment(record({ head: 'e'.repeat(40), runId: 'run-5' }), 80)];
    const [pr] = enrichPrsWithIgnoredRulings([{ number: 3794, state: 'OPEN', headRefName: 'lane/x', headRefOid: 'e'.repeat(40), labels: [{ name: 'review:human' }],
      mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments: comments5 }], { humanAt: wired.humanAt });
    const p = planReconcile({ repo: 'we', prs: [pr], agents: [], now: 0, requiredChecks: ['test'], fixerLadder: wired });
    expect(p.refusals.map((r) => r.kind)).toEqual(['ruling-dispute']);
    expect(p.dispatch).toEqual([]);
  });
  it('a configured ladder changes the thresholds (config extends the default)', () => {
    const custom = loadFixerLadder({ override: { rungs: { 'stronger-model': { at: 1 } }, disable: ['resend'] } });
    expect(rungOf(plan(2, custom))).toBe('stronger-model');
  });
});

describe('what the dispatch does with a rung', () => {
  const ladder = loadFixerLadder({ override: null });
  const ruling = (n) => plan(n, ladder).dispatch[0].rulingNotAddressed;
  it('resend: no table (the ordinary fix route)', () => expect(fixerTableFor(ruling(2))).toBeNull());
  it('stronger model: the routing-policy table, which buildAgentArgv turns into --model opus', () => {
    const table = fixerTableFor(ruling(3));
    expect(table).toMatchObject({ model: 'claude-opus-5', effort: 'high', reason: 'fixer-escalation rung stronger-model' });
    const argv = buildAgentArgv({ sessionId: 's', payload: { prompt: 'BRIEF', sessionSlug: 'fix-3794', launchKind: 'fix' }, table });
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    const plain = buildAgentArgv({ sessionId: 's', payload: { prompt: 'BRIEF', sessionSlug: 'fix-3794', launchKind: 'fix' } });
    expect(plain).toContain('--model');
  });
  it('a route to a provider the fix dispatch cannot launch is refused, never silently run on Claude', () => {
    expect(() => fixerTableFor({ rung: { id: 'cross-provider' }, route: { provider: 'codex', model: 'gpt-6-astra' } })).toThrow(/cannot launch/);
  });
  it('the test-first rungs tell the fixer to write a failing test per finding first; resend does not', () => {
    expect(withRulingNotAddressed('BRIEF', ruling(3))).toMatch(/write a failing test for EACH finding/);
    expect(withRulingNotAddressed('BRIEF', ruling(3))).toMatch(/escalation rung 2 \(stronger-model\)/);
    expect(withRulingNotAddressed('BRIEF', ruling(2))).not.toMatch(/failing test/);
  });
});
