import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { writeRun, readRun } from '../run-store.mjs';
import { provenanceRun } from '../../lib/__tests__/fixtures/saved-red-team-provenance.mjs';
import { requestDrainRedTeam, readDrainRedTeamRequests } from '../../lib/drain-red-team-requests.mjs';
import { readSavedRedTeamResult } from '../../lib/drain-saved-red-team.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { createReviewJobIo, runReviewJob } from '../review-job.mjs';
const request = { repo: 'web-everything/web-everything', pr: 12, head: 'a'.repeat(40), requestedAt: 1 };
function fixture() {
  const payload = { runId: 'review-pr-existing', verdict: { verdict: 'accept' }, findings: {
    read: { netBasis: { rev: request.head }, diffText: '+code', netChangedFiles: ['scripts/x.mjs'] } } };
  const io = { root: '/repo', now: () => 100, log: vi.fn(), claim: () => ({ ok: true }), unclaim: vi.fn(), updateRecord: vi.fn(),
    readDrainRedTeamState: vi.fn(() => ({ headRefOid: request.head, state: 'OPEN', labels: ['review:accepted', 'ready-to-merge'] })),
    readDrainRedTeamReview: () => payload, acquireLane: vi.fn(() => ({ lanePath: '/lane' })), releaseLane: vi.fn(),
    runRedTeam: vi.fn(() => ({ status: 'ran', callId: 'call', seat: { status: 'ok' } })),
    recordSavedRedTeamResult: vi.fn(() => true), finishDrainRedTeamRequest: vi.fn(), runRedTeamGate: vi.fn(),
  };
  return { io, payload };
}
describe('drain request through the review job red-team path', () => {
  it('runs a pinned needs-human review once the PR carries live acceptance', () => {
    const { io, payload } = fixture();
    payload.verdict = { verdict: 'needs-human' };
    const result = runReviewJob({ ...request, drainRedTeamRequest: request }, io);
    expect(result.outcome).toBe('ran');
    // The consumer stamps the head it just read as live-accepted; the pass's owed gate accepts only that head.
    expect(io.runRedTeam).toHaveBeenCalledWith(expect.objectContaining({ loopPayload: { ...payload, acceptedPrHead: request.head } }));
    expect(io.finishDrainRedTeamRequest).toHaveBeenCalledWith(request);
  });
  it('uses the existing exact-head review and finishes only after saving provenance', () => {
    const { io, payload } = fixture();
    runReviewJob({ ...request, drainRedTeamRequest: request }, io);
    expect(io.runRedTeam.mock.calls[0][0].loopPayload).toEqual({ ...payload, acceptedPrHead: request.head });
    expect(io.recordSavedRedTeamResult).toHaveBeenCalledWith(expect.objectContaining({ runId: payload.runId, head: request.head }));
    expect(io.finishDrainRedTeamRequest).toHaveBeenCalledWith(request);
    expect(io.recordSavedRedTeamResult.mock.invocationCallOrder[0]).toBeLessThan(io.finishDrainRedTeamRequest.mock.invocationCallOrder[0]);
    expect(io.releaseLane).toHaveBeenCalled();
    expect(io.updateRecord).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/lane' }));
  });
  it('retires a moved head as stale without acquiring a lane or running a model', () => {
    const { io } = fixture(); io.readDrainRedTeamState.mockReturnValue({ headRefOid: 'b'.repeat(40) });
    runReviewJob({ ...request, drainRedTeamRequest: request }, io);
    expect(io.finishDrainRedTeamRequest).toHaveBeenCalledWith(request, { status: 'stale' });
    expect(io.acquireLane).not.toHaveBeenCalled(); expect(io.runRedTeam).not.toHaveBeenCalled();
  });
  it.each(['review:human', 'review:changes', 'review:pending'])('retains a blocked request (%s)', label => {
    const { io } = fixture(); io.readDrainRedTeamState.mockReturnValue({ headRefOid: request.head, state: 'OPEN', labels: ['review:accepted', 'ready-to-merge', label] });
    runReviewJob({ ...request, drainRedTeamRequest: request }, io);
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.finishDrainRedTeamRequest).not.toHaveBeenCalled();
  });
  it.each(['error', 'disabled', 'skipped'])('does not consume an unsaved result (%s)', status => {
    const { io } = fixture(); io.runRedTeam.mockReturnValue({ status });
    runReviewJob({ ...request, drainRedTeamRequest: request }, io);
    expect(io.finishDrainRedTeamRequest).not.toHaveBeenCalled();
  });
  it('does not consume when provenance cannot be saved', () => {
    const { io } = fixture(); io.recordSavedRedTeamResult.mockImplementation(() => { throw Error('disk'); });
    expect(() => runReviewJob({ ...request, drainRedTeamRequest: request }, io)).toThrow('disk');
    expect(io.finishDrainRedTeamRequest).not.toHaveBeenCalled(); expect(io.releaseLane).toHaveBeenCalled();
  });
  it.each(['kill-switch', 'card-only', 'ci-blocked', 'no-lane', 'live-job', 'unattested'])('keeps admission guards (%s)', mode => {
    const { io, payload } = fixture();
    if (mode === 'kill-switch') io.redTeamEnabled = () => false;
    if (mode === 'card-only') { io.skipCardOnly = () => true; payload.findings.read.netChangedFiles = ['backlog/1-card.md']; }
    if (mode === 'ci-blocked') io.readDrainRedTeamCi = () => ({ allowed: false, headSha: request.head });
    if (mode === 'no-lane') io.acquireLane.mockReturnValue({ lanePath: null });
    if (mode === 'live-job') io.claim = () => ({ ok: false });
    if (mode === 'unattested') io.recordSavedRedTeamResult.mockReturnValue(false);
    runReviewJob({ ...request, drainRedTeamRequest: request }, io);
    expect(io.finishDrainRedTeamRequest).not.toHaveBeenCalled();
    expect(io.runRedTeam).toHaveBeenCalledTimes(mode === 'unattested' ? 1 : 0);
  });
  it('revalidates the head after acquiring a lane', () => {
    const { io } = fixture(); io.readDrainRedTeamState.mockReturnValueOnce({ headRefOid: request.head, state: 'OPEN', labels: ['review:accepted', 'ready-to-merge'] }).mockReturnValue({ headRefOid: 'b'.repeat(40) });
    runReviewJob({ ...request, drainRedTeamRequest: request }, io);
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.finishDrainRedTeamRequest).toHaveBeenCalledWith(request, { status: 'stale' });
  });
});

