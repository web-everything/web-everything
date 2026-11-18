/**
 * @file pr-state.test.mjs — proof of the PURE `formatPrStateLine` + `prStateRecord` (#2434). The `gh pr view`
 *   call is the CLI's concern; the view → one-line/record distillation (with the `checks=` token single-sourced
 *   through classifyChecks over the normalized rollup) is pure and unit-tested here against fixtures, no gh.
 */
import { describe, it, expect } from 'vitest';
import { formatPrStateLine, prStateRecord } from '../pr-state.mjs';

const greenView = {
  number: 472,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ],
  title: 'scripts: drain helpers',
};

const failView = {
  number: 480,
  state: 'OPEN',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
  ],
  title: 'a broken PR',
};

// A PR whose REQUIRED check (test) is green but a NON-required (optional) check is red — pr-land would merge it.
const optionalRedView = {
  number: 481,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
  ],
  title: 'required green, optional red',
};

describe('prStateRecord', () => {
  it('distills the view, with the checks token from classifyChecks over the rollup', () => {
    expect(prStateRecord(greenView)).toEqual({
      number: 472,
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      checks: 'passed',
      checksScope: 'all', // no requiredNames → historical all-checks scope
      title: 'scripts: drain helpers',
    });
  });

  it('reports a failed check via the shared classifier', () => {
    expect(prStateRecord(failView).checks).toBe('failed');
  });

  // #2925 — the decisive case, one layer inside pr-state's `checks=` token: a superseded CANCELLED entry beside
  // the SUCCESS that actually finished, same check name (routes through `rollupToCheckRows`'s
  // `collapseRollupToLatestPerName` seam). Before the fix this read `failed` even though the check that
  // finished is green.
  it('a superseded CANCELLED entry beside a later SUCCESS reads GREEN, not failed (#2925)', () => {
    const supersededThenGreen = {
      ...greenView,
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    };
    expect(prStateRecord(supersededThenGreen).checks).toBe('passed');
  });

  it('is tolerant of an empty view (never throws)', () => {
    const r = prStateRecord({});
    expect(r.number).toBe(0);
    expect(r.checks).toBe('passed'); // no rollup → classifyChecks no-checks default
    expect(r.checksScope).toBe('all');
    expect(() => prStateRecord()).not.toThrow();
  });

  it('with requiredNames, the token reflects the REQUIRED set only (#2482) — optional red is ignored', () => {
    const r = prStateRecord(optionalRedView, ['test']);
    expect(r.checks).toBe('passed');       // required (test) is green — pr-land would merge it
    expect(r.checksScope).toBe('required');
  });

  it('without requiredNames, the same PR over-reports the optional red (all-checks fallback)', () => {
    expect(prStateRecord(optionalRedView).checks).toBe('failed');
  });

  it('requiredNames=[] (a no-required-checks PR) reads as passed', () => {
    const r = prStateRecord(failView, []);
    expect(r.checks).toBe('passed');
    expect(r.checksScope).toBe('required');
  });
});

describe('formatPrStateLine', () => {
  it('renders the one-line state view', () => {
    expect(formatPrStateLine(greenView))
      .toBe('#472 OPEN mergeable=MERGEABLE checks=passed mss=CLEAN  scripts: drain helpers');
  });

  it('renders a red/conflicting PR', () => {
    expect(formatPrStateLine(failView))
      .toBe('#480 OPEN mergeable=CONFLICTING checks=failed mss=DIRTY  a broken PR');
  });

  it('narrows the checks token to the required set when requiredNames is supplied (#2482)', () => {
    expect(formatPrStateLine(optionalRedView, ['test']))
      .toBe('#481 OPEN mergeable=MERGEABLE checks=passed mss=CLEAN  required green, optional red');
  });
});
