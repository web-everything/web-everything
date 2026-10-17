// @vitest-environment node
import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSafetyNet, SAFETY_NET_SHADOW_LOG, SAFETY_NET_LEDGER } from '../red-main-quarantine-io.mjs';
import { QUARANTINE_SAFETY_NET_DEFAULTS, parseVitestFailures } from '../red-main-quarantine.mjs';
import { findMergeGroupFlakeEvidence } from '../../conveyor/main-ci-red-core.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/red-main-quarantine-62da75ed3.json', import.meta.url), 'utf8'));
const now = Date.parse(fixture.now);
const file = 'scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs';
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
// Hypothetical same-commit proof: the recorded episode had no re-run, so addition scenarios supply an earlier
// run of the failing sha whose re-run passed integration (the failing run's own latest attempt still failed it).
const PROOF_RUN = 7;
const rerunJobs = [{ name: 'integration', conclusion: 'failure', run_attempt: 1 }, { name: 'integration', conclusion: 'success', run_attempt: 2 }];
function replay({ old = false, proof = true, rerun = false, entries = [], mutateRuns = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-replay-'));
  dirs.push(dir);
  if (entries.length) writeFileSync(join(dir, SAFETY_NET_LEDGER), JSON.stringify({ version: 1, reds: {}, shadowList: { version: 1, entries } }));
  const mainCiRuns = structuredClone(fixture.mainCiRuns);
  if (!proof) delete mainCiRuns.failing.groupEvidence;
  if (rerun) mainCiRuns.runs.push({ ...mainCiRuns.runs[0], databaseId: PROOF_RUN, createdAt: '2026-10-14T06:08:00Z', updatedAt: '2026-10-14T06:15:00Z', attempt: 2 });
  mutateRuns(mainCiRuns);
  const out = runSafetyNet({ mainCiRuns, dir, now, mode: { value: 'stop', source: 'tool' }, live: false,
    settings: { value: { ...QUARANTINE_SAFETY_NET_DEFAULTS, ...(old ? { unitJobPattern: '^test-shard \\(\\d+\\)$', requireProvenFlake: false, fileCardPerEntry: false } : {}) }, sources: {} },
    readJobs: (id, opts) => (opts?.filter === 'all' ? { jobs: id === PROOF_RUN ? rerunJobs : [] } : { failed: fixture.failedJobs }),
    readLog: () => parseVitestFailures(fixture.log),
    readList: () => ({ ok: true, list: { version: 1, entries } }), log: () => {},
  });
  return { out, line: JSON.parse(readFileSync(join(dir, SAFETY_NET_SHADOW_LOG), 'utf8').trim()) };
}
it('replays the old coverage gap and records its none decision', () => {
  const { out, line } = replay({ old: true });
  expect(out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('integration') });
  expect(line).toMatchObject({ wouldDo: 'none', why: out.plan.why });
});
it('requires proof when group evidence is absent', () => {
  const { out } = replay({ proof: false });
  expect(out.plan).toMatchObject({ action: 'none', why: 'not a proven flake: integration (no green re-run of the failing commit)' });
});
it.each([
  ['unrelated base', (runs) => { runs.failing.groupEvidence.baseSha = 'deadbee'; }],
  ['future completion', (runs) => { runs.failing.groupEvidence.completedAt = '2099-01-01T00:00:00Z'; }],
  ['unrelated base and future completion', (runs) => {
    runs.failing.groupEvidence.baseSha = 'deadbee';
    runs.failing.groupEvidence.completedAt = '2099-01-01T00:00:00Z';
  }],
  ['missing base', (runs) => { delete runs.failing.groupEvidence.baseSha; }],
  ['missing completion', (runs) => { delete runs.failing.groupEvidence.completedAt; }],
  ['invalid completion', (runs) => { runs.failing.groupEvidence.completedAt = 'unknown'; }],
  ['non-string completion', (runs) => { runs.failing.groupEvidence.completedAt = 0; }],
  ['missing failing head', (runs) => {
    // Keep a valid red-window subject while the selected failing run has no code identity.
    runs.runs.push({ ...runs.runs[0], databaseId: 7, createdAt: '2026-10-14T06:08:00Z' });
    delete runs.runs[0].headSha;
  }],
  ['missing failing run', (runs) => { runs.failing.runId = 7; }],
  ['a different current tip', (runs) => { runs.tip = { sha: 'abcdef1' }; }],
  ['coverage of the current tip but different failing code', (runs) => {
    runs.tip = { sha: 'abcdef1' };
    runs.failing.groupEvidence.baseSha = runs.tip.sha;
  }],
])('rejects merge-group evidence with %s through the safety-net IO path', (_, mutate) => {
  const { out, line } = replay({ mutateRuns: (runs) => {
    // Isolate each invalid fact from the recorded fixture's unrelated base.
    runs.failing.groupEvidence.baseSha = runs.runs[0].headSha;
    mutate(runs);
  } });
  expect(out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('not a proven flake: integration') });
  expect(line.wouldDo).toBe('none');
});
it('never takes a green merge group as flake proof: it tested the queued PR, which may fix the failure', () => {
  // PR #5283 red team: A fails deterministically; PR #99 fixes it and its merge group (base A) passes.
  const A = 'a'.repeat(40);
  const groupRuns = [{ databaseId: 99, status: 'completed', conclusion: 'success', updatedAt: '2026-10-14T06:25:00Z',
    headBranch: `gh-readonly-queue/main/pr-99-${A}`, headSha: 'b'.repeat(40) }];
  const groupEvidence = findMergeGroupFlakeEvidence({ groupRuns, tipSha: A, failedJobs: ['integration'],
    jobsOf: () => [{ name: 'integration', conclusion: 'success' }] });
  expect(groupEvidence).toMatchObject({ runId: 99, baseSha: A });
  const { out, line } = replay({ mutateRuns: (runs) => {
    runs.runs[0].headSha = A;
    runs.tip = { sha: A };
    runs.failing.groupEvidence = groupEvidence;
  } });
  expect(out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('not a proven flake: integration') });
  expect(line.wouldDo).toBe('none');
});
it('rejects the recorded group coverage because its base differs from the failing code', () => {
  expect(fixture.mainCiRuns.failing.groupEvidence.baseSha).not.toBe(fixture.mainCiRuns.runs[0].headSha);
  expect(replay().out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('not a proven flake: integration') });
});
it('replays a hypothetical green re-run of the failing commit as a shadow addition with one owed card', () => {
  const { out, line } = replay({ rerun: true });
  expect(out.plan.entries[0].proof).toEqual({ kind: 'rerun-passed', runId: PROOF_RUN, attempt: 2 });
  expect(out.shadow).toBe(true);
  expect(out.liveEntries).toEqual([]);
  expect(line).toMatchObject({ wouldDo: 'add', tests: [file] });
  expect(out.plan.entries).toEqual([expect.objectContaining({ test: file, job: 'integration' })]);
  expect(line.cards).toHaveLength(1);
  expect(line.cards[0]).toMatchObject({ test: file, job: 'integration', brokenSha: '62da75ed3', title: expect.stringMatching(/^Quarantined flaky test: .* \(integration\) — fix or delete before .* ET$/) });
});
it('caps live entries plus new files', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ test: `scripts/old-${i}.test.mjs`, brokenSha: 'abcdef1', owner: 'operator', reason: 'flake', addedAt: now - 1000, expiresAt: now + 100000 }));
  expect(replay({ entries, rerun: true }).out.plan).toMatchObject({ action: 'none', why: 'quarantine cap 5 reached' });
});
