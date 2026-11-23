// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTimeouts, resolveLimits, classify, softRecord, durationMs } from '../test-timeout-policy.mjs';

const policy = JSON.parse(readFileSync(new URL('../../settings/test-timeout-policy.json', import.meta.url), 'utf8'));
const file = 'a.test.mjs', job = 'test-shard (1)';
const limits = resolveLimits(policy, { file, job });
const killed = ms => ({ runnerLimitMs: ms, truncated: true });
const evaluate = (measure, p = policy) => classify(measure, resolveLimits(p, { file, job }));

describe('SHIP-TMO closed outcomes first', () => {
  it('no configured bounds alerts without quarantine', () => {
    expect(evaluate(killed(limits.softMs), {})).toMatchObject({ class: 'unconfigured', outputs: [{ type: 'alert' }] });
  });
  it.each([undefined, policy.all.soft, 'PT1S'])('hard missing or <= soft acts as hard (%s)', hard => {
    const p = { all: { ...policy.all, hard } };
    expect(evaluate(killed(limits.softMs), p).class).toBe('hard');
    expect(evaluate({ durationMs: limits.softMs + 1 }, p).class).toBe('hard');
  });
  it('runner at hard never quarantines, regardless of G1 setting', () => {
    for (const runnerKillAtHard of [false, true]) expect(evaluate(killed(limits.hardMs), { all: { ...policy.all, runnerKillAtHard } })).toMatchObject({ class: 'hard', outputs: [{ type: 'red-main' }] });
  });
  it('runnerKillAtHard true treats all truncations as hard', () => {
    expect(evaluate(killed(limits.softMs), { all: { ...policy.all, runnerKillAtHard: true } }).class).toBe('hard');
  });
  it('unknown kill point remains hard under G1', () => {
    expect(evaluate(killed(limits.softMs + 1)).class).toBe('hard');
  });
  it('does not borrow a timeout from before a new FAIL header or an invalid file', () => {
    expect(parseTimeouts('Error: Test timed out in 5000ms.\nFAIL ../a.test.mjs > a\nTest timed out in 5000ms.\nFAIL a.test.mjs > a\nFAIL b.test.mjs\nTest timed out in 5000ms.')).toEqual([]);
  });
  it('invalid duration settings fail closed', () => {
    expect(evaluate(killed(1), { all: { soft: 'bogus', hard: 'PT' } }).class).toBe('unconfigured');
    expect(durationMs('P999999999999999D')).toBeNull();
  });
  it.each([
    'AssertionError: expected "Test timed out in 5000ms." to equal "ok"',
    'AssertionError: expected true to be false\nError: Test timed out in 5000ms.',
    'AssertionError: mismatch\n\nTest timed out in 5000ms.',
    'diagnostic: Error: Test timed out in 5000ms.',
    'Error: ordinary failure\nError: Test timed out in 5000ms.',
    'Error: Test timed out in 5000ms. quoted diagnostic',
    '`Error: Test timed out in 5000ms.`',
    'Error: Test timed out in 5000ms.\u2028assertion diagnostic',
    'Error: ordinary failure\r\nError: Test timed out in 5000ms.',
  ])('rejects timeout text in ordinary failure diagnostics: %s', error => {
    expect(parseTimeouts(`FAIL a.test.mjs > case\n${error}`)).toEqual([]);
  });
});

