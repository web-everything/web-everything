/**
 * Card xyyuvyz — THE POST-ACCEPT RED TEAM RUNS ON EVERY HEAD THE PANEL ACCEPTS, ONCE PER HEAD. Live gap (PR #4722):
 * the red team broke head ea117e881, the PR was fixed, and the panel accepted the fixed head e125ac999 — but the PR
 * carried `review:human`, so the run reduced to `needs-human` (the human gate) and the job's accept-only gate skipped
 * the red team. No real process, model, git or GitHub call: every effect is a fake.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordRedTeamStatus, readDrainRedTeamEvidence } from '../../lib/drain-red-team-evidence.mjs';

import { runReviewJob } from '../review-job.mjs';
import { planRedTeamOnSkip, runRedTeamOnSkip } from '../../lib/review-red-team-on-skip.mjs';
import { redTeamEnqueueHold } from '../../lib/drain-queue-safety.mjs';
import { redTeamForHead } from '../../lib/red-team-gate.mjs';
import { redTeamOwedFor, runRedTeam } from '../review-extra-seats.mjs';

const REPO = 'web-everything/web-everything';
const HEAD_1 = 'e'.repeat(40);
const HEAD_2 = 'f'.repeat(40);
const NOW = Date.parse('2026-10-10T14:03:00Z');

const read = (rev) => ({
  title: 'fix the thing', body: 'Claims: adds a guard.', diffText: 'diff --git a/x.mjs b/x.mjs\n+export const f = (n) => 10 / n;\n',
  netChangedFiles: ['x.mjs'], netBasis: { base: 'b'.repeat(40), rev },
});
const ACCEPTS = { correctness: 'accept', security: 'accept', simplicity: 'accept' };
/** A `review-loop-cli --json` payload. `human: true` is the `review:human` advisory shape #4722 printed. */
const payload = ({ rev = HEAD_1, verdict = 'accept', human = false, lensVerdicts = ACCEPTS, stopped = 'complete', extra = {} } = {}) => ({
  runId: 'review-pr-1', stopped,
  verdict: {
    verdict, loop: { outcome: human ? 'escalated' : 'converged' },
    ...(human ? { humanRequired: true } : {}),
    lenses: Object.keys(lensVerdicts), lensVerdicts, findings: [], admittedFindings: [], ...extra,
  },
  findings: { read: read(rev), judge: { findings: [] }, judgeSecurity: { findings: [] } },
});
const advisoryAccept = (rev = HEAD_1) => payload({ rev, verdict: 'needs-human', human: true, stopped: 'confirm' });

function jobIo(loopPayload) {
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
    redTeamStatus: () => {},
    prepareLane: () => ({ head: 'a'.repeat(40) }),
    acquireLane: () => ({ lanePath: '/lanes/lane-7' }),
    runLoop: () => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' }),
    releaseLane: () => {},
    log: (l) => calls.push(['log', l]),
    runRedTeam: (input) => { calls.push(['red-team', input.loopPayload.findings.read.netBasis.rev]); return { status: 'ran', foldedVerdict: 'accept', findings: [], comment: { status: 'posted' } }; },
    runRedTeamGate: () => { calls.push(['gate']); return { status: 'ok', outcome: 'advisory' }; },
  };
  return { io, calls };
}
const dispatched = (calls) => calls.filter((c) => c[0] === 'red-team').map((c) => c[1]);

