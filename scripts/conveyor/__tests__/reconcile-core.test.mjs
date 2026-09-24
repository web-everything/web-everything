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
import {
  planReconcile, countFindings, bindAgents, assessLiveness, isAwaitingPermission, startedAtMs,
  REFUSAL_KINDS, DISPATCH_KINDS, selectStatusCandidates, markSelfReportedDone, CI_HEAL_ROUND_CAP,
  CONFLICT_FIX_ROUND_CAP, ADVISORY_FIX_ROUND_CAP,
} from '../reconcile-core.mjs';
import {
  STAND_DOWN_MARKER, WATCHER_STAND_DOWN_ACTOR, SUPERSEDE_STAND_DOWN_MARKER, buildStandDownComment,
} from '../stand-down.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { CI_HEAL_COMMENT_MARKER, buildCiHealComment } from '../ci-heal-mark.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-round-count.mjs';
import { ADVISORY_FIX_COMMENT_MARKER, buildAdvisoryFixComment } from '../advisory-fix-mark.mjs';
import { laneRefItemNum } from '../lease-reaper.mjs';
import { NEGOTIATION_ROUND_CAP } from '../../lib/jury-core.mjs';
import { defaultReadPrs, defaultReadAgents, PR_LIST_JSON_FIELDS, PR_LIST_LIMIT } from '../reconcile-pass.mjs';
import { reviewSessionSlug } from '../review-session-slug.mjs';
import { sessionSlugFor } from '../../operations/dispatch-lane.mjs';

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

