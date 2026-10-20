import { beforeEach as beforeTimingFixture, afterEach as afterTimingFixture, vi as timingFixture } from 'vitest';
beforeTimingFixture(() => timingFixture.stubEnv('WE_RED_TEAM_TIMING', 'post-accept'));
afterTimingFixture(() => timingFixture.unstubAllEnvs());
/**
 * Card xyyuvyz — THE POST-ACCEPT RED TEAM RUNS ON EVERY HEAD THE PANEL ACCEPTS, ONCE PER HEAD. Live gap (PR #4722):
 * the red team broke head ea117e881, the PR was fixed, and the panel accepted the fixed head e125ac999 — but the PR
 * carried `review:human`, so the run reduced to `needs-human` (the human gate) and the job's accept-only gate skipped
 * the red team. No real process, model, git or GitHub call: every effect is a fake.
 */
import { describe, it, expect } from 'vitest';

import { createReviewJobIo, runReviewJob } from '../review-job.mjs';
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
    const root = mkdtempSync(join(tmpdir(), 'red-team-prior-row-'));
    try {
      const env = { CONVEYOR_STATE_ROOT: root, OPERATION_RUNS_DIR: join(root, 'runs') };
      writeRun(provenanceRun({ env, rows: [prior] }), env.OPERATION_RUNS_DIR);
      const { io, calls } = seatIo([prior]);
      const r = await runRedTeam({ pr: 4722, repo: REPO, lanePath: '/lane', loopPayload: advisoryAccept(HEAD_2), env }, io);
      expect(calls.some((c) => c[0] === 'reserve')).toBe(false);
      expect(r.status).not.toBe('not-owed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// Exercise the production run-store writer through both job paths, then the admission reader.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRun, writeRun } from '../run-store.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { readSavedRedTeamResult } from '../../lib/drain-saved-red-team.mjs';
import { provenanceRun, savedRowsHash } from '../../lib/__tests__/fixtures/saved-red-team-provenance.mjs';

it.each(['post-accept', 'panel-seat'])('persists and verifies review-job provenance for %s', timing => {
  const root = mkdtempSync(join(tmpdir(), 'review-job-provenance-'));
  try {
    const runsDir = join(root, 'runs');
    const env = { CONVEYOR_STATE_ROOT: root, OPERATION_RUNS_DIR: runsDir, WE_SHARED_RUNS_DIR: runsDir,
      WE_RED_TEAM_TIMING: timing };
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: REPO, pr: 4722, rev: HEAD_1,
      callId: 'owned-call', status: 'ok', recheckStatus: 'ok', findings: [], confirmedMissCount: 0 };
    const path = resolveScorecardStorePath(env);
    mkdirSync(dirname(path), { recursive: true });
    const rows = [{ ...row, v: 1, outcome: null, scoredAt: new Date(NOW).toISOString() }];
    writeFileSync(path, JSON.stringify({ records: rows }));
    const run = provenanceRun({ env, rows, id: 'review-pr-1' });
    delete run.findings.savedRedTeamResult;
    // Saving evidence cannot complete an unfinished run.
    const cursor = run.cursor;
    writeRun({ ...run, cursor: 0 }, runsDir);
    const { io } = jobIo(payload());
    const redTeam = { status: 'ran', rev: HEAD_1, callId: row.callId, seat: row,
      recheckStatus: 'ok', findings: [], comment: { status: 'withheld' } };
    const real = createReviewJobIo({ env, dir: join(root, 'jobs') });
    io.recordSavedRedTeamResult = real.recordSavedRedTeamResult;
    io.redTeamTimingSetting = () => ({ value: { timing }, sources: {}, invalid: [] });
    io.runRedTeam = () => redTeam;
    if (timing === 'panel-seat') {
      io.startSpeculativeRedTeam = () => ({ pid: 123, startedAt: NOW });
      io.speculativeReadSunk = () => true;
      io.awaitSpeculativeRedTeam = () => ({ spec: { status: 'speculated', rev: HEAD_1 } });
      io.finishSpeculativeRedTeam = () => redTeam;
      io.cleanupSpeculativeRedTeam = () => {};
    }
    runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    const saved = readRun(run.id, runsDir);
    expect(saved.findings.savedRedTeamResult).toEqual({ writer: 'review-job', references: [{ path, index: 0 }],
      sha256: savedRowsHash(rows) });
    const input = { repo: REPO, pr: 4722, head: HEAD_1, env, log: () => {} };
    expect(readSavedRedTeamResult(input)).toBeNull();
    writeRun({ ...saved, cursor }, runsDir);
    expect(readSavedRedTeamResult(input)).toMatchObject({ findings: [], recheckIncomplete: false });
    rows[0].privateNote = 'changed after attestation';
    writeFileSync(path, JSON.stringify({ records: rows }));
    expect(readSavedRedTeamResult(input)).toBeNull();
    // The job cannot attest a row modified before its attestation either.
    rows[0].findings = [{ confirmedByRecheck: true }];
    writeFileSync(path, JSON.stringify({ records: rows }));
    expect(() => real.recordSavedRedTeamResult({ runId: run.id, repo: REPO, pr: 4722, head: HEAD_1, redTeam }))
      .toThrow(/changed before attestation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


it.each(['missing', 'mismatched', 'valid'])('requires %s existing provenance for stored results without a seat payload', proof => {
  const root = mkdtempSync(join(tmpdir(), 'review-job-resumed-provenance-'));
  try {
    const env = { CONVEYOR_STATE_ROOT: root, OPERATION_RUNS_DIR: join(root, 'runs') };
    const rows = [{ dispatchKind: 'review-seat', seat: 'red-team', repo: REPO, pr: 4722, rev: HEAD_1,
      callId: 'saved-call', status: 'ok', findings: [], recheckStatus: 'ok', privateNote: 'included in hash' }];
    const path = resolveScorecardStorePath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ records: rows }));
    const run = provenanceRun({ env, rows, id: 'review-pr-resumed' });
    const real = createReviewJobIo({ env, dir: join(root, 'jobs') });
    for (const status of ['ran', 'resumed', 'already-ran']) {
      const originalProof = { writer: 'review-job', references: [{ path, index: 0 }],
        sha256: proof === 'mismatched' ? '0'.repeat(64) : savedRowsHash(rows) };
      if (proof === 'missing') delete run.findings.savedRedTeamResult;
      else run.findings.savedRedTeamResult = originalProof;
      writeRun(run, env.OPERATION_RUNS_DIR);
      real.recordSavedRedTeamResult({ runId: run.id, repo: REPO, pr: 4722, head: HEAD_1,
        redTeam: { status, callId: 'saved-call' } });
      expect(readRun(run.id, env.OPERATION_RUNS_DIR).findings.savedRedTeamResult)
        .toEqual(proof === 'missing' ? undefined : originalProof);
      const saved = readSavedRedTeamResult({ repo: REPO, pr: 4722, head: HEAD_1, env, log: () => {} });
      if (proof === 'valid') expect(saved).not.toBeNull();
      else expect(saved).toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 2026-10-20 — live #5729/#5752/#5485: in panel-seat mode a speculative pass the jurors' findings made `stale`
// was recorded as the red team's ERROR ("the speculative brief could not carry"), so the PR stayed
// red-team:pending. It must fall back to the sequential pass, exactly as the post-accept path does.
describe('panel-seat speculative fallback', () => {
  const RAN = { status: 'ran', foldedVerdict: 'accept', findings: [], recheckStatus: 'not-needed', comment: { status: 'posted' } };
  const EVIDENCE = { callId: 'prior-call', provider: 'codex', model: 'm', findings: [], recheckStatus: 'ok', foldedVerdict: 'accept', confirmedMissCount: 0 };
  const panelIo = ({ status, sequential, evidence = null }) => {
    const { io, calls } = jobIo(payload());
    io.redTeamTimingSetting = () => ({ value: { timing: 'panel-seat' }, sources: {}, invalid: [] });
    io.startSpeculativeRedTeam = () => ({ pid: 123, startedAt: NOW });
    io.speculativeReadSunk = () => true;
    io.awaitSpeculativeRedTeam = () => ({ spec: { status: 'speculated', rev: HEAD_1 } });
    io.finishSpeculativeRedTeam = () => ({ status, reason: 'the jurors raised 1 finding(s) the speculative brief could not carry' });
    io.recordDiscardedRedTeam = () => ({ status: 'recorded' });
    io.cleanupSpeculativeRedTeam = () => {};
    io.readPriorRedTeamEvidence = () => evidence;
    const statuses = [];
    io.redTeamStatus = (s) => statuses.push(s);
    io.runRedTeam = (input) => { calls.push(['red-team', input.loopPayload.findings.read.netBasis.rev]); return sequential; };
    return { io, calls, statuses };
  };

  it('stale runs the sequential red team and records its result', () => {
    const { io, calls, statuses } = panelIo({ status: 'stale', sequential: RAN });
    const out = runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(dispatched(calls)).toEqual([HEAD_1]);
    expect(calls.some(c => c[0] === 'gate')).toBe(true);
    expect(out.outcome).not.toBe('blocked-on-infra');
    expect(statuses.at(-1)).toMatchObject({ status: 'finished', result: expect.objectContaining({ status: 'ran' }) });
    expect(calls.some(c => c[0] === 'log' && /speculative pass stale; sequential pass → ran/.test(c[1]))).toBe(true);
  });

  it.each(['already-ran', 'resumed'])('superseded + sequential %s folds the verified prior row and runs the gate', seq => {
    const { io, calls, statuses } = panelIo({ status: 'superseded', sequential: { status: seq, callId: 'prior-call', rev: HEAD_1 }, evidence: EVIDENCE });
    const out = runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(calls.some(c => c[0] === 'gate')).toBe(true);
    expect(out.outcome).not.toBe('blocked-on-infra');
    expect(statuses.at(-1)).toMatchObject({ status: 'finished', result: expect.objectContaining({ status: 'ran', recheckStatus: 'ok' }) });
  });

  it('superseded + sequential already-ran with NO verified row stays an incomplete result (never folds to accept)', () => {
    const { io, calls } = panelIo({ status: 'superseded', sequential: { status: 'already-ran', callId: 'prior-call', rev: HEAD_1 } });
    const out = runReviewJob({ pr: 4722, repo: REPO, pid: 1 }, io);
    expect(calls.some(c => c[0] === 'gate')).toBe(false);
    expect(out.outcome).toBe('blocked-on-infra');
  });
});
