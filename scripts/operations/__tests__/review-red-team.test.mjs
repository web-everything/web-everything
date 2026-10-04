/**
 * x00g3tt — THE POST-ACCEPT RED TEAM: after Claude's review ACCEPTS, one non-Claude seat tries to break the change;
 * Claude re-checks its claims; a confirmed break is a miss for the accepting seat and the builder. No real codex,
 * agy, claude, git or GitHub process: every effect is a fake.
 */
import { describe, it, expect } from 'vitest';

import {
  runRedTeam, redTeamEnabled, redTeamMarker, redTeamCommentPosted, redTeamAlreadyRan, resolveBuilder,
  buildRedTeamTask, buildRecheckRequest, applyRecheck, buildMissRows, renderRedTeamComment, replayPayload,
  reserveSeatCalls, RED_TEAM_ENV, EXTRA_SEATS_ENV, DAILY_CAP_ENV, PROVIDER_CAP_ENV, RED_TEAM_SEAT, RED_TEAM_MODELS,
  RED_TEAM_MISS_DISPATCH_KIND, ACCEPTING_SEAT_MODEL, DEFAULT_PROBE_INTERVAL_MS,
} from '../review-extra-seats.mjs';
import { runReviewJob, summarizeRedTeam } from '../review-job.mjs';
import { JUDGE_MODEL } from '../review-pr.mjs';
import { REVIEW_SEAT_DISPATCH_KIND } from '../../lib/provider-routing.mjs';
import { validateScorecard } from '../../conveyor/run-scorecard-store.mjs';
import { buildDelegationMarker } from '../../lib/delegation-marker.mjs';

const REPO = 'web-everything/web-everything';
const NOW = Date.parse('2026-09-26T15:00:00Z');
const REV = 'a'.repeat(40);

const payload = (verdict, body = 'Claims: adds a guard.') => ({
  runId: 'review-pr-1', stopped: 'complete', verdict: { verdict },
  findings: {
    read: {
      title: 'fix the thing', body, diffText: 'diff --git a/x.mjs b/x.mjs\n+export const f = (n) => 10 / n;\n',
      netChangedFiles: ['x.mjs'], netBasis: { base: 'b'.repeat(40), rev: REV },
    },
    judge: { findings: [] },
    judgeSecurity: { findings: [] },
  },
});

const BREAK = { summary: 'f(0) returns Infinity instead of rejecting the zero divisor', category: 'failing-input', file: 'x.mjs', line: 1, impactIfUnfixed: 'broken', failure_scenario: 'f(0)' };
const HOLE = { summary: 'the guard trusts a caller-supplied path, so ../ escapes the checkout', category: 'security', file: 'x.mjs', line: 1, impactIfUnfixed: 'unrecoverable', failure_scenario: 'f("../../etc")' };
const answer = (findings) => `Tried hard.\n\n\`\`\`json\n${JSON.stringify({ lenses: { 'red-team': { verdict: findings.length ? 'changes' : 'accept', findings } } })}\n\`\`\``;
/** A direct-task report in whichever provider's shape the seat was routed to (codex: lastMessage; gemini: events). */
const report = (provider, text) => (provider === 'codex' ? { lastMessage: text, exitCode: 0 } : { events: { finalResponse: text } });
const seatSays = (findings) => async ({ provider }) => ({ report: report(provider, answer(findings)) });

function fakeIo(over = {}) {
  const calls = [];
  const rows = [];
  const trials = [];
  const ledgerBox = {};
  const io = {
    now: () => NOW,
    newId: (() => { let n = 0; return () => `call-${++n}`; })(),
    log: (l) => calls.push(['log', l]),
    readRecords: () => [],
    reserveCalls: ({ provider, want, dailyCap, now }) => {
      const r = reserveSeatCalls({ ledger: ledgerBox[provider] ?? null, records: io.readRecords(), want, dailyCap, now, newId: io.newId, provider });
      ledgerBox[provider] = r.ledger;
      calls.push(['reserve', provider, want, r.callIds.length]);
      return r;
    },
    append: (row) => {
      const v = validateScorecard({ v: 1, scoredAt: new Date(NOW).toISOString(), ...row });
      if (!v.ok) throw new Error(v.errors.join('; '));
      rows.push(row);
    },
    cliAvailable: () => true,
    makeScratch: (o) => { calls.push(['scratch', o]); return '/tmp/x00g3tt-scratch'; },
    removeScratch: (d) => calls.push(['rm', d]),
    writeFile: (p, t) => calls.push(['write', p, t]),
    readHeadMessage: () => 'fix: guard\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\n',
    runSeat: async (o) => { calls.push(['seat', o]); return { report: report(o.provider, answer([BREAK])) }; },
    runRecheck: async (o) => { calls.push(['recheck', o]); return { checks: [{ index: 0, confirmed: true, reason: 'the diff divides by n with no zero check' }] }; },
    logTrial: (row) => { trials.push(row); return row; },
    listComments: () => { calls.push(['list']); return []; },
    postComment: (o) => calls.push(['post', o]),
    ...over,
  };
  return { io, calls, rows, trials };
}

