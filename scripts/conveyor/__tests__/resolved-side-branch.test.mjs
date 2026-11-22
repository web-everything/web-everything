// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { workflowEditFact, evaluatePrGates } from '../../lib/merge-gate-ci.mjs';

const H = '1'.repeat(40), B = '2'.repeat(40), S = '3'.repeat(40), T = '4'.repeat(40);
const branch = { name: 'lane/topic-fix-7329-conflict-alt', sha: S, ancestors: [S, H, B] };
const pr = { number: 7329, state: 'OPEN', headRefName: 'lane/topic', headRefOid: H,
  baseRefName: 'main', baseRefOid: B, isCrossRepository: false, mergeStateStatus: 'DIRTY',
  labels: [{ name: 'review:changes' }, { name: 'review:human' }],
  comments: [{ body: 'Reviewer: resolve the conflict in scripts/x.mjs:1', author: { login: 'web-everything' } }], statusCheckRollup: [] };
const core = () => import(/* @vite-ignore */ new URL('../resolved-side-branch.mjs', import.meta.url).href);
const pass = () => import(/* @vite-ignore */ new URL('../resolved-side-branch-push.mjs', import.meta.url).href);
function fixture(overrides = {}) {
  let live = { ...pr };
  const order = [];
  const io = {
    listPrs: vi.fn(() => [pr]), readBranches: vi.fn(() => [branch]),
    readPr: vi.fn(() => ({ ...live })), appToken: vi.fn(() => 'ghs_fixture'),
    pushRefusal: vi.fn(() => null),
    push: vi.fn(() => { order.push('push'); live = { ...live, headRefOid: S }; }),
    record: vi.fn(() => order.push('record')), log: vi.fn(),
    ...overrides,
  };
  return { io, order, live: () => live };
}

