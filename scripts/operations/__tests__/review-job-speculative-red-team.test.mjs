/**
 * Card xbizuci — `review.speculativeRedTeam`: the review job starts the post-accept red team beside the review loop
 * and keeps it only when the review accepts. No real process, model, git or GitHub call: every effect is a fake.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnKeepAlive } from '../../lib/test-keepalive.mjs';

import { createReviewJobIo, runReviewJob, settleSpeculativeRedTeam } from '../review-job.mjs';
import {
  speculateRedTeam, finishSpeculativeRedTeam, runRedTeam, buildRedTeamDiscardRow, reserveSeatCalls,
  RED_TEAM_DISCARD_DISPATCH_KIND, redTeamReadFingerprint, recordDiscardedRedTeam, ACTIVE_SEAT_PIDS, killActiveSeats,
} from '../review-extra-seats.mjs';
import { validateScorecard } from '../../conveyor/run-scorecard-store.mjs';
import { redTeamEnqueueHold } from '../../lib/drain-queue-safety.mjs';
import { readDrainRedTeamEvidence, recordRedTeamStatus } from '../../lib/drain-red-team-evidence.mjs';
import { newRunRecord, writeRun } from '../run-store.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { liveResultGateState, parseRedTeamComment, redTeamGateMarker, redTeamResultId } from '../../lib/red-team-gate.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';

const REPO = 'web-everything/web-everything';
const REV = 'a'.repeat(40);
const NOW = Date.parse('2026-10-10T14:00:00Z');

const read = (rev = REV) => ({
  title: 'fix the thing', body: 'Claims: adds a guard.', diffText: 'diff --git a/x.mjs b/x.mjs\n+export const f = (n) => 10 / n;\n',
  netChangedFiles: ['x.mjs'], netBasis: { base: 'b'.repeat(40), rev },
});
const payload = (verdict, r = read()) => ({
  runId: 'review-pr-1', stopped: 'complete', verdict: { verdict, loop: { outcome: 'converged' } },
  findings: { read: r, judge: { findings: [] }, judgeSecurity: { findings: [] } },
});
/** Card xyyuvyz — the `review:human` advisory-accept shape (#4722): `needs-human` only because the human gate applies, panel all accept. */
const advisoryAccept = (r = read()) => {
  const lensVerdicts = { correctness: 'accept', security: 'accept', simplicity: 'accept' };
  const p = payload('needs-human', r);
  p.verdict = { ...p.verdict, loop: { outcome: 'escalated' }, humanRequired: true, lenses: Object.keys(lensVerdicts), lensVerdicts, findings: [], admittedFindings: [] };
  return p;
};

// ── the job ──────────────────────────────────────────────────────────────────────────────────────────────────────

const PASS = { status: 'speculated', rev: REV, callId: 'call-1', provider: 'codex', findings: [], timings: { startedAt: 0, readAt: 5, finishedAt: 50 } };

function jobIo({ verdict = 'accept', setting = { value: 'on', enabled: true, source: 'standard', invalid: [] }, spec = PASS, finish, over = {} } = {}) {
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
    runLoop: (o) => { calls.push(['loop', o.readSink ?? null]); return { status: 0, stdout: JSON.stringify(payload(verdict)), stderr: '' }; },
    releaseLane: () => {},
    log: (l) => calls.push(['log', l]),
    runRedTeam: () => { calls.push(['sequential']); return { status: 'ran', foldedVerdict: 'accept', findings: [], comment: { status: 'posted' } }; },
    runRedTeamGate: () => { calls.push(['gate']); return { status: 'ok', outcome: 'advisory' }; },
    speculativeRedTeamSetting: () => setting,
    startSpeculativeRedTeam: (o) => { calls.push(['start', o.lanePath]); return { pid: 4242, readSink: '/jobs/sink.json', passFile: '/jobs/pass.json', startedAt: Date.now() }; },
    awaitSpeculativeRedTeam: () => { calls.push(['await']); return { spec, waitedMs: 3 }; },
    cancelSpeculativeRedTeam: () => { calls.push(['cancel']); return { spec, reserved: spec ? { callId: spec.callId } : null }; },
    finishSpeculativeRedTeam: (o) => { calls.push(['finish', o.loopPayload.verdict.verdict]); return finish ?? { status: 'ran', foldedVerdict: 'accept', findings: [], comment: { status: 'posted' } }; },
    recordDiscardedRedTeam: (o) => { calls.push(['discard-row', o.reason]); return { status: 'recorded' }; },
    cleanupSpeculativeRedTeam: () => calls.push(['cleanup']),
    ...over,
  };
  return { io, calls };
}
const kinds = (calls) => calls.filter((c) => c[0] !== 'log').map((c) => c[0]);