describe('x00g3tt — the red team fires on ACCEPT only', () => {
  it('an accepted PR gets exactly one red-team dispatch to a non-Claude provider', async () => {
    const { io, calls } = fakeIo();
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    const seats = calls.filter((c) => c[0] === 'seat');
    expect(seats).toHaveLength(1);
    expect(['codex', 'agy-claude', 'agy-gemini']).toContain(seats[0][1].provider);
    expect(seats[0][1]).toMatchObject({ model: RED_TEAM_MODELS[seats[0][1].provider].model, effort: 'high' });
    expect(r.status).toBe('ran');
  });

  it('card x6ov12s — a held-but-probe-due codex is still admitted to the red-team pass (both call sites wired)', async () => {
    // Same live-incident shape as review-extra-seats.test.mjs's runExtraSeats case: codex's last row would
    // still hold under the plain `quotaHold` reader (99% gauge, resetsAt days out); this call site must read
    // it through `quotaHoldOrProbe` too, so a full probe interval past that row's own `scoredAt` admits it.
    const heldRow = {
      dispatchKind: 'review-seat', provider: 'codex', status: 'ok',
      quotaUsedPercent: 99, quotaResetsAt: '2026-10-03T17:11:00-04:00', scoredAt: '2026-09-28T22:31:00-04:00',
    };
    const now = Date.parse(heldRow.scoredAt) + DEFAULT_PROBE_INTERVAL_MS;
    const { io, calls } = fakeIo({
      now: () => now,
      readRecords: () => [heldRow],
      // Only codex is a real candidate here — the other two providers' own CLI is unavailable, so this run's
      // ONE dispatch can only reach codex, and only if the red-team's own quotaHold(...) call site was swapped
      // to quotaHoldOrProbe(...) too. Left un-swapped (soak break), codex reads as held and NOTHING is available.
      cliAvailable: (p) => p === 'codex',
    });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    expect(r.status).toBe('ran');
    const seats = calls.filter((c) => c[0] === 'seat');
    expect(seats).toHaveLength(1);
    expect(seats[0][1].provider).toBe('codex');
  });

  it.each(['changes', 'needs-human', null])('a %s verdict gets NO red-team dispatch', async (verdict) => {
    const { io, calls } = fakeIo();
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload(verdict), env: {} }, io);
    expect(r.status).toBe('not-owed');
    expect(calls.some((c) => ['seat', 'reserve', 'scratch'].includes(c[0]))).toBe(false);
  });

  it('its own kill switch, and the added-seats one, each turn it off before anything is read', async () => {
    expect(redTeamEnabled({})).toBe(true);
    expect(redTeamEnabled({ [RED_TEAM_ENV]: '0' })).toBe(false);
    expect(redTeamEnabled({ [EXTRA_SEATS_ENV]: 'off' })).toBe(false);
    const { io, calls } = fakeIo({ readRecords: () => { throw new Error('must not read'); } });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: { [RED_TEAM_ENV]: '0' } }, io);
    expect(r.status).toBe('disabled');
    expect(calls).toEqual([]);
  });

  it('shares the added seats\' PER-PROVIDER cap: with every provider\'s day spent it launches nothing', async () => {
    const spentRow = (provider) => ({ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider, callId: `old-${provider}`, scoredAt: new Date(NOW).toISOString(), status: 'ok' });
    const spent = ['codex', 'agy-claude', 'agy-gemini'].map(spentRow);
    const { io, calls } = fakeIo({ readRecords: () => spent });
    const env = { [PROVIDER_CAP_ENV.codex]: '1', [PROVIDER_CAP_ENV['agy-claude']]: '1', [PROVIDER_CAP_ENV['agy-gemini']]: '1' };
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env }, io);
    expect(r).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/daily-cap/) });
    expect(calls.some((c) => c[0] === 'seat')).toBe(false);
  });

  it('card xn2wf9t — codex AT ITS OWN CAP still runs the red team, falling back to an antigravity backend (never "no seat")', async () => {
    const spent = [{ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider: 'codex', callId: 'old-1', scoredAt: new Date(NOW).toISOString(), status: 'ok' }];
    const { io, calls } = fakeIo({ readRecords: () => spent });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: { [PROVIDER_CAP_ENV.codex]: '1' } }, io);
    expect(r.status).toBe('ran');
    expect(['agy-claude', 'agy-gemini']).toContain(r.provider);
    const seats = calls.filter((c) => c[0] === 'seat');
    expect(seats).toHaveLength(1);
    expect(seats[0][1].provider).not.toBe('codex');
  });

  it('never runs twice for the same head once a clean row exists', async () => {
    const prior = [{ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, seat: 'red-team', pr: 5, rev: REV, status: 'ok' }];
    expect(redTeamAlreadyRan(prior, 5, REV)).toBe(true);
    expect(redTeamAlreadyRan(prior, 5, 'c'.repeat(40))).toBe(false);
    // The pass finished (its comment is up), so nothing is owed. When the comment is missing, see the resume tests.
    const { io, calls } = fakeIo({ readRecords: () => prior, listComments: () => [{ body: redTeamMarker(5, REV), author: { login: 'web-everything' } }] });
    expect((await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io)).status).toBe('already-ran');
    expect(calls.some((c) => c[0] === 'seat' || c[0] === 'post')).toBe(false);
  });

  it('skips a provider under a quota hold and a missing CLI, and says why when none is left', async () => {
    const { io } = fakeIo({ cliAvailable: () => false });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    expect(r).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/CLI not found/) });
  });
});

