/**
 * @file scripts/conveyor/__tests__/reconcile-core.test.mjs
 * @description Pins the resident reconcile pass (WE #3296) — the dispatch and, mostly, its FOUR REFUSALS.
 *
 *   Nothing in the tree compared desired delivery state against actual: `planTick` spawns only for PRs the
 *   CURRENT session launched (`tick-core.mjs:396`), and that bookkeeping is piped in over STDIN, so it dies with
 *   the session. `planReconcile` is the pass that closes it, and the dispatch is the easy half. These cases are
 *   weighted the way the item is: one for the dispatch and its KEY, one per refusal, and one for the argv —
 *   because every refusal is a place where a plausible simplification silently re-opens the defect.
 *
 *   THE ARGV CASE IS NOT CEREMONY. Every other case here runs on injected fixtures and would stay green while
 *   the pass read the wrong PRs and reconciled nothing in production. A wrong discovery query fails SILENTLY —
 *   an empty listing reads exactly like a fleet with nothing owed.
 *
 *   THE MUTATIONS THIS FILE IS BUILT TO KILL (one per refusal, each named with the case it reddens):
 *     • drop the `stood-down` check                       → reddens case 2 only.
 *     • drop the empty-findings check                     → reddens case 3 only.
 *     • read the attempt count from an in-process tally    → reddens case 4 only.
 *     • accept a fresh transcript mtime as liveness       → reddens case 5(c) ONLY, and must leave 5(a) green.
 *
 *   That last asymmetry is the whole of refusal 4 and it is easy to get backwards: 5(a) is a LIVE pid with a
 *   STALE transcript, so a mutant that grants liveness on freshness never fires on it — the live pid refuses
 *   either way. 5(c) is a FRESH transcript with NO agent entry, which is exactly what that mutant breaks.
 *   Freshness never grants liveness; staleness never withdraws it. A mutation that reddens BOTH has removed the
 *   wrong thing. 5(b) and 5(d) carry a stale mtime too, so what their refusal turns on is the entry's own fields
 *   and nothing else.
 *
 *   Every fixture below is a shape MEASURED on 2026-08-26, not an invented one; the timestamps in the case names
 *   say when.
 */
import { describe, it, expect } from 'vitest';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from '../fix-procedure.mjs';
import {
  planReconcile as planReconcileCore, fixWaitingSince, countFindings, bindAgents, assessLiveness, isAwaitingPermission, startedAtMs,
  REFUSAL_KINDS, DISPATCH_KINDS, selectStatusCandidates, markSelfReportedDone, markHungSessions,
  markAuthExpiredSessions, markIdleFinishedSessions, markBgIsolationStalls, CI_HEAL_ROUND_CAP,
  CONFLICT_FIX_ROUND_CAP, ADVISORY_FIX_ROUND_CAP, CONFLICT_FIX_ABSOLUTE_CEILING, foldReviewRefusalInto,
  ACCEPT_LABEL_GRACE_MS, acceptLabelDropped, CARD_BATCH_EXTRACT_WIRED,
} from '../reconcile-core.mjs';
import {
  STAND_DOWN_MARKER, WATCHER_STAND_DOWN_ACTOR, SUPERSEDE_STAND_DOWN_MARKER, buildStandDownComment,
} from '../stand-down.mjs';
import { buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { CI_HEAL_COMMENT_MARKER, buildCiHealComment } from '../ci-heal-mark.mjs';
import { buildCiHealEscalationComment } from '../ci-heal-escalation-mark.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-round-count.mjs';
import {
  ADVISORY_FIX_COMMENT_MARKER, buildAdvisoryFixComment, isLatestAdvisoryFindingAddressed, countCompletedAdvisoryEpisodes,
} from '../advisory-fix-mark.mjs';
import { CONVERTED_ADVISORY_NOTE_MARKER } from '../../lib/review-escalation.mjs';
import { buildRebaseOntoMainComment, DEFAULT_MAX_REBASE_RETRIES_PER_SHA } from '../main-red-recovery.mjs';
import { laneRefItemNum } from '../lease-reaper.mjs';
import { NEGOTIATION_ROUND_CAP } from '../../lib/jury-core.mjs';
import { defaultReadPrs, defaultReadAgents, PR_LIST_JSON_FIELDS, PR_LIST_LIMIT } from '../reconcile-pass.mjs';
import { reviewSessionSlug } from '../review-session-slug.mjs';
import { sessionSlugFor } from '../../operations/dispatch-lane.mjs';
import { buildReviewedShaMarker } from '../../lib/review-escalation.mjs';
import { classifyPr } from '../../progress-board.mjs';
import { reconcileHolds } from '../../operations/land-advance-items-io.mjs';

// ── fixtures — measured shapes, 2026-08-26 ───────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-08-26T17:34:00Z');
const HOUR = 3_600_000;
/** The three permission-blocked sessions started 2026-08-17T22:10–22:12Z — 211.4 h before the 17:34Z reading. */
const BLOCKED_SINCE = '2026-08-17T22:10:00Z';
/** THE SHAPE THE TOOL ACTUALLY RETURNS. Read off a live `claude agents --json` on 2026-08-26: `startedAt` is an
 *  epoch NUMBER, not the ISO string it reads like. This is `conveyor-3151`'s (pid 18278) real value. */
const BLOCKED_SINCE_EPOCH = 1787004649412; // === 2026-08-17T22:10:49.412Z
const STALE_MTIME = NOW - 211.4 * HOUR;   // a transcript nobody has written to in 211 hours.
const FRESH_MTIME = NOW - 30_000;         // written 30 s ago.
// #3383 — every durable marker counter now requires a TRUSTED author (`we:scripts/lib/marker-authorship.mjs`);
// this is the real automation login, confirmed live. Fixtures below attach it to every comment meant to read as
// a genuine marker, unless a case is specifically about authorship itself.
const AUTOMATION = { login: 'web-everything' };

const lbl = (...names) => names.map((name) => ({ name }));
// These fixtures model a repository whose one required check is gate. Specific CI cases override the set.
const planReconcile = options => planReconcileCore({ requiredChecks: ['gate'], ...options });
const greenRollup = [{ name: 'gate', status: 'completed', conclusion: 'success' }];
const pendingRollup = [{ name: 'gate', status: 'in_progress', conclusion: null }];
const redRollup = [{ name: 'gate', status: 'completed', conclusion: 'failure' }];
const finding = (text = 'the cap is not derived from the PR; derive it from the comment thread') =>
  ({ body: `🔁 human review — changes requested\n\n${text}` });

/** PR #1563 — open 2026-08-25T22:00:51Z, merged 16:39:23Z, 18 h 39 m and TWELVE review rounds against a cap of 5. */
const pr1563 = (over = {}) => ({
  number: 1563,
  state: 'OPEN',
  headRefName: 'lane/2612-converge-pr-drive',
  headRefOid: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
  labels: lbl('review:changes'),
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: greenRollup,
  comments: [finding()],
  ...over,
});

/** The four PRs actually open at 17:34Z, with the labels and comment counts measured then. */
const OPEN_AT_1734 = [
  { number: 1576, headRefName: 'lane/review-slice-scopes', labels: lbl('review:changes', 'checking'), nComments: 2 },
  { number: 1572, headRefName: 'lane/review-pr-override-reason', labels: lbl('review:accepted'), nComments: 9 },
  { number: 1571, headRefName: 'lane/review-corpus-replay', labels: lbl('ready-to-merge', 'review:accepted', 'checking'), nComments: 6 },
  { number: 1569, headRefName: 'lane/review-efficacy-watch', labels: lbl('ready-to-merge', 'review:accepted', 'checking'), nComments: 9 },
].map((p) => ({
  number: p.number,
  state: 'OPEN',
  headRefName: p.headRefName,
  headRefOid: `${p.number}`.repeat(10),
  labels: p.labels,
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: pendingRollup,
  comments: Array.from({ length: p.nComments }, (_, i) => finding(`round ${i + 1}`)),
}));

/** A spy for the injected `exec`, so a discovery query is assertable with no `gh` and no credential. */
const spyExec = (stdout = '[]') => {
  const calls = [];
  return { calls, exec: (file, argv, opts) => { calls.push({ file, argv, opts }); return stdout; } };
};

// ── CASE 1 — THE DISPATCH, AND ITS KEY ────────────────────────────────────────────────────────────────────────
describe('case 1 — the dispatch, keyed by PR NUMBER (#3296)', () => {
  it('a bounced PR with a finding and nothing live on it returns exactly one `fix` dispatch', () => {
    const plan = planReconcile({ prs: [pr1563()], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(1);
    expect(plan.dispatch[0].kind).toBe('fix');
    expect(plan.dispatch[0].prNumber).toBe(1563);
    expect(plan.refusals).toHaveLength(0);
  });

  it('an agent listing with no entry BOUND to the PR does not suppress the dispatch', () => {
    // Live sessions, in real lanes, on OTHER heads. Being alive somewhere is not being alive HERE — the whole
    // reason the binding is derived rather than assumed.
    const agents = [
      { sessionId: 's1', cwd: '/lanes/lane-37', pid: 111, pidAlive: true, laneHeadOid: 'ffff'.repeat(10) },
      { sessionId: 's2', cwd: '/lanes/lane-39', pid: 222, pidAlive: true, laneHeadOid: 'eeee'.repeat(10) },
    ];
    const plan = planReconcile({ prs: [pr1563()], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch.map((d) => d.kind)).toEqual(['fix']);
  });

  it('THE KEY: the four real head refs open at 17:34Z produce FOUR rows — an item-keyed pass produces ZERO', () => {
    // Measured 2026-08-26 17:34Z: `laneRefItemNum` returns null on every one of the four. Its grammar is
    // `^lane/(x[a-z0-9]{5,7}|\d+)[a-z]?-`, and none of today's review lanes match it. A pass keyed by ITEM
    // number would therefore have seen none of the PRs it exists to reconcile. That difference is this test.
    const refs = OPEN_AT_1734.map((p) => p.headRefName);
    expect(refs).toEqual([
      'lane/review-slice-scopes', 'lane/review-pr-override-reason',
      'lane/review-corpus-replay', 'lane/review-efficacy-watch',
    ]);
    expect(refs.map(laneRefItemNum)).toEqual([null, null, null, null]);
    expect(refs.map(laneRefItemNum).filter(Boolean)).toHaveLength(0); // the item-keyed pass: zero rows.

    const plan = planReconcile({ prs: OPEN_AT_1734, agents: [], durableCounts: {}, now: NOW });
    const rows = [...plan.dispatch, ...plan.refusals];
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.prNumber).sort()).toEqual([1569, 1571, 1572, 1576]);
    // #1576 was the only one of the four with work owed; the other three were reviewed and queued to land.
    expect(plan.dispatch.map((d) => [d.prNumber, d.kind])).toEqual([[1576, 'fix']]);
    expect(plan.refusals.map((r) => r.kind)).toEqual(['nothing-owed', 'nothing-owed', 'nothing-owed']);
  });

  it('EVERY PR yields exactly one row — a pass that drops a PR silently is the original defect one level up', () => {
    const prs = [...OPEN_AT_1734, pr1563(), pr1563({ number: 9001, comments: [] })];
    const plan = planReconcile({ prs, agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch.length + plan.refusals.length).toBe(prs.length);
    const keyed = [...plan.dispatch, ...plan.refusals].map((r) => r.prNumber);
    expect(new Set(keyed).size).toBe(prs.length);
  });

  it('every refusal kind this pass can emit is on the frozen REFUSAL_KINDS list', () => {
    const prs = [...OPEN_AT_1734, pr1563(), pr1563({ number: 9001, comments: [] })];
    const plan = planReconcile({ prs, agents: [], durableCounts: {}, now: NOW });
    for (const r of plan.refusals) expect(REFUSAL_KINDS).toContain(r.kind);
    for (const d of plan.dispatch) expect(DISPATCH_KINDS).toContain(d.kind);
  });
});

// ── CASE 2 — REFUSAL 1: `stood-down` IS TERMINAL ──────────────────────────────────────────────────────────────
describe('case 2 — refusal 1: a fixer that stopped to ASK is never restarted (#3296)', () => {
  const stoodDown = pr1563({ comments: [finding(), { body: `${STAND_DOWN_MARKER}\n\nthe finding needs a judgment.`, author: AUTOMATION }] });

  it('returns ZERO dispatches and one `stood-down` refusal', () => {
    const plan = planReconcile({ prs: [stoodDown], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].kind).toBe('stood-down');
    expect(plan.refusals[0].prNumber).toBe(1563);
    expect(plan.refusals[0].standDowns).toBe(1);
  });

  it('TERMINAL — a week later the answer is byte-identical: no decay, no clock', () => {
    const a = planReconcile({ prs: [stoodDown], agents: [], durableCounts: {}, now: NOW });
    const b = planReconcile({ prs: [stoodDown], agents: [], durableCounts: {}, now: NOW + 7 * 24 * HOUR });
    expect(b).toEqual(a);
  });

  it('a human QUOTING the stand-down comment does not mark the PR stood down', () => {
    // The marker counts only as a LEADING line — the same narrowing `countRearmComments` applies, and for the
    // same reason: a person replying to the escalation is raising a finding, not posting a marker.
    const quoted = pr1563({ comments: [{ body: `> ${STAND_DOWN_MARKER}\n\nI disagree — here is the call.` }] });
    const plan = planReconcile({ prs: [quoted], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals.map((r) => r.kind)).not.toContain('stood-down');
    expect(plan.dispatch.map((d) => d.kind)).toEqual(['fix']);
  });

  // #xu2krte Fork 2 (review-human statute amendment) — PR web-everything/web-everything#2549's shape: the parked-PR
  // conflict watch itself stood a PR down at conflict-detection time (`reason=conflict`, its own actor string),
  // which is a ROUTING artifact the SAME watch re-derives every sweep, never a fix agent's own judgment call.
  // That must not block this gate forever the way an actual escalation does.
  // `viewerDidAuthor` is GitHub's own per-comment provenance flag from `gh pr view/list --json comments` — true
  // only for a comment the conveyor's own authenticated identity wrote.
  const watcherMarker = { body: buildStandDownComment({ actor: WATCHER_STAND_DOWN_ACTOR, reason: 'conflict' }), viewerDidAuthor: true };
  const supersede = { body: `${SUPERSEDE_STAND_DOWN_MARKER}\n\nrouted to a fix agent`, viewerDidAuthor: true };

  it('#xu2krte Fork 2 — a watcher stand-down the watch ITSELF later superseded is not terminal', () => {
    const watcherStoodDown = pr1563({ comments: [finding(), watcherMarker, supersede] });
    const plan = planReconcile({ prs: [watcherStoodDown], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals.map((r) => r.kind)).not.toContain('stood-down');
    expect(plan.dispatch.map((d) => d.kind)).toEqual(['fix']);
  });

  it('review finding 1 — a CURRENT (never superseded) watcher stand-down + an unrelated finding stays stood-down', () => {
    const stillValid = pr1563({ comments: [watcherMarker, finding()] });
    const plan = planReconcile({ prs: [stillValid], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals.map((r) => r.kind)).toEqual(['stood-down']);
  });

  it('review finding 3 — a TRUSTED-author, not-watcher-self-authored stand-down cannot escape the terminal gate', () => {
    // Trusted (the OPERATOR'S login — my broader isTrustedMarkerAuthor accepts it) but NOT self-authored under
    // stand-down.mjs's narrower isSelfAuthored (which matches AUTOMATION_LOGINS, never the operator) — so
    // neither supersede path applies and it stays an ordinary terminal stand-down.
    const trustedNotWatcherSelf = pr1563({ comments: [finding(), { body: watcherMarker.body, author: { login: 'chalbert' } }, supersede] });
    const plan = planReconcile({ prs: [trustedNotWatcherSelf], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals.map((r) => r.kind)).toEqual(['stood-down']);
  });

  // #3383 — adversarial coverage review, 2026-09-24: before THIS item's fix, a comment with no author
  // information at all (an untrusted/forged comment) STILL escaped nowhere — it counted as an ordinary
  // stand-down. Now a marker with no trusted author never counts at all, closing the forgery this item targets.
  it('#3383 — a genuinely FORGED comment (no trusted author) is never terminal, watcher-actor text or not', () => {
    const forged = pr1563({ comments: [finding(), { body: watcherMarker.body }, supersede] });
    const plan = planReconcile({ prs: [forged], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals.map((r) => r.kind)).not.toContain('stood-down');
  });

  it('the supersede comment is conveyor bookkeeping, never counted as a reviewer finding', () => {
    const onlyBookkeeping = pr1563({ comments: [watcherMarker, supersede] });
    const plan = planReconcile({ prs: [onlyBookkeeping], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(countFindings([watcherMarker, supersede])).toBe(0);
  });

  it('a fix agent\'s OWN judgment stand-down (not the watch) stays exactly as terminal as before', () => {
    const humanNeeded = pr1563({
      comments: [finding(), { body: buildStandDownComment({ actor: 'conveyor fix agent', reason: 'needs-judgment' }), author: AUTOMATION }],
    });
    const plan = planReconcile({ prs: [humanNeeded], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].kind).toBe('stood-down');
    expect(plan.dispatch).toHaveLength(0);
  });

  // xaer296 (epic #3383) — CONFIRMED LIVE on `web-everything/web-everything#2549`, 2026-09-24T14:35:41Z: a fixer
  // dispatched in ADVISORY-FIX MODE correctly found nothing to reproduce (the finding was already fixed by an
  // earlier round) and wrongly stood down anyway. `we:scripts/conveyor/advisory-fix-mark.mjs
  // #isAdvisoryMechanismStandDownSuperseded` recognizes this as a MECHANISM FAILURE the thread already proves,
  // not a genuine judgment call, and it is EXCLUDED from `countUnresolvedStandDowns` — no new comment required.
  // #3383 — a trusted author is now required for this note to count toward the advisory-fix branch's own
  // admitted-finding check (`countAdvisoryComments`), independent of the self-authored fix-mark checks below.
  const advisoryNote1563 = { body: `${ADVISORY_NOTE_MARKER}\n\nSome admitted finding text.`, author: AUTOMATION };
  const selfAuthoredFixMark = { body: buildAdvisoryFixComment({}), viewerDidAuthor: true };
  const selfAuthoredNeedsJudgmentStandDown = {
    body: buildStandDownComment({ actor: 'conveyor fix agent', reason: 'needs-judgment' }),
    viewerDidAuthor: true,
  };

  it('xaer296 — a fix agent\'s needs-judgment stand-down is NOT terminal when the thread already proves the finding was addressed first', () => {
    const pr = pr1563({
      labels: lbl('review:human', 'advisory:changes'),
      comments: [advisoryNote1563, selfAuthoredFixMark, selfAuthoredNeedsJudgmentStandDown],
    });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals.map((r) => r.kind)).not.toContain('stood-down');
    // The mark already outnumbers (postdates) the one note — falls through to the ordinary review dispatch.
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 1563 })]);
  });

  it('xaer296 — a needs-judgment stand-down posted BEFORE any fix-mark (a genuine, still-current judgment call) stays terminal', () => {
    const pr = pr1563({
      labels: lbl('review:human', 'advisory:changes'),
      comments: [advisoryNote1563, selfAuthoredNeedsJudgmentStandDown], // no fix-mark exists at all
    });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals.map((r) => r.kind)).toEqual(['stood-down']);
    expect(plan.dispatch).toHaveLength(0);
  });

  it('xaer296 — a FORGED (not self-authored) fix-mark cannot supersede the stand-down', () => {
    const pr = pr1563({
      labels: lbl('review:human', 'advisory:changes'),
      comments: [advisoryNote1563, { body: selfAuthoredFixMark.body }, selfAuthoredNeedsJudgmentStandDown],
    });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals.map((r) => r.kind)).toEqual(['stood-down']);
  });

  it('xaer296 — a fix-mark that comes AFTER the stand-down (not before) does not retroactively supersede it', () => {
    const pr = pr1563({
      labels: lbl('review:human', 'advisory:changes'),
      comments: [advisoryNote1563, selfAuthoredNeedsJudgmentStandDown, selfAuthoredFixMark],
    });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals.map((r) => r.kind)).toEqual(['stood-down']);
  });

  // xaer296 FOLLOW-UP — CONFIRMED LIVE on `web-everything/web-everything#2549`, 2026-09-24: the coordinator loaded
  // `viewerDidAuthor`-only fix into the daemon clone and ran `runReconcilePass` for REAL — it still refused
  // `stood-down` (`standDowns: 2`), because `viewerDidAuthor` reads `false` on every marker comment this repo's
  // automation posts, from BOTH a personal-token read AND the resident daemon's own real production read (its
  // discovery read never authenticates as the identity that actually posted them). This pins the fix in the
  // shape `gh pr view --json comments` ACTUALLY returns — `author.login`, no `viewerDidAuthor` at all — so a
  // regression back to a `viewerDidAuthor`-only check reddens here even though every OTHER test in this
  // describe block (which injects `viewerDidAuthor: true` directly) would stay green.
  it('xaer296 FOLLOW-UP — the REAL gh comment shape (author.login, no viewerDidAuthor field) resolves the exact same way', () => {
    const realFixMark = { author: { login: 'web-everything' }, body: buildAdvisoryFixComment({}) };
    const realStandDown = {
      author: { login: 'web-everything' },
      body: buildStandDownComment({ actor: 'conveyor fix agent', reason: 'needs-judgment' }),
    };
    const pr = pr1563({
      labels: lbl('review:human', 'advisory:changes'),
      comments: [advisoryNote1563, realFixMark, realStandDown],
    });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals.map((r) => r.kind)).not.toContain('stood-down');
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 1563 })]);
  });

  it('a human\'s own /finish stand-down (default actor) stays exactly as terminal as before', () => {
    const humanFinish = pr1563({ comments: [finding(), { body: buildStandDownComment({ reason: 'gate-red' }), author: { login: 'chalbert' } }] });
    const plan = planReconcile({ prs: [humanFinish], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals[0].kind).toBe('stood-down');
    expect(plan.dispatch).toHaveLength(0);
  });
});

