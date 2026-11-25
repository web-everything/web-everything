import { describe, it, expect } from 'vitest';
import { evaluatePolicy, evaluateChangelog, runWatch, parseFeed, fetchFeedText, ghReadArgs } from '../actions-policy-watch.mjs';

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
  it('a policy with a wrong or absent id is unknown, not ok', () => {
    expect(evaluatePolicy({ id: 1, rules: [{ event: 'pull_request_target', workflows: ['.github/workflows/merge-gate.yml'] }] }, cfg).status).toBe('unknown');
    expect(evaluatePolicy({ rules: [{ event: 'pull_request_target', workflows: ['.github/workflows/merge-gate.yml'] }] }, cfg).status).toBe('unknown');
  });
  it('parses Atom entries with attributes and rejects non-feed responses', async () => {
    const atom = '<feed xmlns="x"><entry xml:lang="en"><id>z1</id><title xml:lang="en">Allow-policy sunset</title></entry></feed>';
    expect(parseFeed(atom)).toEqual([{ id: 'z1', title: 'Allow-policy sunset', summary: '' }]);
    expect(() => parseFeed('<html>503</html>')).toThrow();
    const res = (ok, status, body) => async () => ({ ok, status, text: async () => body });
    await expect(fetchFeedText('u', res(false, 503, '<html/>'))).rejects.toThrow(/503/);
    expect((await fetchFeedText('u', res(true, 200, atom))).length).toBe(1);
  });
  it('a failed feed raises a feed alert and never hides the policy alert', async () => {
    const r = await runWatch({
      cfg, org: 'o', ghApi: async () => JSON.stringify(policy(['.github/workflows/merge-gate.yml', 'x.yml'])),
      fetchFeed: async () => { throw new Error('feed HTTP 503'); },
    });
    expect(r.alerts.length).toBe(2);
    expect(r.feed.status).toBe('unknown');
  });
  it('the production gh invocation is a plain GET', () => {
    expect(ghReadArgs('orgs/o/actions/policies/17152')).toEqual(['api', 'orgs/o/actions/policies/17152']);
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
