// @vitest-environment node
/** Card 6267 — the red-team-only job the drain's re-request starts. Every effect is a fake. */
import { describe, it, expect } from 'vitest';
import { runRedTeamOnlyJob } from '../review-job.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'e'.repeat(40);
const loopPayload = { runId: 'review-pr-1', verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: HEAD }, diffText: 'diff' } } };

function io({ live = HEAD, req = { repo: REPO, pr: 5283, head: HEAD, loopPayload }, redTeam = { status: 'ran', findings: [] } } = {}) {
  const calls = [];
  const it = {
    root: '/daemon', now: () => 1000, newActorId: () => 'actor', log: () => {},
    readRedTeamRequest: () => req,
    recordRedTeamRequestOutcome: (_p, o) => calls.push(['outcome', o.outcome]),
    readLiveHead: () => live,
    claim: () => ({ ok: true }), unclaim: () => calls.push(['unclaim']),
    acquireLane: () => ({ lanePath: '/lanes/lane-9' }), releaseLane: () => calls.push(['release']),
    redTeamStatus: s => calls.push(['status', s.status, s.result ?? null, s.loopPayload.findings.read.netBasis.rev]),
    runRedTeam: input => { calls.push(['runRedTeam', input.lanePath]); return redTeam; },
    runRedTeamGate: () => { calls.push(['gate']); return { status: 'ok', outcome: 'clean' }; },
    runLoop: () => { calls.push(['runLoop']); throw new Error('no panel'); },
    report: () => calls.push(['report']),
  };
  return { io: it, calls };
}

describe('runRedTeamOnlyJob', () => {
  it('runs the red team + gate on the recorded read for that head and records the status; no panel, no label', () => {
    const { io: x, calls } = io();
    const out = runRedTeamOnlyJob({ pr: 5283, repo: REPO, head: HEAD, requestPath: '/r.json' }, x);
    expect(out).toMatchObject({ outcome: 'ran', redTeam: { status: 'ran' } });
    expect(calls).toEqual([
      ['status', 'queued', null, HEAD], ['runRedTeam', '/lanes/lane-9'], ['gate'], ['status', 'finished', 'ran', HEAD],
      ['outcome', 'ran'], ['release'], ['unclaim']]);
  });
  it('refuses when the PR head has moved', () => {
    const { io: x, calls } = io({ live: 'f'.repeat(40) });
    expect(runRedTeamOnlyJob({ pr: 5283, repo: REPO, head: HEAD, requestPath: '/r.json' }, x)).toMatchObject({ outcome: 'head-moved' });
    expect(calls.some(c => c[0] === 'runRedTeam' || c[0] === 'status')).toBe(false);
  });
  it('refuses a request that does not match this repo, PR and head', () => {
    const { io: x, calls } = io({ req: { repo: REPO, pr: 1, head: HEAD, loopPayload } });
    expect(runRedTeamOnlyJob({ pr: 5283, repo: REPO, head: HEAD, requestPath: '/r.json' }, x)).toMatchObject({ outcome: 'refused' });
    expect(calls.some(c => c[0] === 'runRedTeam')).toBe(false);
  });
  it('a skipped/disabled runner status is recorded as error, never as a released hold', () => {
    for (const status of ['skipped', 'disabled', 'prior-row', undefined]) {
      const { io: x, calls } = io({ redTeam: status ? { status } : null });
      runRedTeamOnlyJob({ pr: 5283, repo: REPO, head: HEAD, requestPath: '/r.json' }, x);
      expect(calls).toContainEqual(['status', 'finished', 'error', HEAD]);
    }
  });
  it('re-checks the head after the lane wait and refuses if it moved', () => {
    const heads = [HEAD, 'f'.repeat(40)];
    const { io: x, calls } = io();
    x.readLiveHead = () => heads.shift();
    expect(runRedTeamOnlyJob({ pr: 5283, repo: REPO, head: HEAD, requestPath: '/r.json' }, x)).toMatchObject({ outcome: 'head-moved' });
    expect(calls.some(c => c[0] === 'runRedTeam' || c[0] === 'status')).toBe(false);
    expect(calls).toContainEqual(['release']);
  });
  it('an unusable run still writes its finished status (the drain keeps holding; the request is not a result)', () => {
    const { io: x, calls } = io({ redTeam: { status: 'error', reason: 'unparseable' } });
    expect(runRedTeamOnlyJob({ pr: 5283, repo: REPO, head: HEAD, requestPath: '/r.json' }, x)).toMatchObject({ outcome: 'ran', redTeam: { status: 'error' } });
    expect(calls).toContainEqual(['status', 'finished', 'error', HEAD]);
  });
});
