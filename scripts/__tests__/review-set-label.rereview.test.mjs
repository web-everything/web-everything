import { describe, it, expect, vi, afterEach } from 'vitest';
import { decideSetLabel, runReviewLabelCli, buildVerdictComment, REVIEW_LABEL_TARGETS, GH_COMMENT_MAX } from '../review-set-label.mjs';
import { reviewRecordKind } from '../merge-ai-prs.mjs';
import { parseReviewedSha, parseReviewedDiff, parseReviewedContribution, parseOperatorClearance, parseLatestHumanClearedSha } from '../lib/review-escalation.mjs';
import { latestAcceptRecord } from '../lib/accept-carry-forward.mjs';
import { APPLIABLE_TARGETS, validateRequest } from '../apply-review-request.mjs';
import { RED_TEAM_STATUS_LABELS } from '../lib/red-team-status-label-meta.mjs';
import { PR_COMMENTS_PAGE_SIZE } from '../lib/review-label-provider.mjs';
import { advisoryCoversHead, parseAdvisories, planAdvisoryRepairLabels } from '../lib/advisory-labels.mjs';
import { planReconcile } from '../conveyor/reconcile-core.mjs';
import { liveResultGateState, redTeamMarker } from '../lib/red-team-gate.mjs';
import { redTeamOwedFor } from '../lib/review-red-team-policy.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const FROM = ['review:human', 'review:accepted', 'review:changes', 'redteam:accepted', 'ready-to-merge',
  'review:awaiting-advisory', 'advisory:accepted', 'advisory:changes', 'advisory:ruling-needed', ...RED_TEAM_STATUS_LABELS];
const trusted = body => ({ body, author: { login: 'web-everything' } });
const clearance = head => ({ body: buildVerdictComment({ to: 'clear-human', actor: 'operator', headSha: head }), author: { login: 'chalbert' } });
afterEach(() => vi.restoreAllMocks());

function run({ state = {}, flags = [], omit = [], onRead, onPost, onSetLabels, page, postError = false, reason = 'head moved' } = {}) {
  let live = { state: 'OPEN', labels: [...FROM], headRefOid: HEAD, comments: [], ...state };
  const writes = [], emitted = [];
  let reads = 0, exit = null;
  const provider = {
    readPrState: vi.fn(() => { onRead?.(++reads, live); return structuredClone(live); }),
    readComments: vi.fn(() => page),
    readLabels: vi.fn(() => live.labels),
    postComment: vi.fn((_repo, _pr, body) => {
      if (postError) throw new Error('comment write failed');
      writes.push({ kind: 'comment', body });
      live.comments.push(trusted(body));
      onPost?.(live);
    }),
    setLabels: vi.fn((_repo, _pr, { add, remove }) => {
      writes.push({ kind: 'labels', add, remove });
      live.labels = [...live.labels.filter(l => !remove.includes(l)), add];
      onSetLabels?.(live);
    }),
  };
  const stop = new Error('test exit');
  vi.spyOn(process, 'exit').mockImplementation(code => { exit = code; throw stop; });
  const argv = ['7', '--repo=web-everything/web-everything', '--to=rereview', '--actor=operator', `--reason=${reason}`, ...flags]
    .filter(a => !omit.some(prefix => a.startsWith(prefix)));
  try {
    runReviewLabelCli({ argv, provider, defaultActor: 'default', emit: line => emitted.push(JSON.parse(line)),
      buildComment: buildVerdictComment, successResult: o => ({ ok: true, ...o }),
      refusalResult: ({ decision }) => ({ refused: true, error: decision.reason }) });
  } catch (e) { if (e !== stop) throw e; }
  return { live, writes, provider, emitted, exit };
}

