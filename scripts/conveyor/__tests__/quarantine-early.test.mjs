// @vitest-environment node
import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as q from '../../lib/red-main-quarantine.mjs';
import { runSafetyNet } from '../../lib/red-main-quarantine-io.mjs';
import smell from '../health-smells/main-ci-red.mjs';
import * as core from '../main-ci-red-core.mjs';
import { parseTimeouts } from '../../lib/test-timeout-policy.mjs';

const file = 'scripts/conveyor/soak/daemon-soak.soak.test.mjs';
const job = 'soak-shard (1)', now = Date.parse('2026-11-22T23:05:00Z');
// Run 45080540441: timeout text from handoff events.live.json, line 304 of job 137404406023.
// File reporter line reconstructed from the prep; this is not the complete archived job log.
const log = `❯ ${file} (1 test | 1 failed)\n  → Test timed out in 1020000ms.`;
const red = { databaseId: 45080540441, headSha: '70001b920c55f4423d028a2a18d3d79c8a8b2757', status: 'completed', conclusion: 'timed_out',
  createdAt: '2026-11-22T22:57:00Z', updatedAt: '2026-11-22T23:00:00Z', attempt: 1 };
const failure = () => q.parseVitestFailures(log);
const run = (overrides = {}) => ({ ...red, jobFailures: { [job]: failure() }, ...overrides });
const plan = (overrides = {}) => q.planSafetyNet({ status: 'red', firstRedSha: red.headSha, failedJobs: [job],
  jobFailures: { [job]: failure() }, now, latestRunId: red.databaseId, touchedFiles: () => [], ...overrides });

it.each([
  `FAIL ${file} > slow case\nError: Test timed out in 5000ms.`,
  log,
  `RUN ${file}\nError: The job has exceeded the maximum execution time`,
  `RUN ${file}\nError: There was an error during teardown`,
  `❯ ${file} (1 test | 1 failed)\nError: Test timed out in 5000ms.`,
])('names timeout/teardown/soak failures without a summary: %s', text => {
  expect(q.parseVitestFailures(text)).toMatchObject({ files: [file], complete: true });
});

it('never promotes a passing file, an ambiguous job timeout, or an incomplete ordinary failure', () => {
  for (const text of [`✓ other.test.mjs\nError: job timed out`,
    `RUN a.test.mjs b.test.mjs\nError: job timed out`, `FAIL ${file} > assertion\nAssertionError: broken`]) {
    expect(q.parseVitestFailures(text).complete).toBe(false);
  }
  const p = plan({ jobFailures: { [job]: failure(), integration: q.parseVitestFailures('FAIL other.test.mjs\nTest Files 1 failed') },
    flakeProof: { [job]: { kind: 'rerun-passed', runId: red.databaseId, attempt: 2 } } });
  expect(p.tests).toEqual([file]);
});

it('accepts count two on consecutive main SHAs but refuses an intervening different failure', () => {
  const earlier = run({ databaseId: 1, headSha: 'aaaaaaa', createdAt: '2026-11-22T22:50:00Z' });
  expect(plan({ repeatRuns: [earlier, run()] }).tests).toEqual([file]);
  const gap = run({ databaseId: 2, createdAt: '2026-11-22T22:53:00Z', jobFailures: {} });
  expect(plan({ repeatRuns: [earlier, gap, run()] }).action).toBe('none');
});

it.each([
  'RUN a.test.mjs b.test.mjs\nFAIL a.test.mjs > assertion\nError: job timed out',
  'FAIL a.test.mjs > assertion\nError: job timed out',
  'RUN a.test.mjs b.test.mjs\nFAIL a.test.mjs > slow\nError: Test timed out in 5000ms.',
  'FAIL a.test.mjs > assertion\nAssertionError: broken\nFAIL b.test.mjs > slow\nError: Test timed out in 5000ms.',
  'FAIL a.test.mjs > assertion\nAssertionError: broken\nError: Test timed out in 5000ms.',
])('rejects partial mixed-failure logs with unattributable interruption: %s', text => {
  const parsed = q.parseVitestFailures(text);
  expect(parsed.complete).toBe(false);
  expect(plan({ jobFailures: { [job]: parsed },
    flakeProof: { [job]: { kind: 'rerun-passed', runId: red.databaseId, attempt: 2 } } }).action).toBe('none');
});