// ── CASE 3 — REFUSAL 2: NO FINDINGS, NO FIXER ─────────────────────────────────────────────────────────────────
describe('case 3 — refusal 2: a PR with nothing to fix never gets a fixer (#3296)', () => {
  /** #1576 shape with successful required CI added for review eligibility. */
  const pr1576 = (over = {}) => ({
    number: 1576, state: 'OPEN',
    headRefName: 'lane/review-slice-scopes', headRefOid: '1576'.repeat(10),
    labels: lbl('review:pending', 'checking'), mergeStateStatus: 'CLEAN',
    statusCheckRollup: greenRollup, comments: [], ...over,
  });

  it('#1576 with green CI — no `fix` dispatch, and a `no-findings` refusal', () => {
    const plan = planReconcile({ prs: [pr1576()], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch.map((d) => d.kind)).not.toContain('fix');
    expect(plan.refusals.map((r) => r.kind)).toEqual(['no-findings']);
    expect(plan.refusals[0].prNumber).toBe(1576);
    expect(plan.refusals[0].findings).toBe(0);
  });

  it('the SAME fixture returns a `review` dispatch — "nothing to fix" is not "nothing to do"', () => {
    const plan = planReconcile({ prs: [pr1576()], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(1);
    expect(plan.dispatch[0].kind).toBe('review');
    expect(plan.dispatch[0].prNumber).toBe(1576);
  });

  it('a BOUNCED PR with zero findings gets NOTHING — the sharper half of the same refusal', () => {
    // A supervisor that refused to dispatch a fixer at a comment-less PR was right to refuse. Without the
    // empty-findings check this is where a fix agent gets handed a PR and invents work to justify itself.
    const plan = planReconcile({ prs: [pr1563({ comments: [] })], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals.map((r) => r.kind)).toEqual(['no-findings']);
  });

  it('the conveyor\'s OWN marker comments are not findings — three re-arms is still zero findings', () => {
    const onlyBookkeeping = pr1563({ comments: [{ body: REARM_COMMENT_MARKER, author: AUTOMATION }, { body: REARM_COMMENT_MARKER, author: AUTOMATION }] });
    expect(countFindings(onlyBookkeeping.comments)).toBe(0);
    const plan = planReconcile({ prs: [onlyBookkeeping], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0].kind).toBe('no-findings');
    expect(plan.refusals[0].comments).toBe(2); // two comments, zero findings — the distinction is the point.
  });
});

// ── CASE 4 — REFUSAL 3: THE CAP SURVIVES A RESTART, OR IT IS NOT A CAP ────────────────────────────────────────
describe('case 4 — refusal 3: the round cap is derived from the PR and ONLY from the PR (#3296)', () => {
  it('a fresh pass carrying NOTHING in refuses on the PR\'s own count', () => {
    // `durableCounts` is what the shell read back off the PR's comment thread. No in-process state exists here:
    // this pass is one-shot. #1563 ran to TWELVE rounds against a cap of 5 with a durable count of 0 — the cap
    // never bound because it was held in process memory that kept dying.
    const plan = planReconcile({ prs: [pr1563()], agents: [], durableCounts: { 1563: 5 }, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toMatchObject({ kind: 'cap-exhausted', prNumber: 1563, attempts: 5, cap: NEGOTIATION_ROUND_CAP });
  });

  it('AN IN-MEMORY TALLY CANNOT SATISFY IT — a tally of 9 on a PR whose own count is 0 still dispatches', () => {
    // The criterion is not "a cap exists", it is "the cap is PR-sourced". A pass that read a process tally would
    // refuse here, and would then reset to zero on the next restart — which is what "not a cap" means.
    const plan = planReconcile({
      prs: [pr1563()], agents: [], durableCounts: {}, now: NOW,
      attemptTally: { 1563: 9 }, // deliberately supplied, and deliberately never read.
    });
    expect(plan.refusals.map((r) => r.kind)).not.toContain('cap-exhausted');
    expect(plan.dispatch.map((d) => [d.prNumber, d.kind, d.attempts])).toEqual([[1563, 'fix', 0]]);
  });

  it('the PR\'s own re-arm comments bind the cap even when the shell supplied no map at all', () => {
    const burned = pr1563({ comments: [finding(), ...Array.from({ length: 5 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }))] });
    const plan = planReconcile({ prs: [burned], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals[0]).toMatchObject({ kind: 'cap-exhausted', attempts: 5 });
  });

  // #3383 — THE PR #2117 / #2298 REGRESSION. A `bounced` PR that ALSO carries `review:human` can run round
  // after round without ever completing a repair-and-rearm cycle (the fix keeps failing/stalling), so it never
  // posts a `REARM_COMMENT_MARKER` comment no matter how many rounds actually run — `countRearmComments` alone
  // stays at 0 forever for this population. Confirmed live on `#2117`: 33 advisory-panel comments against the
  // identical findings, 2026-09-15T00:24Z through 19:13Z, roughly every 20-90 minutes, no end condition — and a
  // further burst on `#2298`. What DOES post once per completed round is the advisory comment itself
  // (`ADVISORY_NOTE_MARKER`, `we:scripts/operations/review-pr.mjs#renderAdvisoryNote`) — this pins that counting
  // THOSE is what makes the cap actually bind for this population, with NO durableCounts map supplied at all
  // (mirrors the case above's own "the PR's own re-arm comments bind the cap even when the shell supplied no
  // map at all").
  it('#3383 — PR #2117/#2298 regression: repeated advisory-panel comments alone (never a re-arm marker) still trip the cap on a review:human PR', () => {
    const advisoryRound = (n) => ({ body: `${ADVISORY_NOTE_MARKER} round ${n} — no commits changed since the last one`, author: AUTOMATION });
    const burned = pr1563({
      labels: lbl('review:changes', 'review:human'),
      comments: [finding(), ...Array.from({ length: 5 }, (_, i) => advisoryRound(i + 1))],
    });
    const plan = planReconcile({ prs: [burned], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({ kind: 'cap-exhausted', attempts: 5, cap: NEGOTIATION_ROUND_CAP });
  });

  it('#3383 — advisory rounds one below the cap still dispatch — the fix does not over-tighten the cap', () => {
    const advisoryRound = (n) => ({ body: `${ADVISORY_NOTE_MARKER} round ${n}`, author: AUTOMATION });
    const notYetBurned = pr1563({
      labels: lbl('review:changes', 'review:human'),
      comments: [finding(), ...Array.from({ length: NEGOTIATION_ROUND_CAP - 1 }, (_, i) => advisoryRound(i + 1))],
    });
    const plan = planReconcile({ prs: [notYetBurned], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', prNumber: 1563, attempts: NEGOTIATION_ROUND_CAP - 1 })]);
  });

  it('one attempt below the cap still dispatches — the cap binds AT the cap, not before it', () => {
    const plan = planReconcile({ prs: [pr1563()], agents: [], durableCounts: { 1563: 4 }, now: NOW });
    expect(plan.dispatch.map((d) => d.attempts)).toEqual([4]);
  });

  // xpprcdz — a PR that is `review:human` FROM OPEN (no `review:changes`, no `review:pending`) previously
  // refused as `owed-elsewhere` and was NEVER dispatched at all, so `we:scripts/operations/review-pr.mjs`'s own
  // `advise` step — built specifically for this population — never ran. Live-caught 2026-09-23: PR #2486 and
  // #2492 sat with zero advisory-panel comments and no status label, indistinguishable from "nobody has looked"
  // versus "an advisory pass already ran and found nothing new". `needs-human` now dispatches `review` too —
  // `review-pr.mjs`'s `confirm` step still suspends on an operator, so this never clears the human gate; only
  // `advise` (a comment plus an `advisory:*` label) runs unattended.
  it('xpprcdz — a PURE review:human PR (no review:changes, no review:pending) with a finding now dispatches `review`, not `owed-elsewhere`', () => {
    const humanFromOpen = pr1563({ labels: lbl('review:human') });
    const plan = planReconcile({ prs: [humanFromOpen], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 1563, phase: 'needs-human' })]);
    expect(plan.refusals).toHaveLength(0);
  });

  it('xpprcdz — the SAME round cap that binds a bounced+review:human PR also binds a PURE review:human one — advisory comments above the cap trip it', () => {
    const advisoryRound = (n) => ({ body: `${ADVISORY_NOTE_MARKER} round ${n} — no commits changed since the last one`, author: AUTOMATION });
    const burned = pr1563({
      labels: lbl('review:human'),
      comments: [finding(), ...Array.from({ length: NEGOTIATION_ROUND_CAP + 1 }, (_, i) => advisoryRound(i + 1))],
    });
    const plan = planReconcile({ prs: [burned], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({ kind: 'cap-exhausted', attempts: NEGOTIATION_ROUND_CAP + 1, cap: NEGOTIATION_ROUND_CAP });
  });

  it('xpprcdz — review:accepted supersedes review:human (classifyPr\'s own rule) — an already-cleared PR is not re-dispatched as needs-human', () => {
    const cleared = pr1563({ labels: lbl('review:human', 'review:accepted') });
    const plan = planReconcile({ prs: [cleared], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch.map((d) => d.kind)).not.toContain('review');
  });
});

// ── CASE 5 — REFUSAL 4: LIVENESS COMES FROM A LIVE PROCESS ────────────────────────────────────────────────────
describe('case 5 — refusal 4: liveness from a live PROCESS, and the listing is thinner than it looks (#3296)', () => {
  const SHA = pr1563().headRefOid;

  it('5(a) a LIVE pid refuses — however stale the transcript is (211 h stale here)', () => {
    // Freshness never grants liveness, and STALENESS NEVER WITHDRAWS IT. A transcript stops being written when
    // an agent FINISHES exactly as when it dies, so a 211-hour-old transcript says nothing about the process.
    const agents = [{ sessionId: 's-a', cwd: '/lanes/lane-37', pid: 18278, pidAlive: true, laneHeadOid: SHA }];
    const plan = planReconcile({ prs: [pr1563({ transcriptMtimeMs: STALE_MTIME })], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toMatchObject({ kind: 'live-process', pid: 18278, prNumber: 1563 });
  });

  it('5(b) a session blocked on a PERMISSION PROMPT refuses under its OWN kind, and is SURFACED', () => {
    // The fifth state: neither alive nor dead. Three sessions have held one for 211.4 h. Folded into
    // `live-process` it reads as "busy" and stays invisible for another 211 hours.
    const agents = [{
      sessionId: 's-b', cwd: '/lanes/lane-31', pid: 32933, pidAlive: true, laneHeadOid: SHA,
      status: 'waiting', waitingFor: 'permission prompt', startedAt: BLOCKED_SINCE,
    }];
    const plan = planReconcile({ prs: [pr1563({ transcriptMtimeMs: STALE_MTIME })], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0].kind).toBe('awaiting-permission');
    expect(plan.refusals[0].kind).not.toBe('live-process'); // outranks a live pid ON PURPOSE.
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toMatchObject({ kind: 'awaiting-permission', prNumber: 1563, heldHours: 211.4 });
    expect(plan.notes[0].text).toContain('nobody is there to answer it');
  });

  it('5(b\u2032) the SAME block, with `startedAt` in the shape the tool really returns — an epoch NUMBER', () => {
    // Measured off a live listing: `startedAt` comes back as `1787004649412`, and `Date.parse` of that is NaN.
    // A parser that accepted only the ISO string would compute NO age — silently dropping the one figure that
    // makes a 217-hour block impossible to overlook, while every other assertion stayed green.
    const agents = [{
      sessionId: 's-b2', cwd: '/lanes/lane-31', pid: 18278, pidAlive: true, laneHeadOid: SHA,
      status: 'waiting', waitingFor: 'permission prompt', startedAt: BLOCKED_SINCE_EPOCH,
    }];
    const plan = planReconcile({ prs: [pr1563({ transcriptMtimeMs: STALE_MTIME })], agents, durableCounts: {}, now: NOW });
    expect(plan.refusals[0].kind).toBe('awaiting-permission');
    expect(plan.notes[0].heldHours).toBe(211.4);          // NOT null — the whole point of this case.
    expect(plan.notes[0].text).toContain('211.4h');
  });

  it('`startedAt` is read in every shape the listing produces, and unreadable ones do not throw', () => {
    expect(startedAtMs(BLOCKED_SINCE_EPOCH)).toBe(BLOCKED_SINCE_EPOCH);
    expect(startedAtMs('2026-08-17T22:10:49.412Z')).toBe(BLOCKED_SINCE_EPOCH);
    expect(startedAtMs(String(BLOCKED_SINCE_EPOCH))).toBe(BLOCKED_SINCE_EPOCH); // a numeric STRING is an epoch too
    expect(startedAtMs(null)).toBeNaN();
    expect(startedAtMs(undefined)).toBeNaN();
    expect(startedAtMs('not a date')).toBeNaN();
  });

  it('an unreadable `startedAt` still SURFACES the block — it just cannot age it', () => {
    // The note is the point; the hour count is the detail. Losing the detail must never lose the note.
    const agents = [{
      sessionId: 's-b3', cwd: '/lanes/lane-31', pid: 18278, pidAlive: true, laneHeadOid: SHA,
      status: 'waiting', waitingFor: 'permission prompt',
    }];
    const plan = planReconcile({ prs: [pr1563()], agents, durableCounts: {}, now: NOW });
    expect(plan.refusals[0].kind).toBe('awaiting-permission');
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0].heldHours).toBeNull();
    expect(plan.notes[0].text).toContain('nobody is there to answer it');
  });

  it('5(c) NO agent entry plus a FRESH transcript still DISPATCHES — no timestamp grants liveness', () => {
    // THE MUTATION TARGET. A pass that accepted a fresh mtime as liveness reddens exactly here and nowhere else.
    const plan = planReconcile({ prs: [pr1563({ transcriptMtimeMs: FRESH_MTIME })], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals).toHaveLength(0);
    expect(plan.dispatch.map((d) => d.kind)).toEqual(['fix']);
    // The mtime rides along as EVIDENCE and is reported — it is just never authoritative.
    expect(plan.dispatch[0].transcriptMtimeMs).toBe(FRESH_MTIME);
  });

  it('5(d) a bound entry with NO `pid` refuses as UNKNOWN, not as idle — with the bind evidence attached', () => {
    // `pid` is on 13 of 17 entries. Absence of a field is not evidence of death, and the binding itself is a
    // proxy that has been observed to be WRONG (it bound the preparing session to #1571 at 17:34Z), so the
    // refusal carries the `cwd` and sha it turned on and a reader can audit the bind rather than inherit it.
    const agents = [{ sessionId: 's-d', cwd: '/lanes/lane-39', laneHeadOid: SHA, kind: 'conveyor', name: 'ci-heal' }];
    const plan = planReconcile({ prs: [pr1563({ transcriptMtimeMs: STALE_MTIME })], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({
      kind: 'liveness-unknown', prNumber: 1563, pid: null, cwd: '/lanes/lane-39', sha: SHA,
    });
  });

  it('a PROVABLY dead pid is not a blocker — `pidAlive:false` is the only thing that clears the way', () => {
    const agents = [{ sessionId: 's-e', cwd: '/lanes/lane-40', pid: 4242, pidAlive: false, laneHeadOid: SHA }];
    const plan = planReconcile({ prs: [pr1563({ transcriptMtimeMs: STALE_MTIME })], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch.map((d) => d.kind)).toEqual(['fix']);
  });

  it('a FINISHED session is not a blocker even with a live pid — a completed agent\'s pid can be recycled into a warm bg-spare pool rather than exit (live-caught #3876, PR #2461, 2026-09-22)', () => {
    // `claude agents --json` reported `{state:'done', status:'idle'}` for review-2461 while its OS pid (probed by
    // `process.kill(pid,0)`) was STILL alive — reused for a wholly unrelated later task. `pidAlive===true` alone
    // used to be read as "something is still working this PR" regardless of the agent's own reported state,
    // which meant a PR whose reviewer session had already finished stayed refused as `live-process` forever: the
    // pid never goes on to probe dead, since it is a real live process, just not this PR's anymore.
    const agents = [{ sessionId: 's-done', cwd: '/lanes/lane-40', pid: 16562, pidAlive: true, laneHeadOid: SHA, status: 'idle', state: 'done' }];
    const plan = planReconcile({ prs: [pr1563({ transcriptMtimeMs: STALE_MTIME })], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch.map((d) => d.kind)).toEqual(['fix']);
  });

  it('the binding needs BOTH shas — two unknowns are not a match', () => {
    expect(bindAgents({ headRefOid: '' }, [{ cwd: '/x', laneHeadOid: '' }])).toEqual([]);
    expect(bindAgents({ headRefOid: SHA }, [{ cwd: '/x' }])).toEqual([]);
    expect(bindAgents({ headRefOid: SHA }, [{ cwd: '/x', laneHeadOid: SHA }])).toHaveLength(1);
  });

  it('the fifth state is recognised by status+waitingFor, and nothing else is mistaken for it', () => {
    expect(isAwaitingPermission({ status: 'waiting', waitingFor: 'permission prompt' })).toBe(true);
    expect(isAwaitingPermission({ status: 'waiting', waitingFor: 'a subagent' })).toBe(false);
    expect(isAwaitingPermission({ status: 'running' })).toBe(false);
    expect(isAwaitingPermission({})).toBe(false);
  });

  it('worst-first across MANY bound sessions — lane-35 held two at 17:34Z (#3283 observed live)', () => {
    const agents = [
      { sessionId: 's-live', cwd: '/lanes/lane-35', pid: 100, pidAlive: true, laneHeadOid: SHA },
      { sessionId: 's-blocked', cwd: '/lanes/lane-35', pid: 101, pidAlive: true, laneHeadOid: SHA, status: 'waiting', waitingFor: 'permission prompt', startedAt: BLOCKED_SINCE },
    ];
    expect(assessLiveness(bindAgents(pr1563(), agents)).kind).toBe('awaiting-permission');
  });
});

// ── CASE 5b — THE NAME-BASED BIND: A REVIEW DISPATCH THE cwd/oid RULE CANNOT EVER CATCH (#3437) ─────────────────
describe('case 5b — refusal 4, name-based bind: a review session the cwd/oid rule cannot catch (#3437)', () => {
  /** #1576 re-armed `review:changes → review:pending` — one prior finding, one re-arm marker; label back to
   *  `review:pending`. Mirrors the real PR (`#1765`) whose re-arm round is what let the bug run seven ticks. */
  const rearmed1576 = (over = {}) => ({
    number: 1576, state: 'OPEN',
    headRefName: 'lane/review-slice-scopes', headRefOid: '1576'.repeat(10),
    labels: lbl('review:pending', 'checking'), mergeStateStatus: 'CLEAN',
    statusCheckRollup: greenRollup, comments: [{ body: REARM_COMMENT_MARKER }], ...over,
  });

  it('bindAgents matches on session NAME alone — cwd/oid deliberately NOT matching', () => {
    const agents = [{
      sessionId: 's-review', cwd: '/Users/op/workspace/webeverything', pid: 4242, pidAlive: true,
      laneHeadOid: 'deadbeef'.repeat(5), // the PRIMARY checkout's HEAD — never the PR's headRefOid.
      name: reviewSessionSlug(1576),
    }];
    const bound = bindAgents(rearmed1576(), agents);
    expect(bound).toHaveLength(1);
    expect(bound[0].agent.sessionId).toBe('s-review');
    // `sha` is the PR's OWN headRefOid regardless of which path matched — it never equals the agent's
    // `laneHeadOid` here, which is exactly the point: path 1 did NOT match; path 2 (the name) did.
    expect(bound[0].sha).toBe(rearmed1576().headRefOid);
    expect(bound[0].agent.laneHeadOid).not.toBe(bound[0].sha);
  });

  it('a session named for a DIFFERENT PR does not bind — the slug is PR-specific', () => {
    const agents = [{ sessionId: 's-other', cwd: '/x', pid: 1, pidAlive: true, name: reviewSessionSlug(9999) }];
    expect(bindAgents(rearmed1576(), agents)).toEqual([]);
  });

  it('THE FIX: re-armed, fed through planReconcile TWICE, dispatches review exactly ONCE — the second call refuses `live-process`', () => {
    // Round 1: nothing live yet — the PR is owed a review and gets exactly one dispatch.
    const round1 = planReconcile({ prs: [rearmed1576()], agents: [], durableCounts: {}, now: NOW });
    expect(round1.dispatch).toHaveLength(1);
    expect(round1.dispatch[0]).toMatchObject({ kind: 'review', prNumber: 1576 });

    // That dispatch spawns a `review-1576`-named session in the PRIMARY checkout (never the lane it later
    // acquires for itself) — exactly the shape that made the pre-fix cwd/oid bind miss it on every later tick.
    const agents = [{
      sessionId: 's-review', cwd: '/Users/op/workspace/webeverything', pid: 4242, pidAlive: true,
      laneHeadOid: 'deadbeef'.repeat(5), name: reviewSessionSlug(1576),
    }];
    const round2 = planReconcile({ prs: [rearmed1576()], agents, durableCounts: {}, now: NOW });
    expect(round2.dispatch).toHaveLength(0);
    expect(round2.refusals).toMatchObject([{ kind: 'live-process', prNumber: 1576, pid: 4242 }]);
    // The refused session's `cwd` is the PRIMARY checkout, never a lane whose HEAD equals this PR's sha —
    // proof the bind that caught it was the NAME path, not the cwd/oid one.
    expect(round2.refusals[0].cwd).toBe('/Users/op/workspace/webeverything');
  });

  it('a review dispatch that IS dead (`pidAlive:false`) does not block a re-dispatch', () => {
    const agents = [{
      sessionId: 's-dead', cwd: '/Users/op/workspace/webeverything', pid: 4242, pidAlive: false,
      laneHeadOid: 'deadbeef'.repeat(5), name: reviewSessionSlug(1576),
    }];
    const plan = planReconcile({ prs: [rearmed1576()], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(1);
    expect(plan.dispatch[0].kind).toBe('review');
  });

  it('the two bind paths union rather than double-count a session that happens to satisfy both', () => {
    const sha = pr1563().headRefOid;
    const agents = [{
      sessionId: 's-both', cwd: '/lanes/lane-9', pid: 7, pidAlive: true, laneHeadOid: sha,
      name: reviewSessionSlug(1563),
    }];
    expect(bindAgents(pr1563(), agents)).toHaveLength(1);
  });
});

// ── CASE 5c — REFUSAL 4, NAME-BASED BIND FOR A FIX SESSION (#3438) ─────────────────────────────────────────────
// Mirrors case 5b exactly, one dispatch kind over: a fix agent commits in its acquired lane before it pushes, so
// its lane HEAD diverges from the still-unpushed `pr.headRefOid` right when it starts real work — the SAME
// #3437 blind spot, recurring for `kind:'fix'` unless `bindAgents` also matches `fix-<pr>` by name.
describe('case 5c — refusal 4, name-based bind: a fix session the cwd/oid rule cannot catch (#3438)', () => {
  it('bindAgents matches a live fix session on NAME alone — cwd/oid deliberately NOT matching', () => {
    const agents = [{
      sessionId: 's-fix', cwd: '/lanes/lane-4', pid: 5150, pidAlive: true,
      laneHeadOid: 'deadbeef'.repeat(5), // the fix agent's OWN post-commit lane HEAD, never the PR's headRefOid.
      name: sessionSlugFor(1563, 'fix'),
    }];
    const bound = bindAgents(pr1563(), agents);
    expect(bound).toHaveLength(1);
    expect(bound[0].agent.sessionId).toBe('s-fix');
    expect(bound[0].agent.laneHeadOid).not.toBe(bound[0].sha);
  });

  it('THE FIX: a bounced PR fed through planReconcile TWICE with a live fix session dispatches exactly ONCE', () => {
    const round1 = planReconcile({ prs: [pr1563()], agents: [], durableCounts: {}, now: NOW });
    expect(round1.dispatch).toHaveLength(1);
    expect(round1.dispatch[0]).toMatchObject({ kind: 'fix', prNumber: 1563 });

    const agents = [{
      sessionId: 's-fix', cwd: '/lanes/lane-4', pid: 5150, pidAlive: true,
      laneHeadOid: 'deadbeef'.repeat(5), name: sessionSlugFor(1563, 'fix'),
    }];
    const round2 = planReconcile({ prs: [pr1563()], agents, durableCounts: {}, now: NOW });
    expect(round2.dispatch).toHaveLength(0);
    expect(round2.refusals).toMatchObject([{ kind: 'live-process', prNumber: 1563, pid: 5150 }]);
  });

  it('a `fix-<pr>` session for a DIFFERENT PR does not bind — the slug is PR-specific, same as the review slug', () => {
    const agents = [{ sessionId: 's-other', cwd: '/x', pid: 1, pidAlive: true, name: sessionSlugFor(9999, 'fix') }];
    expect(bindAgents(pr1563(), agents)).toEqual([]);
  });
});

// ── CASE 5d — REFUSAL 4, NAME-BASED BIND FOR A CI-HEAL SESSION (#3967 multi-repo slice 7) ───────────────────────
// Mirrors case 5c exactly, one dispatch kind over: a CI-heal agent rebases in its acquired lane before it
// re-pushes, so its lane HEAD diverges from the still-red PR's `headRefOid` right when it starts real work —
// the SAME #3437 blind spot, recurring for `kind:'ci-heal'` unless `bindAgents` also matches `ci-heal-<pr>`.
describe('case 5d — refusal 4, name-based bind: a ci-heal session the cwd/oid rule cannot catch (#3967)', () => {
  const prRed = (over = {}) => pr1563({
    number: 2601, labels: [], statusCheckRollup: redRollup, comments: [], ...over,
  });

  it('bindAgents matches a live ci-heal session on NAME alone — cwd/oid deliberately NOT matching', () => {
    const agents = [{
      sessionId: 's-heal', cwd: '/lanes/lane-9', pid: 6161, pidAlive: true,
      laneHeadOid: 'cafebabe'.repeat(4), // the heal agent's OWN post-rebase lane HEAD, never the PR's headRefOid.
      name: sessionSlugFor(2601, 'ci-heal'),
    }];
    const bound = bindAgents(prRed(), agents);
    expect(bound).toHaveLength(1);
    expect(bound[0].agent.sessionId).toBe('s-heal');
    expect(bound[0].agent.laneHeadOid).not.toBe(bound[0].sha);
  });

  it('THE FIX: a red-CI PR fed through planReconcile TWICE with a live ci-heal session dispatches exactly ONCE', () => {
    const round1 = planReconcile({ prs: [prRed()], agents: [], now: NOW });
    expect(round1.dispatch).toHaveLength(1);
    expect(round1.dispatch[0]).toMatchObject({ kind: 'ci-heal', prNumber: 2601 });

    const agents = [{
      sessionId: 's-heal', cwd: '/lanes/lane-9', pid: 6161, pidAlive: true,
      laneHeadOid: 'cafebabe'.repeat(4), name: sessionSlugFor(2601, 'ci-heal'),
    }];
    const round2 = planReconcile({ prs: [prRed()], agents, now: NOW });
    expect(round2.dispatch).toHaveLength(0);
    expect(round2.refusals).toMatchObject([{ kind: 'live-process', prNumber: 2601, pid: 6161 }]);
  });

  it('a `ci-heal-<pr>` session for a DIFFERENT PR does not bind — the slug is PR-specific', () => {
    const agents = [{ sessionId: 's-other', cwd: '/x', pid: 1, pidAlive: true, name: sessionSlugFor(9999, 'ci-heal') }];
    expect(bindAgents(prRed(), agents)).toEqual([]);
  });
});

// ── CASE 5e — CI-HEAL DISPATCH AND ITS OWN DURABLE CAP (#3967 multi-repo slice 7) ───────────────────────────────
// `ci-red` used to be a wholesale `owed-elsewhere` refusal ("the conveyor tick plans CI-heals, this pass does
// not") — the WE-only, session-ephemeral `planTick`/`planCiHealSpawns` path. This pass now plans a durable,
// repo-agnostic `ci-heal` dispatch instead, capped by `countCiHealComments` (the SAME restart-surviving marker
// count `we:scripts/conveyor/ci-heal-mark.mjs` already defines for the tick's own path) — never `roundCap`'s
// rearm/advisory counters, and never the reviewer-`findings` check (a red check needs no reviewer thread).
describe('case 5e — ci-heal dispatch, capped by the durable heal-mark count, not `roundCap` (#3967)', () => {
  const prRed = (over = {}) => pr1563({
    number: 2602, labels: [], statusCheckRollup: redRollup, comments: [], ...over,
  });

  it('a red-CI PR with nothing live and zero prior heals is dispatched `ci-heal`, not refused `owed-elsewhere`', () => {
    const plan = planReconcile({ prs: [prRed()], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2602, attempts: 0 })]);
  });

  it('a red-CI PR is dispatched regardless of `review:changes` findings — the reviewer-findings check never applies to ci-heal', () => {
    // Would hit REFUSAL 2 (`no-findings`) under the fix/review table; ci-heal has no such gate.
    const plan = planReconcile({ prs: [prRed({ comments: [] })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2602 })]);
  });

  // LIVE INCIDENT 2026-10-04, PR #3833 (web-everything/web-everything): `review:human` + `ci:failed`, a red required
  // `test` that was NOT this PR's own code. `classifyPr` ranks `review:human` ('needs-human') ABOVE `ci-red`, so
  // this branch never ran: the PR logged "owed a ci-heal" for 9 hours and no ci-heal was ever planned. A CI
  // repair is not a review decision — the human hold must not exclude it.
  it('a `review:human` PR with a red required check IS dispatched `ci-heal` (a CI repair is not a review decision)', () => {
    const plan = planReconcile({ prs: [prRed({ labels: lbl('review:human', 'ci:failed') })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2602, attempts: 0 })]);
    expect(plan.refusals.filter((r) => r.kind === 'review-ci')).toEqual([]);
  });

  it('a `review:human` PR whose red check is ONLY review-gate is still not healed', () => {
    const plan = planReconcile({
      prs: [prRed({ labels: lbl('review:human'), statusCheckRollup: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }] })],
      agents: [], now: NOW, requiredChecks: ['review-gate'],
    });
    expect(plan.dispatch.filter((d) => d.kind === 'ci-heal')).toEqual([]);
  });

  it('a `review:human` PR at the heal cap surfaces `ci-heal-exhausted`, never a silent stall', () => {
    const comments = Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const plan = planReconcile({ prs: [prRed({ labels: lbl('review:human'), comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.notes).toEqual([expect.objectContaining({ kind: 'ci-heal-exhausted', prNumber: 2602 })]);
  });

  it(`the durable heal-mark count is read from the PR's OWN comments — ${CI_HEAL_ROUND_CAP - 1} prior heals still dispatches`, () => {
    const comments = Array.from({ length: CI_HEAL_ROUND_CAP - 1 }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    expect(comments[0].body.startsWith(CI_HEAL_COMMENT_MARKER)).toBe(true);
    const plan = planReconcile({ prs: [prRed({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', attempts: CI_HEAL_ROUND_CAP - 1 })]);
  });

  it(`AT the cap (${CI_HEAL_ROUND_CAP} durable heal-mark comments) the PR is refused \`cap-exhausted\`, never re-dispatched`, () => {
    const comments = Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const plan = planReconcile({ prs: [prRed({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', prNumber: 2602, attempts: CI_HEAL_ROUND_CAP, cap: CI_HEAL_ROUND_CAP })]);
  });

  it('a caller-supplied `ciHealCap` overrides the default — one prior heal already exhausts a cap of 1', () => {
    const comments = [{ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }];
    const plan = planReconcile({ prs: [prRed({ comments })], agents: [], now: NOW, ciHealCap: 1 });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 1 })]);
  });

  it('a REARM/advisory comment count never leaks into the ci-heal cap — the two caps are independent floors', () => {
    // `roundCap` defaults to `NEGOTIATION_ROUND_CAP` (5); flood the thread with REARM markers (the fix/review
    // cap's own source) and confirm ci-heal is still owed at attempts:0 — it reads its OWN marker, not this one.
    const comments = Array.from({ length: NEGOTIATION_ROUND_CAP + 2 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({ prs: [prRed({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', attempts: 0 })]);
  });

  it('DISPATCH_KINDS includes `ci-heal` — every dispatch this pass ever returns has a named kind', () => {
    expect(DISPATCH_KINDS).toContain('ci-heal');
    const plan = planReconcile({ prs: [prRed()], agents: [], now: NOW });
    for (const d of plan.dispatch) expect(DISPATCH_KINDS).toContain(d.kind);
  });
});

// we:backlog/x5uqim1-*.md (#4075/#3383) — LIVE INCIDENT 2026-09-25: a `ci-red` PR whose required check failed
// only because `origin/main`'s own CI was red at that moment must refuse `owed-ci-rerun`, never dispatch
// `ci-heal` — a heal agent would "repair" code that was never broken. Fixture shapes measured live off
// `web-everything/web-everything`: PR #2635 (33 commits behind main, never refreshed, failed inside main's real
// 01:30:55Z–02:31:25Z red window) and PR #2596 (`ahead_by: 0` — the operator's own manual branch refresh, still
// red) — see `main-red-recovery.test.mjs` for the same real window, and that module's own file header for why a
// rebase onto main (not a `gh run rerun`) is the real mechanism.
// #xznd5za (epic #3383/#4075) — LIVE INCIDENT 2026-09-25: `web-everything/web-everything#2636`'s required check
// `test-shard (1)` concluded CANCELLED (the daemon's own hung-ci-recovery cancel, applied only once its OWN
// hung-recovery cap was exhausted — never re-run). `we:scripts/progress-board.mjs#ciFailed` used to hand-roll a
// conclusion list that OMITTED `CANCELLED`, so `classifyPr` (this file's ONLY source of `phase` — see the file
// header) read this PR as `'open'`, never `'ci-red'` — the whole ci-heal branch below, dispatch AND
// cap-exhausted escalation alike, was skipped entirely and the PR fell through to `nothing-owed` forever, even
// though `we:scripts/conveyor/main-red-recovery.mjs`'s own attribution (fed by the ALREADY-correct
// `we:scripts/merge-ai-prs.mjs#isRequiredCheckFailed`) independently confirmed "required check failed … owed a
// ci-heal, not a rebase" on the very same tick. This fixture is the REAL rollup read live off PR #2636 via `gh
// pr view 2636 --repo web-everything/web-everything --json statusCheckRollup,comments` at the moment of the incident.
describe('case 5h — a CANCELLED required check reads ci-red and is ci-healed, never nothing-owed (#xznd5za, PR #2636 real shape)', () => {
  const pr2636CancelledRollup = [
    { __typename: 'CheckRun', name: 'test-shard (1)', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { __typename: 'CheckRun', name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'test-shard (2)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'test-shard (3)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'test-shard (4)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  const pr2636 = (over = {}) => pr1563({
    number: 2636, labels: lbl('ci:failed'), mergeStateStatus: 'BLOCKED',
    statusCheckRollup: pr2636CancelledRollup, comments: [], ...over,
  });

  it('RED (the live bug, reproduced): before the fix this PR read phase `open` and was refused `nothing-owed` — pinned so a regression is caught even if `classifyPr` itself is never touched again', () => {
    // Pins the FULL live symptom this incident actually showed: a `ci:failed`-labelled, required-check-failing
    // PR that this pass nonetheless has NO opinion about. Asserting the fixed behaviour (below) already covers
    // the regression; this case additionally documents, in the plan's own vocabulary, what the pre-fix output
    // looked like — `nothing-owed` must never again be the verdict for a PR whose rollup carries a real failing
    // conclusion, cancelled or otherwise.
    const plan = planReconcile({ prs: [pr2636()], agents: [], now: NOW });
    expect(plan.refusals.map((r) => r.kind)).not.toContain('nothing-owed');
  });

  it('under the cap: dispatches `ci-heal`, exactly PR #2636\'s real live count (2 of 3) at the moment of the incident', () => {
    const comments = Array.from({ length: 2 }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const plan = planReconcile({ prs: [pr2636({ comments })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2636, attempts: 2 })]);
    expect(plan.dispatch[0].phase).toBe('ci-red');
  });

  it(`AT the cap (${CI_HEAL_ROUND_CAP} durable heal-mark comments): refused \`cap-exhausted\` AND escalated visibly — never silently \`nothing-owed\``, () => {
    const comments = Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const plan = planReconcile({ prs: [pr2636({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'cap-exhausted', prNumber: 2636, attempts: CI_HEAL_ROUND_CAP, cap: CI_HEAL_ROUND_CAP, phase: 'ci-red',
    })]);
    // THE ESCALATION (#xznd5za) — a capped ci-red PR must be surfaced, not merely refused. The note's own text
    // carries the literal phrase an operator/escalation-reader searches for.
    expect(plan.notes).toEqual([expect.objectContaining({
      kind: 'ci-heal-exhausted', prNumber: 2636, attempts: CI_HEAL_ROUND_CAP, cap: CI_HEAL_ROUND_CAP,
    })]);
    expect(plan.notes[0].text).toMatch(/ci-heal attempts exhausted/);
  });
});

// #2748 false-red follow-up (soak-replay-gate, PR #2775) — LIVE INCIDENT 2026-09-26: `chalbert/web-
// everything#2748`'s real rollup (`gh pr view 2748 --repo web-everything/web-everything --json statusCheckRollup`)
// has every REQUIRED check (`test`/`smoke`/`daemon-soak`) green, and the ONLY red check is the brand-new
// advisory `soak-replay-gate` (PR #2775) — an advisory check `classifyPr`'s exclusion list did not yet know
// about. This read `phase: 'ci-red'` and kept a `ci-heal-2748` session dispatched against a PR with nothing a
// ci-heal could repair — pure waste, and it blocked landing. Passing `requiredChecks` (branch protection's own
// required set, fetched + cached by `we:scripts/lib/required-status-checks.mjs`) fixes this STRUCTURALLY: only
// a check IN that set can make `phase` read `ci-red`, so the NEXT advisory workflow someone adds can never
// reproduce this by construction, with no exclusion-list update required.
describe('case 5j — requiredChecks makes a NEW advisory check\'s red never read ci-red (PR #2748 real shape)', () => {
  // `status: 'COMPLETED'` on every row matches the real `gh pr view --json statusCheckRollup` shape — without
  // it `reduceCheckState` (evidence only, carried as `check` on every row) reads an incomplete-looking rollup
  // as still running; irrelevant to `phase` (which `ciFailed` alone decides) but kept realistic here anyway.
  const pr2748Rollup = [
    { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'soak-replay-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'test-shard (1)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'test-shard (2)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'test-shard (3)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'test-shard (4)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'daemon-soak', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  const REQUIRED_CHECKS = ['test', 'smoke', 'daemon-soak'];
  // `review:accepted` + `ready-to-merge` (→ phase `queued` once CI truly reads clean) isolates the ci-red
  // question from the unrelated `needs-review`/`review` dispatch branch a `review:pending` label would also
  // exercise — the real PR #2748 carries `review:pending` too, but that is a SEPARATE fact this case does not
  // need to also assert on.
  const pr2748 = (over = {}) => pr1563({
    number: 2748, labels: lbl('review:accepted', 'ready-to-merge'), mergeStateStatus: 'CLEAN',
    statusCheckRollup: pr2748Rollup, comments: [], ...over,
  });

  // The LIVE bug (before EITHER half of this fix) was `ciFailed`'s exclusion list not yet knowing
  // `soak-replay-gate`'s name at all — reproduced directly against `we:scripts/progress-board.mjs#ciFailed`
  // in `progress-board.test.mjs`. Both halves of the fix land in the SAME PR, so by the time `planReconcile`
  // is exercised here even the no-`requiredChecks` default path (now that `CI_TRUTH_EXCLUDED_CHECKS` itself
  // carries `soak-replay-gate`, belt-and-suspenders for every call site that never wires a required set
  // through) already reads this correctly — asserted below alongside the `requiredChecks`-aware path, which
  // is the one call site actually wired end-to-end (`reconcile-pass.mjs` → `planReconcile`) and the one that
  // remains correct even against a FUTURE advisory check nobody has added to the exclusion list yet.
  it('with no requiredChecks (the exclusion-list default, now carrying soak-replay-gate too): never ci-red', () => {
    const plan = planReconcile({ prs: [pr2748()], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'nothing-owed', phase: 'queued', prNumber: 2748 })]);
  });

  it('FIXED, and future-proof: with requiredChecks supplied, an all-green required set never reads ci-red — nothing owed here', () => {
    const plan = planReconcile({ prs: [pr2748()], agents: [], now: NOW, requiredChecks: REQUIRED_CHECKS });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'nothing-owed', phase: 'queued', prNumber: 2748 })]);
  });

  it('a REAL required-check failure alongside the same advisory red still reads ci-red and is ci-healed', () => {
    const rollupWithRealFailure = [
      ...pr2748Rollup.filter((c) => c.name !== 'test'),
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    const plan = planReconcile({
      prs: [pr2748({ statusCheckRollup: rollupWithRealFailure, labels: lbl('ci:failed') })],
      agents: [], now: NOW, requiredChecks: REQUIRED_CHECKS,
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2748, phase: 'ci-red' })]);
  });
});

// we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — LIVE INCIDENT, web-everything/web-everything: of
// ~10 ci-heal sessions dispatched inside one hour, 7 (PRs #2782/#2778/#2772/#2779/…) ended "no change needed".
// Real measured shape (`gh api repos/web-everything/web-everything/branches/main/protection`, `gh run list --branch
// main`, `gh api .../commits/<sha>/check-runs` on each PR's own pre-heal commit): `main`'s own red window ran
// 2026-09-26T23:03:09Z (first concluded `failure`) to 2026-09-27T00:49:15Z (the run that finally concluded
// `success`) — the fix (PR #2780/#4247) MERGED at 00:38Z, but CI itself did not CONFIRM green until 00:49:15Z.
// PR #2782's `test` check had concluded `FAILURE` at 00:04:00Z (inside that window) on its PRE-rebase commit —
// squarely `main`'s own fault. `ci-red-recovery-watch.mjs`'s mechanical rebase then did its job: pushed a new
// head onto the recovered `main` and re-triggered CI — but the durable `ci:failed` label `merge-ai-prs.mjs`'s
// own ci-lifecycle reconcile had ALREADY stamped stayed on the PR (nothing clears it until a FRESH green read
// concludes), and `classifyPr`'s stale-label fallback (`!isRequiredCheckGreen(pr)`) read "the new run has not
// concluded yet" the SAME as "still failed", handing `reconcile-core.mjs` a `phase: 'ci-red'` for a PR whose
// only fact was "CI just restarted". Because the check had genuinely not concluded, `isRequiredCheckFailed`
// (which `enrichPrsWithMainRedFacts` filters on) ALSO read `false` for it — so `requiredCheckCompletedAt` was
// never even attached, `isPrCiFailureOwedRerun` read `'unknown'` attribution, `owed-ci-rerun` never fired, and
// the PR fell straight through to a `ci-heal` dispatch: a real, wasted Opus/Sonnet session repairing a PR whose
// new CI run either had not finished yet or had already gone green. `isRequiredCheckPending` closes exactly
// this gap (`we:scripts/merge-ai-prs.mjs`) — a check present but unconcluded is now excluded from the
// label-trust fallback, same as it always was from the live-rollup scan a few lines above it.
describe('case 5k — a stale ci:failed label beside a RESTARTED (not yet concluded) required check waits, never ci-heals (heal-wait-for-rerun, real PR #2782/#2778 shape)', () => {
  const MAIN_RED_WINDOWS = [{ start: '2026-09-26T23:03:09Z', end: '2026-09-27T00:49:15Z' }];
  const restartedRollup = [
    { name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'daemon-soak', status: 'COMPLETED', conclusion: 'SUCCESS' },
    // The rebase's fresh head re-triggered `test` and it has not concluded yet — the exact shape a mechanical
    // rebase produces the instant it pushes, real or synthetic alike.
    { name: 'test', status: 'IN_PROGRESS', conclusion: null },
  ];
  const pr2782 = (over = {}) => pr1563({
    number: 2782, labels: lbl('review:accepted', 'ready-to-merge', 'ci:failed'), mergeStateStatus: 'CLEAN',
    statusCheckRollup: restartedRollup, comments: [], ...over,
  });

  it('BEFORE this fix, classifyPr alone already shows the mechanism: the stale label no longer outranks a check still in flight', () => {
    // Direct proof at the unit the incident actually turned on — `we:scripts/progress-board.mjs#classifyPr`'s
    // stale-`ci:failed` fallback branch. Before this fix `!isRequiredCheckGreen(pr)` alone (true for BOTH
    // "concluded failed" and "restarted, not concluded") made this read `'ci-red'`; now it reads through to
    // whatever the PR's OTHER facts say (here: reviewed and queued).
    expect(classifyPr({
      state: 'OPEN', labels: lbl('review:accepted', 'ready-to-merge', 'ci:failed'), mergeStateStatus: 'CLEAN',
      statusCheckRollup: restartedRollup,
    })).toBe('queued');
  });

  it('AFTER: planReconcile never dispatches ci-heal for the restarted-but-unconcluded check — nothing owed', () => {
    const plan = planReconcile({ prs: [pr2782()], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'nothing-owed', phase: 'queued', prNumber: 2782 })]);
  });

  it('still reviewed correctly once the SAME rebase lands and test genuinely concludes green (no regression on the ordinary path)', () => {
    const greenAfterRebase = restartedRollup.map((c) => (c.name === 'test' ? { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' } : c));
    const plan = planReconcile({
      prs: [pr2782({ statusCheckRollup: greenAfterRebase })], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'nothing-owed', phase: 'queued', prNumber: 2782 })]);
  });

  it('a check that HAS concluded failed (not merely restarted) still trusts the label and is ci-healed — the fix never masks a real failure', () => {
    const genuinelyFailed = restartedRollup.map((c) => (c.name === 'test' ? { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' } : c));
    const plan = planReconcile({
      prs: [pr2782({ statusCheckRollup: genuinelyFailed, labels: lbl('ci:failed') })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2782, phase: 'ci-red' })]);
  });
});

// we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — LIVE INCIDENT, web-everything/web-everything#2783:
// three ci-heal sessions dispatched across one evening, each ending "escalated (needs human — not a CI break)"
// for the IDENTICAL reason on the IDENTICAL head — because the brief's escalation exit wrote nothing durable
// (a bare one-line RETURN), so every reconcile tick that followed re-read the PR as plain `ci-red` with
// nothing live working it and dispatched ANOTHER heal. `ci-heal-escalation-mark.mjs` posts a durable,
// HEAD-SCOPED comment on escalation; these pin the BEFORE/AFTER through `planReconcile` itself.
describe('case 5l — a ci-heal already escalated THIS EXACT head never gets re-dispatched — surfaced once, re-arms on a new push (heal-wait-for-rerun, real PR #2783 shape)', () => {
  const HEAD_2783 = '70326866f0f299ddd005f9da54f0b87a3c169ac4'; // PR #2783's real head, 2026-09-27
  const NEW_HEAD_2783 = 'ffffffff70326866f0f299ddd005f9da54f0b8f9';
  const pr2783 = (over = {}) => pr1563({
    number: 2783, headRefOid: HEAD_2783, labels: lbl('review:pending', 'checking'), mergeStateStatus: 'CLEAN',
    statusCheckRollup: redRollup, comments: [], ...over,
  });

  it('BEFORE this fix (no durable escalation record): a bare one-line return leaves nothing on the PR, so the very next tick dispatches ANOTHER ci-heal — the real #2783 defect', () => {
    const plan = planReconcile({ prs: [pr2783()], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2783 })]);
  });

  it('AFTER: an escalation comment recorded against the CURRENT head refuses re-dispatch and surfaces a note instead of burning a 4th session', () => {
    const escalation = buildCiHealEscalationComment({
      headSha: HEAD_2783, outcome: 'needs-human', reason: 'the diff itself is genuinely wrong, not a CI break',
    });
    const plan = planReconcile({
      prs: [pr2783({ comments: [{ body: escalation, author: AUTOMATION }] })], agents: [], now: NOW,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'ci-heal-escalated', prNumber: 2783, headSha: HEAD_2783 })]);
    expect(plan.notes).toEqual([expect.objectContaining({ kind: 'ci-heal-escalated', prNumber: 2783, outcome: 'needs-human' })]);
  });

  it('a new push (a DIFFERENT head) RE-ARMS auto-heal with no human clear — the escalation named the OLD head only', () => {
    const escalation = buildCiHealEscalationComment({ headSha: HEAD_2783, outcome: 'needs-human', reason: 'stale, superseded by a new push' });
    const plan = planReconcile({
      prs: [pr2783({ headRefOid: NEW_HEAD_2783, comments: [{ body: escalation, author: AUTOMATION }] })],
      agents: [], now: NOW,
    });
    expect(plan.refusals.map((r) => r.kind)).not.toContain('ci-heal-escalated');
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2783 })]);
  });

  it('waiting-on-system-fix reads as its OWN refusal kind — never conflated with a genuine needs-human judgment call', () => {
    const escalation = buildCiHealEscalationComment({
      headSha: HEAD_2783, outcome: 'waiting-on-system-fix', systemFixRef: 2784,
      reason: 'soak-replay-gate false red — #2784 fixes the gate itself',
    });
    const plan = planReconcile({
      prs: [pr2783({ comments: [{ body: escalation, author: AUTOMATION }] })], agents: [], now: NOW,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'waiting-on-system-fix', prNumber: 2783, headSha: HEAD_2783, systemFixRef: '2784',
    })]);
    expect(plan.notes).toEqual([expect.objectContaining({ kind: 'ci-heal-escalated', outcome: 'waiting-on-system-fix', systemFixRef: '2784' })]);
  });

  // #4263 (PR #2787 review, live incident 2026-09-27) — BEFORE this fix, a `waiting-on-system-fix` escalation
  // refused FOREVER on the escalated head: the refusal keyed purely on head equality and never re-checked
  // whether the named `systemFixRef` PR had itself since landed. `pr.systemFixLanded` is the evidence
  // `reconcile-pass.mjs#enrichPrsWithSystemFixFacts` independently re-derives (real state re-checked, never
  // trusted from the escalation comment's own claim).
  describe('#4263 waiting-on-system-fix re-arms once the referenced system-fix PR has landed', () => {
    const escalation = buildCiHealEscalationComment({
      headSha: HEAD_2783, outcome: 'waiting-on-system-fix', systemFixRef: 2784,
      reason: 'soak-replay-gate false red — #2784 fixes the gate itself',
    });

    it('BEFORE/without systemFixLanded evidence: still refuses forever on the SAME head — the pre-#4263 defect, unchanged default', () => {
      const plan = planReconcile({
        prs: [pr2783({ comments: [{ body: escalation, author: AUTOMATION }] })], agents: [], now: NOW,
      });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'waiting-on-system-fix', prNumber: 2783 })]);
    });

    it('AFTER: systemFixLanded re-arms healing on the SAME (unchanged) head — no new push required, dispatches ci-heal', () => {
      const plan = planReconcile({
        prs: [pr2783({ comments: [{ body: escalation, author: AUTOMATION }], systemFixLanded: true })],
        agents: [], now: NOW,
      });
      expect(plan.refusals.map((r) => r.kind)).not.toContain('waiting-on-system-fix');
      expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2783 })]);
      expect(plan.notes).toEqual([expect.objectContaining({
        kind: 'system-fix-landed', prNumber: 2783, headSha: HEAD_2783, systemFixRef: '2784',
      })]);
    });

    it('systemFixLanded is IGNORED for a plain needs-human escalation — there is no fix PR to re-check, and it must not accidentally re-arm one', () => {
      const needsHuman = buildCiHealEscalationComment({ headSha: HEAD_2783, outcome: 'needs-human', reason: 'genuinely wrong diff' });
      const plan = planReconcile({
        prs: [pr2783({ comments: [{ body: needsHuman, author: AUTOMATION }], systemFixLanded: true })],
        agents: [], now: NOW,
      });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'ci-heal-escalated', prNumber: 2783 })]);
    });

    it('respects the CI-heal cap even once re-armed — landing the system fix does not also reset the attempt count', () => {
      const priorHeals = Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: CI_HEAL_COMMENT_MARKER, author: AUTOMATION }));
      const plan = planReconcile({
        prs: [pr2783({ comments: [...priorHeals, { body: escalation, author: AUTOMATION }], systemFixLanded: true })],
        agents: [], now: NOW,
      });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', prNumber: 2783 })]);
    });
  });

  it('#3383 — an escalation comment from an UNTRUSTED author never suppresses a real ci-heal', () => {
    const forged = buildCiHealEscalationComment({ headSha: HEAD_2783, outcome: 'needs-human' });
    const plan = planReconcile({
      prs: [pr2783({ comments: [{ body: forged, author: { login: 'some-random-account' } }] })], agents: [], now: NOW,
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2783 })]);
  });

  it('REFUSAL_KINDS names both new kinds — an unnamed refusal is a bug', () => {
    expect(REFUSAL_KINDS).toContain('ci-heal-escalated');
    expect(REFUSAL_KINDS).toContain('waiting-on-system-fix');
  });

  // we:backlog/fix-review-ciheal-deadlock (LIVE DEADLOCK 2026-09-28/29, PR #2878, web-everything/web-everything) —
  // a `not-a-ci-break` escalation is ci-heal's OWN structured confirmation that the PR's true owed action is
  // a review, never another heal. BEFORE this fix, the only bucket available for this exact finding was
  // `needs-human` — which this same describe block's own earlier tests confirm is a hard, review-blocking
  // `continue` with no parallel dispatch. #2878 deadlocked exactly there: ci-heal (correctly) refused to
  // re-heal a head with nothing left to fix, and the review daemon read the SAME `ci-heal-escalated` refusal
  // and stood down every tick — nobody ever asked "does this PR still need a review". `not-a-ci-break` closes
  // x6n7c2p keeps that escalation bookkeeping but requires observed successful CI before review.
  describe('not-a-ci-break escalation cannot override required CI (we:backlog/fix-review-ciheal-deadlock)', () => {
    it('retains the ci-heal escalation and waits for required CI, with findings present', () => {
      const escalation = buildCiHealEscalationComment({
        headSha: HEAD_2783, outcome: 'not-a-ci-break',
        reason: 'not a CI break — every required check is green; only review-gate is red, held by the review label',
      });
      const plan = planReconcile({
        prs: [pr2783({ comments: [{ body: escalation, author: AUTOMATION }, finding()] })], agents: [], now: NOW,
      });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals[0].reviewRefusal).toMatchObject({ kind: 'review-ci' });
      expect(plan.dispatch.some((d) => d.kind === 'ci-heal')).toBe(false);
      expect(plan.refusals).toEqual([expect.objectContaining({
        kind: 'ci-heal-escalated', prNumber: 2783, headSha: HEAD_2783,
      })]);
      expect(plan.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'ci-heal-escalated', prNumber: 2783, outcome: 'not-a-ci-break' }),
      ]));
    });

    it('zero-findings population: CI refusal folds into the escalation; no review', () => {
      const escalation = buildCiHealEscalationComment({ headSha: HEAD_2783, outcome: 'not-a-ci-break', reason: 'not a CI break' });
      const plan = planReconcile({
        prs: [pr2783({ comments: [{ body: escalation, author: AUTOMATION }] })], agents: [], now: NOW,
      });
      expect(plan.refusals).toEqual([expect.objectContaining({
        kind: 'ci-heal-escalated', reviewRefusal: expect.objectContaining({ kind: 'review-ci' }),
      })]);
      expect(plan.dispatch).toEqual([]);
      // PR #2894 review: the folded refusal strips the population marker, exactly as the `owed-ci-rerun` fold
      // strips `owedCiRerun` — it belongs on the dispatch row, never inside `reviewRefusal`.
      expect(plan.refusals[0].reviewRefusal).not.toHaveProperty('ciHealNotCiBreak');
    });

    it('foldReviewRefusalInto: one shared fold — strips withPhase keys and the marker, and tolerates a bare refusal (PR #2894 review)', () => {
      const row = { kind: 'ci-heal-escalated' };
      const fold = foldReviewRefusalInto(row, { prNumber: 1, labels: [] }, 'ciHealNotCiBreak');
      fold('no-findings', { prNumber: 1, labels: [], ciHealNotCiBreak: true, findings: 0 });
      expect(row.reviewRefusal).toEqual({ kind: 'no-findings', findings: 0 });
      expect(() => fold('cap-exhausted')).not.toThrow();
      expect(row.reviewRefusal).toEqual({ kind: 'cap-exhausted' });
    });

    it('never fires without the `review:pending` label — an already-`review:accepted` PR is refused ci-heal-escalated alone', () => {
      const escalation = buildCiHealEscalationComment({ headSha: HEAD_2783, outcome: 'not-a-ci-break', reason: 'not a CI break' });
      const plan = planReconcile({
        prs: [pr2783({ labels: lbl('review:accepted'), comments: [{ body: escalation, author: AUTOMATION }] })],
        agents: [], now: NOW,
      });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'ci-heal-escalated', prNumber: 2783 })]);
    });

    it('a genuine needs-human escalation is UNCHANGED — still a hard stop, never a parallel review (regression guard)', () => {
      const escalation = buildCiHealEscalationComment({ headSha: HEAD_2783, outcome: 'needs-human', reason: 'the diff itself is genuinely wrong' });
      const plan = planReconcile({
        prs: [pr2783({ comments: [{ body: escalation, author: AUTOMATION }, finding()] })], agents: [], now: NOW,
      });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'ci-heal-escalated', prNumber: 2783 })]);
      expect(plan.refusals[0].reviewRefusal).toBeUndefined();
    });

    it('a waiting-on-system-fix escalation is UNCHANGED — still a hard stop, never a parallel review (regression guard)', () => {
      const escalation = buildCiHealEscalationComment({
        headSha: HEAD_2783, outcome: 'waiting-on-system-fix', systemFixRef: 2784, reason: 'tooling gate false red',
      });
      const plan = planReconcile({
        prs: [pr2783({ comments: [{ body: escalation, author: AUTOMATION }, finding()] })], agents: [], now: NOW,
      });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'waiting-on-system-fix', prNumber: 2783 })]);
      expect(plan.refusals[0].reviewRefusal).toBeUndefined();
    });
  });
});