describe('redTeamOwedFor — which finished reviews owe the red team', () => {
  it('a recorded accept owes it', () => {
    expect(redTeamOwedFor(payload())).toBe(true);
  });

  it('a review:human ADVISORY accept (needs-human only because of the human gate, panel all accept) owes it', () => {
    expect(redTeamOwedFor(advisoryAccept())).toBe(true);
  });

  it('a review:human run whose panel did NOT accept does not', () => {
    expect(redTeamOwedFor(payload({ verdict: 'needs-human', human: true, lensVerdicts: { ...ACCEPTS, correctness: 'changes' } }))).toBe(false);
  });

  it('a needs-human with no human gate (e.g. a degraded read or a juror conflict) does not', () => {
    expect(redTeamOwedFor(payload({ verdict: 'needs-human' }))).toBe(false);
  });

  it('an advisory accept on an unpinned or degraded read does not (no head to key the pass by)', () => {
    const p = advisoryAccept();
    p.findings.read.netBasis.rev = null;
    expect(redTeamOwedFor(p)).toBe(false);
    const d = advisoryAccept();
    d.findings.read.degraded = true;
    expect(redTeamOwedFor(d)).toBe(false);
  });

  it('a review:human run with pending or blocked referrals does not', () => {
    expect(redTeamOwedFor(payload({ verdict: 'needs-human', human: true, extra: { pendingReferrals: ['k'] } }))).toBe(false);
    expect(redTeamOwedFor(payload({ verdict: 'needs-human', human: true, extra: { blockedReferrals: ['k'] } }))).toBe(false);
  });

  it('changes, prevention-outstanding and a missing payload do not', () => {
    expect(redTeamOwedFor(payload({ verdict: 'changes', lensVerdicts: { ...ACCEPTS, correctness: 'changes' } }))).toBe(false);
    expect(redTeamOwedFor(payload({ verdict: 'prevention-outstanding' }))).toBe(false);
    expect(redTeamOwedFor(null)).toBe(false);
  });
});

describe('runReviewJob — the red team runs on every accepted head', () => {
  it('a review:human advisory accept dispatches the red team for that head (#4722 e125ac999)', () => {
    const { io, calls } = jobIo(advisoryAccept(HEAD_2));
    const out = runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(out.outcome).toBe('parked');
    expect(dispatched(calls)).toEqual([HEAD_2]);
    expect(out.redTeam).toMatchObject({ status: 'ran' });
  });

  it('an accept on a NEW head after an earlier head was red-teamed dispatches again, for the new head', () => {
    const first = jobIo(payload({ rev: HEAD_1 }));
    runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, first.io);
    const second = jobIo(advisoryAccept(HEAD_2));
    runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, second.io);
    expect(dispatched(first.calls)).toEqual([HEAD_1]);
    expect(dispatched(second.calls)).toEqual([HEAD_2]);
  });

  it('a review:human run the panel did not accept never reaches the red team', () => {
    const { io, calls } = jobIo(payload({ verdict: 'needs-human', human: true, stopped: 'confirm', lensVerdicts: { ...ACCEPTS, security: 'changes' } }));
    runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(dispatched(calls)).toEqual([]);
  });
});

describe('runRedTeam — the pass itself honours the advisory accept and stays once per head', () => {
  const seatIo = (records) => {
    const calls = [];
    const io = {
      now: () => NOW,
      newId: (() => { let n = 0; return () => `call-${++n}`; })(),
      log: () => {},
      readRecords: () => records,
      reserveCalls: () => { calls.push(['reserve']); return { callIds: [], ledger: null }; },
      append: () => {},
      cliAvailable: () => true,
      listComments: () => [],
      postComment: (o) => calls.push(['post', o]),
    };
    return { io, calls };
  };

  it('a review:human advisory accept is not refused as not-owed', async () => {
    const { io, calls } = seatIo([]);
    const r = await runRedTeam({ pr: 4722, repo: REPO, lanePath: '/lane', loopPayload: advisoryAccept(HEAD_2), env: {} }, io);
    expect(r.status).not.toBe('not-owed');
    expect(calls.some((c) => c[0] === 'reserve')).toBe(true);
  });

  it('the same head is never run twice: a prior clean row for (pr, head) resumes without a new model call', async () => {
    const prior = {
      v: 1, dispatchKind: 'review-seat', seat: 'red-team', lens: 'red-team', pr: 4722, repo: REPO, rev: HEAD_2,
      redTeamCallId: 'call-0', status: 'ok', provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept', confirmedMissCount: 0,
      scoredAt: new Date(NOW).toISOString(),
    };
    const { io, calls } = seatIo([prior]);
    const r = await runRedTeam({ pr: 4722, repo: REPO, lanePath: '/lane', loopPayload: advisoryAccept(HEAD_2), env: {} }, io);
    expect(calls.some((c) => c[0] === 'reserve')).toBe(false);
    expect(r.status).not.toBe('not-owed');
  });
});

