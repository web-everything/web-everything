/**
 * Card 6212 — `redTeam.timing=round1`: the red team runs in the SAME round as the panel. A `changes` review finishes
 * the speculative pass (its confirmed breaks join that send-back), an accept reuses it even when the jurors raised
 * findings, a break already ruled on an earlier head with unchanged cited lines is not raised again, and the fixer
 * waits (bounded) for an in-flight pass. `post-accept` is the old order exactly. No real process, model, git or GitHub
 * call: every effect is a fake.
 */
import { describe, it, expect } from 'vitest';

import { runReviewJob } from '../review-job.mjs';
import { speculateRedTeam, finishSpeculativeRedTeam, runRedTeam, renderRedTeamComment, reserveSeatCalls, redTeamOwedThisRound } from '../review-extra-seats.mjs';
import { applyRedTeamGate, buildGateComment } from '../red-team-gate-apply.mjs';
import { validateScorecard } from '../../conveyor/run-scorecard-store.mjs';
import { extractFindings } from '../../conveyor/fix-context-pack.mjs';
import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, GATE_OUTCOMES, readRedTeamDisposition, redTeamGateMarker, ruledEarlierBreaks } from '../../lib/red-team-gate.mjs';
import { redTeamEnqueueHold } from '../../lib/drain-queue-safety.mjs';
import {
  citedLinesFingerprint, decideRound1FixHold, formatRedTeamTimingLine, resolveRedTeamTiming, round1RedTeamOwedFor, sameBreak, suppressPreviouslyRuled,
} from '../../lib/red-team-timing.mjs';

const REPO = 'web-everything/web-everything';
const REV = 'a'.repeat(40);
const NOW = Date.parse('2026-10-21T20:00:00Z');
const ROUND1 = resolveRedTeamTiming({ env: { WE_RED_TEAM_TIMING: 'round1' } });
const POST_ACCEPT = resolveRedTeamTiming({ env: {} });

const read = (rev = REV) => ({
  title: 'fix the thing', body: 'Claims: adds a guard.', diffText: 'diff --git a/x.mjs b/x.mjs\n+export const f = (n) => 10 / n;\n',
  netChangedFiles: ['x.mjs'], netBasis: { base: 'b'.repeat(40), rev },
});
const payload = (verdict, r = read()) => ({
  runId: 'review-pr-1', stopped: 'complete', verdict: { verdict, loop: { outcome: 'converged' } },
  findings: { read: r, judge: { findings: [] }, judgeSecurity: { findings: [] } },
});

// ── the setting ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('redTeam.timing (policy cascade)', () => {
  it('standard is post-accept (card 6212: trial, default unchanged); env, tool and platform layers set it, each logged with its source', () => {
    expect(POST_ACCEPT.value.timing).toBe('post-accept');
    expect(POST_ACCEPT.round1).toBe(false);
    expect(formatRedTeamTimingLine(POST_ACCEPT)).toContain('timing="post-accept" (standard)');
    expect(resolveRedTeamTiming({ file: { redTeam: { timing: 'round1' } } })).toMatchObject({ round1: true, sources: { timing: 'tool' } });
    expect(resolveRedTeamTiming({ platform: { timing: 'round1' } })).toMatchObject({ round1: true, sources: { timing: 'platform' } });
    // panel-seat (the card's own name) is an alias; the log shows the normalised value.
    const alias = resolveRedTeamTiming({ env: { WE_RED_TEAM_TIMING: 'panel-seat' } });
    expect(alias.round1).toBe(true);
    expect(formatRedTeamTimingLine(alias)).toContain('timing="round1" (env)');
  });

  it('the kill switch: env post-accept beats a round1 file; an invalid value keeps the lower layer and is reported', () => {
    expect(resolveRedTeamTiming({ file: { redTeam: { timing: 'round1' } }, env: { WE_RED_TEAM_TIMING: 'post-accept' } }).round1).toBe(false);
    const bad = resolveRedTeamTiming({ file: { redTeam: { timing: 'sometimes' } } });
    expect(bad.round1).toBe(false);
    expect(bad.invalid.join(' ')).toContain('sometimes');
    expect(resolveRedTeamTiming({ env: { WE_RED_TEAM_ROUND1_FIX_HOLD_MINUTES: '5' } }).value.round1FixHoldMinutes).toBe(5);
  });

  it('round 1 owes the red team only on a plain changes review', () => {
    expect(round1RedTeamOwedFor(payload('changes'))).toBe(true);
    for (const v of ['accept', 'needs-human', 'prevention-outstanding']) expect(round1RedTeamOwedFor(payload(v))).toBe(false);
    expect(round1RedTeamOwedFor(null)).toBe(false);
    expect(redTeamOwedThisRound(payload('changes'))).toBe(false);
    expect(redTeamOwedThisRound(payload('changes'), { round1: true })).toBe(true);
    expect(redTeamOwedThisRound(payload('accept'))).toBe(true);
  });
});