describe('case 5g — owed-ci-rerun refuses ci-heal for a ci-red PR attributable to a red main (we:backlog/x5uqim1)', () => {
  const MAIN_RED_WINDOWS = [{ start: '2026-09-25T01:30:55Z', end: '2026-09-25T02:31:25Z' }];
  const prRedAttributable = (over = {}) => pr1563({
    number: 2635, labels: [], statusCheckRollup: redRollup, comments: [],
    requiredCheckCompletedAt: '2026-09-25T01:57:47Z', aheadByOnMain: 33,
    ...over,
  });

  it('refuses owed-ci-rerun (never ci-heal) for a main-red failure whose head is still behind main', () => {
    const plan = planReconcile({ prs: [prRedAttributable()], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun', prNumber: 2635, phase: 'ci-red' })]);
  });

  it('falls through to the ordinary ci-heal path once the head already contains main\'s tip and is still red (PR #2596\'s real shape)', () => {
    const plan = planReconcile({
      prs: [prRedAttributable({ number: 2596, requiredCheckCompletedAt: '2026-09-25T02:02:29Z', aheadByOnMain: 0 })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2596, attempts: 0 })]);
  });

  it('a ci-red PR outside every red-main window still gets ci-heal, unaffected (PR #2636\'s real shape)', () => {
    const plan = planReconcile({
      prs: [prRedAttributable({ number: 2636, requiredCheckCompletedAt: '2026-09-25T08:03:45Z', aheadByOnMain: 33 })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2636 })]);
  });

  it('no mainRedWindows supplied at all (byte-identical to before this item) never blocks ci-heal', () => {
    const plan = planReconcile({ prs: [prRedAttributable()], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2635 })]);
  });

  it('REFUSAL_KINDS names owed-ci-rerun — an unnamed refusal is a bug', () => {
    expect(REFUSAL_KINDS).toContain('owed-ci-rerun');
  });

  // we:backlog/xudx8ff-*.md (#4075/#3383) — LIVE INCIDENT 2026-09-25: PRs #2635/#2636 are BOTH owed-ci-rerun
  // (their failure falls inside a real main-red window) AND mergeStateStatus: 'DIRTY' (a genuine conflict with
  // main, confirmed live via `gh pr view --json mergeStateStatus,mergeable`). A mechanical rebase can never
  // clear a real conflict, so refusing owed-ci-rerun here left them stuck forever — no other pass ever plans a
  // fixer for a PR this branch refuses. A DIRTY PR must fall through to the ordinary ci-heal path instead.
  it('#xudx8ff — a DIRTY (conflicting) PR falls through to ci-heal instead of owed-ci-rerun, even inside a real main-red window', () => {
    const plan = planReconcile({
      prs: [prRedAttributable({ mergeStateStatus: 'DIRTY' })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2635, attempts: 0 })]);
  });

  it('#xudx8ff — a DIRTY PR still respects the ci-heal cap once its own durable attempt count is exhausted', () => {
    const comments = Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const plan = planReconcile({
      prs: [prRedAttributable({ mergeStateStatus: 'DIRTY', comments })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', prNumber: 2635, cap: CI_HEAL_ROUND_CAP })]);
  });

  // x5uqim1 follow-up (#4075/#3383) — a rebase onto main that keeps failing for a NON-conflict reason (never a
  // real conflict, which already escapes via `mergeStateStatus: 'DIRTY'` above) must not refuse `owed-ci-rerun`
  // forever either: `we:scripts/conveyor/ci-red-recovery-watch.mjs#sweepCiRedRecovery` posts a durable marker on
  // EVERY rebase attempt (success or failure), and this pass reads that count straight off `pr.comments` — no
  // new IO shell wiring needed, since `comments` is already part of this pass's own input.
  it('#x5uqim1 — once the rebase-onto-main attempt cap is exhausted for this head sha, falls through to ci-heal instead of refusing owed-ci-rerun forever', () => {
    const sha = pr1563().headRefOid;
    const comments = Array.from({ length: DEFAULT_MAX_REBASE_RETRIES_PER_SHA }, () => ({
      body: buildRebaseOntoMainComment({ headSha: sha, ok: false, action: 'error', error: 'push rejected' }),
      author: AUTOMATION,
    }));
    const plan = planReconcile({
      prs: [prRedAttributable({ comments })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2635, attempts: 0 })]);
  });

  it('#x5uqim1 — a rebase attempt count BELOW the cap still refuses owed-ci-rerun as before (byte-identical to the untouched case)', () => {
    const sha = pr1563().headRefOid;
    const comments = Array.from({ length: DEFAULT_MAX_REBASE_RETRIES_PER_SHA - 1 }, () => ({
      body: buildRebaseOntoMainComment({ headSha: sha, ok: false, action: 'error', error: 'push rejected' }),
      author: AUTOMATION,
    }));
    const plan = planReconcile({
      prs: [prRedAttributable({ comments })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun', prNumber: 2635 })]);
  });
});

// we:backlog/review-while-main-red (#4075/#3383) — LIVE INCIDENT 2026-09-26: PRs #2769/#2770/#2772/#2778/#2779
// (web-everything/web-everything) sat `review:pending` + `ci:failed(owed-ci-rerun)` for hours with review capacity
// idle (2 review jobs running against 5 held PRs) — the `owed-ci-rerun` refusal above used to be the PR's ONLY
// row every tick, so a review never even got a look until main recovered AND the mechanical rebase cleared
// `ci:failed`, serializing two genuinely independent facts (main's own CI state; whether this PR has been
// reviewed) for no reason. `dispatchReviewRow` closes it: a `review:pending` PR reaching `owed-ci-rerun` now ALSO
// gets a `review` dispatched, carrying `owedCiRerun: true` so a reader can tell the two populations apart.
describe('review-while-main-red — retain rerun ownership while review waits for required CI', () => {
  const MAIN_RED_WINDOWS = [{ start: '2026-09-25T01:30:55Z', end: '2026-09-25T02:31:25Z' }];
  const prOwedCiRerunAndReview = (over = {}) => pr1563({
    number: 2769, labels: lbl('review:pending', 'ci:failed'), statusCheckRollup: redRollup,
    requiredCheckCompletedAt: '2026-09-25T01:57:47Z', aheadByOnMain: 33,
    comments: [finding()],
    ...over,
  });

  it('retains owed-ci-rerun ownership and waits before review, with findings present', () => {
    const plan = planReconcile({ prs: [prOwedCiRerunAndReview()], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun', prNumber: 2769, phase: 'ci-red' })]);
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals[0].reviewRefusal).toMatchObject({ kind: 'review-ci' });
  });

  it('zero-findings population: CI refusal folds into owed-ci-rerun; no review', () => {
    const twoRearms = [
      { body: REARM_COMMENT_MARKER, author: AUTOMATION },
      { body: REARM_COMMENT_MARKER, author: AUTOMATION },
    ];
    const plan = planReconcile({
      prs: [prOwedCiRerunAndReview({ comments: twoRearms })], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'owed-ci-rerun', reviewRefusal: expect.objectContaining({ kind: 'review-ci' }),
    })]);
    expect(plan.dispatch).toEqual([]);
  });

  it('above the round cap: `cap-exhausted` (folded) instead of dispatching a review forever, and the round-cap note still surfaces (zero-findings population, REARM-only thread)', () => {
    const overCapRearms = Array.from({ length: NEGOTIATION_ROUND_CAP + 1 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({
      prs: [prOwedCiRerunAndReview({ comments: overCapRearms })], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'owed-ci-rerun',
      reviewRefusal: expect.objectContaining({ kind: 'cap-exhausted', attempts: NEGOTIATION_ROUND_CAP + 1, cap: NEGOTIATION_ROUND_CAP, capKind: 'review' }),
    })]);
    expect(plan.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'round-cap-exhausted', prNumber: 2769, capKind: 'review' }),
    ]));
  });

  it('above the round cap WITH a real finding present: `cap-exhausted` folds in directly (no `no-findings`)', () => {
    const overCapRearms = [finding(), ...Array.from({ length: NEGOTIATION_ROUND_CAP + 1 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }))];
    const plan = planReconcile({
      prs: [prOwedCiRerunAndReview({ comments: overCapRearms })], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'owed-ci-rerun',
      reviewRefusal: expect.objectContaining({ kind: 'cap-exhausted', attempts: NEGOTIATION_ROUND_CAP + 1, cap: NEGOTIATION_ROUND_CAP }),
    })]);
  });

  it('#2588 stays independent: a head already carrying a `reviewed-sha` accept marker is not re-dispatched (`already-reviewed-head` folded), even while owed-ci-rerun also holds', () => {
    const sha = pr1563().headRefOid;
    const plan = planReconcile({
      prs: [prOwedCiRerunAndReview({ comments: [{ body: buildReviewedShaMarker(sha), author: AUTOMATION }] })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'owed-ci-rerun', reviewRefusal: expect.objectContaining({ kind: 'already-reviewed-head', headSha: sha, reviewedSha: sha }),
    })]);
  });

  // PR #2783 review round 1 (codex-correctness, PLAUSIBLE): the raw-SHA `already-reviewed-head` guard cannot see
  // through a mechanical rebase. Defended structurally, not by the SHA: an accepted PR carries `review:accepted`,
  // never `review:pending`, so neither review path owes it anything — whether its CI is still red on the old head
  // or the rebase has moved the head and CI is still running.
  it('does not redispatch an accepted contribution while its mechanical rebase is awaiting CI', () => {
    const reviewedSha = 'a'.repeat(40);
    const rebasedHead = 'b'.repeat(40);
    const accepted = { comments: [finding(), { body: buildReviewedShaMarker(reviewedSha), author: AUTOMATION }], labels: lbl('review:accepted', 'ci:failed') };
    const stillRed = planReconcile({
      prs: [prOwedCiRerunAndReview({ ...accepted, headRefOid: reviewedSha })], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    // The case only the `review:pending` label gate defends: head MOVED (raw-SHA guard misses), CI still red.
    const rebasedStillRed = planReconcile({
      prs: [prOwedCiRerunAndReview({ ...accepted, headRefOid: rebasedHead })], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(rebasedStillRed.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun', prNumber: 2769 })]);
    expect(rebasedStillRed.refusals[0].reviewRefusal).toBeUndefined();
    const rebasedCiRunning = planReconcile({
      prs: [prOwedCiRerunAndReview({ ...accepted, headRefOid: rebasedHead, labels: lbl('review:accepted'), statusCheckRollup: [] })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    for (const plan of [stillRed, rebasedStillRed, rebasedCiRunning]) {
      expect(plan.dispatch.filter((d) => d.kind === 'review')).toEqual([]);
    }
  });

  it('NEVER fires for the sibling population — a PR\'s OWN code red (no main-red window covers it) still gets only `ci-heal`, never a parallel review', () => {
    const plan = planReconcile({
      prs: [prOwedCiRerunAndReview({ requiredCheckCompletedAt: '2026-09-25T08:03:45Z' })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2769 })]);
    expect(plan.refusals.map((r) => r.kind)).not.toContain('owed-ci-rerun');
  });

  it('never fires without the `review:pending` label — an already-`review:accepted` PR (no review owed) is refused owed-ci-rerun alone, byte-identical to before this item', () => {
    const plan = planReconcile({
      prs: [prOwedCiRerunAndReview({ labels: lbl('review:accepted', 'ci:failed') })],
      agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun', prNumber: 2769 })]);
  });

  // PR #2783 review round 1 (correctness, CONFIRMED): `reconcileHolds` keys refusals by PR number and keeps the
  // LAST row, so a second `no-findings` row silently replaced the `owed-ci-rerun` hold (`['review','fix']`) with
  // `['fix']` — land-advance's own review dispatch was no longer vetoed for a PR this pass already dispatches a
  // review for. The parallel review's own refusal folds INTO the one `owed-ci-rerun` row, never adds a row.
  it.each([
    ['zero findings', () => [{ body: REARM_COMMENT_MARKER, author: AUTOMATION }]],
    ['zero findings at the cap', () => Array.from({ length: NEGOTIATION_ROUND_CAP }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }))],
    ['findings at the cap', () => [finding(), ...Array.from({ length: NEGOTIATION_ROUND_CAP }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }))]],
    ['already-reviewed head', () => [{ body: buildReviewedShaMarker(pr1563().headRefOid), author: AUTOMATION }]],
  ])('%s: exactly ONE refusal row for the PR, and land-advance still sees the review hold', (_name, comments) => {
    const plan = planReconcile({
      prs: [prOwedCiRerunAndReview({ comments: comments() })], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.refusals.filter((r) => r.prNumber === 2769)).toHaveLength(1);
    expect(reconcileHolds(plan.refusals)['we#2769']).toMatchObject({ kind: 'owed-ci-rerun', holds: ['review', 'fix'] });
  });

  it('a DIRTY (conflicting) PR takes the #xudx8ff ci-heal fallback, unaffected by this item — no parallel review either', () => {
    const plan = planReconcile({
      prs: [prOwedCiRerunAndReview({ mergeStateStatus: 'DIRTY' })], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS,
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2769 })]);
    expect(plan.refusals.map((r) => r.kind)).not.toContain('owed-ci-rerun');
  });
});

// landing-freeze fix (2026-09-27) — LIVE INCIDENT: PR #2790 fixed a `daemon-soak` regression that had sat on
// `main` unseen (the job was `pull_request`-only before it, so `main`'s own CI runs stayed `success` right
// through the regression — NO red window ever opened to attribute #2748/#2783/#2784/#2788/#2789's identical
// failures against, however genuinely `main`-caused they were). #2748/#2783/#2784 hit `cap-exhausted` burning
// their heal count repairing code that was never broken; #2788/#2789 were about to be handed yet another heal.
// `isPrCiFailureOwedRerun`'s new green-check path (`main-red-recovery.mjs`'s own "LANDING-FREEZE FIX" section
// header) fixes this WITHOUT needing any red-window attribution at all — see that module's own tests for the
// pure-function coverage; these pin the same fix through `planReconcile`, the caller that actually decides
// `ci-heal` vs `owed-ci-rerun` for a live PR.
describe('case 5i — landing-freeze fix: owed-ci-rerun via main\'s own latest-run green check, no red window needed (PR #2748 real shape)', () => {
  const mainLatestCheckRuns = [
    { name: 'test', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T04:00:10Z' },
    { name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T03:56:55Z' },
  ];
  const pr2748 = (over = {}) => pr1563({
    number: 2748, labels: [], statusCheckRollup: redRollup, comments: [],
    requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadByOnMain: 5, requiredCheckName: 'daemon-soak',
    // #2748's merge base never ran daemon-soak on `main` (pull_request-only job), and it lacks main's green sha.
    prContainsMainGreenSha: false, mergeBaseCheckRuns: [], mergeBaseRunConclusion: 'success',
    ...over,
  });

  // PR #2793 review (correctness, CONFIRMED) — the reviewer's end-to-end shape: an ordinary CLEAN PR whose OWN
  // code broke `test`, behind a healthy `main` whose `test` was already green at this PR's own merge base. Main
  // being green now is the normal state, not evidence main caused this — ci-heal owns it.
  it('falls through to ci-heal for a plain PR-owned failure behind a healthy main (check already green at the merge base)', () => {
    const plan = planReconcile({
      prs: [pr2748({
        requiredCheckCompletedAt: '2026-01-01T00:00:00Z', aheadByOnMain: 3, requiredCheckName: 'test',
        mergeBaseCheckRuns: [{ name: 'test', conclusion: 'success', status: 'completed', completed_at: '2025-12-31T00:00:00Z' }],
      })],
      agents: [], now: NOW, mainRedWindows: [], mainLatestCheckRuns,
    });
    expect(plan.refusals.some((r) => r.kind === 'owed-ci-rerun')).toBe(false);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2748 })]);
  });

  it('falls through to ci-heal when the PR already contains main\'s green run sha, even though main\'s tip moved on (aheadBy > 0)', () => {
    const plan = planReconcile({
      prs: [pr2748({ prContainsMainGreenSha: true, mergeBaseCheckRuns: null })],
      agents: [], now: NOW, mainRedWindows: [], mainLatestCheckRuns,
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2748 })]);
  });

  it('refuses owed-ci-rerun (never ci-heal), with EMPTY mainRedWindows — main\'s own latest run alone is enough', () => {
    const plan = planReconcile({ prs: [pr2748()], agents: [], now: NOW, mainRedWindows: [], mainLatestCheckRuns });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun', prNumber: 2748, phase: 'ci-red' })]);
    expect(plan.refusals[0].why).toMatch(/passing on main's own latest completed run/);
  });

  // THE CAP-EXHAUSTED CASE, DIRECTLY FROM THE INCIDENT: #2748 had already burned its full ci-heal cap
  // repairing main's own (now-fixed) regression before #2790 landed. Once this fix is live, the SAME durable
  // comment count no longer matters — `owed-ci-rerun` is checked, and skips the cap entirely, before the cap
  // is ever consulted. No separate "re-arm" bookkeeping: the cap simply never gets a vote on this path.
  it('fires even when the durable ci-heal count is ALREADY at (or past) the cap — the heal cap never gates this path', () => {
    const comments = Array.from({ length: CI_HEAL_ROUND_CAP + 1 }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const plan = planReconcile({
      prs: [pr2748({ comments })], agents: [], now: NOW, mainRedWindows: [], mainLatestCheckRuns,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun', prNumber: 2748 })]);
    expect(plan.refusals.some((r) => r.kind === 'cap-exhausted')).toBe(false);
    expect(plan.notes.some((n) => n.kind === 'ci-heal-exhausted')).toBe(false);
  });

  it('falls through to the ordinary ci-heal path once the head already contains main\'s tip (ahead_by 0), even with main green', () => {
    const plan = planReconcile({
      prs: [pr2748({ aheadByOnMain: 0 })], agents: [], now: NOW, mainRedWindows: [], mainLatestCheckRuns,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2748 })]);
  });

  it('falls through to ci-heal when main\'s own latest run never reported the failing check at all — never a guess', () => {
    const plan = planReconcile({
      prs: [pr2748()], agents: [], now: NOW, mainRedWindows: [], mainLatestCheckRuns: [],
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2748 })]);
  });

  it('omitting mainLatestCheckRuns entirely (byte-identical to before this item) never blocks ci-heal', () => {
    const plan = planReconcile({ prs: [pr2748()], agents: [], now: NOW, mainRedWindows: [] });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2748 })]);
  });

  it('a DIRTY (conflicting) PR still falls through to ci-heal instead of owed-ci-rerun, unaffected by this fix', () => {
    const plan = planReconcile({
      prs: [pr2748({ mergeStateStatus: 'DIRTY' })], agents: [], now: NOW, mainRedWindows: [], mainLatestCheckRuns,
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2748 })]);
  });
});