it('requests the proof rerun for a timeout-only soak log; a passing rerun still proves a flake', () => {
  expect(core.classifyFlakeRun({ run: red, failures: core.parseVitestFailures(log) }).eligible).toBe(true);
  const text = `FAIL ${file} > slow\nError: Test timed out in 5000ms.`;
  expect(plan({ jobFailures: { [job]: { ...q.parseVitestFailures(text), timeouts: parseTimeouts(text) } },
    flakeProof: { [job]: { kind: 'rerun-passed', runId: red.databaseId, attempt: 2 } } }).tests).toEqual([file]);
});

it('refuses missing owner/TTL, bounds lifetime, and never skips expired entries', () => {
  const options = { tests: [file], brokenSha: red.headSha, owner: 'operator', reason: 'failed main',
    actor: 'operator', now, ttlMs: q.QUARANTINE_MAX_TTL_MS * 2 };
  for (const missing of ['owner', 'ttlMs']) {
    const bad = { ...options }; delete bad[missing];
    expect(q.addEntries(null, bad).ok).toBe(false);
  }
  const { list } = q.addEntries(null, options);
  expect(list.entries[0].expiresAt).toBe(now + q.QUARANTINE_MAX_TTL_MS);
  expect(q.testsToSkip({ list, now: now + q.QUARANTINE_MAX_TTL_MS })).toEqual([]);
});

it('replays 45080540441: one FAILED rerun publishes; unknown failures escalate immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-early-'));
  let list = { version: 1, entries: [] }, logs = [];
  const invoke = (r, readLog = failure, live = true) => runSafetyNet({ dir, now, live,
    mainCiRuns: { runs: [r], failing: { runId: r.databaseId, jobs: [job] } },
    mode: { value: 'quarantine', source: 'fixture' }, settings: { value: q.QUARANTINE_SAFETY_NET_DEFAULTS },
    timeoutPolicy: {}, touchedFiles: () => [], readJobs: () => ({ failed: [{ name: job, id: 1 }] }), readLog,
    readList: () => ({ ok: true, list }), log: line => logs.push(line),
    write: ({ change }) => { const result = change(list); expect(result.ok).toBe(true); list = result.list; return result; } });
  try {
    const first = invoke(red);
    expect(first.applied).toBe(false);
    expect(first.alerts[0].why).toMatch(/not a proven flake/);
    const retry = { ...red, attempt: 2, updatedAt: '2026-11-22T23:04:00Z' };
    const replay = invoke(retry, failure, false);
    expect(replay.plan.tests).toEqual([file]);
    console.info('45080540441 reconstructed dry-run', JSON.stringify({ at: new Date(now).toISOString(), entries: replay.plan.entries }));
    const second = invoke(retry);
    expect(second.applied).toBe(true);
    expect(list.entries[0]).toMatchObject({ test: file, owner: 'red-main-safety-net', proof: { kind: 'repeat-failed', attempts: [1, 2] } });
    const output = smell.evaluate({ mainCiRuns: { runs: [red] } }, { now, config: {}, quarantineSafetyNet: () => first });
    expect(output[0].summary).toContain(first.alerts[0].why);
    list = { version: 1, entries: [] };
    const unknown = invoke({ ...red, databaseId: 99 }, () => q.parseVitestFailures('unreadable crash'));
    expect(unknown.applied).toBe(false);
    expect(unknown.alerts).toContainEqual(expect.objectContaining({ type: 'escalation', at: now, why: expect.stringContaining('unknown') }));
    expect(logs.some(line => line.includes('escalation'))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
