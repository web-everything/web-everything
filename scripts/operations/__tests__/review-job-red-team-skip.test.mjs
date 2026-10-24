// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { settleRedTeamSkip } from '../../lib/red-team-skip-outcome.mjs';
import { publishAttention, replay } from '../needs-you-feed.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReviewJob, createReviewJobIo } from '../review-job.mjs';
import { readDrainRedTeamEvidence, readRedTeamStatus } from '../../lib/drain-red-team-evidence.mjs';
import { normalizeRedTeamResult, redTeamSkipNeedsSettlement } from '../../lib/review-red-team-on-skip.mjs';
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

  it.each([true, false])('real persisted skip survives drain reads and recovery admission (policy=%s)', cardOnly => {
    const root = mkdtempSync(join(tmpdir(), 'skip-provenance-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_SKIP_CARD_ONLY: '1', WE_RED_TEAM_STATUS_LABELS: '0' };
    const key = { repo, pr, head, env };
    const readEvidence = () => readDrainRedTeamEvidence({ ...key, list: () => [], readScorecards: () => [] });
    const production = createReviewJobIo({ env, readEvidence });
    const f = fixture(cardOnly ? skipped : { status: 'skipped', reason: 'quota exhausted' });
    f.io.redTeamStatus = production.redTeamStatus;
    try {
      runReviewJob({ repo, pr }, f.io);
      const stored = readRedTeamStatus(key);
      expect(stored.result).toEqual(cardOnly ? { status: 'skipped', policy: 'card-only' } : { status: 'skipped' });
      expect(normalizeRedTeamResult(stored.result)).toEqual({ priorResult: 'skipped', priorComment: undefined });
      expect(redTeamSkipNeedsSettlement(stored)).toBe(cardOnly);
      expect(readEvidence()).toMatchObject({ loopPayload: f.loopPayload, scheduled: false, recorded: false, inFlight: false, skipCardOnly: true });
      const admission = production.redTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'queued', redTeamMode: 'fresh' });
      expect(admission.redTeamAdmission.prior).toEqual(cardOnly ? null : {
        repo, pr, head, status: 'finished', result: { status: 'skipped' },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
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

  it.each(['ran', 'resumed'])('completed %s does not settle', status => {
    const f = fixture({ status });
    runReviewJob({ repo, pr }, f.io);
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

  it.each([
    { status: 'deferred' }, { status: 'deferred-by-budget' },
    { status: 'skipped', deferredByCap: true }, { status: 'skipped', deferredByGuard: true },
    { status: 'not-owed' }, { status: 'not-owed', deferredByGuard: true },
  ])('deferral or not-owed outcome does not settle or publish needs-you: %j', redTeam => {
    const f = fixture(redTeam);
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.runRedTeam).toHaveBeenCalledOnce();
    expect(f.io.settleRedTeamSkip).not.toHaveBeenCalled();
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
      const production = createReviewJobIo({ env, readEvidence: () => ({ inFlight: false, queued: false }) });
      const loopPayload = payload();
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
