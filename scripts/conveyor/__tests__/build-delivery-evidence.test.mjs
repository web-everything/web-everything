import { describe, it, expect } from 'vitest';
import {
  classifyBuildDelivery, prBelongsToBuild, cardStatusFromText, readBuildDelivery, defaultListBuildPrs,
} from '../build-delivery-evidence.mjs';

const pr = (over) => ({ number: 1, state: 'OPEN', title: 'WE #4388: build', headRefName: 'lane/4388-fix', mergedAt: null, url: 'u', ...over });

describe('prBelongsToBuild', () => {
  it('matches the lane branch or a word-boundary title, never a prepare/scope authoring PR', () => {
    expect(prBelongsToBuild(pr({}), '4388')).toBe(true);
    expect(prBelongsToBuild(pr({ title: 'unrelated', headRefName: 'lane/4388-ci-app-token-we' }), '4388')).toBe(true);
    expect(prBelongsToBuild(pr({ headRefName: 'lane/4388-scope-abc' }), '4388')).toBe(false);
    expect(prBelongsToBuild(pr({ headRefName: 'lane/4388-prepare-abc' }), '4388')).toBe(false);
    expect(prBelongsToBuild(pr({ title: 'WE #43880: x', headRefName: 'lane/other' }), '4388')).toBe(false);
  });
});

describe('classifyBuildDelivery', () => {
  it('replay #4388 -> PR #4339: an open PR is pr-open', () => {
    expect(classifyBuildDelivery({ num: '4388', prs: [pr({ number: 4339 })] })).toMatchObject({ outcome: 'pr-open', pr: 4339 });
  });
  it('replay #4382: a merged PR is pr-merged and wins over an open one', () => {
    const merged = pr({ number: 4288, state: 'MERGED', mergedAt: '2026-10-07T19:26:47Z', title: 'WE #4382: build', headRefName: 'lane/4382-ci-app-token-we' });
    expect(classifyBuildDelivery({ num: '4382', prs: [pr({ number: 9, title: 'WE #4382: again', headRefName: 'lane/4382b' }), merged] }))
      .toMatchObject({ outcome: 'pr-merged', pr: 4288 });
  });
  it('a closed-unmerged PR is not delivery', () => {
    expect(classifyBuildDelivery({ num: '4388', prs: [pr({ state: 'CLOSED' })] })).toBeNull();
  });
  it('a resolved card with no PR is card-resolved', () => {
    expect(classifyBuildDelivery({ num: '4382', prs: [], cardStatus: 'resolved' })).toMatchObject({ outcome: 'card-resolved' });
  });
  it('nothing found is null', () => {
    expect(classifyBuildDelivery({ num: '4388', prs: [], cardStatus: 'open' })).toBeNull();
  });
});

describe('IO shell fails soft', () => {
  it('cardStatusFromText reads frontmatter status', () => {
    expect(cardStatusFromText('---\nkind: story\nstatus: resolved\n---\nbody')).toBe('resolved');
    expect(cardStatusFromText('no frontmatter')).toBeNull();
  });
  it('a throwing reader is unknown, never delivered', () => {
    const boom = () => { throw new Error('gh down'); };
    expect(readBuildDelivery('4388', { listPrs: boom, readCardStatus: boom })).toBeNull();
  });
  it('defaultListBuildPrs asks gh for ALL states by branch prefix and parses rows; a gh failure is null', () => {
    let argv;
    const rows = defaultListBuildPrs('4388', { exec: (_f, a) => { argv = a; return JSON.stringify([pr({})]); } });
    expect(argv).toEqual(expect.arrayContaining(['--state', 'all', '--search', 'head:lane/4388-']));
    expect(rows).toHaveLength(1);
    expect(defaultListBuildPrs('4388', { exec: () => { throw new Error('x'); } })).toBeNull();
  });
});
