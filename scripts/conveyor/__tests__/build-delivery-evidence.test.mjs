import { describe, it, expect } from 'vitest';
import {
  classifyBuildDelivery, prBelongsToBuild, cardStatusFromText, cardOpenedFromText, readBuildDelivery, defaultListBuildPrs,
  defaultReadCardStatus, defaultReadCardOpened,
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
  it('a cross-repository (fork) PR is never delivery evidence, by branch OR by title', () => {
    expect(prBelongsToBuild(pr({ isCrossRepository: true }), '4388')).toBe(false);
    expect(prBelongsToBuild(pr({ isCrossRepository: true, headRefName: 'someone/patch-1' }), '4388')).toBe(false);
    expect(prBelongsToBuild(pr({ isCrossRepository: false }), '4388')).toBe(true);
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
  it('a fork PR on lane/<num>- cannot suppress the card (open or merged)', () => {
    const open = pr({ number: 7, isCrossRepository: true });
    const merged = pr({ number: 8, state: 'MERGED', mergedAt: '2026-10-07T19:26:47Z', isCrossRepository: true });
    expect(classifyBuildDelivery({ num: '4388', prs: [open, merged], cardStatus: 'open' })).toBeNull();
  });
  it('re-queue: a merged PR from BEFORE the card was (re)opened is not delivery of this opening', () => {
    const old = pr({ number: 50, state: 'MERGED', mergedAt: '2026-09-01T10:00:00Z' });
    expect(classifyBuildDelivery({ num: '4388', prs: [old], cardStatus: 'open', cardOpenedAt: '2026-10-05' })).toBeNull();
    // same-day and later merges still count (the card is opened, built and merged on one day all the time)
    const sameDay = pr({ number: 51, state: 'MERGED', mergedAt: '2026-10-05T10:00:00Z' });
    expect(classifyBuildDelivery({ num: '4388', prs: [sameDay], cardStatus: 'open', cardOpenedAt: '2026-10-05' })).toMatchObject({ outcome: 'pr-merged', pr: 51 });
    const later = pr({ number: 52, state: 'MERGED', mergedAt: '2026-10-07T10:00:00Z' });
    expect(classifyBuildDelivery({ num: '4388', prs: [old, later], cardStatus: 'open', cardOpenedAt: '2026-10-05' })).toMatchObject({ outcome: 'pr-merged', pr: 52 });
  });
  it('an unreadable or absent dateOpened never hides a merged PR (fail toward "delivered")', () => {
    const old = pr({ number: 50, state: 'MERGED', mergedAt: '2026-09-01T10:00:00Z' });
    for (const cardOpenedAt of [null, undefined, '', 'garbage']) {
      expect(classifyBuildDelivery({ num: '4388', prs: [old], cardStatus: 'open', cardOpenedAt })).toMatchObject({ outcome: 'pr-merged' });
    }
  });
  it('an open PR is still pr-open whatever the card date says (live work is never "old")', () => {
    expect(classifyBuildDelivery({ num: '4388', prs: [pr({})], cardStatus: 'open', cardOpenedAt: '2030-01-01' })).toMatchObject({ outcome: 'pr-open' });
  });
  it('nothing found is null', () => {
    expect(classifyBuildDelivery({ num: '4388', prs: [], cardStatus: 'open' })).toBeNull();
  });
});

describe('IO shell fails soft', () => {
  it('cardOpenedFromText reads the dateOpened frontmatter', () => {
    expect(cardOpenedFromText('---\nkind: story\ndateOpened: "2026-10-07"\n---\nbody')).toBe('2026-10-07');
    expect(cardOpenedFromText('---\ndateOpened: 2026-10-07\n---')).toBe('2026-10-07');
    expect(cardOpenedFromText('---\nkind: story\n---')).toBeNull();
  });
  it('readBuildDelivery threads the card dateOpened through to the classifier', () => {
    const old = pr({ number: 50, state: 'MERGED', mergedAt: '2026-09-01T10:00:00Z' });
    const io = { listPrs: () => [old], readCardStatus: () => 'open' };
    expect(readBuildDelivery('4388', { ...io, readCardOpened: () => '2026-10-05' })).toBeNull();
    expect(readBuildDelivery('4388', { ...io, readCardOpened: () => null })).toMatchObject({ outcome: 'pr-merged' });
  });
  it('cardStatusFromText reads frontmatter status', () => {
    expect(cardStatusFromText('---\nkind: story\nstatus: resolved\n---\nbody')).toBe('resolved');
    expect(cardStatusFromText('no frontmatter')).toBeNull();
  });
  it('the default readers take status and dateOpened from the card on origin/main (git is injected)', () => {
    const git = (_f, a) => (a[0] === 'ls-tree' ? 'backlog/4388-x.md\n' : '---\nstatus: open\ndateOpened: "2026-10-05"\n---\n');
    expect(defaultReadCardStatus('4388', { git })).toBe('open');
    expect(defaultReadCardOpened('4388', { git })).toBe('2026-10-05');
    expect(defaultReadCardOpened('9999', { git: () => { throw new Error('no git'); } })).toBeNull();
  });
  it('a throwing reader is unknown, never delivered', () => {
    const boom = () => { throw new Error('gh down'); };
    expect(readBuildDelivery('4388', { listPrs: boom, readCardStatus: boom })).toBeNull();
  });
  it('defaultListBuildPrs asks gh for ALL states by branch prefix and parses rows; a gh failure is null', () => {
    let argv;
    const rows = defaultListBuildPrs('4388', { exec: (_f, a) => { argv = a; return JSON.stringify([pr({})]); } });
    expect(argv).toEqual(expect.arrayContaining(['--state', 'all', '--search', 'head:lane/4388-']));
    expect(argv[argv.indexOf('--json') + 1].split(',')).toContain('isCrossRepository');
    // fork rows are dropped AFTER the page limit, so the page must be wide enough that forks cannot crowd out the real PR
    expect(Number(argv[argv.indexOf('--limit') + 1])).toBeGreaterThanOrEqual(100);
    expect(rows).toHaveLength(1);
    expect(defaultListBuildPrs('4388', { exec: () => { throw new Error('x'); } })).toBeNull();
  });
});
