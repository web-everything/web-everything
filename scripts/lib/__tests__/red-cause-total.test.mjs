import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyRedCause, reachesChanged, testReachesChanged, RED_CAUSES } from '../red-cause.mjs';

const red = (phase, tests = [], summary = '') => ({ phase, result: { exitCode: 1, signal: null, failureDetails: { tests, summary, truncated: false } } });
const ok = (phase) => ({ phase, result: { exitCode: 0, signal: null } });

// The review's "a red marker gets no redCause when the gate throws without a signal" — the catch block in verify-lane
// leaves exitCode=2, signal=null and an empty (or all-green) phaseResults.
describe('classifyRedCause is total: every non-zero verdict carries a declared cause', () => {
  it('a gate that threw before any phase finished (spawn error) is `infra`', () => {
    expect(classifyRedCause({ exitCode: 2, signal: null, infrastructure: null, phaseResults: [] })).toEqual({ redCause: 'infra', redCauseFiles: [] });
  });
  it('a gate that threw between green phases is `infra`', () => {
    expect(classifyRedCause({ exitCode: 2, phaseResults: [ok('vitest')] })).toEqual({ redCause: 'infra', redCauseFiles: [] });
  });
  it('a signal with no red phase is `killed-superseded`', () => {
    expect(classifyRedCause({ exitCode: 2, signal: 'SIGKILL', phaseResults: [] }).redCause).toBe('killed-superseded');
  });
  it('invariant: red implies a cause from RED_CAUSES, across exit codes, signals, phase shapes and retry states', () => {
    const phaseShapes = [[], [ok('vitest')], [ok('vitest'), ok('scan'), ok('standards')], [red('vitest')], [red('vitest', [{ file: 'a.test.mjs', name: null }])],
      [ok('vitest'), red('scan', [{ file: 'g.test.mjs', name: null }])], [ok('vitest'), red('standards')]];
    for (const exitCode of [1, 2, 3, 124, 127, 137, 143])
      for (const signal of [null, 'SIGTERM', 'SIGKILL'])
        for (const phaseResults of phaseShapes)
          for (const isolatedRetry of [null, 'still-red', 'flaky-outside-diff'])
            for (const changedFiles of [undefined, null, [], ['x.mjs']]) {
              const cause = classifyRedCause({ exitCode, signal, phaseResults, isolatedRetry, changedFiles });
              expect(cause, JSON.stringify({ exitCode, signal, phaseResults, isolatedRetry, changedFiles })).not.toBeNull();
              expect(RED_CAUSES).toContain(cause.redCause);
              expect(Array.isArray(cause.redCauseFiles)).toBe(true);
            }
  });
  it('green stays null (no cause invented for a passing gate)', () => {
    expect(classifyRedCause({ exitCode: 0, phaseResults: [] })).toBeNull();
    expect(classifyRedCause({ exitCode: 0, phaseResults: [ok('vitest')] })).toBeNull();
  });
});

