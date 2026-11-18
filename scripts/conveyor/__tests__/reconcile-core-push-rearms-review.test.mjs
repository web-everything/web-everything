import { describe, expect, it } from 'vitest';
import { planReconcile, countFindings } from '../reconcile-core.mjs';
import { buildFixEndComment } from '../fix-procedure.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { buildReviewedShaMarker, REVIEW_PR_CHANNEL } from '../../lib/review-escalation.mjs';
import { REVIEW_PR_FOOTER } from '../mechanical-round-cap.mjs';
import { openOperatorSendBacks } from '../../lib/operator-send-backs.mjs';

const OLD = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const author = { login: 'web-everything' };
const REVIEW_AT = '2026-11-05T10:00:00Z', SEND_AT = '2026-11-05T11:00:00Z';
const END_AT = '2026-11-05T11:21:00Z';
const advisory = (head = OLD, extra = {}) => ({ author, createdAt: REVIEW_AT,
  body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** changes\n\nRequired repair.\n\n---\n\nNet basis: \`${'c'.repeat(40)}..${head}\` — 1 net changed file(s) vs current main`, ...extra });
const end = (extra = {}) => ({ author, createdAt: END_AT,
  body: buildFixEndComment({ who: 'fix-session', headSha: HEAD }), ...extra });
const sendBack = (extra = {}) => ({ id: 'send-back', author: { login: 'chalbert' }, createdAt: SEND_AT,
  body: `🔁 review — changes requested\n\nRecorded by chalbert via console.\n\nAt head \`${HEAD}\`: fix the export.`, ...extra });
const pr = (extra = {}) => ({ number: 6360, state: 'OPEN', headRefName: 'lane/r618', headRefOid: HEAD,
  labels: ['review:human', 'advisory:changes'], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
  comments: [advisory(), end()], ...extra });
