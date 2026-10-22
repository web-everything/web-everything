import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRedTeam, speculateRedTeam } from '../review-extra-seats.mjs';
import { writeRun } from '../run-store.mjs';
import { provenanceRun } from '../../lib/__tests__/fixtures/saved-red-team-provenance.mjs';

const pr = 5762, repo = 'web-everything/web-everything', rev = 'a'.repeat(40);
const read = { netBasis: { rev }, netChangedFiles: ['scripts/example.mjs'], diffText: '+export const example = true;' };
const loopPayload = { verdict: { verdict: 'accept' }, findings: { read } };
const prior = { dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', repo, pr, rev,
  callId: 'stored-call', provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' };

for (const entry of [runRedTeam, speculateRedTeam]) {
  describe(`${entry.name} resumeOnly`, () => {
    let root, env;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'red-team-resume-only-'));
      env = { CONVEYOR_STATE_ROOT: root, OPERATION_RUNS_DIR: join(root, 'runs') };
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    const run = io => entry({ pr, repo, read, loopPayload, env, resumeOnly: true }, io);
    function fakeIo(readRecords) {
      return { readRecords, now: () => 1_000, log: () => {},
        cliAvailable: vi.fn(), reserveCalls: vi.fn(), runSeat: vi.fn(), runRecheck: vi.fn(),
        listComments: () => [], postComment: vi.fn(), append: vi.fn() };
    }
    function noCalls(io) {
      for (const key of ['cliAvailable', 'reserveCalls', 'runSeat', 'runRecheck']) expect(io[key], key).not.toHaveBeenCalled();
    }
    it('fails closed on an unreadable scorecard store without provider selection, reservation or model calls', async () => {
      const io = fakeIo(() => { throw Error('EIO'); });
      expect(await run(io)).toEqual({ status: 'skipped', reason: 'resume-only: scorecard store unreadable — no call launched' });
      noCalls(io);
    });
    it.each([[], [{ ...prior, status: 'error' }], [{ ...prior, rev: 'b'.repeat(40) }]])('refuses scorecards with no clean prior row: %j', async records => {
      const io = fakeIo(() => records);
      expect(await run(io)).toEqual({ status: 'skipped', reason: 'resume-only: no clean prior red-team row — no call launched' });
      noCalls(io);
    });
    it('resumes a clean prior row and finishes its comment without new reservation or model calls', async () => {
      writeRun(provenanceRun({ env, rows: [prior] }), env.OPERATION_RUNS_DIR);
      const io = fakeIo(() => [prior]);
      expect(await run(io)).toMatchObject({ status: 'resumed', callId: prior.callId, comment: { status: 'posted' } });
      expect(io.postComment).toHaveBeenCalledOnce();
      noCalls(io);
    });
    it.each(['missing', 'incomplete', 'wrong-repo', 'wrong-head', 'wrong-path', 'hash-mismatch', 'missing-row-repo'])(
      'refuses a clean row with %s provenance without new calls', async kind => {
        const records = [{ ...prior }];
        const proof = provenanceRun({ env, rows: records });
        if (kind === 'incomplete') proof.cursor = 0;
        if (kind === 'wrong-repo') proof.input.repo = 'other/repo';
        if (kind === 'wrong-head') proof.findings.read.netBasis.rev = 'b'.repeat(40);
        if (kind === 'wrong-path') proof.findings.savedRedTeamResult.references[0].path = join(root, 'other.json');
        if (kind === 'hash-mismatch') proof.findings.savedRedTeamResult.sha256 = '0'.repeat(64);
        if (kind === 'missing-row-repo') delete records[0].repo;
        if (kind !== 'missing') writeRun(proof, env.OPERATION_RUNS_DIR);
        const io = fakeIo(() => records);
        expect(await run(io)).toEqual({ status: 'skipped', reason: 'resume-only: no clean prior red-team row — no call launched' });
        expect(io.postComment).not.toHaveBeenCalled();
        noCalls(io);
      });
  });
}
