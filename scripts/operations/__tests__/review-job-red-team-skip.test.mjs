// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { settleRedTeamSkip } from '../../lib/red-team-skip-outcome.mjs';
import { publishAttention, replay } from '../needs-you-feed.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReviewJob, createReviewJobIo, redTeamRunnerArgs } from '../review-job.mjs';
import { decodeRecoveryAdmission, readDrainRedTeamEvidence, readRedTeamStatus, recordRedTeamStatus, readRecoveryWitness, redTeamStatusDir } from '../../lib/drain-red-team-evidence.mjs';
import { failedRedTeamRetry } from '../../lib/red-team-run-result.mjs';
import { normalizeRedTeamResult, planRedTeamOnSkip, redTeamSkipNeedsSettlement, planRedTeamRecovery, abandonStaleRedTeamRun, recoveryProbe } from '../../lib/review-red-team-on-skip.mjs';
import { newRunRecord, writeRun } from '../run-store.mjs';
import { redTeamOwedOnHead } from '../../lib/review-red-team-policy.mjs';
import { planRedTeamStatusLabels } from '../../lib/red-team-status-labels.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { createRedTeamIo, speculateRedTeam, runRedTeam } from '../review-extra-seats.mjs';
import { execFileSync } from 'node:child_process';
import { readRedTeamCarry } from '../../lib/red-team-carry-machine.mjs';
import { createRedTeamCarryIo } from '../../lib/red-team-carry-io.mjs';
import { emptyDiffExemptionEvidence } from '../../lib/red-team-empty-net-diff.mjs';
import { emptyDiffFixture } from '../../lib/__tests__/red-team-empty-net-diff-fixture.mjs';

const repo = 'web-everything/web-everything', pr = 5872, head = 'a'.repeat(40);
const emptySkip = { status: 'skipped', policy: 'empty-net-diff', reason: 'red team skipped: empty net diff' };
const skipped = { status: 'skipped', policy: 'card-only', reason: 'red team skipped: card-only' };
const payload = () => ({ runId: 'review-pr-skip', stopped: 'complete',
  verdict: { verdict: 'accept', loop: { outcome: 'converged' }, findings: [], admittedFindings: [] },
  findings: { read: { title: 'Update card', body: '', diffText: 'diff --git a/backlog/5872.md b/backlog/5872.md\n+update\n',
    netChangedFiles: ['backlog/5872.md'], netRenameSources: [], netBasis: { rev: head } } },
});

function fixture(redTeam = skipped) {
  const loopPayload = payload(), events = [];
  const lanePath = join(tmpdir(), 'review-job-red-team-skip-lane');
  const io = {
    root: process.cwd(), now: () => 1_000, newActorId: () => 'actor',
    readPrevCompletion: () => null, claim: () => ({ ok: true }), updateRecord: vi.fn(), unclaim: vi.fn(),
    acquireLane: () => ({ lanePath }), releaseLane: vi.fn(), prepareLane: () => ({ head }),
    report: vi.fn(), log: vi.fn(),
    runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' })),
    readRedTeamOnlyPayload: () => ({ head, loopPayload }), fetchRedTeamHead: () => ({ head }),
    runExtraSeats: vi.fn(), speculativeRedTeamSetting: () => ({ enabled: false }),
    runRedTeam: vi.fn(() => { events.push('red-team'); return redTeam; }),
    settleRedTeamSkip: vi.fn(() => { events.push('settle'); return { outcome: 'policy-clear' }; }),
    runRedTeamGate: vi.fn(() => { events.push('gate'); return { status: 'ok', outcome: 'advisory' }; }),
    redTeamStatus: vi.fn(({ status }) => { events.push(status); }), clearRedTeamQueued: vi.fn(),
  };
  return { io, events, loopPayload };
}

