import { describe, it, expect } from 'vitest';
import {
  containedCommit, findStackBases, resolveStackAwareReview, renderStackMarker,
  parseStackMarkers, decideStackDispatch, fingerprintOf,
} from '../review-stack-base.mjs';
import { renderJudgeInput, planRecordDecision } from '../../operations/review-pr.mjs';
import { checkStackBeforeReview, dispatchReviewByMode } from '../../operations/review-job.mjs';

// 2026-10-09 replay, with synthetic 40-hex object names. #4631 merged 704c02f
// through its SECOND parent; #4624 then advanced to dea2666 -> 704c02f -> f174798.
const TOP = '1'.repeat(40);
const BOTTOM = '2'.repeat(40);
const CONTAINED = '3'.repeat(40);
const OLDER = '4'.repeat(40);
const LEFT = '5'.repeat(40);
const RIGHT = '6'.repeat(40);
const STRAY = '7'.repeat(40); // 7fd6bba, shared by #4655 and #4686
const TREE = '8'.repeat(40);
const REPO = 'web-everything/web-everything';
const BASE = { pr: 4624, ref: 'lane/red-main-contain', head: BOTTOM, contained: CONTAINED };
const STACK = { ...BASE, tree: TREE, topHead: TOP };
const DIFF = 'diff --git a/own.mjs b/own.mjs\n--- a/own.mjs\n+++ b/own.mjs\n@@ -1 +1 @@\n-old\n+new\n';
const FINGERPRINT = fingerprintOf(DIFF);
const DIFFERENT = fingerprintOf(DIFF.replace('+new', '+changed'));
const marker = (over = {}) => ({ top: 4631, topHead: TOP, bottom: 4624,
  bottomRef: BASE.ref, bottomHead: BOTTOM, contained: CONTAINED, fingerprint: FINGERPRINT, ...over });
const comment = (over = {}) => ({ viewerDidAuthor: true, body: renderStackMarker(marker(over)) });
const sets = () => new Map([
  [BOTTOM, { reach: new Set([BOTTOM, CONTAINED, OLDER]), first: [BOTTOM, CONTAINED, OLDER] }],
  [TOP, { reach: new Set([TOP, CONTAINED, OLDER]), first: [TOP] }],
  [LEFT, { reach: new Set([LEFT, STRAY]), first: [LEFT, STRAY] }],
  [RIGHT, { reach: new Set([RIGHT, STRAY]), first: [RIGHT, STRAY] }],
]);
const rows = () => [
  { pr: 4624, headRefName: BASE.ref, headRefOid: BOTTOM },
  { pr: 4631, headRefName: 'lane/accept-carry-forward', headRefOid: TOP },
  { pr: 4655, headRefName: 'lane/left', headRefOid: LEFT },
  { pr: 4686, headRefName: 'lane/right', headRefOid: RIGHT },
];

describe('containedCommit — second-parent containment, not shared ancestry', () => {
  it('returns the bottom head when the top contains it directly', () => {
    const graph = sets();
    graph.set(TOP, { reach: new Set([TOP, BOTTOM, CONTAINED, OLDER]), first: [TOP, BOTTOM, CONTAINED, OLDER] });
    expect(containedCommit(graph, BOTTOM, TOP)).toBe(BOTTOM);
  });
  it('returns the newest merged bottom commit after the bottom moves (#4631/#4624)', () => {
    expect(containedCommit(sets(), BOTTOM, TOP)).toBe(CONTAINED);
  });
  it('does not order two PRs cut from the same stray first-parent ancestor (#4655/#4686)', () => {
    expect(containedCommit(sets(), LEFT, RIGHT)).toBeNull();
    expect(containedCommit(sets(), RIGHT, LEFT)).toBeNull();
  });
  it('ignores a bottom already on main even if the top contains its head', () => {
    const graph = sets();
    graph.set(CONTAINED, { reach: new Set(), first: [] });
    expect(containedCommit(graph, CONTAINED, TOP)).toBeNull();
  });
  it.each([[BOTTOM, 'f'.repeat(40)], ['f'.repeat(40), TOP]])('leaves an unknown head unknown (%s, %s)', (bottom, top) => {
    expect(containedCommit(sets(), bottom, top)).toBeUndefined();
  });
});