describe('x00g3tt — evidence, Claude re-check and confirmed misses', () => {
  it('writes the red-team seat row plus one miss row per accepting seat and one for the builder', async () => {
    const { io, rows } = fakeIo();
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    expect(r).toMatchObject({ confirmedMissCount: 1, foldedVerdict: 'changes', recheckStatus: 'ok', rowsWritten: 3 });
    const [seat, ...misses] = rows;
    expect(seat).toMatchObject({
      dispatchKind: REVIEW_SEAT_DISPATCH_KIND, seat: 'red-team', lens: 'red-team', taskType: 'review-lens:red-team',
      rev: REV, status: 'ok', seatVerdict: 'changes', confirmedMissCount: 1, foldedVerdict: 'changes', claudeVerdict: 'accept',
    });
    expect(seat.findings[0]).toMatchObject({ file: 'x.mjs', category: 'failing-input', confirmedByRecheck: true });
    expect(misses.map((m) => [m.dispatchKind, m.missRole, m.provider, m.model])).toEqual([
      [RED_TEAM_MISS_DISPATCH_KIND, 'accepting-review', 'claude', ACCEPTING_SEAT_MODEL],
      [RED_TEAM_MISS_DISPATCH_KIND, 'builder', 'claude', 'claude-opus-5.5'],
    ]);
    expect(misses[0]).toMatchObject({ claudeSeat: 'judge', taskType: 'red-team-miss:review-lens:correctness', outcome: null });
    // #4034 follow-up (card 4034b) — every row, seat AND both misses, stamps the loop's own net changed files.
    for (const r of rows) expect(r.changedFiles).toEqual(['x.mjs']);
  });

  it('the accepting-seat model matches review-pr\'s mandatory seats', () => {
    expect(ACCEPTING_SEAT_MODEL).toBe(JUDGE_MODEL);
  });

  it('a break Claude does NOT confirm records no miss, and the accept stands', async () => {
    const { io, rows, trials } = fakeIo({ runRecheck: async () => ({ checks: [{ index: 0, confirmed: false, reason: 'n is validated upstream' }] }) });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    expect(r).toMatchObject({ confirmedMissCount: 0, foldedVerdict: 'accept' });
    expect(rows).toHaveLength(1);
    expect(trials).toEqual([]);
  });

  it('a crashed re-check confirms nothing (a miss is never inferred)', async () => {
    const { io, rows } = fakeIo({ runRecheck: async () => { throw new Error('claude not logged in'); } });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    expect(r.recheckStatus).toMatch(/^error: .*logged in/);
    expect(r.confirmedMissCount).toBe(0);
    expect(rows.filter((x) => x.dispatchKind === RED_TEAM_MISS_DISPATCH_KIND)).toEqual([]);
  });

  it('a security break counts against the security seat', async () => {
    const { io, rows } = fakeIo({
      runSeat: seatSays([BREAK, HOLE]),
      runRecheck: async () => ({ checks: [{ index: 0, confirmed: true, reason: 'y' }, { index: 1, confirmed: true, reason: 'y' }] }),
    });
    await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    const seats = rows.filter((x) => x.missRole === 'accepting-review').map((x) => [x.claudeSeat, x.missCount]);
    expect(seats).toEqual([['judge', 1], ['judgeSecurity', 1]]);
  });

  it('a clean pass skips the re-check and writes one row with the accept standing', async () => {
    const { io, rows, calls } = fakeIo({ runSeat: seatSays([]) });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    expect(r).toMatchObject({ foldedVerdict: 'accept', recheckStatus: 'not-needed' });
    expect(calls.some((c) => c[0] === 'recheck')).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it('a timed-out red team records needs-human, posts nothing, confirms nothing', async () => {
    const { io, rows, calls } = fakeIo({ runSeat: async () => ({ report: null, timedOut: true }) });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    expect(r).toMatchObject({ foldedVerdict: 'needs-human', comment: { status: 'not-posted' } });
    expect(rows[0].status).toBe('timeout');
    expect(calls.some((c) => c[0] === 'post')).toBe(false);
  });

  it('a DELEGATED builder\'s confirmed miss also lands as its delegation trial (reworked, informative), once per PR', async () => {
    const body = `Claims: adds a guard.\n\n${buildDelegationMarker({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix' })}`;
    const { io, trials, rows } = fakeIo();
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept', body), env: {} }, io);
    expect(r.delegationTrial).toBe('logged');
    expect(trials[0]).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix', outcome: 'reworked', informative: true, verifiedBy: 'independent-claude', pr: 5 });
    // #4034 follow-up (card 4034b) — the builder's REWORKED delegation trial is exactly the row #4034's
    // critical-work rule reads for a miss; it must carry scope, not just the evidence rows.
    expect(trials[0].changedFiles).toEqual(['x.mjs']);
    expect(rows.at(-1)).toMatchObject({ missRole: 'builder', provider: 'codex', model: 'gpt-6-astra', taskType: 'red-team-miss:builder:bugfix' });
    const again = fakeIo({ readRecords: () => [{ dispatchKind: 'session-delegation', pr: 5, outcome: 'reworked' }] });
    expect((await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept', body), env: {} }, again.io)).delegationTrial).toBe('already-logged');
    expect(again.trials).toEqual([]);
  });

  it('resolveBuilder: marker, then the Claude co-author trailer, then unknown', () => {
    expect(resolveBuilder({ body: buildDelegationMarker({ provider: 'gemini', model: 'g3', taskType: 'doc-fix' }) })).toMatchObject({ provider: 'gemini', delegated: true });
    expect(resolveBuilder({ headMessage: 'x\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>' })).toMatchObject({ provider: 'claude', model: 'claude-sonnet-4.6' });
    expect(resolveBuilder({})).toMatchObject({ provider: 'unknown', source: 'none' });
  });

  it('applyRecheck fails closed on missing or malformed answers', () => {
    const out = applyRecheck([BREAK, HOLE], { checks: [{ index: 1, confirmed: 'yes' }] });
    expect(out.map((f) => f.confirmedByRecheck)).toEqual([false, false]);
  });

  it('miss rows are valid scorecard rows', () => {
    const rows = buildMissRows({ pr: 5, repo: REPO, rev: REV, runCallId: 'c', redTeamProvider: 'codex', redTeamModel: 'm', builder: { provider: 'claude', model: 'claude-opus-5.5', taskType: null, source: 'co-authored-by' }, confirmed: [BREAK] });
    for (const r of rows) expect(validateScorecard(r).ok).toBe(true);
    expect(buildMissRows({ pr: 5, repo: REPO, rev: REV, confirmed: [], builder: {} })).toEqual([]);
  });

  it('miss rows stamp changedFiles when the caller supplies it, and null (never []) when it does not (#4034 follow-up)', () => {
    const withFiles = buildMissRows({ pr: 5, repo: REPO, rev: REV, runCallId: 'c', redTeamProvider: 'codex', redTeamModel: 'm', builder: { provider: 'claude', model: 'claude-opus-5.5', taskType: null, source: 'co-authored-by' }, confirmed: [BREAK], changedFiles: ['x.mjs'] });
    for (const r of withFiles) expect(r.changedFiles).toEqual(['x.mjs']);
    const withoutFiles = buildMissRows({ pr: 5, repo: REPO, rev: REV, runCallId: 'c', redTeamProvider: 'codex', redTeamModel: 'm', builder: { provider: 'claude', model: 'claude-opus-5.5', taskType: null, source: 'co-authored-by' }, confirmed: [BREAK] });
    for (const r of withoutFiles) expect(r.changedFiles).toBeNull();
  });

  it('resuming a red-team pass (a prior clean row already exists) carries the prior row\'s changedFiles forward, not a fresh diff', async () => {
    const prior = {
      dispatchKind: REVIEW_SEAT_DISPATCH_KIND, seat: RED_TEAM_SEAT.seat, status: 'ok',
      provider: 'agy-gemini', model: RED_TEAM_MODELS['agy-gemini'].model, callId: 'call-1', rev: REV,
      pr: 5, findings: [{ ...BREAK, confirmedByRecheck: true }], builder: { provider: 'claude', model: 'claude-opus-5.5', source: 'co-authored-by' },
      recheckStatus: 'ok', foldedVerdict: 'changes', changedFiles: ['prior/scope.mjs'],
    };
    const { io, rows } = fakeIo({ readRecords: () => [prior] });
    await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    const misses = rows.filter((r) => r.dispatchKind === RED_TEAM_MISS_DISPATCH_KIND);
    expect(misses.length).toBeGreaterThan(0);
    for (const m of misses) expect(m.changedFiles).toEqual(['prior/scope.mjs']);
  });
});

describe('x00g3tt — the ONE advisory comment, deduped by a trusted marker', () => {
  it('posts once, starting with the marker, and reports advisory status', async () => {
    const { io, calls } = fakeIo();
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    const posts = calls.filter((c) => c[0] === 'post');
    expect(posts).toHaveLength(1);
    expect(posts[0][1].body.startsWith(redTeamMarker(5, REV))).toBe(true);
    expect(posts[0][1].body).toMatch(/Advisory only/);
    expect(posts[0][1].body).toMatch(/\[\*\*confirmed\*\*\]/);
    expect(r.comment.status).toBe('posted');
  });

  it('a trusted marker already there dedups; a forged one from another login does not', async () => {
    const body = `${redTeamMarker(5, REV)}\nold`;
    expect(redTeamCommentPosted([{ body, author: { login: 'web-everything' } }], 5, REV)).toBe(true);
    expect(redTeamCommentPosted([{ body, author: { login: 'mallory' } }], 5, REV)).toBe(false);
    expect(redTeamCommentPosted([body], 5, REV)).toBe(false);
    const { io, calls } = fakeIo({ listComments: () => [{ body, author: { login: 'web-everything' } }] });
    expect((await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io)).comment.status).toBe('deduped');
    expect(calls.some((c) => c[0] === 'post')).toBe(false);
  });

  it('replay (post:false) renders the comment and never lists or posts', async () => {
    const { io, calls } = fakeIo();
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {}, post: false }, io);
    expect(r.comment).toMatchObject({ status: 'not-posted', body: expect.stringContaining('Post-accept red team') });
    expect(calls.some((c) => c[0] === 'post' || c[0] === 'list')).toBe(false);
  });

  it('a clean pass says so', () => {
    const text = renderRedTeamComment({ pr: 5, rev: REV, provider: 'codex', model: 'm', findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' });
    expect(text).toMatch(/no break found/);
  });
});

describe('x00g3tt — a clean seat row never strands an unfinished effect (PR #2735 review)', () => {
  const DELEGATED = `Claims: adds a guard.\n\n${buildDelegationMarker({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix' })}`;
  const run = (io, over = {}) => runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {}, ...over }, io);
  const trustedMarker = () => [{ body: `${redTeamMarker(5, REV)}\nold`, author: { login: 'web-everything' } }];

  it('a failed comment post is retried on the next run, without re-running the model or spending a call', async () => {
    const first = fakeIo({ postComment: () => { throw new Error('gh: network unreachable'); } });
    expect((await run(first.io)).comment.status).toBe('error');
    const posted = [];
    const again = fakeIo({ readRecords: () => first.rows, postComment: (o) => posted.push(o) });
    const r = await run(again.io);
    expect(r.status).toBe('resumed');
    expect(r.comment.status).toBe('posted');
    expect(posted).toHaveLength(1);
    expect(posted[0].body.startsWith(redTeamMarker(5, REV))).toBe(true);
    expect(posted[0].body).toMatch(/\[\*\*confirmed\*\*\]/);
    expect(posted[0].body).toMatch(/Scenario: f\(0\)/);
    expect(again.calls.some((c) => c[0] === 'seat' || c[0] === 'reserve' || c[0] === 'recheck')).toBe(false);
    expect(again.rows).toEqual([]);
  });

  it('a miss row that failed to append is written on the next run — only the missing one', async () => {
    const first = fakeIo();
    const append = first.io.append;
    first.io.append = (row) => { if (row.missRole === 'builder') throw new Error('store: EIO'); append(row); };
    const r1 = await run(first.io);
    expect(r1.rowsWritten).toBe(2);
    const again = fakeIo({ readRecords: () => first.rows, listComments: trustedMarker });
    const r = await run(again.io);
    expect(r.status).toBe('resumed');
    expect(again.rows).toHaveLength(1);
    expect(again.rows[0]).toMatchObject({ dispatchKind: RED_TEAM_MISS_DISPATCH_KIND, missRole: 'builder', provider: 'claude', model: 'claude-opus-5.5', rev: REV, redTeamCallId: r1.callId });
    expect(again.calls.some((c) => c[0] === 'seat' || c[0] === 'post')).toBe(false);
  });

  it('a delegation trial that failed to log is logged on the next run', async () => {
    const first = fakeIo({ logTrial: () => { throw new Error('store: EIO'); } });
    expect((await run(first.io, { loopPayload: payload('accept', DELEGATED) })).delegationTrial).toMatch(/^error/);
    const again = fakeIo({ readRecords: () => first.rows, listComments: trustedMarker });
    const r = await run(again.io, { loopPayload: payload('accept', DELEGATED) });
    expect(r.delegationTrial).toBe('logged');
    expect(again.trials[0]).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix', outcome: 'reworked', pr: 5 });
    expect(again.rows).toEqual([]);
  });

  it('once every effect is done a later run is already-ran and writes nothing', async () => {
    const first = fakeIo();
    await run(first.io, { loopPayload: payload('accept', DELEGATED) });
    const records = [...first.rows, { dispatchKind: 'session-delegation', pr: 5, outcome: 'reworked' }];
    const again = fakeIo({ readRecords: () => records, listComments: trustedMarker });
    expect((await run(again.io, { loopPayload: payload('accept', DELEGATED) })).status).toBe('already-ran');
    expect(again.rows).toEqual([]);
    expect(again.trials).toEqual([]);
    expect(again.calls.some((c) => c[0] === 'post' || c[0] === 'seat')).toBe(false);
  });
});

describe('x00g3tt — the replay never writes the shared store (PR #2735 review)', () => {
  const DELEGATED = `Claims.\n\n${buildDelegationMarker({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix' })}`;

  it('record:false writes no evidence row and logs no delegation trial, even on a confirmed break', async () => {
    const { io, rows, trials } = fakeIo();
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept', DELEGATED), env: {}, post: false, record: false }, io);
    expect(r.confirmedMissCount).toBe(1);
    expect(rows).toEqual([]);
    expect(trials).toEqual([]);
    expect(r.rowsWritten).toBe(0);
    expect(r.delegationTrial).toMatch(/not recorded/);
  });

  it('a replay payload is never recorded, whatever the caller passed', async () => {
    const { io, rows, trials } = fakeIo();
    const p = replayPayload({ view: { title: 't', body: DELEGATED, headRefOid: REV, files: [] }, diffText: 'diff --git a/x b/x\n+x\n' });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: p, env: {}, post: false }, io);
    expect(r.status).toBe('ran');
    expect(rows).toEqual([]);
    expect(trials).toEqual([]);
  });

  it('a replay does not mark the head as already-ran for the real post-accept run', async () => {
    const replay = fakeIo();
    await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {}, post: false, record: false }, replay.io);
    const real = fakeIo({ readRecords: () => replay.rows });
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, real.io);
    expect(r.status).toBe('ran');
    expect(real.calls.some((c) => c[0] === 'post')).toBe(true);
  });
});