const run = (extra = {}, agents = [], options = {}) => planReconcile({
  prs: [{ ...pr(extra), labels: pr(extra).labels.map(name => ({ name })) }], agents,
  requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' }, now: Date.parse('2026-11-05T12:00:00Z'), ...options });
const held = comments => ({ comments, labels: ['review:human'],
  referralHold: { kind: 'same-head', head: HEAD, why: 'findings ruled' },
  referralHoldAutoResolve: { outcome: 'resume', head: HEAD, why: 'all ruled' } });

describe('live send-back on the current head owes its first fixer', () => {
  const fresh = extra => ({ comments: [sendBack()], labels: ['review:changes'], ...extra });
  it.each([
    ['disabled CI-heal budget', {}, { ciHealCap: 0 }, 'cap-exhausted'],
    ['disabled CI-heal budget with a directed round at the review cap', {}, { ciHealCap: 0, durableCounts: { 6360: 5 } }, 'cap-exhausted'],
    ['unreadable timeout evidence', { timeoutRetry: { eligible: false, unknown: true, reason: 'read failed' } }, {}, 'timeout-evidence-unknown'],
    ['unresolved rerun reservation', { timeoutRetryBudget: { pending: true, reason: 'reservation unreadable' } }, {}, 'ci-heal-escalated'],
    ['live rerun reservation', { timeoutRetryBudget: { pending: true, pendingSince: '2026-11-05T11:59:59Z' } }, {}, 'ci-timeout-rerun-in-flight'],
  ])('initial send-back preserves the %s refusal', (_name, extra, options, refusal) => {
    const result = run(fresh({ statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }], ...extra }), [], options);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: refusal }));
  });
  it.each([
    ['review:changes'],
    ['review:changes', 'red-team:blocked', 'status:sent-back-red-team'],
    ['review:changes', 'review:accepted', 'status:sent-back-review'],
  ])('counts authenticated operator repair prose as a finding with labels %j', (...labels) => {
    expect(countFindings([sendBack()])).toBe(1);
    const result = run(fresh({ labels }));
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix', phase: 'bounced',
      findings: 1, attempts: 0 })]);
    expect(result.dispatch[0].mode).toBeUndefined(); // Ordinary bounced route, after all ownership guards.
    expect(result.refusals).toEqual([]);
  });
  it.each([
    [0, 'cap-exhausted'],
    [2, null],
  ])('a queued send-back preserves CodeQL healing ownership with cap=%s', (ciHealCap, refusal) => {
    const result = run(fresh({ labels: ['review:accepted'], codeqlFailure: { alerts: [] } }), [], { ciHealCap });
    if (refusal) {
      expect(result.dispatch).toEqual([]);
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: refusal, cap: 0 }));
    } else {
      expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', reason: 'codeql' })]);
    }
  });
  it.each([
    { labels: ['review:accepted'], kind: null },
    { labels: [], kind: 'restore-review-label' },
  ])('a same-head request retains its ordinary owner outside bounced: %j', ({ labels, kind }) => {
    const result = run(fresh({ labels }));
    if (kind) {
      expect(result.dispatch).toEqual([expect.objectContaining({ kind, label: 'review:pending' })]);
      expect(result.refusals).toEqual([]);
    } else {
      expect(result.dispatch).toEqual([]);
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'nothing-owed' }));
    }
  });
  it.each([
    ['empty', ''],
    ['whitespace', '   \n\t'],
    ['head metadata only', `At head \`${HEAD}\`.`],
    ['hidden prose', `At head \`${HEAD}\`.\n\n<!-- Repair the export. -->`],
    ['quoted example only', `At head \`${HEAD}\`.\n\n> Repair the export.`],
    ['unparseable', null],
  ])('refuses an operator send-back with %s repair prose', (_name, prose) => {
    const request = sendBack({ body: prose === null ? null
      : `🔁 review — changes requested\n\nRecorded by chalbert via console.\n\n${prose}` });
    expect(countFindings([request])).toBe(0);
    const result = run(fresh({ comments: [request] }));
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'no-findings', findings: 0 }));
  });
  it.each([
    [true, 'card-batch-extract'],
    [false, 'fix'],
  ])('initial send-back preserves card-batch routing when extraction=%s', (cardBatchExtract, kind) => {
    const result = run(fresh({ headRefName: 'lane/card-batch-6360' }), [], { cardBatchExtract });
    expect(result.dispatch).toEqual([expect.objectContaining({ kind, findings: 1 })]);
    expect(result.refusals).toEqual([]);
  });
  it('a previously queued head becomes owed when the send-back and changes label arrive', () => {
    expect(run({ comments: [], labels: ['review:accepted'] }).refusals[0]?.kind).toBe('nothing-owed');
    expect(run(fresh({ labels: ['review:changes', 'review:accepted'] })).dispatch[0]?.kind).toBe('fix');
  });
  it.each([
    ['review:changes', 'red-team:blocked', 'status:sent-back-red-team'],
    ['review:changes', 'review:accepted'],
  ])('ordinary judge bounce dispatches through OWED with labels %j', (...labels) => {
    const request = sendBack({ author, body: sendBack().body.replace('Recorded by chalbert', 'Recorded by round-judge') });
    expect(run(fresh({ labels, comments: [request] })).dispatch).toEqual([
      expect.objectContaining({ kind: 'fix', phase: 'bounced' }),
    ]);
  });
  it('does not dispatch while the fixer holds a claim', () => {
    const result = run(fresh({ fixClaim: { who: 'fix-6360' } }));
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0]?.kind).toBe('fix-claimed');
  });
  it('a completed repair with explicit send-back coverage owes no second fixer', () => {
    const request = sendBack({ body: sendBack().body.replace(HEAD, OLD) });
    const release = end({ body: `${end().body}\n\n<!-- addresses-operator-send-back: send-back -->` });
    const comments = [advisory(), request, release];
    // Completed repairs retain the stale advisory labels; fresh() instead models an explicit
    // review:changes bounce, which already selected the operator re-arm before includeUnattempted.
    expect(openOperatorSendBacks(pr({ comments }))).toEqual([]);
    const result = run({ comments });
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review', headRefOid: HEAD })]);
  });
  it('preserves cap refusal when the operator allowance is disabled', () => {
    // The existing operator ceremony grants a minimum budget of two; exhaust that effective cap.
    const result = run(fresh(), [], { roundCap: 1, durableCounts: { 6360: 2 },
      operatorRulingExtraRounds: { value: 0, source: 'tool' } });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0]).toMatchObject({ kind: 'cap-exhausted', attempts: 2, cap: 2 });
  });
  it('a trusted rearm consumes the first repair instead of re-dispatching every pass', () => {
    const result = run(fresh({ comments: [sendBack(), { author, createdAt: END_AT, body: REARM_COMMENT_MARKER }] }));
    expect(result.dispatch.filter(d => d.mode === 'ruling-not-addressed')).toEqual([]);
  });
  it('keeps the rebase ownership refusal for an unbounced conflicted PR', () => {
    const result = run(fresh({ labels: ['review:accepted'], mergeStateStatus: 'DIRTY' }));
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0]?.kind).toBe('owed-elsewhere');
  });
});