describe('findStackBases', () => {
  it('finds only #4631 over #4624 among all four trusted PRs', () => {
    expect(findStackBases(rows(), sets())).toEqual(new Map([[4631, BASE]]));
  });
  it('drops a bottom whose ref is not lane/*', () => {
    const prs = rows();
    prs[0].headRefName = 'feature/red-main-contain';
    expect(findStackBases(prs, sets())).toEqual(new Map());
  });
  it.each([4624, 4631])('does not form a new stack with untrusted PR #%i', (pr) => {
    expect(findStackBases(rows().map(r => ({ ...r, untrusted: r.pr === pr })), sets())).toEqual(new Map());
  });
});

describe('resolveStackAwareReview', () => {
  it('defaults on with empty settings', () => {
    expect(resolveStackAwareReview({}, { read: () => ({}) })).toBe(true);
  });
  it('honors file off', () => {
    expect(resolveStackAwareReview({}, { read: () => ({ stackAwareReview: { mode: 'off' } }) })).toBe(false);
  });
  it.each([['on', 'off', true], ['off', 'on', false]])('env %s overrides file %s', (env, file, expected) => {
    expect(resolveStackAwareReview({ WE_STACK_AWARE_REVIEW: env }, { read: () => ({ stackAwareReview: { mode: file } }) })).toBe(expected);
  });
  it('defaults on when the settings reader throws', () => {
    expect(resolveStackAwareReview({}, { read: () => { throw new Error('unreadable settings'); } })).toBe(true);
  });
});

describe('stack accept markers', () => {
  it('round-trips a trusted marker', () => {
    expect(parseStackMarkers([comment()])).toEqual([{ v: 1, verdict: 'accept', ...marker() }]);
  });
  it('ignores an untrusted author', () => {
    expect(parseStackMarkers([{ ...comment(), viewerDidAuthor: false, author: { login: 'random-user' } }])).toEqual([]);
  });
  it('ignores malformed JSON', () => {
    expect(parseStackMarkers([{ viewerDidAuthor: true, body: '<!-- reviewed-stack: {broken} -->' }])).toEqual([]);
  });
});

describe('decideStackDispatch', () => {
  const decide = (over = {}) => decideStackDispatch({ pr: 4631, stack: STACK, comments: [comment()], ...over });
  it('reviews when there is no marker', () => {
    expect(decide({ comments: [] })).toEqual({ action: 'review' });
  });
  it('holds an unchanged stacked accept until #4624 lands', () => {
    expect(decide({ stackFingerprint: FINGERPRINT })).toMatchObject({ action: 'held', why: expect.stringContaining('stacked-accept-held') });
    expect(decide({ stackFingerprint: FINGERPRINT }).why).toContain('#4624');
  });
  it('reviews a changed stack diff', () => {
    expect(decide({ stackFingerprint: DIFFERENT }).action).toBe('review');
  });
  it('carries an accept when the collapsed stack has the same main diff', () => {
    expect(decide({ stack: null, mainFingerprint: FINGERPRINT }).action).toBe('carry');
  });
  it('reviews when the collapsed stack has a different main diff', () => {
    expect(decide({ stack: null, mainFingerprint: DIFFERENT }).action).toBe('review');
  });
  it('ignores markers for another PR', () => {
    expect(decide({ comments: [comment({ top: 9999 })], stackFingerprint: FINGERPRINT, mainFingerprint: FINGERPRINT })).toEqual({ action: 'review' });
  });
});

