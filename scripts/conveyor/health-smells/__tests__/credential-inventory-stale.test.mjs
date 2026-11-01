import { describe, it, expect } from 'vitest';
import smell from '../credential-inventory-stale.mjs';
import { SMELLS } from '../index.mjs';
import { runHealthTick } from '../../health-watch-core.mjs';
const now = Date.parse('2026-10-01T12:00:00Z');
const sample = (age = 91, badCredentials = true) => ({ lookbackHours: 24, repositories: [{ repo: 'a/b', secrets: { complete: true }, ci: { complete: true } }], secrets: [{ repo: 'a/b', name: 'FUI_READ_TOKEN', updated_at: new Date(now - age * 86400000).toISOString() }], ciFindings: [{ repo: 'a/b', runId: 42, attempt: 1, runUrl: 'https://github.com/a/b/actions/runs/42', observedAt: new Date(now).toISOString(), badCredentials }] });
const evaluate = (s, descriptor = smell) => descriptor.evaluate({ credentialInventory: s }, { now });
describe('credential-inventory-stale', () => {
  it('registers with independent repo subjects', () => {
    expect(SMELLS.find((s) => s.id === smell.id)).toBe(smell);
    expect(smell).toMatchObject({ cadence: 'gh', scope: 'repo', probes: ['credentialInventory'], openAfter: 1, closeAfter: 2 });
    expect(evaluate(sample()).map((r) => r.subject)).toEqual(['a/b:secret-age', 'a/b:ci-auth']);
  });
  it('uses a strict configurable age threshold and keeps CI independent', () => {
    expect(evaluate(sample(90, false)).map((r) => r.breach)).toEqual([false, false]);
    expect(evaluate(sample(91, false)).map((r) => r.breach)).toEqual([true, false]);
    expect(evaluate(sample(20), { ...smell, maxAgeDays: 10 })[0].breach).toBe(true);
    expect(evaluate(sample(1))[0].breach).toBe(false);
  });
  it.each([null, 'invalid', '2027-01-01T00:00:00Z'])('unknown timestamp %s never emits age clean', (date) => {
    const s = sample(); s.secrets[0].updated_at = date;
    expect(evaluate(s).map((r) => r.subject)).toEqual(['a/b:ci-auth']);
  });
  it('partial positives open, unavailable samples preserve, and two complete clean samples close', () => {
    let state = {};
    const tick = (s) => { const r = runHealthTick(state, { credentialInventory: s }, [smell], now); state = r.state; return r; };
    const partial = sample(); partial.repositories[0].secrets.complete = false; partial.repositories[0].ci.complete = false;
    expect(tick(partial).transitions.filter((t) => t.type === 'opened')).toHaveLength(2);
    partial.secrets = [];
    partial.ciFindings = [];
    expect(tick(partial).transitions).toHaveLength(0);
    expect(tick(sample(1, false)).transitions.filter((t) => t.type === 'closed')).toHaveLength(0);
    expect(tick(partial).transitions).toHaveLength(0);
    expect(tick(sample(1, false)).transitions.filter((t) => t.type === 'closed')).toHaveLength(2);
  });
  it('a match outside the window clears only the windowed signal', () => {
    const s = sample(); s.ciFindings[0].observedAt = new Date(now - 86400001).toISOString();
    const result = evaluate(s); expect(result.map((r) => r.breach)).toEqual([true, false]);
    expect(result[1].recommendation).toContain('does not prove credential repair');
  });
});
