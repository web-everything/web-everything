/** @file worker-wrapper-launch.test.mjs — wrapped launch, liveness and legacy completion compatibility. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  workerWrapperEnabledFor, wrappedArgvFromBg, wrappedTimeoutMs, launchWrappedClaudeWorker,
  wrappedRecordToAgentRow, listWrappedWorkerAgents,
} from '../worker-wrapper-launch.mjs';
import { newEnvelopeRecord, finishEnvelopeRecord, validateCompletionRecord } from '../completion-record.mjs';
import { tryReadCompletion, writeCompletion } from '../completion-store.mjs';
import { planDoneReport } from '../completion-cli.mjs';
import { preserveLegacyWords, runWorker } from '../worker-wrapper.mjs';
import { reviewJobResult } from '../review-job-envelope.mjs';
import { isClaimRunnerDead, countLiveFixSessions } from '../../lib/dispatch-throttle.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wr-launch-')); dirs.push(d); return d; };
const SESSION_ID = '12345678-1234-4234-8234-123456789abc';
const T0 = () => '2026-10-08T10:00:00.000Z';
const T1 = () => '2026-10-08T10:05:00.000Z';
const DONE = {
  v: 1, outcome: 'done', summary: 'fixed F1', blocker: null,
  findingsAddressed: [{ ref: 'F1', disposition: 'fixed', note: 'Fixed the finding' }],
  filesTouched: ['a.mjs'], learning: null,
};
const started = (over = {}) => newEnvelopeRecord({
  session: 'fix-7', role: 'fix', launcher: 'claude-p', pr: 7, pid: 111,
  timeoutMs: 60_000, sessionId: SESSION_ID, now: T0, ...over,
});

describe('workerWrapperEnabledFor', () => {
  it('honors explicit on and off', () => {
    for (const role of ['build', 'fix']) expect(workerWrapperEnabledFor(role, { WE_WORKER_WRAPPER: 'on' })).toBe(true);
    expect(workerWrapperEnabledFor('fix', { WE_WORKER_WRAPPER: 'off' })).toBe(false);
  });
  it('defaults migrated roles on outside tests and keeps build off', () => {
    for (const role of ['fix', 'ci-heal', 'review']) expect(workerWrapperEnabledFor(role, {})).toBe(true);
    expect(workerWrapperEnabledFor('build', {})).toBe(false);
    expect(workerWrapperEnabledFor('fix', { VITEST: 'true' })).toBe(false);
  });
});

describe('wrappedArgvFromBg', () => {
  it('keeps launch flags and adds the session, print mode, schema and prompt suffix', () => {
    const argv = wrappedArgvFromBg(['--bg', '-n', 'fix-12', '--settings', '{}', '--model', 'sonnet', 'PROMPT'], { sessionId: SESSION_ID });
    expect(argv).not.toContain('--bg');
    expect(argv.slice(0, 2)).toEqual(['--session-id', SESSION_ID]);
    for (const [flag, value] of [['-n', 'fix-12'], ['--settings', '{}'], ['--model', 'sonnet'], ['--output-format', 'json']]) {
      expect(argv).toContain(flag);
      expect(argv[argv.indexOf(flag) + 1]).toBe(value);
    }
    expect(argv).toContain('-p');
    // a --bg session runs in permission mode auto; -p must keep it (live-caught: ci-heal-4453 denied at step 0)
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(wrappedArgvFromBg(['--bg', '--permission-mode', 'acceptEdits', 'P'], { sessionId: SESSION_ID }).filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(argv).toContain('--json-schema');
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1])).toEqual(expect.any(Object));
    expect(argv.at(-1).startsWith('PROMPT')).toBe(true);
    expect(argv.at(-1)).toContain('StructuredOutput');
  });
  it('rejects resumes, non-background launches and non-UUID session ids', () => {
    expect(() => wrappedArgvFromBg(['--bg', '--resume', 'abc', 'p'], { sessionId: SESSION_ID })).toThrow(/resume/);
    expect(() => wrappedArgvFromBg(['-p', 'p'], { sessionId: SESSION_ID })).toThrow(/fresh/);
    expect(() => wrappedArgvFromBg(['--bg', 'p'], { sessionId: 'not-a-uuid' })).toThrow(/uuid/);
  });
});

describe('wrappedTimeoutMs', () => {
  it('uses role budgets and only accepts overrides of at least a minute', () => {
    expect(wrappedTimeoutMs('fix', {})).toBe(2 * 60 * 60 * 1000);
    expect(wrappedTimeoutMs('review', {})).toBe(60 * 60 * 1000);
    expect(wrappedTimeoutMs('fix', { WE_WORKER_WRAPPER_TIMEOUT_MS: '120000' })).toBe(120_000);
    expect(wrappedTimeoutMs('fix', { WE_WORKER_WRAPPER_TIMEOUT_MS: '5' })).toBe(2 * 60 * 60 * 1000);
  });
});

describe('launchWrappedClaudeWorker', () => {
  it('passes the wrapper spec to the injected launcher and returns a pid handle', () => {
    const specDir = tmp();
    const launch = vi.fn(() => ({ wrapperPid: 4321 }));
    const options = { role: 'fix', session: 'fix-12', bgArgv: ['--bg', '-n', 'fix-12', 'PROMPT'], pr: 12, sessionId: SESSION_ID, env: {}, specDir, launch };
    expect(launchWrappedClaudeWorker(options)).toMatchObject({ handle: 'pid:4321', wrapperPid: 4321, sessionId: SESSION_ID });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      role: 'fix', launcher: 'claude-p', session: 'fix-12', command: 'claude',
      legacyFromCompletion: true, preserveLegacyWords: true, timeoutMs: 7_200_000, pr: '12', sessionId: SESSION_ID,
    }), { specDir });
    launch.mockReturnValue({ wrapperPid: undefined });
    expect(launchWrappedClaudeWorker(options)).toMatchObject({ handle: null, wrapperPid: null });
  });
});

describe('wrapped worker agent rows', () => {
  it('exposes the started worker identity and observed liveness', () => {
    const rec = started();
    expect(rec.sessionId).toBe(SESSION_ID);
    expect(wrappedRecordToAgentRow(rec, { isAlive: () => true })).toMatchObject({ name: 'fix-7', state: 'working', pid: 111, sessionId: SESSION_ID });
    expect(wrappedRecordToAgentRow(rec, { isAlive: () => false }).state).toBe('stopped');
  });
  it('keeps a stopped done row for one day after completion', () => {
    const rec = finishEnvelopeRecord(started(), { result: DONE, parse: { ok: true, reason: null }, action: { type: 'done' }, outcome: 'done' }, T1);
    const ended = Date.parse(T1());
    expect(wrappedRecordToAgentRow(rec, { isAlive: () => false, nowMs: ended + 3_600_000 }).state).toBe('stopped');
    expect(wrappedRecordToAgentRow(rec, { isAlive: () => false, nowMs: ended + 25 * 3_600_000 })).toBeNull();
  });
  it('excludes node jobs, builds, records without a pid and v1 records', () => {
    for (const rec of [started({ launcher: 'node-job' }), started({ role: 'build' }), started({ pid: null }), { ...started(), v: 1 }]) {
      expect(wrappedRecordToAgentRow(rec, { isAlive: () => true })).toBeNull();
    }
  });
  it('lists only readable worker rows and tolerates an unreadable listing', () => {
    const dir = tmp();
    const rec = started();
    const list = vi.fn(() => ['fix-7', 'x']);
    const read = vi.fn((s) => s === 'fix-7' ? rec : null);
    const rows = listWrappedWorkerAgents({ dir, list, read, isAlive: () => true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'fix-7', state: 'working' });
    expect(list).toHaveBeenCalledWith(dir);
    expect(read).toHaveBeenCalledWith('fix-7', dir);
    expect(listWrappedWorkerAgents({ dir, list: () => { throw new Error('unreadable'); } })).toEqual([]);
  });
});

describe('planDoneReport', () => {
  it.each([['healed', 'done'], ['zzz', 'unparseable']])('maps %s on an existing v2 record to %s', (outcome, resultOutcome) => {
    const rec = planDoneReport({ existing: started({ pid: 5 }), session: 'fix-7', kind: 'fix', patch: { outcome, sessionId: SESSION_ID }, now: T1 });
    expect(rec).toMatchObject({ v: 2, status: 'done', outcome, pid: 5, sessionId: SESSION_ID, source: 'legacy-completion', result: { outcome: resultOutcome } });
    expect(validateCompletionRecord(rec)).toEqual({ ok: true, errors: [] });
  });
  it('retains v1 behavior without a started record', () => {
    const rec = planDoneReport({ existing: null, session: 'fix-7', kind: 'fix', patch: { outcome: 'healed', sessionId: SESSION_ID }, now: T1 });
    expect(rec).toMatchObject({ v: 1, status: 'done', outcome: 'healed' });
    expect(validateCompletionRecord(rec).ok).toBe(true);
  });
});

describe('preserveLegacyWords', () => {
  const envelope = { outcome: 'done', verdict: null, label: null };
  it('keeps the agent outcome and label from a done report', () => {
    expect(preserveLegacyWords(envelope, { status: 'done', outcome: 'needs-human', label: 'x', denied: null })).toEqual({ outcome: 'needs-human', verdict: null, label: 'x' });
  });
  it('leaves the envelope unchanged for started or absent reports', () => {
    expect(preserveLegacyWords(envelope, { status: 'started', outcome: 'needs-human', label: 'x' })).toEqual(envelope);
    expect(preserveLegacyWords(envelope, null)).toEqual(envelope);
  });
});

describe('runWorker legacy words with an injected child', () => {
  it.each([true, false])('preserveLegacyWords enabled: %s', async (preserve) => {
    const dir = tmp();
    const spec = {
      role: 'fix', launcher: 'claude-p', session: 'fix-9', command: 'claude', argv: ['-p', 'x'],
      completionsDir: dir, draftsDir: tmp(), postmortemMode: 'off', legacyFromCompletion: true,
      ...(preserve ? { preserveLegacyWords: true } : {}),
    };
    const spawnToCompletionFn = vi.fn(async () => ({ stdout: JSON.stringify({ type: 'result', structured_output: DONE }), stderr: '' }));
    const { envelope } = await runWorker(spec, { spawnToCompletionFn, legacyRead: () => ({ status: 'done', outcome: 'healed', label: 'L' }) });
    expect(spawnToCompletionFn).toHaveBeenCalledTimes(1);
    const expected = { v: 2, status: 'done', outcome: preserve ? 'healed' : 'done', label: preserve ? 'L' : null, parse: { ok: true }, result: { outcome: 'done' } };
    expect(envelope).toMatchObject(expected);
    expect(tryReadCompletion('fix-9', dir)).toMatchObject(expected);
  });
});

describe('dispatch throttle runner liveness', () => {
  it('only declares claims dead when they have a dead runner pid', () => {
    expect(isClaimRunnerDead({ meta: { runnerPid: 12 } }, () => false)).toBe(true);
    expect(isClaimRunnerDead({ meta: { runnerPid: 12 } }, () => true)).toBe(false);
    expect(isClaimRunnerDead({ meta: {} }, () => false)).toBe(false);
  });
  it('excludes a dead fix runner while retaining a ci-heal without a pid', () => {
    expect(countLiveFixSessions([{ meta: { kind: 'fix', runnerPid: 1 } }, { meta: { kind: 'ci-heal' } }], { alive: () => false })).toBe(1);
  });
});

describe('completion-store same-generation streak', () => {
  it('counts the agent report and wrapper finalization as one infra occurrence', () => {
    const dir = tmp();
    const rec = finishEnvelopeRecord(started({ pid: 5 }), {
      result: reviewJobResult({ outcome: 'blocked-on-infra' }), parse: { ok: true, reason: null },
      action: { type: 'retry' }, outcome: 'blocked-on-infra', source: 'legacy-completion',
    }, T1);
    writeCompletion(rec, dir);
    const first = tryReadCompletion('fix-7', dir);
    expect(first.infraStreak).toBe(1);
    writeCompletion({ ...rec, source: 'worker-result' }, dir);
    expect(tryReadCompletion('fix-7', dir)).toMatchObject({ infraStreak: 1, source: 'worker-result', startedAt: rec.startedAt, pid: 5 });
  });
});