describe('case 5f — conflict-fix dispatch, capped by its OWN durable marker, not the shared roundCap (#xkmu3gv)', () => {
  // `web-everything/web-everything#2549`, shape measured live 2026-09-24: `bounced` (review:changes present, wins
  // `classifyPr`'s precedence over `review:human`), ALSO carrying `merge-status:conflicting` (the mechanical
  // conflict-resolution route PR #2577 introduces) and `advisory:changes`, with 5 prior real negotiation rounds
  // already spent (`review-round:5`, at the shared `NEGOTIATION_ROUND_CAP` of 5).
  const prConflict = (over = {}) => pr1563({
    number: 2549,
    labels: [...lbl('review:changes', 'review:human', 'merge-status:conflicting', 'advisory:changes')],
    ...over,
  });

  it('a conflict-labelled bounce with zero prior conflict-fix rounds is dispatched `fix`, even though the shared cap is fully spent', () => {
    // Flood the thread with REARM/advisory markers past `NEGOTIATION_ROUND_CAP` — the shared cap this bounce
    // would otherwise be refused on — and confirm it still dispatches, because the conflict-fix cap reads its
    // OWN marker, never this one.
    const shared = Array.from({ length: 5 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({ prs: [prConflict({ comments: [finding(), ...shared] })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({
      kind: 'fix', prNumber: 2549, isConflict: true, advisoryPending: true, attempts: 0, cap: CONFLICT_FIX_ROUND_CAP,
    })]);
  });

  it(`the durable conflict-fix count is read from the PR's OWN comments — ${CONFLICT_FIX_ROUND_CAP - 1} prior rounds still dispatches`, () => {
    const comments = [finding(), ...Array.from({ length: CONFLICT_FIX_ROUND_CAP - 1 }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }))];
    const plan = planReconcile({ prs: [prConflict({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', attempts: CONFLICT_FIX_ROUND_CAP - 1 })]);
  });

  it(`AT the cap (${CONFLICT_FIX_ROUND_CAP} durable conflict-fix comments) the PR is refused \`cap-exhausted\`, capKind \`conflict-fix\``, () => {
    const comments = [finding(), ...Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }))];
    const plan = planReconcile({ prs: [prConflict({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'cap-exhausted', prNumber: 2549, attempts: CONFLICT_FIX_ROUND_CAP, cap: CONFLICT_FIX_ROUND_CAP, capKind: 'conflict-fix',
    })]);
  });

  it('a caller-supplied `conflictFixCap` overrides the default', () => {
    const plan = planReconcile({ prs: [prConflict({ comments: [finding(), { body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }] })], agents: [], now: NOW, conflictFixCap: 1 });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 1, capKind: 'conflict-fix' })]);
  });

  // #2787 LIVE INCIDENT (2026-09-27) — 3 rounds each genuinely SUCCEEDED against a stacked base that kept
  // getting rebased (fc7c9e916 → 971cf0781 → 49087faaf → dc35a35c2), then that base landed entirely and the PR
  // retargeted to `main` — its FIRST-EVER main-base conflict. BEFORE this fix: `cap-exhausted` on arrival
  // (3 stale-looking rounds already "spent"). AFTER: none of those 3 rounds match the CURRENT target (`main`),
  // so this dispatches.
  it('#2787 reproduction: 3 prior rounds against a DIFFERENT (stacked) target do not exhaust the cap for a FIRST-EVER main-base conflict', () => {
    const priorStackedRounds = [
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nconveyor fix agent resolved this PR's conflict against \`lane/soak-gate-false-red\` (a STACKED-BASE mechanical rebase, #3383...) round 1`, author: AUTOMATION },
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nconveyor fix agent resolved this PR's conflict against \`lane/soak-gate-false-red\` (a STACKED-BASE mechanical rebase, #3383...) round 2`, author: AUTOMATION },
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nconveyor fix agent resolved this PR's conflict against \`lane/soak-gate-false-red\` (a STACKED-BASE mechanical rebase, #3383...) round 3`, author: AUTOMATION },
    ];
    const plan = planReconcile({ prs: [prConflict({ comments: [finding(), ...priorStackedRounds] })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', prNumber: 2549, attempts: 0, cap: CONFLICT_FIX_ROUND_CAP })]);
  });

  it('#2787 hard ceiling: even rounds against DIFFERENT targets stop dispatching once the RAW total hits CONFLICT_FIX_ABSOLUTE_CEILING (a true loop, not a moving target)', () => {
    const manyDifferentTargets = Array.from({ length: CONFLICT_FIX_ABSOLUTE_CEILING }, (_, i) => ({
      body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved against \`lane/some-base-${i}\``, author: AUTOMATION,
    }));
    const plan = planReconcile({ prs: [prConflict({ comments: [finding(), ...manyDifferentTargets] })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'cap-exhausted', prNumber: 2549, capKind: 'conflict-fix',
      why: expect.stringContaining('hard ceiling'),
    })]);
  });

  it('a round against the SAME main sha the PR is STILL conflicting against (mainSha threaded in) still counts as stale — genuinely stuck, not a moving target', () => {
    const comments = [
      finding(),
      ...Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({
        body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved\n\n<!-- conveyor-conflict-fix-target: main@aaa1111 -->`, author: AUTOMATION,
      })),
    ];
    const plan = planReconcile({ prs: [prConflict({ comments })], agents: [], now: NOW, mainSha: 'aaa1111' });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'conflict-fix' })]);
  });

  it('a round against an OLDER main sha (mainSha threaded in, main has since moved) does NOT count as stale — dispatches', () => {
    const comments = [
      finding(),
      ...Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({
        body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved\n\n<!-- conveyor-conflict-fix-target: main@aaa1111 -->`, author: AUTOMATION,
      })),
    ];
    const plan = planReconcile({ prs: [prConflict({ comments })], agents: [], now: NOW, mainSha: 'bbb2222' });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', prNumber: 2549, attempts: 0 })]);
  });

  it('a bounce WITHOUT the conflict label is unaffected — the ordinary shared cap still governs it', () => {
    const shared = Array.from({ length: 5 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({ prs: [pr1563({ comments: [finding(), ...shared] })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 5 })]);
    // xilx617 — the generic REFUSAL 3 now names its OWN population (`capKind: OWED[phase]`) so its
    // `round-cap-exhausted` note can say WHICH auto-repair rounds were exhausted; a `bounced` phase owes `fix`.
    expect(plan.refusals[0].capKind).toBe('fix');
  });

  it('`countConflictFixComments` narrows on the leading line, like every sibling counter', async () => {
    const { countConflictFixComments } = await import('../conflict-fix-round-count.mjs');
    expect(countConflictFixComments([{ body: CONFLICT_FIX_COMMENT_MARKER + '\n\nmore', author: AUTOMATION }])).toBe(1);
    expect(countConflictFixComments([{ body: `> ${CONFLICT_FIX_COMMENT_MARKER}`, author: AUTOMATION }])).toBe(0);
    expect(countConflictFixComments(null)).toBe(0);
  });
});

describe('case 5f-2 — ALREADY-LANDED pre-empts the conflict-fix dispatch (live incident, web-everything/web-everything PR #2752, #4034/#2748)', () => {
  // Real shape, measured live 2026-09-26: `review:changes` + `merge-status:conflicting`, `mergeStateStatus:
  // DIRTY` — exactly `case 5f`'s `isConflictBounce` population, which would otherwise dispatch a mechanical
  // conflict-fix here. `we:scripts/conveyor/reconcile-pass.mjs#enrichPrsWithAlreadyLandedFacts` is the IO shell
  // that computes `alreadyLandedInMain` off per-file blob identity against `main`'s own history; this pass only
  // reads the already-decided fact.
  const prAlreadyLanded = (over = {}) => pr1563({
    number: 2752,
    headRefName: 'lane/4034-critical-work-gate',
    labels: lbl('review:changes', 'merge-status:conflicting'),
    mergeStateStatus: 'DIRTY',
    comments: [finding()],
    ...over,
  });

  it('refuses `already-landed`, naming the carrier PR, instead of dispatching the mechanical conflict-fix', () => {
    const plan = planReconcile({
      prs: [prAlreadyLanded({ alreadyLandedInMain: { carrierPr: 2759 } })], agents: [], now: NOW,
    });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'already-landed', prNumber: 2752, carrierPr: 2759,
      why: expect.stringContaining('#2759'),
    })]);
  });

  it('carries the PR\'s own `headRefName` on the refusal — the one fact `already-landed-watch.mjs` resolves the backlog card from (PR #2769 review)', async () => {
    const { planAlreadyLandedCloses } = await import('../already-landed-watch.mjs');
    const plan = planReconcile({
      prs: [prAlreadyLanded({ alreadyLandedInMain: { carrierPr: 2759 } })], agents: [], now: NOW,
    });
    expect(plan.refusals[0].headRefName).toBe('lane/4034-critical-work-gate');
    // Wiring, not just shape: the watch's own planner, fed this real plan, derives the item to resolve.
    expect(planAlreadyLandedCloses(plan)).toEqual([expect.objectContaining({ prNumber: 2752, itemNum: '4034' })]);
  });

  it('still refuses `already-landed` (carrierPr null) when the carrier could not be attributed with confidence — the containment fact never depends on attribution', () => {
    const plan = planReconcile({
      prs: [prAlreadyLanded({ alreadyLandedInMain: { carrierPr: null } })], agents: [], now: NOW,
    });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'already-landed', prNumber: 2752, carrierPr: null })]);
    expect(plan.refusals[0].why).not.toMatch(/#null/);
  });

  it('takes priority over `stacked-rebase`/other conflict handling regardless of round counts already spent', () => {
    const comments = [finding(), ...Array.from({ length: CONFLICT_FIX_ROUND_CAP + 5 }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }))];
    const plan = planReconcile({
      prs: [prAlreadyLanded({ comments, alreadyLandedInMain: { carrierPr: 2759 } })], agents: [], now: NOW,
    });
    // Not `cap-exhausted` (that would mean it fell through to the ordinary conflict-fix branch) — `already-landed`
    // pre-empts it outright, whatever the durable attempt count already reads.
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'already-landed' })]);
  });

  it('a PR with NO `alreadyLandedInMain` fact is completely unaffected — falls straight through to the ordinary conflict-fix dispatch', () => {
    const plan = planReconcile({ prs: [prAlreadyLanded()], agents: [], now: NOW });
    expect(plan.refusals).toHaveLength(0);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', isConflict: true, prNumber: 2752 })]);
  });

  it('still yields to a genuinely LIVE session (liveness outranks already-landed, exactly like every other phase)', () => {
    const agents = [{ name: 'fix-2752', pid: 555, state: 'working', pidAlive: true, cwd: '/lane' }];
    const plan = planReconcile({
      prs: [prAlreadyLanded({ alreadyLandedInMain: { carrierPr: 2759 } })], agents, now: NOW,
    });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'live-process', prNumber: 2752 })]);
  });

  it('`already-landed` is listed in REFUSAL_KINDS, so `formatReport` groups it like every other refusal', () => {
    expect(REFUSAL_KINDS).toContain('already-landed');
  });
});