describe('review-pr stack basis and recording', () => {
  const read = (stackBase = { ...STACK, fingerprint: FINGERPRINT }) => ({
    pr: 4631, repo: REPO, title: 'Accept carry-forward', body: 'Carry an accepted diff forward.',
    labels: ['review:pending'], netChangedFiles: ['own.mjs'], diffText: DIFF,
    netBasis: { base: TREE, rev: TOP, scored: true }, stackBase,
  });
  const view = (finding, answer = 'accept', findings = []) => ({
    input: { pr: 4631, repo: REPO, actor: 'test-reviewer' },
    findings: { read: finding, confirm: answer },
    verdict: { verdict: answer, findings, lenses: ['correctness'], lensVerdicts: { correctness: answer } },
  });
  it('tells the juror its diff is against #4624, not current main', () => {
    const input = renderJudgeInput(read());
    expect(input).toContain("Net diff vs #4624's head");
    expect(input).toContain('STACKED on #4624');
    expect(input).not.toContain('Net diff vs current main');
  });
  it('keeps the main basis wording for an unstacked PR', () => {
    expect(renderJudgeInput(read(null))).toContain('Net diff vs current main');
  });
  it('records a parseable stack hold for an accept on the reviewed head', () => {
    const finding = read();
    const plan = planRecordDecision(view(finding));
    expect(plan.stackHold).toBeDefined();
    expect(parseStackMarkers([{ viewerDidAuthor: true, body: plan.stackHold.marker }])).toEqual([
      { v: 1, verdict: 'accept', ...marker({ topHead: finding.netBasis.rev }) },
    ]);
  });
  it('does not hold an accept without a stack base', () => {
    expect(planRecordDecision(view(read(null))).stackHold).toBeUndefined();
  });
  it('does not hold changes with findings even on a stack', () => {
    const findings = [{ file: 'own.mjs', line: 1, category: 'correctness', severity: 'major', summary: 'The carry drops a reviewed change.' }];
    expect(planRecordDecision(view(read(), 'changes', findings)).stackHold).toBeUndefined();
  });
});

describe('checkStackBeforeReview', () => {
  // Every IO seam is injected. Call records also prove the skipped paths do no carry work.
  const probe = ({ base = STACK, comments = [], carryOk = true, ...over } = {}) => {
    const calls = { stack: [], thread: [], stackText: [], mainText: [], carry: [], log: [] };
    const out = checkStackBeforeReview({ pr: 4631, repo: REPO, env: { WE_STACK_AWARE_REVIEW: 'on' },
      readStack: n => { calls.stack.push(n); return base; },
      readThread: n => { calls.thread.push(n); return { comments, headRefName: 'lane/accept-carry-forward', headRefOid: TOP }; },
      stackText: b => { calls.stackText.push(b); return DIFF; },
      mainText: ref => { calls.mainText.push(ref); return { scored: true, text: DIFF }; },
      carry: (n, decision) => { calls.carry.push([n, decision]); return { ok: carryOk }; },
      log: line => calls.log.push(line), ...over,
    });
    return { out, calls };
  };
  it('returns and logs the stack base when no accept has been recorded', () => {
    const { out, calls } = probe();
    expect(out).toEqual({ base: STACK });
    expect(calls.log).toEqual([expect.stringMatching(/#4624.*lane\/red-main-contain/)]);
    expect(calls.stackText).toEqual([]);
    expect(calls.carry).toEqual([]);
  });
  it('skips an unchanged stacked accept without carrying it', () => {
    const { out, calls } = probe({ comments: [comment()] });
    expect(out.skipped).toContain('stacked-accept-held');
    expect(calls.stackText).toEqual([STACK]);
    expect(calls.carry).toEqual([]);
    expect(calls.mainText).toEqual([]);
  });
  it('carries exactly once after the stack collapses to the same main diff', () => {
    const { out, calls } = probe({ base: null, comments: [comment()] });
    expect(out.skipped).toContain('stack-accept-carried');
    expect(calls.mainText).toEqual(['lane/accept-carry-forward']);
    expect(calls.carry).toEqual([[4631, expect.objectContaining({ action: 'carry', marker: expect.objectContaining({ fingerprint: FINGERPRINT }) })]]);
  });
  it('continues to review when carrying the accept fails', () => {
    const { out, calls } = probe({ base: null, comments: [comment()], carryOk: false });
    expect(out).toEqual({ base: null });
    expect(calls.carry).toHaveLength(1);
  });
  it.each([
    ['disabled', { env: { WE_STACK_AWARE_REVIEW: 'off' } }],
    ['another repository', { repo: 'plateauapp/plateau-app' }],
  ])('does no reads when %s', (_name, opts) => {
    const { out, calls } = probe(opts);
    expect(out).toEqual({ base: null });
    expect(calls).toEqual({ stack: [], thread: [], stackText: [], mainText: [], carry: [], log: [] });
  });
  it('dispatchReviewByMode returns the injected skip before dispatching a job', () => {
    const calls = [];
    expect(dispatchReviewByMode({ mode: 'job', pr: 4631, repo: REPO, env: {},
      stackCheck: opts => { calls.push(opts); return { skipped: 'x' }; },
    })).toEqual({ mode: 'job', pr: 4631, repo: REPO, skipped: 'x' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pr: 4631, repo: REPO, env: {} });
  });
});
