// @vitest-environment node
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as q from '../red-main-quarantine.mjs';
import escape from '../../conveyor/soak/breaks/red-main-quarantine-log-escape-sequences.mjs';

const file = 'scripts/example.test.mjs', job = 'test-shard (1)', now = 1000;
const V = `##[group]Run npx vitest run scripts/example.test.mjs
##[endgroup]
❯ ${file} (1 test | 1 failed)
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
  ['05 worker failure (regression guard)', [`${V}\nError: Worker forks error`, `${V}\nWorker exited unexpectedly`]],
  ['06 Unhandled Errors (regression guard)', [`${V}\n⎯ Unhandled Errors ⎯`]],
  ['07 invalid error head', [head('TypeError: broken'), head('Error: ENOSPC'), head('Error: expected true to be false')]],
  ['08 hook timeout head (regression guard)', [head('Error: Hook timed out in 5000ms.')]],
  ['09 process killed', [V.replace('exit code 1', 'exit code 137'), `${V}\nKilled`, `${V}\nSIGKILL`]],
  ['10 coverage threshold', [`${V}\nERROR: Coverage threshold not met`]],
  ['11 canceled or exceeded', [`${V}\n##[error]The operation was canceled`, `${V}\nmaximum duration exceeded`]],
  ['12 inconsistent summaries', [V.replace('Tests  1 failed', 'Tests  2 failed'), `${V}\nTest Files 1 failed`, V.replace(' Tests  1 failed | 8 passed\n', ''), V.replace('Failed Tests 1', 'Failed Tests 2')]],
  ['13 indented ENOSPC', [beforeSeparator('    ENOSPC')]],
  ['14 missing head', [head('')]],
  ['15 stderr console block', [beforeSeparator('stderr | scripts/example.test.mjs > fails\nError: boom'), beforeSeparator('stdout | scripts/example.test.mjs > fails\nhello')]],
  ['16 node:test only (regression guard)', ['TAP version 13\nnot ok 1 - fails\n# tests 1\n# fail 1']],
  ['17 stale parser evidence', null],
];
it.each(negatives)('rejects %s', (name, logs) => {
  if (logs) {
    for (const log of logs) {
      const parsed = q.parseVitestFailures(`${log}\nPost job cleanup.`);
      expect(parsed.complete, log).toBe(false);
      expect(plan(parsed).action, log).toBe('none');
    }
    return;
  }
  const entry = { test: file, brokenSha: 'aaaaaaa', owner: 'operator', reason: 'red', addedAt: 0,
    expiresAt: 10000, parserVersion: 4, proof: { kind: 'rerun-passed', runId: 1, attempt: 2 } };
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
  const parsed = q.parseVitestFailures(`${log}\nPost job cleanup.`);
  expect(parsed.complete).toBe(true);
  expect(parsed.tests).toEqual([{ file, name: 'fails' }]);
  if (name.startsWith('timeout')) expect(parsed.timeouts).toEqual([{ file, name: 'fails', runnerLimitMs: 5000, truncated: true }]);
});

it('caps oversized veto diagnostics at five and keeps the red held for operator repair', () => {
  const parsed = q.parseVitestFailures(`${V}\n${Array(100).fill('ENOSPC').join('\n')}`);
  expect(parsed.complete).toBe(false);
  expect(parsed.parserVersion).toBe(5);
  expect(parsed.vetoes).toHaveLength(5);
  expect(parsed.vetoes.every(v => Number.isInteger(v.line) && typeof v.reason === 'string')).toBe(true);
  expect(plan(parsed)).toMatchObject({ action: 'none', why: expect.stringContaining('unknown') });
});

