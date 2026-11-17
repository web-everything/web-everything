/** PR #6891: a quiet PR must be planned when its joined-fix deadline expires. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDecider } from '../../decider-daemon.mjs';
import { REVIEW_PR_CHANNEL } from '../../../lib/review-escalation.mjs';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';

export default {
  id: 'shadow-decider-long-recheck',
  title: 'shadow rehydrates a quiet PR after a deadline beyond the projection freshness bound',
  card: '5454',
  fixedBy: { sha: 'PR-6891-fresh-hydration', where: 'working-tree', paths: ['scripts/conveyor/decider-daemon.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/decider-daemon.mjs'), 'utf8').includes('observedAt: now()');
  },
  async run() {
    const start = Date.parse('2026-11-15T12:00:00Z');
    let clock = start;
    const records = [];
    const head = 'a'.repeat(40);
    const repo = ghRepoSlug('we');
    const decider = createDecider({ now: () => clock, repoSlug: repo, caps: { fix: 2, heavy: 3, ciHealReserve: 1 },
      process: { id: 'soak-shadow', pid: 1 }, io: {
        hydrate: () => ({ pr: { number: 7, state: 'OPEN', isDraft: false, headRefOid: head,
          headRefName: 'lane/shadow-soak', labels: [{ name: 'review:changes' }],
          comments: [{ author: { login: 'web-everything' }, createdAt: new Date(start).toISOString(),
            body: `🔁 review — changes requested\n\nRecorded by juror via ${REVIEW_PR_CHANNEL}.\n\nRepair the unit failure.\n\n---\n\nNet basis: \`0000..${head}\` — 1 net changed file(s) vs current main\n\n_Recorded through ${REVIEW_PR_CHANNEL}._` }],
          statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null,
            head_sha: head, completedAt: new Date(start).toISOString() }] },
        agents: [],
        plannerOptions: { requiredChecks: ['test'], fixTiming: { joinCiAndReview: true, joinWaitMaxMin: 15 } } }),
        readLive: () => ({ fix: 0, ciHeal: 0, heavy: 0 }),
        hostGate: () => ({ allow: true }),
        appendShadow: row => { if (row.kind === 'decision') records.push(row); },
      } });
    decider.ingest([{ seq: 1, type: 'pull_request', action: 'opened', repo, prs: [7], sha: head, at: start }]);
    await decider.tick();
    clock = records[0]?.recheckAt ?? start;
    await decider.tick();
    return { start, records };
  },
  judge({ start, records }) {
    const problems = [];
    if (records[0]?.action || !(records[0]?.recheckAt > start + 300_000)) problems.push('missing long refusal deadline');
    if (records.length !== 2 || records[1]?.action?.kind !== 'fix') problems.push('quiet PR never planned at deadline');
    if (records[1]?.lagMs !== records[0]?.recheckAt - start) problems.push('event lag lost during hydration');
    return problems;
  },
};
