/**
 * stack.reviewWhileBaseOpen (operator go 2026-10-10): a GitHub-stacked PR (base = another PR's lane branch) is promoted,
 * reviewed against its base, and fixed while its base PR is still open; merge still waits for the base.
 * Live before: #4750/#4757/#4759/#4770 sat as `review-status:awaiting-base` drafts with no checks at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveStackReviewWhileBaseOpen, stackReviewWhileBaseOpen, isGithubStacked, stackedTopMayFixInParallel,
  resetStackReviewLog, STACK_REVIEW_WHILE_BASE_OPEN_ENV,
} from '../../lib/stack-review-while-open.mjs';
import { isDraftOwedPromotion, isPromotionCandidate } from '../draft-promotion-rule.mjs';
import { runReconcilePromoteDraftDispatch } from '../../operations/promote-draft-pr-dispatch.mjs';
import { applyStackOrder, markParallelFixPairs, resetHoldMemo } from '../pr-stack.mjs';
import { findStackBases, decideStackDispatch, renderStackMarker, stackHoldHeading } from '../review-stack-base.mjs';
import { classifyPr } from '../../merge-ai-prs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sha = (c) => c.repeat(40);
const settings = { detect: true, bottomFirst: true, restack: true, restackMaxRounds: 3, holdMaxAgeMs: 6 * 3600e3 };

describe('policy: stack.reviewWhileBaseOpen', () => {
  beforeEach(() => resetStackReviewLog());
  it('defaults to true from the standard layer', () => {
    expect(resolveStackReviewWhileBaseOpen({}, { read: () => ({}) })).toEqual({ value: true, source: 'standard' });
  });
  it('the tool file overrides the default; env overrides the file; junk is ignored', () => {
    expect(resolveStackReviewWhileBaseOpen({}, { read: () => ({ stack: { reviewWhileBaseOpen: false } }) })).toEqual({ value: false, source: 'tool' });
    expect(resolveStackReviewWhileBaseOpen({ [STACK_REVIEW_WHILE_BASE_OPEN_ENV]: 'on' }, { read: () => ({ stack: { reviewWhileBaseOpen: false } }) })).toEqual({ value: true, source: 'env' });
    expect(resolveStackReviewWhileBaseOpen({ [STACK_REVIEW_WHILE_BASE_OPEN_ENV]: 'maybe' }, { read: () => ({ stack: { reviewWhileBaseOpen: 'nah' } }) })).toEqual({ value: true, source: 'standard' });
    expect(resolveStackReviewWhileBaseOpen({}, { read: () => { throw new Error('unreadable'); } }).value).toBe(true);
  });
  it('the shipped settings file turns it on, and the source is logged once per process', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'scripts/settings/stack.json'), 'utf8')).stack.reviewWhileBaseOpen).toBe(true);
    const lines = [];
    const env = { WE_POLICY_CASCADE_LOG: '1' };
    stackReviewWhileBaseOpen(env, { read: () => ({}), log: (l) => lines.push(l) });
    stackReviewWhileBaseOpen(env, { read: () => ({}), log: (l) => lines.push(l) });
    expect(lines).toEqual(['policy-cascade · stack: reviewWhileBaseOpen=true (standard)']);
  });
  it('a GitHub stack is a base other than the default branch; unknown is not a stack', () => {
    expect(isGithubStacked({ baseRefName: 'lane/resource-usage-service' })).toBe(true);
    expect(isGithubStacked({ baseRefName: 'main' })).toBe(false);
    expect(isGithubStacked({})).toBe(false);
  });
});

describe('CI runs a stacked PR\'s own required checks', () => {
  it.each(['.github/workflows/ci.yml', '.github/workflows/soak-replay-gate.yml'])('%s triggers on pull_request into lane/**', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text).toMatch(/pull_request:\n\s+branches: \[main, 'lane\/\*\*'\]/);
  });
});

describe('promotion: a stacked draft with green checks is promoted while its base is open', () => {
  const draft = { state: 'OPEN', isDraft: true, headRefName: 'lane/resource-slice-2', headRefOid: sha('a'), baseRefName: 'lane/resource-usage-service', labels: [{ name: 'review-status:awaiting-base' }], isCrossRepository: false };
  it('the shared rule owes it promotion on its own green head checks (setting on)', () => {
    const r = isDraftOwedPromotion({ pr: draft, checks: { state: 'green', sha: sha('a') }, reviewWhileBaseOpen: true });
    expect(r.owed).toBe(true);
    expect(r.why).toMatch(/while the base is open/);
    expect(isPromotionCandidate(draft, { reviewWhileBaseOpen: true })).toBe(true);
  });
  it('still not owed while its checks are not green, and never with the setting off', () => {
    expect(isDraftOwedPromotion({ pr: draft, checks: { state: 'pending', sha: sha('a') }, reviewWhileBaseOpen: true }).owed).toBe(false);
    const off = isDraftOwedPromotion({ pr: draft, checks: { state: 'green', sha: sha('a') }, reviewWhileBaseOpen: false });
    expect(off).toEqual({ owed: false, why: expect.stringMatching(/stack\.reviewWhileBaseOpen is off/) });
  });

  const reconcile = () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 4750, headRefOid: sha('a'), baseRefName: 'lane/resource-usage-service' }], refusals: [] });
  const common = { reconcile, checkStaleness: () => {}, readHeadCheckState: () => ({ state: 'green', why: 'ok' }), readPrLabels: () => [], clearAwaitingCi: () => {} };
  it('the tick promote pass un-drafts it and names its open base', () => {
    const ready = [];
    const out = runReconcilePromoteDraftDispatch({ ...common, provider: { ready: (n) => ready.push(n) }, reviewWhileBaseOpen: true });
    expect(ready).toEqual([4750]);
    expect(out.dispatched).toEqual([{ pr: 4750, kind: 'promote-draft', stackedOn: 'lane/resource-usage-service' }]);
  });
  it('with the setting off the tick refuses it as stacked-awaiting-base (the old serial behaviour)', () => {
    const ready = [];
    const out = runReconcilePromoteDraftDispatch({ ...common, provider: { ready: (n) => ready.push(n) }, reviewWhileBaseOpen: false });
    expect(ready).toEqual([]);
    expect(out.refusals).toEqual([expect.objectContaining({ pr: 4750, kind: 'stacked-awaiting-base' })]);
  });
});

describe('review: a GitHub-stacked top is judged against its base, and its accept carries forward after the restack', () => {
  // Bottom #4757 (lane/fixer-history-takeover) at B; top #4759 cut from it: holds B plus its own commit T.
  const B = sha('b'); const T = sha('c');
  const prs = [
    { pr: 4757, headRefName: 'lane/fixer-history-takeover', headRefOid: B, author: 'bot' },
    { pr: 4759, headRefName: 'lane/takeover-review-attempt', headRefOid: T, author: 'bot', baseRefName: 'lane/fixer-history-takeover' },
  ];
  const sets = new Map([
    [B, { reach: new Set([B]), first: [B] }],
    [T, { reach: new Set([T, B]), first: [T, B] }],
  ]);
  it('the stack base of the top is its open base PR (scope and the juror diff read from it, not main)', () => {
    expect(findStackBases(prs, sets).get(4759)).toEqual({ pr: 4757, ref: 'lane/fixer-history-takeover', head: B, contained: B });
  });
  const fp = 'f'.repeat(64);
  const marker = renderStackMarker({ top: 4759, topHead: T, bottom: 4757, bottomRef: 'lane/fixer-history-takeover', bottomHead: B, contained: B, fingerprint: fp });
  const comments = [{ viewerDidAuthor: true, author: { login: 'web-everything-bot[bot]' }, body: `${stackHoldHeading(4757)} accepted on its own diff.\n${marker}` }];
  it('while the base is open an accept is held (no accept label, so the drain cannot land it)', () => {
    const d = decideStackDispatch({ pr: 4759, stack: { pr: 4757 }, comments, stackFingerprint: fp });
    expect(d.action).toBe('held');
  });
  it('after the base merges and the restack leaves an identical net diff, the accept is carried forward', () => {
    const d = decideStackDispatch({ pr: 4759, stack: null, comments, mainFingerprint: fp, bottomLanded: { ok: true } });
    expect(d.action).toBe('carry');
  });
  it('a different net diff after the restack gets exactly one re-review', () => {
    expect(decideStackDispatch({ pr: 4759, stack: null, comments, mainFingerprint: 'e'.repeat(64), bottomLanded: { ok: true } }).action).toBe('review');
  });
});

describe('fixer: a stacked top is held behind its base only while both are fixed on shared files', () => {
  beforeEach(() => resetHoldMemo());
  const pair = (extra = {}) => ({ top: 4770, bottom: 4759, bottomRef: 'lane/takeover-review-attempt', bottomHead: sha('b'), containedHead: sha('b'), heldFor: sha('b'), heldSince: null, topHead: sha('c'), bottomOpen: true, inSync: true, restackRounds: 0, ...extra });
  // `stackPolicy` + `bottomClaimed` are what markParallelFixPairs sets; the bottom is "busy" when it owes a fix this pass
  // (it is in `planned`) or holds a live fix claim.
  const busyBottom = { stackPolicy: true, bottomClaimed: true };
  it('a top whose own change touches none of the base files is dispatched in parallel, even beside a busy bottom', () => {
    const out = applyStackOrder([{ pr: 4759 }, { pr: 4770 }], { pairs: [pair({ ...busyBottom, parallelFix: true })] }, { settings });
    expect(out.planned).toEqual([{ pr: 4759 }, { pr: 4770 }]);
    expect(out.refusals.map((r) => r.kind)).toEqual(['stacked-parallel-fix']);
    expect(out.stackAbove.get(4759).has(4770)).toBe(false);
  });
  it('bottom-first (#4655) holds only while BOTH are being fixed on shared (or unknown) files', () => {
    for (const p of [pair({ ...busyBottom, parallelFix: false }), pair({ stackPolicy: true, bottomClaimed: null, parallelFix: false })]) {
      const out = applyStackOrder([{ pr: 4770 }], { pairs: [p] }, { settings });
      expect(out.planned).toEqual([]);
      expect(out.refusals.map((r) => r.kind)).toEqual(['stacked-above']);
    }
    // bottom owes a fix this pass (planned) and shares files: held
    const owed = applyStackOrder([{ pr: 4759 }, { pr: 4770 }], { pairs: [pair({ stackPolicy: true, bottomClaimed: false, parallelFix: false })] }, { settings });
    expect(owed.planned).toEqual([{ pr: 4759 }]);
    expect(owed.refusals.map((r) => r.kind)).toEqual(['stacked-above']);
  });
  it('setting off (no stackPolicy on the pair): the old hold is unchanged', () => {
    const out = applyStackOrder([{ pr: 4770 }], { pairs: [pair({ parallelFix: true, bottomClaimed: false })] }, { settings });
    expect(out.refusals.map((r) => r.kind)).toEqual(['stacked-above']);
  });
  it('live #4715 (2026-10-10 08:40→11:03 ET): bottom #4708 at its round cap, no fix owed, no claim → the top is dispatched, not held', () => {
    const p = { top: 4715, bottom: 4708, bottomRef: 'lane/gh-merge-queue-gate', bottomHead: sha('a'), containedHead: sha('a'), heldFor: sha('a'), heldSince: null,
      topHead: sha('d'), bottomOpen: true, inSync: true, restackRounds: 0, stackPolicy: true, bottomClaimed: false, parallelFix: false };
    // #4708 is absent from `planned`: reconcile refused it `cap-exhausted` on every tick of the window.
    const out = applyStackOrder([{ pr: 4715 }], { pairs: [p] }, { settings });
    expect(out.planned).toEqual([{ pr: 4715 }]);
    expect(out.refusals[0]).toEqual(expect.objectContaining({ kind: 'stacked-parallel-fix', why: expect.stringMatching(/owes no fix this pass and holds no fix claim/) }));
  });
  it('markParallelFixPairs: disjoint files → parallel; shared file or unreadable diff → held; setting off → untouched', () => {
    const files = { [`${sha('b')}...${sha('c')}`]: ['scripts/a.mjs'], [`origin/main...${sha('b')}`]: ['scripts/b.mjs'] };
    const readFiles = () => (a, b) => files[`${a}...${b}`] ?? null;
    const disjoint = { pairs: [pair()] };
    markParallelFixPairs(disjoint, { root: '.', reviewWhileBaseOpen: () => true, readFiles, readClaims: () => [{ meta: { pr: 4759 } }] });
    expect(disjoint.pairs[0]).toEqual(expect.objectContaining({ parallelFix: true, stackPolicy: true, bottomClaimed: true }));
    const noClaim = { pairs: [pair()] };
    markParallelFixPairs(noClaim, { root: '.', reviewWhileBaseOpen: () => true, readFiles, readClaims: () => [] });
    expect(noClaim.pairs[0].bottomClaimed).toBe(false);
    const claimsUnreadable = { pairs: [pair()] };
    markParallelFixPairs(claimsUnreadable, { root: '.', reviewWhileBaseOpen: () => true, readFiles, readClaims: () => { throw new Error('x'); } });
    expect(claimsUnreadable.pairs[0].bottomClaimed).toBeNull();
    files[`origin/main...${sha('b')}`] = ['scripts/a.mjs'];
    const shared = { pairs: [pair()] };
    markParallelFixPairs(shared, { root: '.', reviewWhileBaseOpen: () => true, readFiles, readClaims: () => [] });
    expect(shared.pairs[0].parallelFix).toBe(false);
    const unreadable = { pairs: [pair()] };
    markParallelFixPairs(unreadable, { root: '.', reviewWhileBaseOpen: () => true, readFiles: () => () => null, readClaims: () => [] });
    expect(unreadable.pairs[0].parallelFix).toBe(false);
    const off = { pairs: [pair()] };
    markParallelFixPairs(off, { root: '.', reviewWhileBaseOpen: () => false, readFiles, readClaims: () => [] });
    expect(off.pairs[0].parallelFix).toBeUndefined();
    expect(off.pairs[0].stackPolicy).toBeUndefined();
  });
  it('stackedTopMayFixInParallel fails closed on an unknown side', () => {
    expect(stackedTopMayFixInParallel({ topOwnFiles: null, bottomFiles: [] })).toEqual({ parallel: false, overlap: null });
  });
});

describe('drain: never merges a PR whose base is not main', () => {
  const ready = {
    number: 4759, title: 't', baseRefName: 'lane/fixer-history-takeover', labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', commits: [],
  };
  it('refused with the default branch known', () => {
    const v = classifyPr(ready, { defaultBranch: 'main' });
    expect(v.decision).toBe('skip');
    expect(v.reason).toBe('base is not main (lane/fixer-history-takeover)');
  });
  it('refused even when the default branch could not be resolved (fail closed for a lane/* base)', () => {
    const v = classifyPr(ready, { defaultBranch: null });
    expect(v.decision).toBe('skip');
    expect(v.reason).toBe('base is not the default branch (lane/fixer-history-takeover)');
  });
  it('the same PR retargeted to main after its base merged is no longer held by this arm', () => {
    const v = classifyPr({ ...ready, baseRefName: 'main' }, { defaultBranch: 'main' });
    expect(v.reason).not.toMatch(/base is not/);
  });
});