// ── the job ─────────────────────────────────────────────────────────────────────────────────────────────────────

const PASS = { status: 'speculated', rev: REV, callId: 'call-1', provider: 'codex', findings: [], timings: { startedAt: 0, readAt: 5, finishedAt: 50 } };
const OFF = { value: 'off', enabled: false, source: 'tool', invalid: [] };

function jobIo({ verdict = 'changes', timing = ROUND1, speculative = OFF, spec = PASS } = {}) {
  const calls = [];
  const io = {
    root: '/daemon',
    now: (() => { let t = 1_000; return () => { t += 10; return t; }; })(),
    newActorId: () => 'actor',
    readPrevCompletion: () => null,
    report: () => {},
    claim: () => ({ ok: true }),
    updateRecord: () => {},
    unclaim: () => {},
    acquireLane: () => ({ lanePath: '/lanes/lane-7' }),
    runLoop: () => { calls.push(['loop']); return { status: 0, stdout: JSON.stringify(payload(verdict)), stderr: '' }; },
    releaseLane: () => {},
    log: (l) => calls.push(['log', l]),
    runExtraSeats: () => { calls.push(['extra-seats']); return { status: 'ran', seats: [] }; },
    runRedTeam: (o) => { calls.push(['sequential', o.round1 === true, ...(o.holdStatus ? [true] : [])]); return { status: 'ran', foldedVerdict: 'accept', findings: [], comment: { status: 'posted' } }; },
    runRedTeamGate: () => { calls.push(['gate']); return { status: 'applied', outcome: 'sent-back' }; },
    redTeamStatus: (o) => calls.push([`status:${o.status}`]),
    speculativeRedTeamSetting: () => speculative,
    redTeamTimingSetting: () => timing,
    startSpeculativeRedTeam: () => { calls.push(['start']); return { pid: 4242, readSink: '/jobs/sink.json', passFile: '/jobs/pass.json', startedAt: Date.now() }; },
    speculativeReadSunk: () => true,
    awaitSpeculativeRedTeam: () => { calls.push(['await']); return { spec, waitedMs: 3 }; },
    cancelSpeculativeRedTeam: () => { calls.push(['cancel']); return { spec, reserved: spec ? { callId: spec.callId } : null }; },
    finishSpeculativeRedTeam: (o) => { calls.push(['finish', o.loopPayload.verdict.verdict, o.round1 === true, ...(o.holdStatus ? [true] : [])]); return { status: 'ran', foldedVerdict: 'changes', findings: [], comment: { status: 'posted' } }; },
    recordDiscardedRedTeam: (o) => { calls.push(['discard-row', o.reason]); return { status: 'recorded' }; },
    cleanupSpeculativeRedTeam: () => calls.push(['cleanup']),
  };
  return { io, calls };
}
const kinds = (calls) => calls.filter((c) => c[0] !== 'log').map((c) => c[0]);