describe('case 5g — advisory-fix dispatch on a `needs-human` PR carrying `advisory:changes` (#xkmu3gv)', () => {
  // A `needs-human` PR (review:human, no review:changes) that already carries an admitted `advisory:changes`
  // finding from `we:scripts/operations/review-pr.mjs`'s `advise` step — the population no daemon ever acted on
  // before this item: the reconcile pass only ever dispatched `review` for `needs-human`, never a `fix`.
  const advisoryNote = { body: `${ADVISORY_NOTE_MARKER}\n\nSome admitted finding text.`, author: AUTOMATION };
  const prNeedsHuman = (over = {}) => pr1563({
    number: 2601,
    labels: [...lbl('review:human', 'advisory:changes')],
    comments: [advisoryNote],
    ...over,
  });

  it('owes a `fix` (mode advisory-fix), never a `review`, when the current advisory note has not yet been fixed', () => {
    const plan = planReconcile({ prs: [prNeedsHuman()], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({
      kind: 'fix', mode: 'advisory-fix', prNumber: 2601, attempts: 0, cap: ADVISORY_FIX_ROUND_CAP,
    })]);
  });

  it('once the advisory-fix marker outnumbers stale, it falls through to the ordinary `needs-human` → `review` path (a fresh review is owed, not another fix)', () => {
    // One advisory note, one completed advisory-fix round already posted AFTER it — the count has caught up,
    // so the SAME finding is not re-fixed; a fresh review is owed to judge the repaired head.
    const comments = [advisoryNote, { body: buildAdvisoryFixComment({}), author: AUTOMATION }];
    const plan = planReconcile({ prs: [prNeedsHuman({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2601 })]);
  });

  // PR #2607 review:changes (security/broken-access-control): a FORGED advisory-fix mark — the right leading
  // line, posted by anyone who can comment — must never read as "addressed". Otherwise it routes the PR to the
  // cap-EXEMPT review dispatch instead of a capped fix, and re-posting it every tick keeps the PR cycling
  // forever without ever reaching cap-exhausted (the human escalation the round cap guarantees).
  it('a forged (non-self-authored) advisory-fix mark after the latest note is NOT addressed — still a capped fix', () => {
    const forged = { body: buildAdvisoryFixComment({}), author: { login: 'some-commenter' } };
    for (const fake of [forged, { body: forged.body }, forged.body, { ...forged, viewerDidAuthor: false }]) {
      expect(isLatestAdvisoryFindingAddressed([advisoryNote, fake])).toBe(false);
      const plan = planReconcile({ prs: [prNeedsHuman({ comments: [advisoryNote, fake] })], agents: [], now: NOW });
      expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'advisory-fix', prNumber: 2601 })]);
    }
    // A genuine self-authored mark (either accepted signal) still counts.
    expect(isLatestAdvisoryFindingAddressed([advisoryNote, { ...forged, author: { login: 'web-everything' } }])).toBe(true);
    expect(isLatestAdvisoryFindingAddressed([advisoryNote, { body: forged.body, viewerDidAuthor: true }])).toBe(true);
  });

  // xaer296 (epic #3383) — CONFIRMED LIVE, `web-everything/web-everything#2549`, 2026-09-24: 5 advisory-panel comments
  // already on the thread from ordinary review rounds 1-5 (ALL pre-dating the #xkmu3gv marker mechanism), and
  // exactly ONE genuine advisory-fix round, which DID address the current (latest, 5th) finding. The OLD
  // count-based test (`advisoryFixes < advisoryNotes`, i.e. `1 < 5`) stayed true forever — no number of further
  // real fixes could ever "catch up" to a note backlog that predates the mechanism — so the reconcile pass kept
  // re-dispatching a fixer at an ALREADY-fixed PR. The fix must be ORDER-based: a fix-mark AFTER the LATEST note
  // is enough, regardless of how many older notes came before either ever existed.
  it('xaer296 — a fix-mark AFTER the latest of TWO pre-existing advisory notes is addressed (order, not count)', () => {
    // Two prior notes (well under `NEGOTIATION_ROUND_CAP`, so this isolates the order-vs-count fix from the
    // separate, pre-existing shared-cap union below — see the next test for the exact #2549 shape, where BOTH
    // facts are true at once).
    // #3383 — a trusted author is now required for these notes/fix to count toward the shared union cap too.
    const priorNote = { body: `${ADVISORY_NOTE_MARKER}\n\nround 1`, author: AUTOMATION };
    const latestNote = { body: `${ADVISORY_NOTE_MARKER}\n\nround 2 — the current finding`, author: AUTOMATION };
    const theOneFix = { body: buildAdvisoryFixComment({}), viewerDidAuthor: true };
    const comments = [priorNote, latestNote, theOneFix];
    const plan = planReconcile({ prs: [prNeedsHuman({ comments })], agents: [], now: NOW });
    // A fresh review is owed — NOT another fix (the old bug re-dispatched `fix` here forever: 1 < 2).
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2601 })]);
    expect(plan.refusals).toHaveLength(0);
  });

  it('xuxcsw6 — a fix-mark after the advisory does NOT re-dispatch a review while the referral hold stands (the live #3771 loop)', () => {
    const comments = [{ body: `${ADVISORY_NOTE_MARKER}\n\nround 1`, author: AUTOMATION }, { body: buildAdvisoryFixComment({}), viewerDidAuthor: true }];
    const pr = prNeedsHuman({ comments });
    for (let tick = 0; tick < 3; tick++) {
      const plan = planReconcile({ prs: [{ ...pr, referralHold: { head: 'a'.repeat(40), episode: 'e', count: 5, why: 'review paused: 5 referrals need a ruling; it resumes on a new push, a ruling, or a send-back' } }], agents: [], now: NOW });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'review-referrals-pending', prNumber: 2601 })]);
    }
  });

  // The EXACT `web-everything/web-everything#2549` shape: 5 pre-existing advisory notes (rounds 1-5, `review-round:5`)
  // AND the one genuine advisory-fix mark addressing the latest. `isLatestAdvisoryFindingAddressed` correctly
  // reads `addressed: true` here too (same fix as the test above) — but the GENERIC, pre-existing shared round
  // cap (`countAdvisoryComments` UNIONED into `roundCap`, #2117/#2298) independently reads 5 notes against a
  // cap of `NEGOTIATION_ROUND_CAP` (5) and refuses first. This is CORRECT, pre-existing behavior this item does
  // not change: a PR that has genuinely burned 5 rounds still needs a person. The win here is narrower but real
  // — before this fix the PR was invisibly STUCK on a terminal `stood-down` forever (case 2's own new tests);
  // after it, the SAME PR reaches a clean, auditable `cap-exhausted` refusal a human can act on (exactly the
  // task's own "owed an advisory review (or clean hand-back)" framing) instead of a silent dead end.
  // xaer296 FOLLOW-UP 2 — CONFIRMED LIVE on `web-everything/web-everything#2549`, 2026-09-24: once `addressed` is
  // correctly `true` (order-based, per the test above), the real reconcile pass hit a THIRD gap — it fell
  // through to the generic `OWED`-table review dispatch, which is subject to the SAME shared `roundCap`
  // (`NEGOTIATION_ROUND_CAP`) fed by `countAdvisoryComments` — i.e. the raw COUNT OF ADVISORY NOTES, which is
  // exactly the pre-existing history (5 rounds, predating `#xkmu3gv`) this branch's own `addressed` check
  // already correctly looks PAST. So the real #2549 sat `cap-exhausted` (5/5) even once its finding was proven
  // fixed. The review this branch owns dispatches directly, EXEMPT from that shared cap — see the dispatch
  // site's own docblock for why that exemption is safe (self-limiting: it can fire at most once per completed
  // advisory-fix round, and those rounds are already bounded by `ADVISORY_FIX_ROUND_CAP`).
  it('xaer296 FOLLOW-UP 2 — the exact #2549 shape (5 pre-existing notes + 1 genuine fix) is owed a REVIEW, never cap-exhausted', () => {
    // #3383 — a trusted author is now required for these notes/fix to count toward the shared union cap too.
    const priorNotes = Array.from({ length: 4 }, (_, i) => ({ body: `${ADVISORY_NOTE_MARKER}\n\nround ${i + 1}`, author: AUTOMATION }));
    const latestNote = { body: `${ADVISORY_NOTE_MARKER}\n\nround 5 — the current finding`, author: AUTOMATION };
    const theOneFix = { body: buildAdvisoryFixComment({}), viewerDidAuthor: true };
    const comments = [...priorNotes, latestNote, theOneFix];
    const plan = planReconcile({ prs: [prNeedsHuman({ comments })], agents: [], now: NOW });
    expect(plan.refusals).toHaveLength(0);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2601 })]);
  });

  // The exemption is NARROW — a `needs-human` PR that carries NO `advisory:changes` at all (the ordinary
  // population `NEGOTIATION_ROUND_CAP` was built for) must stay EXACTLY as capped as before.
  it('xaer296 FOLLOW-UP 2 — a normal PR above the shared cap (no advisory:changes at all) is STILL refused cap-exhausted', () => {
    const rearms = Array.from({ length: NEGOTIATION_ROUND_CAP + 1 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({
      prs: [prNeedsHuman({ labels: lbl('review:human'), comments: [finding(), ...rearms] })],
      agents: [], now: NOW,
    });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', prNumber: 2601, attempts: NEGOTIATION_ROUND_CAP + 1, cap: NEGOTIATION_ROUND_CAP })]);
  });

  // And a PR that carries `advisory:changes` but has NOT YET addressed the latest finding must stay governed
  // by its OWN `ADVISORY_FIX_ROUND_CAP` (already covered above) — the exemption never reaches this branch at
  // all, since it is gated on `addressed === true`.
  it('xaer296 FOLLOW-UP 2 — advisory:changes NOT yet addressed is unaffected by the review exemption (still the advisory-fix cap)', () => {
    const comments = [];
    for (let i = 0; i < ADVISORY_FIX_ROUND_CAP; i += 1) {
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nround ${i}`, author: AUTOMATION });
      comments.push({ body: buildAdvisoryFixComment({}), author: AUTOMATION });
    }
    comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\none more, still broken`, author: AUTOMATION });
    const plan = planReconcile({ prs: [prNeedsHuman({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'advisory-fix', cap: ADVISORY_FIX_ROUND_CAP })]);
  });

  it(`AT the cap (${ADVISORY_FIX_ROUND_CAP} durable advisory-fix comments, still behind the note count) the PR is refused \`cap-exhausted\`, capKind \`advisory-fix\``, () => {
    // ADVISORY_FIX_ROUND_CAP advisory-fix rounds, each followed by ANOTHER advisory note that still found
    // something wrong (so the fix count never catches up to the note count) — genuinely exhausted.
    const comments = [];
    for (let i = 0; i < ADVISORY_FIX_ROUND_CAP; i += 1) {
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nround ${i}`, author: AUTOMATION });
      comments.push({ body: buildAdvisoryFixComment({}), author: AUTOMATION });
    }
    comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\none more, still broken`, author: AUTOMATION }); // the note the last fix didn't clear
    const plan = planReconcile({ prs: [prNeedsHuman({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'cap-exhausted', prNumber: 2601, attempts: ADVISORY_FIX_ROUND_CAP, cap: ADVISORY_FIX_ROUND_CAP, capKind: 'advisory-fix',
    })]);
  });

  describe('operator round-extension grants reach the advisory-fix cap', () => {
    const exhausted = () => {
      const comments = [];
      for (let i = 0; i < ADVISORY_FIX_ROUND_CAP; i += 1) {
        comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nround ${i}`, author: AUTOMATION });
        comments.push({ body: buildAdvisoryFixComment({}), author: AUTOMATION });
      }
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\none more, still broken`, author: AUTOMATION });
      return comments;
    };
    const grant = (login) => ({
      author: { login },
      body: buildRoundExtensionComment({ repo: 'we', pr: 2601, by: 1, actor: 'chalbert', channel: 'test', reason: 'one more', at: '2026-10-06T10:44:00Z' }),
    });
    it('an operator-authored grant lets a PR at the advisory-fix cap dispatch again', () => {
      const plan = planReconcile({ prs: [prNeedsHuman({ comments: [...exhausted(), grant('chalbert')] })], agents: [], now: NOW });
      expect(plan.refusals).toEqual([]);
      expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'advisory-fix', prNumber: 2601, cap: ADVISORY_FIX_ROUND_CAP + 1 })]);
    });
    it('an automation-authored grant does not', () => {
      const plan = planReconcile({ prs: [prNeedsHuman({ comments: [...exhausted(), grant('web-everything')] })], agents: [], now: NOW });
      expect(plan.dispatch).toHaveLength(0);
      expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'advisory-fix' })]);
    });
  });

  // xconv1-evidence FOLLOW-UP (web-everything/web-everything#2766/#2767, 2026-09-27), reconstructed from the real
  // live thread shape (order + marker prefixes + authorship, as `gh pr view 2766 --json comments` returned it):
  // a CONVERTED note, 3 fix-mark comments ALL landing inside that SAME episode (the mechanism bug meant no
  // review ever advanced it before the #xconv1-evidence fix), then a later, independent review's own genuinely
  // NEW advisory note. The raw lifetime fix-mark COUNT (3) used to refuse this `cap-exhausted` with zero
  // attempts ever made against the new finding; `countCompletedAdvisoryEpisodes` reads it as ONE spent episode.
  it('THE LIVE #2766/#2767 SHAPE: 3 fix-marks clustered inside ONE (buggy, never-advanced) converted-note episode, then a genuinely new finding — owed a fresh advisory-fix (1 of 3 episodes spent), never cap-exhausted', () => {
    const comments = [
      { body: `${CONVERTED_ADVISORY_NOTE_MARKER} converted note — the original test-gaming false positive`, author: AUTOMATION },
      { body: buildAdvisoryFixComment({}), author: AUTOMATION },
      { body: buildAdvisoryFixComment({}), author: AUTOMATION },
      { body: buildAdvisoryFixComment({}), author: AUTOMATION },
      { body: `${ADVISORY_NOTE_MARKER}\n\na later, independent review's own genuinely new finding`, author: AUTOMATION },
    ];
    const plan = planReconcile({ prs: [prNeedsHuman({ comments })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({
      kind: 'fix', mode: 'advisory-fix', prNumber: 2601, attempts: 1, cap: ADVISORY_FIX_ROUND_CAP,
    })]);
  });

  // advisory-after-cap (web-everything/web-everything#2766, live-caught 2026-09-27, ~11:20Z), reconstructed from the
  // real thread shape (`gh pr view 2766 --repo web-everything/web-everything --json labels,comments,commits,headRefOid`):
  // a converted note + 3 fix-mark comments in ONE episode, then two real advisory notes each followed by one
  // completed fix episode (3 completed episodes total = AT the cap) — and the head then moved a FOURTH time via
  // a MERGE-CONFLICT fix (a different, non-advisory marker), never followed by a fresh advisory. The reconcile
  // pass correctly refuses `cap-exhausted` (no more auto-repair) but, before this item, ALSO refused the one
  // fresh review the operator needs, because nothing here had ever run `advise` against this exact head. Verified
  // live: `node scripts/conveyor/reconcile-pass.mjs --repo=web-everything/web-everything --json` read this PR as
  // `cap-exhausted`/`advisory-fix`, `attempts: 3, cap: 3`, with `headRefOid: 'd2453a582…'` — the same head this
  // fixture uses.
  const REAL_2766_HEAD = 'd2453a58216d6cc4b14a4e1f30c673451ca93485'; // measured live head, 2026-09-27T11:17:58Z
  const REAL_2766_REVIEWED_HEAD = 'c7dbec3b19543fe959dba5e6ddc1959689182e45'; // the ONLY head any advisory ever named
  // Verbatim (only whitespace-normalized) leading `Net basis:`/`**Verdict:**` lines off the real 11:07:58Z
  // advisory comment — the LATEST one on the real thread, and the one `latestAdvisory` must read as covering
  // `REAL_2766_REVIEWED_HEAD`, never `REAL_2766_HEAD`.
  const real2766LatestAdvisoryNote = {
    body: [
      `${ADVISORY_NOTE_MARKER} This PR carries \`review:human\`. The independent`,
      'AI review below ran automatically, before the required human review ceremony.',
      '',
      '## ⚠️ Advisory review (informational only) — web-everything/web-everything#2766',
      '',
      '**Verdict:** 🚦 human review required',
      '',
      '**Advisory outcome:** `changes` — blocking findings on this head; `advisory:changes` is applied.',
      '',
      '---',
      '',
      `Net basis: \`3f64a2804a38d544d4a477affc028957c6258ad9..${REAL_2766_REVIEWED_HEAD}\` (rev` +
        ' `origin/lane/2749-prevention-outstanding-verdict` at review time) — 5 net changed file(s) vs current main.',
    ].join('\n'),
    author: AUTOMATION,
  };
  const live2766Comments = () => [
      // Episode 1 — converted note, 3 clustered fix-marks (pre-dating the episode-counting fix; still ONE
      // completed episode).
      { body: `${CONVERTED_ADVISORY_NOTE_MARKER} converted note — the original test-gaming false positive`, author: AUTOMATION },
      { body: buildAdvisoryFixComment({}), author: AUTOMATION },
      { body: buildAdvisoryFixComment({}), author: AUTOMATION },
      { body: buildAdvisoryFixComment({}), author: AUTOMATION },
      // A real advisory note immediately followed by ANOTHER real advisory note with no fix in between (the
      // real thread's 02:29Z/02:49Z pair) — an INCOMPLETE episode, contributing 0.
      { body: `${ADVISORY_NOTE_MARKER}\n\nfindings from round 1`, author: AUTOMATION },
      { body: `${ADVISORY_NOTE_MARKER}\n\nfindings from round 2 (same as round 1 — no fix ran between them)`, author: AUTOMATION },
      // Episode 2 — completed.
      { body: buildAdvisoryFixComment({}), author: AUTOMATION },
      // Episode 3 — a real note, then a completed fix.
      { body: `${ADVISORY_NOTE_MARKER}\n\nfindings from round 3`, author: AUTOMATION },
      { body: buildAdvisoryFixComment({}), author: AUTOMATION },
      // The LATEST advisory note — 3 episodes are now spent (cap reached) and this is the ONLY head any
      // advisory has ever named.
      real2766LatestAdvisoryNote,
      // The head then moved a 4th time — a MERGE-CONFLICT fix (its own, different marker; never
      // `ADVISORY_FIX_COMMENT_MARKER`), so `isLatestAdvisoryFindingAddressed` correctly stays `false` and no
      // advisory has EVER run against `REAL_2766_HEAD`.
      { body: '🔧 **conveyor fix (`fix-2766`) — merge conflict with `main` resolved** (head `d2453a582`)', author: AUTOMATION },
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nA mechanical conflict-fix round merged main and re-armed.`, author: AUTOMATION },
  ];
  it('THE LIVE web-everything/web-everything#2766 SHAPE (2026-09-27, ~11:20Z): advisory-fix cap genuinely AT 3/3, then the head moved via a merge-conflict fix with no advisory yet — owed a fresh REVIEW, never another fixer, never a silent cap-exhausted dead end', () => {
    const comments = live2766Comments();
    const pr = prNeedsHuman({ comments, headRefOid: REAL_2766_HEAD });
    // Sanity on the fixture itself, so a future edit to it can't silently stop exercising the cap.
    expect(countCompletedAdvisoryEpisodes(comments)).toBe(ADVISORY_FIX_ROUND_CAP);
    expect(isLatestAdvisoryFindingAddressed(comments)).toBe(false);

    const plan = planReconcile({ prs: [pr], agents: [], now: NOW });
    // THE FIX: never a fixer (the cap is genuinely spent) — but a fresh review IS owed, because the newest
    // advisory (reviewed head `c7dbec3b1…`) does not cover this PR's current head (`d2453a582…`).
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({
      kind: 'review', prNumber: 2601, attempts: ADVISORY_FIX_ROUND_CAP, cap: ADVISORY_FIX_ROUND_CAP,
    })]);
    expect(plan.dispatch[0].mode).toBeUndefined(); // never `mode: 'advisory-fix'` — this is a review, not a fixer.
  });

  // xuxcsw6 — live 2026-10-04, #3771: both direct review branches (a fix postdates the advisory; the newest
  // advisory does not cover the head) bypassed the referral hold and re-dispatched a full review each tick.
  const referralHold = { head: 'a'.repeat(40), episode: 'e', count: 2, why: 'review paused: 2 referrals need a ruling; it resumes on a new push, a ruling, or a send-back' };
  it('xuxcsw6 — a held PR is refused review-referrals-pending on the stale-advisory branch, and not when the hold lifts', () => {
    const pr = prNeedsHuman({ comments: live2766Comments(), headRefOid: REAL_2766_HEAD });
    const held = planReconcile({ prs: [{ ...pr, referralHold }], agents: [], now: NOW });
    expect(held.dispatch).toEqual([]);
    expect(held.refusals).toEqual([expect.objectContaining({ kind: 'review-referrals-pending', prNumber: 2601 })]);
    expect(planReconcile({ prs: [{ ...pr, referralHold: null }], agents: [], now: NOW }).dispatch)
      .toEqual([expect.objectContaining({ kind: 'review' })]);
  });

  // The exemption above is narrow to a head an advisory has NEVER covered. A PR at the SAME cap, whose newest
  // advisory DOES cover its current head (nothing has moved since that verdict — the ordinary, genuinely
  // unfixable case), must stay EXACTLY as capped as before this item — no dispatch, plain `cap-exhausted`.
  it('a PR AT the advisory-fix cap whose newest advisory covers the CURRENT head stays a plain `cap-exhausted` refusal (unaffected by the new exemption)', () => {
    const comments = [
      { ...real2766LatestAdvisoryNote },
      // no head-moving comment after it — the reviewed head IS the live head.
    ];
    for (let i = 0; i < ADVISORY_FIX_ROUND_CAP - 1; i += 1) {
      comments.push({ body: buildAdvisoryFixComment({}), author: AUTOMATION });
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nstill broken, round ${i}`, author: AUTOMATION });
    }
    const pr = prNeedsHuman({ comments, headRefOid: REAL_2766_REVIEWED_HEAD });
    expect(countCompletedAdvisoryEpisodes(comments)).toBeGreaterThanOrEqual(1);
    const plan = planReconcile({ prs: [pr], agents: [], now: NOW, advisoryFixCap: 1 });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'advisory-fix' })]);
  });

  // PR #2806 review:changes (correctness + security, both CONFIRMED): the covers-head read must trust-gate the
  // advisory it reads, like every other marker reader in this file (#3383). WE's PRs are public, so any GitHub
  // account can post a comment shaped like an advisory (`**Verdict:**` + `Net basis: <base>..<head>`). Both
  // directions are pinned: a forgery must neither SUPPRESS the owed review nor MANUFACTURE an unowed one.
  const forgedAdvisory = (head) => ({
    body: `**Verdict:** ✅ accept\n\nNet basis: \`${'0'.repeat(40)}..${head}\` (forged)`,
    author: { login: 'random-external-account' },
  });
  it('#2806 — a forged (untrusted) advisory naming the CURRENT head never suppresses the review the live #2766 shape is owed', () => {
    const comments = [...live2766Comments(), forgedAdvisory(REAL_2766_HEAD)];
    const plan = planReconcile({ prs: [prNeedsHuman({ comments, headRefOid: REAL_2766_HEAD })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2601 })]);
  });
  it('#2806 — a forged (untrusted) advisory naming a DIFFERENT head never manufactures a review past a genuine advisory that covers the current head', () => {
    const comments = [{ ...real2766LatestAdvisoryNote }, forgedAdvisory('f'.repeat(40))];
    for (let i = 0; i < ADVISORY_FIX_ROUND_CAP - 1; i += 1) {
      comments.push({ body: buildAdvisoryFixComment({}), author: AUTOMATION });
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nstill broken, round ${i}`, author: AUTOMATION });
    }
    const plan = planReconcile({
      prs: [prNeedsHuman({ comments, headRefOid: REAL_2766_REVIEWED_HEAD })], agents: [], now: NOW, advisoryFixCap: 1,
    });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'advisory-fix' })]);
  });

  // PR #2800 advisory finding (CONFIRMED): the episode counter trust-gates note boundaries, but the "addressed"
  // check did not — so an untrusted commenter posting a forged note every tick kept `addressed` false forever,
  // while every genuine fix-mark landed inside the SAME already-completed episode and never advanced the count.
  // Simulated end to end: each tick a forged note arrives, then whatever the planner dispatched runs (a fix
  // posts a trusted fix-mark; a review posts a trusted note that still finds the head broken).
  it('a forged-note flood from an untrusted login can never defeat the advisory-fix cap — cap-exhausted still fires', () => {
    const MALLORY = { login: 'mallory' };
    const comments = [
      { body: `${ADVISORY_NOTE_MARKER}\n\nround 1`, author: AUTOMATION },
      { body: buildAdvisoryFixComment({}), author: AUTOMATION },
    ];
    let capped = null;
    for (let tick = 0; tick < ADVISORY_FIX_ROUND_CAP * 4 && !capped; tick += 1) {
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nforged ${tick}`, author: MALLORY });
      const plan = planReconcile({ prs: [prNeedsHuman({ comments: [...comments] })], agents: [], now: NOW });
      capped = plan.refusals.find((r) => r.kind === 'cap-exhausted') ?? null;
      const d = plan.dispatch[0];
      if (d?.kind === 'fix') comments.push({ body: buildAdvisoryFixComment({}), author: AUTOMATION });
      else if (d?.kind === 'review') comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nstill broken ${tick}`, author: AUTOMATION });
    }
    expect(capped).toEqual(expect.objectContaining({ capKind: 'advisory-fix', attempts: ADVISORY_FIX_ROUND_CAP, cap: ADVISORY_FIX_ROUND_CAP }));
  });

  // #2800 advisory finding, Codex advisory follow-up — a BOUNDED FALLBACK for a rarer but concrete gap the
  // forged-note-flood test above does not cover: GitHub lets a comment be edited or deleted, so the SOLE
  // advisory-note comment a finding depends on can vanish from the thread entirely while `advisory:changes` — a
  // separate, sticky LABEL — survives. With no trusted note left AT ALL (not even a forged one),
  // `countCompletedAdvisoryEpisodes`'s per-note-episode loop never runs (`noteIndices` is empty) and used to
  // return 0 FOREVER no matter how many trusted advisory-fix marks piled up; `isLatestAdvisoryFindingAddressed`
  // independently stays `false` too (no `lastNoteIndex`). Both gates open at once: the `!addressed` branch's own
  // `advisoryFixes >= advisoryFixCap` check never trips, so nothing bounds this population's fixer redispatch.
  // Simulated end to end exactly like the forged-note-flood case: no note is ever (re)posted — the deleted-note
  // shape — only trusted advisory-fix marks accumulate from whatever the planner dispatches.
  it('#2800 — the sole advisory note is deleted while advisory:changes remains: trusted fix marks still bound the cap (no unlimited fixer dispatch)', () => {
    // The finding itself survives independently of the note MARKER — e.g. pre-dating the marker convention, or
    // simply left behind by the same edit/delete that removed the note's leading line. Not a trusted advisory
    // note (`isTrustedAdvisoryNote` matches neither marker prefix), so it opens no episode — exactly the shape
    // this fix must still bound.
    const comments = [{ body: 'security: broken access control in the new handler', author: AUTOMATION }];
    let capped = null;
    let fixDispatches = 0;
    for (let tick = 0; tick < ADVISORY_FIX_ROUND_CAP * 4 && !capped; tick += 1) {
      const plan = planReconcile({ prs: [prNeedsHuman({ comments: [...comments] })], agents: [], now: NOW });
      capped = plan.refusals.find((r) => r.kind === 'cap-exhausted') ?? null;
      const d = plan.dispatch[0];
      if (d?.kind === 'fix') { fixDispatches += 1; comments.push({ body: buildAdvisoryFixComment({}), author: AUTOMATION }); }
    }
    // BOUNDED — the whole point: the loop above runs for a fixed, finite tick ceiling (`ADVISORY_FIX_ROUND_CAP *
    // 4`) and this asserts `cap-exhausted` was reached WELL before that ceiling — i.e. dispatch genuinely
    // stopped, rather than cycling `fix` on every single tick the way the pre-fix code did (which would run this
    // loop to its ceiling with `capped` still `null`, failing the assertion below).
    expect(capped).toEqual(expect.objectContaining({ capKind: 'advisory-fix', cap: ADVISORY_FIX_ROUND_CAP }));
    expect(fixDispatches).toBeLessThan(ADVISORY_FIX_ROUND_CAP * 4);
  });

  it('a caller-supplied `advisoryFixCap` overrides the default', () => {
    const plan = planReconcile({ prs: [prNeedsHuman()], agents: [], now: NOW, advisoryFixCap: 0 });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 0, capKind: 'advisory-fix' })]);
  });

  it('a REARM/ordinary comment count never leaks into the advisory-fix cap — independent floors', () => {
    const shared = Array.from({ length: NEGOTIATION_ROUND_CAP + 2 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({ prs: [prNeedsHuman({ comments: [advisoryNote, ...shared] })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'advisory-fix', attempts: 0 })]);
  });

  it('`needs-human` with NO `advisory:changes` label is unaffected — still the ordinary `review` dispatch', () => {
    const plan = planReconcile({ prs: [prNeedsHuman({ labels: lbl('review:human'), comments: [finding()] })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2601 })]);
  });

  it('the advisory-fix and conflict-fix markers are BOOKKEEPING, never counted as a reviewer finding', () => {
    expect(countFindings([{ body: CONFLICT_FIX_COMMENT_MARKER }, { body: ADVISORY_FIX_COMMENT_MARKER }])).toBe(0);
  });

  it('`countAdvisoryFixComments` narrows on the leading line, like every sibling counter', async () => {
    const { countAdvisoryFixComments } = await import('../advisory-fix-mark.mjs');
    expect(countAdvisoryFixComments([{ body: ADVISORY_FIX_COMMENT_MARKER + '\n\nmore', author: AUTOMATION }])).toBe(1);
    expect(countAdvisoryFixComments([{ body: `> ${ADVISORY_FIX_COMMENT_MARKER}`, author: AUTOMATION }])).toBe(0);
    expect(countAdvisoryFixComments(undefined)).toBe(0);
  });
});

describe('case 5h — real web-everything/web-everything#2549 shape (measured 2026-09-24, the live case #xkmu3gv closes)', () => {
  // The actual live labels this PR carried when this item was built (`review:changes`, `review:human`,
  // `merge-status:conflicting`, `advisory:changes`, `review-round:5`) — before this item, `runReconcilePass`
  // against the real repo refused it `cap-exhausted` outright, with no advisory fix ever owed. See the PR body
  // for the full real dry-run output this pins as a fixture.
  it('is owed a `fix` (conflict route, with the advisory finding named on the row), not refused', () => {
    const pr2549 = pr1563({
      number: 2549,
      labels: [...lbl('review:changes', 'review:human', 'merge-status:conflicting', 'review-round:5', 'advisory:changes')],
      comments: [finding('a security/coverage gap — card xlqampw lacks a blockedBy on decision card xcw0nxo')],
    });
    const plan = planReconcile({ prs: [pr2549], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({
      kind: 'fix', prNumber: 2549, isConflict: true, advisoryPending: true, attempts: 0, cap: CONFLICT_FIX_ROUND_CAP,
    })]);
  });
});

// #3794 live case, 2026-10-04.
describe('main-fixed signature before the heal cap', () => {
  const window = { from: '2026-10-05T00:00:00Z', to: '2026-10-05T01:44:46Z' };
  const comments = Array.from({ length: 3 }, () => ({
    body: CI_HEAL_COMMENT_MARKER, author: AUTOMATION, createdAt: '2026-10-05T01:00:00Z',
  }));
  const pr = pr1563({ number: 3794, labels: [], statusCheckRollup: redRollup, comments,
    aheadByOnMain: 3, requiredCheckName: 'test', requiredCheckCompletedAt: '2026-10-05T00:54:36Z' });
  it('owes a rebase despite three spent heals; no facts preserves exhaustion', () => {
    const mainFixedSignature = { signatures: [{ emitterFiles: ['scripts/check-standards.mjs'], fixCommits: ['e5c22481e'] }],
      bugIntroducedAt: window.from, fixedAt: window.to };
    const plan = planReconcile({ prs: [{ ...pr, mainFixedSignature }] });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun', why: expect.stringContaining('e5c22481e') })]);
    expect(plan.notes.some((n) => n.kind === 'ci-heal-exhausted')).toBe(false);
    expect(planReconcile({ prs: [pr] }).refusals[0].kind).toBe('cap-exhausted');
  });
  it('uses chargeable attempts after the rebase and exposes refunds; opt-out keeps the cap', () => {
    const rebased = { ...pr, aheadByOnMain: 0, comments: [...comments, { author: AUTOMATION,
      body: buildRebaseOntoMainComment({ attribution: 'main-fixed-signature', attributedWindow: window }),
    }] };
    expect(planReconcile({ prs: [rebased], ciHealBudgetRestore: true }).dispatch[0])
      .toMatchObject({ kind: 'ci-heal', attempts: 0, refunded: 3 });
    expect(planReconcile({ prs: [rebased], ciHealBudgetRestore: true, ciHealCap: 0 }).refusals[0])
      .toMatchObject({ kind: 'cap-exhausted', attempts: 0, refunded: 3 });
    expect(planReconcile({ prs: [rebased], ciHealBudgetRestore: false }).refusals[0])
      .toMatchObject({ kind: 'cap-exhausted', attempts: 3 });
  });
});

describe('case 5i — STACKED-BASE CONFLICT dispatch, a `conflicted` PR whose base is not `main` (#3383)', () => {
  // `web-everything/web-everything#2578`, shape measured live 2026-09-24: `review:accepted` (no `review:changes`, no
  // `review:human`), `mergeStateStatus: DIRTY`/`mergeable: CONFLICTING` (`classifyPr` reads `conflicted`), base
  // `lane/3681-ratify-daemon-lifecycle` — stacked on PR #2549, NOT `main`. BEFORE this branch existed,
  // `runReconcilePass({repo:'web-everything/web-everything'})` refused this `owed-elsewhere` ("the branch needs a
  // rebase before it can merge"), a rebase the drain will never perform for a non-default-base PR
  // (`#poc-branch-declared-delivery-mode` clause 5) — a genuine stacked-PR gap no daemon closed.
  const prStacked = (over = {}) => pr1563({
    number: 2578,
    labels: lbl('review:accepted', 'checking', 'review-round:2', 'merge-status:conflicting', 'advisory:accepted'),
    mergeStateStatus: 'DIRTY',
    baseRefName: 'lane/3681-ratify-daemon-lifecycle',
    comments: [],
    ...over,
  });

  it('a stacked, conflicted PR with zero prior conflict-fix rounds is dispatched `fix` (mode stacked-rebase), never `owed-elsewhere`', () => {
    const plan = planReconcile({ prs: [prStacked()], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({
      kind: 'fix', prNumber: 2578, isConflict: true, mode: 'stacked-rebase',
      baseRefName: 'lane/3681-ratify-daemon-lifecycle', attempts: 0, cap: CONFLICT_FIX_ROUND_CAP,
    })]);
  });

  it('review:accepted rides through UNCHANGED on the dispatch row — this population is never bounced first', () => {
    const plan = planReconcile({ prs: [prStacked()], agents: [], now: NOW });
    expect(plan.dispatch[0].labels).toContain('review:accepted');
  });

  it('shares the SAME durable conflict-fix cap/marker PR #2579 added — never a fourth counter', () => {
    const comments = Array.from({ length: CONFLICT_FIX_ROUND_CAP - 1 }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({ prs: [prStacked({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'stacked-rebase', attempts: CONFLICT_FIX_ROUND_CAP - 1 })]);
  });

  it(`AT the cap (${CONFLICT_FIX_ROUND_CAP} durable conflict-fix comments) the PR is refused \`cap-exhausted\`, capKind \`stacked-rebase\` — never \`owed-elsewhere\``, () => {
    // xilx617 — `capKind` is now `stacked-rebase` here, DISTINCT from the plain conflict-fix bounce's
    // `conflict-fix` above, even though both share the identical cap/counter (see this branch's own docblock) —
    // the `round-cap-exhausted` note needs to say WHICH population is exhausted, and "a stacked PR's rebase
    // against its own base" reads differently from "a bounced PR's conflict resolution against main".
    const comments = Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({ prs: [prStacked({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'cap-exhausted', prNumber: 2578, attempts: CONFLICT_FIX_ROUND_CAP, cap: CONFLICT_FIX_ROUND_CAP, capKind: 'stacked-rebase',
    })]);
  });

  it('a caller-supplied `conflictFixCap` overrides the default here too', () => {
    const plan = planReconcile({ prs: [prStacked({ comments: [{ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }] })], agents: [], now: NOW, conflictFixCap: 1 });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 1, capKind: 'stacked-rebase' })]);
  });

  it('REGRESSION — a `conflicted` PR whose base IS `main` (or unknown) is UNCHANGED: still `owed-elsewhere`', () => {
    const planMainBase = planReconcile({ prs: [prStacked({ baseRefName: 'main' })], agents: [], now: NOW });
    expect(planMainBase.dispatch).toHaveLength(0);
    expect(planMainBase.refusals).toEqual([expect.objectContaining({ kind: 'owed-elsewhere', prNumber: 2578 })]);

    const planNoBase = planReconcile({ prs: [prStacked({ baseRefName: undefined })], agents: [], now: NOW });
    expect(planNoBase.dispatch).toHaveLength(0);
    expect(planNoBase.refusals).toEqual([expect.objectContaining({ kind: 'owed-elsewhere', prNumber: 2578 })]);
  });

  it('REGRESSION — the normal retarget path (GitHub flips `baseRefName` to `main` once the stacked base merges) falls straight through to the ordinary path, unaffected', () => {
    // Simulates the PR's base branch merging into `main` and GitHub retargeting the PR — from this pass's own
    // point of view that is INDISTINGUISHABLE from an ordinary main-base conflict, which is exactly the point:
    // no special-casing was needed for this transition.
    const retargeted = prStacked({ baseRefName: 'main' });
    const plan = planReconcile({ prs: [retargeted], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'owed-elsewhere', why: 'the branch needs a rebase before it can merge' })]);
  });

  it('a caller-supplied `defaultBranch` overrides `main` — a PR based on the repo\'s ACTUAL default is not "stacked"', () => {
    const plan = planReconcile({ prs: [prStacked({ baseRefName: 'trunk' })], agents: [], now: NOW, defaultBranch: 'trunk' });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'owed-elsewhere', prNumber: 2578 })]);
  });

  it('never fires for a non-`conflicted` phase — a stacked, BOUNCED PR is handled by the existing conflict-fix branch instead', () => {
    const bounced = pr1563({
      number: 2579,
      labels: lbl('review:changes', 'merge-status:conflicting'),
      mergeStateStatus: 'DIRTY',
      baseRefName: 'lane/some-other-base',
      comments: [finding()],
    });
    const plan = planReconcile({ prs: [bounced], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', isConflict: true, prNumber: 2579 })]);
    expect(plan.dispatch[0].mode).not.toBe('stacked-rebase'); // the ordinary `isConflictBounce` branch owns this row
  });

  it('every row carries `baseRefName` as evidence, dispatch and refusal alike', () => {
    const plan = planReconcile({ prs: [prStacked()], agents: [], now: NOW });
    expect(plan.dispatch[0].baseRefName).toBe('lane/3681-ratify-daemon-lifecycle');
  });

  // #4265 (PR #2797 review, live incident 2026-09-27) — `currentSha` USED TO BE HARDCODED `null` for this
  // branch's own call into `countStaleConflictFixRounds`, in contrast to the main-base branch a few hundred
  // lines below (which threads a real, freshly-resolved `mainSha`). Mirrors the #2787 `mainSha` reproduction
  // above (lines ~1477-1527), but for the STACKED-base branch's own `base.baseRefSha`.
  describe('#4265 stacked-base `currentSha` (base.baseRefSha) — was hardcoded null, exhausting the cap across different tips', () => {
    const BASE_REF = 'lane/3681-ratify-daemon-lifecycle';
    const roundAt = (sha, n) => ({
      body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nconveyor fix agent resolved this PR's conflict against ` +
        `\`${BASE_REF}\` round ${n}\n\n<!-- conveyor-conflict-fix-target: ${BASE_REF}@${sha} -->`,
      author: AUTOMATION,
    });

    it('3 repairs against 3 successively OLDER tips of the SAME repeatedly-rebased stacked base do NOT exhaust the cap when the current tip is newer still — dispatches, attempts 0 (reproduction)', () => {
      const priorRounds = [roundAt('aaa1111', 1), roundAt('bbb2222', 2), roundAt('ccc3333', 3)];
      const pr = prStacked({ comments: [...priorRounds], baseRefSha: 'ddd4444' });
      const plan = planReconcile({ prs: [pr], agents: [], now: NOW });
      expect(plan.refusals).toEqual([]);
      expect(plan.dispatch).toEqual([expect.objectContaining({
        kind: 'fix', prNumber: 2578, mode: 'stacked-rebase', attempts: 0, cap: CONFLICT_FIX_ROUND_CAP,
      })]);
    });

    it('a round against the SAME current baseRefSha still counts as stale — genuinely stuck, not a moving target', () => {
      const comments = Array.from({ length: CONFLICT_FIX_ROUND_CAP }, (_, i) => roundAt('aaa1111', i + 1));
      const pr = prStacked({ comments, baseRefSha: 'aaa1111' });
      const plan = planReconcile({ prs: [pr], agents: [], now: NOW });
      expect(plan.dispatch).toHaveLength(0);
      expect(plan.refusals).toEqual([expect.objectContaining({
        kind: 'cap-exhausted', prNumber: 2578, attempts: CONFLICT_FIX_ROUND_CAP, cap: CONFLICT_FIX_ROUND_CAP, capKind: 'stacked-rebase',
      })]);
    });

    it('REGRESSION — with no `baseRefSha` supplied at all (the pre-#4265 shape), stale counting still degrades safely to ref-only (unchanged default)', () => {
      const comments = Array.from({ length: CONFLICT_FIX_ROUND_CAP }, (_, i) => roundAt('aaa1111', i + 1));
      const pr = prStacked({ comments }); // no baseRefSha field at all
      const plan = planReconcile({ prs: [pr], agents: [], now: NOW });
      expect(plan.dispatch).toHaveLength(0);
      expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'stacked-rebase' })]);
    });

    it('every row carries `baseRefSha` as evidence, dispatch and refusal alike', () => {
      const plan = planReconcile({ prs: [prStacked({ baseRefSha: 'ddd4444' })], agents: [], now: NOW });
      expect(plan.dispatch[0].baseRefSha).toBe('ddd4444');
    });
  });
});

