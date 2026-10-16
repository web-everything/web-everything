// @vitest-environment node
import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSafetyNet, SAFETY_NET_SHADOW_LOG, SAFETY_NET_LEDGER } from '../red-main-quarantine-io.mjs';
import { QUARANTINE_SAFETY_NET_DEFAULTS, parseVitestFailures } from '../red-main-quarantine.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/red-main-quarantine-62da75ed3.json', import.meta.url), 'utf8'));
const now = Date.parse(fixture.now);
const file = 'scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs';
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function replay({ old = false, proof = true, entries = [], mutateRuns = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-replay-'));
  dirs.push(dir);
  if (entries.length) writeFileSync(join(dir, SAFETY_NET_LEDGER), JSON.stringify({ version: 1, reds: {}, shadowList: { version: 1, entries } }));
  const mainCiRuns = structuredClone(fixture.mainCiRuns);
  if (!proof) delete mainCiRuns.failing.groupEvidence;
  mutateRuns(mainCiRuns);
  const out = runSafetyNet({ mainCiRuns, dir, now, mode: { value: 'stop', source: 'tool' }, live: false,
    settings: { value: { ...QUARANTINE_SAFETY_NET_DEFAULTS, ...(old ? { unitJobPattern: '^test-shard \\(\\d+\\)$', requireProvenFlake: false, fileCardPerEntry: false } : {}) }, sources: {} },
    readJobs: () => ({ failed: fixture.failedJobs }), readLog: () => parseVitestFailures(fixture.log),
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
  expect(out.plan).toMatchObject({ action: 'none', why: 'not a proven flake: integration (no green re-run or merge-group run on the main tip)' });
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
it('accepts merge-group evidence completed by now on the failing code', () => {
  const { out } = replay({ mutateRuns: (runs) => {
    runs.failing.groupEvidence.baseSha = runs.runs[0].headSha;
    runs.failing.groupEvidence.completedAt = fixture.now;
    runs.tip = { sha: runs.runs[0].headSha };
  } });
  expect(out.plan.action).toBe('add');
});
it('rejects the recorded group coverage because its base differs from the failing code', () => {
  expect(fixture.mainCiRuns.failing.groupEvidence.baseSha).not.toBe(fixture.mainCiRuns.runs[0].headSha);
  expect(replay().out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('not a proven flake: integration') });
});
it('replays hypothetical same-code group coverage as a shadow addition with one owed card', () => {
  const { out, line } = replay({ mutateRuns: (runs) => { runs.failing.groupEvidence.baseSha = runs.runs[0].headSha; } });
  expect(out.shadow).toBe(true);
  expect(out.liveEntries).toEqual([]);
  expect(line).toMatchObject({ wouldDo: 'add', tests: [file] });
  expect(out.plan.entries).toEqual([expect.objectContaining({ test: file, job: 'integration' })]);
  expect(line.cards).toHaveLength(1);
  expect(line.cards[0]).toMatchObject({ test: file, job: 'integration', brokenSha: '62da75ed3', title: expect.stringMatching(/^Quarantined flaky test: .* \(integration\) — fix or delete before .* ET$/) });
});
it('caps live entries plus new files', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ test: `scripts/old-${i}.test.mjs`, brokenSha: 'abcdef1', owner: 'operator', reason: 'flake', addedAt: now - 1000, expiresAt: now + 100000 }));
  expect(replay({ entries, mutateRuns: (runs) => { runs.failing.groupEvidence.baseSha = runs.runs[0].headSha; } }).out.plan).toMatchObject({ action: 'none', why: 'quarantine cap 5 reached' });
});