describe('rereview without approval', () => {
  it('is a label CLI target but remains excluded from staged review requests', () => {
    expect(REVIEW_LABEL_TARGETS).toContain('rereview');
    expect(APPLIABLE_TARGETS).not.toContain('rereview');
    expect(validateRequest({ repo: 'o/r', pr: 7, to: 'rereview', actor: 'operator', body: 'review request' }).ok).toBe(false);
  });
  it('never produces accepted or merge eligibility, removing stale verdicts and all red-team statuses', () => {
    const result = run();
    expect(result.exit).toBe(null);
    expect(result.live.labels).toEqual(['review:pending']);
    expect(result.writes.map(w => w.kind)).toEqual(['comment', 'labels']);
    expect(result.writes[1].add).toBe('review:pending');
    expect(result.writes[1].remove).toEqual(expect.arrayContaining(FROM));
  });
  it('records actor, reason, CURRENT head and from-labels on every use', () => {
    const result = run();
    const body = result.writes[0].body;
    expect(reviewRecordKind(body)).toBe('rereview');
    expect(JSON.parse(body.split('\n')[2])).toEqual({ actor: 'operator', reason: 'head moved', headSha: HEAD, fromLabels: FROM });
  });
  it.each([undefined, null, 'untrusted labels'])('renders an empty label list for absent or non-array labels: %j', fromLabels => {
    const body = buildVerdictComment({ to: 'rereview', fromLabels });
    expect(JSON.parse(body.split('\n')[2])).toEqual({ reason: '', headSha: '', fromLabels: [] });
  });
  it('tolerates omitted comment options', () => {
    expect(typeof buildVerdictComment()).toBe('string');
  });
  it.each(['--actor=', '--reason='])('requires explicit attribution even when a default actor exists: %s', prefix => {
    const result = run({ omit: [prefix] });
    expect(result.exit).not.toBe(null);
    expect(result.writes).toEqual([]);
    expect(result.provider.readPrState).not.toHaveBeenCalled();
  });
  it.each(['CLOSED', 'MERGED', '', undefined])('refuses a non-open or unreadable PR state: %s', state => {
    const result = run({ state: { state } });
    expect(result.exit).not.toBe(null);
    expect(result.writes).toEqual([]);
  });
  it('supports a matching --expect-head and refuses mismatches before any write', () => {
    expect(run({ flags: [`--expect-head=${HEAD}`] }).exit).toBe(null);
    vi.restoreAllMocks();
    const result = run({ flags: [`--expect-head=${OLD}`] });
    expect(result.writes).toEqual([]);
    expect(result.emitted.at(-1).error).toMatch(/live head differs/);
  });
  it.each(['', 'abc', 'z'.repeat(40)])('refuses malformed head pins: %s', pin => {
    const result = run({ flags: [`--expect-head=${pin}`] });
    expect(result.exit).not.toBe(null);
    expect(result.writes).toEqual([]);
  });
  it.each(['', null])('refuses unreadable live heads: %s', headRefOid => {
    const result = run({ state: { headRefOid } });
    expect(result.exit).not.toBe(null);
    expect(result.writes).toEqual([]);
  });
  it('refuses head movement before the record', () => {
    const result = run({ onRead: (n, live) => { if (n === 2) live.headRefOid = OLD; } });
    expect(result.writes).toEqual([]);
    expect(result.exit).not.toBe(null);
  });
  it.each(['CLOSED', 'MERGED'])('refuses a PR that becomes %s before the swap', state => {
    const result = run({ onPost: live => { live.state = state; } });
    expect(result.writes.map(w => w.kind)).toEqual(['comment']);
    expect(result.live.labels).toContain('review:human');
  });
  it('refuses unreadable labels on the pre-write read', () => {
    const result = run({ onRead: (n, live) => { if (n === 2) live.labels = null; } });
    expect(result.exit).not.toBe(null);
    expect(result.writes).toEqual([]);
  });
  it('retains the human hold if the head moves after recording', () => {
    const result = run({ onPost: live => { live.headRefOid = OLD; } });
    expect(result.writes.map(w => w.kind)).toEqual(['comment']);
    expect(result.live.labels).toContain('review:human');
    expect(result.exit).not.toBe(null);
  });
  it('refuses without review:human and points to rearm', () => {
    const result = run({ state: { labels: ['review:changes'] } });
    expect(result.writes).toEqual([]);
    expect(result.emitted.at(-1).error).toMatch(/use rearm/);
  });
  it.each([
    ['head moves from A to B', live => { live.headRefOid = OLD; }],
    ['PR becomes MERGED', live => { live.state = 'MERGED'; }],
    ['PR becomes CLOSED', live => { live.state = 'CLOSED'; }],
    ['PR state becomes unreadable', live => { live.state = undefined; }],
    ['head becomes unreadable', live => { live.headRefOid = null; }],
  ])('restores the human hold and never reports success when %s during setLabels', (_name, onSetLabels) => {
    const result = run({ onSetLabels });
    expect(result.exit).toBe(1);
    expect(result.live.labels).toEqual(['review:human']);
    expect(result.writes.map(w => w.kind)).toEqual(['comment', 'labels', 'labels']);
    expect(JSON.parse(result.writes[0].body.split('\n')[2]).headSha).toBe(HEAD);
    expect(result.writes[2]).toEqual({ kind: 'labels', add: 'review:human', remove: ['review:pending'] });
    expect(result.emitted.some(row => row.ok)).toBe(false);
    expect(result.emitted.at(-1).error).toMatch(/state or live head changed during label write; human hold restored/);
  });
  it('restores the human hold when the post-write state read fails', () => {
    const result = run({ onRead: n => { if (n === 4) throw new Error('state read failed'); } });
    expect(result.exit).toBe(1);
    expect(result.live.labels).toEqual(['review:human']);
    expect(result.emitted.some(row => row.ok)).toBe(false);
    expect(result.emitted.at(-1).error).toMatch(/state read failed; human hold restored; inspect the PR and retry/);
  });
  it('refuses a head carrying human clearance in the pure decision and CLI', () => {
    expect(decideSetLabel({ to: 'rereview', currentLabels: FROM, humanClearedHead: true }).allowed).toBe(false);
    const result = run({ state: { comments: [clearance(HEAD)] } });
    expect(result.writes).toEqual([]);
    expect(result.emitted.at(-1).error).toMatch(/human clearance/);
  });
  it('does not confuse a previous head clearance with the current head', () => {
    expect(run({ state: { comments: [clearance(OLD)] } }).live.labels).toEqual(['review:pending']);
  });
  it('refuses a clearance arriving after the request record', () => {
    const result = run({ onPost: live => live.comments.push(clearance(HEAD)) });
    expect(result.writes.map(w => w.kind)).toEqual(['comment']);
    expect(result.live.labels).toContain('review:human');
  });
  it('preserves human clearance arriving during setLabels', () => {
    const result = run({ onSetLabels: live => {
      if (live.labels.includes('review:pending')) live.comments.push(clearance(HEAD));
    } });
    expect(result.exit).toBe(1);
    expect(result.live.labels).toEqual(['review:accepted']);
    expect(result.emitted.some(row => row.ok)).toBe(false);
    expect(result.emitted.at(-1).error).toMatch(/human clearance restored; rereview refused/);
  });
  it('preserves human clearance arriving beyond the embedded page during setLabels', () => {
    const page = [];
    const result = run({ page, onSetLabels: live => {
      if (!live.labels.includes('review:pending')) return;
      live.comments.push(...Array.from({ length: PR_COMMENTS_PAGE_SIZE }, () => trusted('discussion')));
      page.push(...live.comments, clearance(HEAD));
    } });
    expect(result.provider.readComments).toHaveBeenCalled();
    expect(result.exit).toBe(1);
    expect(result.live.labels).toEqual(['review:accepted']);
    expect(result.emitted.some(row => row.ok)).toBe(false);
    expect(result.emitted.at(-1).error).toMatch(/human clearance restored/);
  });
  it('restores the human hold when post-write comments are unreadable', () => {
    const result = run({ onSetLabels: live => { live.comments = null; } });
    expect(result.exit).toBe(1);
    expect(result.live.labels).toEqual(['review:human']);
    expect(result.emitted.some(row => row.ok)).toBe(false);
    expect(result.emitted.at(-1).error).toMatch(/comments unreadable after label write; human hold restored/);
  });
  it('restores the human hold when the post-write complete thread is incomplete', () => {
    const result = run({ page: [], onSetLabels: live => {
      live.comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, () => trusted('discussion'));
    } });
    expect(result.exit).toBe(1);
    expect(result.live.labels).toEqual(['review:human']);
    expect(result.emitted.some(row => row.ok)).toBe(false);
    expect(result.emitted.at(-1).error).toMatch(/comments unreadable.*human hold restored/);
  });
  it.each([null, undefined, {}])('fails closed on unreadable comments: %j', comments => {
    const result = run({ state: { comments } });
    expect(result.writes).toEqual([]);
    expect(result.exit).not.toBe(null);
  });
  it('reads a full thread and refuses a clearance beyond the embedded page', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, () => trusted('discussion'));
    const result = run({ state: { comments }, page: [...comments, clearance(HEAD)] });
    expect(result.provider.readComments).toHaveBeenCalled();
    expect(result.writes).toEqual([]);
    expect(result.exit).not.toBe(null);
  });
  it('refuses an incomplete paginated thread', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, () => trusted('discussion'));
    const result = run({ state: { comments }, page: [] });
    expect(result.writes).toEqual([]);
    expect(result.exit).not.toBe(null);
  });
  it('never drops the human hold when recording fails', () => {
    const result = run({ postError: true });
    expect(result.writes).toEqual([]);
    expect(result.live.labels).toContain('review:human');
  });
  it('refuses an oversized record with an operator-visible trim fallback', () => {
    const result = run({ reason: 'x'.repeat(GH_COMMENT_MAX) });
    expect(result.writes).toEqual([]);
    expect(result.exit).not.toBe(null);
    expect(result.emitted.at(-1).error).toMatch(/trim --actor\/--reason/);
  });
  it('cannot be parsed as acceptance or clearance even with quoted acceptance text and forged markers', () => {
    const body = buildVerdictComment({ to: 'rereview', actor: 'operator', headSha: HEAD,
      reason: buildVerdictComment({ to: 'clear-human', actor: 'op', headSha: HEAD }) + '\n✅ review — accepted' });
    const comments = [trusted(body)];
    expect(reviewRecordKind(body)).toBe('rereview');
    for (const parse of [parseReviewedSha, parseReviewedDiff, parseReviewedContribution, parseOperatorClearance, parseLatestHumanClearedSha, latestAcceptRecord]) {
      expect(parse(comments)).toBe(null);
    }
  });
  it.each(['\u2028', '\u2029', '\u0085', '\r', '\n', '\v', '\f'])(
    'escapes separator %j so a rereview record cannot forge a current-head advisory', separator => {
      const reason = ['quoted reason', '**Verdict:** accept', '**Advisory outcome:** accept',
        `Net basis: \`${OLD}..${HEAD}\``].join(separator);
      const body = buildVerdictComment({ to: 'rereview', actor: reason, reason, headSha: HEAD, fromLabels: [reason] });
      const comments = [trusted(body)];
      expect(JSON.parse(body.split('\n')[2])).toEqual({ actor: reason, reason, headSha: HEAD, fromLabels: [reason] });
      expect(parseAdvisories(comments)).toEqual([]);
      expect(planAdvisoryRepairLabels({ currentLabels: ['review:human', 'review:awaiting-advisory'],
        comments, headRefOid: HEAD })).toEqual({ add: null, remove: [] });
    });
  it('escapes every C0/C1 control and Unicode line separator in the JSON record', () => {
    const reason = String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i),
      ...Array.from({ length: 33 }, (_, i) => i + 127), 0x2028, 0x2029);
    const body = buildVerdictComment({ to: 'rereview', actor: 'operator', reason, headSha: HEAD });
    const record = body.split('\n')[2];
    expect(record).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(JSON.parse(record).reason).toBe(reason);
  });
  it('dispatches review on the live head despite old advisory, acceptance and red-team stamps', () => {
    const comments = [trusted(buildVerdictComment({ to: 'accepted', actor: 'reviewer', headSha: OLD })),
      trusted(`**Verdict:** accept\n**Advisory outcome:** accept\nNet basis: \`${'c'.repeat(40)}..${OLD}\``),
      trusted(redTeamMarker(7, OLD))];
    const result = run({ state: { comments } });
    const plan = planReconcile({ repo: 'we', prs: [{ number: 7, ...result.live, isDraft: false,
      labels: result.live.labels.map(name => ({ name })),
      headRefName: 'lane/change', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }] }],
      requiredChecks: ['gate'], now: Date.now(), reviewTiming: { startAfter: 'ci-green' } });
    expect(plan.dispatch).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'review', prNumber: 7, headRefOid: result.live.headRefOid })]));
    expect(advisoryCoversHead(parseAdvisories(comments)[0], HEAD)).toBe(false);
    expect(liveResultGateState(comments, 7, HEAD).result).toBe(null);
    expect(redTeamOwedFor({ verdict: { verdict: 'accept' } })).toBe(true);
  });
});