describe('runReviewJob under review.speculativeRedTeam', () => {
  it('the actual carry comment releases queue admission without starting another review or red team', () => {
    const head = 'b'.repeat(40);
    const comments = [
      { author: { login: 'web-everything' }, body: `<!-- reviewed-sha: ${REV} -->` },
      { author: { login: 'web-everything' }, body: renderRedTeamComment({ pr: 10, rev: REV, findings: [], provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'accept' }) },
    ];
    const { io, calls } = jobIo({ over: {
      carryAcrossRebaseSetting: () => ({ value: 'on', source: 'test' }),
      readCarryEvidence: () => ({ headSha: head, comments }),
      contributionPatchId: () => 'c'.repeat(40),
      restampVerdict: () => ({ ok: true }),
      postCarryComment: ({ body }) => comments.push({ user: { login: 'web-everything[bot]' }, body }),
    } });
    expect(runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io).outcome).toBe('carried');
    expect(kinds(calls)).toEqual([]);
    expect(redTeamEnqueueHold({ loopPayload: payload('accept'), comments, pr: 10, head, env: {} })).toBeNull();
  });

  // PR #5482 operator ruling: a carry moves only the gate decisions made on the result it carries.
  it('a carry never moves an earlier same-head result\'s gate outcome onto the newer result it carries', () => {
    const head = 'b'.repeat(40);
    const degraded = summary => renderRedTeamComment({ pr: 10, rev: REV, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [{ summary, category: 'edge-case', impactIfUnfixed: 'degraded', confirmedByRecheck: true }] });
    const bot = body => ({ author: { login: 'web-everything' }, body });
    const run = comments => {
      const { io } = jobIo({ over: {
        carryAcrossRebaseSetting: () => ({ value: 'on', source: 'test' }),
        readCarryEvidence: () => ({ headSha: head, comments }),
        contributionPatchId: () => 'c'.repeat(40),
        restampVerdict: () => ({ ok: true }),
        postCarryComment: ({ body }) => comments.push(bot(body)),
      } });
      expect(runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io).outcome).toBe('carried');
      return [...liveResultGateState(comments, 10, head).outcomes];
    };
    const carded = bot(redTeamGateMarker(10, REV, 'card-queued'));
    expect(run([bot(`<!-- reviewed-sha: ${REV} -->`), bot(degraded('old')), carded, bot(degraded('new'))])).toEqual([]);
    expect(run([bot(`<!-- reviewed-sha: ${REV} -->`), bot(degraded('old')), carded])).toEqual(['card-queued']);
  });

  // Codex guard audit of the round-grant fix: one carry comment would flatten record order and lose a grant's position
  // between a round-cap and a later sent-back. The carry never moves a send-back step record at all, so it cannot.
  it('a send-back step record (round-cap, grant-backed sent-back) is never carried, so the grant position survives', () => {
    const head = 'b'.repeat(40);
    const broken = renderRedTeamComment({ pr: 10, rev: REV, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', file: 'x.mjs', line: 1, confirmedByRecheck: true }] });
    const bot = body => ({ author: { login: 'web-everything' }, body });
    const grant = { author: { login: 'chalbert' }, body: buildRoundExtensionComment({ repo: REPO, pr: 10, by: 1, actor: 'chalbert', channel: 'test', reason: 'Yes', at: '2026-10-19T00:00:00Z' }) };
    const id = redTeamResultId(parseRedTeamComment(broken));
    const base = [bot(`<!-- reviewed-sha: ${REV} -->`), bot(broken), bot(redTeamGateMarker(10, REV, 'round-cap', id)), grant];
    for (const comments of [base, [...base, bot(redTeamGateMarker(10, REV, 'sent-back', id))]]) {
      const posted = [];
      const { io } = jobIo({ over: {
        carryAcrossRebaseSetting: () => ({ value: 'on', source: 'test' }),
        readCarryEvidence: () => ({ headSha: head, comments }),
        contributionPatchId: () => 'c'.repeat(40),
        restampVerdict: () => ({ ok: true }),
        postCarryComment: a => posted.push(a),
      } });
      expect(runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io).outcome).not.toBe('carried');
      expect(posted).toEqual([]);
    }
  });

  it.each([true, false])('records the pass as queued before the added seats and the dispatch, then finished (speculative=%s)', enabled => {
    const events = [];
    const { io } = jobIo({ setting: { enabled }, over: {
      redTeamStatus: row => events.push(row),
      runExtraSeats: () => { expect(events.map(row => row.status)).toEqual(['queued']); return { status: 'ran', seats: [] }; },
      finishSpeculativeRedTeam: () => { expect(events.map(row => row.status)).toEqual(['queued']); return { status: 'ran' }; },
      runRedTeam: () => { expect(events.map(row => row.status)).toEqual(['queued']); return { status: 'ran' }; },
    } });
    runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(events.map(row => row.status)).toEqual(['queued', 'finished']);
    expect(events[0]).toMatchObject({ repo: REPO, pr: 10, loopPayload: { findings: { read: { netBasis: { rev: REV } } } } });
  });
  it.each([true, false])('holds enqueue at every step from the accept until a result is posted (speculative=%s)', enabled => {
    const root = mkdtempSync(join(tmpdir(), 'review-job-window-'));
    try {
      const runsDir = join(root, 'runs');
      const env = { WE_SHARED_RUNS_DIR: runsDir };
      const holds = [];
      const probe = step => {
        const evidence = readDrainRedTeamEvidence({ repo: REPO, pr: 10, head: REV, env, runsDir, readScorecards: () => [] });
        holds.push([step, redTeamEnqueueHold({ ...evidence, comments: [], pr: 10, head: REV, env })]);
      };
      const { io } = jobIo({ setting: { enabled }, over: {
        redTeamStatus: row => recordRedTeamStatus(row, { env }),
        // The loop persists its accepting run and applies the labels before the job sees its stdout.
        runLoop: () => {
          writeRun({ ...newRunRecord({ id: 'review-pr-1', op: 'review-pr', input: { repo: REPO, pr: 10 } }), ...payload('accept') }, runsDir);
          probe('labels applied');
          return { status: 0, stdout: JSON.stringify(payload('accept')), stderr: '' };
        },
        runExtraSeats: () => { probe('added seats'); return { status: 'ran', seats: [] }; },
        awaitSpeculativeRedTeam: () => { probe('speculative wait'); return { spec: PASS, waitedMs: 3 }; },
        finishSpeculativeRedTeam: () => { probe('speculative finish'); return { status: 'ran' }; },
        runRedTeam: () => { probe('sequential pass'); return { status: 'ran' }; },
      } });
      runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
      expect(holds.length).toBeGreaterThanOrEqual(3);
      for (const [step, reason] of holds) expect([step, reason]).toEqual([step, expect.stringMatching(/no recorded result/)]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('clears scheduling status when the review rejects and discards speculation', () => {
    const events = [];
    const { io } = jobIo({ verdict: 'changes', over: { redTeamStatus: row => events.push(row) } });
    runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(events).toEqual([expect.objectContaining({ status: 'finished', result: 'not-owed' })]);
  });
  it('starts the red team BEFORE the loop, hands the loop the read sink, and logs the layer that set the setting', () => {
    const { io, calls } = jobIo();
    runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(kinds(calls).slice(0, 2)).toEqual(['start', 'loop']);
    expect(calls.find((c) => c[0] === 'loop')[1]).toBe('/jobs/sink.json');
    expect(calls.some((c) => c[0] === 'log' && c[1].includes('review.speculativeRedTeam=on (standard)'))).toBe(true);
  });

  it('accept → the speculative pass is finished and IS the red team result; the gate runs after it; no sequential pass', () => {
    const { io, calls } = jobIo();
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(kinds(calls)).toEqual(['start', 'loop', 'await', 'finish', 'cleanup', 'gate']);
    expect(calls.find((c) => c[0] === 'finish')[1]).toBe('accept');
    expect(out.redTeam).toMatchObject({ status: 'ran', foldedVerdict: 'accept', comment: 'posted' });
    expect(out.redTeamSpeculative).toMatchObject({ decision: 'finish', waitedMs: 3 });
    expect(out.redTeamSpeculative.result).toBeUndefined();
    expect(out.redTeamGate).toMatchObject({ status: 'ok', outcome: 'advisory' });
  });

  it('accept → the recorded result equals what the sequential order records (same summary, same gate call)', () => {
    const same = { status: 'ran', foldedVerdict: 'changes', findings: [{ summary: 'f(0)', confirmedByRecheck: true }], confirmedMissCount: 1, comment: { status: 'posted' } };
    const spec = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, jobIo({ finish: same }).io);
    const seq = jobIo({ setting: { value: 'off', enabled: false, source: 'env', invalid: [] }, over: { runRedTeam: () => same } });
    const sequential = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, seq.io);
    expect(spec.redTeam).toEqual(sequential.redTeam);
    expect(spec.redTeamGate).toEqual(sequential.redTeamGate);
    expect(spec.verdict).toBe(sequential.verdict);
    expect(spec.outcome).toBe(sequential.outcome);
  });

  it('a review:human advisory accept → the speculative pass is finished (not discarded, no sequential pass) and the gate runs', () => {
    const { io, calls } = jobIo({ over: { runLoop: (o) => { calls.push(['loop', o.readSink ?? null]); return { status: 0, stdout: JSON.stringify(advisoryAccept()), stderr: '' }; } } });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(kinds(calls)).toEqual(['start', 'loop', 'await', 'finish', 'cleanup', 'gate']);
    expect(calls.find((c) => c[0] === 'finish')[1]).toBe('needs-human');
    expect(out.redTeam).toMatchObject({ status: 'ran', foldedVerdict: 'accept' });
    expect(out.redTeamSpeculative).toMatchObject({ decision: 'finish' });
  });

  it('changes → the pass is called off and its spend recorded; nothing posted, no gate, no sequential pass', () => {
    const { io, calls } = jobIo({ verdict: 'changes' });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(kinds(calls)).toEqual(['start', 'loop', 'cancel', 'discard-row', 'cleanup']);
    expect(calls.find((c) => c[0] === 'discard-row')[1]).toMatch(/verdict changes — not accept/);
    expect(out.redTeam).toBeUndefined();
    expect(out.redTeamGate).toBeUndefined();
    expect(out.redTeamSpeculative).toMatchObject({ decision: 'discard', passStatus: 'speculated', spend: { status: 'recorded' } });
    expect(out.verdict).toBe('changes');
  });

  it('a loop that printed no review (timeout) also discards', () => {
    const { io, calls } = jobIo({ over: { runLoop: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }) } });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(kinds(calls)).toEqual(['start', 'cancel', 'discard-row', 'cleanup']);
    expect(out.redTeamSpeculative.decision).toBe('discard');
  });

  it('red-team failure: a speculative process that died is the same degraded result as a crashed sequential pass', () => {
    const { io, calls } = jobIo({ spec: null });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(out.redTeam).toMatchObject({ status: 'error' });
    expect(out.redTeam.foldedVerdict).toBeUndefined();
    expect(kinds(calls)).toContain('gate');
    expect(kinds(calls)).not.toContain('sequential');
    const seqCrash = jobIo({ setting: { value: 'off', enabled: false, source: 'env', invalid: [] }, over: { runRedTeam: () => { throw new Error('boom'); } } });
    const seqOut = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, seqCrash.io);
    expect(seqOut.redTeam.status).toBe(out.redTeam.status);
  });

  it('a speculative pass that errored is reported as that error (never a ratifying accept)', () => {
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, jobIo({ spec: { status: 'error', reason: 'scratch failed' } }).io);
    expect(out.redTeam).toEqual({ status: 'error', reason: 'scratch failed' });
  });

  it('a speculation that made no call (skipped / prior row / no read) falls back to the sequential pass', () => {
    for (const status of ['skipped', 'prior-row', 'no-read']) {
      const { io, calls } = jobIo({ spec: { status, reason: 'x' } });
      runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
      expect(kinds(calls)).toEqual(['start', 'loop', 'await', 'cleanup', 'sequential', 'gate']);
    }
  });

  it('a stale pass (it judged a different read) records its spend as discarded and runs the sequential pass', () => {
    const { io, calls } = jobIo({ finish: { status: 'stale', reason: 'different head' } });
    runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(kinds(calls)).toEqual(['start', 'loop', 'await', 'finish', 'discard-row', 'cleanup', 'sequential', 'gate']);
  });

  it('accept, but the loop never wrote the read sink → called off at once and the sequential pass runs (never a red-team error)', () => {
    const { io, calls } = jobIo({ over: { speculativeReadSunk: () => false } });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(kinds(calls)).toEqual(['start', 'loop', 'cancel', 'discard-row', 'cleanup', 'sequential', 'gate']);
    expect(out.redTeam.status).toBe('ran');
    expect(out.redTeamSpeculative).toMatchObject({ decision: 'sequential', passStatus: 'no-read' });
  });

  it('setting off → today\'s order: no speculative start, no sink, the red team after the review', () => {
    const { io, calls } = jobIo({ setting: { value: 'off', enabled: false, source: 'tool', invalid: [] } });
    runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(kinds(calls)).toEqual(['loop', 'sequential', 'gate']);
    expect(calls.find((c) => c[0] === 'loop')[1]).toBeNull();
    expect(calls.some((c) => c[0] === 'log' && c[1].includes('review.speculativeRedTeam=off (tool)'))).toBe(true);
  });

  it('a failed start is the sequential order, never a failed review', () => {
    const { io, calls } = jobIo({ over: { startSpeculativeRedTeam: () => { throw new Error('spawn EAGAIN'); } } });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 1 }, io);
    expect(kinds(calls)).toEqual(['loop', 'sequential', 'gate']);
    expect(out.outcome).toBe('auto-cleared');
  });

  it('settleSpeculativeRedTeam reports the overlap: read and pass times relative to the start', () => {
    const { io } = jobIo();
    const spec = { pid: 1, startedAt: 1000, loopFinishedAt: 1300 };
    const pass = { ...PASS, timings: { startedAt: 1000, readAt: 1010, finishedAt: 1250 } };
    const r = settleSpeculativeRedTeam({ spec, accepted: true, out: { pr: 1, repo: REPO, sessionSlug: 's' }, input: { loopPayload: payload('accept') } },
      { ...io, awaitSpeculativeRedTeam: () => ({ spec: pass, waitedMs: 0 }) });
    expect(r.timings).toEqual({ readAfterMs: 10, finishedAfterMs: 250, loopFinishedAfterMs: 300 });
  });
});

