import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterRunFileNames, listRunIds, newRunRecord, runPath, writeRun } from '../../operations/run-store.mjs';
import { abandonedPath, isRunAbandoned, markRunAbandoned } from '../run-abandoned.mjs';
import { closeConfirmRunsAfterClearance } from '../../review-set-label.mjs';
import { reapDeadReviewRuns } from '../reap-dead-review-runs.mjs';
import { readDrainRedTeamEvidence, readRecoveryWitness } from '../drain-red-team-evidence.mjs';
import { findSuspendedReferralRuns } from '../suspended-referral-run.mjs';
import { findResumableParkedRun, readReviewRunEvidence } from '../../conveyor/review-referral-hold.mjs';
import { readReviewRuns } from '../../conveyor/pass-daemons/pr-merge-watch-signals.mjs';
import { readAbandonedReviewSignal } from '../abandoned-review-signal.mjs';
import { archiveClosedReviewRuns } from '../archive-closed-review-runs.mjs';
import { loadRounds } from '../../operations/review-round-replay.mjs';
import { scanReviewJurorUsage } from '../../conveyor/run-rating.mjs';

const repo = 'fixture/repo', pr = 7109, head = 'a'.repeat(40), id = 'review-pr-round4';
const now = Date.now(), minute = 60_000;
let root, dir, env;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-abandon-round4-'));
  dir = join(root, 'runs'); mkdirSync(dir);
  env = { OPERATION_RUNS_DIR: dir, WE_PLATFORM_PREFERENCES_FILE: join(root, 'prefs.json') };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function fixture(pending = { kind: 'effect', step: 'record', stepIndex: 9 }) {
  const run = newRunRecord({ id, op: 'review-pr', input: { repo, pr } });
  run.pending = pending;
  run.findings = { read: { repo, pr, netBasis: { rev: head } } };
  run.verdict = { verdict: 'accept' };
  run.stepTimings = [{ step: 'read', stepIndex: 0, startedAt: new Date(now - 32 * minute).toISOString() }];
  writeRun(run, dir);
  utimesSync(runPath(id, dir), (now - 31 * minute) / 1000, (now - 31 * minute) / 1000);
  return run;
}
const gate = reader => reader({ repo, pr, head, runsDir: dir, env, now, readScorecards: () => [] });
const mark = () => markRunAbandoned({ id, dir, now, reason: 'dead', by: 'test', probes: {} });
function strayNames() {
  for (const name of ['review-pr-x.abandoned.json', 'junk file', 'review-pr-invalid!.json', 'review-pr-newline\n.json', `${id}.json.123.x.tmp`]) {
    writeFileSync(join(dir, name), '{');
  }
}

it('label-clearance, list, both gate scans, reaper and suspended-referral scans skip stray names and still read real runs', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  fixture({ kind: 'confirm', step: 'confirm', stepIndex: 9 }); strayNames();
  const resume = vi.fn(() => true);
  expect(closeConfirmRunsAfterClearance({ repo, pr, headSha: head, dir, resume })).toEqual({ closed: [id], failed: [] });
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledWith(id);
  expect(listRunIds(dir)).toEqual([id]);
  for (const reader of [readDrainRedTeamEvidence, readRecoveryWitness]) expect(gate(reader).reason).toBe('review-unfinished');
  fixture({ kind: 'effect', step: 'mandatoryReferrals', stepIndex: 9 });
  expect(findSuspendedReferralRuns({ repo, pr, head, now, runsDir: dir }).map(r => r.id)).toEqual([id]);
  fixture();
  const reaped = reapDeadReviewRuns({ dir, env, now, apply: true, tool: {}, log: () => {},
    probes: { reviewJobs: () => [], pidIdentity: () => ({ alive: false }), leases: () => '[]', sessions: () => '[]' } });
  expect(reaped.reaped).toEqual([id]); expect(reaped.scanned).toBe(1);
  expect(warn).toHaveBeenCalledTimes(5);
  for (const [line] of warn.mock.calls) {
    expect(line).toContain('skipping invalid run filename');
    expect(line).not.toMatch(/[\r\n]/);
  }
});

