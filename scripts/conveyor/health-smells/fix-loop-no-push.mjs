import { fixLoopBreaches, fixLoopConfig } from '../fix-loop-ledger.mjs';
import { repoKeyForSlug } from '../../lib/constellation-repos.mjs';

export default {
  id: 'fix-loop-no-push', scope: 'repo', cadence: 'gh', probes: ['prs', 'fixLoopLedger'],
  openAfter: 1, closeAfter: 2, severity: 'high', action: 'alert',
  evaluate({ prs, fixLoopLedger }, { now, env = process.env }) {
    const config = fixLoopConfig(env);
    const current = (prs ?? []).map(pr => ({ ...pr, repo: repoKeyForSlug(pr.repo) ?? pr.repo }));
    return fixLoopBreaches({ rows: fixLoopLedger, prs: current, now, config }).map(group => ({
      subject: `pr:${group.repo}#${group.pr}`, breach: true,
      measure: { count: group.count, head: group.head, kinds: group.kinds, windowHours: config.windowHours, held: config.hold },
      summary: `${group.repo} PR #${group.pr}: ${group.count} fix/ci-heal sessions on head ${group.head.slice(0, 7)} in ${config.windowHours}h, nothing pushed — ${config.hold ? 'auto-held' : 'alert only'}`,
      recommendation: 'Send the saved repair through the load-flake hold / salvage path; investigate why sessions end without pushing.',
    }));
  },
};
