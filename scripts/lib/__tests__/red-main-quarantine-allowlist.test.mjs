// @vitest-environment node
import { it, expect } from 'vitest';
import * as q from '../red-main-quarantine.mjs';
import escape from '../../conveyor/soak/breaks/red-main-quarantine-log-escape-sequences.mjs';

const file = 'scripts/example.test.mjs', job = 'test-shard (1)', now = 1000;
const V = `❯ ${file} (1 test | 1 failed)
 × fails
   → expected true to be false
⎯ Failed Tests 1 ⎯
 FAIL ${file} > fails
AssertionError: expected true to be false
- true
+ false
 ❯ ${file}:10:2
⎯⎯⎯⎯⎯
 Test Files  1 failed | 2 passed
 Tests  1 failed | 8 passed
##[error]Process completed with exit code 1.`;
const plan = parsed => q.planSafetyNet({ status: 'red', firstRedSha: 'aaaaaaa', failedJobs: [job],
  jobFailures: { [job]: parsed }, now, flakeProof: { [job]: { kind: 'rerun-passed', runId: 1, attempt: 2 } } });
const beforeSeparator = text => V.replace('⎯⎯⎯⎯⎯', `${text}\n⎯⎯⎯⎯⎯`);
const head = text => V.replace('AssertionError: expected true to be false', text);
const negatives = [
  ['01 bare ENOSPC in block', [beforeSeparator('ENOSPC')]],
  ['02 ENOSPC after summary', [V.replace('##[error]Process', 'ENOSPC\n##[error]Process')]],
  ['03 ENOSPC after trailer', [`${V}\nENOSPC`]],
  ['04 ENOSPC in setup', [`ENOSPC\n${V}`]],
  ['05 worker failure', [`${V}\nError: Worker forks error`, `${V}\nWorker exited unexpectedly`]],
  ['06 Unhandled Errors', [`${V}\n⎯ Unhandled Errors ⎯`]],
  ['07 invalid error head', [head('TypeError: broken'), head('Error: ENOSPC'), head('Error: expected true to be false')]],
  ['08 hook timeout head', [head('Error: Hook timed out in 5000ms.')]],
  ['09 process killed', [V.replace('exit code 1', 'exit code 137'), `${V}\nKilled`, `${V}\nSIGKILL`]],
  ['10 coverage threshold', [`${V}\nERROR: Coverage threshold not met`]],
  ['11 canceled or exceeded', [`${V}\n##[error]The operation was canceled`, `${V}\nmaximum duration exceeded`]],
  ['12 inconsistent summaries', [V.replace('Tests  1 failed', 'Tests  2 failed'), `${V}\nTest Files 1 failed`, V.replace(' Tests  1 failed | 8 passed\n', ''), V.replace('Failed Tests 1', 'Failed Tests 2')]],
  ['13 indented ENOSPC', [beforeSeparator('    ENOSPC')]],
  ['14 missing head', [head('')]],
  ['15 stderr console block', [beforeSeparator('stderr | scripts/example.test.mjs > fails\nError: boom'), beforeSeparator('stdout | scripts/example.test.mjs > fails\nhello')]],
  ['16 node:test only', ['TAP version 13\nnot ok 1 - fails\n# tests 1\n# fail 1']],
  ['17 stale parser evidence', null],
];
it.each(negatives)('rejects %s', (name, logs) => {
  if (logs) {
    for (const log of logs) {
      const parsed = q.parseVitestFailures(log);
      expect(parsed.complete, log).toBe(false);
      expect(plan(parsed).action, log).toBe('none');
    }
    return;
  }
  const entry = { test: file, brokenSha: 'aaaaaaa', owner: 'operator', reason: 'red', addedAt: 0,
    expiresAt: 10000, parserVersion: 3, proof: { kind: 'rerun-passed', runId: 1, attempt: 2 } };
  for (const evidence of [{ proof: entry.proof }, { proof: undefined, timeout: { runnerLimitMs: 5000 } }]) {
    const list = { version: 1, entries: [{ ...entry, ...evidence }] };
    expect(q.activeEntries(list, { now })).toEqual([]);
    expect(q.testsToSkip({ list, now })).toEqual([]);
    expect(q.planSafetyNet({ status: 'red', list, now }).action).toBe('prune');
    const pruned = q.pruneOnGreen(list, { mainGreen: null, now });
    expect(pruned.list.entries).toEqual([]);
    expect(pruned.events[0].why).toBe('parser-version');
  }
});

it.each([
  ['base V', V],
  ['claimed code, stack and diff', beforeSeparator(`  10 | throw new Error('x')\n    at new FooError (scripts/example.test.mjs:10:2)\n+ Error: x`)],
  ['timeout with progress arrow', head('Error: Test timed out in 5000ms.').replace('→ expected true to be false', '→ Test timed out in 5000ms.')],
  ['escape soak fixture', null],
])('accepts %s', async (name, log) => {
  if (log === null) {
    const report = await escape.run({});
    expect(escape.judge(report)).toEqual([]);
    expect(report.read.failures.complete).toBe(true);
    return;
  }
  const parsed = q.parseVitestFailures(log);
  expect(parsed.complete).toBe(true);
  expect(parsed.tests).toEqual([{ file, name: 'fails' }]);
  if (name.startsWith('timeout')) expect(parsed.timeouts).toEqual([{ file, name: 'fails', runnerLimitMs: 5000, truncated: true }]);
});

it('caps oversized veto diagnostics at five and keeps the red held for operator repair', () => {
  const parsed = q.parseVitestFailures(`${V}\n${Array(100).fill('ENOSPC').join('\n')}`);
  expect(parsed.complete).toBe(false);
  expect(parsed.parserVersion).toBe(4);
  expect(parsed.vetoes).toHaveLength(5);
  expect(parsed.vetoes.every(v => Number.isInteger(v.line) && typeof v.reason === 'string')).toBe(true);
  expect(plan(parsed)).toMatchObject({ action: 'none', why: expect.stringContaining('unknown') });
});
