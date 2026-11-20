import { expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchReadyCandidate } from '../../../lib/daemon-rebuild/adopt.mjs';
import { matchReadyCandidate as baseline } from '../fixtures/ready-candidate-ref-only-matcher.mjs';
import b from './ready-candidate-adopted-across-overlay-churn.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('detects the fixed matcher after wanted-tip checks move into a helper', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

it.each([
  ['ref-only matcher with the old marker', `// stillWanted(a.ref, a.sha)
export { matchReadyCandidate } from ${JSON.stringify(new URL('../fixtures/ready-candidate-ref-only-matcher.mjs', import.meta.url).href)};`],
  ['matcher that also adopts removed and divergent overlays', `export function matchReadyCandidate({ ready }) {
    return { adopt: ready.adopt, match: 'superseded' };
  }`],
  ['malformed matcher', 'export function matchReadyCandidate('],
  ['module without the matcher export', 'export const unrelated = true;'],
  ['missing matcher', null],
])('fix detection refuses a %s', (_label, source) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-ready-churn-probe-'));
  try {
    if (source !== null) {
      const path = join(root, 'scripts/lib/daemon-rebuild/adopt.mjs');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    expect(b.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