// ── the two halves of the pass ───────────────────────────────────────────────────────────────────────────────────

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

describe('speculateRedTeam + finishSpeculativeRedTeam', () => {
  it('speculating writes nothing and posts nothing; finishing an accept records exactly what the sequential pass records', async () => {
    const a = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, a.io);
    expect(pass.status).toBe('speculated');
    expect(a.rows).toEqual([]);
    expect(a.posts).toEqual([]);
    const fin = await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: payload('accept'), pass: JSON.parse(JSON.stringify(pass)), env: {} }, a.io);

    const b = seatsIo();
    const seq = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, b.io);
    const strip = (r) => ({ ...r, callId: undefined, seat: { ...r.seat, callId: undefined } });
    expect(strip(fin)).toEqual(strip(seq));
    expect(fin.foldedVerdict).toBe('changes');
    const norm = (rows) => rows.map((r) => ({ ...r, callId: undefined, redTeamCallId: undefined }));
    expect(norm(a.rows)).toEqual(norm(b.rows));
    expect(a.posts.map((p) => p.body)).toEqual(b.posts.map((p) => p.body));
  });

  it('a pass that judged a different read is stale (the job then runs the sequential pass)', async () => {
    const { io, rows, posts } = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
    const r = await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: payload('accept', read('c'.repeat(40))), pass, env: {} }, io);
    expect(r.status).toBe('stale');
    expect(rows).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('an accept whose jurors raised findings is stale: the sequential brief lists them, the speculative one could not', async () => {
    const { io, rows, posts } = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
    const p = payload('accept');
    p.findings.judge.findings = [{ summary: 'f(0) divides by zero', file: 'x.mjs' }];
    const r = await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: p, pass, env: {} }, io);
    expect(r.status).toBe('stale');
    expect(rows).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('finishing a non-accept is refused (not owed) — the speculative pass never posts on changes', async () => {
    const { io, posts } = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
    expect((await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: payload('changes'), pass, env: {} }, io)).status).toBe('not-owed');
    expect(posts).toEqual([]);
  });

  it('a review:human advisory accept finishes the speculative pass and posts (card xyyuvyz, #4722) — same result as the sequential pass', async () => {
    const a = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, a.io);
    const fin = await finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload: advisoryAccept(), pass: JSON.parse(JSON.stringify(pass)), env: {} }, a.io);
    expect(fin.status).toBe('ran');
    expect(a.posts.length).toBe(1);

    const b = seatsIo();
    const seq = await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: advisoryAccept(), env: {} }, b.io);
    const strip = (r) => ({ ...r, callId: undefined, seat: { ...r.seat, callId: undefined } });
    expect(strip(fin)).toEqual(strip(seq));
  });

  it('every red-team entry point reads the one gate: plain accept and advisory accept run, a non-accept is not owed', async () => {
    const owed = [['plain accept', () => payload('accept')], ['advisory accept', () => advisoryAccept()]];
    const refused = [['changes', () => payload('changes')], ['human gate, panel not accepting', () => {
      const p = advisoryAccept();
      p.verdict.lensVerdicts = { ...p.verdict.lensVerdicts, correctness: 'changes' };
      return p;
    }]];
    const entries = {
      runRedTeam: async (loopPayload, io) => runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload, env: {} }, io),
      finishSpeculativeRedTeam: async (loopPayload, io) => {
        const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
        return finishSpeculativeRedTeam({ pr: 5, repo: REPO, loopPayload, pass, env: {} }, io);
      },
    };
    for (const [entry, run] of Object.entries(entries)) {
      for (const [name, make] of owed) {
        const { io, posts } = seatsIo();
        const r = await run(make(), io);
        expect([entry, name, r.status]).toEqual([entry, name, 'ran']);
        expect(posts.length).toBe(1);
      }
      for (const [name, make] of refused) {
        const { io, posts } = seatsIo();
        const r = await run(make(), io);
        expect([entry, name, r.status]).toEqual([entry, name, 'not-owed']);
        expect(posts).toEqual([]);
      }
    }
  });

  it('a prior clean row is reported, never resumed, by a speculative pass', async () => {
    const { io, posts } = seatsIo();
    await runRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env: {} }, io);
    const before = posts.length;
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
    expect(pass.status).toBe('prior-row');
    expect(posts.length).toBe(before);
  });

  it('the discard row names the spend under its own kind; a pass killed mid-call is recorded from its reservation', async () => {
    const { io } = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
    const row = buildRedTeamDiscardRow({ pr: 5, repo: REPO, pass, reason: 'changes', now: NOW });
    expect(row).toMatchObject({ dispatchKind: RED_TEAM_DISCARD_DISPATCH_KIND, pr: 5, rev: REV, provider: 'codex', completed: true, findingsCount: 1 });
    expect(buildRedTeamDiscardRow({ pr: 5, repo: REPO, reserved: { callId: 'c9', provider: 'codex', rev: REV }, reason: 'killed', now: NOW }))
      .toMatchObject({ callId: 'c9', completed: false });
    expect(buildRedTeamDiscardRow({ pr: 5, repo: REPO, reason: 'nothing', now: NOW })).toBeNull();
  });

  it('the discard row is one the scorecard store accepts (live: the first discard was refused by its validator)', async () => {
    const { io, rows } = seatsIo();
    const pass = await speculateRedTeam({ pr: 5, repo: REPO, lanePath: '/lane', read: read(), env: {}, resume: false }, io);
    expect(recordDiscardedRedTeam({ pr: 5, repo: REPO, pass, reason: 'changes' }, io)).toMatchObject({ status: 'recorded', completed: true });
    expect(recordDiscardedRedTeam({ pr: 5, repo: REPO, reserved: { callId: 'c9', provider: 'codex', model: 'm', rev: REV }, reason: 'killed' }, io)).toMatchObject({ status: 'recorded', completed: false });
    expect(rows.map((r) => r.dispatchKind)).toEqual([RED_TEAM_DISCARD_DISPATCH_KIND, RED_TEAM_DISCARD_DISPATCH_KIND]);
    expect(rows.every((r) => r.score === null && r.criteriaEvaluated === 0)).toBe(true);
  });

  it('the read fingerprint changes with the head, the diff, the title, the body or the file list', () => {
    const base = redTeamReadFingerprint(read());
    expect(redTeamReadFingerprint(read())).toBe(base);
    for (const tweak of [{ netBasis: { rev: 'c'.repeat(40) } }, { diffText: 'x' }, { title: 't' }, { body: 'b' }, { netChangedFiles: [] }]) {
      expect(redTeamReadFingerprint({ ...read(), ...tweak })).not.toBe(base);
    }
  });
});

