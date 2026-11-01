// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { settleRedTeamSkip } from '../../lib/red-team-skip-outcome.mjs';
import { publishAttention, replay } from '../needs-you-feed.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReviewJob, createReviewJobIo } from '../review-job.mjs';
import { readDrainRedTeamEvidence, readRedTeamStatus, readRecoveryWitness, redTeamStatusDir } from '../../lib/drain-red-team-evidence.mjs';
import { normalizeRedTeamResult, planRedTeamOnSkip, redTeamSkipNeedsSettlement, planRedTeamRecovery, abandonStaleRedTeamRun, recoveryProbe } from '../../lib/review-red-team-on-skip.mjs';
import { newRunRecord, writeRun } from '../run-store.mjs';
import { redTeamOwedOnHead } from '../../lib/review-red-team-policy.mjs';
import { planRedTeamStatusLabels } from '../../lib/red-team-status-labels.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { speculateRedTeam, runRedTeam } from '../review-extra-seats.mjs';

const repo = 'web-everything/web-everything', pr = 5872, head = 'a'.repeat(40);
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
      expect(stored.result).toEqual(cardOnly ? { status: 'skipped', policy: 'card-only' } : { status: 'skipped' });
      expect(normalizeRedTeamResult(stored.result)).toEqual({ priorResult: 'skipped', priorComment: undefined });
      expect(redTeamSkipNeedsSettlement(stored)).toBe(cardOnly);
      expect(readEvidence()).toMatchObject({ loopPayload: f.loopPayload, scheduled: false, recorded: false, inFlight: false, skipCardOnly: true });
      writeRun({ ...newRunRecord({ id: 'review-pr-skip', op: 'review-pr', input: { repo, pr } }), ...f.loopPayload }, env.WE_SHARED_RUNS_DIR);
      if (!cardOnly) {
        expect(() => production.redTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'queued', redTeamMode: 'fresh' })).toThrow('prior pass cannot restart');
        expect(readRedTeamStatus(key)).toEqual(stored); return;
      }
      const admission = production.redTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'queued', redTeamMode: 'fresh' });
      expect(admission.redTeamAdmission.prior).toEqual(cardOnly ? null : {
        repo, pr, head, status: 'finished', result: { status: 'skipped' },
      });
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
