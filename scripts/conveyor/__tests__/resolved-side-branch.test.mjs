// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { dispatchFix, runReconcileFixDispatch, planFixesFromReconcile, pushOnlyFixBrief } from '../reconcile-fix-dispatch.mjs';
import { findResolvedSideBranch, resolvedSideBranchEvidenceReadable, pushedResolvedRepairReviewOwed } from '../resolved-side-branch.mjs';
import { AUTOMATION_LOGINS, buildConcurrentAuthorPauseComment, buildLoadFlakeHoldComment, buildLoadFlakeResolvedComment, emitFixQuestion } from '../stand-down.mjs';
import { workflowEditFact, evaluatePrGates } from '../../lib/merge-gate-ci.mjs';
import { runReconcileNotesAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
import { REVIEW_PR_CHANNEL } from '../../lib/review-escalation.mjs';
import { REVIEW_PR_FOOTER } from '../mechanical-round-cap.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';

const H = '1'.repeat(40), B = '2'.repeat(40), S = '3'.repeat(40), T = '4'.repeat(40);
const branch = { name: 'lane/topic-fix-7329-conflict-alt', sha: S, ancestors: [S, H, B] };
const proof = b => ({ author: { login: AUTOMATION_LOGINS[0] }, body: buildConcurrentAuthorPauseComment({ head: H, alt: b.name, altSha: b.sha }) });
const pr = { number: 7329, state: 'OPEN', headRefName: 'lane/topic', headRefOid: H,
  baseRefName: 'main', baseRefOid: B, isCrossRepository: false, mergeStateStatus: 'DIRTY',
  labels: ['review:changes', 'review:human'], files: ['scripts/x.mjs'],
  comments: [{ body: 'Reviewer: resolve the conflict in scripts/x.mjs:1', author: { login: 'web-everything' } }, proof(branch)],
  statusCheckRollup: [], resolvedSideBranches: [branch] };
const plan = (over = {}, options = {}) => planReconcile({ prs: [{ ...pr, ...over }], ...options });
const review = (head, author = { login: AUTOMATION_LOGINS[0] }) => ({ author,
  body: `🔁 review — changes requested\n\nRecorded by reviewer via ${REVIEW_PR_CHANNEL}.\n\nReviewer: repair the new finding in scripts/x.mjs:1\n\n---\n\nNet basis: \`${B}..${head}\` — 1 net changed file(s) vs current main\n\n${REVIEW_PR_FOOTER}` });
const greenPushedPr = () => ({ ...pr, headRefOid: S, rowsHead: S, rowsComplete: true,
  mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
function run(dispatch, overrides = {}) {
  return runReconcileFixDispatch({ root: '/repo', repo: 'we',
    checkStaleness: () => ({ fresh: true, behind: 0 }), reconcile: () => plan(),
    findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: () => ['scripts/x.mjs'],
    pickFreeLanes: () => [1], listBuildClaims: () => [], listFixClaims: () => [],
    priorityShadow: null, tryResume: vi.fn(() => { throw Error('full conflict resume forbidden'); }),
    tryResumeRound: vi.fn(() => { throw Error('full round resume forbidden'); }), stepLog: () => {}, dispatch, ...overrides });
}

describe('saved repair push-only merge-path checklist', () => {
  it.each([0, 1, 2, 'exhausted'])('attested saved load-flake repair stays with its retry-limited worker (results=%s)', attempts => {
    const comment = (body, minute) => ({ body, createdAt: `2026-11-05T10:0${minute}:00Z`, author: { login: AUTOMATION_LOGINS[0] } });
    const hold = comment(buildLoadFlakeHoldComment({ head: H, alt: branch.name, altSha: S }), 0);
    const results = attempts === 'exhausted'
      ? [comment(buildLoadFlakeResolvedComment({ altSha: S, result: 'exhausted' }), 3)]
      : Array.from({ length: attempts }, (_, i) => comment(buildLoadFlakeResolvedComment({ altSha: S, result: 'red-again' }), i + 1));
    const live = { ...pr, comments: [pr.comments[0], hold, ...results] };
    // This is eligible saved-descendant evidence, attested by the actual load-flake producer.
    expect(findResolvedSideBranch({ pr: live, branches: [branch] })).toEqual(branch);
    const reconcile = () => planReconcile({ prs: [live] });
    const result = reconcile();
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'load-flake-hold',
      why: expect.stringMatching(attempts === 'exhausted' ? /operator inspection/ : /retry-limited.*worker/) }));
    const dispatch = vi.fn();
    run(dispatch, { reconcile });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('an active load-flake worker also excludes a separately attested saved repair on the same PR', () => {
    const hold = { author: { login: AUTOMATION_LOGINS[0] }, createdAt: '2026-11-05T10:00:00Z',
      body: buildLoadFlakeHoldComment({ head: H, alt: 'lane/topic-fix-7329-load-alt', altSha: T }) };
    const result = plan({ comments: [...pr.comments, hold] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'load-flake-hold' }));
  });
  it('an exhausted historical abbreviated load-flake SHA cannot restart through push-only', () => {
    const comment = (body, minute) => ({ author: { login: AUTOMATION_LOGINS[0] }, body, createdAt: `2026-11-05T10:0${minute}:00Z` });
    const comments = [...pr.comments,
      comment(buildLoadFlakeHoldComment({ head: H, alt: branch.name, altSha: S.slice(0, 9) }), 0),
      comment(buildLoadFlakeResolvedComment({ altSha: S.slice(0, 9), result: 'exhausted' }), 1)];
    const result = plan({ comments });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'load-flake-hold', why: expect.stringContaining('operator inspection') }));
  });
  it('a closed historical load-flake hold does not own a different saved repair', () => {
    const comment = (body, minute) => ({ author: { login: AUTOMATION_LOGINS[0] }, body, createdAt: `2026-11-05T10:0${minute}:00Z` });
    const comments = [...pr.comments,
      comment(buildLoadFlakeHoldComment({ head: H, alt: 'lane/topic-fix-7329-load-alt', altSha: T }), 0),
      comment(buildLoadFlakeResolvedComment({ altSha: T, result: 'head-moved' }), 1)];
    expect(plan({ comments }).dispatch).toEqual([expect.objectContaining({ kind: 'fix', pushOnly: { branch: branch.name, sha: S } })]);
  });
  it.each([true, false])('successful push with unchanged labels/comments owes review, never old findings (saved ref listed=%s)', listed => {
    let live = { ...pr };
    const dispatch = vi.fn(planned => {
      expect(planned.pushOnly).toEqual({ branch: branch.name, sha: S });
      live = { ...live, ...greenPushedPr() };
      return { pr: planned.pr };
    });
    const reconcile = () => planReconcile({ prs: [live], requiredChecks: ['test'], reviewTiming: { startAfter: 'ci-green' } });
    expect(run(dispatch, { reconcile }).dispatched).toHaveLength(1);
    expect(live.labels).toEqual(pr.labels);
    expect(live.comments).toEqual(pr.comments);
    if (!listed) delete live.resolvedSideBranches; // Deleted ref / unscanned PR / daemon restart.
    const after = reconcile();
    expect(after.dispatch, JSON.stringify(after.refusals)).toEqual([expect.objectContaining({ kind: 'review', headRefOid: S,
      resolvedRepairReview: { branch: branch.name, sha: S } })]);
    run(dispatch, { reconcile });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(reconcile().dispatch.some(row => row.kind === 'fix')).toBe(false);
    live = { ...live, comments: [...live.comments, review(S)] };
    expect(pushedResolvedRepairReviewOwed(live)).toBeNull();
    expect(reconcile().dispatch).toContainEqual(expect.objectContaining({ kind: 'fix', headRefOid: S }));
  });
  it.each([
    ['old-head review', review(H)], ['other-head review', review(T)],
    ['abbreviated head', review(S.slice(0, 9))], ['untrusted reviewer', review(S, { login: 'outsider' })],
    ['re-arm without review', { author: { login: AUTOMATION_LOGINS[0] }, body: `🔧 conveyor fix — re-armed for re-review\n<!-- reviewed-sha: ${S} -->` }],
    ['quoted head', { author: { login: AUTOMATION_LOGINS[0] }, body: `🔁 review — changes requested\n> <!-- reviewed-sha: ${S} -->` }],
  ])('%s cannot release the exact-head saved-repair review handoff', (_name, comment) => {
    const live = { ...greenPushedPr(), comments: [...pr.comments, comment] };
    delete live.resolvedSideBranches;
    expect(pushedResolvedRepairReviewOwed(live)).toEqual({ branch: branch.name, sha: S });
    const result = planReconcile({ prs: [live], requiredChecks: ['test'] });
    expect(result.dispatch.some(row => row.kind === 'fix')).toBe(false);
    expect(result.dispatch.every(row => row.kind === 'review')).toBe(true);
  });
  it('a review preceding the saved-repair record cannot consume its handoff', () => {
    const live = { ...greenPushedPr(), comments: [review(S), ...pr.comments] };
    expect(pushedResolvedRepairReviewOwed(live)).toEqual({ branch: branch.name, sha: S });
    const result = planReconcile({ prs: [live], requiredChecks: ['test'] });
    expect(result.dispatch.some(row => row.kind === 'fix')).toBe(false);
  });
  it('new-head gate holds still refuse review and never reopen the previous findings', () => {
    const live = { ...greenPushedPr(), statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'failure' }] };
    const result = planReconcile({ prs: [live], requiredChecks: ['test'] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'review-ci' }));
  });
  it('a review gate proposing scope repair refuses for inspection instead of launching a full fixer', () => {
    const live = { ...greenPushedPr(), scopeBloat: { stale: false, why: 'scope repair required' } };
    const result = planReconcile({ prs: [live], requiredChecks: ['test'] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'resolved-side-branch-review-owed', why: expect.stringContaining('operator inspection') }));
  });
  it.each([
    ['accept', `✅ review — accepted\n\n<!-- reviewed-sha: ${S} -->`],
    ['advisory', `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** changes\n\n---\n\nNet basis: \`${B}..${S}\` — 1 net changed file(s) vs current main`],
  ])('a later trusted exact-head %s consumes the handoff', (_name, body) => {
    const live = { ...greenPushedPr(), comments: [...pr.comments, { author: { login: AUTOMATION_LOGINS[0] }, body }] };
    expect(pushedResolvedRepairReviewOwed(live)).toBeNull();
  });
  it.each(['lane/topic', 'lane/3438-topic'])('both scope projections preserve push-only over conflict hints (%s)', headRefName => {
    const entry = { ...plan().dispatch[0], headRefName, labels: ['merge-status:conflicting'], isConflict: true, attempts: 4 };
    const item = { num: '3438', scope: ['we:scripts/x.mjs'] };
    const { planned, refusals } = planFixesFromReconcile([entry], () => item, () => [item]);
    expect(refusals).toEqual([]);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ pushOnly: { branch: branch.name, sha: S }, isConflict: false, laneRef: headRefName });
    const resume = vi.fn(() => { throw Error('old full-fix session must not resume'); });
    const dispatch = vi.fn(p => p);
    const result = run(dispatch, { reconcile: () => ({ dispatch: [entry], refusals: [] }),
      findItemFn: () => item, loadItems: () => [item], tryResume: resume, tryResumeRound: resume });
    expect(result.refusals).toEqual([]);
    expect(resume).not.toHaveBeenCalled();
    expect(dispatch.mock.calls[0][0].pushOnly.sha).toBe(S);
  });
  it('disabled push-only policy refuses saved repair without falling back to full resolution', () => {
    const result = plan({}, { resolvedSideBranchEnabled: false });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'resolved-side-branch-disabled', why: expect.stringContaining('operator inspection') }));
  });
  it.each(['main', 'lane/other-fix-17329-alt', 'lane/topic\n'])('dispatch-boundary validation refuses unsafe or wrong-PR binding (%s)', ref => {
    const entry = { ...plan().dispatch[0], headRefName: ref };
    const result = planFixesFromReconcile([entry], () => null, () => []);
    // A safe lane head is allowed only as this entry's PR head. A saved ref for another PR is refused.
    if (ref === 'lane/other-fix-17329-alt') {
      entry.headRefName = pr.headRefName; entry.pushOnly = { branch: ref, sha: S };
      expect(planFixesFromReconcile([entry], () => null, () => []).planned).toEqual([]);
    } else expect(result.planned).toEqual([]);
    expect(() => pushOnlyFixBrief({ pr: pr.number, laneRef: 'main', headRefOid: H, pushOnly: { branch: branch.name, sha: S } })).toThrow(/operator inspection/);
  });
  it('Tier 1: newer resolved SHA dispatches push-only, never a normal full fix', () => {
    const ordinary = { ...pr }; delete ordinary.resolvedSideBranches;
    expect(planReconcile({ prs: [ordinary] }).dispatch.some(d => d.kind === 'fix')).toBe(true);
    expect(plan().dispatch).toEqual([expect.objectContaining({ kind: 'fix', prNumber: pr.number, pushOnly: { branch: branch.name, sha: S } })]);
    const dispatch = vi.fn(p => p);
    const result = run(dispatch);
    expect(result.refusals).toEqual([]);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0]).toMatchObject({ pushOnly: { branch: branch.name, sha: S }, laneRef: pr.headRefName, isConflict: false });
  });
  it('previous-head holds and acceptance remain enforced by the new-head gate and planner', () => {
    const before = structuredClone(pr);
    const dispatch = vi.fn(p => p); run(dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(pr).toEqual(before);
    expect(workflowEditFact({ pinnedHead: { sha: S }, gatePaths: { files: ['.github/workflows/ci.yml'] }, acceptance: { humanClearedSha: H } }).status).toBe('hold');
    const gate = evaluatePrGates({ pr: { number: pr.number, labels: ['review:accepted', 'review:human'] }, pinnedHead: { sha: S },
      gatePaths: { files: ['.github/workflows/ci.yml'] }, acceptance: { humanClearedSha: H } }, { write: () => {} });
    expect(gate.results).toContainEqual(expect.objectContaining({ id: 'review-acceptance', status: 'hold' }));
    const next = plan({ headRefOid: S, mergeStateStatus: 'CLEAN', labels: ['review:pending', 'review:human'], comments: [], rowsComplete: true, rowsHead: S, statusCheckRollup: [
      { name: 'test', status: 'completed', conclusion: 'success' },
      { name: 'merge-gate', status: 'completed', conclusion: 'failure', mergeGateReviewHold: { holds: ['review-gate'], jobId: 1 } },
      { name: 'review-gate', status: 'completed', conclusion: 'failure' },
    ] }, { requiredChecks: ['test', 'merge-gate', 'review-gate'] });
    expect(next.refusals).toContainEqual(expect.objectContaining({ kind: 'review-hold-red', headRefOid: S }));
    expect(next.dispatch.some(d => d.kind === 'fix')).toBe(false);
  });
  it.each(['main', 'topic', 'lane/../main', 'lane/topic\n'])('non-lane or unsafe PR head %s refuses both launch modes', headRefName => {
    expect(plan({ headRefName }).dispatch).toEqual([]);
    expect(plan({ headRefName }).refusals).toContainEqual(expect.objectContaining({ kind: 'resolved-side-branch-unreadable', why: expect.stringContaining('operator inspection') }));
  });
  it.each([
    ['unreadable', null], ['oversized claims', Array.from({ length: 17 }, () => branch)],
    ['oversized ancestry', [{ ...branch, ancestors: Array.from({ length: 32769 }, () => S) }]],
    ['ambiguous claims', [branch, { ...branch, name: 'lane/topic-fix-7329-other', sha: T, ancestors: [T, H, B] }]],
    ['unreadable ancestry', [{ ...branch, ancestors: null }]],
  ])('%s refuses push-only AND full re-resolve, with operator fallback', (_name, resolvedSideBranches) => {
    const result = plan({ resolvedSideBranches });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'resolved-side-branch-unreadable', why: expect.stringContaining('operator inspection') }));
  });
  it('ancestry orders saved repairs, never timestamps; aliases at one SHA are stable', () => {
    const newer = { ...branch, name: 'lane/topic-fix-7329-newer', sha: T, ancestors: [T, S, H, B] };
    expect(findResolvedSideBranch({ pr: { ...pr, comments: [...pr.comments, proof(newer)] }, branches: [branch, newer] })).toEqual(newer);
    const alias = { ...branch, name: 'lane/topic-fix-7329-alias' };
    expect(resolvedSideBranchEvidenceReadable({ pr, branches: [branch, alias] })).toBe(false);
    expect(findResolvedSideBranch({ pr: { ...pr, comments: [...pr.comments, proof(alias)] }, branches: [branch, alias] })).toEqual(alias);
  });
  it('two fully attested divergent repairs require operator inspection', () => {
    const other = { name: 'lane/topic-fix-7329-other', sha: T, ancestors: [T, H, B] };
    const result = plan({ comments: [...pr.comments, proof(other)], resolvedSideBranches: [branch, other] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'resolved-side-branch-unreadable', why: expect.stringContaining('operator inspection') }));
  });
  it.each([
    ['different PR', { ...branch, name: 'lane/topic-fix-17329-alt' }],
    ['PR number suffix', { ...branch, name: 'lane/topic-fix-73290-alt' }],
    ['same head', { ...branch, sha: H }],
    ['missing current head', { ...branch, ancestors: [S, B] }],
    ['missing current base', { ...branch, ancestors: [S, H] }],
    ['abbreviated SHA', { ...branch, sha: 'abcdef0' }],
    ['SHA newline', { ...branch, sha: S + '\n' }],
    ['unreadable entry', null],
  ])('detection never selects %s', (_name, candidate) => {
    expect(findResolvedSideBranch({ pr, branches: [candidate] })).toBeNull();
  });
  it('verification failure does not fall back to a full-resolve launch in the same round', () => {
    const dispatch = vi.fn(p => { expect(p.pushOnly).toEqual({ branch: branch.name, sha: S }); throw Error('verification failed'); });
    const result = run(dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'dispatch-failed', why: expect.stringContaining('verification failed') }));
  });
  it('normal dispatch claim and launcher carry a push-only brief bound to the own lane head, without hook bypasses', () => {
    const acquireClaim = vi.fn(() => ({ ok: true })), launchWrapped = vi.fn(() => ({ handle: 'pid:123' }));
    const readBrief = vi.fn(() => 'FULL RESOLVE: resolve every conflict and apply findings');
    const planned = { pr: pr.number, itemNum: null, lane: 1, laneRef: pr.headRefName, headRefOid: H,
      scope: ['we:scripts/x.mjs'], pushOnly: { branch: branch.name, sha: S } };
    dispatchFix(planned, { root: '/repo', readBrief, acquireClaim, readFixClaim: () => null,
      releaseClaim: vi.fn(), executorDecision: { executor: 'claude', source: 'test', reason: 'test' },
      wrapFix: true, launchWrapped, stampRunner: vi.fn(), sessionCwdFor: () => '/scratch', ensureSessionCwd: p => p,
      grantConflictHelper: vi.fn(), resolveSettingsEnv: () => ({}), isolateSession: () => ({ worktreeSettings: {} }),
      advisorFor: () => ({}), recordAdvisor: vi.fn(), postNotice: vi.fn(), fixSettings: { roundHistory: 'off' } });
    expect(acquireClaim).toHaveBeenCalledWith(expect.objectContaining({ pr: pr.number, kind: 'fix', headSha: H }));
    expect(launchWrapped).toHaveBeenCalledOnce();
    const request = launchWrapped.mock.calls[0][0];
    const serialized = JSON.stringify(request.bgArgv);
    expect(serialized).toContain('Push-only');
    expect(serialized).toContain(`${branch.name}@${S}`);
    expect(serialized).toContain(`only to the PR head refs/heads/${pr.headRefName}`);
    expect(serialized).toContain('Do no new conflict work');
    expect(serialized).toContain('Do not change labels, holds, acceptance');
    expect(serialized).toContain('verification fails');
    expect(serialized).not.toMatch(/FULL RESOLVE|--no-verify|HUSKY|SKIP.*HOOK|core.hooksPath/);
    expect(readBrief).not.toHaveBeenCalled();
  });
  it.each([true, false])('stood-down notes emit fix-question-asked only after comment success (%s)', ok => {
    const order = [], emit = vi.fn(event => order.push(event.kind));
    const result = runReconcileNotesAllRepos({ repos: ['we'], dryRun: false,
      tick: () => ({ notes: [{ kind: 'stood-down', prNumber: pr.number, text: 'operator question' }], prsByNumber: new Map([[pr.number, { ...pr, comments: [] }]]) }),
      postComment: () => { order.push('comment'); return { ok }; },
      questionEvent: e => emitFixQuestion(e, emit), autoRoundGrant: () => null });
    expect(result.comments[0].posted).toBe(ok);
    expect(order).toEqual(ok ? ['comment', 'fix-question-asked'] : ['comment']);
  });
});