describe('runReviewJob under redTeam.timing', () => {
  it('round1 + changes: the pass starts beside the panel (even with review.speculativeRedTeam off), is FINISHED, gated, and settled before the added seats', () => {
    const { io, calls } = jobIo({ verdict: 'changes' });
    const out = runReviewJob({ pr: 7, repo: REPO }, io);
    // `running` again before the gate: the fixer keeps waiting until the gate has published the fix list.
    // The job re-asserts its hold as soon as the pass process is done, and the finish is told not to mark it finished.
    expect(kinds(calls)).toEqual(['start', 'loop', 'status:queued', 'await', 'status:running', 'finish', 'cleanup', 'status:running', 'gate', 'status:finished', 'extra-seats']);
    expect(calls.find((c) => c[0] === 'finish')).toEqual(['finish', 'changes', true, true]);
    expect(calls.some((c) => c[0] === 'discard-row')).toBe(false);
    expect(out.redTeamTiming).toEqual({ timing: 'round1', round: 'changes' });
    expect(out.redTeam.status).toBe('ran');
    expect(calls.some((c) => c[0] === 'log' && /redTeam\.timing: .*timing="round1" \(env\)/.test(c[1]))).toBe(true);
  });

  it('post-accept (the kill switch) + changes: the old order exactly — speculative off means no pass at all; on means a discard', () => {
    const off = jobIo({ verdict: 'changes', timing: POST_ACCEPT });
    runReviewJob({ pr: 7, repo: REPO }, off.io);
    expect(kinds(off.calls)).toEqual(['loop', 'extra-seats']);
    const on = jobIo({ verdict: 'changes', timing: POST_ACCEPT, speculative: { value: 'on', enabled: true, source: 'standard', invalid: [] } });
    runReviewJob({ pr: 7, repo: REPO }, on.io);
    expect(kinds(on.calls)).toEqual(['start', 'loop', 'extra-seats', 'cancel', 'discard-row', 'cleanup', 'status:finished']);
    expect(on.calls.some((c) => c[0] === 'gate')).toBe(false);
  });

  it('round1 + accept: the accepted head reuses the round pass (finish, told round1) after the added seats — no sequential re-run', () => {
    const { io, calls } = jobIo({ verdict: 'accept' });
    runReviewJob({ pr: 7, repo: REPO }, io);
    expect(kinds(calls)).toEqual(['start', 'loop', 'status:queued', 'extra-seats', 'await', 'finish', 'cleanup', 'gate', 'status:finished']);
    expect(calls.find((c) => c[0] === 'finish')).toEqual(['finish', 'accept', true]);
    expect(calls.some((c) => c[0] === 'sequential')).toBe(false);
  });

  it('round1 + needs-human: nothing is owed this round — the pass is called off, as before', () => {
    const { io, calls } = jobIo({ verdict: 'needs-human' });
    runReviewJob({ pr: 7, repo: REPO }, io);
    expect(kinds(calls)).toEqual(['start', 'loop', 'extra-seats', 'cancel', 'discard-row', 'cleanup', 'status:finished']);
  });

  it('round1 + changes, a pass that made no call (e.g. a prior row): the sequential pass runs, told round1', () => {
    const { io, calls } = jobIo({ verdict: 'changes', spec: { status: 'prior-row', reason: 'clean row' } });
    runReviewJob({ pr: 7, repo: REPO }, io);
    expect(calls.find((c) => c[0] === 'sequential')).toEqual(['sequential', true, true]);
    expect(kinds(calls).indexOf('gate')).toBeLessThan(kinds(calls).indexOf('extra-seats'));
  });

  it('NEVER WEAKER: round1 + accept whose pass died is an error result, never a clear', () => {
    const { io, calls } = jobIo({ verdict: 'accept', spec: null });
    const out = runReviewJob({ pr: 7, repo: REPO }, io);
    expect(out.redTeam.status).toBe('error');
    expect(calls.some((c) => c[0] === 'finish')).toBe(false);
  });
});

// ── the two halves of the pass under round1 ─────────────────────────────────────────────────────────────────────

