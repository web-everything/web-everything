/** A waiter behind an accepted/queued landing holder was blocked forever when the holder could not
 * land (158 blocked waits on 11-23). The wait is now bounded by waitForLandingHolder.maxWaitMinutes
 * counted from the waiter's waitingSince; an unknown waitingSince keeps the hold.
 * RED proof: drop the maxWaitMinutes branch from landingHolderDecision.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { landingHolderDecision, resolveFixScopePolicy } from '../../fix-scope-policy.mjs';

const SOURCE = 'scripts/conveyor/fix-scope-policy.mjs';

export default {
  id: 'landing-holder-wait-unbounded',
  title: 'a landing-holder wait ends after maxWaitMinutes; just under the bound and unknown waitingSince still hold',
  card: 'landing-holder-timeout',
  fixedBy: { sha: 'HEAD', where: 'main', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    const start = source.indexOf('export function landingHolderDecision');
    return start >= 0 && /maxWaitMinutes/.test(source.slice(start, start + 2500));
  },
  async run() {
    const setting = resolveFixScopePolicy({ env: {}, platform: {}, readTool: () => ({}) }).value.waitForLandingHolder;
    const now = Date.parse('2026-11-24T12:00:00Z');
    const ago = m => new Date(now - m * 60000).toISOString();
    const state = { labels: ['review:accepted'] };
    const violations = [];
    const decide = waitingSince => landingHolderDecision({ state, setting, waitingSince, now });
    if (decide(ago(61)).hold !== false) violations.push('waiter past maxWaitMinutes stayed blocked');
    if (decide(ago(59)).hold !== true) violations.push('waiter just under maxWaitMinutes was released');
    if (decide('not-a-date').hold !== true) violations.push('unparseable waitingSince released the hold');
    if (landingHolderDecision({ state: null, setting, waitingSince: ago(500), now }).hold !== true) violations.push('unreadable holder state released the hold');
    return { violations };
  },
  judge: report => report.violations,
};
