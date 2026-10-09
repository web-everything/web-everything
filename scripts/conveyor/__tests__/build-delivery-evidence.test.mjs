import { describe, it, expect } from 'vitest';
import {
  classifyBuildDelivery, prBelongsToBuild, cardStatusFromText, cardOpenedFromText, readBuildDelivery, defaultListBuildPrs,
  defaultReadCardStatus, defaultReadCardOpened, NON_IMPLEMENTING_REF_RE, isDocsOnlyPr, isBacklogOnlyPr,
} from '../build-delivery-evidence.mjs';
import { NON_IMPLEMENTING_REF_RE as IO_NON_IMPLEMENTING_REF_RE, filterAlreadyDoneCandidates } from '../../operations/dispatch-lane-io.mjs';
import { publicationTitle } from '../../operations/machine-pr-title.mjs';

const pr = (over) => ({ number: 1, state: 'OPEN', title: 'WE #4388: build', headRefName: 'lane/4388-fix', mergedAt: null, url: 'u', ...over });

describe('prBelongsToBuild', () => {
  it('matches the lane branch or a word-boundary title, never a prepare/scope authoring PR', () => {
    expect(prBelongsToBuild(pr({}), '4388')).toBe(true);
    expect(prBelongsToBuild(pr({ title: 'unrelated', headRefName: 'lane/4388-ci-app-token-we' }), '4388')).toBe(true);
    // authoring PRs carry an authoring title (the ref shape alone is not proof — see the live-PR table below)
    expect(prBelongsToBuild(pr({ title: 'WE #4388: author scope: for #4388', headRefName: 'lane/4388-scope-abc' }), '4388')).toBe(false);
    expect(prBelongsToBuild(pr({ title: 'WE #4388: prepare — etxtbsy', headRefName: 'lane/4388-prepare-abc' }), '4388')).toBe(false);
    expect(prBelongsToBuild(pr({ title: 'WE #43880: x', headRefName: 'lane/other' }), '4388')).toBe(false);
  });
  it('a real build whose slug merely CONTAINS scope/prepare is still a build; only the authoring shape is dropped', () => {
    expect(prBelongsToBuild(pr({ title: 'x', headRefName: 'lane/4400-narrow-scope-of-x' }), '4400')).toBe(true);
    expect(prBelongsToBuild(pr({ title: 'x', headRefName: 'lane/4400-fix-prepare-step' }), '4400')).toBe(true);
    expect(prBelongsToBuild(pr({ title: 'x', headRefName: 'lane/4400b-narrow-scope-of-x' }), '4400')).toBe(true);
    expect(prBelongsToBuild(pr({ title: 'x', headRefName: 'lane/4400-scope-3dfab284' }), '4400')).toBe(false);
    expect(prBelongsToBuild(pr({ title: 'x', headRefName: 'lane/4400b-prepare-3dfab284' }), '4400')).toBe(false);
  });
  // Review of PR #4361 (operator ruling): the ref alone cannot tell an authoring PR from a real build. A card
  // whose own slug starts with scope-/prepare- gets a build branch of exactly the authoring shape. Every row is a
  // real PR of web-everything/web-everything (number, ref, title as GitHub has them).
  it.each([
    // real builds on an authoring-shaped ref — the title is the card's, not an authoring marker
    [700, 'lane/2629-scope-review-to-convergence', 'WE #2629: prepare-scope agents run an AI review-to-convergence before any human review', '2629', true],
    [870, 'lane/2739-scope-authoring-file-level', 'WE #2739: flag directory-level backlog scopes at authoring — default to file-level', '2739', true],
    [743, 'lane/2638-prepare-time-jury-charter', 'WE #2638: prepare-time jury charter — pre-register jury + expectations', '2638', true],
    [2998, 'lane/4504-prepare-item-spawn', 'WE #4504: spawn a full prepare agent for needs-prepare holds', '4504', true],
    [3098, 'lane/4594-prepare-handoff', 'WE #4594: prepared cards become buildable on the next tick (no rediscovery)', '4594', true],
    [3074, 'lane/4480b-prepare-stamp-works-on-an-actively-claimed-card-without-rese', 'WE #4480: gate-failure fix', '4480', true],
    [0, 'lane/4480-prepare-stamp-works-on-an-actively-claimed-card', 'WE #4480: build — prepare-stamp works on an actively claimed card', '4480', true],
    // authoring PRs — every title shape the prepare/scope flows have minted
    [833, 'lane/2451-scope-origin-fresh-defer-aware', 'WE #2451: author scope: for #2451', '2451', false],
    [4363, 'lane/4648-prepare-reconcile-dead-build-run-records-even-after-their-dispatch-c', 'WE #4648: prepare — reconcile dead build run records even after their…', '4648', false],
    [3070, 'lane/4480-prepare-item', 'WE #4480: prepare item — Design/MVP/Test plan/Proof plan/Follow-ups', '4480', false],
    [3047, 'lane/4544-prepare-stamp', 'WE #4544: complete prepare stamp', '4544', false],
    [2440, 'lane/3722-prepare-decision', 'prepare #3722: session and runner one system — 3 forks + ratify, research topic, grounding report', '3722', false],
    [2428, 'lane/3806-prepare-weighted-budget', 'backlog: #3806 prepare-stamp (preparedDate 2026-09-21)', '3806', false],
    [0, 'lane/4400-prepare-stamp', 'WE #4400: prepare-stamp — narrow the scope of x', '4400', false],
    // an authoring PR off the usual ref shape, and one for a hash-id card
    [2242, 'lane/2456-author-scope-drain-review', 'WE #2456: author scope: for #2456', '2456', false],
    [0, 'lane/x9mr5is-prepare-the-disjoint-closure-check-treats-a-deleted-dependency-as-to', 'WE #x9mr5is: prepare — the disjoint closure check treats a deleted…', 'x9mr5is', false],
    // no title to read: the authoring-shaped ref keeps its old reading
    [0, 'lane/4400-prepare-narrow-scope', '', '4400', false],
  ])('live PR #%i (%s) belongs to the build: %s', (number, headRefName, title, num, expected) => {
    expect(prBelongsToBuild(pr({ number, headRefName, title }), num)).toBe(expected);
  });
  // The title GitHub shows is the one `publicationTitle` publishes, not the brief's raw commit subject: it files
  // `author scope: for #N` under `build —`. Every authoring brief's subject, as published, must still read authoring.
  it.each([
    ['prepare-scope', 'WE #4400: author scope: for #4400', 'lane/4400-scope-narrow-the-gate'],
    ['prepare-decision', 'WE #4400: prepare decision forks for #4400', 'lane/4400-prepare-narrow-the-gate'],
    ['prepare-item', 'WE #4400: prepare — narrow the gate', 'lane/4400-prepare-item-narrow-the-gate'],
    ['legacy decision', 'WE #4400: author decision forks for #4400', 'lane/4400-prepare-narrow-the-gate'],
  ])('a %s PR, as published, is authoring, not delivery', (_kind, subject, headRefName) => {
    const title = publicationTitle({ title: subject, card: { title: 'Narrow the gate' } });
    expect(prBelongsToBuild(pr({ title, headRefName }), '4400')).toBe(false);
  });
  it('live scope PR #2317 with its published-form title is authoring; a published build title on the same ref shape is a build', () => {
    expect(prBelongsToBuild(pr({ title: 'WE #2835: build — author scope: for #2835', headRefName: 'lane/2835-scope-verdicts-totality' }), '2835')).toBe(false);
    expect(prBelongsToBuild(pr({ title: 'WE #2835: build — scope verdicts totality', headRefName: 'lane/2835-scope-verdicts-totality' }), '2835')).toBe(true);
  });
  it('the authoring-ref predicate is the ONE shared with dispatch-lane-io, not a re-derived copy', () => {
    expect(NON_IMPLEMENTING_REF_RE).toBe(IO_NON_IMPLEMENTING_REF_RE);
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
    expect(readBuildDelivery('4388', { listPrs: boom, readCardStatus: boom, readCardOpened: () => null })).toBeNull();
  });
  it('defaultListBuildPrs asks gh for ALL states by branch prefix and parses rows; a gh failure is null', () => {
    let argv;
    const rows = defaultListBuildPrs('4388', { exec: (_f, a) => { argv = a; return JSON.stringify([pr({})]); } });
    expect(argv).toEqual(expect.arrayContaining(['--state', 'all', '--search', 'head:lane/4388']));
    expect(argv[argv.indexOf('--json') + 1].split(',')).toEqual(expect.arrayContaining(['isCrossRepository', 'files']));
    // fork rows are dropped AFTER the page limit, so the page must be wide enough that forks cannot crowd out the real PR
    expect(Number(argv[argv.indexOf('--limit') + 1])).toBeGreaterThanOrEqual(100);
    expect(rows).toHaveLength(1);
    expect(defaultListBuildPrs('4388', { exec: () => { throw new Error('x'); } })).toBeNull();
  });
});