describe('R618 pushed fix owes its review', () => {
  it('reviews a new fixer head despite the stale advisory:changes label', () => {
    expect(run().dispatch).toEqual([expect.objectContaining({ kind: 'review', headRefOid: HEAD })]);
  });
  it('reviews a bounced new fixer head rather than fixing the old findings again', () => {
    expect(run({ labels: ['review:changes'] }).dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
  });
  it.each([
    { labels: ['review:changes', 'merge-status:conflicting'], mergeStateStatus: 'CLEAN' },
    { labels: ['review:changes'], mergeStateStatus: 'DIRTY' },
    { labels: ['review:changes', 'merge-status:conflicting'], mergeStateStatus: 'DIRTY' },
  ])('a fix-end preserves conflict-repair priority with green CI: %j', conflict => {
    const before = run({ ...conflict, comments: [advisory(OLD)] });
    const after = run({ ...conflict, comments: [advisory(OLD), end()] });
    const routes = result => result.dispatch.map(({ kind, mode, isConflict, cap }) => ({ kind, mode, isConflict, cap }));
    expect(before.dispatch).toEqual([expect.objectContaining({ kind: 'fix' })]);
    if (conflict.labels.includes('merge-status:conflicting')) expect(before.dispatch[0].isConflict).toBe(true);
    expect(routes(after)).toEqual(routes(before));
    expect(after.dispatch.map(d => d.kind)).not.toContain('review');
  });
  it('recognizes the last full review verdict basis, not only advisory and accept markers', () => {
    const verdict = { author, createdAt: REVIEW_AT,
      body: `🔁 review — changes requested\n\nRecorded by agent via ${REVIEW_PR_CHANNEL}.\n\nRepair the export.\n\n---\n\nNet basis: \`${'c'.repeat(40)}..${OLD}\` — 1 net changed file(s) vs current main\n\n${REVIEW_PR_FOOTER}` };
    expect(run({ labels: ['review:changes'], comments: [verdict, end()] }).dispatch[0]?.kind).toBe('review');
  });
  it('reviews a new head after a reviewed-sha verdict, even past the repair cap', () => {
    const verdict = { author, createdAt: REVIEW_AT, body: buildReviewedShaMarker(OLD) };
    expect(run({ comments: [verdict, end()] }, [], { durableCounts: { 6360: 8 } }).dispatch[0]?.kind).toBe('review');
  });
  it('does not queue a duplicate while a review is running on this head', () => {
    const agents = [{ name: 'review-6360', sessionId: 'review-session', pid: 123, pidAlive: true,
      laneHeadOid: HEAD, startedAt: Date.parse(END_AT), cwd: '/dispatch/review-6360' }];
    const result = run({}, agents);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals.map(r => r.kind)).toContain('live-process');
  });
  it('ignores only the released fixer session, allowing the owed review', () => {
    expect(run({}, [{ sessionId: 'fix-session', pid: 124, pidAlive: true, laneHeadOid: HEAD,
      startedAt: Date.parse(REVIEW_AT), cwd: '/dispatch/fix-6360' }]).dispatch[0]?.kind).toBe('review');
  });
  // A fix-end must not shadow the stale-base repair: a clean PR whose base predates a newly required job can only
  // be unblocked by the rebase, so the owed-review branch yields to it instead of refusing on the missing job.
  it.each([['review:pending', 'needs-review'], ['review:human', 'needs-human']])(
    'a pushed repair on a stale base (%s) routes to the stale-base rebase, not a review-ci refusal', (label, phase) => {
      const verdict = { author, createdAt: REVIEW_AT, body: buildReviewedShaMarker(OLD) };
      const result = run({ labels: [label], comments: [verdict, end()] }, [],
        { requiredChecks: ['gate', 'new-required-job'], defaultBranch: 'main' });
      expect(result.dispatch).toMatchObject([{ phase, kind: 'fix', isConflict: true, mode: 'stale-base-rebase',
        staleBase: { missing: ['new-required-job'], defaultBranch: 'main' } }]);
      expect(result.dispatch.map(d => d.kind)).not.toContain('review');
      expect(result.refusals).toEqual([]);
    });
  it('does not re-arm when the reviewed head is unchanged', () => {
    expect(run({ comments: [advisory(HEAD), end()] }).dispatch.map(d => d.kind)).not.toContain('review');
  });
  it('never rearms a covered current head when a skewed old-head review sorts later', () => {
    const comments = [advisory(HEAD), advisory(OLD, { createdAt: SEND_AT }), end()];
    expect(run({ comments }).dispatch.map(d => d.kind)).not.toContain('review');
  });
  it.each(['2026-11-05T09:00:00Z', REVIEW_AT])('keeps the old fix path for inconsistent or tied cross-head review time %s', createdAt => {
    const comments = [advisory(OLD), advisory('d'.repeat(40), { createdAt }), end()];
    expect(run({ comments }).dispatch[0]?.mode).toBe('advisory-fix');
  });
  it('keeps an active fix claim authoritative', () => {
    expect(run({ fixClaim: { who: 'new-fixer' } }).refusals[0]?.kind).toBe('fix-claimed');
  });
  it('never bypasses genuinely red CI', () => {
    const result = run({ statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }] });
    expect(result.dispatch.map(d => d.kind)).not.toContain('review');
    expect(result.dispatch[0]?.kind).toBe('ci-heal');
  });
  it('keeps the CI refusal while the pushed head is still being checked', () => {
    const result = run({ statusCheckRollup: [{ name: 'gate', status: 'in_progress', conclusion: null }] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0]?.kind).toBe('review-ci');
  });
  it.each([undefined, 'unreadable'])('keeps the old fix path when fix-end time is %s', createdAt => {
    expect(run({ comments: [advisory(), end({ createdAt })] }).dispatch[0]?.mode).toBe('advisory-fix');
  });
  it('keeps the old fix path when the review timestamp is NaN', () => {
    expect(run({ comments: [advisory(OLD, { createdAt: 'NaN' }), end()] }).dispatch[0]?.mode).toBe('advisory-fix');
  });
  it('an older trusted unpinned review blocks rearming after a newer pinned review and fix release', () => {
    const unpinned = { author, createdAt: '2026-11-05T09:00:00Z',
      body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** changes\n\nReview basis unavailable.` };
    const result = run({ comments: [unpinned, advisory(OLD), end()] });
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'advisory-fix' })]);
    expect(result.dispatch.map(d => d.kind)).not.toContain('review');
  });
  it('an untrusted fix-end grants no re-arm', () => {
    expect(run({ comments: [advisory(), end({ author: { login: 'outsider' } })] }).dispatch[0]?.mode).toBe('advisory-fix');
  });
  it('does not treat a release preceding the last advisory as a new repair', () => {
    expect(run({ comments: [end({ createdAt: '2026-11-05T09:00:00Z' }), advisory()] })
      .dispatch[0]?.mode).toBe('advisory-fix');
  });
  it.each([
    `> at \`${HEAD.slice(0, 9)}\``,
    `\`\`\`text\nat \`${HEAD.slice(0, 9)}\`\n\`\`\``,
  ])('a headless release with a quoted current head cannot authorize review: %s', quoted => {
    const body = `${buildFixEndComment({ who: 'fix-session' })}\n\n${quoted}`;
    const result = run({ comments: [advisory(OLD), end({ body })] });
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'advisory-fix' })]);
  });
  it('a fix-end before the review in thread order cannot rearm it even when its timestamp is later', () => {
    // Keep bookkeeping between them so only original thread indexes establish the order.
    const comments = [end(), { body: 'thread bookkeeping' }, advisory(OLD)];
    const result = run({ comments });
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'advisory-fix' })]);
  });
  it('a release after the review in thread order still rearms across unrelated comments', () => {
    const comments = [{ body: 'earlier discussion' }, advisory(OLD), { body: 'thread bookkeeping' }, end()];
    expect(run({ comments }).dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
  });
  // One named case per cited incident (#6360, #6378, #6346). These are MODELS of the thread shapes the review raised
  // (plain advisory + fix-end; short-SHA review basis; full verdict with no review:human), not recorded replays of the
  // live threads. A live thread with a different shape is not defended by these tests.
  describe('incident shapes', () => {
    it('#6360: advisory:changes + review:human, fix-end on a new head, owes a review', () => {
      expect(run().dispatch).toEqual([expect.objectContaining({ kind: 'review', headRefOid: HEAD })]);
    });
    it('#6378: a short-SHA review basis and a fix-end on a new head still owe a review', () => {
      const short = OLD.slice(0, 9);
      expect(run({ comments: [advisory(short), end()] }).dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
    });
    it('#6346: a bounced head whose full verdict has no review:human label owes a review after the fix-end', () => {
      const verdict = { author, createdAt: REVIEW_AT,
        body: `🔁 review — changes requested\n\nRecorded by agent via ${REVIEW_PR_CHANNEL}.\n\nRepair the export.\n\n---\n\nNet basis: \`${'c'.repeat(40)}..${OLD}\` — 1 net changed file(s) vs current main\n\n${REVIEW_PR_FOOTER}` };
      expect(run({ labels: ['review:changes'], comments: [verdict, end()] }).dispatch[0]?.kind).toBe('review');
    });
  });
});

