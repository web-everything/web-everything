/** Stranded accepts must be discovered even though normal review planning skips accepted PRs. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as daemon from '../review-daemon.mjs';
import { createFileRunStore } from '../../../scripts/operations/run-store.mjs';
import { RESUME_MAX_ATTEMPTS } from '../../../scripts/operations/review-loop-cli.mjs';
import { strandedRecord, DEAD_OWNER, RECOVERY_OWNER, STRANDED_HEAD, STRANDED_REPO } from '../../../scripts/operations/__fixtures__/stranded-record.fixture.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'stranded-sweep-')); dirs.push(dir);
  const store = createFileRunStore(dir), run = strandedRecord(); store.write(run);
  const dispatch = vi.fn(() => ({ dispatched: true, pid: 99999 }));
  const options = { dir, runsDir: dir, store, repo: STRANDED_REPO, owner: RECOVERY_OWNER,
    readRuns: () => [store.read(run.id)], readRun: id => store.read(id),
    pidIdentity: vi.fn(() => ({ alive: false, reason: 'gone' })), dispatch,
    readPr: () => ({ number: 7493, state: 'OPEN', headRefOid: STRANDED_HEAD, labels: [{ name: 'review:accepted' }] }),
    leaseHeld: () => true, ciAllowed: () => true, cooldownActive: () => false,
    now: () => Date.parse('2026-11-26T16:00:00Z'), log: () => {},
  };
  return { dir, store, run, dispatch, options };
}
async function sweep(f) {
  expect(daemon.sweepStrandedRecordEffects, 'the sweep must inspect run records, not just review:pending PRs').toBeTypeOf('function');
  return daemon.sweepStrandedRecordEffects(f.options);
}
describe('stranded record sweep', () => {
  it('stranded record sweep dispatches one pinned job', async () => {
    const f = fixture(); await sweep(f);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0][0]).toMatchObject({ resumeRun: f.run.id, claimToken: expect.any(String) });
    expect(f.store.read(f.run.id).effects[0].status).toBe('pending');
  });
  it('second tick does not double-dispatch', async () => {
    const f = fixture(); await sweep(f); await sweep(f);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['live', f => f.options.pidIdentity.mockReturnValue({ alive: true })],
    ['unknown', f => f.options.pidIdentity.mockReturnValue({ alive: null })],
    ['unstamped', f => { delete f.run.owner; }],
    ['foreign host', f => { f.run.owner.host = 'foreign'; }],
    ['foreign namespace', f => { f.run.owner.namespace = 'pid:[987]'; }],
    ['null namespace', f => { f.run.owner.namespace = null; }],
    ['malformed owner', f => { f.run.owner = { ...DEAD_OWNER, procStart: null }; }],
    ['cap reached', f => { f.run.strandedResumeAttempts = RESUME_MAX_ATTEMPTS; }],
    ['lease not held', f => { f.options.leaseHeld = () => false; }],
    ['CI not allowed', f => { f.options.ciAllowed = () => false; }],
    ['cooldown active', f => { f.options.cooldownActive = () => true; }],
  ])('%s -> no dispatch', async (_, mutate) => {
    const f = fixture(); mutate(f); f.store.write(f.run); await sweep(f);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