describe('failed red-team recovery (#6096)', () => {
  const failed = { status: 'failed', reason: 'provider quota exhausted', findings: [],
    foldedVerdict: 'needs-human', comment: { status: 'not-posted' } };
  const evidence = { loopPayload: payload(), inFlight: false, queued: false, recorded: true,
    seatRecorded: true, completedRecorded: false, failedSeatCount: 1 };
  const recovery = (over = {}) => ({ repo: REPO,
    refusals: [{ kind: 'already-reviewed-head', prNumber: 4722, headSha: HEAD_1 }],
    rawPrs: [{ number: 4722, headRefOid: HEAD_1, comments: [], reviews: [], labels: ['review:accepted'] }],
    readEvidence: () => evidence, readStatus: () => ({ status: 'finished', result: failed }),
    now: NOW, lastDispatch: new Map(), setting: { enabled: true, retryCooldownMin: 30 }, ...over });

  it('persists failed and settles the failure reason without an unpublished claim or clear', () => {
    const { io } = jobIo(payload());
    const settlements = [], statuses = [];
    io.runRedTeam = () => failed;
    io.settleRedTeamSkip = input => { settlements.push(input.redTeam); return { outcome: 'non-policy' }; };
    io.redTeamStatus = input => statuses.push(input);
    const result = runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(result.redTeam).toMatchObject({ status: 'failed', reason: failed.reason, outcome: 'non-policy' });
    expect(settlements).toEqual([failed]);
    expect(statuses.at(-1)).toMatchObject({ status: 'finished', result: 'failed' });
    expect(redTeamForHead([], 4722, HEAD_1)).toBeFalsy();
  });

  it('drain evidence never credits a failed seat as a completed pass or creates a clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-failed-drain-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    try {
      recordRedTeamStatus({ repo: REPO, pr: 4722, loopPayload: payload(), status: 'finished', result: 'failed' }, { env });
      const read = readDrainRedTeamEvidence({ repo: REPO, pr: 4722, head: HEAD_1, env,
        list: () => [], readScorecards: () => [{ dispatchKind: 'review-seat', seat: 'red-team',
          repo: REPO, pr: 4722, rev: HEAD_1, status: 'timeout' }] });
      expect(read).toMatchObject({ completedRecorded: false, failedSeatCount: 1, inFlight: false,
        status: { result: 'failed' } });
      expect(redTeamEnqueueHold({ ...read, comments: [], repo: REPO, pr: 4722, head: HEAD_1,
        env: { WE_RED_TEAM_SKIP_CARD_ONLY: '0' } })).toBe('post-accept red team has no recorded result on the live head');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['failed', { status: 'failed' }, 'ran', { status: 'ran' }])('schedules one fresh retry, then observes cooldown: %s', result => {
    const inputs = recovery({ readStatus: () => ({ status: 'finished', result }) });
    const dispatches = [];
    const run = () => runRedTeamOnSkip({ ...inputs, plan: { refusals: inputs.refusals },
      now: () => NOW, capacity: { lanes: 2, liveReviews: 0, maxLive: 2 },
      readCarry: () => null, dispatch: input => { dispatches.push(input); return { jobPid: 123 }; } });
    expect(run().rows[0]).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    expect(run().rows[0]).toMatchObject({ action: 'skip', why: 'retry cooldown active' });
    expect(dispatches).toHaveLength(1);
  });

  it.each([
    { readStatus: () => ({ status: 'finished', result: 'failed', retryCount: 1 }) },
    { readEvidence: () => ({ ...evidence, failedSeatCount: 2 }) },
    { readEvidence: () => ({ ...evidence, completedRecorded: true }) },
    { setting: { enabled: false, retryCooldownMin: 30 } },
  ])('refuses retries with spent, contradictory, or disabled evidence: %s', overrides => {
    expect(planRedTeamOnSkip(recovery(overrides))[0].action).toBe('skip');
  });
});