const BREAK = { summary: 'f(0) returns Infinity', category: 'failing-input', file: 'x.mjs', line: 1, impactIfUnfixed: 'broken', failure_scenario: 'f(0)' };
const answer = (findings) => `\`\`\`json\n${JSON.stringify({ lenses: { 'red-team': { verdict: findings.length ? 'changes' : 'accept', findings } } })}\n\`\`\``;
function seatsIo(over = {}) {
  const rows = [];
  const posts = [];
  const ledger = {};
  const io = {
    now: () => NOW,
    newId: (() => { let n = 0; return () => `call-${++n}`; })(),
    log: () => {},
    readRecords: () => rows.slice(),
    reserveCalls: ({ provider, want, dailyCap, now }) => {
      const r = reserveSeatCalls({ ledger: ledger[provider] ?? null, records: [], want, dailyCap, now, newId: io.newId, provider });
      ledger[provider] = r.ledger;
      return r;
    },
    append: (row) => {
      const v = validateScorecard({ v: 1, scoredAt: new Date(NOW).toISOString(), ...row });
      if (!v.ok) throw new Error(v.errors.join('; '));
      rows.push(row);
    },
    cliAvailable: (p) => p === 'codex',
    makeScratch: () => '/tmp/scratch',
    removeScratch: () => {},
    writeFile: () => {},
    readHeadMessage: () => 'fix\n',
    runSeat: async () => ({ report: { lastMessage: answer([BREAK]), exitCode: 0 } }),
    runRecheck: async () => ({ checks: [{ index: 0, confirmed: true, reason: 'no zero check' }] }),
    logTrial: (r) => r,
    listComments: () => [],
    postComment: (o) => posts.push(o),
    ...over,
  };
  return { io, rows, posts };
}

describe('finishSpeculativeRedTeam under round1', () => {
  it('a changes review is refused without round1 (old order) and finished with it: the comment carries the confirmed break', async () => {
    const { io, posts } = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
    const p = payload('changes');
    p.findings.judge.findings = [{ summary: 'a juror finding', file: 'x.mjs' }];
    expect((await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: p, pass, env: {} }, io)).status).toBe('not-owed');
    expect(posts).toEqual([]);
    const fin = await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: p, pass, env: {}, round1: true }, io);
    expect(fin.status).toBe('ran');
    expect(fin.confirmedMissCount).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('f(0) returns Infinity');
  });

  it('an accept whose jurors raised findings reuses the pass under round1 (stale without it)', async () => {
    const { io } = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
    const p = payload('accept');
    p.findings.judge.findings = [{ summary: 'nit', file: 'x.mjs' }];
    expect((await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: p, pass, env: {} }, io)).status).toBe('stale');
    expect((await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: p, pass, env: {}, round1: true }, io)).status).toBe('ran');
  });

  it('a different read is still stale under round1 (an outcome never rests on a different input)', async () => {
    const { io } = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
    expect((await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: payload('changes', read('c'.repeat(40))), pass, env: {}, round1: true }, io)).status).toBe('stale');
  });

  it('the card-review class: a card-only net diff never runs the red team, round1 or not', async () => {
    const { io, posts } = seatsIo();
    const cardOnly = { ...read(), netChangedFiles: ['backlog/1234-a-card.md'], diffText: 'diff --git a/backlog/1234-a-card.md b/backlog/1234-a-card.md\n+x\n' };
    const r = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('changes', cardOnly), env: {}, round1: true }, io);
    expect(r).toMatchObject({ status: 'skipped', reason: 'red team skipped: card-only' });
    expect(posts).toEqual([]);
  });
});

// ── remembered breaks ───────────────────────────────────────────────────────────────────────────────────────────

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const bot = (body, at) => ({ author: { login: 'web-everything' }, createdAt: at, body });
const rtComment = (rev, findings, at) => bot(renderRedTeamComment({ pr: 4722, rev, provider: 'codex', model: 'm', findings, recheckStatus: 'ok', foldedVerdict: 'changes' }), at);
const F = (o) => ({ summary: 's', category: 'edge-case', impactIfUnfixed: 'broken', file: 'scripts/x.mjs', line: 3, confirmedByRecheck: true, recheckReason: 'real', ...o });
// Lines 1-6 padding, 9 = 'c' (the carded break), 10 = the division (the sent-back break), then more padding.
const FILE = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'a', 'b', 'c', 'const x = 1 / n;', 'd', 'e', 'f', 'g', 'h'].join('\n');

