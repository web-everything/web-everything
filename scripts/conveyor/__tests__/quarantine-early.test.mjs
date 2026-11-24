// @vitest-environment node
import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as q from '../../lib/red-main-quarantine.mjs';
import { runSafetyNet, SAFETY_NET_LEDGER } from '../../lib/red-main-quarantine-io.mjs';
import smell from '../health-smells/main-ci-red.mjs';
import { parseTimeouts } from '../../lib/test-timeout-policy.mjs';

const file = 'scripts/conveyor/soak/daemon-soak.soak.test.mjs';
const job = 'soak-shard (1)', now = Date.parse('2026-11-22T23:05:00Z');
// Run 45080540441: timeout text from handoff events.live.json, line 304 of job 137404406023.
// File reporter line reconstructed from the prep; this is not the complete archived job log.
const fragment = `❯ ${file} (1 test | 1 failed)\n  → Test timed out in 1020000ms.`;
// Synthetic complete assertion log exercises repeat proof without timeout policy.
const log = `FAIL ${file} > fails\nAssertionError: broken\nTest Files 1 failed`;
const red = { databaseId: 45080540441, headSha: '70001b920c55f4423d028a2a18d3d79c8a8b2757', status: 'completed', conclusion: 'timed_out',
  createdAt: '2026-11-22T22:57:00Z', updatedAt: '2026-11-22T23:00:00Z', attempt: 1 };
const failure = () => q.parseVitestFailures(log);
const run = (overrides = {}) => ({ ...red, jobFailures: { [job]: failure() }, ...overrides });
const plan = (overrides = {}) => q.planSafetyNet({ status: 'red', firstRedSha: red.headSha, failedJobs: [job],
  jobFailures: { [job]: failure() }, now, latestRunId: red.databaseId, touchedFiles: () => [], ...overrides });