it('G1 at soft records a soft unknown with its conformity loss', () => {
  expect(evaluate(killed(limits.softMs))).toMatchObject({ class: 'soft', verdict: { result: 'unknown' }, conformityLoss: 'runner-kills-at-soft (G1)', outputs: [{ type: 'quarantine' }, { type: 'alert' }, { type: 'fix-card', priority: 'high' }] });
});
it('nontruncated boundaries classify per SHIP-TMO-009', () => {
  expect(evaluate({ durationMs: limits.softMs }).class).toBe('headroom');
  expect(evaluate({ durationMs: limits.softMs + 1 }).class).toBe('soft');
  expect(evaluate({ durationMs: limits.hardMs }).class).toBe('soft');
  expect(evaluate({ durationMs: limits.hardMs + 1 }).class).toBe('hard');
});
it('a passing measurement in headroom emits exactly one warning', () => {
  const o = evaluate({ status: 'pass', durationMs: Math.ceil(limits.softMs * (1 - limits.headroom)) });
  expect(o).toMatchObject({ class: 'headroom', verdict: { result: 'pass' }, outputs: [{ type: 'warning' }] });
  expect(evaluate({ status: 'pass', durationMs: limits.softMs + 1 }).class).toBe('soft');
  expect(evaluate({ status: 'pass', durationMs: limits.softMs }, { all: { ...policy.all, headroom: undefined } }).outputs).toEqual([]);
});
it('cascades all → jobs → tests independently and records sources', () => {
  const p = { ...policy, jobs: { [job]: { soft: 'PT6S' } }, tests: { [file]: { hard: 'PT12S' } } };
  expect(resolveLimits(p, { file, job })).toMatchObject({ softMs: 6000, hardMs: 12000, headroom: policy.all.headroom,
    sources: { soft: { scope: `jobs.${job}` }, hard: { scope: `tests.${file}` }, headroom: { scope: 'all' } } });
});
it('soak own-limit override resolves to 1,020,000 ms and hard is twice soft', () => {
  const l = resolveLimits(policy, { file: 'scripts/conveyor/soak/daemon-soak.soak.test.mjs', job: 'soak-shard (1)' });
  expect(l.softMs).toBe(1020000); expect(l.hardMs).toBe(l.softMs * 2);
});
it('ANSI and timestamp parser attaches each timeout to the nearest named failure', () => {
  expect(parseTimeouts(`2026-11-22T23:25:07.6237099Z \x1b[31m FAIL \x1b[0m a.test.mjs > suite > name\n2026-11-22T23:25:07Z Error: Test timed out in ${limits.softMs}ms.`)).toEqual([{ file, name: 'suite > name', runnerLimitMs: limits.softMs, truncated: true }]);
});
it('accepts a complete timeout error with CRLF and blank separator lines', () => {
  expect(parseTimeouts('FAIL a.test.mjs > case\r\n\r\nError: Test timed out in 5000ms.\r\n')).toEqual([
    { file, name: 'case', runnerLimitMs: 5000, truncated: true },
  ]);
});
it('escalation counts entries within the policy window, release carries settings or approval', () => {
  const entry = { test: file, job, timeouts: [evaluate(killed(limits.softMs))] };
  const now = Date.parse('2026-11-22T00:00:00Z');
  const first = softRecord(entry, { now, run: 1 });
  expect(first.priority).toBe('high');
  expect(first.release).toEqual({ passesUnderSoft: policy.all.release.passes });
  const second = softRecord(entry, { now: now + 1, run: 2, history: [first] });
  expect(second.priority).toBe('urgent');
  expect(second.outputs.find(o => o.type === 'escalation').entries).toEqual([first.id, second.id]);
  expect(softRecord(entry, { now: now + durationMs(policy.all.escalation.window) + 3600000, run: 3, history: [first] }).priority).toBe('high');
  const absent = { test: file, job, timeouts: [evaluate(killed(limits.softMs), { all: { ...policy.all, escalation: undefined, release: undefined } })] };
  expect(softRecord(absent, { now, run: 1 })).toMatchObject({ priority: 'urgent', release: { approvalRequired: true } });
});
it('recording the same run twice keeps priority high', () => {
  const entry = { test: file, job, timeouts: [evaluate(killed(limits.softMs))] };
  const first = softRecord(entry, { now: 1000, run: 1 });
  const repeated = softRecord(entry, { now: 1001, run: 1, history: [first, first] });
  expect(repeated.priority).toBe('high');
  expect(repeated.outputs.some(o => o.type === 'escalation')).toBe(false);
});