const lbl = (...names) => names.map((name) => ({ name }));
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
  const stoodDown = pr1563({ comments: [finding(), { body: `${STAND_DOWN_MARKER}\n\nthe finding needs a judgment.` }] });

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

  // #xu2krte Fork 2 (review-human statute amendment) — PR chalbert/web-everything#2549's shape: the parked-PR
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

  it('review finding 3 — a FORGED watcher-actor stand-down (not self-authored) cannot escape the terminal gate', () => {
    const forged = pr1563({ comments: [finding(), { body: watcherMarker.body }, supersede] });
    const plan = planReconcile({ prs: [forged], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals.map((r) => r.kind)).toEqual(['stood-down']);
  });

  it('the supersede comment is conveyor bookkeeping, never counted as a reviewer finding', () => {
    const onlyBookkeeping = pr1563({ comments: [watcherMarker, supersede] });
    const plan = planReconcile({ prs: [onlyBookkeeping], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(countFindings([watcherMarker, supersede])).toBe(0);
  });

  it('a fix agent\'s OWN judgment stand-down (not the watch) stays exactly as terminal as before', () => {
    const humanNeeded = pr1563({
      comments: [finding(), { body: buildStandDownComment({ actor: 'conveyor fix agent', reason: 'needs-judgment' }) }],
    });
    const plan = planReconcile({ prs: [humanNeeded], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].kind).toBe('stood-down');
    expect(plan.dispatch).toHaveLength(0);
  });

  it('a human\'s own /finish stand-down (default actor) stays exactly as terminal as before', () => {
    const humanFinish = pr1563({ comments: [finding(), { body: buildStandDownComment({ reason: 'gate-red' }) }] });
    const plan = planReconcile({ prs: [humanFinish], agents: [], durableCounts: {}, now: NOW });
    expect(plan.refusals[0].kind).toBe('stood-down');
    expect(plan.dispatch).toHaveLength(0);
  });
});

// ── CASE 3 — REFUSAL 2: NO FINDINGS, NO FIXER ─────────────────────────────────────────────────────────────────
describe('case 3 — refusal 2: a PR with nothing to fix never gets a fixer (#3296)', () => {
  /** #1576 as measured at 17:21Z: `review:pending`, ZERO comments, head ref `lane/review-slice-scopes`. */
  const pr1576 = (over = {}) => ({
    number: 1576, state: 'OPEN',
    headRefName: 'lane/review-slice-scopes', headRefOid: '1576'.repeat(10),
    labels: lbl('review:pending', 'checking'), mergeStateStatus: 'CLEAN',
    statusCheckRollup: pendingRollup, comments: [], ...over,
  });

  it('#1576 at 17:21Z — no `fix` dispatch, and a `no-findings` refusal', () => {
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
    const onlyBookkeeping = pr1563({ comments: [{ body: REARM_COMMENT_MARKER }, { body: REARM_COMMENT_MARKER }] });
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
    const burned = pr1563({ comments: [finding(), ...Array.from({ length: 5 }, () => ({ body: REARM_COMMENT_MARKER }))] });
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
    const advisoryRound = (n) => ({ body: `${ADVISORY_NOTE_MARKER} round ${n} — no commits changed since the last one` });
    const burned = pr1563({
      labels: lbl('review:changes', 'review:human'),
      comments: [finding(), ...Array.from({ length: 5 }, (_, i) => advisoryRound(i + 1))],
    });
    const plan = planReconcile({ prs: [burned], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({ kind: 'cap-exhausted', attempts: 5, cap: NEGOTIATION_ROUND_CAP });
  });

  it('#3383 — advisory rounds one below the cap still dispatch — the fix does not over-tighten the cap', () => {
    const advisoryRound = (n) => ({ body: `${ADVISORY_NOTE_MARKER} round ${n}` });
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

  it('xpprcdz — the SAME round cap that binds a bounced+review:human PR also binds a PURE review:human one — advisory comments alone trip it', () => {
    const advisoryRound = (n) => ({ body: `${ADVISORY_NOTE_MARKER} round ${n} — no commits changed since the last one` });
    const burned = pr1563({
      labels: lbl('review:human'),
      comments: [finding(), ...Array.from({ length: NEGOTIATION_ROUND_CAP }, (_, i) => advisoryRound(i + 1))],
    });
    const plan = planReconcile({ prs: [burned], agents: [], durableCounts: {}, now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals[0]).toMatchObject({ kind: 'cap-exhausted', attempts: NEGOTIATION_ROUND_CAP, cap: NEGOTIATION_ROUND_CAP });
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
    statusCheckRollup: pendingRollup, comments: [{ body: REARM_COMMENT_MARKER }], ...over,
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

  it(`the durable heal-mark count is read from the PR's OWN comments — ${CI_HEAL_ROUND_CAP - 1} prior heals still dispatches`, () => {
    const comments = Array.from({ length: CI_HEAL_ROUND_CAP - 1 }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }) }));
    expect(comments[0].body.startsWith(CI_HEAL_COMMENT_MARKER)).toBe(true);
    const plan = planReconcile({ prs: [prRed({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', attempts: CI_HEAL_ROUND_CAP - 1 })]);
  });

  it(`AT the cap (${CI_HEAL_ROUND_CAP} durable heal-mark comments) the PR is refused \`cap-exhausted\`, never re-dispatched`, () => {
    const comments = Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: buildCiHealComment({ reason: 'red-ci' }) }));
    const plan = planReconcile({ prs: [prRed({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', prNumber: 2602, attempts: CI_HEAL_ROUND_CAP, cap: CI_HEAL_ROUND_CAP })]);
  });

  it('a caller-supplied `ciHealCap` overrides the default — one prior heal already exhausts a cap of 1', () => {
    const comments = [{ body: buildCiHealComment({ reason: 'red-ci' }) }];
    const plan = planReconcile({ prs: [prRed({ comments })], agents: [], now: NOW, ciHealCap: 1 });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 1 })]);
  });

  it('a REARM/advisory comment count never leaks into the ci-heal cap — the two caps are independent floors', () => {
    // `roundCap` defaults to `NEGOTIATION_ROUND_CAP` (5); flood the thread with REARM markers (the fix/review
    // cap's own source) and confirm ci-heal is still owed at attempts:0 — it reads its OWN marker, not this one.
    const comments = Array.from({ length: NEGOTIATION_ROUND_CAP + 2 }, () => ({ body: REARM_COMMENT_MARKER }));
    const plan = planReconcile({ prs: [prRed({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', attempts: 0 })]);
  });

  it('DISPATCH_KINDS includes `ci-heal` — every dispatch this pass ever returns has a named kind', () => {
    expect(DISPATCH_KINDS).toContain('ci-heal');
    const plan = planReconcile({ prs: [prRed()], agents: [], now: NOW });
    for (const d of plan.dispatch) expect(DISPATCH_KINDS).toContain(d.kind);
  });
});

describe('case 5f — conflict-fix dispatch, capped by its OWN durable marker, not the shared roundCap (#xkmu3gv)', () => {
  // `chalbert/web-everything#2549`, shape measured live 2026-09-24: `bounced` (review:changes present, wins
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
    const shared = Array.from({ length: 5 }, () => ({ body: REARM_COMMENT_MARKER }));
    const plan = planReconcile({ prs: [prConflict({ comments: [finding(), ...shared] })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({
      kind: 'fix', prNumber: 2549, isConflict: true, advisoryPending: true, attempts: 0, cap: CONFLICT_FIX_ROUND_CAP,
    })]);
  });

  it(`the durable conflict-fix count is read from the PR's OWN comments — ${CONFLICT_FIX_ROUND_CAP - 1} prior rounds still dispatches`, () => {
    const comments = [finding(), ...Array.from({ length: CONFLICT_FIX_ROUND_CAP - 1 }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER }))];
    const plan = planReconcile({ prs: [prConflict({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', attempts: CONFLICT_FIX_ROUND_CAP - 1 })]);
  });

  it(`AT the cap (${CONFLICT_FIX_ROUND_CAP} durable conflict-fix comments) the PR is refused \`cap-exhausted\`, capKind \`conflict-fix\``, () => {
    const comments = [finding(), ...Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER }))];
    const plan = planReconcile({ prs: [prConflict({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'cap-exhausted', prNumber: 2549, attempts: CONFLICT_FIX_ROUND_CAP, cap: CONFLICT_FIX_ROUND_CAP, capKind: 'conflict-fix',
    })]);
  });

  it('a caller-supplied `conflictFixCap` overrides the default', () => {
    const plan = planReconcile({ prs: [prConflict({ comments: [finding(), { body: CONFLICT_FIX_COMMENT_MARKER }] })], agents: [], now: NOW, conflictFixCap: 1 });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 1, capKind: 'conflict-fix' })]);
  });

  it('a bounce WITHOUT the conflict label is unaffected — the ordinary shared cap still governs it', () => {
    const shared = Array.from({ length: 5 }, () => ({ body: REARM_COMMENT_MARKER }));
    const plan = planReconcile({ prs: [pr1563({ comments: [finding(), ...shared] })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 5 })]);
    expect(plan.refusals[0].capKind).toBeUndefined();
  });

  it('`countConflictFixComments` narrows on the leading line, like every sibling counter', async () => {
    const { countConflictFixComments } = await import('../conflict-fix-round-count.mjs');
    expect(countConflictFixComments([{ body: CONFLICT_FIX_COMMENT_MARKER + '\n\nmore' }])).toBe(1);
    expect(countConflictFixComments([{ body: `> ${CONFLICT_FIX_COMMENT_MARKER}` }])).toBe(0);
    expect(countConflictFixComments(null)).toBe(0);
  });
});

describe('case 5g — advisory-fix dispatch on a `needs-human` PR carrying `advisory:changes` (#xkmu3gv)', () => {
  // A `needs-human` PR (review:human, no review:changes) that already carries an admitted `advisory:changes`
  // finding from `we:scripts/operations/review-pr.mjs`'s `advise` step — the population no daemon ever acted on
  // before this item: the reconcile pass only ever dispatched `review` for `needs-human`, never a `fix`.
  const advisoryNote = { body: `${ADVISORY_NOTE_MARKER}\n\nSome admitted finding text.` };
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
    const comments = [advisoryNote, { body: buildAdvisoryFixComment({}) }];
    const plan = planReconcile({ prs: [prNeedsHuman({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 2601 })]);
  });

  it(`AT the cap (${ADVISORY_FIX_ROUND_CAP} durable advisory-fix comments, still behind the note count) the PR is refused \`cap-exhausted\`, capKind \`advisory-fix\``, () => {
    // ADVISORY_FIX_ROUND_CAP advisory-fix rounds, each followed by ANOTHER advisory note that still found
    // something wrong (so the fix count never catches up to the note count) — genuinely exhausted.
    const comments = [];
    for (let i = 0; i < ADVISORY_FIX_ROUND_CAP; i += 1) {
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nround ${i}` });
      comments.push({ body: buildAdvisoryFixComment({}) });
    }
    comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\none more, still broken` }); // the note the last fix didn't clear
    const plan = planReconcile({ prs: [prNeedsHuman({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'cap-exhausted', prNumber: 2601, attempts: ADVISORY_FIX_ROUND_CAP, cap: ADVISORY_FIX_ROUND_CAP, capKind: 'advisory-fix',
    })]);
  });

  it('a caller-supplied `advisoryFixCap` overrides the default', () => {
    const plan = planReconcile({ prs: [prNeedsHuman()], agents: [], now: NOW, advisoryFixCap: 0 });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 0, capKind: 'advisory-fix' })]);
  });

  it('a REARM/ordinary comment count never leaks into the advisory-fix cap — independent floors', () => {
    const shared = Array.from({ length: NEGOTIATION_ROUND_CAP + 2 }, () => ({ body: REARM_COMMENT_MARKER }));
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
    expect(countAdvisoryFixComments([{ body: ADVISORY_FIX_COMMENT_MARKER + '\n\nmore' }])).toBe(1);
    expect(countAdvisoryFixComments([{ body: `> ${ADVISORY_FIX_COMMENT_MARKER}` }])).toBe(0);
    expect(countAdvisoryFixComments(undefined)).toBe(0);
  });
});

describe('case 5h — real chalbert/web-everything#2549 shape (measured 2026-09-24, the live case #xkmu3gv closes)', () => {
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

describe('case 5i — STACKED-BASE CONFLICT dispatch, a `conflicted` PR whose base is not `main` (#3383)', () => {
  // `chalbert/web-everything#2578`, shape measured live 2026-09-24: `review:accepted` (no `review:changes`, no
  // `review:human`), `mergeStateStatus: DIRTY`/`mergeable: CONFLICTING` (`classifyPr` reads `conflicted`), base
  // `lane/3681-ratify-daemon-lifecycle` — stacked on PR #2549, NOT `main`. BEFORE this branch existed,
  // `runReconcilePass({repo:'chalbert/web-everything'})` refused this `owed-elsewhere` ("the branch needs a
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
    const comments = Array.from({ length: CONFLICT_FIX_ROUND_CAP - 1 }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER }));
    const plan = planReconcile({ prs: [prStacked({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'stacked-rebase', attempts: CONFLICT_FIX_ROUND_CAP - 1 })]);
  });

  it(`AT the cap (${CONFLICT_FIX_ROUND_CAP} durable conflict-fix comments) the PR is refused \`cap-exhausted\`, capKind \`conflict-fix\` — never \`owed-elsewhere\``, () => {
    const comments = Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER }));
    const plan = planReconcile({ prs: [prStacked({ comments })], agents: [], now: NOW });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({
      kind: 'cap-exhausted', prNumber: 2578, attempts: CONFLICT_FIX_ROUND_CAP, cap: CONFLICT_FIX_ROUND_CAP, capKind: 'conflict-fix',
    })]);
  });

  it('a caller-supplied `conflictFixCap` overrides the default here too', () => {
    const plan = planReconcile({ prs: [prStacked({ comments: [{ body: CONFLICT_FIX_COMMENT_MARKER }] })], agents: [], now: NOW, conflictFixCap: 1 });
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', cap: 1, capKind: 'conflict-fix' })]);
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

describe('selectStatusCandidates — which PRs deserve a review-status refresh (PR #1920 staleness, x5v8yy9)', () => {
  it('includes an owed-elsewhere refusal (e.g. ci-red) — it is a real conveyor PR, not an unrelated one', () => {
    // `needs-human` no longer produces `owed-elsewhere` (xpprcdz dispatches `review` for it instead) — `ci-red`
    // is the current real example of a phase this pass refuses as someone else's job.
    const refusals = [{ prNumber: 1920, kind: 'owed-elsewhere', phase: 'ci-red' }];
    expect(selectStatusCandidates([], refusals)).toEqual(refusals);
  });

  it('excludes ONLY nothing-owed', () => {
    const refusals = [
      { prNumber: 1, kind: 'nothing-owed', phase: 'queued' },
      { prNumber: 2, kind: 'owed-elsewhere', phase: 'ci-red' },
      { prNumber: 3, kind: 'cap-exhausted' },
    ];
    expect(selectStatusCandidates([], refusals).map((r) => r.prNumber)).toEqual([2, 3]);
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

  it('combines reviewsOwed + fixesOwed + non-nothing-owed refusals, all three sources at once', () => {
    const reviewsOwed = [{ prNumber: 1, kind: 'review' }];
    const fixesOwed = [{ prNumber: 2, kind: 'fix' }];
    const refusals = [{ prNumber: 3, kind: 'owed-elsewhere' }, { prNumber: 4, kind: 'nothing-owed' }];
    expect(selectStatusCandidates(reviewsOwed, refusals, fixesOwed).map((c) => c.prNumber)).toEqual([1, 2, 3]);
  });

  it('a 2-arg call (fixesOwed omitted) is byte-identical to before this fix — every existing caller unaffected', () => {
    const reviewsOwed = [{ prNumber: 1 }];
    const refusals = [{ prNumber: 2, kind: 'owed-elsewhere' }];
    expect(selectStatusCandidates(reviewsOwed, refusals)).toEqual([{ prNumber: 1 }, { prNumber: 2, kind: 'owed-elsewhere' }]);
  });

  it('tolerates non-array fixesOwed', () => {
    expect(selectStatusCandidates([], [], null)).toEqual([]);
    expect(selectStatusCandidates([], [], undefined)).toEqual([]);
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
