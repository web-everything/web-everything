import { describe, expect, it } from 'vitest';
import { advisoryHeadMoveState, planReconcile } from '../reconcile-core.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { buildFixEndComment } from '../fix-procedure.mjs';

import { buildReviewedShaMarker, buildClearedHumanMarker } from '../../lib/review-escalation.mjs';

const OLD = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const author = { login: 'web-everything' };
const advisory = (head = OLD, body = `Net basis: \`${'c'.repeat(40)}..${head}\` — 1 net changed file(s) vs current main`) => ({
  author, createdAt: '2026-11-20T10:00:00Z', body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** accept\n\nLooks fine.\n\n---\n\n${body}` });
const own = (oid, extra = {}) => ({ oid, messageHeadline: 'fix: the thing', messageBody: '', authors: [{ login: 'chalbert' }], ...extra });
const mainMerge = oid => own(oid, { messageHeadline: "Merge branch 'main' into lane/x" });
const pr = (extra = {}) => ({ number: 7230, state: 'OPEN', headRefName: 'lane/x', headRefOid: HEAD,
  labels: ['review:human'], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
  commits: [own(OLD), mainMerge(HEAD)], comments: [advisory()], ...extra });
const run = (extra = {}, options = {}) => planReconcile({
  prs: [{ ...pr(extra), labels: pr(extra).labels.map(name => ({ name })) }], agents: [],
  requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' }, now: Date.parse('2026-11-20T12:00:00Z'),
  advisoryReviewOnHumanHandoff: 'on', ...options });
const reviews = result => result.dispatch.filter(d => d.kind === 'review' && d.advisoryReview?.reason === 'head-moved-advisory');
const unreadable = () => advisory(OLD, 'no basis recorded');
const verdict = () => ({ author, createdAt: '2026-11-20T11:00:00Z', body: `✅ review — accepted\n${buildReviewedShaMarker(HEAD)}` });
const clearance = () => ({ ...verdict(), body: `${verdict().body}\n${buildClearedHumanMarker('chalbert')}` });
const sendBack = () => ({ id: 'op-send-back', author: { login: 'chalbert' }, createdAt: '2026-11-20T11:30:00Z',
  body: `🔁 review — changes requested\n\nRecorded by chalbert via console.\n\nAt head \`${HEAD}\`: fix the export.` });
const red = [{ name: 'gate', status: 'completed', conclusion: 'failure' }];

