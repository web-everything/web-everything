/**
 * Card xbizuci — `review.speculativeRedTeam`: the review job starts the post-accept red team beside the review loop
 * and keeps it only when the review accepts. No real process, model, git or GitHub call: every effect is a fake.
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReviewJobIo, runReviewJob, settleSpeculativeRedTeam } from '../review-job.mjs';
import {
  speculateRedTeam, finishSpeculativeRedTeam, runRedTeam, buildRedTeamDiscardRow, reserveSeatCalls,
  RED_TEAM_DISCARD_DISPATCH_KIND, redTeamReadFingerprint, recordDiscardedRedTeam, ACTIVE_SEAT_PIDS, killActiveSeats,
} from '../review-extra-seats.mjs';
import { validateScorecard } from '../../conveyor/run-scorecard-store.mjs';

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
    const seat = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
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
