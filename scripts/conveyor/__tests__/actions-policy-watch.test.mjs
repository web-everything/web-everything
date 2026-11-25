import { describe, it, expect } from 'vitest';
import { evaluatePolicy, evaluateChangelog, runWatch } from '../actions-policy-watch.mjs';

const cfg = {
  policyId: 17152,
  event: 'pull_request_target',
  expectedWorkflowPath: '.github/workflows/merge-gate.yml',
  keywords: ['allow-policy', 'allow policy'],
};
const policy = (workflows) => ({ id: 17152, rules: [{ event: 'pull_request_target', workflows }] });

describe('actions-policy-watch', () => {
  it('is ok when the policy allows only merge-gate.yml', () => {
    expect(evaluatePolicy(policy(['.github/workflows/merge-gate.yml']), cfg).status).toBe('ok');
  });
  it('alerts when policy 17152 allows pull_request_target for a second workflow', () => {
    const r = evaluatePolicy(policy(['.github/workflows/merge-gate.yml', '.github/workflows/other.yml']), cfg);
    expect(r.status).toBe('drift');
    expect(r.reason).toMatch(/other\.yml/);
  });
  it('alerts when the workflow is renamed', () => {
    expect(evaluatePolicy(policy(['.github/workflows/gate.yml']), cfg).status).toBe('drift');
  });
  it('alerts when the policy is missing', () => {
    expect(evaluatePolicy(null, cfg).status).toBe('missing');
    expect(evaluatePolicy({ id: 17152, rules: [] }, cfg).status).toBe('missing');
  });
  it('an API error raises unknown, not ok', async () => {
    const r = await runWatch({ cfg, org: 'o', ghApi: async () => { throw new Error('403'); }, fetchFeed: async () => [] });
    expect(r.policy.status).toBe('unknown');
    expect(r.alerts.length).toBe(1);
  });
  it('a 403 or 404 from the API raises unknown, not ok or missing', async () => {
    for (const msg of ['gh: Not Found (HTTP 404)', 'gh: Forbidden (HTTP 403)']) {
      const r = await runWatch({ cfg, org: 'o', ghApi: async () => { throw new Error(msg); }, fetchFeed: async () => [] });
      expect(r.policy.status).toBe('unknown');
      expect(r.alerts.length).toBe(1);
    }
  });
  it('a changelog item naming the allow-policy sunset raises one alert', async () => {
    const items = [
      { id: 'a', title: 'Sunset of the Actions allow-policy', summary: '' },
      { id: 'b', title: 'Unrelated', summary: 'nothing' },
    ];
    expect(evaluateChangelog(items, cfg, new Set()).map((i) => i.id)).toEqual(['a']);
    expect(evaluateChangelog(items, cfg, new Set(['a']))).toEqual([]);
    const r = await runWatch({
      cfg, org: 'o', ghApi: async () => JSON.stringify(policy(['.github/workflows/merge-gate.yml'])),
      fetchFeed: async () => items,
    });
    expect(r.alerts.length).toBe(1);
  });
  it('is read-only: only GET-style endpoint reads reach the client', async () => {
    const calls = [];
    await runWatch({
      cfg, org: 'o', ghApi: async (...args) => { calls.push(args); return JSON.stringify(policy(['.github/workflows/merge-gate.yml'])); },
      fetchFeed: async () => [],
    });
    expect(calls.length).toBe(1);
    expect(calls[0].length).toBe(1);
    expect(calls[0][0]).toBe('orgs/o/actions/policies/17152');
  });
});