it.each([
  `FAIL ${file} > slow case\nError: Test timed out in 5000ms.`,
  fragment,
  `RUN ${file}\nError: The job has exceeded the maximum execution time`,
  `RUN ${file}\nError: There was an error during teardown`,
  `❯ ${file} (1 test | 1 failed)\nError: Test timed out in 5000ms.`,
])('rejects summaryless timeout/teardown/soak fragments: %s', text => {
  expect(q.parseVitestFailures(text).complete).toBe(false);
  expect(plan({ jobFailures: { [job]: q.parseVitestFailures(text) } }).action).toBe('none');
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

it('requires proof for complete assertions and classifies every accepted timeout', () => {
  expect(plan().action).toBe('none');
  const text = `FAIL ${file} > slow\nError: Test timed out in 5000ms.\nTest Files 1 failed`;
  const timed = { ...q.parseVitestFailures(text), timeouts: parseTimeouts(text) };
  const proof = { [job]: { kind: 'rerun-passed', runId: red.databaseId, attempt: 2 } };
  expect(timed.complete).toBe(true);
  expect(timed.timeouts).toEqual([{ file, name: 'slow', runnerLimitMs: 5000, truncated: true }]);
  const soft = { all: { soft: 'PT5S', hard: 'PT10M', runnerKillAtHard: false } };
  expect(plan({ jobFailures: { [job]: timed }, flakeProof: proof, timeoutPolicy: soft }).tests).toEqual([file]);
});

it('still refuses to quarantine a hard or unconfigured timeout (early quarantine never widens what can be quarantined)', () => {
  const text = `FAIL ${file} > slow\nError: Test timed out in 5000ms.\nTest Files 1 failed`;
  const timed = { ...q.parseVitestFailures(text), timeouts: parseTimeouts(text) };
  const proof = { [job]: { kind: 'rerun-passed', runId: red.databaseId, attempt: 2 } };
  for (const timeoutPolicy of [{}, { all: { soft: 'PT1S', hard: 'PT2S' } }]) {
    const p = plan({ jobFailures: { [job]: timed }, flakeProof: proof, timeoutPolicy });
    expect(p.action).toBe('none');
    expect(p.why).toMatch(/timeout policy/);
  }
});

it.each([
  ['same-file assertion then timeout', `FAIL ${file} > assertion\nAssertionError: broken\nFAIL ${file} > slow\nError: Test timed out in 5000ms.`],
  ['RUN plus teardown', `RUN ${file}\nError: There was an error during teardown`],
  ['zero failed reporter', `❯ ${file} (1 test | 0 failed)\nError: Test timed out in 5000ms.`],
  ['unattributed extra timeout', `FAIL ${file} > slow\nError: Test timed out in 5000ms.\nError: Test timed out in 5000ms.`],
  ['extra worker error', `FAIL ${file} > slow\nError: Test timed out in 5000ms.\nError: Worker exited unexpectedly`],
  ['unsupported reporter arrow', fragment],
  ['unsupported reporter Error', `❯ ${file} (1 test | 1 failed)\nError: Test timed out in 5000ms.`],
])('escalates %s even with a summary and rerun proof', (_, text) => {
  const parsed = { ...q.parseVitestFailures(`${text}\nTest Files 1 failed`), timeouts: parseTimeouts(text) };
  expect(parsed.complete).toBe(false);
  expect(plan({ jobFailures: { [job]: parsed }, flakeProof: { [job]: { kind: 'rerun-passed', runId: red.databaseId, attempt: 2 } } }).action).toBe('none');
});

it('reads touchedFiles for same-SHA repeats and refuses unknown evidence', () => {
  let calls = 0;
  const p = plan({ repeatRuns: [run({ attempt: 1 }), run({ attempt: 2, createdAt: '2026-11-22T23:01:00Z' })],
    latestAttempt: 2, touchedFiles: (...shas) => { calls++; expect(shas).toEqual([red.headSha, red.headSha]); return null; } });
  expect(calls).toBe(1);
  expect(p).toMatchObject({ action: 'none', why: expect.stringContaining('touched files unknown') });
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

it('publishes synthetic complete repeat evidence; unknown failures escalate immediately', () => {
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
    console.info('synthetic complete-log dry-run', JSON.stringify({ at: new Date(now).toISOString(), entries: replay.plan.entries }));
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

// A file summary cannot account for an additional infrastructure crash.
it.each(['Unhandled Rejection', 'Uncaught Exception', 'Worker exited unexpectedly', 'Worker failed', 'teardown failed'])(
  'rejects a complete assertion summary with extra crash: %s', diagnostic => {
    expect(q.parseVitestFailures(`${log}\n${diagnostic}`).complete).toBe(false);
  });

it.each(['AssertionError: broken', 'Error: expected true to be false'])(
  'keeps ordinary assertion diagnostics complete: %s', diagnostic => {
    expect(q.parseVitestFailures(`FAIL ${file} > fails\n${diagnostic}\nTest Files 1 failed`).complete).toBe(true);
  });

it.each(['startup_failure', 'cancelled', 'action_required', 'neutral', 'stale'])(
  'refuses repeat proof across intervening terminal %s', conclusion => {
    const earlier = run({ databaseId: 1, headSha: 'aaaaaaa', createdAt: '2026-11-22T22:50:00Z' });
    const gap = run({ databaseId: 2, createdAt: '2026-11-22T22:53:00Z', conclusion, jobFailures: {} });
    expect(plan({ repeatRuns: [earlier, gap, run()] })).toMatchObject({
      action: 'none', why: expect.stringContaining('consecutive main failures do not name this file'),
    });
  });

it.each(['startup_failure', 'cancelled', 'action_required', 'neutral', 'stale'])(
  'keeps terminal %s in the IO repeat window without reading its jobs', conclusion => {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-early-'));
  const earlier = { ...red, databaseId: 1, createdAt: '2026-11-22T22:50:00Z' };
  const readIds = [];
  const gap = { ...red, databaseId: 2, headSha: 'bbbbbbb', createdAt: '2026-11-22T22:53:00Z', conclusion };
  try {
    const out = runSafetyNet({ dir, now, live: false,
      mainCiRuns: { runs: [earlier, gap, red], failing: { runId: red.databaseId, jobs: [job] } },
      mode: { value: 'quarantine' }, settings: { value: q.QUARANTINE_SAFETY_NET_DEFAULTS },
      timeoutPolicy: {}, touchedFiles: () => [], readLog: failure,
      readJobs: id => { readIds.push(id); return { failed: [{ name: job, id: 1 }] }; }, log: () => {} });
    expect(out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('consecutive main failures do not name this file') });
    expect(readIds).not.toContain(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([undefined, 1])('re-reads cached failures with parser version %s', parserVersion => {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-early-'));
  let reads = 0;
  const invoke = () => runSafetyNet({ dir, now, live: false,
    mainCiRuns: { runs: [red], failing: { runId: red.databaseId, jobs: [job] } },
    mode: { value: 'quarantine' }, settings: { value: q.QUARANTINE_SAFETY_NET_DEFAULTS },
    timeoutPolicy: {}, touchedFiles: () => [], readJobs: () => ({ failed: [{ name: job, id: 1 }] }),
    readLog: () => { reads++; return reads === 1 ? failure() : q.parseVitestFailures('unreadable crash'); }, log: () => {} });
  try {
    invoke();
    const path = join(dir, SAFETY_NET_LEDGER), ledger = JSON.parse(readFileSync(path, 'utf8'));
    const rec = Object.values(ledger.reds)[0];
    rec.parserVersion = parserVersion;
    rec.readRetryAt = now + 60_000; // version changes also reset stale retry backoff
    writeFileSync(path, JSON.stringify(ledger));
    const out = invoke();
    expect(reads).toBe(2);
    expect(out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('unknown') });
    expect(Object.values(JSON.parse(readFileSync(path, 'utf8')).reds)[0]).toMatchObject({
      parserVersion: q.QUARANTINE_PARSER_VERSION, jobFailures: {},
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([undefined, 1])('refuses cached attempt proof with parser version %s', parserVersion => {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-early-'));
  const invoke = r => runSafetyNet({ dir, now, live: false,
    mainCiRuns: { runs: [r], failing: { runId: r.databaseId, jobs: [job] } },
    mode: { value: 'quarantine' }, settings: { value: q.QUARANTINE_SAFETY_NET_DEFAULTS },
    timeoutPolicy: {}, touchedFiles: () => [], readJobs: () => ({ failed: [{ name: job, id: 1 }] }), readLog: failure, log: () => {} });
  try {
    invoke(red);
    const path = join(dir, SAFETY_NET_LEDGER), ledger = JSON.parse(readFileSync(path, 'utf8'));
    Object.values(ledger.reds)[0].attempts['1'].parserVersion = parserVersion;
    writeFileSync(path, JSON.stringify(ledger));
    expect(invoke({ ...red, attempt: 2, updatedAt: '2026-11-22T23:04:00Z' }).plan.action).toBe('none');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('emits unknown-failure escalation even with an existing live quarantine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-early-'));
  const list = { ...q.addEntries(null, { tests: ['scripts/other.test.mjs'], brokenSha: red.headSha,
    owner: 'operator', reason: 'known flake', actor: 'operator', now, ttlMs: 60_000 }).list, mode: 'quarantine' };
  const emitted = [];
  try {
    const out = runSafetyNet({ dir, now, live: true,
      mainCiRuns: { runs: [red], failing: { runId: red.databaseId, jobs: [job] } },
      mode: { value: 'quarantine' }, settings: { value: q.QUARANTINE_SAFETY_NET_DEFAULTS },
      timeoutPolicy: {}, readJobs: () => ({ failed: [{ name: job, id: 1 }] }),
      readLog: () => q.parseVitestFailures('unreadable crash'), readList: () => ({ ok: true, list }),
      write: () => { throw new Error('must not write'); }, log: line => emitted.push(line) });
    expect(out.applied).toBe(false);
    expect(out.liveEntries).toHaveLength(1);
    expect(out.alerts).toContainEqual(expect.objectContaining({ type: 'escalation', why: expect.stringContaining('unknown') }));
    expect(emitted.some(line => line.includes('"type":"escalation"'))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
