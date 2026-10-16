// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { readDrainRedTeamEvidence, recordRedTeamStatus } from '../drain-red-team-evidence.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'drain-red-team-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  return { repo: 'web-everything/web-everything', pr: 5439, head: 'b'.repeat(40), runsDir,
    readScorecards: () => [], env: { WE_SHARED_RUNS_DIR: runsDir } };
}
const payload = head => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });

describe('drain reads actual head-bound review scheduler inputs', () => {
  it('does not invent an accept when no review run exists', () => {
    expect(readDrainRedTeamEvidence(fixture())).toEqual({ loopPayload: null, recorded: false, inFlight: false });
  });
  it('reads the persisted review payload and rejects stale heads, other PRs and repos', () => {
    const f = fixture();
    const run = { ...newRunRecord({ id: 'review-pr-5439', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) };
    writeRun(run, f.runsDir);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ loopPayload: run, recorded: false, inFlight: false });
    for (const mismatch of [{ head: 'a'.repeat(40) }, { pr: 5443 }, { repo: 'other/repo' }]) {
      expect(readDrainRedTeamEvidence({ ...f, ...mismatch }).loopPayload).toBeNull();
    }
  });
  it('honors an existing seat row even when the result comment was never posted', () => {
    const f = fixture();
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head, status: 'ok' };
    expect(readDrainRedTeamEvidence({ ...f, readScorecards: () => [row] }).recorded).toBe(true);
    for (const mismatch of [{ rev: 'a'.repeat(40) }, { repo: 'other/repo' }, { pr: 5443 }, { dispatchKind: 'review-seat-speculative-discard' }]) {
      expect(readDrainRedTeamEvidence({ ...f, readScorecards: () => [{ ...row, ...mismatch }] }).recorded).toBe(false);
    }
  });
  it('a skipped provider pass is not evidence that a red team ran', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'skipped' }, f);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ recorded: false, inFlight: false });
  });
  it('observes running, crashed and finished passes across reader restarts', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, f);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true })).toMatchObject({ recorded: false, inFlight: true });
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => false })).toMatchObject({ recorded: false, inFlight: false });
    expect(readDrainRedTeamEvidence({ ...f, head: 'a'.repeat(40) })).toMatchObject({ recorded: false, inFlight: false });
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, f);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true })).toMatchObject({ recorded: true, inFlight: false });
  });
});
