/** An accepted stacked child cannot land until its base does, so treating it as a landing holder
 * can deadlock the base's fixer. Replay both the pure decision and the live snapshot reader with
 * hermetic PR observations; an unrelated accepted PR targeting main must still retain its hold.
 * RED proof: remove the non-main base guard from matchedHolderStates.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { landingHolderDecision, createHolderStateReader, resolveFixScopePolicy } from '../../fix-scope-policy.mjs';

const SOURCE = 'scripts/conveyor/fix-scope-policy.mjs';

export default {
  id: 'stacked-pr-landing-holder-deadlock',
  title: 'accepted stacked children cannot hold fixers waiting for landing; unrelated main PRs still can',
  card: 'stacked-pr-landing-holder-deadlock',
  fixedBy: { sha: 'HEAD', where: 'main', paths: [SOURCE] },
  // Synchronous source probe; run() is the behavioural proof for both consumers of the shared guard.
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    const start = source.indexOf('const matchedHolderStates =');
    const end = source.indexOf('\n\n', start);
    return start >= 0 && end > start && /state\.baseRefName !== 'main'/.test(source.slice(start, end));
  },
  async run() {
    const setting = resolveFixScopePolicy({ env: {}, platform: {}, readTool: () => ({}) }).value.waitForLandingHolder;
    const violations = [];
    const states = [
      [1, { baseRefName: 'lane/x', labels: ['review:accepted'], inMergeQueue: false, headRefOid: 'child' }],
      [2, { baseRefName: 'main', labels: ['review:accepted'], inMergeQueue: false, headRefOid: 'unrelated' }],
    ];
    const reader = createHolderStateReader({ repo: 'soak/fixture', exec: () => JSON.stringify({
      data: { repository: { pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: states.map(([number, state]) => ({ number, baseRefName: state.baseRefName,
          headRefOid: state.headRefOid, isInMergeQueue: state.inMergeQueue,
          labels: { nodes: state.labels.map(name => ({ name })) } })),
      } } },
    }) });
    for (const [name, stateFor] of [['direct', pr => new Map(states).get(pr)], ['snapshot', pr => reader.stateFor(pr)]]) {
      const child = landingHolderDecision({ state: stateFor(1), setting });
      if (child.hold !== false || child.landing === true) violations.push(`${name}: accepted stacked child retained a landing hold`);
      const unrelated = landingHolderDecision({ state: stateFor(2), setting });
      if (unrelated.hold !== true || unrelated.landing !== true) violations.push(`${name}: unrelated accepted main PR lost its landing hold`);
    }
    const landing = reader.landingPrs(setting.holderStates);
    if (landing.length !== 1 || landing[0] !== 2) violations.push(`landingPrs: expected only unrelated main PR #2, got ${landing.join(',')}`);
    const unreadable = landingHolderDecision({ state: null, setting });
    if (unreadable.hold !== true || unreadable.failedClosed !== true) violations.push('unreadable holder state released the hold');
    return { violations };
  },
  judge: report => report.violations,
};
