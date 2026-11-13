/**
 * PR #6595 (2026-11-11): the drain's review:human park re-added review:awaiting-advisory after the head landed. The
 * operator's human accept (clear-human) swapped review:human for review:accepted but left review:awaiting-advisory,
 * so policy-clear refused the PR forever ("conflicting label prevents policy-clear"). The human clearance is the
 * final verdict: it must drop the pending advisory in the same swap that adds review:accepted.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'human-accept-leaves-awaiting-advisory',
  title: 'PR #6595: a human clear-human accept leaves review:awaiting-advisory behind, so policy-clear refuses the PR forever',
  card: 'PR #6595 human accept must clear review:awaiting-advisory (review-set-label)',
  fixedBy: { sha: 'db7a1636e5211177a79a1936efc4e1416ef3b07c', where: 'lane/human-accept-clears-awaiting-2', paths: ['scripts/review-set-label.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/review-set-label.mjs'), 'utf8').includes('supersedes a pending advisory'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { decideSetLabel } = await import(pathToFileURL(join(root, 'scripts/review-set-label.mjs')).href);
    const violations = [];
    const d = decideSetLabel({
      to: 'clear-human',
      currentLabels: [{ name: 'review:human' }, { name: 'review:awaiting-advisory' }, { name: 'ready-to-merge' }],
    });
    if (!d.allowed) violations.push(`clear-human was refused: ${d.reason}`);
    else if (!d.removeLabels.includes('review:awaiting-advisory')) {
      violations.push('clear-human added review:accepted but left review:awaiting-advisory standing');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