describe('import-walk caps: an unknown is recorded, never passed off as proven (review: cap bias)', () => {
  const chain = { 'c0.test.mjs': "import './c1.mjs';", 'c1.mjs': "import './c2.mjs';", 'c2.mjs': "import './c3.mjs';", 'c3.mjs': "import './c4.mjs';", 'c4.mjs': "import './c5.mjs';", 'c5.mjs': "import './changed.mjs';", 'changed.mjs': '' };
  const rf = (p) => { if (!(p in chain)) throw new Error('ENOENT'); return chain[p]; };

  it('reachesChanged is tri-state: reaches / outside / unknown', () => {
    expect(reachesChanged({ testFile: 'c0.test.mjs', changedFiles: ['changed.mjs'], readFile: rf })).toBe('reaches');
    expect(reachesChanged({ testFile: 'c0.test.mjs', changedFiles: ['elsewhere.mjs'], readFile: rf })).toBe('outside');
    expect(reachesChanged({ testFile: 'c0.test.mjs', changedFiles: ['changed.mjs'], readFile: rf, maxDepth: 4 })).toBe('unknown');
    expect(reachesChanged({ testFile: 'c0.test.mjs', changedFiles: ['changed.mjs'], readFile: rf, maxFiles: 2 })).toBe('unknown');
    expect(reachesChanged({ testFile: 'c0.test.mjs', changedFiles: null, readFile: rf })).toBe('outside');
  });
  it('the boolean form still treats an unknown as reaching', () => {
    expect(testReachesChanged({ testFile: 'c0.test.mjs', changedFiles: ['elsewhere.mjs'], readFile: rf, maxDepth: 4 })).toBe(true);
  });
  const tests = [{ file: 'lib/__tests__/deep.test.mjs', name: 'x' }];
  it('an unknown reach stays in-diff-failure but is flagged `redCauseUncertain`', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', tests)], changedFiles: ['lib/foo.mjs'], touchesDiff: () => 'unknown' }))
      .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['lib/__tests__/deep.test.mjs'], redCauseUncertain: true });
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', tests)], isolatedRetry: 'still-red', retriedFailures: [{ file: tests[0].file }], changedFiles: ['lib/foo.mjs'], touchesDiff: () => 'unknown' }))
      .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['lib/__tests__/deep.test.mjs'], redCauseUncertain: true });
  });
  it('a proven reach or a proven outside carries no uncertainty flag', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', tests)], changedFiles: ['lib/foo.mjs'], touchesDiff: () => true }))
      .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['lib/__tests__/deep.test.mjs'] });
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', tests)], changedFiles: ['lib/foo.mjs'], touchesDiff: () => false }))
      .toEqual({ redCause: 'out-of-diff-still-red', redCauseFiles: ['lib/__tests__/deep.test.mjs'] });
    // one proven file settles it even when another is unknown
    const two = [{ file: 'a.test.mjs', name: null }, { file: 'b.test.mjs', name: null }];
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', two)], changedFiles: ['x.mjs'], touchesDiff: (f) => (f === 'a.test.mjs' ? true : 'unknown') }).redCauseUncertain).toBeUndefined();
  });

  it('a source file past the read cap is unseen imports: unknown, never "outside"', () => {
    const big = { 't.test.mjs': `import './lib.mjs';\n${'x'.repeat(2_100_000)}\nimport './changed.mjs';`, 'lib.mjs': '', 'changed.mjs': '' };
    const bigRf = (p) => { if (!(p in big)) throw new Error('ENOENT'); return big[p]; };
    expect(reachesChanged({ testFile: 't.test.mjs', changedFiles: ['changed.mjs'], readFile: bigRf })).toBe('unknown');
  });
  it('every in-diff verdict that is not PROVEN is flagged: truncated or empty failure list, unknown diff', () => {
    const one = [{ file: 'a.test.mjs', name: null }];
    const truncated = red('vitest', one); truncated.result.failureDetails.truncated = true;
    expect(classifyRedCause({ exitCode: 1, phaseResults: [truncated], changedFiles: ['x.mjs'], touchesDiff: () => false }))
      .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['a.test.mjs'], redCauseUncertain: true });
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [])], changedFiles: ['x.mjs'] }))
      .toEqual({ redCause: 'in-diff-failure', redCauseFiles: [], redCauseUncertain: true });
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', one)], changedFiles: null }).redCauseUncertain).toBe(true);
    // a failing file that is itself in the diff is proven, even when the list is truncated
    expect(classifyRedCause({ exitCode: 1, phaseResults: [truncated], changedFiles: ['a.test.mjs'] }).redCauseUncertain).toBeUndefined();
  });
  it('asks about each failing file once (the import walk is memoised)', () => {
    let calls = 0;
    classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'a.test.mjs', name: null }])], changedFiles: ['x.mjs'], touchesDiff: () => { calls++; return 'unknown'; } });
    expect(calls).toBe(1);
  });

  // Calibration: with a change that touches nothing any test imports, (almost) no test of THIS repo may read as
  // reaching it or unknown at the default caps. Before the caps were raised 196 of 460 did, which filled
  // `in-diff-failure` with failures that had nothing to do with the diff.
  it('calibration: at the default caps, nearly every repo test is provably outside a disjoint change', () => {
    const files = [];
    for (const dir of ['scripts/__tests__', 'scripts/lib/__tests__', 'skills-src/conveyor/__tests__'])
      for (const f of readdirSync(dir)) if (/\.test\.m?[jt]s$/.test(f)) files.push(`${dir}/${f}`);
    expect(files.length).toBeGreaterThan(100);
    const counts = { reaches: 0, outside: 0, unknown: 0 };
    for (const testFile of files) counts[reachesChanged({ testFile, changedFiles: ['zz-disjoint/unrelated.mjs'], readFile: (p) => readFileSync(p, 'utf8') })]++;
    expect(counts.reaches).toBe(0);
    expect(counts.unknown / files.length, JSON.stringify(counts)).toBeLessThan(0.1);
  });
});