// Review of PR #4361 (policy ruling on head d7a3b14ac): the delivery gate must agree with the already-done gate
// about backlog-only PRs, and its production query must reach every ref shape `prBelongsToBuild` accepts.
describe('a backlog-only PR does not suppress the implementation build', () => {
  const md = [{ path: 'backlog/4388-x.md' }, { path: 'backlog/index.md' }];
  const code = [{ path: 'backlog/4388-x.md' }, { path: 'scripts/x.mjs' }];
  it('isDocsOnlyPr: every changed file .md; absent or empty files never says docs-only', () => {
    expect(isDocsOnlyPr({ files: md })).toBe(true);
    expect(isDocsOnlyPr({ files: ['a.MD'] })).toBe(true);
    expect(isDocsOnlyPr({ files: code })).toBe(false);
    for (const files of [undefined, null, [], 'x']) expect(isDocsOnlyPr({ files })).toBe(false);
  });
  it('the delivery gate excludes only BACKLOG-only PRs: a doc card built by a non-backlog .md PR is still delivered', () => {
    expect(isBacklogOnlyPr({ files: md })).toBe(true);
    expect(isBacklogOnlyPr({ files: [{ path: 'backlog/a.md' }, { path: 'skills-src/conveyor/brief.md' }] })).toBe(false);
    for (const files of [undefined, [], [{ path: 'backlog/a.mjs' }]]) expect(isBacklogOnlyPr({ files })).toBe(false);
    const docCard = pr({ number: 79, state: 'OPEN', headRefName: 'lane/4388-brief', files: [{ path: 'skills-src/conveyor/brief.md' }, { path: 'backlog/4388-x.md' }] });
    expect(classifyBuildDelivery({ num: '4388', prs: [docCard], cardStatus: 'open' })).toMatchObject({ outcome: 'pr-open', pr: 79 });
  });
  it.each([
    ['merged, on the card lane ref, unrecognized title (a JIT-number commit)', { state: 'MERGED', mergedAt: '2026-10-07T10:00:00Z', title: 'drain: JIT-number x', headRefName: 'lane/4388-jit' }],
    ['merged, title merely names the number', { state: 'MERGED', mergedAt: '2026-10-07T10:00:00Z', title: 'file the prevention card for 4388', headRefName: 'lane/other' }],
    ['open, title merely names the number', { state: 'OPEN', title: 'prevention card for #4388', headRefName: 'lane/other' }],
    ['open, on the card lane ref', { state: 'OPEN', headRefName: 'lane/4388b-notes' }],
  ])('%s', (_name, over) => {
    const row = pr({ number: 77, files: md, ...over });
    expect(prBelongsToBuild(row, '4388')).toBe(false);
    expect(classifyBuildDelivery({ num: '4388', prs: [row], cardStatus: 'open' })).toBeNull();
    expect(readBuildDelivery('4388', { listPrs: () => [row], readCardStatus: () => 'open', readCardOpened: () => null })).toBeNull();
  });
  it('the same row with a code file still counts, and both gates agree on the same fixtures', () => {
    const row = pr({ number: 78, state: 'MERGED', mergedAt: '2026-10-07T10:00:00Z', title: 'WE #4388: build', files: code });
    expect(classifyBuildDelivery({ num: '4388', prs: [row] })).toMatchObject({ outcome: 'pr-merged', pr: 78 });
    for (const files of [md, code]) {
      const merged = pr({ state: 'MERGED', mergedAt: '2026-10-07T10:00:00Z', title: 'WE #4388: build', files });
      expect(prBelongsToBuild(merged, '4388')).toBe(filterAlreadyDoneCandidates([merged], '4388').length === 1);
    }
  });
});

