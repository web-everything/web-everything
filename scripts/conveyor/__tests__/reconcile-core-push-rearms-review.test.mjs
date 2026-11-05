import { describe, expect, it } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { buildFixEndComment } from '../fix-procedure.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
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

describe('R618 pushed fix owes its review', () => {
  it('reviews a new fixer head despite the stale advisory:changes label', () => {
    expect(run().dispatch).toEqual([expect.objectContaining({ kind: 'review', headRefOid: HEAD })]);
  });
  it('reviews a bounced new fixer head rather than fixing the old findings again', () => {
    expect(run({ labels: ['review:changes'] }).dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
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
});

describe('R618 same-head operator send-back supersedes a finished advisory', () => {
  it('dispatches the newer operator request as a fix despite an auto-resumed referral hold', () => {
    expect(run(held([advisory(HEAD), sendBack()])).dispatch).toEqual([
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