// ── CASE 6 — THE ARGV, PINNED ─────────────────────────────────────────────────────────────────────────────────
//
// The one thing fixtures cannot prove. A wrong discovery query does not throw — it returns nothing, and nothing
// is exactly what a perfectly reconciled fleet looks like. Every case above would stay green.
describe('case 6 — the discovery queries, pinned literally (#3296)', () => {
  it('the session listing is `claude agents --json`, byte-for-byte what dispatch-lane-io already builds', () => {
    const { exec, calls } = spyExec('[]');
    defaultReadAgents({ exec, env: {} });
    expect(calls[0].file).toBe('claude');
    expect(calls[0].argv).toEqual(['agents', '--json']);
  });

  it('the PR query asks `--state open`; NOT `--state all` — the opposite reader\'s flag hides nothing here, this one hides everything', () => {
    // `dispatch-lane-defaults.test.mjs` pins `--state all` for an observer that resolves on MERGED PRs. This
    // pass reconciles OPEN ones. Copying that flag across would drown four open PRs in 29 merged ones and, worse,
    // would look like it was working.
    const { exec, calls } = spyExec('[]');
    defaultReadPrs({ exec });
    expect(calls[0].file).toBe('gh');
    const stateAt = calls[0].argv.indexOf('--state');
    expect(stateAt).toBeGreaterThan(-1);
    expect(calls[0].argv[stateAt + 1]).toBe('open');
    expect(calls[0].argv[stateAt + 1]).not.toBe('all');
  });

  it('`headRefOid` is in `--json` — without it NOTHING binds and every PR reads as unowned', () => {
    const { exec, calls } = spyExec('[]');
    defaultReadPrs({ exec });
    const jsonAt = calls[0].argv.indexOf('--json');
    expect(jsonAt).toBeGreaterThan(-1);
    const fields = String(calls[0].argv[jsonAt + 1]).split(',');
    expect(fields).toEqual(expect.arrayContaining([
      'number', 'headRefName', 'headRefOid', 'labels', 'statusCheckRollup', 'mergeStateStatus', 'comments',
    ]));
    expect(PR_LIST_JSON_FIELDS.split(',')).toEqual(fields);
  });

  it('the whole argv, in one assertion — a rename or a dropped flag reddens exactly here', () => {
    const { exec, calls } = spyExec('[]');
    defaultReadPrs({ exec });
    expect(calls[0].argv).toEqual([
      'pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_LIST_JSON_FIELDS,
    ]);
  });

  it('an empty listing is an empty array, not a throw — and yields an empty plan, not a silent one', () => {
    expect(defaultReadPrs({ exec: () => '' })).toEqual([]);
    expect(planReconcile({ prs: [], agents: [], durableCounts: {}, now: NOW }))
      .toEqual({ dispatch: [], refusals: [], notes: [] });
  });
});

describe('selectStatusCandidates — which PRs deserve a review-status refresh (PR #1920/#2472/#2711 staleness, x5v8yy9/x8who76)', () => {
  it('includes an owed-elsewhere refusal (e.g. ci-red) — it is a real conveyor PR, not an unrelated one', () => {
    // `needs-human` no longer produces `owed-elsewhere` (xpprcdz dispatches `review` for it instead) — `ci-red`
    // is the current real example of a phase this pass refuses as someone else's job.
    const refusals = [{ prNumber: 1920, kind: 'owed-elsewhere', phase: 'ci-red' }];
    expect(selectStatusCandidates([], refusals)).toEqual(refusals);
  });

  it('no longer excludes nothing-owed (x8who76 — see the dedicated test below for why)', () => {
    const refusals = [
      { prNumber: 1, kind: 'nothing-owed', phase: 'queued' },
      { prNumber: 2, kind: 'owed-elsewhere', phase: 'ci-red' },
      { prNumber: 3, kind: 'cap-exhausted' },
    ];
    expect(selectStatusCandidates([], refusals).map((r) => r.prNumber)).toEqual([1, 2, 3]);
  });

  // Live-caught 2026-09-26, PR #2711, card x8who76: SAME BUG CLASS as #1920/#2472 above, a third exclusion.
  // `nothing-owed` used to be dropped outright on the premise it never carries anything live — true in
  // steady state, false at the exact tick a PR TRANSITIONS into it. #2711 got `review:accepted` (phase
  // `queued` → refusal kind `nothing-owed`) while still carrying `review-status:reviewing` from the round
  // that had just finished; excluding `nothing-owed` meant `review-status-tag.mjs` was never called again to
  // notice the review session/job was gone and clear it — the label sat stale, "accepted AND reviewing" at
  // once, a live contradiction the operator caught.
  it('includes a nothing-owed refusal — a PR that just went quiet still deserves one more status refresh to clear a stale label', () => {
    const refusals = [{ prNumber: 2711, kind: 'nothing-owed', phase: 'queued' }];
    expect(selectStatusCandidates([], refusals)).toEqual(refusals);
  });

  it('includes every reviewsOwed entry regardless of refusals', () => {
    const reviewsOwed = [{ prNumber: 42, kind: 'review' }];
    expect(selectStatusCandidates(reviewsOwed, [])).toEqual(reviewsOwed);
  });

  it('tolerates non-array input', () => {
    expect(selectStatusCandidates(null, null)).toEqual([]);
    expect(selectStatusCandidates(undefined, undefined)).toEqual([]);
  });

  // Live-caught 2026-09-22, PR #2472: same root shape as the #1920 owed-elsewhere miss above, a different
  // exclusion — a PR that moved to being owed a FIX (not a review) never got its status label re-derived,
  // so review-status:reviewing sat stale for ~2 hours after its review session had already finished.
  it('includes every fixesOwed entry too — a PR owed a fix deserves a status refresh exactly like one owed a review', () => {
    const fixesOwed = [{ prNumber: 2472, kind: 'fix' }];
    expect(selectStatusCandidates([], [], fixesOwed)).toEqual(fixesOwed);
  });

  it('combines reviewsOwed + fixesOwed + every refusal (including nothing-owed), all three sources at once', () => {
    const reviewsOwed = [{ prNumber: 1, kind: 'review' }];
    const fixesOwed = [{ prNumber: 2, kind: 'fix' }];
    const refusals = [{ prNumber: 3, kind: 'owed-elsewhere' }, { prNumber: 4, kind: 'nothing-owed' }];
    expect(selectStatusCandidates(reviewsOwed, refusals, fixesOwed).map((c) => c.prNumber)).toEqual([1, 2, 3, 4]);
  });

  it('a 2-arg call (fixesOwed omitted) still passes every refusal through unfiltered', () => {
    const reviewsOwed = [{ prNumber: 1 }];
    const refusals = [{ prNumber: 2, kind: 'owed-elsewhere' }];
    expect(selectStatusCandidates(reviewsOwed, refusals)).toEqual([{ prNumber: 1 }, { prNumber: 2, kind: 'owed-elsewhere' }]);
  });

  it('tolerates non-array fixesOwed', () => {
    expect(selectStatusCandidates([], [], null)).toEqual([]);
    expect(selectStatusCandidates([], [], undefined)).toEqual([]);
  });

  // Live-caught 2026-09-26, PR #2742, card xg790dh: same root shape as the fixesOwed miss above, a FOURTH
  // exclusion — a PR that moved from being owed a FIX to being owed a CI-HEAL (its fix session finished, its
  // re-push then went CI-red) never got its status label re-derived either: `kind:'ci-heal'` matched neither
  // `reviewsOwed` nor `fixesOwed`, and a ci-heal-owed PR is a real `dispatch` entry (not a refusal) whenever its
  // cap is unspent — so `review-status:fixing` sat stale indefinitely once the fix finished.
  it('includes every ciHealsOwed entry too — a PR owed a ci-heal deserves a status refresh exactly like one owed a fix', () => {
    const ciHealsOwed = [{ prNumber: 2742, kind: 'ci-heal' }];
    expect(selectStatusCandidates([], [], [], ciHealsOwed)).toEqual(ciHealsOwed);
  });

  it('combines reviewsOwed + fixesOwed + ciHealsOwed + every refusal, all four sources at once', () => {
    const reviewsOwed = [{ prNumber: 1, kind: 'review' }];
    const fixesOwed = [{ prNumber: 2, kind: 'fix' }];
    const ciHealsOwed = [{ prNumber: 5, kind: 'ci-heal' }];
    const refusals = [{ prNumber: 3, kind: 'owed-elsewhere' }, { prNumber: 4, kind: 'nothing-owed' }];
    expect(selectStatusCandidates(reviewsOwed, refusals, fixesOwed, ciHealsOwed).map((c) => c.prNumber)).toEqual([1, 2, 5, 3, 4]);
  });

  it('a 3-arg call (ciHealsOwed omitted) still passes every refusal through unfiltered', () => {
    const reviewsOwed = [{ prNumber: 1 }];
    const refusals = [{ prNumber: 2, kind: 'owed-elsewhere' }];
    expect(selectStatusCandidates(reviewsOwed, refusals, [])).toEqual([{ prNumber: 1 }, { prNumber: 2, kind: 'owed-elsewhere' }]);
  });

  it('tolerates non-array ciHealsOwed', () => {
    expect(selectStatusCandidates([], [], [], null)).toEqual([]);
    expect(selectStatusCandidates([], [], [], undefined)).toEqual([]);
  });
});

it('binds names only for the invocation repo', () => {
  const agents = ['review-49', 'review-fui-49', 'fix-fui-49', 'review-pa-49'].map((name) => ({ name }));
  expect(bindAgents({ number: 49 }, agents, 'frontierui').map((b) => b.agent.name)).toEqual(['review-fui-49', 'fix-fui-49']);
  expect(bindAgents({ number: 49 }, agents).map((b) => b.agent.name)).toEqual(['review-49']);
  const pr = pr1563({ number: 49 });
  const live = [{ name: 'review-fui-49', pidAlive: true, pid: 1 }];
  expect(planReconcile({ prs: [pr], agents: live, repo: 'frontierui' }).refusals.some((r) => r.kind === 'live-process')).toBe(true);
  expect(planReconcile({ prs: [pr], agents: live }).dispatch).toHaveLength(1);
});