describe('review-job red-team skip settlement', () => {
  it.each([
    [emptySkip, emptySkip],
    [{ status: 'skipped', policy: 'card-only' }, { status: 'skipped', policy: 'card-only' }],
    [{ status: 'skipped', reason: 'quota exhausted' }, { status: 'skipped' }],
    [{ status: 'skipped', policy: 'other' }, { status: 'skipped' }],
    ...['ran', 'resumed', 'error', 'disabled', 'not-owed'].map(status => [{ status }, status]),
  ])('persists skip provenance and keeps other outcomes as strings: %j', (redTeam, result) => {
    const f = fixture(redTeam);
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.redTeamStatus.mock.calls.filter(([row]) => row.status === 'finished').map(([row]) => row.result))
      .toEqual([result]);
  });

  it.each(['deferredByGuard', 'deferredByCap'])('summary does not preserve contradictory policy provenance with %s', flag => {
    const f = fixture({ status: 'skipped', policy: 'card-only', [flag]: true });
    f.io.settleRedTeamSkip.mockReturnValue({ outcome: 'non-policy' });
    const out = runReviewJob({ repo, pr }, f.io);
    expect(out.redTeam).toMatchObject({ status: 'skipped', [flag]: true, outcome: 'non-policy' });
    expect(out.redTeam).not.toHaveProperty('policy');
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('real persisted skip survives drain reads and recovery admission (policy=%s)', cardOnly => {
    const root = mkdtempSync(join(tmpdir(), 'skip-provenance-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_SKIP_CARD_ONLY: '1', WE_RED_TEAM_STATUS_LABELS: '0' };
    const key = { repo, pr, head, env };
    const readEvidence = () => readDrainRedTeamEvidence({ ...key, list: () => [], readScorecards: () => [] });
    const production = createReviewJobIo({ env, readEvidence, readSeatRecords: () => [], readWitness: key => readRecoveryWitness({ ...key, env, readScorecards: () => [] }) });
    const f = fixture(cardOnly ? skipped : { status: 'skipped', reason: 'quota exhausted' });
    f.io.redTeamStatus = production.redTeamStatus;
    try {
      runReviewJob({ repo, pr }, f.io);
      const stored = readRedTeamStatus(key);
      expect(stored.result).toEqual(cardOnly ? skipped : { status: 'skipped' });
      expect(normalizeRedTeamResult(stored.result)).toEqual({ priorResult: 'skipped', priorComment: undefined });
      expect(redTeamSkipNeedsSettlement(stored)).toBe(cardOnly);
      expect(readEvidence()).toMatchObject({ loopPayload: f.loopPayload, scheduled: false, recorded: false, inFlight: false, skipCardOnly: true });
      writeRun({ ...newRunRecord({ id: 'review-pr-skip', op: 'review-pr', input: { repo, pr } }), ...f.loopPayload }, env.WE_SHARED_RUNS_DIR);
      if (!cardOnly) {
        const admission = production.redTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'queued', redTeamMode: 'fresh' });
        expect(admission.redTeamAdmission.retrySpent).toBe(true);
        expect(readRedTeamStatus(key).retryCount).toBe(1);
        expect(() => production.redTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'queued', redTeamMode: 'fresh' })).toThrow();
        return;
      }
      const admission = production.redTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'queued', redTeamMode: 'fresh' });
      expect(admission.redTeamAdmission.prior).toEqual(cardOnly ? null : {
        repo, pr, head, status: 'finished', result: { status: 'skipped' },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['accept', 'advisory', 'missing-read', 'mismatched-rev', 'missing-verdict', 'degraded-advisory'])
  ('serialized non-policy skip recovery launches one seat only with intact pinned evidence (%s)', async variant => {
    const root = mkdtempSync(join(tmpdir(), 'skip-runner-admission-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_STATUS_LABELS: '0',
      WE_REVIEW_RED_TEAM: '1', WE_REVIEW_EXTRA_SEATS: '1', WE_RED_TEAM_SKIP_CARD_ONLY: '0' };
    const key = { repo, pr, head, env }, loopPayload = payload();
    Object.assign(loopPayload.findings.read, {
      netChangedFiles: ['scripts/example.mjs'],
      diffText: 'diff --git a/scripts/example.mjs b/scripts/example.mjs\n+export const value = 1;\n',
    });
    if (variant === 'advisory' || variant === 'degraded-advisory') Object.assign(loopPayload.verdict, {
      verdict: 'needs-human', humanRequired: true,
      lensVerdicts: { correctness: 'accept', security: 'accept' },
    });
    const readEvidence = () => readDrainRedTeamEvidence({ ...key, list: () => [], readScorecards: () => [] });
    const production = createReviewJobIo({ env, readEvidence, readSeatRecords: () => [] });
    const io = {
      now: () => 1_000, log: vi.fn(), readRecords: vi.fn(() => []), readRecoveryComments: () => [],
      readRedTeamStatus: () => readRedTeamStatus(key),
      cliAvailable: vi.fn(provider => provider === 'codex'),
      reserveCalls: vi.fn(() => ({ used: 0, callIds: ['skip-retry-seat'] })),
      makeScratch: () => root, removeScratch: vi.fn(), writeFile: vi.fn(), readHeadMessage: () => '',
      runSeat: vi.fn(async () => ({ report: { lastMessage: JSON.stringify({
        lenses: { 'red-team': { verdict: 'accept', findings: [] } },
      }) } })),
      runRecheck: vi.fn(),
    };
    try {
      writeRun({ ...newRunRecord({ id: loopPayload.runId, op: 'review-pr', input: { repo, pr } }), ...loopPayload }, env.WE_SHARED_RUNS_DIR);
      production.redTeamStatus({ repo, pr, loopPayload, status: 'finished', result: { status: 'skipped' } });
      const { redTeamAdmission } = production.redTeamStatus({ repo, pr, loopPayload, status: 'queued', redTeamMode: 'fresh' });
      expect(redTeamAdmission.retrySpent).toBe(true);
      expect(readRedTeamStatus(key).retryCount).toBe(1);
      // Mirror the production runner's file/argv boundary, then its CLI decoder.
      const admissionFile = join(root, 'admission.json');
      writeFileSync(admissionFile, JSON.stringify(redTeamAdmission));
      const args = redTeamRunnerArgs({ repo, pr, lanePath: root, loopFile: join(root, 'loop.json'),
        redTeamMode: 'fresh', redTeamAdmission: admissionFile });
      const file = args.find(arg => arg.startsWith('--red-team-admission=')).slice('--red-team-admission='.length);
      const decoded = decodeRecoveryAdmission(readFileSync(file, 'utf8'));
      // Corrupt only the prior; the current review still owes a pass on this head.
      if (variant === 'missing-read') delete decoded.prior.loopPayload?.findings?.read;
      if (variant === 'mismatched-rev' && decoded.prior.loopPayload) decoded.prior.loopPayload.findings.read.netBasis.rev = 'b'.repeat(40);
      if (variant === 'missing-verdict') delete decoded.prior.loopPayload?.verdict;
      if (variant === 'degraded-advisory' && decoded.prior.loopPayload) decoded.prior.loopPayload.findings.read.degraded = true;
      const eligible = variant === 'accept' || variant === 'advisory';
      expect(failedRedTeamRetry(decoded.prior, { failedSeatCount: 0, completedRecorded: false })).toBe(eligible);
      const input = { repo, pr, lanePath: root, loopPayload, env, post: false, record: false,
        redTeamMode: 'fresh', redTeamAdmission: decoded };
      const result = await runRedTeam(input, io);
      if (!eligible) {
        expect(result).toMatchObject({ status: 'not-owed', deferredByGuard: true,
          reason: expect.stringContaining('red-team retry already spent') });
        expect(io.cliAvailable).not.toHaveBeenCalled();
        expect(io.reserveCalls).not.toHaveBeenCalled();
        expect(io.runSeat).not.toHaveBeenCalled();
        return;
      }
      expect(decoded.prior.loopPayload).toEqual({ verdict: loopPayload.verdict, findings: { read: loopPayload.findings.read } });
      expect(result.status).toBe('ran');
      expect(io.runSeat).toHaveBeenCalledOnce();
      expect(io.reserveCalls).toHaveBeenCalledOnce();
      // Even without seat rows, losing the retry's result cannot replenish its budget.
      production.redTeamStatus({ repo, pr, loopPayload, status: 'finished', result: { status: 'skipped' } });
      expect(readRedTeamStatus(key).retryCount).toBe(1);
      expect(() => production.redTeamStatus({ repo, pr, loopPayload, status: 'queued', redTeamMode: 'fresh' })).toThrow();
      expect(await runRedTeam({ ...input, redTeamAdmission: undefined }, io)).toMatchObject({
        status: 'not-owed', deferredByGuard: true, reason: expect.stringContaining('red-team retry already spent'),
      });
      expect(io.runSeat).toHaveBeenCalledOnce();
      expect(io.reserveCalls).toHaveBeenCalledOnce();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('queued admission preserves string resumed so a crashed worker can recover its finished result', () => {
    const root = mkdtempSync(join(tmpdir(), 'resumed-admission-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_STATUS_LABELS: '0' };
    const key = { repo, pr, head, env };
    const readEvidence = () => ({ inFlight: false, queued: false });
    const readWitness = key => readRecoveryWitness({ ...key, env, readScorecards: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }] });
    const probe = { ...recoveryProbe(), isAlive: () => false };
    const production = createReviewJobIo({ env, readWitness, recoveryProbe: probe });
    const loopPayload = payload();
    try {
      writeRun({ ...newRunRecord({ id: 'review-pr-skip', op: 'review-pr', input: { repo, pr } }), ...loopPayload }, env.WE_SHARED_RUNS_DIR);
      production.redTeamStatus({ repo, pr, loopPayload, status: 'finished', result: 'resumed' });
      const admission = production.redTeamStatus({ repo, pr, loopPayload, status: 'queued', redTeamMode: 'resume' });
      expect(admission.priorResult).toBe('resumed');
      expect(admission.redTeamAdmission.prior).toMatchObject({ status: 'finished', result: 'resumed' });
      expect(readRedTeamStatus(key)).toMatchObject({ status: 'queued', pid: process.pid, result: 'resumed' });
      expect(planRedTeamRecovery(readWitness(key), { now: Date.now(), probe, deadlineMs: 7200000 }).executionPrior)
        .toMatchObject({ status: 'finished', result: 'resumed' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('fresh guard refuses a finished null prior without queued provenance (admitted=%s)', async admitted => {
    const loopPayload = payload();
    loopPayload.findings.read.netChangedFiles = ['scripts/example.mjs'];
    const prior = { repo, pr, head, status: 'finished', result: null };
    const io = {
      now: () => 1_000, log: vi.fn(),
      readRecords: () => [], readRecoveryComments: () => [],
      readRedTeamStatus: () => admitted ? { status: 'queued', pid: 42, result: null } : prior,
      cliAvailable: vi.fn(() => { throw Error('provider reached'); }),
      reserveCalls: vi.fn(), runSeat: vi.fn(), runRecheck: vi.fn(),
    };
    const queued = { repo, pr, head, status: 'queued', pid: 42, result: null };
    io.readRedTeamStatus = () => admitted ? queued : prior;
    const result = await runRedTeam({ repo, pr, loopPayload, redTeamMode: 'fresh',
      env: { WE_REVIEW_RED_TEAM: '1', WE_REVIEW_EXTRA_SEATS: '1', WE_RED_TEAM_SKIP_CARD_ONLY: '0' },
      ...(admitted ? { redTeamAdmission: { schema: 1, pid: 42, queued, prior } } : {}),
    }, io);
    expect(result).toMatchObject({ status: 'not-owed', deferredByGuard: true,
      reason: expect.stringContaining('prior red-team status; not re-run') });
    for (const hook of ['cliAvailable', 'reserveCalls', 'runSeat', 'runRecheck']) expect(io[hook]).not.toHaveBeenCalled();
  });

  it.each(['finished', 'queued'])('fresh admission preserves unknown null completion but recovers a dead queued writer (prior=%s)', async status => {
    const root = mkdtempSync(join(tmpdir(), 'null-admission-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_STATUS_LABELS: '0',
      WE_REVIEW_RED_TEAM: '1', WE_REVIEW_EXTRA_SEATS: '1', WE_RED_TEAM_SKIP_CARD_ONLY: '0' };
    const key = { repo, pr, head, env };
    const loopPayload = payload();
    loopPayload.findings.read.netChangedFiles = ['scripts/example.mjs'];
    try {
      writeRun({ ...newRunRecord({ id: 'review-pr-skip', op: 'review-pr', input: { repo, pr } }), ...loopPayload }, env.WE_SHARED_RUNS_DIR);
      const readWitness = key => readRecoveryWitness({ ...key, env, readScorecards: () => [] });
      const probe = { ...recoveryProbe(), isAlive: () => false };
      const production = createReviewJobIo({ env, readWitness, recoveryProbe: probe });
      production.redTeamStatus({ repo, pr, loopPayload, status, result: null });
      if (status === 'finished') {
        const before = readRedTeamStatus(key);
        expect(() => production.redTeamStatus({ repo, pr, loopPayload, status: 'queued', redTeamMode: 'fresh' })).toThrow('prior pass cannot restart');
        expect(readRedTeamStatus(key)).toEqual(before); return;
      }
      expect(abandonStaleRedTeamRun(key, { readWitness: () => readWitness(key), probe }).ok).toBe(true);
      const { redTeamAdmission } = production.redTeamStatus({ repo, pr, loopPayload, status: 'queued', redTeamMode: 'fresh' });
      expect(redTeamAdmission.prior).toEqual(status === 'queued' ? null : { repo, pr, head, status, result: null });
      const io = {
        now: () => 1_000, log: vi.fn(), readRecords: () => [], readRecoveryComments: () => [],
        readRedTeamStatus: () => readRedTeamStatus(key),
        cliAvailable: vi.fn(() => { throw Error('provider reached'); }),
        reserveCalls: vi.fn(), runSeat: vi.fn(), runRecheck: vi.fn(),
      };
      const result = await runRedTeam({ repo, pr, loopPayload, env, redTeamMode: 'fresh', redTeamAdmission }, io);
      if (status === 'queued') {
        expect(result).toEqual({ status: 'error', reason: 'provider reached' });
        expect(io.cliAvailable).toHaveBeenCalledOnce();
      } else {
        expect(result).toMatchObject({ status: 'not-owed', deferredByGuard: true,
          reason: expect.stringContaining('prior red-team status; not re-run') });
        expect(io.cliAvailable).not.toHaveBeenCalled();
      }
      for (const hook of ['reserveCalls', 'runSeat', 'runRecheck']) expect(io[hook]).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  function freshRecoveryFixture(check) {
    const root = mkdtempSync(join(tmpdir(), 'fresh-recovery-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_STATUS_LABELS: '0' };
    const key = { repo, pr, head, env }, loopPayload = payload(), seats = [];
    Object.assign(loopPayload.findings.read, {
      netChangedFiles: ['scripts/example.mjs'],
      diffText: 'diff --git a/scripts/example.mjs b/scripts/example.mjs\n+export const value = 1;\n',
    });
    const path = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
    const readWitness = () => readRecoveryWitness({ ...key, readScorecards: () => seats });
    const probe = { ...recoveryProbe(), isAlive: vi.fn(() => false) };
    const readEvidence = () => readDrainRedTeamEvidence({ ...key, runsDir: env.WE_SHARED_RUNS_DIR,
      list: () => [], readScorecards: () => seats, isAlive: () => false });
    const production = createReviewJobIo({ env, readWitness, recoveryProbe: probe, readEvidence });
    const decide = () => planRedTeamOnSkip({
      repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
      rawPrs: [{ number: pr, headRefOid: head, comments: [] }], readWitness,
      readEvidence: () => { throw Error('raw recovery must not use normalized drain evidence'); },
      setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map(),
      recoveryOptions: { now: Date.now(), probe, deadlineMs: 7200000 },
    })[0];
    try {
      writeRun({ ...newRunRecord({ id: loopPayload.runId, op: 'review-pr', input: { repo, pr } }), ...loopPayload }, env.WE_SHARED_RUNS_DIR);
      production.redTeamStatus({ repo, pr, loopPayload, status: 'queued', redTeamMode: 'fresh' });
      const stored = readRedTeamStatus(key);
      expect(stored).toMatchObject({ status: 'queued', result: null, pid: process.pid });
      expect(readEvidence()).toMatchObject({ inFlight: false, seatRecorded: false, recorded: false });
      check({ key, path, stored, loopPayload, seats, readWitness, probe, production, decide });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('accepted code head dispatches fresh after queued fresh recovery crashes before running with no seat or result comment', () => {
    freshRecoveryFixture(({ key, path, stored, loopPayload, readWitness, probe, production, decide }) => {
      const before = readFileSync(path, 'utf8');
      expect(readWitness().rawWriter.parsed).toEqual(stored);
      expect(planRedTeamRecovery(readWitness(), { now: Date.now(), probe, deadlineMs: 7200000 }))
        .toMatchObject({ mode: 'fresh', abandon: true, executionPrior: null });
      expect(decide()).toMatchObject({ action: 'dispatch', mode: 'fresh', staleRecovery: true });
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(abandonStaleRedTeamRun(key, { readWitness, probe }).ok).toBe(true);
      const { redTeamAdmission } = production.redTeamStatus({ repo, pr, loopPayload, status: 'queued', redTeamMode: 'fresh' });
      expect(redTeamAdmission.prior).toBeNull();
      expect(readRedTeamStatus(key)).toEqual(redTeamAdmission.queued);
    });
  });

  it.each([
    ['live queued writer', true, 'queued'],
    ['live running writer', true, 'running'],
    ['unknown liveness', undefined, 'queued'],
  ])('queued fresh recovery still skips with %s', (_name, alive, status) => {
    freshRecoveryFixture(({ key, path, stored, readWitness, probe, decide }) => {
      // Keep the birth time unknown so unknown liveness cannot fall through to an age deadline.
      writeFileSync(path, JSON.stringify({ ...stored, status, pidStart: null }));
      probe.isAlive.mockReturnValue(alive);
      const before = readFileSync(path, 'utf8');
      expect(decide().action).toBe('skip');
      expect(probe.isAlive).toHaveBeenCalledWith(stored.pid);
      expect(readWitness().rawWriter.parsed).toEqual(readRedTeamStatus(key));
      expect(readFileSync(path, 'utf8')).toBe(before);
    });
  });

  it.each([undefined, null, 0, -1, 1.5, '123'])('queued fresh recovery still skips with invalid writer pid %j', pid => {
    freshRecoveryFixture(({ path, stored, readWitness, probe, decide }) => {
      writeFileSync(path, JSON.stringify({ ...stored, pid, pidStart: null }));
      const before = readFileSync(path, 'utf8');
      expect(decide().action).toBe('skip');
      expect(probe.isAlive).not.toHaveBeenCalled();
      expect(readWitness().rawWriter.parsed.status).toBe('queued');
      expect(readFileSync(path, 'utf8')).toBe(before);
    });
  });

  it('dead queued fresh recovery cannot dispatch over an existing seat row', () => {
    freshRecoveryFixture(({ key, path, seats, readWitness, probe, decide }) => {
      seats.push({ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' });
      const before = readFileSync(path, 'utf8');
      expect(readWitness().seats).toEqual(seats);
      expect(decide().action).toBe('skip');
      expect(abandonStaleRedTeamRun(key, { readWitness, probe }).ok).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(before);
    });
  });

  it.each([false, true])('skipped redTeam with policy settles before finished status and gate (redTeamOnly=%s)', redTeamOnly => {
    const f = fixture();
    const out = runReviewJob({ repo, pr, redTeamOnly, redTeamMode: 'fresh' }, f.io);
    // The normal path's outcome follows the fixture verdict, not settlement; settlement order is asserted below.
    if (redTeamOnly) expect(out.outcome).toBe('red-team-only');
    expect(f.io.runRedTeam).toHaveBeenCalledTimes(1);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
    expect(f.io.settleRedTeamSkip.mock.calls[0][0]).toMatchObject({ redTeam: skipped, repo, pr, head, readHead: head });
    expect(f.events).toEqual(['queued', 'red-team', 'settle', 'finished', 'gate']);
    expect(f.io.runRedTeamGate.mock.calls).toEqual([[{ repo, pr }]]);
    expect(out.redTeam).toMatchObject({ status: 'skipped', outcome: 'policy-clear' });
    if (redTeamOnly) {
      expect(f.io.runLoop).not.toHaveBeenCalled();
      expect(f.io.runExtraSeats).not.toHaveBeenCalled();
      expect(f.io.report).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('non-policy skipped result also reaches settlement (redTeamOnly=%s)', redTeamOnly => {
    const redTeam = { status: 'skipped', reason: 'provider unavailable' };
    const f = fixture(redTeam);
    f.io.settleRedTeamSkip.mockImplementation(() => { f.events.push('settle'); return { outcome: 'non-policy' }; });
    const out = runReviewJob({ repo, pr, redTeamOnly }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
    expect(f.io.settleRedTeamSkip.mock.calls[0][0]).toMatchObject({ redTeam, repo, pr, head });
    expect(f.events.indexOf('settle')).toBeLessThan(f.events.indexOf('gate'));
    expect(out.redTeam).toMatchObject({ status: 'skipped', outcome: 'non-policy' });
  });

  it.each([{ status: 'error' }, { status: 'disabled' }, { unexpected: true }, null, undefined])(
    'production dispatch settles every incomplete outcome %j', redTeam => {
      const f = fixture();
      f.io.runRedTeam.mockReturnValue(redTeam);
      f.io.settleRedTeamSkip.mockReturnValue({ outcome: 'non-policy' });
      const out = runReviewJob({ repo, pr }, f.io);
      expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
      expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ redTeam, repo, pr, head }));
      expect(out.redTeam.outcome).toBe('non-policy');
    });

  it.each([false, true])('malformed reason cannot prevent settlement or throw (redTeamOnly=%s)', redTeamOnly => {
    const redTeam = { status: 'skipped', reason: { toString: null } };
    const f = fixture(redTeam);
    expect(() => runReviewJob({ repo, pr, redTeamOnly }, f.io)).not.toThrow();
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ redTeam, repo, pr, head }));
    expect(f.events.indexOf('settle')).toBeLessThan(f.events.indexOf('gate'));
  });

  it.each(['ran', 'resumed'])('completed %s with a visible result does not settle', status => {
    for (const commentStatus of ['posted', 'deduped']) {
      const f = fixture({ status, comment: { status: commentStatus } });
      f.io.redTeamResultVisible = vi.fn(() => true);
      runReviewJob({ repo, pr }, f.io);
      expect(f.io.redTeamResultVisible).toHaveBeenCalledWith({ repo, pr, head });
      expect(f.io.settleRedTeamSkip).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['another head', { status: 'ran', comment: { status: 'posted' } }, 'other-head'],
    ['unreadable comments', { status: 'ran', comment: { status: 'posted' } }, 'unreadable'],
    ['untrusted author', { status: 'ran', comment: { status: 'posted' } }, 'untrusted'],
    ['guard deferral', { status: 'resumed', comment: { status: 'deduped' }, deferredByGuard: true }, 'visible'],
    ['cap deferral', { status: 'ran', comment: { status: 'posted' }, deferredByCap: true }, 'visible'],
    ['malformed findings', { status: 'ran', comment: { status: 'posted' }, findings: {} }, 'visible'],
    ['throwing seat derivation', { status: 'ran', comment: { status: 'posted' }, seat: { get startedAt() { throw Error('malformed seat'); } } }, 'visible'],
    ['missing visibility reader', { status: 'ran', comment: { status: 'posted' } }, 'missing'],
  ])('completed result with %s notifies without posting or clearing', (_name, redTeam, evidence) => {
    for (const redTeamOnly of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'review-completion-evidence-'));
      const postComment = vi.fn(), publishNeedsYou = vi.fn();
      try {
        const f = fixture(redTeam);
        const exec = vi.fn((_file, args) => {
          if (evidence === 'unreadable') throw Error('comments unavailable');
          if (args.includes('--paginate')) return [redTeamMarker(pr, evidence === 'other-head' ? 'b'.repeat(40) : head),
            '2026-10-24T00:00:00Z', evidence === 'untrusted' ? 'outsider' : 'web-everything', 'IC_result', 'https://example.test/comment'].join('\t');
          return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } });
        });
        if (evidence !== 'missing') f.io.redTeamResultVisible = createReviewJobIo({ env: {}, exec }).redTeamResultVisible;
        f.io.settleRedTeamSkip.mockImplementation(input => {
          f.events.push('settle');
          return settleRedTeamSkip({ ...input, io: {
            env: { WE_SHARED_RUNS_DIR: join(root, 'runs') }, postComment, publishNeedsYou,
          } });
        });
        const out = runReviewJob({ repo, pr, redTeamOnly }, f.io);
        expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
        expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({
          repo, pr, head, redTeam: expect.objectContaining({ status: 'unpublished' }),
        }));
        expect(out.redTeam.outcome).toBe('non-policy');
        expect(publishNeedsYou).toHaveBeenCalledTimes(1);
        expect(publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head }));
        expect(postComment).not.toHaveBeenCalled();
        // Guard deferrals clear admission for retry; cap-deferred completions suppress the gate.
        // Neither is a completed pass, so the unconditional five-event expectation was wrong.
        expect(f.events).toEqual(redTeam.deferredByGuard
          ? ['queued', 'red-team', 'settle', 'gate']
          : redTeam.deferredByCap ? ['queued', 'red-team', 'settle', 'finished']
            : ['queued', 'red-team', 'settle', 'finished', 'gate']);
        expect(f.io.clearRedTeamQueued.mock.calls).toEqual(redTeam.deferredByGuard ? [[{ repo, pr, head }]] : []);
        expect(f.io.redTeamStatus.mock.calls.filter(([row]) => row.status === 'finished')).toHaveLength(redTeam.deferredByGuard ? 0 : 1);
        expect(f.io.runRedTeamGate).toHaveBeenCalledTimes(redTeam.deferredByCap ? 0 : 1);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  it.each(['deferredByCap', 'deferredByGuard'])('%s preserves lifecycle decisions when comment diagnostics throw', flag => {
    for (const status of ['ran', 'resumed']) for (const redTeamOnly of [false, true]) {
      const f = fixture({ status, [flag]: true,
        comment: { get status() { throw Error('comment status unavailable'); } },
      });
      f.io.settleRedTeamSkip.mockImplementation(() => {
        f.events.push('settle');
        return { outcome: 'non-policy' };
      });
      const out = runReviewJob({ repo, pr, redTeamOnly }, f.io);
      expect(f.events).toEqual(flag === 'deferredByCap'
        ? ['queued', 'red-team', 'settle', 'finished'] : ['queued', 'red-team', 'settle', 'gate']);
      expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
      expect(f.io.clearRedTeamQueued.mock.calls).toEqual(flag === 'deferredByGuard' ? [[{ repo, pr, head }]] : []);
      expect(f.io.runRedTeamGate).toHaveBeenCalledTimes(flag === 'deferredByCap' ? 0 : 1);
      expect(out.redTeam).toMatchObject({ status, [flag]: true, outcome: 'non-policy' });
      if (flag === 'deferredByCap') expect(out).not.toHaveProperty('redTeamGate');
    }
  });

  it.each([false, true])('skipped cap attempt rolls back admission and gates existing findings (throwing diagnostics=%s)', throwing => {
    for (const redTeamOnly of [false, true]) {
      const f = fixture({ status: 'skipped', deferredByCap: true,
        comment: throwing ? { get status() { throw Error('comment status unavailable'); } } : undefined,
      });
      f.io.settleRedTeamSkip.mockImplementation(() => {
        f.events.push('settle');
        return { outcome: 'non-policy' };
      });
      const out = runReviewJob({ repo, pr, redTeamOnly }, f.io);
      expect(f.events).toEqual(['queued', 'red-team', 'settle', 'gate']);
      expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
      expect(f.io.clearRedTeamQueued).toHaveBeenCalledWith({ repo, pr, head });
      expect(f.io.redTeamStatus.mock.calls.map(([row]) => row.status)).toEqual(['queued']);
      expect(f.io.runRedTeamGate.mock.calls).toEqual([[{ repo, pr }]]);
      expect(out.redTeam).toMatchObject({ status: 'skipped', deferredByCap: true, outcome: 'non-policy' });
      expect(out.redTeamGate).toEqual({ status: 'ok', outcome: 'advisory' });
    }
  });

  it('production visibility reader requires a complete trusted result on the settlement head', () => {
    const exec = vi.fn((_file, args) => args.includes('--paginate')
      ? [redTeamMarker(pr, head), '2026-10-24T00:00:00Z', 'web-everything', 'IC_result', 'https://example.test/comment'].join('\t')
      : JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } }));
    const f = fixture({ status: 'ran', comment: { status: 'posted' } });
    f.io.prepareLane = () => ({ head: 'b'.repeat(40) });
    f.io.redTeamResultVisible = createReviewJobIo({ env: {}, exec }).redTeamResultVisible;
    runReviewJob({ repo, pr }, f.io);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(f.io.settleRedTeamSkip).not.toHaveBeenCalled();
  });

  it('stored review head takes precedence over the prepared lane head', () => {
    const f = fixture();
    f.io.prepareLane = () => ({ head: 'b'.repeat(40) });
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ head }));
  });

  it.each([undefined, 'invalid'])('policy skip without a valid netBasis.rev cannot clear the lane head (%s)', rev => {
    const root = mkdtempSync(join(tmpdir(), 'review-policy-read-head-'));
    try {
      const f = fixture(), postComment = vi.fn(), publishNeedsYou = vi.fn();
      if (rev === undefined) delete f.loopPayload.findings.read.netBasis.rev;
      else f.loopPayload.findings.read.netBasis.rev = rev;
      f.io.settleRedTeamSkip.mockImplementation(input => settleRedTeamSkip({ ...input, comments: [], io: {
        env: { WE_SHARED_RUNS_DIR: join(root, 'runs') }, postComment, publishNeedsYou,
      } }));
      const out = runReviewJob({ repo, pr }, f.io);
      expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ head, readHead: null }));
      expect(out.redTeam).toMatchObject({ outcome: 'non-policy', reason: 'policy skip head not bound to the reviewed read' });
      expect(postComment).not.toHaveBeenCalled();
      expect(publishNeedsYou).toHaveBeenCalledTimes(1);
      expect(publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ head }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('two real lane heads without netBasis.rev publish twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-skip-heads-'));
    const path = join(root, 'feed.jsonl');
    try {
      for (const realHead of [head, 'b'.repeat(40)]) {
        const f = fixture({ status: 'skipped', reason: 'missing rev' });
        delete f.loopPayload.findings.read.netBasis.rev;
        f.io.prepareLane = () => ({ head: realHead });
        f.io.settleRedTeamSkip.mockImplementation(input => settleRedTeamSkip({ ...input, io: {
          env: { WE_SHARED_RUNS_DIR: join(root, 'runs') },
          publishNeedsYou: item => publishAttention(item, { path }),
        } }));
        runReviewJob({ repo, pr }, f.io);
        expect(f.io.settleRedTeamSkip.mock.calls[0][0].head).toBe(realHead);
      }
      expect(replay({ path }).map(item => item.head)).toEqual([head, 'b'.repeat(40)]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a missing pinned rev falls back to the prepared lane head, never a null identity', () => {
    const f = fixture({ status: 'skipped', reason: 'missing rev' });
    delete f.loopPayload.findings.read.netBasis.rev;
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ head, runId: f.loopPayload.runId }));
  });

  it.each([undefined, 'invalid'])('invalid prepared lane head stops the job before settlement (%s)', laneHead => {
    const f = fixture();
    delete f.loopPayload.findings.read.netBasis.rev;
    f.io.prepareLane = () => ({ head: laneHead });
    f.io.readCarryEvidence = vi.fn(() => ({ headSha: head }));
    expect(runReviewJob({ repo, pr }, f.io)).toMatchObject({
      outcome: 'blocked-on-infra', label: expect.stringContaining('missing pinned review head'),
    });
    expect(f.io.runLoop).not.toHaveBeenCalled();
    expect(f.io.runRedTeam).not.toHaveBeenCalled();
    expect(f.io.settleRedTeamSkip).not.toHaveBeenCalled();
    expect(f.io.readCarryEvidence).not.toHaveBeenCalled();
  });

  it('missing read revision uses the valid lane head without reading live carry evidence', () => {
    const f = fixture();
    delete f.loopPayload.findings.read.netBasis.rev;
    f.io.readCarryEvidence = vi.fn(() => { throw Error('must not read live head'); });
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ head, readHead: null }));
    expect(f.io.readCarryEvidence).not.toHaveBeenCalled();
  });

  it.each([false, true])('throwing settlement still writes finished status and runs gate (redTeamOnly=%s)', redTeamOnly => {
    const f = fixture();
    f.io.settleRedTeamSkip.mockImplementation(() => { f.events.push('settle'); throw Error('settlement unavailable'); });
    const out = runReviewJob({ repo, pr, redTeamOnly }, f.io);
    expect(f.events).toEqual(['queued', 'red-team', 'settle', 'finished', 'gate']);
    expect(f.io.redTeamStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'finished' }));
    expect(out.redTeamGate.status).toBe('ok');
    expect(f.io.log).toHaveBeenCalledWith(expect.stringContaining('settlement unavailable'));
  });

  it.each([false, true])('not-owed on an accepted head publishes needs-you (redTeamOnly=%s)', redTeamOnly => {
    const root = mkdtempSync(join(tmpdir(), 'review-not-owed-'));
    const postComment = vi.fn(), publishNeedsYou = vi.fn();
    try {
      const f = fixture({ status: 'not-owed' });
      Object.assign(f.loopPayload.findings.read, {
        title: 'Update code', netChangedFiles: ['scripts/example.mjs'],
        diffText: 'diff --git a/scripts/example.mjs b/scripts/example.mjs\n+update\n',
      });
      f.io.settleRedTeamSkip.mockImplementation(input => {
        f.events.push('settle');
        return settleRedTeamSkip({ ...input, comments: [], io: {
          env: { WE_SHARED_RUNS_DIR: join(root, 'runs') }, postComment, publishNeedsYou,
        } });
      });
      const out = runReviewJob({ repo, pr, redTeamOnly }, f.io);
      expect(f.io.runRedTeam).toHaveBeenCalledOnce();
      expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
      expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({
        redTeam: { status: 'not-owed' }, repo, pr, head, readHead: head,
      }));
      expect(publishNeedsYou).toHaveBeenCalledOnce();
      expect(publishNeedsYou.mock.calls[0][0]).toMatchObject({
        repo, pr, head, reason: 'red team skipped (red team reported not-owed on an accepted head); not cleared',
      });
      expect(postComment).not.toHaveBeenCalled();
      expect(out.redTeam.outcome).toBe('non-policy');
      expect(f.events).toEqual(['queued', 'red-team', 'settle', 'finished', 'gate']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('unprintable runner exception still settles, finishes and gates (redTeamOnly=%s)', redTeamOnly => {
    const f = fixture();
    f.io.runRedTeam.mockImplementation(() => {
      f.events.push('red-team');
      throw { message: { toString: null } };
    });
    f.io.settleRedTeamSkip.mockImplementation(() => { f.events.push('settle'); return { outcome: 'non-policy' }; });
    const out = runReviewJob({ repo, pr, redTeamOnly }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({
      redTeam: { status: 'error', reason: 'unprintable error' }, repo, pr, head,
    }));
    expect(out.redTeam).toMatchObject({ status: 'error', reason: 'unprintable error', outcome: 'non-policy' });
    expect(f.io.redTeamStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'finished', result: 'error' }));
    expect(f.events).toEqual(['queued', 'red-team', 'settle', 'finished', 'gate']);
    expect(out.redTeamGate.status).toBe('ok');
  });

  it.each([
    { status: 'not-owed', deferredByGuard: true, reason: 'scorecard store unreadable' },
    { status: 'not-owed', deferredByCap: true, reason: 'cap exhausted' },
    { status: 'skipped', policy: 'card-only', deferredByGuard: true },
    { status: 'skipped', policy: 'card-only', deferredByCap: true },
    { status: 'deferred', reason: 'budget unavailable' },
    { status: 'deferred-by-budget', reason: 'daily quota exhausted' },
    { status: 'skipped', deferredByCap: true, reason: 'cap exhausted' },
    { status: 'skipped', deferredByGuard: true, reason: 'guard refused' },
    { status: 'ran', comment: { status: 'error' } },
    { status: 'resumed' },
    { status: 'resumed', comment: { status: 'withheld' } },
    { status: 'ran', comment: { status: 'not-posted' } },
    { status: 'resumed', comment: { status: 'unexpected' } },
  ])('unfinished publication or deferral publishes needs-you once without a result comment: %j', redTeam => {
    const root = mkdtempSync(join(tmpdir(), 'review-unpublished-'));
    const postComment = vi.fn(), publishNeedsYou = vi.fn();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const f = fixture(redTeam);
        f.io.settleRedTeamSkip.mockImplementation(input => settleRedTeamSkip({ ...input, comments: [], io: {
          env: { WE_SHARED_RUNS_DIR: join(root, 'runs') }, postComment, publishNeedsYou,
        } }));
        const out = runReviewJob({ repo, pr }, f.io);
        const completed = ['ran', 'resumed'].includes(redTeam.status);
        expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
        expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({
          redTeam: completed ? { status: 'unpublished',
            reason: `red team ${redTeam.status} but its result comment is ${redTeam.comment?.status ?? 'unknown'}` } : redTeam,
        }));
        expect(out.redTeam.outcome).toBe('non-policy');
      }
      expect(publishNeedsYou).toHaveBeenCalledTimes(1);
      expect(publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head }));
      expect(postComment).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    [{ status: 'error', reason: 'gh: HTTP 502' }, ' (gh: HTTP 502)'],
    [{ status: 'error', reason: 'a\n  b\tc' }, ' (a b c)'],
    [{ status: 'error', reason: 'x'.repeat(300) }, ` (${'x'.repeat(200)})`],
    [{ status: 'error', reason: '' }, ''],
    [{ status: 'error' }, ''],
  ])('unpublished skip reason carries the comment reason when present: %j', (comment, suffix) => {
    const f = fixture({ status: 'ran', comment });
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({
      redTeam: { status: 'unpublished', reason: `red team ran but its result comment is error${suffix}` },
    }));
  });

  it.each([
    { status: 'resumed', comment: { status: { toString: null } } },
    { status: 'ran', findings: {} },
    { status: 'ran', findings: [null] },
  ])('malformed result settles once without a comment and preserves finished status and gate: %j', redTeam => {
    for (const redTeamOnly of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'review-malformed-result-'));
      const postComment = vi.fn(), publishNeedsYou = vi.fn();
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const f = fixture(redTeam);
          f.io.settleRedTeamSkip.mockImplementation(input => {
            f.events.push('settle');
            return settleRedTeamSkip({ ...input, comments: [], io: {
              env: { WE_SHARED_RUNS_DIR: join(root, 'runs') }, postComment, publishNeedsYou,
            } });
          });
          let out;
          expect(() => { out = runReviewJob({ repo, pr, redTeamOnly }, f.io); }).not.toThrow();
          expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
          expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({
            redTeam: { status: 'unpublished', reason: `red team ${redTeam.status} but its result comment is unknown` },
          }));
          expect(out.redTeam.outcome).toBe('non-policy');
          expect(f.events).toEqual(['queued', 'red-team', 'settle', 'finished', 'gate']);
          expect(f.io.redTeamStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'finished' }));
          expect(out.redTeamGate.status).toBe('ok');
        }
        expect(postComment).not.toHaveBeenCalled();
        expect(publishNeedsYou).toHaveBeenCalledTimes(1);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  it('throwing red-team diagnostic logger still settles and writes finished status before the gate', () => {
    const f = fixture();
    f.io.log.mockImplementation(line => {
      if (line.includes(': red team —')) throw Error('logger unavailable');
    });
    const out = runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['queued', 'red-team', 'settle', 'finished', 'gate']);
    expect(f.io.redTeamStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'finished' }));
    expect(out.redTeamGate.status).toBe('ok');
  });

  it('throwing settlement and logger still write finished status and run the gate', () => {
    const f = fixture();
    f.io.settleRedTeamSkip.mockImplementation(() => { f.events.push('settle'); throw Error('settlement unavailable'); });
    f.io.log.mockImplementation(line => {
      if (line.includes('skip settlement failed')) throw Error('logger unavailable');
    });
    const out = runReviewJob({ repo, pr }, f.io);
    expect(f.events).toEqual(['queued', 'red-team', 'settle', 'finished', 'gate']);
    expect(f.io.redTeamStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'finished' }));
    expect(out.redTeamGate.status).toBe('ok');
    expect(f.io.log).toHaveBeenCalledWith(expect.stringContaining('skip settlement failed'));
  });

  it('production settlement posts marker via gh argv/body and publishes real needs-you', () => {
    const root = mkdtempSync(join(tmpdir(), 'production-skip-'));
    const path = join(root, 'feed.jsonl');
    try {
      vi.stubEnv('VITEST', '');
      vi.stubEnv('WE_UNDER_TEST', '');
      vi.stubEnv('WE_NEEDS_YOU_FEED', path);
      const exec = vi.fn(() => '');
      const production = createReviewJobIo({ env: { WE_SHARED_RUNS_DIR: join(root, 'runs') }, exec });
      expect(production.settleRedTeamSkip({ repo, pr, head, readHead: head, redTeam: skipped, comments: [] }).outcome).toBe('policy-clear');
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith('gh', ['pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-'],
        expect.objectContaining({ input: `${redTeamMarker(pr, head)}\n\nRed team not required on this head: card-only diff (policy redTeam.skipCardOnly)` }));
      production.settleRedTeamSkip({ repo, pr, head, redTeam: { status: 'error', reason: 'offline' } });
      expect(replay({ path })).toEqual([expect.objectContaining({ repo, pr, head, reason: 'red team skipped (offline); not cleared' })]);
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['seat row', 'trusted comment'])('healed card-only fresh admission still refuses a prior %s', async guard => {
    const root = mkdtempSync(join(tmpdir(), 'healed-guard-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_SKIP_CARD_ONLY: '1', WE_RED_TEAM_STATUS_LABELS: '0', WE_REVIEW_RED_TEAM: '1', WE_REVIEW_EXTRA_SEATS: '1' };
    try {
      const production = createReviewJobIo({ env, readSeatRecords: () => [] });
      const loopPayload = payload();
      writeRun({ ...newRunRecord({ id: 'review-pr-skip', op: 'review-pr', input: { repo, pr } }), ...loopPayload }, env.WE_SHARED_RUNS_DIR);
      production.redTeamStatus({ repo, pr, loopPayload, status: 'finished', result: { status: 'skipped', policy: 'card-only' } });
      const { redTeamAdmission } = production.redTeamStatus({ repo, pr, loopPayload, status: 'queued', redTeamMode: 'fresh' });
      expect(redTeamAdmission.prior).toBeNull();
      const io = {
        readRecords: vi.fn(() => guard === 'seat row' ? [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'error' }] : []),
        readRedTeamStatus: () => readRedTeamStatus({ repo, pr, head, env }),
        readRecoveryComments: () => guard === 'trusted comment' ? [{ body: redTeamMarker(pr, head), author: { login: 'web-everything' } }] : [],
        cliAvailable: vi.fn(() => { throw Error('must not reach provider'); }),
      };
      const result = await runRedTeam({ repo, pr, loopPayload, env, redTeamMode: 'fresh', redTeamAdmission }, io);
      expect(result).toMatchObject({ status: 'not-owed', reason: expect.stringContaining(guard === 'seat row' ? 'prior red-team seat row' : 'red-team result already on head') });
      expect(io.readRecords).toHaveBeenCalledWith({ strict: true });
      expect(io.cliAvailable).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('createReviewJobIo exposes the settlement hook', () => {
    expect(createReviewJobIo({ env: {} }).settleRedTeamSkip).toEqual(expect.any(Function));
  });
});

describe('speculateRedTeam card-only skip provenance', () => {
  it('returns policy:card-only with the unchanged reason before any provider or budget work', async () => {
    const io = { now: () => 1_000, log: vi.fn(), readRecords: () => [],
      cliAvailable: vi.fn(() => { throw Error('card-only must skip before provider work'); }),
      reserveCalls: vi.fn(() => { throw Error('card-only must skip before reservation'); }),
      postComment: vi.fn(), append: vi.fn(),
    };
    const result = await speculateRedTeam({ repo, pr, read: payload().findings.read,
      env: { WE_REVIEW_RED_TEAM: '1', WE_REVIEW_EXTRA_SEATS: '1', WE_RED_TEAM_SKIP_CARD_ONLY: 'true' } }, io);
    expect(result).toEqual(skipped);
    for (const hook of ['cliAvailable', 'reserveCalls', 'postComment', 'append']) expect(io[hook]).not.toHaveBeenCalled();
  });
});

describe('writer skipCardOnly setting on a code PR', () => {
  it('never exempts a code read from speculation, recovery guards or an owed pending label', async () => {
    const root = mkdtempSync(join(tmpdir(), 'code-skip-setting-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_SKIP_CARD_ONLY: '1',
      WE_RED_TEAM_STATUS_LABELS: '0', WE_REVIEW_RED_TEAM: '1', WE_REVIEW_EXTRA_SEATS: '1' };
    try {
      const loopPayload = payload();
      loopPayload.findings.read.netChangedFiles = ['scripts/example.mjs'];
      loopPayload.findings.read.diffText = 'diff --git a/scripts/example.mjs b/scripts/example.mjs\n+export const value = 1;\n';
      const production = createReviewJobIo({ env });
      production.redTeamStatus({ repo, pr, loopPayload, status: 'finished', result: 'error' });
      const status = readRedTeamStatus({ repo, pr, head, env });
      expect(status.skipCardOnly).toBe(true);
      expect(redTeamSkipNeedsSettlement({ ...status, result: 'skipped' })).toBe(false);
      const cliAvailable = vi.fn(() => false);
      const result = await speculateRedTeam({ repo, pr, read: status.loopPayload.findings.read, env }, {
        now: () => 1000, log: vi.fn(), readRecords: () => [], cliAvailable,
      });
      expect(result.policy).not.toBe('card-only');
      expect(cliAvailable).toHaveBeenCalled();
      const evidence = readDrainRedTeamEvidence({ repo, pr, head, env, list: () => [], readScorecards: () => [] });
      expect(evidence).toMatchObject({ skipCardOnly: true, scheduled: true, recorded: false, inFlight: false });
      expect(redTeamOwedOnHead({ read: status.loopPayload.findings.read, evidence })).toBe(true);
      expect(planRedTeamStatusLabels({ repo, pr, head, evidence, env, comments: [] }))
        .toEqual({ add: 'red-team:pending', remove: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


describe('PR 5890 settlement provenance and visible dedupe', () => {
  it.each(['ran', 'resumed'])('ignores a %s review-pr payload without red-team run fields', status => {
    const f = fixture({ status, comment: { status: 'error' }, loopPayload: { ...payload(), op: 'review-pr' } });
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).not.toHaveBeenCalled();
    expect(f.io.runRedTeamGate).toHaveBeenCalledOnce();
  });
  it.each(['ran', 'resumed'].flatMap(status => [
    { status, provider: 'codex', model: 'm' }, { status, findings: [] },
  ]))('a real run %j still alerts when its review-pr-shaped result is unpublished', fields => {
    const f = fixture({ ...fields, comment: { status: 'error' }, loopPayload: { ...payload(), op: 'review-pr' } });
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({
      redTeam: { status: 'unpublished', reason: `red team ${fields.status} but its result comment is error` },
    }));
    expect(f.io.runRedTeamGate).toHaveBeenCalledOnce();
  });
  it.each(['already-ran', 'prior-row'])('%s with a visible head result is already settled', status => {
    const f = fixture({ status });
    f.io.redTeamResultVisible = vi.fn(() => true);
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).not.toHaveBeenCalled();
    expect(f.io.redTeamResultVisible).toHaveBeenCalledWith({ repo, pr, head });
    expect(f.io.runRedTeamGate).toHaveBeenCalledOnce();
  });
  it.each(['already-ran', 'prior-row'])('%s without a visible result still alerts', status => {
    const f = fixture({ status });
    f.io.redTeamResultVisible = () => false;
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledOnce();
  });
  it.each(['already-ran', 'prior-row'])('%s with an unreadable result still alerts', status => {
    const f = fixture({ status });
    f.io.redTeamResultVisible = () => { throw Error('thread unreadable'); };
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledOnce();
    expect(f.io.runRedTeamGate).toHaveBeenCalledOnce();
  });
});

describe('readRedTeamOnlyPayload fails closed on a held carry fallback', () => {
  it.each([
    ['top-level', { ok: false, reason: 'scan-capped' }],
    ['carryEvidence', { newest: null, carryEvidence: { ok: false, reason: 'review-unfinished' } }],
  ])('throws a hold for a %s ok:false witness', (_n, witness) => {
    const io = createReviewJobIo({ env: {}, readWitness: () => witness, readSeatRecords: () => [] });
    expect(() => io.readRedTeamOnlyPayload({ pr: 1, repo: 'o/r', head: 'h' })).toThrow(/hold and inspect run evidence/);
  });
});

const emptyEvidenceRoots = [];
afterEach(() => { for (const root of emptyEvidenceRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function newEmptyEvidence() {
  const f = emptyDiffFixture({ repo, pr }); emptyEvidenceRoots.push(f.root); return f;
}

describe('empty net diff producer proof', () => {
  const read = () => ({ netBasis: { base: 'c'.repeat(40), rev: head, scored: true }, netChangedFiles: [], diffText: '', diffScored: true });
  it('owes a scheduled red-team result even with a proven empty net diff', () => {
    expect(redTeamOwedOnHead({ read: read(), evidence: { scheduled: true, skipCardOnly: false } })).toBe(true);
  });
  it('does not owe an unscheduled red-team result with a proven empty net diff', () => {
    const f = newEmptyEvidence();
    expect(redTeamOwedOnHead({ ...f.proof, read: f.read, evidence: { status: f.status, scheduled: false, skipCardOnly: false } })).toBe(false);
    expect(redTeamOwedOnHead({ read: f.read, evidence: { scheduled: false, skipCardOnly: false } })).toBe(true);
  });
  it('skips a proven empty net diff before provider work with policy and reason', async () => {
    const f = newEmptyEvidence();
    const readRecords = vi.fn(() => [f.row]);
    expect(await speculateRedTeam({ repo, pr, lanePath: f.root, read: f.read, env: {} }, { storePath: f.storePath, now: () => 1000, readRecords, log: vi.fn() })).toEqual(emptySkip);
    expect(readRecords).toHaveBeenCalledWith({ strict: true });
  });
  it('refuses empty net diff clearance when the production scorecard reader encounters a directory', async () => {
    const storePath = mkdtempSync(join(tmpdir(), 'red-team-scorecard-directory-'));
    try {
      const production = createRedTeamIo({ env: {}, storePath });
      expect(production.readRecords()).toEqual([]);
      const io = { storePath, now: () => 1000, readRecords: vi.fn(production.readRecords), log: vi.fn(),
        cliAvailable: vi.fn(), reserveCalls: vi.fn(), runSeat: vi.fn(), append: vi.fn(), postComment: vi.fn() };
      const result = await speculateRedTeam({ repo, pr, read: read(), env: {} }, io);
      expect(result).toEqual({ status: 'skipped', reason: 'scorecard store unreadable — inspect stored evidence before retrying; no call launched' });
      expect(io.readRecords).toHaveBeenCalledWith({ strict: true });
      expect(result).not.toHaveProperty('policy');
      for (const effect of ['cliAvailable', 'reserveCalls', 'runSeat', 'append', 'postComment']) {
        expect(io[effect]).not.toHaveBeenCalled();
      }
    } finally {
      rmSync(storePath, { recursive: true, force: true });
    }
  });
  it.each([
    ['unscored text', r => { r.diffScored = false; }],
    ['missing text score', r => { delete r.diffScored; }],
    ['missing score', r => { delete r.netBasis.scored; }],
    ['missing head', r => { delete r.netBasis.rev; }],
    ['missing paths', r => { delete r.netChangedFiles; }],
    ['nonempty paths', r => { r.netChangedFiles = ['scripts/example.mjs']; }],
    ['unreadable diff', r => { delete r.diffText; }],
  ])('never grants a policy for %s', async (_, mutate) => {
    const r = read(); mutate(r);
    const f = newEmptyEvidence();
    f.writeStore([{ ...f.row, rev: head }]);
    const io = { storePath: f.storePath, now: () => 1000, readRecords: vi.fn(() => []), log: vi.fn() };
    const result = await speculateRedTeam({ repo, pr, lanePath: f.root, read: r, env: {} }, io);
    expect(result).not.toHaveProperty('policy');
    expect(result).toEqual({ status: 'skipped', reason: r.diffText == null ? 'the review printed no diff'
      : !r.netBasis.rev ? 'the review printed no pinned head commit (netBasis.rev)'
      : 'empty net diff not proven (read-unproven) — inspect stored evidence before retrying; no call launched' });
    if (r.diffText != null && r.netBasis.rev) expect(io.readRecords).toHaveBeenCalledOnce();
  });

  it('empty net diff preserves resume-only refusal when the scorecard store is unreadable', async () => {
    const read = { netBasis: { rev: head, scored: true }, netChangedFiles: [], diffText: '', diffScored: true };
    expect(await speculateRedTeam({ repo, pr, read, env: {}, resumeOnly: true }, {
      now: () => 1000, readRecords: () => { throw Error('unreadable'); }, log: vi.fn(),
    })).toEqual({ status: 'skipped', reason: 'resume-only: scorecard store unreadable — no call launched' });
  });
  it('empty net diff preserves resume-only refusal when the readable scorecard store has no prior row', async () => {
    const io = {
      now: () => 1000, readRecords: () => [], log: vi.fn(),
      cliAvailable: vi.fn(), reserveCalls: vi.fn(), runSeat: vi.fn(),
      append: vi.fn(), postComment: vi.fn(),
    };
    expect(await speculateRedTeam({ repo, pr, read: read(), env: {}, resumeOnly: true }, io))
      .toEqual({ status: 'skipped', reason: 'resume-only: no clean prior red-team row — no call launched' });
    for (const effect of ['cliAvailable', 'reserveCalls', 'runSeat', 'append', 'postComment']) {
      expect(io[effect]).not.toHaveBeenCalled();
    }
  });
  it.each([
    ['default', {}],
    ['resumable', { resumeOnly: false, resume: true }],
    ['speculative', { resumeOnly: false, resume: false }],
  ])('refuses empty net diff policy clearance with an unreadable scorecard store (%s)', async (_, mode) => {
    const f = newEmptyEvidence();
    const io = { storePath: f.root,
      now: () => 1000, readRecords: () => { throw Error('unreadable'); }, log: vi.fn(),
      cliAvailable: vi.fn(), reserveCalls: vi.fn(), runSeat: vi.fn(),
      append: vi.fn(), postComment: vi.fn(),
    };
    expect(await speculateRedTeam({ repo, pr, read: read(), env: {}, ...mode }, io))
      .toEqual({ status: 'skipped', reason: 'scorecard store unreadable — inspect stored evidence before retrying; no call launched' });
    for (const effect of ['cliAvailable', 'reserveCalls', 'runSeat', 'append', 'postComment']) {
      expect(io[effect]).not.toHaveBeenCalled();
    }
  });
  it.each([true, false])('empty net diff preserves completed prior row (resume=%s)', async resume => {
    const read = { netBasis: { rev: head, scored: true }, netChangedFiles: [], diffText: '', diffScored: true };
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' };
    const result = await speculateRedTeam({ repo, pr, read, env: {}, resume }, {
      now: () => 1000, readRecords: () => [row], log: vi.fn(),
      listComments: () => [{ body: redTeamMarker(pr, head), author: { login: 'web-everything' } }],
    });
    expect(result.status).toBe(resume ? 'already-ran' : 'prior-row');
  });
});

describe('empty net diff terminal publication through the production carry path', () => {
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  // A real lane clone: the empty-diff proof is re-read from Git in the review checkout, never trusted from the payload.
  function laneFixture(root, { realDiff = false, replaceRef = false } = {}) {
    const lanePath = join(root, 'lane');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', lanePath]);
    writeFileSync(join(lanePath, 'file.txt'), 'base\n');
    git(lanePath, ['add', 'file.txt']);
    git(lanePath, ['commit', '--quiet', '-m', 'base']);
    const base = git(lanePath, ['rev-parse', 'HEAD']);
    git(lanePath, ['update-ref', 'refs/remotes/origin/main', base]);
    if (realDiff) {
      writeFileSync(join(lanePath, 'file.txt'), 'changed\n');
      git(lanePath, ['commit', '--quiet', '-am', 'head']);
    } else git(lanePath, ['commit', '--quiet', '--allow-empty', '-m', 'head']);
    const sha = git(lanePath, ['rev-parse', 'HEAD']);
    if (replaceRef) {
      // Plant refs/replace/<head> → a commit carrying the base tree, so a replace-honouring diff of base..head reads empty.
      const planted = git(lanePath, ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'planted']);
      git(lanePath, ['replace', sha, planted]);
    }
    return { lanePath, base, sha };
  }
  function productionCarry({ skipCardOnly, realDiff = false, replaceRef = false }) {
    const root = mkdtempSync(join(tmpdir(), 'empty-net-diff-carry-'));
    const { lanePath, base, sha } = laneFixture(root, { realDiff, replaceRef });
    const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_SKIP_CARD_ONLY: skipCardOnly ? '1' : '0',
      WE_RED_TEAM_STATUS_LABELS: '0' };
    mkdirSync(join(root, '.conveyor'));
    writeFileSync(join(root, '.conveyor', 'run-scorecards.json'), JSON.stringify({ version: 1, records: [
      { dispatchKind: 'review-seat', seat: 'advisory', repo, pr, rev: sha } ] }));
    const comments = [], labels = ['red-team:pending'], gitCwds = [], gitOutputs = [];
    const exec = vi.fn((file, args, options = {}) => {
      if (file === 'git') {
        gitCwds.push(options.cwd);
        const output = execFileSync(file, args, options);
        gitOutputs.push(output);
        return output;
      }
      expect(file).toBe('gh');
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: sha, labels });
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: comments.length } } } } });
      if (args[0] === 'api') return comments.map(comment => [
        comment.body.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t'),
        '2026-11-17T00:00:00Z', comment.author.login, comment.id, '',
      ].join('\t')).join('\n');
      if (args[0] === 'label') return '';
      if (args[1] === 'edit') { labels.splice(0, labels.length, 'red-team:clear'); return ''; }
      if (args[1] === 'comment') {
        comments.push({ id: `IC_${comments.length}`, body: options.input, author: { login: 'web-everything' } });
        return '';
      }
      throw Error(`unexpected command ${file} ${args.join(' ')}`);
    });
    const loopPayload = { runId: 'review-pr-empty', stopped: 'complete', verdict: { verdict: 'changes' }, findings: { read: {
      title: 'Empty head', body: '', diffText: '', diffScored: true, netChangedFiles: [], netRenameSources: [],
      netBasis: { rev: sha, base, scored: true } } } };
    const key = { repo, pr, head: sha, env };
    const readEvidence = k => readDrainRedTeamEvidence({ ...k, env, runsDir: env.WE_SHARED_RUNS_DIR, readScorecards: () => [] });
    writeRun({ ...newRunRecord({ id: loopPayload.runId, op: 'review-pr', input: { repo, pr } }), ...loopPayload }, env.WE_SHARED_RUNS_DIR);
    recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: { ...emptySkip } }, { env });
    const production = createReviewJobIo({ root, env, exec, readEvidence, readSeatRecords: () => [] });
    const f = fixture();
    Object.assign(f.io, {
      env, gitExec: production.gitExec,
      acquireLane: () => ({ lanePath }), readRedTeamOnlyPayload: k => ({ ...readEvidence(k), head: sha }),
      prepareLane: () => ({ head: sha }), fetchRedTeamHead: () => ({ head: sha }), redTeamSkipCardOnlySetting: production.redTeamSkipCardOnlySetting,
      settleRedTeamSkip: vi.fn(production.settleRedTeamSkip),
    });
    return { root, lanePath, base, sha, key, comments, labels, gitCwds, gitOutputs, exec, io: f.io, loopPayload };
  }

  it.each([true, false])('publishes empty-net-diff clearance with card-only skipping %s', skipCardOnly => {
    const c = productionCarry({ skipCardOnly });
    try {
      expect(c.io.redTeamSkipCardOnlySetting()).toBe(skipCardOnly);
      const out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, c.io);
      expect(out.redTeam).toMatchObject({ ...emptySkip, outcome: 'policy-clear' });
      expect(c.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ redTeam: emptySkip }));
      // Terminal marker: exactly one trusted result comment naming the empty-diff exemption, label cleared.
      expect(c.comments.map(comment => comment.body)).toEqual([
        `${redTeamMarker(pr, c.sha)}\n\nRed team not required on this head: not-owed: empty net diff`]);
      expect(c.labels).toEqual(['red-team:clear']);
      expect(readRedTeamCarry(c.key).step).toBe('done');
      // The carry's stored policy and reason are the empty-diff provenance, never card-only.
      expect(readRedTeamStatus(c.key)).toMatchObject({ status: 'finished', result: emptySkip, loopPayload: { verdict: null } });
      // The proof was re-read inside the prepared review lane, not the daemon checkout.
      expect(c.gitCwds.length).toBeGreaterThan(0);
      expect(new Set(c.gitCwds)).toEqual(new Set([c.lanePath]));
      for (const hook of ['redTeamStatus', 'runRedTeam', 'runLoop']) expect(c.io[hook]).not.toHaveBeenCalled();
      // A repeated dispatch is idempotent: no second comment or label write.
      expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, c.io).redTeam?.outcome ?? 'settled').not.toBe('policy-clear');
      expect(c.comments).toHaveLength(1);
    } finally { rmSync(c.root, { recursive: true, force: true }); }
  });

  it.each([true, false])('refuses an empty-diff claim the review lane disproves (card-only skipping %s)', skipCardOnly => {
    const c = productionCarry({ skipCardOnly, realDiff: true });
    try {
      const out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, c.io);
      expect(out.redTeam).toMatchObject({ outcome: 'non-policy', reason: expect.stringContaining('empty net diff not proven') });
      expect(c.comments).toEqual([]);
      expect(c.labels).toEqual(['red-team:pending']);
      expect(readRedTeamCarry(c.key)).toBeNull();
      // The refusal came from the lane's own diff naming the changed file, not from a failed Git call.
      expect(new Set(c.gitCwds)).toEqual(new Set([c.lanePath]));
      expect(c.gitOutputs.length).toBeGreaterThanOrEqual(3);
      expect(c.gitOutputs.length % 3).toBe(0);
      for (let i = 0; i < c.gitOutputs.length; i += 3)
        expect(c.gitOutputs.slice(i, i + 3)).toEqual([`${c.base}\n`, `${c.base}\n`, 'file.txt\0']);
    } finally { rmSync(c.root, { recursive: true, force: true }); }
  });

  it.each([true, false])('refuses an empty-diff claim a planted replace ref fakes (card-only skipping %s)', skipCardOnly => {
    const c = productionCarry({ skipCardOnly, realDiff: true, replaceRef: true });
    try {
      // Control: the planted replace ref really does make a replace-honouring diff of base..head read empty.
      expect(git(c.lanePath, ['diff', '--name-only', `${c.base}..${c.sha}`])).toBe('');
      // Mutation: the exact production probe minus --no-replace-objects would accept the faked empty diff.
      const read = c.loopPayload.findings.read;
      const dropFlag = (file, args, options) => {
        const { GIT_NO_REPLACE_OBJECTS: _disabled, ...env } = options.env;
        return execFileSync(file, args.filter(arg => arg !== '--no-replace-objects'), { ...options, env });
      };
      const proof = { repo, pr, read, head: c.sha, seatRecord: readRedTeamStatus(c.key), cwd: c.lanePath, env: c.key.env };
      expect(emptyDiffExemptionEvidence({ ...proof, exec: dropFlag }).exempt).toBe(true);
      expect(emptyDiffExemptionEvidence(proof)).toEqual({ exempt: false, reason: 'diff-nonempty' });
      // Production: the claim is refused — non-policy, no comment, label unchanged, no carry.
      const out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, c.io);
      expect(out.redTeam).toMatchObject({ outcome: 'non-policy', reason: expect.stringContaining('empty net diff not proven') });
      expect(c.comments).toEqual([]);
      expect(c.labels).toEqual(['red-team:pending']);
      expect(readRedTeamCarry(c.key)).toBeNull();
      expect(new Set(c.gitCwds)).toEqual(new Set([c.lanePath]));
      expect(c.exec.mock.calls.filter(([file]) => file === 'git').every(([, args]) => args[0] === '--no-replace-objects')).toBe(true);
      expect(c.gitOutputs.length).toBeGreaterThanOrEqual(3);
      expect(c.gitOutputs.length % 3).toBe(0);
      for (let i = 0; i < c.gitOutputs.length; i += 3)
        expect(c.gitOutputs.slice(i, i + 3)).toEqual([`${c.base}\n`, `${c.base}\n`, 'file.txt\0']);
    } finally { rmSync(c.root, { recursive: true, force: true }); }
  });

  it('carry eligibility exempts only a proven empty read when card-only skipping is disabled', () => {
    const f = newEmptyEvidence();
    const proven = f.read;
    const readLive = vi.fn(() => null);
    const carry = createRedTeamCarryIo({ env: { WE_RED_TEAM_SKIP_CARD_ONLY: '0' }, storePath: f.storePath, lanePath: f.root, readStatus: () => f.status, readLive, readComments: () => [] });
    expect(carry.eligible({ repo, pr, head: f.head, loopPayload: { findings: { read: { ...proven, netChangedFiles: ['backlog/5872.md'], diffText: '+card' } } } })).toBe(false);
    expect(carry.eligible({ repo, pr, head: f.head, loopPayload: { findings: { read: { ...proven, diffScored: false } } } })).toBe(false);
    expect(readLive).not.toHaveBeenCalled();
    // A proven empty read passes the policy gate and reaches the live guards (which then refuse a missing head).
    expect(carry.eligible({ repo, pr, head: f.head, loopPayload: { findings: { read: proven } } })).toBe(false);
    expect(readLive).toHaveBeenCalledOnce();
  });

  it('a head-move carry rebinding an empty source read never proves the new head empty', () => {
    const from = 'b'.repeat(40);
    const read = { netBasis: { rev: head, scored: true }, netChangedFiles: [], diffText: '', diffScored: true };
    const f = newEmptyEvidence();
    expect(emptyDiffExemptionEvidence(f.proof).exempt).toBe(true);
    expect(emptyDiffExemptionEvidence({ ...f.proof, loopPayload: { carriedFrom: f.head, findings: { read: f.read } } }).exempt).toBe(true);
    expect(emptyDiffExemptionEvidence({ ...f.proof, loopPayload: { carriedFrom: from, findings: { read: f.read } } })).toEqual({ exempt: false, reason: 'read-unproven' });
    const rebound = { repo, pr, head, loopPayload: { carriedFrom: from, verdict: null, findings: { read } } };
    expect(emptyDiffExemptionEvidence({ ...f.proof, loopPayload: { ...rebound.loopPayload, findings: { read: f.read } } }).exempt).toBe(false);
    // Policy off: the rebound read cannot buy the empty-diff exemption past the policy gate.
    const readLive = vi.fn(() => null), writeStatus = vi.fn(), postResult = vi.fn();
    const carry = createRedTeamCarryIo({ env: { WE_RED_TEAM_SKIP_CARD_ONLY: '0' }, readLive, readComments: () => [], writeStatus, postResult });
    expect(carry.eligible(rebound)).toBe(false);
    expect(readLive).not.toHaveBeenCalled();
    // A refused empty claim cannot fall back to publishing a card-only clearance.
    expect(() => carry.recordIntent(rebound)).toThrow('empty net diff not proven');
    expect(() => carry.postResult(rebound)).toThrow('empty net diff not proven');
    expect(writeStatus).not.toHaveBeenCalled();
    expect(postResult).not.toHaveBeenCalled();
  });
});


