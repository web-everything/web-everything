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
function replay({ old = false, proof = true, entries = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-replay-'));
  dirs.push(dir);
  if (entries.length) writeFileSync(join(dir, SAFETY_NET_LEDGER), JSON.stringify({ version: 1, reds: {}, shadowList: { version: 1, entries } }));
  const mainCiRuns = structuredClone(fixture.mainCiRuns);
  if (!proof) delete mainCiRuns.failing.groupEvidence;
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
it('replays group coverage as a shadow addition with one owed card', () => {
  const { out, line } = replay();
  expect(out.shadow).toBe(true);
  expect(out.liveEntries).toEqual([]);
  expect(line).toMatchObject({ wouldDo: 'add', tests: [file] });
  expect(out.plan.entries).toEqual([expect.objectContaining({ test: file, job: 'integration' })]);
  expect(line.cards).toHaveLength(1);
  expect(line.cards[0]).toMatchObject({ test: file, job: 'integration', brokenSha: '62da75ed3', title: expect.stringMatching(/^Quarantined flaky test: .* \(integration\) — fix or delete before .* ET$/) });
});
it('caps live entries plus new files', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ test: `scripts/old-${i}.test.mjs`, brokenSha: 'abcdef1', owner: 'operator', reason: 'flake', addedAt: now - 1000, expiresAt: now + 100000 }));
  expect(replay({ entries }).out.plan).toMatchObject({ action: 'none', why: 'quarantine cap 5 reached' });
});