// ── xpb0zyq — a session that REPORTED its own completion is finished, whatever the listing says ──────────────
describe('markSelfReportedDone + assessLiveness — self-reported completion (xpb0zyq, live 2026-09-23)', () => {
  const T0 = Date.parse('2026-09-23T13:51:10Z');
  // The live shape: `claude agents` still says `blocked`; the session's own record says done/blocked-on-infra.
  const listed = { name: 'review-2513', state: 'blocked', status: 'idle', startedAt: T0, pid: 4242 };
  const record = { status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-09-23T13:52:01Z' };
  const recFor = (r) => (name) => (name === 'review-2513' ? r : null);

  it('THE LIVE CASE: blocked-on-infra, cool-off elapsed → finished, so the PR is re-dispatched', () => {
    const [a] = markSelfReportedDone([listed], recFor(record), Date.parse('2026-09-23T14:30:00Z'));
    expect(a.selfReportedDone).toBe(true);
    expect(a.selfReportedOutcome).toBe('blocked-on-infra');
    expect(assessLiveness([{ agent: a, cwd: '/c', sha: '' }])).toBeNull();
  });

  it('blocked-on-infra INSIDE the cool-off is not yet finished — a persistent outage is not retried every tick', () => {
    const [a] = markSelfReportedDone([listed], recFor(record), Date.parse('2026-09-23T13:55:00Z'));
    expect(a.selfReportedDone).toBeUndefined();
  });

  it('any other done outcome counts at once', () => {
    const [a] = markSelfReportedDone([listed], recFor({ ...record, outcome: 'accepted' }), Date.parse('2026-09-23T13:52:30Z'));
    expect(a.selfReportedDone).toBe(true);
  });

  it('a record OLDER than the session is a previous run with the same name — the fresh run stays live', () => {
    const fresh = { ...listed, startedAt: Date.parse('2026-09-23T14:10:00Z') };
    const [a] = markSelfReportedDone([fresh], recFor(record), Date.parse('2026-09-23T15:00:00Z'));
    expect(a.selfReportedDone).toBeUndefined();
  });

  it('no record, a not-done record, or a reader that throws → the row is untouched', () => {
    const now = Date.parse('2026-09-23T15:00:00Z');
    expect(markSelfReportedDone([listed], () => null, now)[0]).toBe(listed);
    expect(markSelfReportedDone([listed], recFor({ ...record, status: 'running' }), now)[0]).toBe(listed);
    expect(markSelfReportedDone([listed], () => { throw new Error('corrupt'); }, now)[0]).toBe(listed);
  });

  it('end to end: a review:pending PR bound (by name) only to a self-reported-done reviewer is owed a review again', () => {
    const pr = pr1563({ number: 2513, labels: lbl('review:pending'), comments: [] });
    const agents = markSelfReportedDone([listed], recFor(record), Date.parse('2026-09-23T14:30:00Z'));
    const plan = planReconcile({ prs: [pr], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2513 })]);
  });

  it('the same PR with the RAW listing (no self-report marking) stays refused — the bug this fixes', () => {
    const pr = pr1563({ number: 2513, labels: lbl('review:pending'), comments: [] });
    const plan = planReconcile({ prs: [pr], agents: [listed], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
  });
});

// #4306 (epic #3383/#4075, BLOCKER fix-2821) — GUARD 2: "a completion record only ever speaks for the session
// that wrote it." Live 2026-09-27: two fix-2821 fixers (A finished, B still live) shared one completion-record
// name; the reaper's backstop for A clobbered B's own `started` record with a `done` A never wrote. This is the
// READER half of the fix — `markSelfReportedDone` must never apply a FOREIGN session's record to a different,
// still-live row.
describe('markSelfReportedDone Guard-2 sessionId binding (#4306) — a foreign record never unbinds a live session', () => {
  const T0 = Date.parse('2026-09-27T20:53:27Z');
  const listedB = { name: 'review-2513', state: 'blocked', status: 'idle', startedAt: T0, pid: 9999, sessionId: 'B' };

  it('a record whose sessionId is FOREIGN to the row never marks it self-reported-done, however its status/updatedAt read', () => {
    const foreignDone = { status: 'done', outcome: 'unreported-exit', sessionId: 'A', updatedAt: '2026-09-27T21:30:00Z' };
    const [a] = markSelfReportedDone([listedB], () => foreignDone, Date.parse('2026-09-27T22:00:00Z'));
    expect(a).toBe(listedB); // untouched — same "left exactly alone" contract as no-record/not-done above
  });

  it('a record whose sessionId matches the row still marks it done — unchanged from before this card', () => {
    const ownDone = { status: 'done', outcome: 'accepted', sessionId: 'B', updatedAt: '2026-09-27T21:30:00Z' };
    const [a] = markSelfReportedDone([listedB], () => ownDone, Date.parse('2026-09-27T22:00:00Z'));
    expect(a.selfReportedDone).toBe(true);
  });

  it('a legacy record (sessionId null) keeps today\'s rule unchanged, even for a row that DOES carry a sessionId', () => {
    const legacyDone = { status: 'done', outcome: 'accepted', sessionId: null, updatedAt: '2026-09-27T21:30:00Z' };
    const [a] = markSelfReportedDone([listedB], () => legacyDone, Date.parse('2026-09-27T22:00:00Z'));
    expect(a.selfReportedDone).toBe(true);
  });

  it('end to end: a PR bound to a still-live session B stays refused `live-process` even though a FOREIGN done record exists under the shared name — planReconcile dispatches nothing, the exact two-live-fixers incident this card closes', () => {
    const pr = pr1563({ number: 2513, labels: lbl('review:pending'), comments: [] });
    const foreignDone = { status: 'done', outcome: 'unreported-exit', sessionId: 'A', updatedAt: '2026-09-27T21:30:00Z' };
    const agents = markSelfReportedDone([listedB], () => foreignDone, Date.parse('2026-09-27T22:00:00Z'));
    const plan = planReconcile({ prs: [pr], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
  });
});

// ── #3383 continuation — a session whose OWN transcript went stale is finished too, self-report or not ───────
describe('markHungSessions + assessLiveness — hung-transcript detection (epic #3383 continuation, live 2026-09-24)', () => {
  const T0 = Date.parse('2026-09-24T18:40:37.475Z'); // review-2599's real startedAt/updatedAt, measured live.
  // The live shape: `claude agents` still says `working` (review-2582's real state) or `blocked` (the other
  // five), with NO completion record ever reaching `status: done` — the exact gap this axis exists to close.
  const workingRow = { name: 'review-2582', state: 'working', status: 'idle', startedAt: T0, pid: 4242, cwd: '/lanes/lane-9', sessionId: 's-2582' };
  const hungFor = (info) => (a, nowMs, thresholdMs) => (a?.name === 'review-2582' ? { hung: true, reason: info?.reason ?? 'stale-no-activity', ageMs: nowMs - T0 } : { hung: false, reason: 'fresh', ageMs: 0 });

  it('THE LIVE CASE: a `working` row whose transcript is confirmed stale → hung, so the PR is re-dispatched', () => {
    const now = T0 + 45 * 60_000; // 45 minutes of transcript silence
    const [a] = markHungSessions([workingRow], hungFor(), now, 30 * 60_000);
    expect(a.hung).toBe(true);
    expect(a.hungReason).toBeTruthy();
    expect(assessLiveness([{ agent: a, cwd: '/c', sha: '' }])).toBeNull();
  });

  it('overrides a LIVE pid — the whole point of this axis is to disprove liveness the listing still asserts', () => {
    const now = T0 + 45 * 60_000;
    const [a] = markHungSessions([workingRow], hungFor(), now, 30 * 60_000);
    // pidAlive is still true on the row; assessLiveness must not read it as live-process once hung is set.
    expect(assessLiveness([{ agent: { ...a, pidAlive: true }, cwd: '/c', sha: '' }])).toBeNull();
  });

  it('a resolver that answers not-hung, throws, or is absent leaves the row untouched', () => {
    const now = T0 + 45 * 60_000;
    expect(markHungSessions([workingRow], () => ({ hung: false }), now, 30 * 60_000)[0]).toBe(workingRow);
    expect(markHungSessions([workingRow], () => { throw new Error('unreadable transcript'); }, now, 30 * 60_000)[0]).toBe(workingRow);
    expect(markHungSessions([workingRow], () => null, now, 30 * 60_000)[0]).toBe(workingRow);
  });

  it('a row already `state: done` or `selfReportedDone` is never re-classified — no double work', () => {
    const done = { ...workingRow, state: 'done' };
    const selfReported = { ...workingRow, state: 'blocked', selfReportedDone: true };
    const alwaysHung = () => ({ hung: true, reason: 'stale-no-activity' });
    expect(markHungSessions([done], alwaysHung, T0 + 999_999, 30 * 60_000)[0]).toBe(done);
    expect(markHungSessions([selfReported], alwaysHung, T0 + 999_999, 30 * 60_000)[0]).toBe(selfReported);
  });

  it('end to end: a review:pending PR bound only to a hung `working` reviewer is owed a review again', () => {
    const pr = pr1563({ number: 2582, labels: lbl('review:pending'), comments: [] });
    const now = T0 + 45 * 60_000;
    const agents = markHungSessions([workingRow], hungFor(), now, 30 * 60_000);
    const plan = planReconcile({ prs: [pr], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2582 })]);
  });

  it('the same PR with the RAW listing (never marked hung) stays refused as live-process — the bug this fixes', () => {
    const pr = pr1563({ number: 2582, labels: lbl('review:pending'), comments: [] });
    const plan = planReconcile({ prs: [pr], agents: [{ ...workingRow, pidAlive: true }], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({ kind: 'live-process', prNumber: 2582 });
  });
});

// ── #x9fbg1x — markBgIsolationStalls + assessLiveness, live incident fix-2748/fix-2770, 2026-09-26 ────────────
// A MORE SPECIFIC reason layered on the existing `awaiting-permission` state (never a new REFUSAL_KINDS entry
// — the dispatch refusal itself is identical either way), mirroring the hung-transcript describe block above
// one for one: a separate pre-pass over agent rows, `assessLiveness` only ever READS the flag it attaches.
describe('markBgIsolationStalls + assessLiveness — bg-isolation-stall detection (live incident fix-2748/fix-2770, 2026-09-26)', () => {
  const blockedRow = {
    name: 'fix-2748', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt',
    startedAt: Date.parse('2026-09-26T18:00:00.000Z'), pid: 4242, cwd: '/lanes/lane-86', sessionId: '03bd61b3-…',
  };
  const stallInfoFor = (stall) => () => (stall ? { stall: true, reason: 'guard refusal seen', evidence: 'Call EnterWorktree first…' } : { stall: false, reason: 'no-signal' });

  it('confirms the stall and attaches it to the row; assessLiveness carries a bg-isolation-stall reason', () => {
    const [a] = markBgIsolationStalls([blockedRow], stallInfoFor(true));
    expect(a.bgIsolationStall).toBe(true);
    expect(a.bgIsolationStallEvidence).toMatch(/EnterWorktree/);
    const verdict = assessLiveness([{ agent: a, cwd: '/c', sha: '' }]);
    expect(verdict.kind).toBe('awaiting-permission'); // never a new top-level state
    expect(verdict.stallReason).toBe('bg-isolation-stall');
    expect(verdict.why).toMatch(/EnterWorktree/);
  });

  it('a plain awaiting-permission row (no confirmed stall) carries NO stallReason at all', () => {
    const [a] = markBgIsolationStalls([blockedRow], stallInfoFor(false));
    expect(a.bgIsolationStall).toBeUndefined();
    const verdict = assessLiveness([{ agent: a, cwd: '/c', sha: '' }]);
    expect(verdict.kind).toBe('awaiting-permission');
    expect(verdict).not.toHaveProperty('stallReason');
  });

  it('NEVER calls the resolver for a session not already awaiting-permission — cheap by construction', () => {
    let called = false;
    const workingRow = { ...blockedRow, state: 'working', status: 'busy', waitingFor: null };
    markBgIsolationStalls([workingRow], () => { called = true; return { stall: true }; });
    expect(called).toBe(false);
  });

  it('a resolver that answers not-stalled, throws, or is absent leaves the row untouched', () => {
    expect(markBgIsolationStalls([blockedRow], () => ({ stall: false }))[0]).toBe(blockedRow);
    expect(markBgIsolationStalls([blockedRow], () => { throw new Error('unreadable transcript'); })[0]).toBe(blockedRow);
    expect(markBgIsolationStalls([blockedRow], () => null)[0]).toBe(blockedRow);
  });

  it('end to end: a fix session confirmed stuck on the guard still refuses awaiting-permission (never re-dispatched over)', () => {
    const pr = pr1563({ number: 2748, labels: lbl('review:changes'), comments: [] });
    const agents = markBgIsolationStalls([{ ...blockedRow, name: 'fix-2748' }], stallInfoFor(true));
    const plan = planReconcile({ prs: [pr], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({ kind: 'awaiting-permission', prNumber: 2748, stallReason: 'bg-isolation-stall' });
  });
});

// ── LIVE INCIDENT, night of 2026-09-25/26 ET — the operator's Claude login expired; every daemon-dispatched
// session (`ci-heal-2711`/`ci-heal-2712`) ended immediately on the CLI's own auth failure, sat `blocked` for
// hours with a still-LIVE pid, and `assessLiveness` read that as `live-process` forever — see
// `reconcile-core.mjs#assessLiveness`'s own doc for the full incident. Mirrors the hung-transcript describe
// block above, one for one.
describe('markAuthExpiredSessions + assessLiveness — Claude auth-expired detection (live incident, night of 2026-09-25/26 ET)', () => {
  const T0 = Date.parse('2026-09-26T10:53:00.000Z'); // ci-heal-2712's real startedAt, measured live.
  const blockedRow = { name: 'ci-heal-2712', state: 'blocked', status: 'idle', startedAt: T0, pid: 4343, cwd: '/Users/x/workspace/.operations/dispatch/e265b052', sessionId: 's-2712' };
  const authExpiredFor = () => ({ authExpired: true, reason: 'claude-auth' });

  it('THE LIVE CASE: a `blocked` ci-heal row whose transcript shows the auth failure → authExpired, PR freed', () => {
    const [a] = markAuthExpiredSessions([blockedRow], authExpiredFor);
    expect(a.authExpired).toBe(true);
    expect(a.authExpiredReason).toBe('claude-auth');
    expect(assessLiveness([{ agent: a, cwd: '/c', sha: '' }])).toBeNull();
  });

  it('overrides a LIVE pid — the whole point of this axis is that these sessions were never killed', () => {
    const [a] = markAuthExpiredSessions([blockedRow], authExpiredFor);
    expect(assessLiveness([{ agent: { ...a, pidAlive: true }, cwd: '/c', sha: '' }])).toBeNull();
  });

  it('a resolver that answers not-auth-expired, throws, or is absent leaves the row untouched', () => {
    expect(markAuthExpiredSessions([blockedRow], () => ({ authExpired: false }))[0]).toBe(blockedRow);
    expect(markAuthExpiredSessions([blockedRow], () => { throw new Error('unreadable transcript'); })[0]).toBe(blockedRow);
    expect(markAuthExpiredSessions([blockedRow], () => null)[0]).toBe(blockedRow);
  });

  it('a row already `state: done`, `selfReportedDone`, or `hung` is never re-classified — no double work', () => {
    const done = { ...blockedRow, state: 'done' };
    const selfReported = { ...blockedRow, selfReportedDone: true };
    const hung = { ...blockedRow, hung: true };
    expect(markAuthExpiredSessions([done], authExpiredFor)[0]).toBe(done);
    expect(markAuthExpiredSessions([selfReported], authExpiredFor)[0]).toBe(selfReported);
    expect(markAuthExpiredSessions([hung], authExpiredFor)[0]).toBe(hung);
  });

  it('end to end: a red-CI PR bound only to an auth-expired ci-heal session is owed a fresh heal again', () => {
    const comments = Array.from({ length: 2 }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const pr = pr1563({ number: 2711, labels: [], statusCheckRollup: redRollup, comments });
    const agents = markAuthExpiredSessions([{ ...blockedRow, name: 'ci-heal-2711' }], authExpiredFor);
    const plan = planReconcile({ prs: [pr], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2711 })]);
  });

  it('the same PR with the RAW listing (never marked auth-expired) stays refused as live-process — THE LIVE BUG', () => {
    const comments = Array.from({ length: 2 }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const pr = pr1563({ number: 2712, labels: [], statusCheckRollup: redRollup, comments });
    const plan = planReconcile({ prs: [pr], agents: [{ ...blockedRow, name: 'ci-heal-2712', pidAlive: true }], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({ kind: 'live-process', prNumber: 2712 });
  });
});

describe('markIdleFinishedSessions + assessLiveness — idle-turn-ended backstop (#4075/xg7m2wq, live incident PR #2724, 2026-09-26)', () => {
  // ci-heal-2724's real shape: finished ~13:50 ET ("rebased PR #2724 onto main and pushed; no code change was
  // needed") but still listed `working` at 14:10 — the fix-dispatch daemon logged `reconcile-refused
  // live-process` for it the whole time, because `fix-agent-ci-brief.md` never reported completion.
  const T0 = Date.parse('2026-09-26T13:50:00.000Z');
  const workingRow = { name: 'ci-heal-2724', state: 'working', status: 'idle', startedAt: T0, pid: 5151, cwd: '/Users/x/workspace/.operations/dispatch/e265b052', sessionId: 's-2724' };
  const idleFinishedFor = () => ({ finished: true, reason: 'turn-ended-idle' });

  it('THE LIVE CASE: a `working` ci-heal row whose transcript shows the turn ended and idle > threshold → idleFinished, PR freed', () => {
    const [a] = markIdleFinishedSessions([workingRow], idleFinishedFor, T0 + 20 * 60_000, 10 * 60_000);
    expect(a.idleFinished).toBe(true);
    expect(a.idleFinishedReason).toBe('turn-ended-idle');
    expect(assessLiveness([{ agent: a, cwd: '/c', sha: '' }])).toBeNull();
  });

  it('overrides a LIVE pid — the whole point of this axis is to catch a session nobody ever stopped', () => {
    const [a] = markIdleFinishedSessions([workingRow], idleFinishedFor, T0 + 20 * 60_000, 10 * 60_000);
    expect(assessLiveness([{ agent: { ...a, pidAlive: true }, cwd: '/c', sha: '' }])).toBeNull();
  });

  it('a resolver that answers not-finished, throws, or is absent leaves the row untouched', () => {
    expect(markIdleFinishedSessions([workingRow], () => ({ finished: false }), T0, 10 * 60_000)[0]).toBe(workingRow);
    expect(markIdleFinishedSessions([workingRow], () => { throw new Error('unreadable transcript'); }, T0, 10 * 60_000)[0]).toBe(workingRow);
    expect(markIdleFinishedSessions([workingRow], () => null, T0, 10 * 60_000)[0]).toBe(workingRow);
  });

  it('a row already `state: done`, `selfReportedDone`, `hung`, or `authExpired` is never re-classified — the least specific axis runs last', () => {
    const done = { ...workingRow, state: 'done' };
    const selfReported = { ...workingRow, selfReportedDone: true };
    const hung = { ...workingRow, hung: true };
    const authExpired = { ...workingRow, authExpired: true };
    expect(markIdleFinishedSessions([done], idleFinishedFor, T0, 10 * 60_000)[0]).toBe(done);
    expect(markIdleFinishedSessions([selfReported], idleFinishedFor, T0, 10 * 60_000)[0]).toBe(selfReported);
    expect(markIdleFinishedSessions([hung], idleFinishedFor, T0, 10 * 60_000)[0]).toBe(hung);
    expect(markIdleFinishedSessions([authExpired], idleFinishedFor, T0, 10 * 60_000)[0]).toBe(authExpired);
  });

  it('end to end: a red-CI PR bound only to an idle-finished ci-heal session is owed a fresh heal again', () => {
    const comments = Array.from({ length: 2 }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const pr = pr1563({ number: 2724, labels: [], statusCheckRollup: redRollup, comments });
    const agents = markIdleFinishedSessions([workingRow], idleFinishedFor, T0 + 20 * 60_000, 10 * 60_000);
    const plan = planReconcile({ prs: [pr], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 2724 })]);
  });

  it('the same PR with the RAW listing (never marked idle-finished) stays refused as live-process — THE LIVE BUG', () => {
    const comments = Array.from({ length: 2 }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION }));
    const pr = pr1563({ number: 2724, labels: [], statusCheckRollup: redRollup, comments });
    const plan = planReconcile({ prs: [pr], agents: [{ ...workingRow, pidAlive: true }], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({ kind: 'live-process', prNumber: 2724 });
  });
});

// ── live-caught 2026-09-25, PR #2647/#2625 — a `stopped` session must free its PR, not freeze it ──────────────
describe('assessLiveness — `state: stopped` is finished too (PR #2647/#2625, live 2026-09-25)', () => {
  // The REAL shape measured off the running review daemon's own `claude agents --json --all`: a `stopped` (or
  // `done`) row carries NO `pid` field at all — only a currently-`working` row does. `enrichAgents` (reconcile-
  // pass.mjs) then OMITS `pidAlive` entirely (probePid(null) → null → key omitted), so this fixture's `stopped`
  // row is exactly what `assessLiveness` actually receives in production, not an approximation of it.
  const stoppedNoPid = {
    name: 'review-2647', state: 'stopped', kind: 'background', cwd: '/wev-review-daemon',
    sessionId: 's-2647-old', startedAt: 1_000,
  };

  it('a SINGLE stopped, pid-less bound session frees the PR (returns null, not liveness-unknown)', () => {
    expect(assessLiveness([{ agent: stoppedNoPid, cwd: '/c', sha: 'abc' }])).toBeNull();
  });

  it('the bug this fixes: without the `stopped` check, the identical row reads as liveness-unknown', () => {
    // Proves the fixture actually exercises the trap this fix closes — a row that is NEITHER `done` nor
    // otherwise marked finished, with `pidAlive` absent, hits rank 3 on its own.
    const notDone = String(stoppedNoPid.state).toLowerCase() !== 'done';
    const noPidAlive = stoppedNoPid.pidAlive === undefined;
    expect(notDone && noPidAlive).toBe(true);
  });

  it('several historical rows for the same PR, ALL stopped/done, still free it — bindAgents keeps every one', () => {
    const rows = [
      { ...stoppedNoPid, sessionId: 's-1' },
      { ...stoppedNoPid, sessionId: 's-2' },
      { ...stoppedNoPid, state: 'done', sessionId: 's-3' },
    ];
    const bound = rows.map((agent) => ({ agent, cwd: '/c', sha: 'abc' }));
    expect(assessLiveness(bound)).toBeNull();
  });

  it('a genuinely LIVE session among stale `stopped` siblings still wins — stopped never masks a real live one', () => {
    const live = { ...stoppedNoPid, state: 'working', pid: 555, pidAlive: true, sessionId: 's-live' };
    const bound = [
      { agent: { ...stoppedNoPid, sessionId: 's-old' }, cwd: '/c', sha: 'abc' },
      { agent: live, cwd: '/c', sha: 'abc' },
    ];
    expect(assessLiveness(bound)).toMatchObject({ kind: 'live-process' });
  });

  it('end to end: a review:pending PR bound only to stale `stopped` reviewer sessions is owed a review again', () => {
    const pr = pr1563({ number: 2647, labels: lbl('review:pending'), comments: [] });
    const plan = planReconcile({ prs: [pr], agents: [stoppedNoPid], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2647 })]);
  });

  it('the same PR with a `blocked` (never-stopped) sibling still correctly refuses — this fix does not widen ANY other state', () => {
    const pr = pr1563({ number: 2647, labels: lbl('review:pending'), comments: [] });
    const stillBlocked = { ...stoppedNoPid, state: 'blocked', sessionId: 's-blocked' };
    const plan = planReconcile({ prs: [pr], agents: [stillBlocked], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({ kind: 'liveness-unknown', prNumber: 2647 });
  });
});

// ── #4149 (epic #3383/#4075) — root-cause fix: session-reaper now `claude stop`s a `blocked-on-infra` session
// AS SOON AS its record says done, regardless of the cool-off (see session-reaper.mjs#makeCompletionResolver's
// own doc). That means `state` can already read `stopped` here WHILE the cool-off is still running — the exact
// case `markSelfReportedDone`'s new `awaitingInfraCooloff` flag exists to keep `assessLiveness` from misreading.
describe('markSelfReportedDone + assessLiveness — `awaitingInfraCooloff` outranks a `stopped` state (#4149)', () => {
  const T0 = Date.parse('2026-09-25T20:00:00Z');
  const listedStopped = { name: 'review-2669', state: 'stopped', startedAt: T0 };
  const record = { status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-09-25T20:05:00Z' };
  const recFor = (r) => (name) => (name === 'review-2669' ? r : null);

  it('a `stopped` session still inside its own infra cool-off is flagged `awaitingInfraCooloff`, NOT `selfReportedDone`', () => {
    const nowMs = Date.parse('2026-09-25T20:10:00Z'); // 5 min after the report — well inside the 15-min cool-off
    const [a] = markSelfReportedDone([listedStopped], recFor(record), nowMs);
    expect(a.awaitingInfraCooloff).toBe(true);
    expect(a.selfReportedDone).toBeUndefined();
  });

  it('assessLiveness does NOT free the PR for a `stopped` row still awaiting its infra cool-off — the record, not the process, governs', () => {
    const nowMs = Date.parse('2026-09-25T20:10:00Z');
    const [a] = markSelfReportedDone([listedStopped], recFor(record), nowMs);
    expect(assessLiveness([{ agent: a, cwd: '/c', sha: '' }])).not.toBeNull();
  });

  it('once the cool-off elapses, the SAME `stopped` row is selfReportedDone and assessLiveness frees the PR', () => {
    const nowMs = Date.parse('2026-09-25T20:25:00Z'); // past the 15-min cool-off
    const [a] = markSelfReportedDone([listedStopped], recFor(record), nowMs);
    expect(a.selfReportedDone).toBe(true);
    expect(a.awaitingInfraCooloff).toBeUndefined();
    expect(assessLiveness([{ agent: a, cwd: '/c', sha: '' }])).toBeNull();
  });

  it('end to end: a review:pending PR bound to a stopped-but-cooling-off reviewer is correctly refused, never redispatched early', () => {
    const pr = pr1563({ number: 2669, labels: lbl('review:pending'), comments: [] });
    const nowMs = Date.parse('2026-09-25T20:10:00Z');
    const agents = markSelfReportedDone([listedStopped], recFor(record), nowMs);
    const plan = planReconcile({ prs: [pr], agents, durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
  });

  it('a plain `stopped` row with no infra cool-off in play is completely unaffected by this flag (never set)', () => {
    const [a] = markSelfReportedDone([listedStopped], () => null, Date.parse('2026-09-25T20:10:00Z'));
    expect(a).toBe(listedStopped); // untouched — no record at all
    expect(assessLiveness([{ agent: listedStopped, cwd: '/c', sha: '' }])).toBeNull(); // plain `stopped` still frees the PR
  });
});

// ── #2588/review-loops (epic #3383/#4075) — THE REVIEW LOOPS: zero-findings reviews bypassing the round cap,
// and no dedup against a head that already carries an accept verdict. Live incident: PR #2588 got `review:changes`
// at 23:55Z and `review:accepted` at 00:00Z, five minutes apart, from THREE review sessions dispatched inside one
// 16-minute window, all against the same head.
describe('#2588/review-loops — the zero-findings review population now hits the round cap (epic #3383/#4075)', () => {
  /** Shaped exactly like case 3's `pr1576` (`review:pending`, no real findings) but with a comment thread of
   *  pure re-arm bookkeeping — zero findings by `countFindings`, but a real, non-zero durable attempt count. */
  const zeroFindingsPr = (over = {}) => ({
    number: 2588, state: 'OPEN',
    headRefName: 'lane/review-loop-2588', headRefOid: '2588'.repeat(10),
    labels: lbl('review:pending', 'checking'), mergeStateStatus: 'CLEAN',
    statusCheckRollup: greenRollup, comments: [], ...over,
  });

  it('THE BUG, reproduced: before this fix, a zero-findings review dispatched with `attempts: 0` HARDCODED no matter how many rounds already ran — this pins the fix, the dispatched row now carries the REAL count', () => {
    const twoRearms = [
      { body: REARM_COMMENT_MARKER, author: AUTOMATION },
      { body: REARM_COMMENT_MARKER, author: AUTOMATION },
    ];
    const plan = planReconcile({ prs: [zeroFindingsPr({ comments: twoRearms })], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(1);
    expect(plan.dispatch[0]).toMatchObject({ kind: 'review', prNumber: 2588, findings: 0, attempts: 2 });
  });

  it('once the REAL attempt count exceeds the round cap, a zero-findings review population is refused `cap-exhausted`, not dispatched again — THE FIX for the "re-dispatch forever" loop', () => {
    const overCapRearms = Array.from({ length: NEGOTIATION_ROUND_CAP + 1 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({ prs: [zeroFindingsPr({ comments: overCapRearms })], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals.map((r) => r.kind)).toEqual(['no-findings', 'cap-exhausted']);
    expect(plan.refusals[1]).toMatchObject({ prNumber: 2588, attempts: NEGOTIATION_ROUND_CAP + 1, cap: NEGOTIATION_ROUND_CAP });
  });

  it('a `needs-human` PR (review:human) with zero findings above the cap is bound by the identical cap, via the SAME `attempts` value', () => {
    const overCapRearms = Array.from({ length: NEGOTIATION_ROUND_CAP + 1 }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }));
    const pr = zeroFindingsPr({ labels: lbl('review:human'), comments: overCapRearms });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals.map((r) => r.kind)).toEqual(['no-findings', 'cap-exhausted']);
  });

  it('`already-reviewed-head` is on the frozen REFUSAL_KINDS list', () => {
    expect(REFUSAL_KINDS).toContain('already-reviewed-head');
  });
});

describe('#2588/review-loops — ONE REVIEW PER HEAD COMMIT (epic #3383/#4075)', () => {
  const HEAD = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';
  const OLDER_HEAD = 'ffffffffffffffffffffffffffffffffffffffff';

  it('a PR whose CURRENT head already carries a `reviewed-sha` accept marker is refused `already-reviewed-head`, never re-dispatched — the exact #2588 shape (a verdict already landed on this commit)', () => {
    const pr = {
      number: 2588, state: 'OPEN', headRefName: 'lane/review-loop-2588', headRefOid: HEAD,
      labels: lbl('review:pending', 'checking'), mergeStateStatus: 'CLEAN', statusCheckRollup: pendingRollup,
      // #4140 — parseReviewedSha only counts a TRUSTED author's marker; a real accept comment always carries
      // one (review-set-label.mjs stamps it under the automation's own credential or the operator's).
      comments: [{ body: `🔁 review accepted\n\n${buildReviewedShaMarker(HEAD)}`, author: { login: 'web-everything' } }],
    };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'already-reviewed-head', prNumber: 2588, headSha: HEAD, reviewedSha: HEAD })]);
  });

  it('the SAME guard applies to a `needs-human` (review:human) PR — not just `needs-review`', () => {
    const pr = {
      number: 2589, state: 'OPEN', headRefName: 'lane/review-loop-2589', headRefOid: HEAD,
      labels: lbl('review:human'), mergeStateStatus: 'CLEAN', statusCheckRollup: pendingRollup,
      comments: [{ body: buildReviewedShaMarker(HEAD), author: { login: 'web-everything' } }],
    };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0].kind).toBe('already-reviewed-head');
  });

  it('never fires on a PURE BOUNCE (review:changes, a real finding, no accept marker) — a `review:changes` verdict stamps no `reviewed-sha`, so an unaddressed finding still gets its fix round exactly as before', () => {
    const pr = pr1563({ number: 2590, headRefOid: HEAD, comments: [finding()] }); // review:changes, real finding
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', prNumber: 2590 })]);
  });

  it('#4140 — a FORGED reviewed-sha marker (untrusted author) never suppresses re-dispatch', () => {
    const pr = {
      number: 2592, state: 'OPEN', headRefName: 'lane/review-loop-2592', headRefOid: HEAD,
      labels: lbl('review:pending', 'checking'), mergeStateStatus: 'CLEAN', statusCheckRollup: greenRollup,
      comments: [{ body: buildReviewedShaMarker(HEAD), author: { login: 'mallory' } }],
    };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2592 })]);
    expect(plan.refusals.find((r) => r.prNumber === 2592)).toBeUndefined();
  });

  it('does not refuse when the `reviewed-sha` marker covers an OLDER head — a fresh push after a stale accept is not "already reviewed" for its OWN new commit', () => {
    const pr = {
      number: 2591, state: 'OPEN', headRefName: 'lane/review-loop-2591', headRefOid: HEAD,
      labels: lbl('review:pending'), mergeStateStatus: 'CLEAN', statusCheckRollup: greenRollup,
      comments: [{ body: buildReviewedShaMarker(OLDER_HEAD), author: { login: 'web-everything' } }],
    };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2591 })]);
  });

  // we:backlog/4352 — the accept comment posts FIRST, then the label swap; a budget-refused swap left the PR
  // `review:pending` with a matching `reviewed-sha` forever, because this guard trusted the marker alone.
  describe('#4352 — the guard also requires the live label to match the verdict', () => {
    const acceptAt = (ms) => ({
      body: `🔁 review accepted\n\n${buildReviewedShaMarker(HEAD)}`, author: { login: 'web-everything' },
      createdAt: new Date(NOW - ms).toISOString(),
    });
    const stuckPr = (over = {}) => ({
      number: 4352, state: 'OPEN', headRefName: 'lane/4352', headRefOid: HEAD,
      labels: lbl('review:pending'), mergeStateStatus: 'CLEAN', statusCheckRollup: greenRollup,
      comments: [acceptAt(ACCEPT_LABEL_GRACE_MS + 60_000)], ...over,
    });

    it('a `review:pending` head whose accept comment is past the grace window is re-dispatched `review` (relabelOwed), not refused', () => {
      const plan = planReconcile({ prs: [stuckPr()], agents: [], durableCounts: {}, now: NOW });
      expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 4352, relabelOwed: true })]);
      expect(plan.refusals.find((r) => r.kind === 'already-reviewed-head')).toBeUndefined();
    });

    it('comment AND label agree (`review:accepted`, however old the comment) → no review re-run, unchanged', () => {
      const plan = planReconcile({ prs: [stuckPr({ labels: lbl('review:accepted') })], agents: [], durableCounts: {}, now: NOW });
      expect(plan.dispatch.filter((d) => d.kind === 'review')).toHaveLength(0);
    });

    it('still refuses inside the grace window — the label swap may simply be in flight (the #2588 race)', () => {
      const plan = planReconcile({ prs: [stuckPr({ comments: [acceptAt(60_000)] })], agents: [], durableCounts: {}, now: NOW });
      expect(plan.dispatch).toHaveLength(0);
      expect(plan.refusals[0].kind).toBe('already-reviewed-head');
    });

    it('fails closed with no clock or no comment timestamp — the original refusal stands', () => {
      expect(planReconcile({ prs: [stuckPr()], agents: [], durableCounts: {}, now: 0 }).refusals[0].kind).toBe('already-reviewed-head');
      const noTs = stuckPr({ comments: [{ body: buildReviewedShaMarker(HEAD), author: { login: 'web-everything' } }] });
      expect(planReconcile({ prs: [noTs], agents: [], durableCounts: {}, now: NOW }).refusals[0].kind).toBe('already-reviewed-head');
    });

    it('a `review:human` head is NOT treated as a dropped label (escalated-after-accept is legitimate; only the ceremony clears it)', () => {
      const plan = planReconcile({ prs: [stuckPr({ labels: lbl('review:human') })], agents: [], durableCounts: {}, now: NOW });
      expect(plan.dispatch).toHaveLength(0);
      expect(plan.refusals[0].kind).toBe('already-reviewed-head');
    });

    it('the ci-red-parallel caller retains owed-ci-rerun even with a stuck accept label', () => {
      const pr = pr1563({
        number: 4353, headRefOid: HEAD, labels: lbl('review:pending', 'ci:failed'), statusCheckRollup: redRollup,
        requiredCheckCompletedAt: '2026-09-25T01:57:47Z', aheadByOnMain: 33, comments: [acceptAt(ACCEPT_LABEL_GRACE_MS + 60_000)],
      });
      const plan = planReconcile({
        prs: [pr], agents: [], now: NOW, mainRedWindows: [{ start: '2026-09-25T01:30:55Z', end: '2026-09-25T02:31:25Z' }],
      });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals[0]).toMatchObject({ kind: 'owed-ci-rerun', reviewRefusal: { kind: 'review-ci', relabelOwed: true } });
    });

    it('acceptLabelDropped — pure: label AND age must both disagree', () => {
      const comments = [acceptAt(ACCEPT_LABEL_GRACE_MS)];
      expect(acceptLabelDropped({ labels: ['review:pending'], comments, headSha: HEAD, now: NOW })).toBe(true);
      expect(acceptLabelDropped({ labels: ['review:pending', 'review:accepted'], comments, headSha: HEAD, now: NOW })).toBe(false);
      expect(acceptLabelDropped({ labels: ['review:accepted'], comments, headSha: HEAD, now: NOW })).toBe(false);
      expect(acceptLabelDropped({ labels: ['review:pending'], comments, headSha: OLDER_HEAD, now: NOW })).toBe(false);
    });
  });
});

describe('#xconv1 (web-everything/web-everything#2766/#2767 unblock) — CONVERT instead of re-review on a superseded verdict', () => {
  const HEAD = 'abbe08beacae462f98d6caf654d3ce7867c92801'; // #2766's real live head
  const ACCEPTED_AT = '2026-09-26T21:47:43Z';
  const acceptComment = () => ({
    author: { login: 'web-everything' }, createdAt: ACCEPTED_AT,
    body: `✅ review — accepted\n\nRecorded by agent (unattended review-loop) via the declared \`review-pr\` `
      + `operation (#3035).\n\n## Human review verdict — web-everything/web-everything#2766\n\n**Verdict:** ✅ pass — `
      + `no blocking findings\n\n${buildReviewedShaMarker(HEAD)}`,
  });
  const testGamingParkComment = () => ({
    author: { login: 'web-everything' }, createdAt: '2026-09-26T21:51:01Z',
    body: '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\n\ntest-gaming suspected — CI-green '
      + 'may be manufactured by tampering with tests: tests-removed: '
      + 'scripts/operations/__tests__/review-loop-cli.test.mjs (net 2 test case(s) removed)',
  });
  const healComment = () => ({
    author: { login: 'web-everything' }, createdAt: '2026-09-26T23:15:40Z',
    body: '**`review:accepted` removed — mutual exclusivity (#2766/#2767).**\n\nThis PR carried both '
      + '`review:accepted` and `review:human` at once: an automated verdict survived an escalation to '
      + '`review:human` that should have replaced it.',
  });

  it('THE LIVE #2766/#2767 SHAPE: needs-human + accepted-then-test-gaming-parked-then-healed on the SAME head dispatches `convert-advisory`, never `already-reviewed-head`', () => {
    const pr = {
      number: 2766, state: 'OPEN', headRefName: 'lane/2766', headRefOid: HEAD,
      labels: lbl('review:human', 'review:awaiting-advisory'), mergeStateStatus: 'CLEAN', statusCheckRollup: pendingRollup,
      comments: [acceptComment(), testGamingParkComment(), healComment()],
    };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals.find((r) => r.prNumber === 2766)).toBeUndefined();
    expect(plan.dispatch).toEqual([expect.objectContaining({
      kind: 'convert-advisory', prNumber: 2766, headSha: HEAD, reviewedSha: HEAD,
      escalation: expect.objectContaining({ kind: 'test-gaming' }),
    })]);
    expect(plan.dispatch[0].targetedCheckQuestion).toMatch(/test case/i);
    expect(plan.dispatch[0].acceptComment.body).toBe(acceptComment().body);
  });

  it('a needs-human PR accepted then healed with NO substantive park reason still converts, off the heal comment alone', () => {
    const pr = {
      number: 2777, state: 'OPEN', headRefName: 'lane/2777', headRefOid: HEAD,
      labels: lbl('review:human'), mergeStateStatus: 'CLEAN', statusCheckRollup: pendingRollup,
      comments: [acceptComment(), healComment()],
    };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({
      kind: 'convert-advisory', prNumber: 2777,
      escalation: expect.objectContaining({ kind: 'heal-mutual-exclusivity' }),
    })]);
  });

  it('#2588 protection UNCHANGED for `needs-review` (no escalation, ever) — still refused `already-reviewed-head`', () => {
    const pr = {
      number: 2778, state: 'OPEN', headRefName: 'lane/2778', headRefOid: HEAD,
      labels: lbl('review:pending'), mergeStateStatus: 'CLEAN', statusCheckRollup: pendingRollup,
      comments: [acceptComment(), testGamingParkComment(), healComment()],
    };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0].kind).toBe('already-reviewed-head');
  });

  it('a needs-human PR with an accept marker but NO escalation comment at all still refuses `already-reviewed-head` (the ORIGINAL #2588 guard, unweakened)', () => {
    const pr = {
      number: 2779, state: 'OPEN', headRefName: 'lane/2779', headRefOid: HEAD,
      labels: lbl('review:human'), mergeStateStatus: 'CLEAN', statusCheckRollup: pendingRollup,
      comments: [acceptComment()],
    };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0].kind).toBe('already-reviewed-head');
  });

  it('an escalation comment that PREDATES the accept (not a supersession) does not convert', () => {
    const pr = {
      number: 2780, state: 'OPEN', headRefName: 'lane/2780', headRefOid: HEAD,
      labels: lbl('review:human'), mergeStateStatus: 'CLEAN', statusCheckRollup: pendingRollup,
      comments: [{ ...testGamingParkComment(), createdAt: '2026-09-26T00:00:00Z' }, acceptComment()],
    };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0].kind).toBe('already-reviewed-head');
  });

  it('`convert-advisory` is on the frozen DISPATCH_KINDS list', () => {
    expect(DISPATCH_KINDS).toContain('convert-advisory');
  });
});

// ── draft-first PRs (operator-approved 2026-09-27) ──────────────────────────────────────────────────────────
// `--park` now opens a PR as a GitHub draft by default (`scripts/pr-land.mjs`); this pass is what closes the
// loop back: never dispatch a review for a draft, whatever label it carries, and promote (`gh pr ready`, via
// `kind:'promote-draft'`) the moment its required checks are all green.
describe('draft-first PRs — reconcile-core.mjs (operator-approved 2026-09-27)', () => {
  it('`promote-draft` is on the frozen DISPATCH_KINDS list, `draft` is on the frozen REFUSAL_KINDS list', () => {
    expect(DISPATCH_KINDS).toContain('promote-draft');
    expect(REFUSAL_KINDS).toContain('draft');
  });

  it('a draft PR with ALL required checks green is dispatched `promote-draft`, never `review`', () => {
    const pr = pr1563({ isDraft: true, labels: lbl('review:pending'), statusCheckRollup: greenRollup, comments: [] });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'promote-draft', prNumber: 1563 })]);
    expect(plan.dispatch.some((d) => d.kind === 'review')).toBe(false);
  });

  it('a draft PR whose checks are still pending is refused `draft` — no review, no promotion, nothing owed yet', () => {
    const pr = pr1563({ isDraft: true, labels: lbl('review:pending'), statusCheckRollup: pendingRollup, comments: [] });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'draft', prNumber: 1563 })]);
  });

  it('a draft PR with a RED required check is STILL dispatched `ci-heal` — CI healing is never withheld from a draft', () => {
    const pr = pr1563({ isDraft: true, labels: [], statusCheckRollup: redRollup, comments: [] });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 1563 })]);
    expect(plan.dispatch.some((d) => d.kind === 'review' || d.kind === 'promote-draft')).toBe(false);
  });

  it('a NON-draft PR with the exact same shape dispatches `review` as normal — the gate is `isDraft` alone', () => {
    const pr = pr1563({ isDraft: false, labels: lbl('review:pending'), statusCheckRollup: greenRollup, comments: [] });
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 1563 })]);
  });

  it('an `isDraft`-absent PR (a fixture predating this field) behaves exactly as `isDraft: false` — no accidental universal gate', () => {
    const pr = pr1563({ labels: lbl('review:pending'), statusCheckRollup: greenRollup, comments: [] });
    delete pr.isDraft;
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 1563 })]);
  });

  it('every kind this pass ever emits for a draft PR is in the frozen lists (the same exhaustiveness check the file already holds itself to)', () => {
    for (const rollup of [greenRollup, pendingRollup, redRollup]) {
      const pr = pr1563({ isDraft: true, labels: lbl('review:pending'), statusCheckRollup: rollup, comments: [] });
      const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW });
      for (const r of plan.refusals) expect(REFUSAL_KINDS).toContain(r.kind);
      for (const d of plan.dispatch) expect(DISPATCH_KINDS).toContain(d.kind);
    }
  });
});

describe('fix waiting episode', () => {
  it('ages a PR without an episode marker from its creation, and refuses a capped file snapshot', () => {
    const source = pr1563({ createdAt: '2026-09-29T12:00:00Z',
      files: Array.from({ length: 100 }, (_, i) => ({ path: `file-${i}` })) });
    const result = planReconcile({ prs: [source], agents: [], durableCounts: {}, now: NOW });
    expect(result.dispatch[0]).toMatchObject({ kind: 'fix', waitingSince: source.createdAt, files: null });
  });

  it('projects the review episode into an actual fix dispatch row', () => {
    const comments = [{ body: '🔁 review — changes requested', author: { login: 'web-everything' }, createdAt: '2026-09-30T12:00:00Z' }];
    const result = planReconcile({ prs: [pr1563({ comments })], agents: [], durableCounts: {}, now: NOW });
    expect(result.dispatch[0]).toMatchObject({ kind: 'fix', waitingSince: '2026-09-30T12:00:00.000Z' });
  });

  const note = (hour, body = '🔁 review — changes requested\nPlease fix', author = 'web-everything') => ({
    body, author: { login: author }, createdAt: `2026-09-30T${hour}:00:00Z`,
  });
  it('consumes a turn even when a fixer settles without a new verdict', () => {
    expect(fixWaitingSince([note('12'), note('14', FIX_BEGIN_MARKER), note('15', FIX_END_MARKER)])).toBe('2026-09-30T15:00:00.000Z');
  });

  it('retains waiting age across bookkeeping and moves a new finding round to the back', () => {
    const comments = [note('12'), note('13', REARM_COMMENT_MARKER), note('14', 'untrusted', 'stranger'), note('16', 'queue-cap: waiting')];
    expect(fixWaitingSince(comments)).toBe('2026-09-30T12:00:00.000Z');
    expect(fixWaitingSince([...comments, note('15')])).toBe('2026-09-30T15:00:00.000Z');
  });
});

it('xxh4zw8 complete hydrated cancellation heals while caps, claims and stand-downs retain refusal', () => {
  const requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
  const pr = { number: 3336, isDraft: true, headRefName: 'lane/3336-replay', headRefOid: '4ecb5deb362c81aa28de162db4616bb4c2009347',
    labels: [], comments: [], statusCheckRollup: requiredChecks.map((name, i) => ({ id: 100 + i, name,
      status: 'COMPLETED', conclusion: name === 'smoke' ? 'CANCELLED' : 'SUCCESS' })) };
  const plan = override => planReconcile({ prs: [{ ...pr, ...override }], requiredChecks, agents: [], now: NOW });
  expect(plan({}).dispatch.map(d => d.kind)).toEqual(['ci-heal']);
  for (const [override, kind] of [
    [{ comments: Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }), author: AUTOMATION })) }, 'cap-exhausted'],
    [{ comments: [{ body: STAND_DOWN_MARKER, author: AUTOMATION }] }, 'stood-down'],
    [{ fixClaim: { who: 'another-fixer' } }, 'fix-claimed'],
  ]) {
    expect(plan(override).dispatch).toEqual([]);
    expect(plan(override).refusals.map(r => r.kind)).toContain(kind);
  }
  const latest = { id: 200, name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' };
  for (const statusCheckRollup of [[latest, ...pr.statusCheckRollup], [...pr.statusCheckRollup, latest]]) {
    expect(plan({ statusCheckRollup }).dispatch.map(d => d.kind)).toEqual(['promote-draft']);
  }
});

