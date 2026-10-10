/**
 * Card x1b8hlo — the red-team gate's impure half over a fake io: broken → send-back, degraded → card,
 * unconfirmed → advisory, a stale head → ignored, the round cap, dedup — and review-job runs it after the red team.
 */
import { describe, expect, it } from 'vitest';
import { applyRedTeamGate, buildRedTeamCardInput, buildSendBackArgv, buildSendBackBody, RED_TEAM_GATE_ACTOR, RED_TEAM_GATE_CHANNEL } from '../red-team-gate-apply.mjs';
import { runReviewJob } from '../review-job.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker } from '../../lib/red-team-gate.mjs';
import { runReviewLabelCli } from '../../review-set-label.mjs';

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
  const io = {
    readPr: () => ({ headRefOid: head, labels: labels.map((name) => ({ name })), comments }),
    readHead: () => liveHead,
    readSetting: () => ({ value: setting }),
    readRound: () => round,
    sendBack: (a) => { calls.push(['sendBack', a]); return { ok: true }; },
    appendSendBackEvent: async (a) => { calls.push(['ledger', a]); },
    fileCard: (input) => { calls.push(['card', input]); return { ok: true, session: 'red-team-card-x' }; },
    postComment: (a) => { calls.push(['comment', a]); comments.push({ author: { login: 'web-everything' }, body: a.body }); },
    log: () => {},
    ...over,
  };
  return { io, calls };
}
const kinds = (calls) => calls.map((c) => c[0]);

describe('applyRedTeamGate', () => {
  it('broken → send-back through review-set-label + ledger event + gate record', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F({ summary: 'two writers' })])] });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r).toMatchObject({ status: 'applied', outcome: 'sent-back' });
    expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment']);
    expect(calls[0][1]).toMatchObject({ repo: REPO, pr: 4722, head: HEAD });
    expect(calls[0][1].body).toMatch(/1\. `scripts\/x\.mjs:3` — \(edge-case, broken\) two writers/);
    expect(calls[2][1].body.startsWith(redTeamGateMarker(4722, HEAD, 'sent-back'))).toBe(true);
  });

  it('degraded → one follow-up card, no send-back', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F({ impactIfUnfixed: 'degraded', summary: 'stale config' })])] });
    const r = await applyRedTeamGate({ repo: REPO, pr: 4722 }, io);
    expect(r).toMatchObject({ status: 'applied', outcome: 'no-send-back' });
    expect(kinds(calls)).toEqual(['card', 'comment']);
    expect(calls[0][1]).toMatchObject({ kind: 'story', scope: 'we:scripts/x.mjs' });
    expect(calls[0][1].digest).toMatch(/stale config/);
    expect(calls[1][1].body.startsWith(redTeamGateMarker(4722, HEAD, 'card-queued'))).toBe(true);
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
    expect(calls[0][1].body.startsWith(redTeamGateMarker(4722, HEAD, 'sent-back'))).toBe(true);
  });
  it('a round-cap record that cannot be posted is a visible failure too', async () => {
    const { io } = fakeIo({ comments: [comment([F()])], round: 5, postComment: () => { throw new Error('gh down'); } });
    expect(await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).toMatchObject({ status: 'send-back-record-failed', outcome: 'round-cap' });
  });

  it('broken + degraded → send-back, THEN the card; each action gets its own record', async () => {
    const { io, calls } = fakeIo({ comments: [comment([F(), F({ impactIfUnfixed: 'degraded' })])] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('applied');
    expect(kinds(calls)).toEqual(['sendBack', 'ledger', 'comment', 'card', 'comment']);
    expect(calls[2][1].body.startsWith(redTeamGateMarker(4722, HEAD, 'sent-back'))).toBe(true);
    expect(calls[4][1].body.startsWith(redTeamGateMarker(4722, HEAD, 'card-queued'))).toBe(true);
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
    expect(calls[1][1].body.startsWith(redTeamGateMarker(4722, HEAD, 'card-queued'))).toBe(true);
    calls.length = 0;
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('already-acted');
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

  it('acts once per head: the gate record dedups', async () => {
    const done = { author: { login: 'web-everything' }, body: `${redTeamGateMarker(4722, HEAD, 'sent-back')}\nx` };
    const { io, calls } = fakeIo({ comments: [comment([F()]), done] });
    expect((await applyRedTeamGate({ repo: REPO, pr: 4722 }, io)).status).toBe('already-acted');
    expect(calls).toEqual([]);
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