it('consumes the durable request only after its saved evidence is admissible to drain', () => {
  const root = mkdtempSync(join(tmpdir(), 'drain-red-team-job-'));
  try {
    const env = { WE_COORDINATION_ROOT: join(root, 'coord'), CONVEYOR_STATE_ROOT: root, OPERATION_RUNS_DIR: join(root, 'runs') };
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: request.repo, pr: request.pr,
      rev: request.head, callId: 'persisted-call', status: 'ok', recheckStatus: 'ok', findings: [], confirmedMissCount: 0 };
    const path = resolveScorecardStorePath(env);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ records: [row] }));
    const run = provenanceRun({ env, rows: [row] }); delete run.findings.savedRedTeamResult;
    run.findings.read.diffText = '+code'; writeRun(run, env.OPERATION_RUNS_DIR);
    expect(requestDrainRedTeam(request, { env }).requested).toBe(true);
    const durable = readDrainRedTeamRequests({ env })[0];
    const real = createReviewJobIo({ env, dir: join(root, 'jobs') });
    const { io } = fixture();
    io.readDrainRedTeamReview = real.readDrainRedTeamReview;
    io.recordSavedRedTeamResult = real.recordSavedRedTeamResult;
    io.finishDrainRedTeamRequest = real.finishDrainRedTeamRequest;
    io.runRedTeam.mockReturnValue({ status: 'ran', callId: row.callId, seat: row });
    runReviewJob({ ...request, drainRedTeamRequest: durable }, io);
    expect(readRun(run.id, env.OPERATION_RUNS_DIR).findings.savedRedTeamResult.writer).toBe('review-job');
    expect(readSavedRedTeamResult({ ...request, env, log: () => {} })).toMatchObject({ findings: [], recheckIncomplete: false });
    expect(readDrainRedTeamRequests({ env })).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('falls back from a refused preferred lane to auto-pick and logs every lane refusal (live #5485)', () => {
    const { io } = fixture();
    io.acquireLane.mockReturnValueOnce({ lanePath: null, error: 'lane-hold: a verify gate is running' });
    const result = runReviewJob({ ...request, drainRedTeamRequest: request, preferLane: 21 }, io);
    expect(io.acquireLane.mock.calls.map(([o]) => [o.lane ?? null, o.waitMs])).toEqual([[21, 0], [null, 60_000]]);
    expect(result.outcome).toBe('ran');
    expect(io.log.mock.calls.some(([l]) => l.includes('preferred lane-21 not taken (lane-hold: a verify gate is running)'))).toBe(true);
    const { io: io2 } = fixture();
    io2.acquireLane.mockReturnValue({ lanePath: null, error: 'pool full' });
    expect(runReviewJob({ ...request, drainRedTeamRequest: request }, io2)).toMatchObject({ outcome: 'deferred-no-lane', reason: 'pool full' });
    expect(io2.log.mock.calls.some(([l]) => l.includes('red team — no lane (pool full)'))).toBe(true);
  });
