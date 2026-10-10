/**
 * Card x1b8hlo — the red-team gate's impure half over a fake io: broken → send-back, degraded → card,
 * unconfirmed → advisory, a stale head → ignored, the round cap, dedup — and review-job runs it after the red team.
 */
import { describe, expect, it } from 'vitest';
import { applyRedTeamGate, buildRedTeamCardInput, buildSendBackBody } from '../red-team-gate-apply.mjs';
import { runReviewJob } from '../review-job.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker } from '../../lib/red-team-gate.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'ea117e881164c3b6366b0bb78a3660c9a00503b1';
const OTHER = '2'.repeat(40);
const F = (o) => ({ summary: 's', category: 'edge-case', impactIfUnfixed: 'broken', file: 'scripts/x.mjs', line: 3, confirmedByRecheck: true, recheckReason: 'real', ...o });
const comment = (findings, rev = HEAD) => ({
  author: { login: 'web-everything' }, createdAt: '2026-10-10T02:04:41Z',
  body: renderRedTeamComment({ pr: 4722, rev, provider: 'codex', model: 'm', findings, recheckStatus: 'ok', foldedVerdict: 'changes' }),
});

function fakeIo({ comments, labels = ['review:accepted'], head = HEAD, round = 1, setting = CONFIRMED_BREAKS_DEFAULTS, ...over } = {}) {
  const calls = [];
  const io = {
    readPr: () => ({ headRefOid: head, labels: labels.map((name) => ({ name })), comments }),
    readSetting: () => ({ value: setting }),
    readRound: () => round,
    sendBack: (a) => { calls.push(['sendBack', a]); return { ok: true }; },
    appendSendBackEvent: async (a) => { calls.push(['ledger', a]); },
    fileCard: (input) => { calls.push(['card', input]); return { ok: true, session: 'red-team-card-x' }; },
    postComment: (a) => { calls.push(['comment', a]); },
    log: () => {},
    ...over,
  };
  return { io, calls };
}
const kinds = (calls) => calls.map((c) => c[0]);

describe('applyRedTeamGate', () => {
  it('broken → send-back through review-set-label (pinned to the head) + ledger event + gate record', async () => {
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
  it('a crashing gate is only a status', () => {
    const { io } = jobIo('accept', { runRedTeamGate: () => { throw new Error('boom'); } });
    const out = runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(out.redTeamGate).toMatchObject({ status: 'error', reason: expect.stringMatching(/boom/) });
  });
});