describe('citedLinesFingerprint + suppressPreviouslyRuled', () => {
  it('the same lines moved down still match; an edit to a cited line does not; no file/line is never suppressed', () => {
    const at1 = citedLinesFingerprint({ file: 'x.mjs', line: 10, text: FILE });
    expect(citedLinesFingerprint({ file: 'x.mjs', line: 12, text: `new1\nnew2\n${FILE}` })).toBe(at1);
    expect(citedLinesFingerprint({ file: 'x.mjs', line: 10, text: FILE.replace('1 / n', '1 / (n || 1)') })).not.toBe(at1);
    expect(citedLinesFingerprint({ file: 'x.mjs', line: null, text: FILE })).toBeNull();
    expect(citedLinesFingerprint({ file: 'x.mjs', line: 4, text: null })).toBeNull();
    // Anchored: two different lines of a short file never share a fingerprint, even though their excerpts are equal.
    expect(citedLinesFingerprint({ file: 'x.mjs', line: 1, text: 'a\nb' })).not.toBe(citedLinesFingerprint({ file: 'x.mjs', line: 2, text: 'a\nb' }));
    const g = (index, o = {}) => ({ index, file: 'x.mjs', category: 'edge-case', impact: 'broken', summary: `zero divisor crashes parse ${index}`, ...o });
    // The audit probe: two breaks differing by one identifier are NOT the same break.
    expect(sameBreak(g(1, { summary: 'parse crashes when src is nil' }), g(1, { summary: 'parse crashes when dst is nil' }))).toBe(false);
    expect(sameBreak(g(1, { summary: 'fails when n < 0' }), g(1, { summary: 'fails when n > 0' }))).toBe(false);
    expect(sameBreak(g(1, { summary: 'x', scenario: 'parse(-1)' }), g(1, { summary: 'y', scenario: 'parse(1)' }))).toBe(false);
    expect(sameBreak(g(1, { summary: 'parse  crashes when\nsrc is nil ' }), g(1, { summary: 'parse crashes when src is nil' }))).toBe(true);
    expect(sameBreak(g(1, { summary: 'a', scenario: 'f(0)' }), g(1, { summary: 'b', scenario: 'f(0)' }))).toBe(true);
    const plan = { sendBack: [g(1), g(2), g(4, { impact: 'broken', summary: 'unrelated null deref' })], card: [g(3, { impact: 'degraded' })], advisory: [] };
    const ruled = [{ rev: H1, fingerprint: 'fp1', finding: g(1) }, { rev: H1, fingerprint: 'fp3', finding: g(3, { impact: 'degraded' }) },
      { rev: H1, fingerprint: 'fp4', finding: g(4, { impact: 'degraded', summary: 'formatting nit' }) }];
    const out = suppressPreviouslyRuled({ plan, fingerprintOf: (f) => (f.index === 2 ? null : `fp${f.index}`), ruled });
    // #2 has no fingerprint; #4 cites the ruled location but is a DIFFERENT break (class and summary differ).
    expect(out.sendBack.map((f) => f.index)).toEqual([2, 4]);
    expect(out.card).toEqual([]);
    expect(out.advisory.map((f) => f.index)).toEqual([1, 3]);
    expect(out.priorRuled.map((x) => x.rev)).toEqual([H1, H1]);
  });
});

function gateIo({ comments, labels = ['review:changes'], timing = ROUND1, files = {}, head = H2 } = {}) {
  const calls = [];
  const io = {
    readPr: () => ({ headRefOid: head, labels: labels.map((name) => ({ name })), comments }),
    readHead: () => head,
    readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }),
    readTiming: () => timing,
    readFileAt: ({ sha, path }) => { calls.push(['read', sha, path]); return files[`${sha}:${path}`] ?? null; },
    readRound: () => 2,
    dequeueSentBack: () => ({ dequeued: false }),
    signalFix: () => calls.push(['signal']),
    sendBack: (a) => { calls.push(['sendBack', a]); return { ok: true }; },
    appendSendBackEvent: async () => {},
    fileCard: (input) => { calls.push(['card', input]); return { ok: true, session: 'red-team-card-x' }; },
    postComment: (a) => { calls.push(['comment', a.body]); comments.push(bot(a.body, '2026-10-21T21:00:00Z')); },
    log: () => {},
  };
  return { io, calls };
}

