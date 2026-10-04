/**
 * @file scripts/__tests__/prune-landed-lanes.test.mjs
 * @description Unit proof of the pure classifier in `scripts/prune-landed-lanes.mjs` — the #2226
 *   content-verified sweep for stale `origin/lane/*` refs. `git merge-tree` / `gh pr list` are the I/O
 *   boundary (the CLI); `classifyLaneBranch` decides delete/keep/skip from precomputed inputs, so the
 *   safety property ("never delete a ref with live or unverifiable content") is provable without git/gh.
 */
import { describe, it, expect } from 'vitest';
import { isLaneBranch, openPrHeadRefs, openPrStackedBases, classifyLaneBranch, isStillSafeToDelete, nearMissCommentMarker, buildNearMissComment } from '../prune-landed-lanes.mjs';

describe('prune-landed-lanes — isLaneBranch', () => {
  it('accepts only lane/* refs', () => {
    expect(isLaneBranch('lane/2226-foo')).toBe(true);
    expect(isLaneBranch('lane/_base-batch-x')).toBe(true);
    expect(isLaneBranch('main')).toBe(false);
    expect(isLaneBranch('release/1.0')).toBe(false);
    expect(isLaneBranch(undefined)).toBe(false);
  });
});

describe('prune-landed-lanes — openPrHeadRefs', () => {
  it('collects headRefName from a gh pr list --json headRefName payload', () => {
    const set = openPrHeadRefs([{ headRefName: 'lane/a' }, { headRefName: 'lane/b' }]);
    expect(set.has('lane/a')).toBe(true);
    expect(set.has('lane/c')).toBe(false);
  });
  it('is empty/safe on no PRs or malformed entries', () => {
    expect(openPrHeadRefs([]).size).toBe(0);
    expect(openPrHeadRefs(null).size).toBe(0);
    expect(openPrHeadRefs([{}, { headRefName: null }]).size).toBe(0);
  });
});

describe('prune-landed-lanes — classifyLaneBranch (safety property: never delete live/unverifiable content)', () => {
  it('SKIPS any branch backing an open PR, even if content looks superseded', () => {
    const v = classifyLaneBranch('lane/x', { hasOpenPr: true, mergeTree: { ok: true, treeEqualsMain: true } });
    expect(v.verdict).toBe('skip');
  });
  it('DELETEs only when content is byte-identical to origin/main (three-way merge == main tree)', () => {
    const v = classifyLaneBranch('lane/x', { hasOpenPr: false, mergeTree: { ok: true, treeEqualsMain: true } });
    expect(v.verdict).toBe('delete');
  });
  it('KEEPs a clean merge that still differs from main (real unmerged content, no open PR — orphaned WIP)', () => {
    const v = classifyLaneBranch('lane/x', { hasOpenPr: false, mergeTree: { ok: true, treeEqualsMain: false } });
    expect(v.verdict).toBe('keep');
  });
  it('KEEPs on a merge-tree conflict (git exits non-zero) — never auto-deletes on doubt', () => {
    const v = classifyLaneBranch('lane/x', { hasOpenPr: false, mergeTree: { ok: false } });
    expect(v.verdict).toBe('keep');
  });
  it('KEEPs when the merge-tree computation is missing entirely (e.g. origin/main tree lookup failed)', () => {
    const v = classifyLaneBranch('lane/x', { hasOpenPr: false, mergeTree: null });
    expect(v.verdict).toBe('keep');
  });

  // #4138 — live: web-everything/web-everything#2578 closed a SECOND time after being retargeted to `main` (so the
  // #3383 stacked-base-on-a-DRAIN-MERGE cascade could not explain it); prune-landed-lanes never checked
  // whether some OTHER open PR is based on a `lane/*` branch it is about to delete — the identical hazard,
  // just on THIS script's own ref deletes instead of the drain's merge-and-delete.
  it('#4138 — SKIPS a branch some other open PR is based on, even if content looks superseded (never own-head-only)', () => {
    const v = classifyLaneBranch('lane/x', { hasOpenPr: false, mergeTree: { ok: true, treeEqualsMain: true }, stackedOpenPrNums: [2578] });
    expect(v.verdict).toBe('skip');
    expect(v.reason).toMatch(/#2578/);
  });
  it('#4138 — names every stacked PR when more than one is based on the branch', () => {
    const v = classifyLaneBranch('lane/x', { hasOpenPr: false, mergeTree: { ok: true, treeEqualsMain: true }, stackedOpenPrNums: [2578, 2601] });
    expect(v.reason).toMatch(/#2578/);
    expect(v.reason).toMatch(/#2601/);
  });
  it('no stacked PRs (the common case) behaves exactly as before', () => {
    const v = classifyLaneBranch('lane/x', { hasOpenPr: false, mergeTree: { ok: true, treeEqualsMain: true }, stackedOpenPrNums: [] });
    expect(v.verdict).toBe('delete');
  });
});

describe('prune-landed-lanes — openPrStackedBases (#4138)', () => {
  it('maps a base ref to every open PR number based on it', () => {
    const map = openPrStackedBases([{ number: 2578, baseRefName: 'lane/3681' }, { number: 2601, baseRefName: 'lane/3681' }, { number: 9, baseRefName: 'main' }]);
    expect(map.get('lane/3681')).toEqual([2578, 2601]);
    expect(map.get('main')).toEqual([9]);
    expect(map.has('lane/nobody-stacked-here')).toBe(false);
  });
  it('is empty/safe on no PRs or malformed entries', () => {
    expect(openPrStackedBases([]).size).toBe(0);
    expect(openPrStackedBases(null).size).toBe(0);
    expect(openPrStackedBases([{}, { baseRefName: null }, { baseRefName: 'lane/x' /* no number */ }]).size).toBe(0);
  });
});

// #4138 — the delete-time TOCTOU gate: `results` above classifies off the sweep-start snapshot, but the
// actual `gh api DELETE` may run much later (after every branch's own `git merge-tree` computation). This is
// the fresh, immediately-before-delete re-check that catches a PR opened/reopened in that window.
describe('prune-landed-lanes — isStillSafeToDelete (#4138 TOCTOU close)', () => {
  it('safe when the fresh read shows neither hazard', () => {
    expect(isStillSafeToDelete('lane/x', { heads: new Set(), stackedBases: new Map() })).toEqual({ safe: true });
  });
  it('unsafe when the branch itself now backs an open PR (reopened since the sweep started)', () => {
    const r = isStillSafeToDelete('lane/x', { heads: new Set(['lane/x']), stackedBases: new Map() });
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/reopened/);
  });
  it('unsafe when some other open PR is now based on the branch, and names the PR number(s)', () => {
    const r = isStillSafeToDelete('lane/x', { heads: new Set(), stackedBases: new Map([['lane/x', [2578]]]) });
    expect(r.safe).toBe(false);
    expect(r.stackedPrs).toEqual([2578]);
  });
});

describe('prune-landed-lanes — the #4138 near-miss comment (never a silent withheld delete)', () => {
  it('carries its own dedupe marker and names the branch + reason', () => {
    const body = buildNearMissComment('lane/x', 'now backs an open PR (opened or reopened since this sweep started)');
    expect(body.startsWith(nearMissCommentMarker())).toBe(true);
    expect(body).toMatch(/lane\/x/);
    expect(body).toMatch(/now backs an open PR/);
  });
});