it.each(['new', 'legacy'])('%s tombstones hold gates and planners, including cached rows, without touching legacy evidence', location => {
  fixture();
  const parked = { ...readReviewRunEvidence({ dir, persist: false })[0], retryableRecordEffect: true };
  const subject = { number: pr, headRefOid: head, comments: [] };
  expect(findResumableParkedRun(subject, [parked], { repo, runsDir: dir })?.id).toBe(id);
  expect(mark().written).toBe(true);
  const path = join(root, 'run-tombstones', `${id}.json`), legacy = join(dir, `${id}.abandoned.json`);
  expect(abandonedPath(id, dir)).toBe(path);
  expect(existsSync(path)).toBe(true); expect(existsSync(legacy)).toBe(false);
  if (location === 'legacy') renameSync(path, legacy);
  const active = location === 'legacy' ? legacy : path;
  const bytes = readFileSync(active), mtime = statSync(active).mtimeMs;
  strayNames();
  expect(isRunAbandoned(id, dir)).toBe(true);
  for (const reader of [readDrainRedTeamEvidence, readRecoveryWitness]) expect(gate(reader).reason).toBe('review-abandoned');
  expect(readReviewRunEvidence({ dir, persist: false })).toEqual([]);
  expect(readReviewRuns({ dir, now })).toEqual([]);
  expect(findResumableParkedRun(subject, [parked], { repo, runsDir: dir })).toBeNull();
  expect(readAbandonedReviewSignal({ repo, pr, head, runsDir: dir, env, now, tool: {}, log: () => {} }))
    .toMatchObject({ awaitingFreshReview: true, escalate: false });
  expect(readAbandonedReviewSignal({ repo, pr, head, runsDir: dir, env, now: now + 31 * minute, tool: {}, log: () => {} }))
    .toMatchObject({ escalate: true, escalationContext: expect.stringContaining('replacement review never started') });
  expect(mark()).toEqual({ written: false, alreadyAbandoned: true });
  expect(existsSync(path)).toBe(location === 'new');
  expect(readFileSync(active)).toEqual(bytes); expect(statSync(active).mtimeMs).toBe(mtime);
  const run = fixture(); run.findings.progress = true; writeRun(run, dir);
  expect(isRunAbandoned(id, dir)).toBe(false);
  expect(readReviewRunEvidence({ dir, persist: false })).toHaveLength(1);
});

it('archive, replay, rating and cached planner enumerators skip invalid names before parsing/statting records', () => {
  const run = fixture();
  run.findings.reduce = { verdict: 'accept', admittedFindings: [] };
  run.telemetry = [{ model: 'unknown-model', lens: 'test', durationMs: 10, usage: { input_tokens: 7 } }];
  writeRun(run, dir); strayNames();
  expect(readReviewRunEvidence({ dir, persist: false })).toHaveLength(1);
  expect(readReviewRuns({ dir, now })).toHaveLength(1);
  expect(archiveClosedReviewRuns({ runsDir: dir, prState: () => 'OPEN' }).scanned).toBe(1);
  expect(loadRounds({ runsDir: dir, repo }).has(pr)).toBe(true);
  expect(scanReviewJurorUsage({ runsDirs: [dir] })).toMatchObject({ claudeRows: [], nonClaudeRows: [{ pr, tokens: { in: 7 } }] });
});

it.each(['OPERATION_RUNS_DIR', 'WE_SHARED_RUNS_DIR', 'WE_COORDINATION_ROOT'])('new tombstones follow %s and create their sibling folder on write', key => {
  fixture();
  vi.stubEnv('WE_UNDER_TEST', '1'); vi.stubEnv('OPERATION_RUNS_DIR', ''); vi.stubEnv('WE_SHARED_RUNS_DIR', '');
  vi.stubEnv(key, key === 'WE_COORDINATION_ROOT' ? join(root, 'coordination') : dir);
  expect(existsSync(join(root, 'run-tombstones'))).toBe(false);
  expect(abandonedPath(id)).toBe(join(root, 'run-tombstones', `${id}.json`));
  expect(markRunAbandoned({ id, now, reason: 'dead', by: 'test', probes: {} }).written).toBe(true);
  expect(readdirSync(join(root, 'run-tombstones'))).toEqual([`${id}.json`]);
  expect(readdirSync(dir)).toEqual([`${id}.json`]);
  expect(isRunAbandoned(id)).toBe(true);
});

it('filename warnings are one line, length bounded and emitted once per name across repeated scans', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const name = 'invalid\n\u001b\u2028' + 'x'.repeat(1000);
  expect(filterRunFileNames([name, name])).toEqual([]);
  expect(filterRunFileNames([name])).toEqual([]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0].length).toBeLessThan(300);
  expect(warn.mock.calls[0][0]).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

it('oversized invalid-name listings skip every stray and emit one explicit operator fallback at the warning cap', async () => {
  vi.resetModules();
  const { filterRunFileNames: filter } = await import('../../operations/run-store.mjs');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const names = Array.from({ length: 1002 }, (_, i) => `invalid name ${i}`);
  expect(filter([...names, `${id}.json`])).toEqual([`${id}.json`]);
  expect(filter(names)).toEqual([]);
  expect(warn).toHaveBeenCalledTimes(1001);
  expect(warn.mock.calls.at(-1)[0]).toContain('further names skipped; inspect the runs directory');
});