describe('x00g3tt — briefs and replay input', () => {
  it('the red-team brief asks to BREAK an accepted change and names the answer key', () => {
    const t = buildRedTeamTask({ pr: 5, repo: REPO, title: 't', dir: '/d', diffFile: '/d/net.diff', bodyFile: '/d/b.md', changedFiles: ['x.mjs'], claudeFindings: [{ summary: 'known one' }] });
    expect(t).toMatch(/RED TEAM/);
    expect(t).toMatch(/ALREADY ACCEPTED/);
    expect(t).toMatch(/known one/);
    expect(t).toContain(`"${RED_TEAM_SEAT.key}"`);
    const inline = buildRedTeamTask({ pr: 5, repo: REPO, title: 't', inline: { diffText: 'DIFFBODY', body: 'B' } });
    expect(inline).toMatch(/cannot run commands/);
    expect(inline).toContain('DIFFBODY');
  });

  it('the re-check request carries every claim and the diff', () => {
    const q = buildRecheckRequest({ pr: 5, repo: REPO, title: 't', diffText: 'THE-DIFF', findings: [BREAK, HOLE] });
    expect(q.input).toContain('[0] (failing-input)');
    expect(q.input).toContain('[1] (security)');
    expect(q.input).toContain('THE-DIFF');
    expect(q.mandate).toMatch(/untrusted/);
  });

  it('replayPayload is an accept with the pinned head', () => {
    const p = replayPayload({ view: { title: 't', body: 'b', headRefOid: REV, files: [{ path: 'x.mjs' }] }, diffText: 'd' });
    expect(p).toMatchObject({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: REV }, netChangedFiles: ['x.mjs'] } } });
  });
});

