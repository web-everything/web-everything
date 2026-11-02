import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';

const HEAD = 'a'.repeat(40);
const labels = (...names) => names.map(name => ({ name }));
const plan = (over = {}) => planReconcile({ repo: 'we', agents: [], durableCounts: {}, roundCap: 5,
  now: Date.parse('2026-11-02T12:00:00Z'), requiredChecks: ['gate'],
  reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false },
  prs: [{ number: 6023, state: 'OPEN', isDraft: true, baseRefName: 'main',
    headRefName: 'lane/6023-repair', headRefOid: HEAD, mergeStateStatus: 'CLEAN',
    labels: labels('red-team:blocked', 'review:changes'),
    comments: [{ author: { login: 'web-everything' }, createdAt: '2026-11-02T10:00:00Z',
      body: `🔁 review — changes requested\n\nRecorded by auto-policy\n\nruled \`block\` for head \`${HEAD}\`.\n\n### Findings\n\n**correctness/logic** (1)\n- \`src/a.mjs:1\` — repair the open defect` }],
    statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: HEAD }], ...over }],
});

describe('draft red-team send-back (R392(1), live #6023)', () => {
  it.each(['red-team:pending', 'red-team:blocked'])
    ('audit: %s with only an older-head send-back stays refused as a draft', hold => {
      const old = 'b'.repeat(40);
      const result = plan({ labels: labels(hold, 'review:changes'), comments: [{ author: { login: 'web-everything' },
        createdAt: '2026-11-02T10:00:00Z',
        body: `🔁 review — changes requested\n\nRecorded by auto-policy\n\nruled \`block\` for head \`${old}\`.\n\n### Findings\n\n**correctness/logic** (1)\n- \`src/a.mjs:1\` — an older-head defect` }] });
      expect(result.dispatch).toEqual([]);
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'draft', prNumber: 6023 }));
    });

  it('audit: red-team send-back labels without any finding stay refused as a draft', () => {
    const result = plan({ comments: [] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'draft', prNumber: 6023 }));
  });
  it.each(['red-team:blocked', 'red-team:pending'])
    ('a green draft with %s and review:changes owes a fix, never promotion or draft refusal', hold => {
      const result = plan({ labels: labels(hold, 'review:changes') });
      expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 6023, kind: 'fix' })]);
      expect(result.dispatch.some(row => row.kind === 'promote-draft')).toBe(false);
      expect(result.refusals.some(row => row.kind === 'draft')).toBe(false);
    });

  it.each(['red-team:blocked', 'red-team:pending'])
    ('a green draft with %s but no review:changes remains refused as draft', hold => {
      const result = plan({ labels: labels(hold, 'review:pending') });
      expect(result.dispatch).toEqual([]);
      expect(result.refusals).toContainEqual(expect.objectContaining({ prNumber: 6023, kind: 'draft' }));
    });

  it.each(['red-team:blocked', 'red-team:pending'])
    ('draft-withdrawn still refuses even with %s and review:changes', hold => {
      const result = plan({ labels: labels(hold, 'review:changes', 'review-status:draft-withdrawn') });
      expect(result.dispatch).toEqual([]);
      expect(result.refusals).toContainEqual(expect.objectContaining({ prNumber: 6023, kind: 'draft' }));
    });

  it.each([undefined, null, {}, 'review:changes'])
    ('absent/unreadable labels %j cannot authorize a fix pass', unreadable => {
      expect(plan({ labels: unreadable }).dispatch.filter(row => row.kind === 'fix')).toEqual([]);
    });
});