// ── real processes: calling a pass off really stops it ───────────────────────────────────────────────────────────

const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
const exited = (child) => new Promise((resolveExit) => { if (child.exitCode !== null || child.signalCode) resolveExit(); else child.once('exit', () => resolveExit()); });

describe('calling a speculative pass off kills real processes', () => {
  it('killActiveSeats kills a running seat CLI\'s own (detached) process group', async () => {
    const seat = spawnKeepAlive({ detached: true });
    ACTIVE_SEAT_PIDS.add(seat.pid);
    killActiveSeats('SIGKILL');
    await exited(seat);
    ACTIVE_SEAT_PIDS.delete(seat.pid);
    expect(gone(seat.pid)).toBe(true);
  });

  it('cancelSpeculativeRedTeam stops a real speculate process that is still waiting, and returns no spend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xbizuci-'));
    try {
      const io = createReviewJobIo({ dir, env: { ...process.env } });
      const h = io.startSpeculativeRedTeam({ pr: 1, repo: REPO, lanePath: dir, slug: 'cancel-test', waitMs: 60_000 });
      expect(h?.pid).toBeGreaterThan(0);
      expect(io.speculativeReadSunk(h)).toBe(false);
      expect(io.cancelSpeculativeRedTeam(h)).toEqual({ spec: null, reserved: null });
      // Our own detached child lingers as a zombie until this process reaps it; `ps` must not show it running.
      const stat = String(spawnSync('ps', ['-o', 'stat=', '-p', String(h.pid)], { encoding: 'utf8' }).stdout ?? '').trim();
      expect(stat === '' || stat.startsWith('Z')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('durable run seat timing handoff', () => {
  it('hands extra seats and the speculative model-call times to the existing run writer', () => {
    const writes = [];
    const startedAt = new Date(NOW).toISOString();
    const finishedAt = new Date(NOW + 120000).toISOString();
    const spec = { ...PASS, startedAt, finishedAt, parsed: { 'red-team': { verdict: 'accept' } } };
    const extra = { seat: 'advisory', lens: 'simplicity', provider: 'codex', model: 'test', startedAt, finishedAt, seatVerdict: 'changes', findingsCount: 2 };
    const { io } = jobIo({ spec, over: {
      runExtraSeats: () => ({ status: 'ran', seats: [extra] }),
      recordSeatTimings: (id, rows) => writes.push({ id, rows }),
    } });
    runReviewJob({ pr: 5, repo: REPO }, io);
    const rows = writes.flatMap(w => w.rows);
    expect(writes.every(w => w.id === 'review-pr-1')).toBe(true);
    expect(rows).toContainEqual({ seat: 'advisory', lens: 'simplicity', provider: 'codex', model: 'test', startedAt, finishedAt, verdict: 'changes', findingsCount: 2 });
    expect(rows).toContainEqual({ seat: 'red-team', lens: 'red-team', provider: 'codex', model: null, startedAt, finishedAt, verdict: 'accept', findingsCount: 0 });
  });
});
