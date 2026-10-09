/** PR #4481: a rearmed finding left a review:human conflict idle for over six hours. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixPresent = (root) => existsSync(join(root, 'scripts/conveyor/conflict-reassert-rule.mjs'));

export default {
  id: 'review-human-conflict-idle',
  title: '#4481: review:human PR stayed merge-status:conflicting 6+ h, never re-routed to a conflict fix after its finding was rearmed',
  card: '5555',
  fixedBy: {
    sha: '0d990face', where: 'lane/conflict-reassert-human',
    paths: ['scripts/conveyor/conflict-reassert-rule.mjs', 'scripts/conveyor/parked-pr-conflict-watch.mjs'],
  },
  fixPresent,
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const { watchParkedPrConflicts } = await import(pathToFileURL(join(root, 'scripts/conveyor/parked-pr-conflict-watch.mjs')).href);
    const fixture = JSON.parse(readFileSync(join(root, 'scripts/conveyor/__tests__/fixtures/conflict-reassert/pr4481-2026-10-09.json'), 'utf8'));
    const labelCalls = [];
    const unexpected = () => { throw new Error('Unexpected side effect in dry-run conflict replay'); };
    const results = watchParkedPrConflicts({
      listPrs: () => [fixture.pr], listPrComments: () => fixture.comments,
      now: Date.parse(fixture.capturedAt), dryRun: true,
      ...(fixPresent(root) ? { conflictReassertSettings: { reviewHuman: true } } : {}),
      provider: {
        currentRepo: () => 'example/repo',
        setLabels: (...args) => { labelCalls.push(args); unexpected(); },
        postComment: unexpected, ensureLabel: unexpected,
      },
      postFinding: unexpected, postStandDown: unexpected, postRearm: unexpected, postSupersedeComment: unexpected,
      listAgents: () => [], listPrFiles: () => ['AGENTS.md'],
      listPrPatches: () => null, listMainStatutePatches: () => null,
      computeConflictingPaths: () => ['AGENTS.md'], computeConflictDisposition: () => 'conflicting',
      labelAgeMs: unexpected, labelRemovedAtMs: unexpected, attemptMechanicalRebase: unexpected,
    });
    return { results, labelCalls };
  },
  judge({ results, labelCalls }) {
    const violations = [];
    if (!results.some((entry) => entry.num === 4481 && /reconcile-finding/.test(entry.routedTo))) {
      violations.push('#4481 still skipped: no conflict finding re-asserted');
    }
    if (labelCalls.length) violations.push('#4481 replay unexpectedly changed labels');
    return violations;
  },
};