describe('review:human advisory re-run on a moved head', () => {
  it.each(['off', undefined])('unreadable advisory with setting %s and green CI still gets the ordinary review', setting => {
    const result = run({ comments: [unreadable()] }, { advisoryReviewOnHumanHandoff: setting });
    expect(result.dispatch.map(({ kind, headRefOid, advisoryReview }) => ({ kind, headRefOid, advisoryReview })))
      .toEqual([{ kind: 'review', headRefOid: HEAD, advisoryReview: undefined }]);
    expect(result.refusals).toEqual([]);
  });
  it.each(['off', undefined])('readable moved-head advisory preserves ordinary review with setting %s', setting => {
    const result = run({}, { advisoryReviewOnHumanHandoff: setting });
    expect(result.dispatch.map(({ kind, headRefOid, advisoryReview }) => ({ kind, headRefOid, advisoryReview })))
      .toEqual([{ kind: 'review', headRefOid: HEAD, advisoryReview: undefined }]);
    expect(result.refusals).toEqual([]);
  });
  it.each(['on', 'off', undefined])('unreadable history skips fix-pushed review only with reruns enabled (setting %s)', setting => {
    // The advisory lacks its Net basis, but its reviewed-sha still lets the release path identify the old head.
    // A completely headless note would make latestHeadReview null and never exercise the added guard.
    const comments = [{ ...unreadable(), body: `${unreadable().body}\n${buildReviewedShaMarker(OLD)}` },
      { author, createdAt: '2026-11-20T11:00:00Z', body: buildFixEndComment({ who: 'fix-session', headSha: HEAD }) }];
    expect(advisoryHeadMoveState(pr({ comments }))).toEqual({ owed: false, unreadable: true });
    const result = run({ comments }, { advisoryReviewOnHumanHandoff: setting });
    if (setting === 'on') {
      expect(result.dispatch).toEqual([]);
      expect(result.refusals.map(r => r.kind)).toEqual(['advisory-unreadable']);
    } else {
      expect(result.dispatch.map(({ kind, headRefOid, advisoryReview }) => ({ kind, headRefOid,
        advisoryReview: { head: advisoryReview?.head, reason: advisoryReview?.reason } })))
        .toEqual([{ kind: 'review', headRefOid: HEAD, advisoryReview: { head: HEAD, reason: 'fix-pushed' } }]);
      expect(result.refusals).toEqual([]);
    }
  });
  it.each([
    ['newest-first Git reader', [mainMerge(HEAD), own(OLD)]],
    ['oldest-first API reader', [own(OLD), mainMerge(HEAD)]],
    ['live head in the middle', [own(OLD), mainMerge(HEAD), own('c'.repeat(40))]],
  ])('finds the mechanical live head with %s commit ordering', (_name, commits) => {
    expect(reviews(run({ commits }, { roundCap: 0 }))).toEqual([
      expect.objectContaining({ advisoryReview: { head: HEAD, reason: 'head-moved-advisory' } }),
    ]);
  });
  it.each([
    ['absent live head', [mainMerge(OLD)]],
    ['authored live head before older mechanical commit', [own(HEAD), mainMerge(OLD)]],
  ])('does not infer a mechanical head from %s', (_name, commits) => {
    expect(advisoryHeadMoveState(pr({ commits }))).toEqual({ owed: false });
    expect(reviews(run({ commits }))).toEqual([]);
  });
  it.each(['on', 'off'])('unreadable advisory preserves missing-required-job rebase repair when advisory reruns are %s', setting => {
    const result = run({ comments: [unreadable()] }, {
      requiredChecks: ['gate', 'new-job'], advisoryReviewOnHumanHandoff: setting,
    });
    expect(result.dispatch).toEqual([
      expect.objectContaining({ kind: 'fix', mode: 'stale-base-rebase' }),
    ]);
    expect(result.dispatch.some(row => row.kind === 'review')).toBe(false);
    expect(result.refusals.some(row => row.kind === 'advisory-unreadable')).toBe(false);
  });
  it('unreadable advisory preserves ci-heal for completed red required CI', () => {
    const result = run({ comments: [advisory(OLD, 'no basis recorded')],
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }] });
    expect(result.dispatch.map(d => d.kind)).toContain('ci-heal');
    expect(reviews(result)).toHaveLength(0);
  });
  it('current-head verdict suppresses unreadable advisory refusal', () => {
    const covered = { author, createdAt: '2026-11-20T11:00:00Z', body: `✅ review — accepted\n${buildReviewedShaMarker(HEAD)}` };
    expect(advisoryHeadMoveState(pr({ comments: [advisory(OLD, 'no basis recorded'), covered] })))
      .toEqual({ owed: false });
  });
  it('operator setting off suppresses head-moved advisory', () => {
    expect(reviews(run({}, { advisoryReviewOnHumanHandoff: 'off' }))).toHaveLength(0);
  });
  it('the planner default suppresses head-moved advisory', () => {
    expect(reviews(run({}, { advisoryReviewOnHumanHandoff: undefined }))).toHaveLength(0);
  });
  it.each([
    ['update-branch', { messageHeadline: "Merge remote-tracking branch 'origin/main' into lane/x" }],
    ['Merge pull request', { messageHeadline: 'Merge pull request #123 from org/main' }],
    ['drain bookkeeping', { messageHeadline: 'drain: resolve #123 on land (#2748)' }],
    ['generic conveyor trailer', { messageBody: 'Conveyor-Mechanical-Refresh: old-head' }],
  ])('%s owes exactly one advisory on the live 40-hex head', (_name, tip) => {
    expect(run({ commits: [own(OLD), own(HEAD, tip)] }).dispatch).toEqual([
      expect.objectContaining({ kind: 'review', headRefOid: HEAD,
        advisoryReview: { head: HEAD, reason: 'head-moved-advisory' } }),
    ]);
  });
  it.each(['short', 'z'.repeat(40), 'b'.repeat(39)])('invalid live head %s suppresses head-moved dispatch', headRefOid => {
    expect(reviews(run({ headRefOid, commits: [mainMerge(headRefOid)] }))).toHaveLength(0);
  });
  it('a mechanical commit that is not the live tip suppresses dispatch', () => {
    expect(reviews(run({ commits: [mainMerge(OLD)] }))).toHaveLength(0);
  });
  it('current-head verdict alone suppresses head-moved dispatch', () => {
    expect(reviews(run({ comments: [advisory(), verdict()] }))).toHaveLength(0);
  });
  it('a newer unpinned advisory blocks dispatch despite a readable old advisory', () => {
    const result = run({ comments: [advisory(), { ...unreadable(), createdAt: '2026-11-20T11:00:00Z' }] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals.map(r => r.kind)).toEqual(['advisory-unreadable']);
  });
  it.each([
    ['unreadable', [unreadable()]], ['readable stale', [advisory()]], ['absent', []],
  ])('%s advisory preserves red CI repair and red CI operator send-back', (_name, comments) => {
    expect(run({ comments, statusCheckRollup: red }).dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal' })]);
    expect(run({ comments: [...comments, sendBack()], statusCheckRollup: red }).dispatch).toEqual([
      expect.objectContaining({ kind: 'fix', mode: 'operator-send-back' }),
    ]);
  });
  it('a current-head advisory followed by unreadable history preserves operator send-back', () => {
    expect(run({ comments: [advisory(HEAD), unreadable(), sendBack()] }).dispatch).toEqual([
      expect.objectContaining({ kind: 'fix', mode: 'operator-send-back' }),
    ]);
  });
  it.each([
    ['advisory', () => advisory(HEAD)], ['verdict', verdict],
  ])('a current-head %s preserves operator send-back despite unrelated history without timestamps', (_name, review) => {
    const comments = [review(), { ...unreadable(), createdAt: undefined },
      { ...advisory(OLD), createdAt: undefined }, sendBack()];
    expect(run({ comments }).dispatch).toEqual([
      expect.objectContaining({ kind: 'fix', mode: 'operator-send-back' }),
    ]);
  });
  it.each([undefined, 'unreadable'])('a current-head review with time %s still blocks operator send-back', createdAt => {
    const comments = [advisory(HEAD), { ...advisory(HEAD), createdAt }, sendBack()];
    expect(run({ comments }).dispatch.map(d => d.mode)).not.toContain('operator-send-back');
  });
  it.each([
    ['draft', { isDraft: true }, ['promote-draft']],
    ['pending draft', { isDraft: true, statusCheckRollup: [{ name: 'gate', status: 'in_progress' }] }, []],
    ['pending CI', { statusCheckRollup: [{ name: 'gate', status: 'in_progress' }] }, []],
    ['referral hold', { referralHold: { head: HEAD, episode: 'e', count: 2, why: 'needs a ruling' } }, []],
    ['scope-bloat repair rollback', { scopeBloat: { stale: false, why: 'unrelated changes' } }, ['fix']],
  ])('head-moved advisory preserves %s gate without duplicate refusals or speculative rows', (_name, extra, kinds) => {
    const result = run(extra);
    const normal = run({ ...extra, commits: [own(OLD), own(HEAD)] });
    expect(result.dispatch.map(d => d.kind)).toEqual(kinds);
    expect(result.dispatch).toEqual(normal.dispatch);
    expect(result.refusals).toEqual(normal.refusals);
    expect(result.refusals.some(r => r.headMovedAdvisory)).toBe(false);
  });
  it('unreadable advisory preserves block-ruled referral repair', () => {
    expect(run({ comments: [unreadable()], blockRuledReferrals: [{ key: 'must-fix' }] }).dispatch)
      .toEqual([expect.objectContaining({ kind: 'fix', mode: 'block-ruled-referral' })]);
  });
  it('unreadable advisory preserves review-hold-red ownership', () => {
    const result = run({ comments: [unreadable()],
      statusCheckRollup: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }] },
    { requiredChecks: ['review-gate'] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals.map(r => r.kind)).toEqual(['review-hold-red']);
  });
  it('unreadable advisory preserves ignored-ruling escalation', () => {
    const result = run({ comments: [unreadable()], ignoredRulings: { head: HEAD, misses: 100,
      effectiveMisses: 100, matches: [{ finding: { file: 'scripts/example.mjs' } }] } });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals.map(r => r.kind)).toEqual(['ruling-dispute']);
  });
  it('an in-flight review prevents a second advisory', () => {
    const result = run({}, { agents: [{ name: 'review-7230', sessionId: 'review-session', pid: 123,
      pidAlive: true, laneHeadOid: HEAD, cwd: '/dispatch/review-7230' }] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toHaveLength(1);
  });
  it('advisory:changes excludes the head-moved advisory path', () => {
    expect(reviews(run({ labels: ['review:human', 'advisory:changes'] }))).toHaveLength(0);
  });
  it.each(['red-team:pending', 'red-team:blocked'])('head-moved advisory bypasses repair cap and %s seat, and never accepts review:human', label => {
    const result = run({ labels: ['review:human', label] }, { roundCap: 0 });
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review',
      advisoryReview: { head: HEAD, reason: 'head-moved-advisory' },
      why: expect.stringContaining('it never accepts a review:human PR') })]);
  });
  it('review:human head moved by main merge owes one advisory on the live head', () => {
    const rows = reviews(run());
    expect(rows).toHaveLength(1);
    expect(rows[0].advisoryReview).toMatchObject({ head: HEAD, reason: 'head-moved-advisory' });
  });
  it('a conveyor recovery commit also owes one advisory on the live head', () => {
    const rec = own(HEAD, { messageHeadline: 'ci: recover missing PR checks', messageBody: `Conveyor-Missing-Run-Recovery: ${OLD}` });
    expect(reviews(run({ commits: [own(OLD), rec] }))).toHaveLength(1);
  });
  it('the advisory already covers the head: no row', () => {
    expect(reviews(run({ comments: [advisory(HEAD)] }))).toHaveLength(0);
  });
  it('a human clearance on the exact head: no row', () => {
    const clearance = { author, createdAt: '2026-11-20T11:00:00Z',
      body: `✅ review — \`review:human\` cleared via the sanctioned path\n\nCleared by chalbert via \`review-set-label.mjs --to=clear-human\`\n\n${buildReviewedShaMarker(HEAD)}\n${buildClearedHumanMarker('chalbert')}` };
    expect(reviews(run({ comments: [advisory(), clearance] }))).toHaveLength(0);
  });
  it('a non-merge author commit takes the normal path, not the head-moved advisory', () => {
    expect(reviews(run({ commits: [own(OLD), own(HEAD)] }))).toHaveLength(0);
  });
  it('an unreadable advisory dispatches nothing', () => {
    const result = run({ comments: [{ author, createdAt: '2026-11-20T10:00:00Z', body: `${ADVISORY_NOTE_MARKER}\n\nno basis recorded` }] });
    expect(result.dispatch).toHaveLength(0);
    expect(result.refusals.map(r => r.kind)).toEqual(['advisory-unreadable']);
  });
  it('unreadable advisory on an author commit does not produce advisory-unreadable refusal', () => {
    expect(run({ comments: [unreadable()], commits: [own(OLD), own(HEAD)] }).refusals
      .some(r => r.kind === 'advisory-unreadable')).toBe(false);
  });
  it('no advisory at all: no head-moved row', () => {
    expect(reviews(run({ comments: [] }))).toHaveLength(0);
  });
});

describe('advisoryHeadMoveState coverage contract', () => {
  const histories = [['readable', [advisory()]], ['unreadable', [unreadable()]], ['absent', []]];
  const coverage = [['verdict covers', verdict], ['human-cleared', clearance], ['none', () => null]];
  const cases = histories.flatMap(([history, comments]) => coverage.flatMap(([cover, marker]) =>
    [true, false].map(mechanical => ({ history, comments, cover, marker, mechanical }))));
  it.each(cases)('$history advisory / $cover / mechanical=$mechanical', ({ history, comments, cover, marker, mechanical }) => {
    const state = advisoryHeadMoveState(pr({ comments: [...comments, marker()].filter(Boolean),
      commits: [own(OLD), mechanical ? mainMerge(HEAD) : own(HEAD)] }));
    expect(Boolean(state.owed)).toBe(history === 'readable' && cover === 'none' && mechanical);
    expect(Boolean(state.unreadable)).toBe(history === 'unreadable' && cover === 'none' && mechanical);
  });
});