describe('resolved conflict side branch', () => {
  it('Tier 1: resolved descendant owes a push and NO fixer dispatch, even under the old human hold', () => {
    // Prove the fixture would actually launch without saved-branch evidence.
    const ordinary = planReconcile({ prs: [pr], now: Date.now() });
    expect(ordinary.dispatch.some(d => d.kind === 'fix')).toBe(true);
    const plan = planReconcile({ prs: [{ ...pr, resolvedSideBranches: [branch] }], now: Date.now() });
    expect(plan.dispatch.filter(d => d.prNumber === pr.number)).toEqual([]);
    expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'resolved-side-branch-owed', sha: S, branch: branch.name }));
  });
  it('orders commits by ancestry, ignoring reversed or absent timestamps; divergent tips are ambiguous', async () => {
    const { findResolvedSideBranch: find } = await core();
    const newer = { ...branch, name: 'lane/topic-fix-7329-merge-abc', sha: T, ancestors: [T, S, H, B], committedAt: 0 };
    expect(find({ pr, branches: [{ ...branch, committedAt: 9999999 }, newer] })).toEqual(newer);
    expect(find({ pr, branches: [branch, { ...newer, ancestors: [T, H, B] }] })).toBeNull();
  });
  it.each([
    ['different PR', { ...branch, name: 'lane/topic-fix-17329-alt' }],
    ['PR number suffix', { ...branch, name: 'lane/topic-fix-73290-alt' }],
    ['same head', { ...branch, sha: H }],
    ['not descendant / force needed', { ...branch, ancestors: [S, B] }],
    ['missing current base', { ...branch, ancestors: [S, H] }],
    ['abbreviated sha', { ...branch, sha: 'abcdef0' }],
    ['sha newline', { ...branch, sha: S + '\n' }],
    ['unreadable ancestry', { ...branch, ancestors: null }],
    ['unreadable entry', null],
  ])('never selects or pushes %s', async (_name, bad) => {
    const { findResolvedSideBranch } = await core();
    expect(findResolvedSideBranch({ pr, branches: [bad] })).toBeNull();
    const { io } = fixture({ readBranches: () => [bad] });
    await (await pass()).runResolvedSideBranchPass({ repo: 'web-everything/web-everything' }, io);
    expect(io.push).not.toHaveBeenCalled();
  });
  it('missing/unreadable input, oversized input, and missing exact base fail closed with operator fallback', async () => {
    const { findResolvedSideBranch: find } = await core();
    expect(find({ pr, branches: null })).toBeNull();
    expect(find({ pr: { ...pr, baseRefOid: undefined }, branches: [branch] })).toBeNull();
    expect(find({ pr, branches: Array.from({ length: 17 }, () => branch) })).toBeNull();
    expect(find({ pr, branches: [{ ...branch, ancestors: Array.from({ length: 32769 }, () => S) }] })).toBeNull();
    const { io } = fixture({ readBranches: () => { throw Error('unreadable'); } });
    const rows = await (await pass()).runResolvedSideBranchPass({ repo: 'web-everything/web-everything' }, io);
    expect(rows[0].why).toMatch(/operator/);
    expect(io.push).not.toHaveBeenCalled();
  });
  it('Tier 1: push-then-ask pushes past the previous head hold; new head still blocks the merge gate', async () => {
    expect(workflowEditFact({ pinnedHead: { sha: H }, gatePaths: { files: ['.github/workflows/ci.yml'] } }).status).toBe('hold');
    const { io, order, live } = fixture();
    const rows = await (await pass()).runResolvedSideBranchPass({ repo: 'web-everything/web-everything' }, io);
    expect(rows[0].result).toBe('pushed');
    expect(order).toEqual(['push', 'record']);
    expect(io.readPr).toHaveBeenCalledTimes(3);
    expect(io.push).toHaveBeenCalledWith(expect.objectContaining({ sha: S, head: H, branch: pr.headRefName, token: 'ghs_fixture' }));
    const gate = workflowEditFact({ pinnedHead: { sha: live().headRefOid }, gatePaths: { files: ['.github/workflows/ci.yml'] }, acceptance: { humanClearedSha: H } });
    expect(gate.status).toBe('hold');
    expect(gate.reason).toContain(S.slice(0, 9));
    const decision = evaluatePrGates({ pr: { number: pr.number, labels: ['review:accepted', 'review:human'] },
      pinnedHead: { sha: S }, gatePaths: { files: ['.github/workflows/ci.yml'] }, acceptance: { humanClearedSha: H },
    }, { write: () => {} });
    expect(decision.results).toContainEqual(expect.objectContaining({ id: 'review-acceptance', status: 'hold' }));
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('pushed (no fixer launch)'));
  });
  it.each(['before-write', 'after-write'])('head moved %s: no dedupe; moved before write is never pushed', async when => {
    let reads = 0;
    const { io } = fixture({ readPr: () => ({ ...pr, headRefOid: ++reads >= (when === 'before-write' ? 2 : 3) ? T : H }) });
    const rows = await (await pass()).runResolvedSideBranchPass({ repo: 'web-everything/web-everything' }, io);
    expect(rows[0].result).toBe('refused');
    if (when === 'before-write') expect(io.push).not.toHaveBeenCalled();
    expect(io.record).not.toHaveBeenCalled();
  });
  it.each([undefined, { held: true }])('missing or held fix-claim evidence refuses (%s)', async claim => {
    const { io } = fixture({ pushRefusal: () => claim });
    await (await pass()).runResolvedSideBranchPass({ repo: 'web-everything/web-everything' }, io);
    expect(io.push).not.toHaveBeenCalled();
  });
  it.each([null, 'ghp_personal', 'github_pat_personal'])('no personal credential fallback (%s)', async token => {
    const { io } = fixture({ appToken: () => token });
    await (await pass()).runResolvedSideBranchPass({ repo: 'web-everything/web-everything' }, io);
    expect(io.push).not.toHaveBeenCalled();
    expect(io.record).not.toHaveBeenCalled();
  });
  it('failed push leaves no dedupe; a crash after push is a stateless no-op on the new head', async () => {
    const { io } = fixture({ push: () => { throw Error('non-fast-forward'); } });
    await (await pass()).runResolvedSideBranchPass({ repo: 'web-everything/web-everything' }, io);
    expect(io.record).not.toHaveBeenCalled();
    const f = fixture({ record: () => { throw Error('crash'); } });
    await (await pass()).runResolvedSideBranchPass({ repo: 'web-everything/web-everything' }, f.io);
    await (await pass()).runResolvedSideBranchPass({ repo: 'web-everything/web-everything' }, { ...f.io, listPrs: () => [f.live()] });
    expect(f.io.push).toHaveBeenCalledTimes(1);
  });
  it('no label exemption or live author bypass; unreadable branch scan holds dispatch', () => {
    const plan = planReconcile({ prs: [{ ...pr, resolvedSideBranches: null }] });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'resolved-side-branch-unreadable' }));
  });
  it('settings default on, cascade platform/tool/environment, and log provenance', async () => {
    const { resolveResolvedSideBranchSetting: setting } = await pass();
    expect(setting({ env: {}, platform: {}, tool: {} })).toMatchObject({ value: true, source: 'standard' });
    expect(setting({ env: {}, platform: { pushResolvedSideBranch: false }, tool: {} })).toMatchObject({ value: false, source: 'platform' });
    expect(setting({ env: {}, platform: { pushResolvedSideBranch: true }, tool: { pushResolvedSideBranch: false } })).toMatchObject({ value: false, source: 'tool' });
    expect(setting({ env: { WE_FIX_PUSH_RESOLVED_SIDE_BRANCH: 'on' }, platform: { pushResolvedSideBranch: true }, tool: { pushResolvedSideBranch: false } })).toMatchObject({ value: true, source: 'env' });
    expect(setting({ env: { WE_FIX_PUSH_RESOLVED_SIDE_BRANCH: 'unknown' }, platform: {}, tool: {} }).value).toBe(false);
  });
});