describe('the production query reaches every ref shape prBelongsToBuild accepts', () => {
  // A gh stub with the real search semantics: `head:<prefix>` is a branch-PREFIX match on the head ref.
  const ghWith = (all) => (_f, a) => {
    const prefix = a[a.indexOf('--search') + 1].replace(/^head:/, '');
    return JSON.stringify(all.filter((r) => r.headRefName.startsWith(prefix)));
  };
  it.each([
    ['lane/4480-slug'], ['lane/4480b-slug'], ['lane/4480z-slug'], ['lane/4480'], ['lane/4480b'],
  ])('%s is returned by defaultListBuildPrs and belongs to the build', (headRefName) => {
    const row = pr({ number: 3074, state: 'MERGED', mergedAt: '2026-10-07T10:00:00Z', title: 'WE #4480: gate-failure fix', headRefName });
    expect(prBelongsToBuild(row, '4480')).toBe(true);
    const listed = defaultListBuildPrs('4480', { exec: ghWith([row]) });
    expect(listed.map((r) => r.number)).toEqual([3074]);
    expect(readBuildDelivery('4480', { listPrs: (n) => defaultListBuildPrs(n, { exec: ghWith([row]) }), readCardStatus: () => 'open', readCardOpened: () => null }))
      .toMatchObject({ outcome: 'pr-merged', pr: 3074 });
  });
  it('replay card 4480: a closed first PR plus a merged retry-letter PR is delivered', () => {
    const closed = pr({ number: 3070, state: 'CLOSED', title: 'WE #4480: build', headRefName: 'lane/4480-first' });
    const retry = pr({ number: 3074, state: 'MERGED', mergedAt: '2026-10-07T10:00:00Z', title: 'WE #4480: gate-failure fix', headRefName: 'lane/4480b-prepare-stamp-works-on-an-actively-claimed-card-without-rese' });
    expect(readBuildDelivery('4480', { listPrs: (n) => defaultListBuildPrs(n, { exec: ghWith([closed, retry]) }), readCardStatus: () => 'open', readCardOpened: () => null }))
      .toMatchObject({ outcome: 'pr-merged', pr: 3074 });
  });
  it('the wider prefix also lists other cards (lane/44801-…); they are dropped by ref, never delivery', () => {
    const other = pr({ number: 9, state: 'MERGED', mergedAt: '2026-10-07T10:00:00Z', title: 'WE #44801: other', headRefName: 'lane/44801-other' });
    expect(prBelongsToBuild(other, '4480')).toBe(false);
    expect(defaultListBuildPrs('4480', { exec: ghWith([other]) })).toEqual([]);
  });
  it('a 3-digit card: another card sharing the digits whose TITLE names this card cannot suppress its build', () => {
    // card 448, query head:lane/448 also returns lane/4481-…; its title mentions "#448" so titleRe alone would accept it
    const other = pr({ number: 10, state: 'OPEN', title: 'WE #4481: follow-up to #448', headRefName: 'lane/4481-follow-up' });
    const mine = pr({ number: 11, state: 'MERGED', mergedAt: '2026-10-07T10:00:00Z', title: 'WE #448: build', headRefName: 'lane/448b-retry' });
    const io = (all) => ({ listPrs: (n) => defaultListBuildPrs(n, { exec: ghWith(all) }), readCardStatus: () => 'open', readCardOpened: () => null });
    expect(readBuildDelivery('448', io([other]))).toBeNull();
    expect(readBuildDelivery('448', io([other, mine]))).toMatchObject({ outcome: 'pr-merged', pr: 11 });
  });
});