it.each([
  ['no test step', V.replace(/^##\[group\]Run .*\n/, '')],
  ['two test steps', `${V}\n##[group]Run npm run test:unit`],
])('rejects %s with step-boundary', (_, text) => {
  expect(q.parseVitestFailures(text)).toMatchObject({ complete: false, vetoes: [{ reason: 'step-boundary' }] });
});

it.each(['× fails', `❯ ${file} > fails`])('claims ANSI progress arrow and continuation after %s without counting them', progress => {
  const text = V.replace('× fails\n   → expected true to be false',
    `\x1b[31m${progress}\x1b[39m\n\x1b[31m→ Error: Test timed out in 5000ms.\ncontinued Error: exceeded timeout\nmore assertion details\x1b[39m`);
  const parsed = q.parseVitestFailures(`${text}\nPost job cleanup.`);
  expect(parsed.complete).toBe(true);
  expect(parsed.tests).toEqual([{ file, name: 'fails' }]);
  expect(parsed.timeouts).toEqual([]);
});

it.each(['\n\n', '\n✓ passing.test.mjs (1 test)\n', '\n⎯⎯⎯\n', '\n× another test\n'])(
  'ends arrow continuations at blank/progress/separator %j', boundary => {
    const text = V.replace('→ expected true to be false', `→ expected true to be false\nclaimed Error details${boundary}ENOSPC`);
    expect(q.parseVitestFailures(text).complete).toBe(false);
  });

it.each(['Post job cleanup.', '##[group]Run echo cleanup'])(
  'applies only hard vetoes outside the test step ending at %s', boundary => {
    const setup = '##[group]Run npm ci\n##[endgroup]\n[DEP0169] DeprecationWarning: prone to errors\nError: setup exceeded time';
    const text = `${setup}\n${V}\n${boundary}\nError: teardown exceeded time`;
    expect(q.parseVitestFailures(text).complete).toBe(true);
    for (const token of ['ENOSPC', 'SIGKILL', 'Killed', 'OUT OF MEMORY', 'fatal', '::error', 'canceled', '##[error]extra']) {
      expect(q.parseVitestFailures(`${token}\n${text}`).complete, token).toBe(false);
      expect(q.parseVitestFailures(`${text}\n${token}`).complete, token).toBe(false);
    }
  });

it('does not claim extra CI error annotations inside progress or failure diagnostics', () => {
  for (const text of [V.replace('→ expected', '##[error]extra\n→ expected'),
    beforeSeparator('##[error]extra'), `##[error]setup\n${V}`]) {
    expect(q.parseVitestFailures(text).complete).toBe(false);
  }
});

it('freezes run 45080540441 as teardown-only negative evidence', () => {
  const text = readFileSync(new URL('./fixtures/red-main-quarantine-45080540441-negative.log', import.meta.url), 'utf8');
  const lines = text.split('\n');
  const teardown = lines.findIndex(line => line.includes('error during global teardown')) + 1;
  const trailer = lines.findIndex(line => line.includes('##[error]Process completed')) + 1;
  const parsed = q.parseVitestFailures(text);
  expect(parsed.complete).toBe(false);
  expect(parsed.tests).toHaveLength(1);
  expect(parsed.vetoes[0]).toEqual({ line: teardown, reason: 'unclaimed trouble token' });
  expect(parsed.vetoes.every(v => v.line >= teardown && v.line < trailer)).toBe(true);
});

it('accepts the SYNTHETIC soak-shard (3) positive: a real FAIL block with stderr and the annotation copy removed', () => {
  const text = readFileSync(new URL('./fixtures/red-main-quarantine-soak-shard-3-synthetic-positive.log', import.meta.url), 'utf8');
  const parsed = q.parseVitestFailures(text);
  expect(parsed.vetoes).toEqual([]);
  expect(parsed.complete).toBe(true);
  expect(parsed.tests).toHaveLength(1);
});

it('finds timestamped ANSI Run groups and ignores endgroup as a step boundary', () => {
  const text = V.replace('##[group]Run npx vitest run scripts/example.test.mjs',
    '2026-11-23T00:00:00.000Z \x1b[36m##[group]Run npx vitest run scripts/example.test.mjs\x1b[0m');
  expect(q.parseVitestFailures(`${text}\nPost job cleanup.`).complete).toBe(true);
});

it.each(['× fails', `❯ ${file} > fails`])(
  'rejects infrastructure diagnostics at every ANSI continuation position after %s and prevents quarantine', progress => {
    for (const diagnostic of ['Worker exited unexpectedly', 'Worker failed', 'ENOSPC', 'SIGKILL',
      'Killed', 'out of memory', 'FATAL', '::error', 'canceled', 'Unhandled Rejection',
      'Uncaught Exception', 'panic', 'Segmentation fault', 'core dumped', 'Aborted', 'teardown failed']) {
      for (const position of [0, 1, 2, 3]) {
        const diagnostics = ['→ expected true to be false', 'first assertion detail', 'second assertion detail'];
        if (position === 0) diagnostics[0] = `→ ${diagnostic}`;
        else diagnostics.splice(position, 0, diagnostic);
        const text = V.replace('× fails\n   → expected true to be false',
          `\x1b[31m${progress}\n${diagnostics.join('\n')}\x1b[39m`);
        const parsed = q.parseVitestFailures(`${text}\nPost job cleanup.`);
        expect(parsed.complete, `${diagnostic} at position ${position}`).toBe(false);
        expect(parsed.vetoes[0].reason).toBe('infrastructure failure in progress diagnostic');
        expect(plan(parsed).action).toBe('none');
      }
    }
  });
