import { describe, it, test, expect, mock } from 'bun:test';
import { classifyRedCause, testReachesChanged, RED_CAUSES } from '../../../../scripts/lib/red-cause.mjs';

const red = (phase, tests = [], summary = '') => ({ phase, result: { exitCode: 1, signal: null, failureDetails: { tests, summary, truncated: false } } });
const ok = (phase) => ({ phase, result: { exitCode: 0, signal: null } });

describe('classifyRedCause (item 99)', () => {
  it('returns null for a plain green run', () => {
    expect(classifyRedCause({ exitCode: 0, phaseResults: [ok('vitest'), ok('standards')] })).toBeNull();
  });
  it('in-diff-failure: a failing file the change touched', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'a.test.mjs', name: 'x' }])], changedFiles: ['a.test.mjs'] }))
      .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['a.test.mjs'] });
  });
  it('out-of-diff-flaky: failing outside the diff, passed alone (gate went green)', () => {
    expect(classifyRedCause({ exitCode: 0, phaseResults: [ok('vitest')], isolatedRetry: 'flaky-outside-diff', retriedFailures: [{ file: 'b.test.mjs' }] }))
      .toEqual({ redCause: 'out-of-diff-flaky', redCauseFiles: ['b.test.mjs'] });
  });
  it('out-of-diff-still-red: still red alone, or outside the diff and not retried', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'b.test.mjs', name: 'x' }])], isolatedRetry: 'still-red', retriedFailures: [{ file: 'b.test.mjs' }], changedFiles: ['a.mjs'] }))
      .toEqual({ redCause: 'out-of-diff-still-red', redCauseFiles: ['b.test.mjs'] });
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'c.test.mjs', name: 'x' }])], changedFiles: ['a.mjs'] }).redCause).toBe('out-of-diff-still-red');
  });
  it('test-timeout', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'a.test.mjs', name: 'x' }], 'Error: Test timed out in 5000ms.')], changedFiles: ['a.test.mjs'] }).redCause).toBe('test-timeout');
  });
  it('standards and scan (a red always-run guard is a scan)', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [ok('vitest'), red('standards')] }).redCause).toBe('standards');
    expect(classifyRedCause({ exitCode: 1, phaseResults: [ok('vitest'), red('scan', [{ file: 'g.test.mjs', name: 'y' }])] }))
      .toEqual({ redCause: 'scan', redCauseFiles: ['g.test.mjs'] });
  });
  it('the first red phase names the cause, later reds only add files', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'a.test.mjs', name: 'x' }]), red('scan', [{ file: 'g.test.mjs', name: 'y' }])], changedFiles: ['a.test.mjs'] }))
      .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['a.test.mjs'] });
  });
  it('killed-superseded, infra, refused', () => {
    expect(classifyRedCause({ exitCode: 143, infrastructure: { reason: 'verify-signal' } }).redCause).toBe('killed-superseded');
    expect(classifyRedCause({ exitCode: 1, infrastructure: { reason: 'verify-timeout' } }).redCause).toBe('infra');
    expect(classifyRedCause({ refused: true }).redCause).toBe('refused');
  });
  // A source-only edit: the failing file is the (untouched) test that imports the changed source. That is the change's
  // own regression, not a failure "outside the diff" — before, it landed in out-of-diff-still-red.
  describe('a source-only change that breaks its own untouched test', () => {
    const files = {
      'lib/foo.mjs': 'export const x = 1;',
      'lib/mid.mjs': "export * from './foo';",
      'lib/__tests__/foo.test.mjs': "import { x } from '../foo.mjs';",
      'lib/__tests__/dyn.test.mjs': "it('x', async () => { await import('../foo.mjs'); });",
      'lib/__tests__/deep.test.mjs': "import '../mid.mjs';",
      'lib/__tests__/cjs.test.mjs': "const f = require('../foo.mjs');",
      'lib/__tests__/loop-a.test.mjs': "import './loop-b.test.mjs';",
      'lib/__tests__/loop-b.test.mjs': "import './loop-a.test.mjs';",
      'lib/__tests__/other.test.mjs': "import '../bar.mjs';",
      'lib/bar.mjs': 'export const y = 2;',
    };
    const readFile = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
    const changed = ['lib/foo.mjs'];

    it.each(['foo', 'dyn', 'deep', 'cjs'])('testReachesChanged follows %s to the changed source', (name) => {
      expect(testReachesChanged({ testFile: `lib/__tests__/${name}.test.mjs`, changedFiles: changed, readFile })).toBe(true);
    });
    it('testReachesChanged is false for an unrelated, missing or cyclic file, and an unknown diff', () => {
      for (const f of ['other', 'loop-a', 'ghost']) expect(testReachesChanged({ testFile: `lib/__tests__/${f}.test.mjs`, changedFiles: changed, readFile })).toBe(false);
      expect(testReachesChanged({ testFile: 'lib/__tests__/foo.test.mjs', changedFiles: null, readFile })).toBe(false);
    });
    it('follows vi.mock / importActual and a ./x.js import written for an x.ts on disk', () => {
      const f = { 'a/x.ts': '', 'a/t1.test.ts': "vi.mock('./x.js');", 'a/t2.test.ts': "const m = await vi.importActual('./x');" };
      const rf = (p) => { if (!(p in f)) throw new Error('ENOENT'); return f[p]; };
      for (const t of ['a/t1.test.ts', 'a/t2.test.ts']) expect(testReachesChanged({ testFile: t, changedFiles: ['a/x.ts'], readFile: rf })).toBe(true);
    });
    it('is linear on pathological whitespace (no ReDoS)', () => {
      const rf = () => `import${' '.repeat(400_000)}x`;
      const started = Date.now();
      expect(testReachesChanged({ testFile: 't.test.mjs', changedFiles: ['x.mjs'], readFile: rf })).toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
    });
    it('a walk cut short by the depth cap counts as reaching the diff (unknown is not "outside")', () => {
      const chain = { 'c0.test.mjs': "import './c1.mjs';", 'c1.mjs': "import './c2.mjs';", 'c2.mjs': "import './c3.mjs';", 'c3.mjs': "import './c4.mjs';", 'c4.mjs': "import './c5.mjs';", 'c5.mjs': "import './changed.mjs';", 'changed.mjs': '' };
      const rf = (p) => { if (!(p in chain)) throw new Error('ENOENT'); return chain[p]; };
      expect(testReachesChanged({ testFile: 'c0.test.mjs', changedFiles: ['changed.mjs'], readFile: rf })).toBe(true);
      expect(testReachesChanged({ testFile: 'c0.test.mjs', changedFiles: ['changed.mjs'], readFile: rf, maxDepth: 10 })).toBe(true);
      expect(testReachesChanged({ testFile: 'c0.test.mjs', changedFiles: ['elsewhere.mjs'], readFile: rf, maxDepth: 10 })).toBe(false);
    });
    it('a truncated failure list never proves the failures are outside the diff', () => {
      const r = red('vitest', [{ file: 'lib/__tests__/other.test.mjs', name: 'x' }]);
      r.result.failureDetails.truncated = true;
      expect(classifyRedCause({ exitCode: 1, phaseResults: [r], changedFiles: changed, touchesDiff: () => false }).redCause).toBe('in-diff-failure');
    });
    it('is in-diff-failure whether it failed once or stayed red alone', () => {
      const touchesDiff = (f) => testReachesChanged({ testFile: f, changedFiles: changed, readFile });
      const tests = [{ file: 'lib/__tests__/foo.test.mjs', name: 'x' }];
      expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', tests)], changedFiles: changed, touchesDiff }))
        .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['lib/__tests__/foo.test.mjs'] });
      expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', tests)], isolatedRetry: 'still-red', retriedFailures: [{ file: 'lib/__tests__/foo.test.mjs' }], changedFiles: changed, touchesDiff }))
        .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['lib/__tests__/foo.test.mjs'] });
    });
    it('stays out-of-diff-still-red when the failing test does not reach the diff', () => {
      const touchesDiff = (f) => testReachesChanged({ testFile: f, changedFiles: changed, readFile });
      const tests = [{ file: 'lib/__tests__/other.test.mjs', name: 'x' }];
      expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', tests)], isolatedRetry: 'still-red', retriedFailures: [{ file: 'lib/__tests__/other.test.mjs' }], changedFiles: changed, touchesDiff }).redCause).toBe('out-of-diff-still-red');
      expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', tests)], changedFiles: changed, touchesDiff }).redCause).toBe('out-of-diff-still-red');
    });
  });
  it('every emitted value is declared', () => {
    for (const c of ['in-diff-failure', 'out-of-diff-flaky', 'out-of-diff-still-red', 'test-timeout', 'standards', 'scan', 'killed-superseded', 'refused', 'infra']) expect(RED_CAUSES).toContain(c);
  });
});
