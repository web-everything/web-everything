// R365 fix 4: same tree, new head -> no re-review; changed tree -> review; per-PR loop cap parks for a person.
import { describe, it, expect } from 'vitest';
import { planReconcile, REFUSAL_KINDS } from '../reconcile-core.mjs';
import {
  decideReviewChurn, countReviewLoops, resolveReviewChurn, enrichPrsWithReviewChurn, REVIEW_CHURN_STANDARD,
} from '../review-churn.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';

const BOT = { login: 'web-everything' };
const sha = (c) => c.repeat(40);
const at = (h) => `2026-10-10T${String(h).padStart(2, '0')}:00:00Z`;
const accept = (head, h) => ({ author: BOT, createdAt: at(h), body: `✅ review — accepted\n\n<!-- reviewed-sha: ${head} -->` });
const rearm = (h) => ({ author: BOT, createdAt: at(h), body: `${REARM_COMMENT_MARKER}\n\nrepaired` });
const SET = (o = {}) => ({ sameTree: 'shadow', capMode: 'on', maxLoopsPerPr: 3, ...o });
const mkPr = (comments, head, churn) => ({
  number: 7, headRefName: 'lane/x-thing', headRefOid: head, baseRefName: 'main', isDraft: false, createdAt: at(0),
  labels: [{ name: 'review:pending' }], files: [{ path: 'src/a.mjs' }],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: head }],
  comments, ...(churn ? { reviewChurn: churn } : {}),
});
const plan = (p) => planReconcile({ reviewTiming: { startAfter: 'ci-green' }, prs: [p], agents: [], durableCounts: {},
  now: Date.parse(at(20)), requiredChecks: ['test'] });
const row = (r) => r.dispatch.find((x) => x.prNumber === 7);
const refusal = (r, kind) => r.refusals.find((x) => x.prNumber === 7 && x.kind === kind);

describe('same tree, new head', () => {
  const A = sha('a'); const B = sha('b'); const TREE = sha('1');
  const comments = [accept(A, 1)];
  it('same tree is recorded, never enforced: the review is still dispatched', () => {
    const r = plan(mkPr(comments, B, { settings: SET(), headTree: TREE, trees: { [A]: TREE } }));
    expect(row(r)?.kind).toBe('review');
    expect(row(r)?.churnShadow?.kind).toBe('same-tree');
    expect(REFUSAL_KINDS).not.toContain('review-same-tree');
  });
  it('changed tree: reviewed', () => {
    const r = plan(mkPr(comments, B, { settings: SET(), headTree: sha('2'), trees: { [A]: TREE } }));
    expect(row(r)?.kind).toBe('review');
    expect(refusal(r, 'review-same-tree')).toBeUndefined();
  });
  it('unknown tree: reviewed', () => {
    expect(decideReviewChurn(mkPr(comments, B, { settings: SET(), headTree: null, trees: {} }))).toBeNull();
  });
  it('shadow: reviewed, decision recorded on the row', () => {
    const r = plan(mkPr(comments, B, { settings: SET({ sameTree: 'shadow' }), headTree: TREE, trees: { [A]: TREE } }));
    expect(row(r)?.kind).toBe('review');
    expect(row(r)?.churnShadow?.kind).toBe('same-tree');
  });
  it('a same-tree twin of a CHANGES verdict is still reviewed', () => {
    const bounce = { author: BOT, createdAt: at(1), body: `🔁 review — changes requested\n\n<!-- reviewed-sha: ${A} -->` };
    expect(decideReviewChurn(mkPr([bounce], B, { settings: SET(), headTree: TREE, trees: { [A]: TREE } }))).toBeNull();
  });
});

describe('per-PR loop cap', () => {
  const heads = ['a', 'b', 'c'].map(sha);
  const comments = [accept(heads[0], 1), rearm(2), accept(heads[1], 3), rearm(4), accept(heads[2], 5), rearm(6)];
  it('counts distinct reviewed heads', () => {
    expect(countReviewLoops(comments)).toBe(3);
    expect(countReviewLoops([accept(heads[0], 1), accept(heads[0], 2)])).toBe(1);
  });
  it('on: a new head past the cap is STILL reviewed, and a needs-you note is raised', () => {
    const r = plan(mkPr(comments, sha('d'), { settings: SET({ sameTree: 'off' }) }));
    expect(row(r)?.kind).toBe('review');
    expect(row(r)?.churnCap).toMatchObject({ kind: 'loop-cap', loops: 3, cap: 3 });
    expect(r.notes.find((n) => n.kind === 'review-churn' && n.prNumber === 7)).toBeTruthy();
  });
  it('under the cap: reviewed', () => {
    const r = plan(mkPr(comments, sha('d'), { settings: SET({ sameTree: 'off', maxLoopsPerPr: 4 }) }));
    expect(row(r)?.kind).toBe('review');
  });
  it('shadow: reviewed with churnShadow', () => {
    const r = plan(mkPr(comments, sha('d'), { settings: SET({ sameTree: 'off', capMode: 'shadow' }) }));
    expect(row(r)?.kind).toBe('review');
    expect(row(r)?.churnShadow?.kind).toBe('loop-cap');
  });
});