describe('x00g3tt — review-job: the red team is the post-accept hook, after the seats', () => {
  function jobIo(loop, over = {}) {
    const calls = [];
    const io = {
      root: '/daemon',
      now: (() => { let t = 1_000; return () => { t += 10; return t; }; })(),
      newActorId: () => 'actor',
      readPrevCompletion: () => null,
      report: (f) => calls.push(['report', f.status]),
      claim: () => ({ ok: true }),
      updateRecord: () => {},
      unclaim: () => calls.push(['unclaim']),
      acquireLane: () => ({ lanePath: '/lanes/lane-7' }),
      runLoop: () => ({ status: 0, stdout: JSON.stringify(loop), stderr: '' }),
      releaseLane: () => calls.push(['release']),
      log: () => {},
      runExtraSeats: () => { calls.push(['seats']); return { status: 'ran', seats: [] }; },
      runRedTeam: (input) => { calls.push(['red-team', input]); return { status: 'ran', provider: 'codex', model: 'm', seat: { status: 'ok' }, findings: [{ summary: 's', confirmedByRecheck: true }], confirmedMissCount: 1, foldedVerdict: 'changes', recheckStatus: 'ok', comment: { status: 'posted' }, rowsWritten: 3 }; },
      ...over,
    };
    return { io, calls };
  }

  it('an accepted review runs the red team last, after release and the seats, and never changes the outcome', () => {
    const { io, calls } = jobIo(payload('accept'));
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(calls.map((c) => c[0])).toEqual(['report', 'report', 'release', 'unclaim', 'seats', 'red-team']);
    expect(calls.at(-1)[1]).toMatchObject({ pr: 10, repo: REPO, lanePath: '/lanes/lane-7' });
    expect(out).toMatchObject({ outcome: 'auto-cleared', verdict: 'accept', redTeam: { status: 'ran', confirmedMissCount: 1, comment: 'posted' } });
  });

  it('a bounced review never reaches the red team', () => {
    const { io, calls } = jobIo(payload('changes'));
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(calls.some((c) => c[0] === 'red-team')).toBe(false);
    expect(out.redTeam).toBeUndefined();
    expect(out.outcome).toBe('bounced');
  });

  it('a crashing red team is only a status', () => {
    const { io } = jobIo(payload('accept'), { runRedTeam: () => { throw new Error('boom'); } });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(out.outcome).toBe('auto-cleared');
    expect(out.redTeam).toMatchObject({ status: 'error', reason: expect.stringMatching(/boom/) });
  });

  it('summarizeRedTeam keeps the essentials', () => {
    expect(summarizeRedTeam({ status: 'skipped', reason: 'daily-cap' })).toEqual({ status: 'skipped', reason: 'daily-cap' });
  });
});
