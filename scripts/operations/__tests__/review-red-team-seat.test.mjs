// @vitest-environment node
/** #6212: effects are injected; no model, process, Git or GitHub invocation. */
import { describe, expect, it } from 'vitest';
import { runReviewJob } from '../review-job.mjs';
import { finishSpeculativeRedTeam, speculateRedTeam, runRedTeam, reserveSeatCalls } from '../review-extra-seats.mjs';
import { planRedTeamActions, parseRedTeamComment } from '../../lib/red-team-gate.mjs';

const REPO = 'web-everything/web-everything', HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-17T12:00:00Z');
const POLICY = { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' };
const read = () => ({ title: 'guard input', body: 'Claims: guard input', netChangedFiles: ['x.mjs'],
  diffText: 'diff --git a/x.mjs b/x.mjs\n+export const f = n => 10 / n;\n',
  netBasis: { base: 'b'.repeat(40), rev: HEAD } });
const payload = verdict => ({ runId: 'review-pr-6212', stopped: 'complete',
  verdict: { verdict, loop: { outcome: 'converged' } },
  findings: { read: read(), judge: { findings: [] }, judgeSecurity: { findings: [] } } });
const result = findings => ({ status: 'ran', rev: HEAD, findings, recheckStatus: 'ok',
  foldedVerdict: findings.some(f => f.confirmedByRecheck) ? 'changes' : 'accept',
  confirmedMissCount: findings.filter(f => f.confirmedByRecheck).length, comment: { status: 'posted' } });

// New injection seam mirrors speculativeRedTeamSetting: returns the timing cascade result.
function job({ timing = 'panel-seat', verdict = 'accept', speculative = true, findings = [] } = {}) {
  const events = [], statuses = [], reports = [];
  const pass = { status: 'speculated', rev: HEAD, callId: 'call-1', findings,
    timings: { startedAt: NOW, readAt: NOW + 1, finishedAt: NOW + 2 } };
  const io = {
    root: '/daemon', now: () => NOW, newActorId: () => 'actor', readPrevCompletion: () => null,
    claim: () => ({ ok: true }), updateRecord: () => {}, unclaim: () => {},
    report: row => { reports.push(row); if (row.status === 'done') events.push('done'); },
    acquireLane: () => ({ lanePath: '/lanes/lane-7' }), releaseLane: () => events.push('release'),
    log: line => events.push(line),
    redTeamTimingSetting: () => ({ value: { timing }, sources: { timing: 'env' }, invalid: [] }),
    speculativeRedTeamSetting: () => ({ value: speculative ? 'on' : 'off', enabled: speculative, source: 'standard', invalid: [] }),
    startSpeculativeRedTeam: () => { events.push('start-seat'); return { pid: 4242, readSink: '/jobs/read.json', startedAt: NOW }; },
    runLoop: input => { events.push(['jurors', input.readSink]); return { status: 0, stdout: JSON.stringify(payload(verdict)), stderr: '' }; },
    speculativeReadSunk: () => true,
    awaitSpeculativeRedTeam: () => { events.push('await-seat'); return { spec: pass, waitedMs: 0 }; },
    finishSpeculativeRedTeam: input => {
      events.push(['save-seat', input.loopPayload.findings.read.netBasis.rev]); return result(findings);
    },
    cancelSpeculativeRedTeam: () => { events.push('cancel'); return { spec: pass }; },
    recordDiscardedRedTeam: () => { events.push('discard'); return { status: 'recorded' }; },
    cleanupSpeculativeRedTeam: () => {},
    redTeamStatus: row => statuses.push(row),
    runRedTeam: () => { events.push('post-accept-pass'); return result(findings); },
    runRedTeamGate: () => {
      // The existing gate must be reused inline for a block/card, never scheduled after completion.
      events.push('gate');
      const plan = planRedTeamActions({ findings: findings.map((f, index) => ({ index: index + 1,
        confirmed: f.confirmedByRecheck, impact: f.impactIfUnfixed })) }, POLICY);
      return { status: 'applied', outcome: plan.sendBack.length ? 'sent-back' : plan.card.length ? 'card-queued' : 'advisory', plan };
    },
  };
  return { io, events, statuses, reports };
}

describe('red team as an adversarial panel seat', () => {
  it.each(['accept', 'changes', 'needs-human'])('starts beside jurors and retains main acceptance gate for %s', verdict => {
    const h = job({ verdict });
    const out = runReviewJob({ pr: 6212, repo: REPO, pid: 1 }, h.io);
    expect(h.events.indexOf('start-seat')).toBeLessThan(h.events.findIndex(e => Array.isArray(e) && e[0] === 'jurors'));
    expect(h.events).toContainEqual(['jurors', '/jobs/read.json']);
    if (verdict === 'accept') {
      expect(h.events).toContainEqual(['save-seat', HEAD]);
      expect(h.events).not.toContain('discard');
      expect(h.events).not.toContain('cancel');
      expect(out.redTeam).toMatchObject({ status: 'ran' });
    } else {
      expect(h.events).toContain('cancel');
      expect(h.events).toContain('discard');
      expect(h.events).not.toContainEqual(['save-seat', HEAD]);
    }
    if (verdict === 'accept') expect(h.statuses).toContainEqual(expect.objectContaining({ status: 'finished',
      loopPayload: expect.objectContaining({ findings: expect.objectContaining({ read: expect.objectContaining({ netBasis: expect.objectContaining({ rev: HEAD }) }) }) }),
      result: expect.objectContaining({ status: 'ran' }) }));
    else { expect(h.statuses).toEqual([]); expect(h.events).not.toContain('gate'); }
  });

  it('panel-seat still starts alongside jurors when the old speculative optimization is off', () => {
    const h = job({ speculative: false });
    runReviewJob({ pr: 6212, repo: REPO, pid: 1 }, h.io);
    expect(h.events).toContain('start-seat');
    expect(h.events).not.toContain('post-accept-pass');
  });

  it('finishes the seat before completing the review and schedules no post-accept gate', () => {
    const h = job();
    runReviewJob({ pr: 6212, repo: REPO, pid: 1 }, h.io);
    expect(h.events).not.toContain('post-accept-pass');
    const saved = h.events.findIndex(e => Array.isArray(e) && e[0] === 'save-seat');
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(saved).toBeLessThan(h.events.indexOf('done'));
    expect(saved).toBeLessThan(h.events.indexOf('release'));
    expect(h.events.slice(h.events.indexOf('done') + 1)).not.toContain('gate');
  });

  it.each([
    ['broken', true, true], ['degraded', true, false], ['broken', false, false],
  ])('%s confirmed=%s: blocks only a confirmed BROKEN finding', (impactIfUnfixed, confirmedByRecheck, blocks) => {
    const h = job({ findings: [{ summary: 'input violates claim', impactIfUnfixed, confirmedByRecheck }] });
    const out = runReviewJob({ pr: 6212, repo: REPO, pid: 1 }, h.io);
    expect(out.redTeam).toMatchObject({ status: 'ran' });
    if (blocks) {
      expect(out.verdict).toBe('changes');
      expect(out.outcome).toBe('bounced');
      expect(out.redTeamGate).toMatchObject({ outcome: 'sent-back' });
      expect(h.events.indexOf('gate')).toBeLessThan(h.events.indexOf('done'));
      expect(h.reports.filter(r => r.status === 'done')).toEqual([expect.objectContaining({ outcome: 'bounced' })]);
    } else {
      expect(out.verdict).toBe('accept');
      expect(out.outcome).toBe('auto-cleared');
      expect(out.redTeamGate?.outcome).not.toBe('sent-back');
    }
  });

  it('logs the resolved timing source in the job', () => {
    const h = job(); runReviewJob({ pr: 6212, repo: REPO, pid: 1 }, h.io);
    expect(h.events.some(e => typeof e === 'string' && e.includes('policy-cascade · redTeam: timing="panel-seat" (env)'))).toBe(true);
  });

  it('post-accept rollback retains the sequential pass, gate and non-accept discard', () => {
    const h = job({ timing: 'post-accept', speculative: false });
    expect(runReviewJob({ pr: 6212, repo: REPO, pid: 1 }, h.io).outcome).toBe('auto-cleared');
    expect(h.events).toContain('post-accept-pass');
    expect(h.events.indexOf('post-accept-pass')).toBeGreaterThan(h.events.indexOf('done'));
    expect(h.events.indexOf('gate')).toBeGreaterThan(h.events.indexOf('post-accept-pass'));
    const rejected = job({ timing: 'post-accept', verdict: 'changes' });
    runReviewJob({ pr: 6212, repo: REPO, pid: 1 }, rejected.io);
    expect(rejected.events).toContain('discard');
    expect(rejected.events).not.toContain('post-accept-pass');
    expect(rejected.events).not.toContain('gate');
  });
});

describe('panel seat persists through the real speculative completion path', () => {
  it.each(['accept', 'changes', 'needs-human'])('requires an owed review before finishing %s', async verdict => {
    const rows = [], comments = [], statuses = [];
    let n = 0, ledger;
    const io = {
      now: () => NOW, newId: () => `call-${++n}`, log: () => {}, readRecords: () => rows.slice(),
      reserveCalls: ({ provider, want, dailyCap, now }) => {
        const reservation = reserveSeatCalls({ ledger, records: [], provider, want, dailyCap, now, newId: io.newId });
        ledger = reservation.ledger; return reservation;
      },
      cliAvailable: provider => provider === 'codex', makeScratch: () => '/fake/scratch',
      removeScratch: () => {}, writeFile: () => {}, readHeadMessage: () => 'guard input',
      runSeat: async () => ({ report: { exitCode: 0, lastMessage: JSON.stringify({ lenses: { 'red-team': { verdict: 'accept', findings: [] } } }) } }),
      runRecheck: async () => ({ checks: [] }), append: row => rows.push(row), logTrial: row => row,
      listComments: () => [], postComment: row => comments.push(row), redTeamStatus: row => statuses.push(row),
    };
    const env = { WE_RED_TEAM_TIMING: 'panel-seat' };
    if (verdict === 'accept') {
      const baseRunSeat = io.runSeat;
      io.runSeat = async (...args) => {
        expect(statuses).toContainEqual({ repo: REPO, pr: 6212, loopPayload: { findings: { read: read() } }, status: 'running' });
        return baseRunSeat(...args);
      };
      expect((await runRedTeam({ pr: 6212, repo: REPO, lanePath: '/lane', loopPayload: payload('accept'), env }, io)).status).toBe('ran');
      rows.length = 0; comments.length = 0; statuses.length = 0;
      io.runSeat = baseRunSeat;
    }
    const pass = await speculateRedTeam({ pr: 6212, repo: REPO, lanePath: '/lane', read: read(), env, resume: false }, io);
    expect(pass.status).toBe('speculated');
    const statusesBeforeFinish = statuses.slice();
    const out = await finishSpeculativeRedTeam({ pr: 6212, repo: REPO, loopPayload: payload(verdict), pass, env }, io);
    if (verdict !== 'accept') {
      expect(out.status).toBe('not-owed');
      expect(rows).toEqual([]); expect(comments).toEqual([]); expect(statuses).toEqual(statusesBeforeFinish);
      return;
    }
    expect(out.status).toBe('ran');
    expect(rows).toContainEqual(expect.objectContaining({ dispatchKind: 'review-seat', seat: 'red-team', repo: REPO, pr: 6212, rev: HEAD, status: 'ok', findings: [] }));
    if (verdict === 'accept') {
      expect(statuses).toContainEqual(expect.objectContaining({ status: 'finished', result: 'ran' }));
      expect(comments).toHaveLength(1);
      expect(parseRedTeamComment(comments[0].body)).toMatchObject({ pr: 6212, rev: HEAD, findings: [] });
    } else {
      expect(statuses).toEqual([]);
      expect(comments).toEqual([]);
    }
  });
});

it.each(['changes', 'needs-human'])('a %s panel result cannot route a red-team send-back', verdict => {
  const h = job({ verdict, findings: [{ summary: 'confirmed break', confirmedByRecheck: true, impactIfUnfixed: 'broken' }] });
  const out = runReviewJob({ pr: 6212, repo: REPO, pid: 1 }, h.io);
  expect(h.events).not.toContainEqual(['save-seat', HEAD]);
  expect(h.events).toContain('cancel');
  expect(h.events).not.toContain('gate');
  expect(h.statuses).toEqual([]);
  expect(out.verdict).toBe(verdict);
});
