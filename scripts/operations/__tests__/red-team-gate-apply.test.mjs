/**
 * Card x1b8hlo — the red-team gate's impure half over a fake io: broken → send-back, degraded → card,
 * unconfirmed → advisory, a stale head → ignored, the round cap, dedup — and review-job runs it after the red team.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRedTeamGateIo, proveNumberingAncestors, applyRedTeamGate, buildGateComment, buildRedTeamCardInput, buildSendBackArgv, buildSendBackBody, gateExitCode, renderGateSummary, RED_TEAM_GATE_ACTOR, RED_TEAM_GATE_CHANNEL } from '../red-team-gate-apply.mjs';
import { runReviewJob } from '../review-job.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, GATE_OUTCOMES, gateRoundGrants, liveResultGateState, parseRedTeamComment, parseRedTeamGateMarker, readRedTeamDisposition, redTeamGateMarker, redTeamQueueReason, redTeamResultId, redTeamRulingNeeded } from '../../lib/red-team-gate.mjs';
import { redTeamEnqueueHold } from '../../lib/drain-queue-safety.mjs';
import { planRedTeamStatusLabels, syncRedTeamStatusLabels } from '../../lib/red-team-status-labels.mjs';
import { buildReviewedShaMarker, buildClearedHumanMarker } from '../../lib/review-escalation.mjs';
import { buildVerdictCarriedMarker } from '../../lib/review-verdict-carried-marker.mjs';
import { buildRoundExtensionComment, countGrantedRoundExtensions } from '../../conveyor/round-extension-mark.mjs';
import { createGhProvider, GH_ARGV } from '../../lib/review-label-provider.mjs';
import { redTeamRulingHeld, runReviewLabelCli } from '../../review-set-label.mjs';
import { readReviewRound, readReviewRoundAsOf } from '../review-pr-io.mjs';
import { diffFeed, parseFeedLine } from '../needs-you-feed.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'ea117e881164c3b6366b0bb78a3660c9a00503b1';
const OTHER = '2'.repeat(40);
const F = (o) => ({ summary: 's', category: 'edge-case', impactIfUnfixed: 'broken', file: 'scripts/x.mjs', line: 3, confirmedByRecheck: true, recheckReason: 'real', ...o });
const comment = (findings, rev = HEAD) => ({
  author: { login: 'web-everything' }, createdAt: '2026-10-10T02:04:41Z',
  body: renderRedTeamComment({ pr: 4722, rev, provider: 'codex', model: 'm', findings, recheckStatus: 'ok', foldedVerdict: 'changes' }),
});

// `comments` is the LIVE thread: every gate record the io posts is appended to it, so a second run sees the first one's
// records exactly as it would on GitHub.
function fakeIo({ comments, labels = ['review:accepted'], head = HEAD, liveHead = head, round = 1, setting = CONFIRMED_BREAKS_DEFAULTS, ...over } = {}) {
  const calls = [];
  const feedItems = [];
  const io = {
    publishNeedsYou: item => { feedItems.push(item); },
    readPr: () => ({ headRefOid: head, labels: labels.map((name) => ({ name })), comments }),
    readHead: () => liveHead,
    readSetting: () => ({ value: setting }),
    readRound: () => round,
    dequeueSentBack: () => ({ dequeued: false }),
    sendBack: (a) => { calls.push(['sendBack', a]); return { ok: true }; },
    appendSendBackEvent: async (a) => { calls.push(['ledger', a]); },
    fileCard: (input) => { calls.push(['card', input]); return { ok: true, session: 'red-team-card-x' }; },
    postComment: (a) => { calls.push(['comment', a]); comments.push({ author: { login: 'web-everything' }, body: a.body }); },
    log: () => {},
    ...over,
  };
  return { io, calls, feedItems };
}
const kinds = (calls) => calls.map((c) => c[0]);
// Every record the gate writes names the result it decided (PR #5482).
const namedGate = (outcome) => redTeamGateMarker(4722, HEAD, outcome).replace(/ -->$/, ' result=');

const numberingCommit = (head = HEAD, parent = OTHER, files = [{ filename: 'backlog/6936-card.md' }]) => ({
  sha: head, parents: [{ sha: parent }], commit: { message: 'drain: JIT-number x3vn7kd->#6936 at land' }, files,
});

describe('numbering ancestor proof and production reader', () => {
  it('walks only the contiguous first-parent numbering chain, nearest first', () => {
    const base = '3'.repeat(40);
    expect(proveNumberingAncestors(HEAD, [numberingCommit(), numberingCommit(OTHER, base),
      { sha: base, commit: { message: 'fix: real change' } }])).toEqual([OTHER, base]);
  });
  it.each([
    ['non-backlog file', [{ filename: 'scripts/x.mjs' }]],
    ['code renamed into backlog', [{ filename: 'backlog/6936-card.md', previous_filename: 'scripts/x.mjs' }]],
    ['non-card file', [{ filename: 'backlog/data.json' }]],
    ['nested path', [{ filename: 'backlog/sub/card.md' }]],
  ])('does not prove a numbering commit touching a %s', (_name, files) => {
    expect(proveNumberingAncestors(HEAD, [numberingCommit(HEAD, OTHER, files)])).toEqual([]);
  });
  it.each([
    ['empty files', { files: [] }], ['missing files', { files: undefined }],
    ['full API page', { files: Array.from({ length: 100 }, () => ({ filename: 'backlog/card.md' })) }],
    ['merge', { parents: [{ sha: OTHER }, { sha: '3'.repeat(40) }] }],
    ['unknown parent', { parents: [] }], ['wrong sha', { sha: OTHER }],
  ])('fails closed on %s', (_name, patch) => {
    expect(proveNumberingAncestors(HEAD, [{ ...numberingCommit(), ...patch }])).toEqual([]);
  });
  it('caps the reader at five hops; older results need a fresh live-head review', async () => {
    const heads = [HEAD, ...Array.from({ length: 6 }, (_, i) => String(i + 2).repeat(40))];
    const readCommit = vi.fn(({ head }) => numberingCommit(head, heads[heads.indexOf(head) + 1]));
    const log = vi.fn();
    const reader = createRedTeamGateIo({ env: {}, readCommit, log }).numberingAncestors;
    expect(reader({ repo: REPO, head: HEAD })).toEqual(heads.slice(1, 6));
    expect(readCommit).toHaveBeenCalledTimes(5);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fresh live-head review'));
    expect(proveNumberingAncestors(HEAD, heads.slice(0, 6).map((h, i) => numberingCommit(h, heads[i + 1])))).toEqual([]);
    const { io, calls } = fakeIo({ comments: [comment([F()], heads[6])], numberingAncestors: reader });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('no-red-team-on-head');
    expect(calls).toEqual([]);
  });
  it('refuses a full file page and exposes the fresh-review fallback', () => {
    const log = vi.fn();
    const reader = createRedTeamGateIo({ env: {}, log, readCommit: () => numberingCommit(HEAD, OTHER,
      Array.from({ length: 100 }, () => ({ filename: 'backlog/card.md' }))) });
    expect(reader.numberingAncestors({ repo: REPO, head: HEAD })).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fresh live-head review'));
  });
  it('returns empty on any commit read failure, even after a proven hop', () => {
    const readCommit = vi.fn(({ head }) => { if (head === HEAD) return numberingCommit(); throw new Error('unreadable'); });
    expect(createRedTeamGateIo({ env: {}, readCommit }).numberingAncestors({ repo: REPO, head: HEAD })).toEqual([]);
  });
});

describe('applyRedTeamGate', () => {
  it('numbering over an ancestor break sends back once and dedupes on the ancestor', async () => {
    const numberingAncestors = createRedTeamGateIo({ env: {}, readCommit: ({ head }) => head === HEAD
      ? numberingCommit() : { sha: OTHER, commit: { message: 'fix: original contribution' } } }).numberingAncestors;
    const readRound = vi.fn(() => 1);
    const { io, calls } = fakeIo({ comments: [comment([F(), F()], OTHER)], numberingAncestors, readRound });
    const first = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(first).toMatchObject({ status: 'applied', head: HEAD, viaAncestor: OTHER, outcome: 'sent-back' });
    expect(readRound).toHaveBeenCalledWith({ repo: REPO, pr: 4722, head: OTHER });
    expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment']);
    expect(calls[0][1]).toMatchObject({ head: HEAD });
    expect(calls[0][1].body).toContain(`applies to the renumbered live head \`${HEAD}\``);
    expect(parseRedTeamGateMarker(calls[2][1].body)).toMatchObject({ rev: OTHER, outcome: 'sent-back' });
    expect(renderGateSummary(first)).toContain(`renumbered live head ${HEAD}`);
    calls.length = 0;
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', head: HEAD, viaAncestor: OTHER });
    expect(calls).toEqual([]);
  });
  it('ancestor card actions retain their records and dedupe independently', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F(), F({ impactIfUnfixed: 'degraded' })], OTHER)], numberingAncestors: () => [OTHER] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('applied');
    expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment', 'card', 'comment']);
    expect(calls[3][1].digest).toContain(OTHER);
    expect(parseRedTeamGateMarker(calls[4][1].body)).toMatchObject({ rev: OTHER, outcome: 'card-queued' });
    calls.length = 0;
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('already-acted');
    expect(calls).toEqual([]);
  });
  it('a failed ancestry read leaves the older result stale', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()], OTHER)], numberingAncestors: () => { throw new Error('gh unavailable'); } });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('no-red-team-on-head');
    expect(calls).toEqual([]);
  });
  it('a non-numbering commit breaks the chain to an older result', async () => {
    const reader = createRedTeamGateIo({ env: {}, readCommit: ({ head }) => head === HEAD ? numberingCommit()
      : { sha: OTHER, commit: { message: 'fix: implementation change' }, parents: [{ sha: '3'.repeat(40) }] } });
    const { io, calls } = fakeIo({ comments: [comment([F()], '3'.repeat(40))], numberingAncestors: reader.numberingAncestors });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('no-red-team-on-head');
    expect(calls).toEqual([]);
  });
  it('a live result always wins without consulting ancestors', async () => {
    const numberingAncestors = vi.fn(() => [OTHER]);
    const { io, calls } = fakeIo({ comments: [comment([F()], OTHER), comment([F({ confirmedByRecheck: false })])], numberingAncestors });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r.status).toBe('advisory-only');
    expect(r).not.toHaveProperty('viaAncestor');
    expect(numberingAncestors).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it('numbering touching code stays stale at the gate', async () => {
    const reader = createRedTeamGateIo({ env: {}, readCommit: () => numberingCommit(HEAD, OTHER, [{ filename: 'scripts/x.mjs' }]) });
    const { io, calls } = fakeIo({ comments: [comment([F()], OTHER)], numberingAncestors: reader.numberingAncestors });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('no-red-team-on-head');
    expect(calls).toEqual([]);
  });
  it('ancestor results still refuse a live-head move before writing', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()], OTHER)], numberingAncestors: () => [OTHER], liveHead: '3'.repeat(40) });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'head-moved', head: HEAD, viaAncestor: OTHER });
    expect(calls).toEqual([]);
  });
  it('ancestor results retain the round cap', async () => {
    const comments = [comment([F()], OTHER)];
    const resultId = redTeamResultId(parseRedTeamComment(comments[0].body));
    const { io, calls, feedItems } = fakeIo({ comments, numberingAncestors: () => [OTHER], round: 5 });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ outcome: 'round-cap', viaAncestor: OTHER });
    expect(kinds(calls)).toEqual(['comment']);
    expect(parseRedTeamGateMarker(calls[0][1].body)).toMatchObject({ rev: OTHER, outcome: 'round-cap' });
    expect(feedItems).toHaveLength(1);
    expect(feedItems[0]).toMatchObject({ pr: 4722, repo: REPO, head: HEAD, kind: 'at-round-limit',
      outcome: 'round-cap', result: resultId });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', viaAncestor: OTHER });
    expect(kinds(calls)).toEqual(['comment']);
    expect(feedItems).toHaveLength(1);
  });
  it('an untrusted ancestor advisory cannot send back', async () => {
    const { io, calls } = fakeIo({ comments: [{ ...comment([F()], OTHER), author: { login: 'outsider' } }], numberingAncestors: () => [OTHER] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('no-red-team-on-head');
    expect(calls).toEqual([]);
  });
  it('uses the first ancestor with a result', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()], '3'.repeat(40)), comment([F({ confirmedByRecheck: false })], OTHER)],
      numberingAncestors: () => [OTHER, '3'.repeat(40)] });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'advisory-only', viaAncestor: OTHER });
    expect(calls).toEqual([]);
  });

  it('round-cap publishes exactly one needs-you item after the comment, with result identity and feed time', async () => {
    const comments = [comment([F(), F({ summary: 'second break' })])];
    const resultId = redTeamResultId(parseRedTeamComment(comments[0].body));
    const { io, calls, feedItems } = fakeIo({ comments, round: 5 });
    const publish = io.publishNeedsYou;
    io.publishNeedsYou = item => {
      expect(kinds(calls)).toEqual(['comment']);
      publish(item);
    };
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'round-cap' });
    expect(feedItems).toHaveLength(1);
    expect(feedItems[0]).toMatchObject({ pr: 4722, repo: REPO, head: HEAD, kind: 'at-round-limit',
      outcome: 'round-cap', result: resultId, title: '' });
    expect(feedItems[0].reason).toContain('outcome=round-cap');
    expect(feedItems[0].reason).toContain(resultId);
    expect(feedItems[0].reason).toContain('2 unsent confirmed break(s)');
    const at = '2026-10-23T12:00:00.000Z';
    const { lines } = diffFeed([], feedItems, at);
    expect(lines).toHaveLength(1);
    expect(parseFeedLine(lines[0])).toMatchObject({ pr: 4722, head: HEAD, outcome: 'round-cap', result: resultId, at });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('already-acted');
    expect(feedItems).toHaveLength(1);
  });

  it.each([
    ['sent-back', [F()]],
    ['no-send-back', [F({ impactIfUnfixed: 'degraded' })]],
  ])('%s publishes no needs-you items (including card-queued)', async (outcome, findings) => {
    const { io, feedItems } = fakeIo({ comments: [comment(findings)] });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome });
    expect(feedItems).toEqual([]);
  });

  it('a failed round-cap comment publishes no needs-you item', async () => {
    const { io, feedItems } = fakeIo({ comments: [comment([F()])], round: 5,
      postComment: () => { throw new Error('gh down'); } });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('send-back-record-failed');
    expect(feedItems).toEqual([]);
  });

  it.each([false, true])('a needs-you publisher failure is logged without changing gate status (async: %s)', async asynchronous => {
    const logs = [];
    const fail = () => { throw new Error('feed unavailable'); };
    const { io } = fakeIo({ comments: [comment([F()])], round: 5,
      publishNeedsYou: asynchronous ? async () => fail() : fail, log: line => logs.push(line) });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'round-cap', marker: 'posted' });
    expect(logs).toEqual([expect.stringMatching(/needs-you.*feed unavailable/)]);
  });

  it('broken → send-back through review-set-label + ledger event + gate record', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F({ summary: 'two writers' })])] });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r).toMatchObject({ status: 'applied', outcome: 'sent-back' });
    expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment']);
    expect(calls[0][1]).toMatchObject({ repo: REPO, pr: 4722, head: HEAD });
    expect(calls[0][1].body).toMatch(/1\. `scripts\/x\.mjs:3` — \(edge-case, broken\) two writers/);
    expect(calls[2][1].body.startsWith(namedGate('sent-back'))).toBe(true);
  });

  it('degraded → one follow-up card, no send-back', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F({ impactIfUnfixed: 'degraded', summary: 'stale config' })])] });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r).toMatchObject({ status: 'applied', outcome: 'no-send-back' });
    expect(kinds(calls)).toEqual(['card', 'comment']);
    expect(calls[0][1]).toMatchObject({ kind: 'story', scope: 'we:scripts/x.mjs' });
    expect(calls[0][1].digest).toMatch(/stale config/);
    expect(calls[1][1].body.startsWith(namedGate('card-queued'))).toBe(true);
  });

  // Review of the repair: a card job that was spawned but whose record never posted would be queued AGAIN next run.
  it('a card record that cannot be posted is a visible status, not a silent "applied"', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F({ impactIfUnfixed: 'degraded' })])], postComment: () => { throw new Error('gh down'); } });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'card-record-failed', error: expect.stringMatching(/gh down/) });
    expect(kinds(calls)).toEqual(['card']);
  });

  // Round 2 of PR #4762: a send-back whose record cannot be posted looked like success, and without the record the
  // operator queue never learns the fixer owns the break. Same class as the card record above: one case per record.
  it('a send-back record that cannot be posted is a visible failure, and the retry restores it without a second label write', async () => {
    const comments = [comment([F()])];
    let down = true;
    const { io, calls } = fakeIo({ comments, postComment: (a) => { calls.push(['comment', a]); if (down) throw new Error('gh down'); comments.push({ author: { login: 'web-everything' }, body: a.body }); } });
    const first = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(first).toMatchObject({ status: 'send-back-record-failed', error: expect.stringMatching(/gh down/) });
    expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment']);
    // GitHub now shows review:changes (the real writer set it); the retry records without sending again.
    calls.length = 0; down = false;
    const retryIo = { ...io, readPr: () => ({ headRefOid: HEAD, labels: [{ name: 'review:changes' }], comments }) };
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, retryIo)).status).toBe('applied');
    expect(kinds(calls)).toEqual(['comment']);
    expect(calls[0][1].body.startsWith(namedGate('sent-back'))).toBe(true);
  });
  it('a round-cap record that cannot be posted is a visible failure too', async () => {
    const { io } = fakeIo({ comments: [comment([F()])], round: 5, postComment: () => { throw new Error('gh down'); } });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'send-back-record-failed', outcome: 'round-cap' });
  });

  // Prevention for PR #4762 round 2: each action's marker-publication failure is a failure status, a nonzero CLI exit,
  // and an error the job summary line carries (the review-job side is pinned in the review-job describe below).
  it.each([
    ['send-back', () => [F()], 1, 'send-back-record-failed'],
    ['round-cap', () => [F()], 5, 'send-back-record-failed'],
    ['card', () => [F({ impactIfUnfixed: 'degraded' })], 1, 'card-record-failed'],
  ])('a failed %s marker post → %s status, CLI exit 1, error in the summary', async (_action, findings, round, status) => {
    const { io } = fakeIo({ comments: [comment(findings())], round, postComment: () => { throw new Error('gh down'); } });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r.status).toBe(status);
    expect(gateExitCode(r)).toBe(1);
    expect(renderGateSummary(r)).toMatch(/gh down/);
  });
  it('a failed send-back marker post on a PR already under review:changes is a failure too', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()])], labels: ['review:changes'], postComment: () => { throw new Error('gh down'); } });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r).toMatchObject({ status: 'send-back-record-failed', error: expect.stringMatching(/gh down/) });
    expect(kinds(calls)).not.toContain('sendBack');
  });
  it('a failed card marker after a good send-back marker fails the run and keeps the send-back record', async () => {
    const comments = [comment([F(), F({ impactIfUnfixed: 'degraded' })])];
    const { io, calls } = fakeIo({ comments, postComment: (a) => { calls.push(['comment', a]); if (a.body.includes('card-queued')) throw new Error('gh down'); comments.push({ author: { login: 'web-everything' }, body: a.body }); } });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r).toMatchObject({ status: 'card-record-failed', marker: 'posted' });
    expect(gateExitCode(r)).toBe(1);
  });
  it('gateExitCode: 0 for every non-failure status, 1 for every failure one', () => {
    for (const status of ['applied', 'already-acted', 'advisory-only', 'no-red-team-on-head', 'dry-run', 'head-moved']) expect(gateExitCode({ status })).toBe(0);
    for (const status of ['error', 'send-back-failed', 'send-back-record-failed', 'card-failed', 'card-record-failed']) expect(gateExitCode({ status })).toBe(1);
  });

  it('broken + degraded → send-back, THEN the card; each action gets its own record', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F(), F({ impactIfUnfixed: 'degraded' })])] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('applied');
    expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment', 'card', 'comment']);
    expect(calls[2][1].body.startsWith(namedGate('sent-back'))).toBe(true);
    expect(calls[4][1].body.startsWith(namedGate('card-queued'))).toBe(true);
  });

  // F5 (review of PR #4762): a FAILED card used to write the permanent per-head record, so the card was never retried.
  it('a failed card filing stays retryable on the same head, without repeating the send-back', async () => {
    const comments = [comment([F(), F({ impactIfUnfixed: 'degraded', summary: 'stale config' })])];
    let attempt = 0;
    const { io, calls } = fakeIo({ comments, fileCard: (input) => { attempt += 1; calls.push(['card', input]); return attempt === 1 ? { ok: false, error: 'landing job refused' } : { ok: true, session: 'red-team-card-2' }; } });
    const first = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(first).toMatchObject({ status: 'card-failed', error: 'landing job refused' });
    expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment', 'card']);
    calls.length = 0;
    const retry = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(retry.status).toBe('applied');
    expect(kinds(calls)).toEqual(['card', 'comment']);
    expect(calls[1][1].body.startsWith(namedGate('card-queued'))).toBe(true);
    calls.length = 0;
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('already-acted');
    expect(calls).toEqual([]);
  });

  it('records a paused owed card once and reads its finding as already handled', async () => {
    const comments = [comment([F({ impactIfUnfixed: 'degraded' })])];
    let attempts = 0;
    const { io, calls } = fakeIo({ comments, fileCard: () => {
      attempts++;
      return { ok: false, skipped: true, step: 'paused', reason: 'filing paused', num: null, url: null };
    } });
    const result = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(result.status).toBe('applied');
    expect(gateExitCode(result)).toBe(0);
    expect(calls[0][1].body).toContain('recorded, owed as a follow-up card (#1) — filing paused; will file on resume.');
    expect(calls[0][1].body).not.toMatch(/FAILED|undefined|null/);
    expect(readRedTeamDisposition({ comments, pr: 4722, head: HEAD, setting: { degraded: 'send-back' } }).sendBack).toEqual([]);
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('already-acted');
    expect(attempts).toBe(1);
  });

  it.each([
    { ok: false, step: 'paused', error: 'could not record owed filing' },
    { ok: false, skipped: true, step: 'other', error: 'other failure' },
  ])('keeps an unrecorded or unrelated filing failure retryable: %j', async card => {
    const { io, calls } = fakeIo({ comments: [comment([F({ impactIfUnfixed: 'degraded' })])], fileCard: () => card });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('card-failed');
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('card-failed');
    expect(calls).toEqual([]);
  });

  // F4: the round is the only bound on send-backs. An unreadable round must not be read as "round 1".
  it('an unreadable round counts as the cap: no send-back, the operator rules', async () => {
    for (const unreadable of [null, undefined, NaN, '3']) {
      const { io, calls } = fakeIo({ comments: [comment([F()])], readRound: () => unreadable });
      const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
      expect(r.outcome).toBe('round-cap');
      expect(kinds(calls)).toEqual(['comment']);
      expect(calls[0][1].body).toMatch(/could not be read/);
      expect(calls[0][1].body).not.toMatch(/round null/);
    }
  });

  // F1 (review of PR #4762): the sender must not say it pins the head when the writer cannot. What it does instead:
  // re-read the live head right before the write and refuse when the fixer pushed in between.
  it('a push between the gate\'s read and the write is refused (nothing written, nothing recorded)', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()])], liveHead: OTHER });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'head-moved', head: HEAD });
    expect(calls).toEqual([]);
  });

  it('unconfirmed → advisory: nothing written', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F({ confirmedByRecheck: false })])] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('advisory-only');
    expect(calls).toEqual([]);
  });

  it('a comment on a stale head is ignored', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()], OTHER)] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('no-red-team-on-head');
    expect(calls).toEqual([]);
  });

  it('bounded by the round cap: no send-back, the operator rules', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()])], round: 5 });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r.outcome).toBe('round-cap');
    expect(kinds(calls)).toEqual(['comment']);
    expect(calls[0][1].body).toMatch(/round cap/);
  });

  // Live #5492 (2026-10-20): the operator granted "one more round" at review round 12, but the gate kept answering
  // `already-acted → round-cap` (cap fixed at 5, and a round-cap record was never re-decided).
  describe('operator round grant after the cap', () => {
    const OPERATOR = { login: 'chalbert' };
    const grant = (by = 1, at = '2026-10-19T12:00:00Z') => ({ author: OPERATOR, createdAt: at,
      body: buildRoundExtensionComment({ repo: REPO, pr: 4722, by, actor: 'chalbert', channel: 'claude-code-chat', reason: 'Yes', at }) });
    const capRecord = (round = 12, grantIds = null) => ({ author: { login: 'web-everything' }, createdAt: '2026-10-10T03:00:00Z',
      body: buildGateComment({ pr: 4722, head: HEAD, outcome: GATE_OUTCOMES.ROUND_CAP, plan: { sendBack: [{ index: 1 }], card: [], advisory: [] },
        round, grantIds, result: redTeamResultId(parseRedTeamComment(comment([F()]).body)) }) });

    // Standing-ruling grants (operator option B): the gate uses the SAME trusted reader, so an App-posted grant
    // counts only when the io hands it the scope verified from GitHub at this read.
    const autoGrant = (at = '2026-10-19T12:00:00Z') => ({ id: 'IC_auto', author: { login: 'web-everything' }, createdAt: at,
      body: buildRoundExtensionComment({ repo: REPO, pr: 4722, by: 1, actor: 'chalbert', channel: 'standing-ruling-auto', reason: 'ruling', at,
        standingRuling: `${REPO}#5751`, head: HEAD, episode: `${REPO}#4722@${HEAD}:review:12/12` }) });
    const verified = { id: `${REPO}#5751`, author: 'chalbert', by: 1, maxPerPr: 3, repos: [REPO], cardOnlyHeads: { [HEAD]: true }, uneditedComments: ['IC_auto'] };
    it('a standing-ruling grant reopens the send-back only under the verified scope', async () => {
      const comments = [comment([F()]), capRecord(), autoGrant()];
      const without = fakeIo({ comments, round: 12, readRoundAsOf: () => 12 });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722, dryRun: true }, without.io)).toMatchObject({ status: 'already-acted', outcome: 'round-cap' });
      const unverified = fakeIo({ comments, round: 12, readRoundAsOf: () => 12, readGrantScope: () => ({ ...verified, cardOnlyHeads: { [HEAD]: false } }) });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722, dryRun: true }, unverified.io)).toMatchObject({ status: 'already-acted', outcome: 'round-cap' });
      const ok = fakeIo({ comments, round: 12, readRoundAsOf: () => 12, readGrantScope: () => verified });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722, dryRun: true }, ok.io)).toMatchObject({ status: 'dry-run', reopened: true, cap: 13, outcome: 'sent-back' });
      // The pure readers treat a verified automatic grant exactly like a manual grant at the same position, and an
      // unverified one exactly like no grant at all.
      const pr = { number: 4722, repo: REPO, headRefOid: HEAD, labels: ['review:accepted'], comments };
      const manual = { ...pr, comments: [comment([F()]), capRecord(), grant(1)] };
      const none = { ...pr, comments: [comment([F()]), capRecord()] };
      expect(redTeamRulingNeeded({ ...pr, standingRuling: verified })).toEqual(redTeamRulingNeeded(manual));
      expect(redTeamRulingNeeded(pr)).toEqual(redTeamRulingNeeded(none));
    });

    const readerShapes = {
      complete: c => c,
      rest: (c, index) => ({ id: index + 100, node_id: c.id, user: c.author, created_at: c.createdAt, body: c.body }),
      labels: c => ({ author: c.author, createdAt: c.createdAt, body: c.body }),
      minimal: c => ({ author: c.author, body: c.body }),
    };

    it.each(Object.keys(readerShapes))('a new send-back retains its enqueue hold through the %s reader after an earlier clearance', async shape => {
      const clearance = { author: { login: 'chalbert' }, createdAt: '2026-10-18T12:00:00Z',
        body: ['✅ review — `review:human` cleared via the sanctioned path', '',
          'Cleared by operator via `review-set-label.mjs --to=clear-human` (gate-self).', '',
          buildReviewedShaMarker(HEAD), buildClearedHumanMarker('operator')].join('\n') };
      const comments = [comment([F()]), capRecord(), clearance, { ...grant(), id: 'IC_grant' }];
      const { io, calls } = fakeIo({ comments, round: 12, readRoundAsOf: () => 12 });
      const hold = thread => redTeamEnqueueHold({ comments: thread, pr: 4722, head: HEAD, repo: REPO,
        confirmedBreaks: CONFIRMED_BREAKS_DEFAULTS, env: {} });
      expect(hold(comments)).toBeNull();
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'sent-back' });
      expect(calls.filter(([kind]) => kind === 'sendBack')).toHaveLength(1);
      const thread = comments.map(readerShapes[shape]);
      expect(hold(thread)).toMatch(/confirmed a break requiring send-back/);
      expect(redTeamQueueReason({ number: 4722, repo: REPO, headRefOid: HEAD, labels: ['review:changes'], comments: thread }))
        .toMatch(/the fixer owns them/);
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, { ...io, readPr: () => ({ headRefOid: HEAD, labels: [], comments: thread }) }))
        .toMatchObject({ status: 'already-acted', outcome: 'sent-back' });
      expect(calls.filter(([kind]) => kind === 'sendBack')).toHaveLength(1);
    });

    it('grant identities survive metadata changes, distinguish copies and invalidate edits', () => {
      const first = { ...grant(), id: 'IC_grant' };
      const ids = comments => gateRoundGrants(comments, 4722, REPO).map(g => g.id);
      const original = ids([first]);
      for (const shape of Object.values(readerShapes)) expect(ids([first].map(shape))).toEqual(original);
      const copies = ids([first, { ...first, id: 'IC_copy' }]);
      expect(new Set(copies).size).toBe(2);
      expect(ids([first, { ...first, id: 'IC_copy' }].map(readerShapes.labels))).toEqual(copies);
      expect(ids([{ ...first, body: grant(2).body }])).not.toEqual(original);
      expect(ids([{ author: first.author, body: 'unrelated' }, first])).toEqual(original);
    });

    // PR #5744 review: the parser accepted at most 10 grant ids while the writer records every grant, so an 11th grant
    // made the gate's own record unreadable: the send-back repeated and its enqueue hold vanished (fail-open).
    it.each([0, 1, 10, 11, 200])('a gate marker naming %i grant ids round-trips', n => {
      const grantIds = Array.from({ length: n }, (_, i) => createHash('sha256').update(String(i)).digest('hex').slice(0, 16));
      for (const outcome of [GATE_OUTCOMES.SENT_BACK, GATE_OUTCOMES.ROUND_CAP]) {
        const body = buildGateComment({ pr: 4722, head: HEAD, outcome, round: 12, grantIds,
          result: redTeamResultId(parseRedTeamComment(comment([F()]).body)), plan: { sendBack: [{ index: 1 }], card: [], advisory: [] } });
        expect(parseRedTeamGateMarker(body)).toMatchObject({ pr: 4722, rev: HEAD, outcome, grantIds });
      }
    });

    // The writer records whatever the grant reader returns; the parser must not encode that reader's ceiling. Edited
    // grants leave stale ids in an older snapshot, so a record can name more ids than the thread now credits.
    it.each([11, 40])('a send-back record naming %i grant ids is seen again: no repeat, and its enqueue hold stays', async n => {
      const grants = [0, 1, 2].map(i => ({ ...grant(1, `2026-10-19T12:0${i}:00Z`), id: `IC_grant${i}` }));
      const live = gateRoundGrants(grants, 4722, REPO).map(g => g.id);
      const stale = Array.from({ length: n - live.length }, (_, i) => createHash('sha256').update(`edited-${i}`).digest('hex').slice(0, 16));
      const sender = { author: { login: 'web-everything' }, body: buildGateComment({ pr: 4722, head: HEAD,
        outcome: GATE_OUTCOMES.SENT_BACK, round: 12, grantIds: [...stale, ...live],
        result: redTeamResultId(parseRedTeamComment(comment([F()]).body)),
        plan: { sendBack: [{ index: 1 }], card: [], advisory: [] } }) };
      const comments = [comment([F()]), capRecord(), ...grants, sender];
      expect(parseRedTeamGateMarker(sender.body)?.grantIds).toHaveLength(n);
      expect(redTeamEnqueueHold({ comments, pr: 4722, head: HEAD, repo: REPO, confirmedBreaks: CONFIRMED_BREAKS_DEFAULTS, env: {} }))
        .toMatch(/confirmed a break requiring send-back/);
      expect(redTeamQueueReason({ number: 4722, repo: REPO, headRefOid: HEAD, labels: ['review:changes'], comments }))
        .toMatch(/the fixer owns them/);
      const { io, calls } = fakeIo({ comments, round: 12, readRoundAsOf: () => 12 });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'sent-back' });
      expect(calls.filter(([kind]) => kind === 'sendBack')).toHaveLength(0);
    });

    it.each(Object.keys(readerShapes).flatMap(shape => [false, true].map(carried => [shape, carried])))(
      'an existing grant snapshot keeps its enqueue hold through the %s reader until a newer clearance (carried: %s)', (shape, carried) => {
      const extension = { ...grant(), id: 'IC_grant' };
      const key = JSON.stringify([extension.id, extension.createdAt, extension.body]);
      const oldId = createHash('sha256').update(JSON.stringify([key, 1])).digest('hex').slice(0, 16);
      const clearance = { author: { login: 'chalbert' },
        body: ['✅ review — `review:human` cleared via the sanctioned path', '',
          'Cleared by operator via `review-set-label.mjs --to=clear-human` (gate-self).', '',
          buildReviewedShaMarker(HEAD), buildClearedHumanMarker('operator')].join('\n') };
      const sender = { author: { login: 'web-everything' }, body: buildGateComment({ pr: 4722, head: HEAD,
        outcome: GATE_OUTCOMES.SENT_BACK, round: 12, grantIds: [oldId],
        result: redTeamResultId(parseRedTeamComment(comment([F()]).body)),
        plan: { sendBack: [{ index: 1 }], card: [], advisory: [] } }) };
      const result = comment([F()]);
      const prefix = carried ? [
        { ...result, body: result.body.replaceAll(HEAD, OTHER) },
        { ...capRecord(), body: capRecord().body.replaceAll(HEAD, OTHER) },
        { ...clearance, body: clearance.body.replaceAll(HEAD, OTHER) },
        { ...result, body: [buildVerdictCarriedMarker({ fromSha: OTHER, toSha: HEAD, patchId: 'c'.repeat(40) }),
          'Review verdict carried across an identical contribution.', result.body].join('\n') },
      ] : [result];
      const comments = [...prefix, capRecord(), clearance, extension, sender].map(readerShapes[shape]);
      const hold = () => redTeamEnqueueHold({ comments, pr: 4722, head: HEAD, repo: REPO,
        confirmedBreaks: CONFIRMED_BREAKS_DEFAULTS, env: {} });
      expect(hold()).toMatch(/confirmed a break requiring send-back/);
      comments.push(readerShapes[shape](clearance, comments.length));
      expect(hold()).toBeNull();
    });

    // PR #5744 round 4: 12 heads are in the ledger, the gated head's own row missed. The gate read round 13 and capped;
    // the operator's +1 must anchor at that same round 13, not at the 12 recorded heads.
    it('a +1 grant buys a round when the gated head has no ledger row', async () => {
      const rows = Array.from({ length: 12 }, (_, i) => ({ type: 'review-run', pr: 4722,
        headSha: createHash('sha1').update(String(i)).digest('hex'), at: `2026-10-0${1 + (i % 9)}T00:00:00Z` }));
      const readLedgerRows = () => rows;
      const comments = [comment([F()]), capRecord(13), grant()];
      const { io, calls } = fakeIo({ comments,
        readRound: ({ repo, pr, head }) => readReviewRound({ repo, pr, head, readLedgerRows }),
        readRoundAsOf: (a) => readReviewRoundAsOf({ ...a, readLedgerRows }) });
      expect(readReviewRound({ repo: REPO, pr: 4722, head: HEAD, readLedgerRows })).toBe(13);
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'sent-back' });
      expect(calls.filter(([kind]) => kind === 'sendBack')).toHaveLength(1);
    });

    // The anchor counts the gated head for a grant only when the thread shows the head reviewed BEFORE that grant: the
    // first trusted red-team result on it, or a trusted `reviewed-sha` marker naming it. Thread order, never clocks.
    const reviewedSha = (author = 'web-everything') => ({ author: { login: author }, createdAt: '2026-10-09T00:00:00Z',
      body: `🔍 review — accepted\n\n${buildReviewedShaMarker(HEAD)}` });
    const skewed = { ...grant(), createdAt: '2026-01-01T00:00:00Z', body: grant(1, '2026-01-01T00:00:00Z').body };
    it.each([
      ['a grant before any review of the head', () => [grant(), comment([F()])], null],
      ['a grant after the head\'s red-team result', () => [comment([F()]), grant()], HEAD],
      ['a grant after the first result, though a newer result follows it', () => [comment([F()]), grant(), comment([F()])], HEAD],
      ['a grant between the published review and the red-team result', () => [reviewedSha(), grant(), comment([F()])], HEAD],
      ['a grant whose own clock reads earlier than the result', () => [comment([F()]), skewed], HEAD],
      ['a grant after an untrusted reviewed-sha marker only', () => [reviewedSha('mallory'), grant(), comment([F()])], null],
      ['a grant after a reviewed-sha marker for another head', () => [{ ...reviewedSha(), body: buildReviewedShaMarker(OTHER) }, grant(), comment([F()])], null],
    ])('the anchor for %s counts head %s', async (_, thread, expected) => {
      const seen = [];
      const { io } = fakeIo({ comments: thread(), round: 3, readRoundAsOf: (a) => { seen.push(a); return 1; } });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722, dryRun: true }, io)).toMatchObject({ status: 'dry-run' });
      expect(seen).toHaveLength(1);
      expect(seen[0].head ?? null).toBe(expected);
    });

    it('a round-cap record with no later grant stays already-acted (unchanged)', async () => {
      const { io, calls } = fakeIo({ comments: [comment([F()]), capRecord()], round: 12, readRoundAsOf: () => 12 });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'round-cap' });
      expect(calls).toEqual([]);
    });

    it.each([[false, null], [true, null], [false, 'delete'], [true, 'delete'], [false, 'edit'], [true, 'edit']])(
      'a grant during a cap POST survives the stale record (send-back first: %s, replace old grant: %s)', async (sendFirst, replace) => {
      const comments = [comment([F()])];
      const oldAt = '2026-10-18T12:00:00Z';
      const oldGrant = grant(1, oldAt);
      if (replace) comments.push(oldGrant);
      let delayedCap;
      const { io, calls } = fakeIo({ comments, round: 12, readRoundAsOf: ({ at }) => at === oldAt ? 1 : 12,
        postComment: (a) => {
          calls.push(['comment', a]);
          if (a.body.startsWith(namedGate('round-cap'))) {
            // Gate A decided without the fresh grant; the operator grants while its POST is in flight.
            if (replace === 'delete') comments.splice(comments.indexOf(oldGrant), 1);
            if (replace === 'edit') oldGrant.body = 'Grant withdrawn';
            comments.push(grant());
            if (sendFirst) { delayedCap = a; return; }
          }
          comments.push({ author: { login: 'web-everything' }, body: a.body });
        },
      });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'round-cap' });
      if (sendFirst) {
        expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'sent-back' });
        comments.push({ author: { login: 'web-everything' }, body: delayedCap.body });
      }
      else {
        expect(await applyRedTeamGate({ repo: REPO, pr: 4722, dryRun: true }, io))
          .toMatchObject({ status: 'dry-run', reopened: true, cap: 13, outcome: 'sent-back' });
        expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'sent-back' });
      }
      expect(calls.filter(([kind]) => kind === 'sendBack')).toHaveLength(1);
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'sent-back' });
      const pr = { number: 4722, repo: REPO, headRefOid: HEAD, labels: ['review:changes'], comments };
      expect(redTeamQueueReason(pr)).toMatch(/the fixer owns them/);
      expect(redTeamRulingNeeded({ ...pr, labels: ['review:accepted'] })).toBeNull();
    });

    it('--by=1 granted at round 12 sends the break back once: the cap is anchored at the grant round', async () => {
      const comments = [comment([F()]), capRecord(), grant(1)];
      const { io, calls } = fakeIo({ comments, round: 12, readRoundAsOf: () => 12 });
      const dry = await applyRedTeamGate({ repo: REPO, pr: 4722, dryRun: true }, io);
      expect(dry).toMatchObject({ status: 'dry-run', reopened: true, cap: 13, outcome: 'sent-back', wouldSendBack: true });
      const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
      expect(r).toMatchObject({ status: 'applied', outcome: 'sent-back' });
      expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment']);
      // The send-back record after the grant now decides the step: no second send-back, and the break is the fixer's.
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'sent-back' });
      const pr = { number: 4722, repo: REPO, headRefOid: HEAD, labels: ['review:changes'], comments };
      expect(redTeamQueueReason(pr)).toMatch(/the fixer owns them/);
      expect(redTeamRulingNeeded({ ...pr, labels: ['review:accepted'] })).toBeNull();
    });

    it('a later edit cannot make a historical sender claim the enlarged grant', async () => {
      const extension = grant(1);
      const comments = [comment([F()]), capRecord(), extension];
      let round = 12;
      const { io, calls } = fakeIo({ comments, readRound: () => round, readRoundAsOf: () => 12 });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'sent-back' });
      const snapshot = parseRedTeamGateMarker(comments.at(-1).body).grantIds;
      expect(snapshot).toHaveLength(1);
      // A concurrent decision at round 13 consumed the original grant and landed after the sender.
      comments.push(capRecord(13, snapshot));
      round = 13;
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'round-cap' });
      extension.body = grant(2).body;
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722, dryRun: true }, io))
        .toMatchObject({ status: 'dry-run', reopened: true, cap: 14, outcome: 'sent-back' });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'sent-back' });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'sent-back' });
      expect(calls.filter(([kind]) => kind === 'sendBack')).toHaveLength(2);
    });

    it('the next round past the grant is capped again: exactly one more round', async () => {
      const { io } = fakeIo({ comments: [comment([F()]), capRecord(13), grant(1)], round: 13, readRoundAsOf: () => 12 });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722, dryRun: true }, io)).toMatchObject({ reopened: true, cap: 13, outcome: 'round-cap' });
    });

    it('a grant that does not cover the round re-records round-cap once, then never loops', async () => {
      const comments = [comment([F()]), capRecord(), grant(1)];
      const { io, calls } = fakeIo({ comments, round: 12, readRoundAsOf: () => null });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'round-cap' });
      expect(kinds(calls)).toEqual(['comment']);
      expect(calls[0][1].body).toMatch(/review round 12 has reached the round cap \(6\)/);
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'round-cap' });
    });

    it('the shared reader credits a grant only for this PR\'s repo; no repo means no credit (Codex audit)', async () => {
      const raced = { author: { login: 'web-everything' }, createdAt: '2026-10-19T13:00:00Z',
        body: buildGateComment({ pr: 4722, head: HEAD, outcome: GATE_OUTCOMES.SENT_BACK, plan: { sendBack: [{ index: 1 }], card: [], advisory: [] },
          round: 12, result: redTeamResultId(parseRedTeamComment(comment([F()]).body)) }) };
      const fui = { ...grant(1), body: buildRoundExtensionComment({ repo: 'frontier-ui/frontierui', pr: 4722, by: 1, actor: 'chalbert', channel: 'c', reason: 'Yes', at: '2026-10-19T12:00:00Z' }) };
      const pr = (g) => ({ number: 4722, headRefOid: HEAD, labels: ['review:accepted'], comments: [comment([F()]), capRecord(), g, raced] });
      expect(redTeamRulingNeeded(pr(fui), CONFIRMED_BREAKS_DEFAULTS, { repo: REPO })).not.toBeNull();
      expect(redTeamRulingNeeded(pr(grant(1)))).not.toBeNull();
      expect(redTeamRulingNeeded(pr(grant(1)), CONFIRMED_BREAKS_DEFAULTS, { repo: REPO })).toBeNull();
      const { io } = fakeIo({ comments: [comment([F()]), capRecord(), fui], round: 12, readRoundAsOf: () => 12 });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'round-cap' });
    });

    it('a grant not authored by the operator reopens nothing', async () => {
      const forged = { ...grant(1), author: { login: 'web-everything' } };
      const { io, calls } = fakeIo({ comments: [comment([F()]), capRecord(), forged], round: 12, readRoundAsOf: () => 12 });
      expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'round-cap' });
      expect(calls).toEqual([]);
    });

    // PR #5758 review: the gate read grants with no standing-ruling scope, so an automatic grant never reopened its cap.
    describe('automatic standing-ruling grant', () => {
      const RULING_ID = `${REPO}#6000`;
      const autoGrant = { id: 'IC_auto', author: { login: 'web-everything[bot]' }, createdAt: '2026-10-19T12:00:00Z',
        body: buildRoundExtensionComment({ repo: REPO, pr: 4722, by: 1, actor: 'chalbert', channel: 'auto-round-grant', reason: 'r',
          at: '2026-10-19T12:00:00Z', standingRuling: RULING_ID, head: HEAD, episode: `${REPO}#4722@${HEAD}:review:12/12` }) };
      const scope = { ok: true, id: RULING_ID, author: 'chalbert', by: 1, maxPerPr: 3, repos: [REPO],
        cardOnlyHeads: { [HEAD]: true }, uneditedComments: ['IC_auto'] };

      it('reopens a capped red-team send-back once, and every red-team reader credits it', async () => {
        const comments = [comment([F()]), capRecord(), autoGrant];
        const scopes = [];
        const { io, calls } = fakeIo({ comments, round: 12, readRoundAsOf: () => 12,
          readGrantScope: (a) => { scopes.push(a); return scope; } });
        expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'sent-back' });
        expect(scopes[0]).toMatchObject({ repo: REPO, pr: 4722, head: HEAD, comments });
        expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'sent-back' });
        expect(calls.filter(([kind]) => kind === 'sendBack')).toHaveLength(1);
        expect(gateRoundGrants(comments, 4722, REPO, scope)).toEqual([expect.objectContaining({ by: 1, standingRuling: RULING_ID })]);
        const pr = { number: 4722, repo: REPO, headRefOid: HEAD, labels: ['review:changes'], comments, standingRuling: scope };
        expect(redTeamQueueReason(pr)).toMatch(/the fixer owns them/);
        expect(redTeamRulingNeeded({ ...pr, labels: ['review:accepted'] })).toBeNull();
        // The drain hold, the status labels and the clear-human ruling check read the same disposition with the scope.
        const read = standingRuling => readRedTeamDisposition({ comments, pr: 4722, head: HEAD, repo: REPO, setting: CONFIRMED_BREAKS_DEFAULTS, env: {}, standingRuling });
        expect(read(scope)).toMatchObject({ outcome: 'sent-back', sendBack: [expect.objectContaining({ index: 1 })], held: [] });
        expect(read(null)).toMatchObject({ outcome: 'round-cap', sendBack: [] });
        expect(redTeamEnqueueHold({ comments, pr: 4722, head: HEAD, repo: REPO, standingRuling: scope, confirmedBreaks: CONFIRMED_BREAKS_DEFAULTS, env: {} }))
          .toMatch(/confirmed a break requiring send-back/);
        // The drain's enqueue hold holds either way (the break is the fixer's, or the operator's): never released early.
        expect(redTeamEnqueueHold({ comments, pr: 4722, head: HEAD, repo: REPO, standingRuling: null, confirmedBreaks: CONFIRMED_BREAKS_DEFAULTS, env: {} }))
          .toMatch(/confirmed a break requiring send-back/);
        expect(planRedTeamStatusLabels({ labels: [], comments, repo: REPO, pr: 4722, head: HEAD, env: {}, standingRuling: scope }).add).toBe('red-team:blocked');
        // The label sync reads the scope itself unless its caller passes the one it already read.
        const scopeReads = [];
        const provider = { readPrState: () => ({ headRefOid: HEAD, labels: [] }), readComments: () => comments };
        const sync = over => syncRedTeamStatusLabels({ repo: REPO, pr: 4722, head: HEAD, env: { WE_RED_TEAM_STATUS_LABELS: 'true' }, provider, dryRun: true,
          readGrantScope: a => { scopeReads.push(a); return scope; }, ...over });
        expect(sync({}).add).toBe('red-team:blocked');
        expect(scopeReads).toEqual([{ repo: REPO, pr: { number: 4722, headRefOid: HEAD, comments } }]);
        sync({ standingRuling: null });
        expect(scopeReads).toHaveLength(1);
        const asked = [];
        const held = readGrantScope => redTeamRulingHeld({ repo: REPO, pr: 4722, headSha: HEAD, labels: ['review:accepted'], comments,
          setting: CONFIRMED_BREAKS_DEFAULTS, readGrantScope: a => { asked.push(a); return readGrantScope(); } });
        expect(held(() => scope)).toBe(false);
        expect(asked[0]).toMatchObject({ repo: REPO, pr: { number: 4722, headRefOid: HEAD, comments } });
        expect(held(() => null)).toBe(true);
        expect(held(() => { throw new Error('gh down'); })).toBe(true);
      });

      // Operator send-back on PR #5758: the drain reads raw REST comments (numeric `id`, `node_id`, `user`,
      // `created_at`) and the label provider its own projection; a verified grant credited 0 in both, so a card-only
      // PR stayed at its cap. Every production shape credits it; every trust check stays as strict.
      const graphql = (c) => c;
      const rest = (c, i) => ({ id: 3400000000 + i, node_id: c.id ?? `IC_rest_${i}`, user: c.author, created_at: c.createdAt,
        updated_at: c.createdAt, body: c.body, html_url: `https://github.com/${REPO}/pull/4722#issuecomment-${3400000000 + i}` });
      const labelProvider = (c, i) => ({ id: c.id ?? `IC_lp_${i}`, author: c.author, body: c.body, createdAt: c.createdAt });
      it.each([['GraphQL', graphql], ['raw REST', rest], ['label-provider', labelProvider]])(
        'one valid unedited grant credits +1 in the %s shape, and the send-back resolver no longer returns round-cap', async (_, shape) => {
          const thread = () => [comment([F()]), capRecord(), autoGrant].map(shape);
          const comments = thread();
          expect(countGrantedRoundExtensions(comments, { repo: REPO, pr: 4722, standingRuling: scope })).toBe(1);
          expect(gateRoundGrants(comments, 4722, REPO, scope)).toEqual([expect.objectContaining({ by: 1, standingRuling: RULING_ID, at: autoGrant.createdAt })]);
          expect(liveResultGateState(comments, 4722, HEAD, REPO, scope)).toMatchObject({ sendBackOutcome: 'round-cap', reopened: true });
          expect(liveResultGateState(comments, 4722, HEAD, REPO, null)).toMatchObject({ sendBackOutcome: 'round-cap', reopened: false });
          const gate = (readGrantScope) => applyRedTeamGate({ repo: REPO, pr: 4722 },
            fakeIo({ comments: thread(), round: 12, readRoundAsOf: () => 12, readGrantScope }).io);
          expect(await gate(() => scope)).toMatchObject({ status: 'applied', outcome: 'sent-back' });
          expect(await gate(() => null)).toMatchObject({ status: 'already-acted', outcome: 'round-cap' });
        });
      it('no trust check is loosened in the REST shape', () => {
        const thread = (grant) => [comment([F()]), capRecord(), grant].map(rest);
        const credited = (comments) => countGrantedRoundExtensions(comments, { repo: REPO, pr: 4722, standingRuling: scope });
        const restGrant = rest(autoGrant, 2);
        expect(credited([restGrant])).toBe(1);
        // A numeric id alone never matches the unedited node ids; an edited comment (id not in the list) never counts.
        expect(credited([{ ...restGrant, node_id: undefined }])).toBe(0);
        expect(credited([{ ...restGrant, node_id: 'IC_edited' }])).toBe(0);
        // No GitHub creation time, a forged author, another ruling, or a non-card-only head: never credited.
        expect(credited([{ ...restGrant, created_at: undefined }])).toBe(0);
        expect(credited([{ ...restGrant, created_at: 'not a date' }])).toBe(0);
        expect(credited([{ ...restGrant, user: { login: 'mallory' } }])).toBe(0);
        expect(countGrantedRoundExtensions([restGrant], { repo: REPO, pr: 4722, standingRuling: { ...scope, id: `${REPO}#6001` } })).toBe(0);
        expect(countGrantedRoundExtensions([restGrant], { repo: REPO, pr: 4722, standingRuling: { ...scope, cardOnlyHeads: { [HEAD]: false } } })).toBe(0);
        // Per episode and the per-PR cap hold across shapes too.
        expect(credited([restGrant, rest(autoGrant, 3)])).toBe(1);
        const nth = (n) => rest({ ...autoGrant, id: `IC_auto${n}`, body: buildRoundExtensionComment({ repo: REPO, pr: 4722, by: 1, actor: 'chalbert',
          channel: 'auto-round-grant', reason: 'r', at: autoGrant.createdAt, standingRuling: RULING_ID, head: HEAD, episode: `${REPO}#4722@${HEAD}:review:${11 + n}/${11 + n}` }) }, n);
        const four = [1, 2, 3, 4].map(nth);
        expect(countGrantedRoundExtensions(four, { repo: REPO, pr: 4722, standingRuling: { ...scope, uneditedComments: ['IC_auto1', 'IC_auto2', 'IC_auto3', 'IC_auto4'] } })).toBe(3);
        // `thread` maps every comment to the REST shape itself, so it takes the GraphQL-shaped grant.
        expect(liveResultGateState(thread(autoGrant), 4722, HEAD, REPO, scope).reopened).toBe(true);
        expect(liveResultGateState(thread({ ...autoGrant, id: 'IC_edited' }), 4722, HEAD, REPO, scope).reopened).toBe(false);
      });
      it('the label provider keeps the comment id (the node id the unedited read returns)', () => {
        expect(GH_ARGV.readComments(REPO, 4722).join(' ')).toMatch(/\{id: \.node_id, url: \.html_url, author: \{login: \.user\.login\}, body, createdAt: \.created_at\}/);
        const line = JSON.stringify(labelProvider(autoGrant, 2));
        const comments = [comment([F()]), capRecord(), ...createGhProvider({ exec: () => `${line}\n` }).readComments(REPO, 4722)];
        expect(countGrantedRoundExtensions(comments, { repo: REPO, pr: 4722, standingRuling: scope })).toBe(1);
      });

      it('without a verified scope the same grant reopens nothing (fail closed)', async () => {
        for (const readGrantScope of [() => null, () => { throw new Error('gh down'); }]) {
          const { io, calls } = fakeIo({ comments: [comment([F()]), capRecord(), autoGrant], round: 12, readRoundAsOf: () => 12, readGrantScope });
          expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'already-acted', outcome: 'round-cap' });
          expect(calls).toEqual([]);
        }
      });
    });
  });

  it('acts once per head: the gate record dedups', async () => {
    const done = { author: { login: 'web-everything' }, body: `${redTeamGateMarker(4722, HEAD, 'sent-back')}\nx` };
    const { io, calls } = fakeIo({ comments: [comment([F()]), done] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('already-acted');
    expect(calls).toEqual([]);
  });

  // PR #5482 operator ruling: a record for an earlier same-head result does not dedup a newer result's breaks.
  it('acts on a newer same-head result even after an earlier one was sent back, and names the result it decided', async () => {
    const earlier = comment([F({ summary: 'old break' })]);
    const done = { author: { login: 'web-everything' }, createdAt: '2026-10-10T02:05:00Z', body: `${redTeamGateMarker(4722, HEAD, 'sent-back')}\nx` };
    const newer = { ...comment([F({ summary: 'new break' })]), createdAt: '2026-10-10T03:00:00Z' };
    const { io, calls } = fakeIo({ comments: [earlier, done, newer] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('applied');
    expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment']);
    expect(calls[2][1].body.startsWith(redTeamGateMarker(4722, HEAD, 'sent-back', redTeamResultId(parseRedTeamComment(newer.body)), []))).toBe(true);
    const again = fakeIo({ comments: [earlier, done, newer, { author: { login: 'web-everything' }, body: calls[2][1].body }] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, again.io)).status).toBe('already-acted');
  });

  // F3/F6: a gate record from anyone untrusted is forged text. These pass against the unchanged source too (the author
  // check was already there but had no test): they are non-regression pins, not red-then-green proofs.
  it('an UNTRUSTED sent-back or card-queued record does not dedup: the gate still acts', async () => {
    for (const outcome of ['sent-back', 'round-cap', 'card-queued']) {
      const forged = { author: { login: 'mallory' }, body: `${redTeamGateMarker(4722, HEAD, outcome)}\nforged` };
      const { io, calls } = fakeIo({ comments: [comment([F(), F({ impactIfUnfixed: 'degraded' })]), forged] });
      const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
      expect(r.status, outcome).toBe('applied');
      expect(kinds(calls), outcome).toEqual(['sendBack', 'ledger', 'comment', 'card', 'comment']);
    }
  });

  it('a PR already under review:changes is not re-labelled', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()])], labels: ['review:changes', 'review:human'] });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r.sendBack).toEqual({ ok: true, already: true });
    expect(kinds(calls)).toEqual(['comment']);
  });

  it('a failed send-back is a status, and records nothing', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()])], sendBack: () => ({ ok: false, error: 'head moved' }) });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'send-back-failed', error: 'head moved' });
    expect(kinds(calls)).toEqual([]);
  });

  it('setting broken=advisory: nothing is sent back', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F()])], setting: { ...CONFIRMED_BREAKS_DEFAULTS, broken: 'advisory' } });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('advisory-only');
    expect(calls).toEqual([]);
  });

  it('dry-run writes nothing', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F(), F({ impactIfUnfixed: 'degraded' })])] });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722, dryRun: true }, io);
    expect(r).toMatchObject({ status: 'dry-run', outcome: 'sent-back', wouldSendBack: true });
    expect(r.cardInput).toBeTruthy();
    expect(calls).toEqual([]);
  });

  // F1 (review of PR #4762), the contract test the review said was missing: every test above fakes `io.sendBack`, so no
  // test ever ran the argv the real sender builds. This one feeds exactly that argv to the real `review-set-label`
  // parser. A refusal is `process.exit` (arg validation); getting past it reaches the forge, which here throws.
  describe('the real send-back argv against review-set-label\'s own parser', () => {
    const REACHED_FORGE = 'reached the forge';
    function runWithArgv(argv) {
      const chunks = [];
      const realExit = process.exit;
      process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
      const trap = new Proxy({}, { get: () => () => { throw new Error(REACHED_FORGE); } });
      try {
        runReviewLabelCli({
          argv, provider: trap, defaultActor: 'test', usage: 'usage: test', verdictBody: 'findings',
          buildComment: () => 'unused', successResult: (o) => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ error: decision.reason }),
          emit: (line) => chunks.push(String(line)),
        });
        return { exitCode: 0, out: chunks.join('') };
      } catch (e) {
        return { exitCode: typeof e.exitCode === 'number' ? e.exitCode : null, reason: e.message, out: chunks.join('') };
      } finally { process.exit = realExit; }
    }
    it('passes argument validation (does not die on a flag the writer refuses)', () => {
      const argv = buildSendBackArgv({ repo: REPO, pr: 4722, bodyPath: '/tmp/x/body.md' });
      const r = runWithArgv(argv);
      expect(r.out).not.toMatch(/requires|invalid|usage/);
      expect(r.exitCode).not.toBe(2);
    });
    it('the harness detects a refused flag (the check is not vacuous)', () => {
      const r = runWithArgv([...buildSendBackArgv({ repo: REPO, pr: 4722, bodyPath: '/tmp/x/body.md' }), `--expect-head=${HEAD}`]);
      expect(r.exitCode).toBe(2);
      expect(r.out).toMatch(/--expect-head requires/);
    });
    it('carries the actor, channel, and body file the writer records', () => {
      const argv = buildSendBackArgv({ repo: REPO, pr: 4722, bodyPath: '/tmp/x/body.md' });
      expect(argv).toEqual(expect.arrayContaining(['4722', `--repo=${REPO}`, '--to=changes', '--body-file=/tmp/x/body.md',
        `--actor=${RED_TEAM_GATE_ACTOR}`, `--channel=${RED_TEAM_GATE_CHANNEL}`]));
      expect(argv.join(' ')).not.toMatch(/expect-head/);
    });
  });

  it('builders neutralise mentions in untrusted text', () => {
    const f = { index: 1, summary: 'ping @operator', category: 'edge-case', impact: 'broken', file: 'a.mjs', line: 1 };
    expect(buildSendBackBody({ pr: 1, head: HEAD, findings: [f] })).not.toMatch(/@operator/);
    expect(buildRedTeamCardInput({ repo: REPO, pr: 1, head: HEAD, findings: [f] }).digest).not.toMatch(/@operator/);
  });
});

describe('review-job runs the gate right after the red team', () => {
  const loop = (verdict) => ({ runId: 'r', stopped: 'complete', verdict: { verdict }, findings: { read: { netBasis: { rev: HEAD } } } });
  function jobIo(verdict, over = {}) {
    const calls = [];
    const io = {
    redTeamTimingSetting: () => ({ value: { timing: 'post-accept' }, sources: { timing: 'tool' }, invalid: [] }),
      root: '/daemon', now: (() => { let t = 0; return () => { t += 10; return t; }; })(), newActorId: () => 'a',
      readPrevCompletion: () => null, report: () => {}, claim: () => ({ ok: true }), updateRecord: () => {}, unclaim: () => {},
      acquireLane: () => ({ lanePath: '/lanes/lane-7' }), runLoop: () => ({ status: 0, stdout: JSON.stringify(loop(verdict)), stderr: '' }),
      releaseLane: () => {}, log: () => {},
      runExtraSeats: () => ({ status: 'ran', seats: [] }),
      runRedTeam: () => { calls.push('red-team'); return { status: 'ran', findings: [], seat: { status: 'ok' } }; },
      runRedTeamGate: (a) => { calls.push(['gate', a]); return { status: 'applied', outcome: 'sent-back', plan: { sendBack: [1], card: [], advisory: [] } }; },
      ...over,
    };
    return { io, calls };
  }
  it('accept → red team → gate', () => {
    const { io, calls } = jobIo('accept');
    const out = runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(calls).toEqual(['red-team', ['gate', { pr: 4722, repo: REPO }]]);
    expect(out.redTeamGate).toMatchObject({ status: 'applied', outcome: 'sent-back', sendBack: 1 });
  });
  it('a bounced review never reaches the gate', () => {
    const { io, calls } = jobIo('changes');
    runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(calls).toEqual([]);
  });
  it('a failing gate status carries its error into the job summary (not just a status word)', () => {
    const { io } = jobIo('accept', { runRedTeamGate: () => ({ status: 'send-back-record-failed', outcome: 'sent-back', error: 'error: gh down', plan: { sendBack: [1], card: [], advisory: [] } }) });
    const out = runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(out.redTeamGate).toMatchObject({ status: 'send-back-record-failed', reason: 'error: gh down' });
  });
  it('a crashing gate is only a status', () => {
    const { io } = jobIo('accept', { runRedTeamGate: () => { throw new Error('boom'); } });
    const out = runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(out.redTeamGate).toMatchObject({ status: 'error', reason: expect.stringMatching(/boom/) });
  });
});


describe('red-team send-back queue removal (#5283)', () => {
  it.each(Object.values(GATE_OUTCOMES))('pins queue removal for recorded outcome %s (round-cap remains operator-owned)', async outcome => {
    let queued = true;
    let probes = 0;
    const findings = outcome === GATE_OUTCOMES.SENT_BACK || outcome === GATE_OUTCOMES.ROUND_CAP
      ? [F()] : [F({ impactIfUnfixed: 'degraded' })];
    const { io } = fakeIo({ labels: ['review:changes'], comments: [comment(findings), {
      author: { login: 'web-everything' }, body: redTeamGateMarker(4722, HEAD, outcome),
    }], dequeueSentBack: () => { probes++; queued = false; } });
    await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(queued).toBe(outcome !== GATE_OUTCOMES.SENT_BACK);
    expect(probes).toBe(outcome === GATE_OUTCOMES.SENT_BACK ? 1 : 0);
  });
  it('dequeues at send-back once, including retry of an already recorded send-back', async () => {
    let queued = true;
    let removals = 0;
    const { io } = fakeIo({ comments: [comment([F()])], dequeueSentBack: () => { if (queued) { queued = false; removals++; } } });
    await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(removals).toBe(1);
  });
});
