/** PR 6399: chaining the fixer's rearm command missed its per-session Bash allow rule and blocked on permission. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BRIEF = 'skills-src/conveyor/fix-agent-brief.md';

export default {
  id: 'fixer-brief-chains-rearm-review',
  title: 'the fixer brief chains rearm-review with completion and misses its per-session Bash allow rule',
  card: 'PR 6399 fixer rearm-review permission denial',
  fixedBy: { sha: '', where: 'lane/fixer-rearm-standalone' },
  fixPresent(root) {
    return readFileSync(join(root, BRIEF), 'utf8').includes('rearm-review.mjs` as its OWN Bash call');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const brief = readFileSync(join(root, BRIEF), 'utf8');
    const violations = brief.split(/\r?\n/).filter(line =>
      line.startsWith('node "{{WE_ROOT}}/scripts/conveyor/rearm-review.mjs"')
      && (/&&|;|\|/.test(line) || /\\\s*$/.test(line)))
      .map(line => `fixer rearm-review Bash call is chained: ${line}`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