describe('stale accept (no sha)', () => {
  it('a later changes verdict without a structured sha still voids the accept', () => {
    const A = sha('a'); const TREE = sha('1');
    const bounce = { author: BOT, createdAt: at(2), body: '🔁 review — changes requested\n\n### Findings\n- bad' };
    expect(decideReviewChurn(mkPr([accept(A, 1), bounce], sha('b'), { settings: SET(), headTree: TREE, trees: { [A]: TREE } }))).toBeNull();
  });
});

describe('stale accept', () => {
  it('a later changes verdict on the same head voids its accept for the same-tree skip', () => {
    const A = sha('a'); const TREE = sha('1');
    const bounce = { author: BOT, createdAt: at(2), body: `🔁 review — changes requested\n\n<!-- reviewed-sha: ${A} -->` };
    expect(decideReviewChurn(mkPr([accept(A, 1), bounce], sha('b'), { settings: SET(), headTree: TREE, trees: { [A]: TREE } }))).toBeNull();
  });
});

describe('same-tree edge cases', () => {
  it('an abbreviated changes verdict voids a full-sha accept', () => {
    const A = sha('a'); const TREE = sha('1');
    const bounce = { author: BOT, createdAt: at(2), body: `🔁 review — changes requested\n\n<!-- reviewed-sha: ${A.slice(0, 7)} -->` };
    expect(decideReviewChurn(mkPr([accept(A, 1), bounce], sha('b'), { settings: SET(), headTree: TREE, trees: { [A]: TREE } }))).toBeNull();
  });
});

describe('guard interplay', () => {
  it('a shadow same-tree decision never hides an enforcing loop cap', () => {
    const heads = ['a', 'b', 'c'].map(sha); const TREE = sha('1');
    const comments = [accept(heads[0], 1), accept(heads[1], 3), accept(heads[2], 5)];
    const d = decideReviewChurn(mkPr(comments, sha('d'), { settings: SET({ sameTree: 'shadow' }), headTree: TREE, trees: { [heads[0]]: TREE } }));
    expect(d).toMatchObject({ kind: 'loop-cap', mode: 'on' });
  });
});

describe('settings and enrichment', () => {
  it('standard is shadow, cascade env wins, invalid env is ignored', () => {
    const none = resolveReviewChurn({ env: {}, tool: undefined, platform: null, file: '/nonexistent' });
    expect(none.sameTree).toBe('shadow'); expect(none.maxLoopsPerPr).toBe(REVIEW_CHURN_STANDARD.maxLoopsPerPast ?? 8);
    const env = resolveReviewChurn({ env: { WE_REVIEW_CHURN_SAME_TREE: 'off', WE_REVIEW_CHURN_MAX_LOOPS: '5' }, platform: null, file: '/nonexistent' });
    expect(env.sameTree).toBe('off'); expect(env.maxLoopsPerPr).toBe(5);
    const on = resolveReviewChurn({ env: { WE_REVIEW_CHURN_SAME_TREE: 'on' }, platform: null, file: '/nonexistent' });
    expect(on.sameTree).toBe('shadow'); // 'on' is not offered for sameTree
    const bad = resolveReviewChurn({ env: { WE_REVIEW_CHURN_SAME_TREE: 'bogus' }, platform: null, file: '/nonexistent' });
    expect(bad.sameTree).toBe('shadow');
  });
  it('reads trees only for a head that no verdict judged', () => {
    const A = sha('a'); const B = sha('b'); const reads = [];
    const settings = { sameTree: 'on', capMode: 'off', maxLoopsPerPr: 8 };
    const readTree = (_r, s) => { reads.push(s); return sha(s === A ? '1' : '2').replace(/^./, '1'); };
    const [out] = enrichPrsWithReviewChurn([mkPr([accept(A, 1)], B)], { repo: 'o/r-enrich', settings, readTree });
    expect(out.reviewChurn.headTree).toBeTruthy();
    expect(reads.sort()).toEqual([A, B].sort());
    const [same] = enrichPrsWithReviewChurn([mkPr([accept(A, 1)], A)], { repo: 'o/r-enrich2', settings, readTree: () => { throw new Error('no read'); } });
    expect(same.reviewChurn.headTree).toBeUndefined();
  });
});