describe('the red-team gate under round1', () => {
  // H1: a degraded break was CARDED (ruled) and a broken one SENT BACK (not ruled).
  const earlier = () => [
    rtComment(H1, [F({ impactIfUnfixed: 'degraded', line: 9, summary: 'carded on H1' }), F({ line: 10, summary: 'sent back on H1' })], '2026-10-21T19:00:00Z'),
    bot(buildGateComment({ pr: 4722, head: H1, outcome: GATE_OUTCOMES.CARD_QUEUED, plan: { sendBack: [], card: [{ index: 1 }], advisory: [] }, round: 1, cardResult: { ok: true, session: 'c' } }), '2026-10-21T19:01:00Z'),
  ];

  it('a break ruled on an earlier head with unchanged cited lines is not raised again; one only sent back still is', async () => {
    const comments = earlier();
    expect(ruledEarlierBreaks({ comments, pr: 4722, head: H2, setting: CONFIRMED_BREAKS_DEFAULTS }).map((x) => [x.rev, x.finding.summary])).toEqual([[H1, 'carded on H1']]);
    // H2 moved the file down one line and the red team re-raised both breaks at their moved lines.
    comments.push(rtComment(H2, [F({ impactIfUnfixed: 'degraded', line: 10, summary: 'carded on H1' }), F({ line: 11, summary: 'sent back on H1' })], '2026-10-21T20:30:00Z'));
    const files = { [`${H1}:scripts/x.mjs`]: FILE, [`${H2}:scripts/x.mjs`]: `moved\n${FILE}` };
    const { io, calls } = gateIo({ comments, files });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r.status).toBe('applied');
    expect(r.plan.card).toEqual([]);
    expect(r.plan.sendBack.map((f) => f.summary)).toEqual(['sent back on H1']);
    const prior = calls.find((c) => c[0] === 'comment' && c[1].includes('outcome=prior-ruling'));
    expect(prior[1]).toContain(`ruled on head \`${H1.slice(0, 12)}\``);
    // The PR was already under review:changes: the send-back record carries the fix list for the fixer.
    const sent = calls.find((c) => c[0] === 'comment' && c[1].includes('outcome=sent-back'));
    expect(sent[1]).toContain('Fix list');
    expect(sent[1]).toContain('sent back on H1');
    expect(calls.some((c) => c[0] === 'card' || c[0] === 'sendBack')).toBe(false);
    // The fixer is signalled only after the record with the fix list is posted.
    expect(calls.findIndex((c) => c[0] === 'signal')).toBeGreaterThan(calls.findIndex((c) => c[0] === 'comment' && c[1].includes('outcome=sent-back')));
    // The drain reads the carded-again break as released, the sent-back one as owned by the fixer.
    const d = readRedTeamDisposition({ comments, pr: 4722, head: H2, setting: CONFIRMED_BREAKS_DEFAULTS });
    expect(d.sendBack.map((f) => f.summary)).toEqual(['sent back on H1']);
    // A second gate run repeats nothing.
    const again = gateIo({ comments, files });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, again.io)).status).toBe('already-acted');
    expect(again.calls.some((c) => c[0] === 'comment')).toBe(false);
    // And the fixer's context pack stages both the review's ask and the red team's fix list.
    const changes = bot('🔁 review — changes requested\n\n1. a panel finding', '2026-10-21T20:20:00Z');
    const pack = extractFindings([changes, ...comments], { labels: ['review:changes'], isTrusted: () => true, headSha: H2 });
    expect(pack.findings.map((f) => f.kind)).toEqual(['changes', 'red-team']);
    // A fix list about another head is stale and never staged; no known head stages none.
    expect(extractFindings([changes, ...comments], { labels: ['review:changes'], isTrusted: () => true, headSha: H1 }).findings.map((f) => f.kind)).toEqual(['changes']);
    expect(extractFindings([changes, ...comments], { labels: ['review:changes'], isTrusted: () => true }).findings.map((f) => f.kind)).toEqual(['changes']);
  });

  it('a NEW break at the location of a ruled one is raised (the audit probe: carded nit, then a real division by zero there)', async () => {
    const comments = earlier();
    comments.push(rtComment(H2, [F({ impactIfUnfixed: 'broken', line: 9, summary: 'division by zero when n is 0' })], '2026-10-21T20:30:00Z'));
    const { io } = gateIo({ comments, files: { [`${H1}:scripts/x.mjs`]: FILE, [`${H2}:scripts/x.mjs`]: FILE } });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r.plan.sendBack.map((f) => f.summary)).toEqual(['division by zero when n is 0']);
    expect(readRedTeamDisposition({ comments, pr: 4722, head: H2, setting: CONFIRMED_BREAKS_DEFAULTS }).sendBack).toHaveLength(1);
  });

  it('cited lines that changed are raised again; an unreadable file is raised again (fail closed); post-accept never suppresses', async () => {
    for (const [timing, files] of [
      [ROUND1, { [`${H1}:scripts/x.mjs`]: FILE, [`${H2}:scripts/x.mjs`]: FILE.replace('\nc\n', '\nC\n') }],
      [ROUND1, { [`${H1}:scripts/x.mjs`]: FILE }],
      [POST_ACCEPT, { [`${H1}:scripts/x.mjs`]: FILE, [`${H2}:scripts/x.mjs`]: FILE }],
    ]) {
      const comments = earlier();
      comments.push(rtComment(H2, [F({ impactIfUnfixed: 'degraded', line: 9, summary: 'again' })], '2026-10-21T20:30:00Z'));
      const { io, calls } = gateIo({ comments, files, timing });
      const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
      expect(r.plan.card.map((f) => f.summary)).toEqual(['again']);
      expect(calls.some((c) => c[0] === 'comment' && c[1].includes('prior-ruling'))).toBe(false);
    }
  });

  it('NEVER WEAKER: a prior-ruling line written by anyone untrusted releases nothing; the drain still holds a sent-back break', () => {
    const comments = [rtComment(H2, [F({ summary: 'real' })], '2026-10-21T20:30:00Z'),
      { author: { login: 'mallory' }, body: `${redTeamGateMarker(4722, H2, GATE_OUTCOMES.PRIOR_RULING)}\n- 1 finding(s) left advisory (#1).` }];
    const d = readRedTeamDisposition({ comments, pr: 4722, head: H2, setting: CONFIRMED_BREAKS_DEFAULTS });
    expect(d.sendBack).toHaveLength(1);
    expect(redTeamEnqueueHold({ loopPayload: payload('accept', read(H2)), comments, pr: 4722, head: H2, env: {}, confirmedBreaks: CONFIRMED_BREAKS_DEFAULTS })).not.toBeNull();
  });
});