describe('operator send-back renews a bounded durable fix budget', () => {
  const round = () => ({ body: ADVISORY_NOTE_MARKER, author: AUTOMATION });
  const verdict = (over = {}) => ({
    id: 'operator-send-back', createdAt: '2026-10-01T11:00:53Z',
    author: { login: 'chalbert' },
    body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nTwo required changes.',
    ...over,
  });
  const plan = (comments, extra = {}) => planReconcile({
    prs: [pr1563({ comments, labels: lbl('review:changes', 'review:human') })], now: NOW, ...extra,
  });
  const burned = () => Array.from({ length: 5 }, round);

  it('dispatches after the operator sends a capped PR back, including after restart', () => {
    const comments = [...burned(), verdict()];
    for (let restart = 0; restart < 2; restart++) {
      const result = plan(comments);
      expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix',
        operatorFixBudget: { verdictId: 'operator-send-back', cap: 7, attempts: 5 } })]);
    }
    expect(plan([...comments, round()]).dispatch[0]).toMatchObject({ kind: 'fix', attempts: 6 });
    const exhausted = plan([...comments, round(), round()]);
    expect(exhausted.dispatch).toHaveLength(0);
    expect(exhausted.refusals[0]).toMatchObject({ kind: 'cap-exhausted', attempts: 7, cap: 7 });
    expect(exhausted.notes[0]).toMatchObject({ kind: 'round-cap-exhausted', cap: 7 });
  });

  it('cannot extend the grant by switching from advisory rounds to rearm rounds', () => {
    const rearm = { body: REARM_COMMENT_MARKER, author: AUTOMATION };
    expect(plan([...burned(), verdict(), rearm, rearm]).refusals[0])
      .toMatchObject({ kind: 'cap-exhausted', attempts: 7, cap: 7 });
  });

  it.each([
    { author: AUTOMATION, viewerDidAuthor: true },
    { author: { login: 'outsider' } },
    { author: undefined },
    { id: undefined },
    { createdAt: undefined },
    { body: 'quoted: 🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.' },
    { body: '🔁 review — changes requested\n\nRecorded by agent (unattended review-loop).' },
  ])('does not grant a budget to forged or agent-authored records: %j', (over) => {
    const result = plan([...burned(), verdict(over)]);
    expect(result.dispatch).toHaveLength(0);
    expect(result.refusals[0]).toMatchObject({ kind: 'cap-exhausted', cap: 5 });
  });

  it('a later operator decision gets its own allowance without accumulating unused grants', () => {
    const comments = [...burned(), verdict(), verdict({ id: 'second' }), round(), round()];
    expect(plan(comments).refusals[0]).toMatchObject({ kind: 'cap-exhausted', cap: 7 });
    expect(plan([...comments, verdict({ id: 'third' })]).dispatch[0])
      .toMatchObject({ kind: 'fix', operatorFixBudget: { verdictId: 'third', cap: 9, attempts: 7 } });
  });
});

describe('#101 operator send-back re-arms a red-CI PR once as a fix', () => {
  const head = 'b'.repeat(40);
  const sendBack = (over = {}) => ({
    id: 'op-send-back', createdAt: '2026-10-07T00:24:00Z', author: { login: 'chalbert' },
    body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nMUST FIX: rename the export.',
    ...over,
  });
  const plan = (comments) => planReconcile({
    prs: [pr1563({ number: 4141, headRefOid: head, statusCheckRollup: redRollup, labels: lbl('review:changes', 'review:human'), comments })], now: NOW,
  });
  it('dispatches a fix carrying the body, recorded as an operator re-arm', () => {
    const r = plan([sendBack()]);
    expect(r.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'operator-send-back',
      operatorSendBack: expect.objectContaining({ login: 'chalbert', body: 'MUST FIX: rename the export.' }) })]);
  });
  it('is one-shot: a recorded repair round afterwards returns the PR to ci-heal', () => {
    const r = plan([sendBack(), { body: REARM_COMMENT_MARKER, author: AUTOMATION }]);
    expect(r.dispatch.map((d) => d.mode)).not.toContain('operator-send-back');
  });
  it('a loop-held ci-red head (no review:changes label) is still re-armed as a fix by the operator send-back', () => {
    const r = planReconcile({ prs: [pr1563({ number: 4141, headRefOid: head, statusCheckRollup: redRollup,
      labels: lbl('ci:failed'), comments: [sendBack()] })], now: NOW });
    expect(r.dispatch.map((d) => [d.kind, d.mode])).toEqual([['fix', 'operator-send-back']]);
  });
  it('an automation-authored send-back does not re-arm', () => {
    const r = plan([sendBack({ author: AUTOMATION })]);
    expect(r.dispatch.map((d) => d.mode)).not.toContain('operator-send-back');
  });
  it('a bodiless send-back does not re-arm', () => {
    const r = plan([sendBack({ body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.' })]);
    expect(r.dispatch.map((d) => d.mode)).not.toContain('operator-send-back');
  });
});

describe('xng7q1p mechanical timeout precedence', () => {
  const head = 'a'.repeat(40);
  const pr = (extra = {}) => pr1563({ number: 3415, headRefOid: head, labels: [], comments: [], statusCheckRollup: redRollup,
    timeoutRetryBudget: { confirmed: 0, pending: false },
    timeoutRetry: { eligible: true, repo: 'web-everything/web-everything', pr: 3415, head, signature: 'timeout', jobs: [{ run: 10, job: 20, attempt: 1 }] }, ...extra });
  it('does not authorize retries without an observed budget', () => {
    const result = planReconcile({ prs: [pr({ timeoutRetryBudget: undefined })], now: NOW });
    expect(result.dispatch.map((row) => row.kind)).toEqual(['ci-heal']);
  });
  it('infra-cancelled red routes to a mechanical rerun while under its cap, then to ci-heal (never ci-heal first)', () => {
    const infra = { eligible: true, infraCancelled: true, cap: 6, repo: 'web-everything/web-everything', pr: 3415, head, signature: 'infra', jobs: [{ run: 10, job: 20, attempt: 1 }] };
    const under = planReconcile({ prs: [pr({ timeoutRetry: infra, timeoutRetryBudget: { confirmed: 3, pending: false } })], now: NOW });
    expect(under.dispatch.map((row) => row.kind)).toEqual(['ci-timeout-rerun']);
    const spent = planReconcile({ prs: [pr({ timeoutRetry: infra, timeoutRetryBudget: { confirmed: 6, pending: false } })], now: NOW });
    expect(spent.dispatch.map((row) => row.kind)).toEqual(['ci-heal']);
  });
  it('infra-cancelled re-runs the API rejected or refused still spend the cap, so the PR reaches ci-heal (never refused forever)', () => {
    const infra = { eligible: true, infraCancelled: true, cap: 6, repo: 'web-everything/web-everything', pr: 3415, head, signature: 'infra', jobs: [{ run: 10, job: 20, attempt: 1 }] };
    const rejectedUnder = planReconcile({ prs: [pr({ timeoutRetry: infra, timeoutRetryBudget: { confirmed: 1, rejected: 4, pending: false } })], now: NOW });
    expect(rejectedUnder.dispatch.map((row) => row.kind)).toEqual(['ci-timeout-rerun']);
    const rejectedSpent = planReconcile({ prs: [pr({ timeoutRetry: infra, timeoutRetryBudget: { confirmed: 0, rejected: 6, pending: false } })], now: NOW });
    expect(rejectedSpent.dispatch.map((row) => row.kind)).toEqual(['ci-heal']);
    const mixedSpent = planReconcile({ prs: [pr({ timeoutRetry: infra, timeoutRetryBudget: { confirmed: 2, rejected: 4, pending: false } })], now: NOW });
    expect(mixedSpent.dispatch.map((row) => row.kind)).toEqual(['ci-heal']);
  });
  it('exhausted per-head retries fall through to normal healing', () => {
    const result = planReconcile({ prs: [pr({ timeoutRetryBudget: { confirmed: 2, pending: false } })], now: NOW });
    expect(result.dispatch.map((row) => row.kind)).toEqual(['ci-heal']);
  });
  it('an unresolved request becomes a visible human escalation, never another rerun or heal', () => {
    const result = planReconcile({ prs: [pr({ timeoutRetryBudget: { confirmed: 0, pending: true } })], now: NOW });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].kind).toBe('ci-heal-escalated');
    expect(result.notes).toContainEqual(expect.objectContaining({ kind: 'timeout-retry-needs-human', text: expect.stringContaining('needs your decision') }));
  });
  it('a re-run requested moments ago is held in flight, not escalated to the operator (live #4235)', () => {
    const since = new Date(NOW - 90 * 1000).toISOString();
    const result = planReconcile({ prs: [pr({ timeoutRetryBudget: { confirmed: 1, pending: true, pendingSince: since } })], now: NOW });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].kind).toBe('ci-timeout-rerun-in-flight');
    expect(result.notes.some((n) => n.kind === 'timeout-retry-needs-human')).toBe(false);
  });
  it('a re-run unresolved past the window still escalates; unreadable state escalates at once', () => {
    const old = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const stale = planReconcile({ prs: [pr({ timeoutRetryBudget: { confirmed: 1, pending: true, pendingSince: old } })], now: NOW });
    expect(stale.refusals[0].kind).toBe('ci-heal-escalated');
    const fresh = new Date(NOW - 1000).toISOString();
    const unreadable = planReconcile({ prs: [pr({ timeoutRetryBudget: { pending: true, pendingSince: fresh, reason: 'timeout-state-unreadable:x' } })], now: NOW });
    expect(unreadable.refusals[0].kind).toBe('ci-heal-escalated');
  });
  it('keeps live fix ownership ahead of retries', () => {
    const result = planReconcile({ prs: [pr({ fixClaim: { who: 'fixer' } })], now: NOW });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].kind).toBe('fix-claimed');
  });
  it('keeps a live agent ahead of retries', () => {
    const result = planReconcile({ prs: [pr()], now: NOW,
      agents: [{ sessionSlug: 'ci-heal-3415', name: 'ci-heal-3415', status: 'running', pid: 123, pidAlive: true, laneHeadOid: head }] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].kind).toBe('live-process');
  });
  it('keeps same-head escalation ahead of retries', () => {
    const comments = [{ author: AUTOMATION, body: buildCiHealEscalationComment({ headSha: head, outcome: 'needs-human', reason: 'operator decision required' }) }];
    const result = planReconcile({ prs: [pr({ comments })], now: NOW });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].kind).toBe('ci-heal-escalated');
  });
  it('keeps new-tree main-red recovery ahead of same-head retries', () => {
    const result = planReconcile({ prs: [pr({ requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadByOnMain: 5,
      requiredCheckName: 'test', prContainsMainGreenSha: false, mergeBaseCheckRuns: [], mergeBaseRunConclusion: 'success' })],
    now: NOW, mainLatestCheckRuns: [{ name: 'test', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T04:00:10Z' }] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].kind).toBe('owed-ci-rerun');
  });
  it('ineligible evidence retains normal healing with a visible reason', () => {
    const result = planReconcile({ prs: [pr({ timeoutRetry: { eligible: false, reason: 'changed-dependency:leaf.mjs' } })], now: NOW });
    expect(result.dispatch[0].kind).toBe('ci-heal');
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'timeout-retry-ineligible',
      why: 'PR #3415: changed-dependency:leaf.mjs' }));
    expect(result.notes).not.toContainEqual(expect.objectContaining({ kind: 'timeout-retry-ineligible' }));
  });
});

// Synthetic reported PR #3432 shape; no claim of historical replay.
it('x6n7c2p required checks before review — repaired ready head waits', () => {
  const snapshots = [
    ['a', 'in_progress', null], ['a', 'completed', 'failure'],
    ['b', 'in_progress', null], ['b', 'completed', 'success'],
  ];
  const reviews = snapshots.map(([head, status, conclusion]) => {
    const plan = planReconcile({
      prs: [{ number: 3432, state: 'OPEN', isDraft: false, headRefName: 'lane/x6n7c2p-fix',
        headRefOid: head.repeat(40), labels: lbl('review:pending'), mergeStateStatus: 'CLEAN', comments: [],
        statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' },
          { name: 'daemon-soak', status, conclusion }] }],
      requiredChecks: ['test', 'daemon-soak'], agents: [], durableCounts: {}, now: NOW,
    });
    return plan.dispatch.filter(row => row.kind === 'review').length;
  });
  expect(reviews).toEqual([0, 0, 0, 1]);
});

it.each([[], [finding()]])('x6n7c2p required checks before review — fail closed with findings %j', comments => {
  for (const over of [{ requiredChecks: null }, { requiredChecks: [] },
    { prs: [pr1563({ labels: lbl('review:pending'), comments, statusCheckRollup: [] })] },
    { prs: [pr1563({ labels: lbl('review:pending'), comments, statusCheckRollup: pendingRollup })] },
    { prs: [pr1563({ labels: lbl('review:pending'), comments, headRefOid: null })] }]) {
    const plan = planReconcile({ prs: [pr1563({ labels: lbl('review:pending'), comments })], agents: [], now: NOW, ...over });
    expect(plan.dispatch.filter(row => row.kind === 'review')).toEqual([]);
    expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'review-ci' }));
  }
});
it('required review-gate conflict refuses without repeatedly healing review completion', () => {
  const plan = planReconcile({ requiredChecks: ['review-gate'], agents: [], now: NOW,
    prs: [pr1563({ labels: lbl('review:pending'), statusCheckRollup: [{ name: 'review-gate', status: 'completed', conclusion: 'failure' }] })] });
  expect(plan.dispatch).toEqual([]);
  expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'review-ci', ci: expect.objectContaining({ reason: 'required-review-gate-conflict' }) })]);
});
describe('required review-gate conflict is scoped to the review it gates', () => {
  const failed = name => ({ name, status: 'completed', conclusion: 'failure' });
  it('required review-gate conflict preserves repair of other failed checks', () => {
    const plan = planReconcile({ requiredChecks: ['test', 'review-gate'], agents: [], now: NOW,
      prs: [pr1563({ labels: lbl('review:pending'), comments: [], statusCheckRollup: [failed('test'), failed('review-gate')] })] });
    expect(plan.dispatch.filter(row => row.kind === 'review')).toEqual([]);
    expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal', prNumber: 1563 }));
  });
  it('required review-gate conflict does not suppress the fixer for a bounced PR', () => {
    const plan = planReconcile({ requiredChecks: ['review-gate'], agents: [], now: NOW,
      prs: [pr1563({ labels: lbl('review:changes'), statusCheckRollup: [failed('review-gate')] })] });
    expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'fix', prNumber: 1563 }));
    expect(plan.refusals.filter(row => row.kind === 'review-ci')).toEqual([]);
  });
});
describe('required review-gate conflict still refuses a superseded-verdict conversion', () => {
  const HEAD = 'abbe08beacae462f98d6caf654d3ce7867c92801';
  const comments = [
    { author: { login: 'web-everything' }, createdAt: '2026-09-26T21:47:43Z',
      body: `✅ review — accepted\n\nRecorded by agent (unattended review-loop) via the declared \`review-pr\` operation (#3035).\n\n**Verdict:** ✅ pass\n\n${buildReviewedShaMarker(HEAD)}` },
    { author: { login: 'web-everything' }, createdAt: '2026-09-26T23:15:40Z',
      body: '**`review:accepted` removed — mutual exclusivity (#2766/#2767).**\n\nThis PR carried both `review:accepted` and `review:human` at once.' },
  ];
  it.each(['failure', 'in_progress'])('needs-human PR with a %s required review-gate gets review-ci, not convert-advisory', state => {
    const pr = { number: 2777, state: 'OPEN', headRefName: 'lane/2777', headRefOid: HEAD, labels: lbl('review:human'), mergeStateStatus: 'CLEAN', comments,
      statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' },
        state === 'failure' ? { name: 'review-gate', status: 'completed', conclusion: 'failure' } : { name: 'review-gate', status: 'in_progress', conclusion: null }] };
    const plan = planReconcile({ requiredChecks: ['test', 'review-gate'], prs: [pr], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'review-ci', ci: expect.objectContaining({ reason: 'required-review-gate-conflict' }) })]);
  });
});


describe('xul2kwr withdrawn green drafts', () => {
  it.each([
    [['review-status:draft-withdrawn'], undefined],
    [[{ name: 'review-status:draft-withdrawn' }], null],
    [['review-status:draft-withdrawn'], { who: 'fix-3432' }],
  ])('holds labels %j and claim %j', (labels, fixClaim) => {
    const plan = planReconcile({ prs: [pr1563({ isDraft: true, labels, fixClaim, comments: [] })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: fixClaim ? 'fix-claimed' : 'draft',
      why: expect.stringMatching(fixClaim ? /fix claim/ : /withdrawn/),
    })]);
  });
  it('preserves scope-change promotion and withdrawn red CI healing', () => {
    for (const [label, checks, kind] of [
      ['review-status:draft-scope-change', greenRollup, 'promote-draft'],
      ['review-status:draft-withdrawn', redRollup, 'ci-heal'],
    ]) {
      const plan = planReconcile({ prs: [pr1563({ isDraft: true, labels: [label], comments: [], statusCheckRollup: checks })], agents: [], now: NOW });
      expect(plan.dispatch).toEqual([expect.objectContaining({ kind })]);
    }
  });
});

describe('xe8y12n orthogonal missing-review diagnostic', () => {
  const commits = [{ messageHeadline: 'repair', authors: [{ name: 'Claude' }] }];
  it.each([
    {}, { isDraft: true }, { labels: lbl('ci:failed'), statusCheckRollup: [{ name: 'gate', conclusion: 'failure', status: 'completed' }] },
    { mergeStateStatus: 'DIRTY', labels: lbl('merge-status:conflicting') },
    { labels: lbl('review-status:stood-down') },
    { fixClaim: { session: 'fixer', headSha: 'a'.repeat(40) } },
  ])('keeps the exact dispatch/refusal decisions for %j', extra => {
    const pr = { number: 3239, state: 'OPEN', labels: [], headRefName: 'lane/3239', headRefOid: 'a'.repeat(40), comments: [], statusCheckRollup: greenRollup, ...extra };
    const without = planReconcile({ prs: [pr] });
    const withEvidence = planReconcile({ prs: [{ ...pr, commits }] });
    expect(withEvidence.notes).toContainEqual(expect.objectContaining({ kind: 'review-label-missing', prNumber: 3239 }));
    expect(withEvidence.dispatch).toEqual(without.dispatch);
    expect(withEvidence.refusals).toEqual(without.refusals);
  });
  it('does not suppress live-agent decisions', () => {
    const pr = { number: 3239, state: 'OPEN', labels: [], headRefName: 'lane/3239', headRefOid: 'a'.repeat(40), comments: [], statusCheckRollup: greenRollup };
    const agents = [{ name: 'review-3239', state: 'running', pid: 123, pidAlive: true, cwd: '/lane', headSha: pr.headRefOid }];
    const before = planReconcile({ prs: [pr], agents });
    const after = planReconcile({ prs: [{ ...pr, commits }], agents });
    expect(after.notes).toContainEqual(expect.objectContaining({ kind: 'review-label-missing' }));
    expect(after.dispatch).toEqual(before.dispatch);
    expect(after.refusals).toEqual(before.refusals);
  });
});

// LIVE INCIDENT 2026-10-03/04, PR #3830: an open, green lane PR with NO review:* label sat in limbo forever.
describe('restore-review-label — open green PR with no review label (PR #3830)', () => {
  it('is on the frozen DISPATCH_KINDS list', () => { expect(DISPATCH_KINDS).toContain('restore-review-label'); });
  const open = (over = {}) => pr1563({ isDraft: false, labels: [], statusCheckRollup: greenRollup, comments: [], headRefName: 'lane/xw4yqe9-prevention-card', ...over });
  it('RED before the fix: such a PR was refused `nothing-owed`; now it is owed `review:pending`', () => {
    const plan = planReconcile({ prs: [open()], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'restore-review-label', prNumber: 1563, label: 'review:pending' })]);
  });
  it('waits out the grace so a label-on-green producer can label ready-to-merge first', () => {
    const fresh = open({ statusCheckRollup: greenRollup.map((c) => ({ ...c, completedAt: new Date(NOW - 60_000).toISOString() })) });
    expect(planReconcile({ prs: [fresh], agents: [], durableCounts: {}, now: NOW }).dispatch.some((d) => d.kind === 'restore-review-label')).toBe(false);
    const settled = open({ statusCheckRollup: greenRollup.map((c) => ({ ...c, completedAt: new Date(NOW - 30 * 60_000).toISOString() })) });
    expect(planReconcile({ prs: [settled], agents: [], durableCounts: {}, now: NOW }).dispatch.some((d) => d.kind === 'restore-review-label')).toBe(true);
  });
  it('xpd70wx: a lane PR STACKED on another lane branch (checks never run) is owed review:pending (plateau-app#217)', () => {
    const stackedRollup = [{ name: 'admit', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: new Date(NOW - 30 * 60_000).toISOString() }];
    const stacked = open({ baseRefName: 'lane/xwtnr2y-sessions-page', statusCheckRollup: stackedRollup });
    expect(planReconcile({ prs: [stacked], agents: [], durableCounts: {}, now: NOW }).dispatch)
      .toEqual([expect.objectContaining({ kind: 'restore-review-label', label: 'review:pending' })]);
    // still never for a labelled or red stacked PR
    for (const p of [{ ...stacked, labels: lbl('review:pending') }, { ...stacked, statusCheckRollup: redRollup }]) {
      expect(planReconcile({ prs: [p], agents: [], durableCounts: {}, now: NOW }).dispatch.some((d) => d.kind === 'restore-review-label')).toBe(false);
    }
  });
  it('never for a labelled, draft, red/pending, ready-to-merge or non-lane PR', () => {
    for (const p of [
      open({ labels: lbl('review:accepted') }), open({ labels: lbl('review:pending') }), open({ labels: lbl('ready-to-merge') }),
      open({ isDraft: true }), open({ statusCheckRollup: pendingRollup }), open({ statusCheckRollup: redRollup }),
      open({ headRefName: 'feature/human' }),
    ]) {
      expect(planReconcile({ prs: [p], agents: [], durableCounts: {}, now: NOW }).dispatch.some((d) => d.kind === 'restore-review-label')).toBe(false);
    }
  });
});

import { loadFlakeLegacyBody } from './load-flake-fixture.mjs';
import { countUnresolvedStandDowns } from '../reconcile-core.mjs';
it('legacy #3881 waits on host load, not a human', () => {
  const comment = { body: loadFlakeLegacyBody, createdAt: '2026-10-04T18:51:50Z', author: AUTOMATION };
  expect(countUnresolvedStandDowns([comment])).toBe(0);
  const plan = planReconcile({ prs: [pr1563({ comments: [finding(), comment] })], agents: [], durableCounts: {}, now: NOW });
  expect(plan.refusals[0].kind).toBe('load-flake-hold');
});

import { buildLoadFlakeHoldComment as loadHoldBody, buildLoadFlakeResolvedComment as loadResultBody } from '../stand-down.mjs';
it('load-hold reconcile routing respects cutoff, head changes, and terminal exhaustion', () => {
  const c = (body, createdAt = '2026-10-04T18:51:50Z') => ({ body, createdAt, author: AUTOMATION });
  const hold = c(loadHoldBody({ head: 'abc1234', alt: 'lane/fix-alt', altSha: '9202eee8a' }));
  for (const [comments, headRefOid, expected] of [
    [[c(loadFlakeLegacyBody, '2026-10-05T00:00:00Z')], 'abc1234', 'stood-down'],
    [[hold], 'abc1234', 'load-flake-hold'],
    [[hold], 'def5678', null],
    [[hold, c(loadResultBody({ altSha: '9202eee8a', result: 'pushed' }), '2026-10-04T20:00:00Z')], 'abc1234', null],
    [[hold, c(loadResultBody({ altSha: '9202eee8a', result: 'exhausted' }), '2026-10-04T20:00:00Z')], 'abc1234', 'stood-down'],
  ]) {
    const plan = planReconcile({ prs: [pr1563({ comments: [finding(), ...comments], headRefOid })], agents: [], durableCounts: {}, now: NOW });
    const kinds = plan.refusals.map((r) => r.kind);
    if (expected) expect(kinds).toContain(expected);
    else { expect(kinds).not.toContain('stood-down'); expect(kinds).not.toContain('load-flake-hold'); }
  }
});

import { buildOperatorAnswer as buildLegacyHoldAnswer } from '../stand-down-answer-core.mjs';
it('a legacy load-flake hold the thread superseded no longer refuses the PR (PR #3945 review)', () => {
  const legacy = { id: 'IC_legacy_hold', body: loadFlakeLegacyBody, createdAt: '2026-10-04T18:51:50Z', author: AUTOMATION };
  const answer = { id: 'IC_answer', createdAt: '2026-10-04T20:00:00Z', author: AUTOMATION,
    body: buildLegacyHoldAnswer({ standDownId: 'IC_legacy_hold', reason: 'handled by hand', actor: 'chalbert', channel: 'test' }) };
  const kinds = (comments) => planReconcile({ prs: [pr1563({ comments: [finding(), ...comments], headRefOid: 'advanced-past-alt' })], agents: [], durableCounts: {}, now: NOW }).refusals.map((r) => r.kind);
  expect(kinds([legacy])).toContain('load-flake-hold');
  expect(kinds([legacy, answer])).not.toContain('load-flake-hold');
  expect(kinds([legacy, answer])).not.toContain('stood-down');
});

it('a legacy load-flake stand-down on a repo the reverify pass never sweeps stays terminal (PR #3945 review)', () => {
  const legacy = (slug) => ({ id: 'IC_legacy_hold', body: loadFlakeLegacyBody, createdAt: '2026-10-04T18:51:50Z', author: AUTOMATION,
    url: `https://github.com/${slug}/pull/12#issuecomment-1` });
  const kinds = (slug) => planReconcile({ prs: [pr1563({ comments: [finding(), legacy(slug)] })], agents: [], durableCounts: {}, now: NOW }).refusals.map((r) => r.kind);
  expect(kinds('frontier-ui/frontierui')).toContain('stood-down');
  expect(kinds('frontier-ui/frontierui')).not.toContain('load-flake-hold');
  expect(kinds('web-everything/web-everything')).toContain('load-flake-hold');
});

// ── xuz8m83 — a rejected card batch is extracted, not fixed in place ──────────────────────────────────────────
describe('card-batch extraction routing (#4703, xuz8m83)', () => {
  const plan = (over, options = {}) => planReconcile({ prs: [pr1563(over)], agents: [], durableCounts: {}, now: NOW, cardBatchExtract: true, ...options });

  it('plans `card-batch-extract` (not `fix`) for a lane/card-batch-* PR labelled review:changes', () => {
    const { dispatch } = plan({ headRefName: 'lane/card-batch-prevention-4' });
    expect(dispatch.map((d) => d.kind)).toEqual(['card-batch-extract']);
    expect(dispatch[0].prNumber).toBe(1563);
    expect(dispatch[0].headRefName).toBe('lane/card-batch-prevention-4');
    expect(DISPATCH_KINDS).toContain('card-batch-extract');
  });

  it('plans a rebuilt remainder batch (…-r1) the same way', () => {
    expect(plan({ headRefName: 'lane/card-batch-prevention-4-r1' }).dispatch.map((d) => d.kind)).toEqual(['card-batch-extract']);
  });

  // Nothing consumes the kind until the wiring slice (reconcile-fix-dispatch skips every kind but `fix`), so by default
  // a rejected card batch keeps its in-place `fix` dispatch rather than stalling on an entry nobody acts on.
  it('keeps planning `fix` for a card batch until the extract kind is wired', () => {
    expect(CARD_BATCH_EXTRACT_WIRED).toBe(false);
    const { dispatch } = planReconcile({ prs: [pr1563({ headRefName: 'lane/card-batch-prevention-4' })], agents: [], durableCounts: {}, now: NOW });
    expect(dispatch.map((d) => d.kind)).toEqual(['fix']);
  });

  it('any other PR, including look-alike names, still plans `fix` exactly as before', () => {
    for (const headRefName of ['lane/2612-converge-pr-drive', 'lane/card-extract-5-abc1234', 'card-batch-prevention-1', 'lane/xx-card-batch-1']) {
      expect(plan({ headRefName }).dispatch.map((d) => d.kind)).toEqual(['fix']);
    }
  });
});

it('a bounced PR whose head is the load-flake pushed fix is owed a re-arm, not another fixer (#4361)', () => {
  const c = (body, createdAt) => ({ body, createdAt, author: AUTOMATION });
  const alt = 'a5938d8938a20137e76d2145e49d40ee8fff4970';
  const hold = c(loadHoldBody({ head: 'd7a3b14ac', alt: 'lane/build-outcomes-fix-4361-alt', altSha: alt }), '2026-10-08T15:01:01Z');
  const pushed = c(loadResultBody({ altSha: alt, result: 'pushed' }), '2026-10-08T15:02:43Z');
  const plan = (comments) => planReconcile({ prs: [pr1563({ comments: [finding(), hold, ...comments], headRefOid: alt, labels: lbl('review:changes', 'review:human') })], agents: [], durableCounts: {}, now: NOW });
  const owed = plan([pushed]);
  expect(owed.dispatch.some((d) => d.kind === 'fix')).toBe(false);
  expect(owed.refusals).toEqual([expect.objectContaining({ kind: 'load-flake-rearm-owed', sha: alt })]);
  // once re-armed (or bounced again on that head) the ordinary paths own it again
  expect(plan([pushed, c('🔁 review — changes requested\n\nagain', '2026-10-08T16:00:00Z')]).refusals.map((r) => r.kind)).not.toContain('load-flake-rearm-owed');
});