it('review-extra-seats refuses an empty-net-diff exemption on a missing production scorecard store (ENOENT)', async () => {
  const f = newEmptyEvidence();
  rmSync(f.storePath);
  const production = createRedTeamIo({ env: {}, storePath: f.storePath });
  expect(() => production.readRecords({ strict: true })).toThrow('scorecard store missing');
  const io = { storePath: f.storePath, readRecords: vi.fn(production.readRecords), now: () => 1000, log: vi.fn(),
    cliAvailable: vi.fn(), reserveCalls: vi.fn(), runSeat: vi.fn(), append: vi.fn(), postComment: vi.fn() };
  const result = await speculateRedTeam({ repo, pr, lanePath: f.root, read: f.read, env: {} }, io);
  expect(result).toEqual({ status: 'skipped', reason: 'empty net diff not proven (store-missing) — inspect stored evidence before retrying; no call launched' });
  expect(result).not.toHaveProperty('policy');
  expect(io.readRecords).toHaveBeenCalledWith({ strict: true });
  for (const effect of ['cliAvailable', 'reserveCalls', 'runSeat', 'append', 'postComment']) expect(io[effect]).not.toHaveBeenCalled();
});


it('carry effects refuse evidence removed after a complete empty-diff proof', () => {
  const f = newEmptyEvidence(), writeStatus = vi.fn(), postResult = vi.fn();
  const carry = createRedTeamCarryIo({ env: { WE_RED_TEAM_SKIP_CARD_ONLY: '1' }, storePath: f.storePath,
    lanePath: f.root, readStatus: () => f.status, writeStatus, postResult });
  const state = { repo, pr, head: f.head, loopPayload: { ...f.loopPayload, carriedFrom: f.head } };
  expect(emptyDiffExemptionEvidence({ ...f.proof, loopPayload: state.loopPayload }).exempt).toBe(true);
  rmSync(f.storePath);
  expect(() => carry.recordIntent(state)).toThrow('empty net diff not proven');
  expect(() => carry.postResult(state)).toThrow('empty net diff not proven');
  expect(writeStatus).not.toHaveBeenCalled();
  expect(postResult).not.toHaveBeenCalled();
});


