import { expect, it, vi } from 'vitest';
import { matchReadyCandidate } from '../../../lib/daemon-rebuild/adopt.mjs';
import { matchReadyCandidate as baseline } from '../fixtures/ready-candidate-ref-only-matcher.mjs';
import b from './ready-candidate-adopted-across-overlay-churn.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

async function assertChurnOutcomes(matchCandidate) {
  const report = await b.run({
    matchCandidate(args) {
      const stillWanted = vi.fn(args.stillWanted);
      const result = matchCandidate({ ...args, stillWanted });
      const overlay = args.ready.adopt.applied[0];
      expect(stillWanted).toHaveBeenCalledWith(overlay.ref, overlay.sha);
      return result;
    },
  });
  expect(report.results.map(({ scenario }) => scenario)).toEqual([
    'descendant-advanced', 'removed-overlay', 'non-descendant-tip',
  ]);
  const [advanced, removed, divergent] = report.results.map(({ result }) => result);
  expect(advanced).toMatchObject({ adopt: { finalSha: 'candidate-build' }, match: 'superseded' });
  expect(removed).toMatchObject({ adopt: null, reason: 'overlay-no-longer-wanted' });
  expect(divergent).toMatchObject({ adopt: null, reason: 'overlay-no-longer-wanted' });
}

it('requires real matcher adoption across overlay churn independently of fix detection', async () => {
  await assertChurnOutcomes(matchReadyCandidate);
});

it('reproduces the descendant adoption failure with the pinned origin/main matcher', async () => {
  const report = await b.run({ matchCandidate: baseline });
  expect(report.violations.map((v) => v.invariant)).toEqual(['descendant-advanced']);
  expect(b.judge(report)).toHaveLength(1);
  await expect(assertChurnOutcomes(baseline)).rejects.toThrow();
});
