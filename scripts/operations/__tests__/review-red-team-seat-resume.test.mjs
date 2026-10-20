// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provenanceRun } from '../../lib/__tests__/fixtures/saved-red-team-provenance.mjs';
import { writeRun } from '../run-store.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
import { finishSpeculativeRedTeam, redTeamReadFingerprint } from '../review-extra-seats.mjs';

const repo = 'web-everything/web-everything', rev = 'a'.repeat(40), pr = 6212;
const read = { title: 'guard', body: 'Claims: guard', diffText: '+guard',
  netChangedFiles: ['x.mjs'], netBasis: { base: 'b'.repeat(40), rev } };
const loopPayload = { verdict: { verdict: 'accept' }, findings: { read,
  judge: { findings: [{ summary: 'juror also found a problem' }] } } };
const env = { WE_RED_TEAM_TIMING: 'panel-seat' };
const prior = { dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev, status: 'ok',
  callId: 'old-call', provider: 'codex', model: 'test', findings: [], recheckStatus: 'ok',
  foldedVerdict: 'accept', confirmedMissCount: 0, changedFiles: ['x.mjs'] };

describe('panel seat reuses live-head evidence', () => {
  it.each(['changes', 'needs-human'])('a saved panel seat cannot bypass a not-owed %s review', async verdict => {
    const readRecords = vi.fn(() => [prior]);
    const out = await finishSpeculativeRedTeam({ pr, repo, env,
      loopPayload: { ...loopPayload, verdict: { verdict } },
      pass: { status: 'prior-row', rev, readFingerprint: redTeamReadFingerprint(read) } }, { readRecords });
    expect(out.status).toBe('not-owed');
    expect(readRecords).not.toHaveBeenCalled();
  });
  it('returns saved findings and re-check status when resuming a completed pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'red-team-seat-resume-'));
    roots.push(root);
    const provenEnv = { ...env, OPERATION_RUNS_DIR: join(root, 'runs'), CONVEYOR_STATE_ROOT: root };
    writeRun(provenanceRun({ env: provenEnv, rows: [prior] }), provenEnv.OPERATION_RUNS_DIR);
    const postComment = vi.fn(), runSeat = vi.fn();
    const out = await finishSpeculativeRedTeam({ pr, repo, env: provenEnv, loopPayload,
      pass: { status: 'prior-row', rev, readFingerprint: redTeamReadFingerprint(read) } }, {
      readRecords: () => [prior], now: () => Date.now(), log: () => {}, append: vi.fn(),
      listComments: () => [], postComment, runSeat,
    });
    expect(out).toMatchObject({ status: 'ran', rev, findings: [], recheckStatus: 'ok', confirmedMissCount: 0 });
    expect(runSeat).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledOnce();
  });

  it('a prior row never bypasses the pinned read fingerprint', async () => {
    const readRecords = vi.fn(() => [prior]);
    const out = await finishSpeculativeRedTeam({ pr, repo, env, loopPayload,
      pass: { status: 'prior-row', rev, readFingerprint: 'another-read' } }, { readRecords });
    expect(out.status).toBe('stale');
    expect(readRecords).not.toHaveBeenCalled();
  });
});