it('producer keeps recovery owed when its seat read fails despite otherwise complete positive evidence', async () => {
  const f = newEmptyEvidence();
  expect(emptyDiffExemptionEvidence(f.proof).exempt).toBe(true);
  const io = { storePath: f.storePath, readRecords: vi.fn(() => { throw Error('seat read failed'); }),
    now: () => 1000, log: vi.fn(), cliAvailable: vi.fn(), reserveCalls: vi.fn(), runSeat: vi.fn() };
  expect(await speculateRedTeam({ repo, pr, lanePath: f.root, read: f.read, env: {} }, io)).toEqual({
    status: 'skipped', reason: 'scorecard store unreadable — inspect stored evidence before retrying; no call launched',
  });
  expect(io.readRecords).toHaveBeenCalledWith({ strict: true });
  for (const effect of ['cliAvailable', 'reserveCalls', 'runSeat']) expect(io[effect]).not.toHaveBeenCalled();
});


it('a persisted empty-diff policy with missing read text keeps an unscheduled red team owed', () => {
  const f = newEmptyEvidence();
  const evidence = { status: f.status, scheduled: false, skipCardOnly: false };
  expect(redTeamOwedOnHead({ ...f.proof, read: f.read, evidence })).toBe(false);
  delete f.read.diffText;
  const exec = vi.fn();
  expect(redTeamOwedOnHead({ ...f.proof, read: f.read, evidence, exec })).toBe(true);
  expect(emptyDiffExemptionEvidence({ ...f.proof, exec })).toEqual({ exempt: false, reason: 'read-unproven' });
  expect(exec).not.toHaveBeenCalled();
});