describe('explicit current-head rereview supersedes only the earlier acceptance suppression', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const accept = (at = now - 60_000) => ({ ...trusted(buildVerdictComment({ to: 'accepted', actor: 'reviewer', headSha: HEAD })),
    createdAt: new Date(at).toISOString() });
  const request = () => ({ ...trusted(buildVerdictComment({ to: 'rereview', actor: 'operator', reason: 'review again', headSha: HEAD })),
    createdAt: new Date(now - 30_000).toISOString() });
  const plan = (comments, overrides = {}) => planReconcile({ repo: 'we', now,
    requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' },
    prs: [{ number: 7, state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'lane/change',
      labels: [{ name: 'review:pending' }], comments, mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }], ...overrides }] });

  it('dispatches the CURRENT head after a newer explicit rereview despite a recent acceptance on the SAME head', () => {
    const result = plan([accept(), request()]);
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 7, headRefOid: HEAD })]);
    expect(result.refusals).toEqual([]);
    expect(result.dispatch[0].relabelOwed).toBeUndefined();
  });
  it.each([
    ['untrusted author', c => { c.author.login = 'mallory'; }],
    ['missing author', c => { delete c.author; }],
    ['missing timestamp', c => { delete c.createdAt; }],
    ['invalid timestamp', c => { c.createdAt = 'unreadable'; }],
    ['older request', c => { c.createdAt = new Date(now - 90_000).toISOString(); }],
    ['equal timestamp', c => { c.createdAt = accept().createdAt; }],
    ['other head', c => { c.body = c.body.replace(HEAD, OLD); }],
    ['malformed JSON', c => { c.body = c.body.replace('{', '{broken'); }],
    ['missing marker', c => { c.body = c.body.replace('<!-- review-rereview-v1 -->', ''); }],
    ['quoted record', c => { c.body = 'quoted request\n' + c.body; }],
    ['empty attribution', c => { c.body = c.body.replace('"actor":"operator"', '"actor":""'); }],
  ])('retains already-reviewed-head with %s evidence', (_name, mutate) => {
    const record = request();
    mutate(record);
    const result = plan([accept(), record]);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({ kind: 'already-reviewed-head', headSha: HEAD })]);
  });
  it('retains suppression with no rereview record or unreadable acceptance timestamp', () => {
    for (const comments of [[accept()], [{ ...accept(), createdAt: undefined }, request()]]) {
      const result = plan(comments);
      expect(result.dispatch).toEqual([]);
      expect(result.refusals[0].kind).toBe('already-reviewed-head');
    }
  });
  it('a later acceptance on the same head supersedes the rereview request', () => {
    const result = plan([accept(), request(), accept(now - 10_000)]);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].kind).toBe('already-reviewed-head');
  });
  it('keeps draft and CI suppressions after an explicit rereview request', () => {
    for (const [overrides, kind] of [[{ isDraft: true, statusCheckRollup: [{ name: 'gate', status: 'in_progress', conclusion: null }] }, 'draft'],
      [{ statusCheckRollup: [{ name: 'gate', status: 'in_progress', conclusion: null }] }, 'review-ci']]) {
      const result = plan([accept(), request()], overrides);
      expect(result.dispatch).toEqual([]);
      expect(result.refusals.some(row => row.kind === kind)).toBe(true);
    }
  });
  it('never dispatches after same-head acceptance, human clearance, then a newer rereview request', () => {
    const result = plan([accept(),
      { ...clearance(HEAD), createdAt: new Date(now - 45_000).toISOString() }, request()]);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({
      kind: 'already-reviewed-head', prNumber: 7, headSha: HEAD,
    })]);
  });
  it('never overrides a human clearance on the same head', () => {
    const result = plan([{ ...clearance(HEAD), createdAt: accept().createdAt }, request()]);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].kind).toBe('already-reviewed-head');
  });
});