// ── the fixer waits for an in-flight round-1 pass ───────────────────────────────────────────────────────────────

describe('round-1 fix hold', () => {
  const status = (s) => ({ status: s, head: REV });
  it('holds only while a round-1 pass is queued/running, its writer alive, and younger than the bound', () => {
    expect(decideRound1FixHold({ setting: ROUND1, status: status('running'), statusAt: NOW - 60_000, now: NOW }).hold).toBe(true);
    expect(decideRound1FixHold({ setting: ROUND1, status: status('queued'), statusAt: NOW - 60_000, now: NOW }).hold).toBe(true);
    expect(decideRound1FixHold({ setting: POST_ACCEPT, status: status('running'), statusAt: NOW, now: NOW }).hold).toBe(false);
    expect(decideRound1FixHold({ setting: ROUND1, status: status('finished'), statusAt: NOW, now: NOW }).hold).toBe(false);
    expect(decideRound1FixHold({ setting: ROUND1, status: status('running'), statusAt: NOW, now: NOW, writerAlive: false }).hold).toBe(false);
    expect(decideRound1FixHold({ setting: ROUND1, status: status('running'), statusAt: NOW - 31 * 60_000, now: NOW }).hold).toBe(false);
    expect(decideRound1FixHold({ setting: ROUND1, status: null, now: NOW }).hold).toBe(false);
  });

  it('fix dispatch refuses (for this tick) a review:changes PR whose head has a round-1 pass in flight, before any lane or claim', () => {
    const asked = [];
    const r = runReconcileFixDispatch({
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 77, headRefName: 'lane/x', headRefOid: REV, labels: ['review:changes'], body: '' }], refusals: [] }),
      findItemFn: () => null, loadItems: () => [], resolveFallbackScope: () => ['scripts/x.mjs'], fetchItemlessDiffPaths: () => ['scripts/x.mjs'],
      root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
      pickFreeLanes: () => [3],
      round1RedTeamHold: (o) => { asked.push(o); return { hold: true, why: 'round-1 red team running' }; },
      dispatch: () => { throw new Error('must not dispatch'); },
    });
    expect(asked).toEqual([{ repo: REPO, pr: 77, head: REV }]);
    expect(r.dispatched).toEqual([]);
    expect(r.refusals.some((x) => x.kind === 'red-team-round1' && x.pr === 77)).toBe(true);
  });
});