describe('R618 same-head operator send-back supersedes a finished advisory', () => {
  it('dispatches the newer operator request as a fix despite an auto-resumed referral hold', () => {
    expect(run(held([advisory(HEAD), sendBack()])).dispatch).toEqual([
      expect.objectContaining({ kind: 'fix', mode: 'operator-send-back' }),
    ]);
  });
  it('a send-back preceding the current-head review in thread order grants nothing despite its later time', () => {
    const comments = [sendBack(), { body: 'thread bookkeeping' }, advisory(HEAD)];
    const result = run(held(comments));
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0]?.kind).toBe('already-reviewed-head');
  });
  it('a clock-skewed later same-head review cannot be hidden behind an earlier review timestamp', () => {
    const comments = [advisory(HEAD, { createdAt: '2026-11-05T10:30:00Z' }), sendBack(), advisory(HEAD)];
    const result = run(held(comments));
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0]?.kind).toBe('already-reviewed-head');
  });
  it.each(['rearm', 'advisory'])('a trusted %s marker after a send-back consumes its one-shot repair', kind => {
    const marker = kind === 'rearm'
      ? { author, createdAt: END_AT, body: REARM_COMMENT_MARKER }
      : advisory(OLD, { createdAt: END_AT });
    const result = run(held([advisory(HEAD), sendBack(), marker]));
    expect(result.dispatch).toEqual([]);
    expect(result.dispatch.map(d => d.mode)).not.toContain('operator-send-back');
  });
  it('a forged rearm marker cannot consume the operator send-back', () => {
    const marker = { author: { login: 'outsider' }, createdAt: END_AT, body: REARM_COMMENT_MARKER };
    expect(run(held([advisory(HEAD), sendBack(), marker])).dispatch).toEqual([
      expect.objectContaining({ kind: 'fix', mode: 'operator-send-back' }),
    ]);
  });
  it('compares a send-back only with current-head reviews despite a future-dated old-head review', () => {
    const comments = [advisory(OLD, { createdAt: END_AT }), advisory(HEAD), sendBack()];
    expect(run(held(comments)).dispatch).toEqual([
      expect.objectContaining({ kind: 'fix', mode: 'operator-send-back' }),
    ]);
  });
  it('uses the latest current-head review rather than an earlier one for a send-back', () => {
    const comments = [advisory(HEAD), sendBack(), advisory(HEAD, { createdAt: END_AT }),
      advisory(OLD, { createdAt: REVIEW_AT })];
    expect(run(held(comments)).dispatch.map(d => d.mode)).not.toContain('operator-send-back');
  });
  it('an older send-back leaves already-reviewed-head intact', () => {
    expect(run(held([sendBack({ createdAt: '2026-11-05T09:00:00Z' }), advisory(HEAD)]))
      .refusals[0]?.kind).toBe('already-reviewed-head');
  });
  it.each([undefined, 'NaN'])('keeps already-reviewed-head for unreadable send-back time %s', createdAt => {
    expect(run(held([advisory(HEAD), sendBack({ createdAt })])).refusals[0]?.kind).toBe('already-reviewed-head');
  });
  it('keeps already-reviewed-head for unreadable review time', () => {
    expect(run(held([advisory(HEAD, { createdAt: 'NaN' }), sendBack()])).refusals[0]?.kind).toBe('already-reviewed-head');
  });
  it('an agent-authored copy grants nothing', () => {
    expect(run(held([advisory(HEAD), sendBack({ author })])).refusals[0]?.kind).toBe('already-reviewed-head');
  });
  it.each([undefined, 'NaN'])('an addressed fix-end with unreadable time %s cannot resolve a send-back', createdAt => {
    const request = sendBack({ body: sendBack().body.replace(HEAD, OLD) });
    const coverage = end({ createdAt, body: `${end().body}\n\n<!-- addresses-operator-send-back: send-back -->` });
    expect(openOperatorSendBacks(pr({ comments: [request, coverage] }))).toHaveLength(1);
  });
  it('an addressed fix-end on the requested head cannot resolve the send-back', () => {
    const coverage = end({ body: `${end().body}\n\n<!-- addresses-operator-send-back: send-back -->` });
    expect(openOperatorSendBacks(pr({ comments: [sendBack(), coverage] }))).toHaveLength(1);
  });
  it.each([
    `Quoted repair at \`${HEAD.slice(0, 9)}\`.`,
    `> \`fix-session\` released the fix claim at \`${HEAD.slice(0, 9)}\`.`,
    `\`\`\`text\n\`fix-session\` released the fix claim at \`${HEAD.slice(0, 9)}\`.\n\`\`\``,
  ])('a headless fix-end cannot resolve a request using body text: %s', quoted => {
    const request = sendBack({ body: sendBack().body.replace(HEAD, OLD) });
    const body = `${buildFixEndComment({ who: 'fix-session' })}\n\n${quoted}\n<!-- addresses-operator-send-back: send-back -->`;
    expect(openOperatorSendBacks(pr({ comments: [request, end({ body })] }))).toHaveLength(1);
  });
  it('a quoted new head cannot supersede the actual unchanged claim-release head', () => {
    const body = `${buildFixEndComment({ who: 'fix-session', headSha: OLD })}\n\n> at \`${HEAD.slice(0, 9)}\`\n<!-- addresses-operator-send-back: send-back -->`;
    const request = sendBack({ body: sendBack().body.replace(HEAD, OLD) });
    expect(openOperatorSendBacks(pr({ comments: [request, end({ body })] }))).toHaveLength(1);
  });
  it.each(['evidence', 'fix-end'])('does not re-fire after covering %s', kind => {
    const request = sendBack({ body: sendBack().body.replace(HEAD, OLD) });
    const coverage = kind === 'evidence'
      ? { author, createdAt: END_AT, body: `## Fix evidence\n\n<!-- addresses-operator-send-back: send-back -->\nHead: \`${HEAD}\`` }
      : end({ body: `${end().body}\n\n<!-- addresses-operator-send-back: send-back -->` });
    const comments = [advisory(OLD), request, coverage, advisory(HEAD, { createdAt: '2026-11-05T11:30:00Z' })];
    expect(openOperatorSendBacks(pr({ comments }))).toEqual([]);
    expect(run(held(comments)).dispatch).toEqual([]);
    expect(run(held(comments)).refusals[0]?.kind).toBe('already-reviewed-head');
  });
  it.each(['\n', '\r\n', '\n\n'])('resolves a changed-head fix-end with coverage metadata immediately after the release sentence (%j)', separator => {
    const request = sendBack({ body: sendBack().body.replace(HEAD, OLD) });
    const body = buildFixEndComment({ who: 'fix-session', headSha: HEAD })
      .replace('. ', `.${separator}<!-- addresses-operator-send-back: send-back -->\n`);
    const comments = [advisory(OLD), request, end({ body }),
      advisory(HEAD, { createdAt: '2026-11-05T11:30:00Z' })];
    expect(openOperatorSendBacks(pr({ comments }))).toEqual([]);
    expect(run(held(comments)).dispatch).toEqual([]);
    expect(run(held(comments)).refusals[0]?.kind).toBe('already-reviewed-head');
  });
});

describe('R618 operator send-back route hands the fixer the whole request', () => {
  it('keeps a required repair that sits after char 4100 of a long send-back body', () => {
    const tail = 'REQUIRED REPAIR AFTER CHAR 4100';
    const long = sendBack({ body: `${sendBack().body}\n\n${'x'.repeat(4200)}\n${tail}` });
    const [fix] = run(held([advisory(HEAD), long])).dispatch;
    expect(fix).toEqual(expect.objectContaining({ kind: 'fix', mode: 'operator-send-back' }));
    // Pin the exact field the fixer brief reads: `base` also carries fullBody, so a whole-object check could pass on the truncated route.
    expect(fix.operatorSendBack.body).toContain(tail);
    expect(fix.operatorSendBack.body.length).toBeGreaterThan(4100);
  });
});
