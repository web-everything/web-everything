import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const FEED = 'scripts/lib/red-team-feed.mjs';
const FIX_SHA = '7c9e367a63b0e60e902db67bb6c2d3612d4ec519';

export default {
  id: 'redteam-feed-pending-never-queued',
  title: 'a red-team:pending PR with a finished review reaches the red-team dispatch queue',
  card: 'REDTEAM-FEED: ~1 red-team process live against 16 allowed',
  fixedBy: { sha: FIX_SHA, where: 'lane/redteam-feed', paths: [FEED, 'skills-src/conveyor/review-daemon.mjs'] },
  fixPresent(root) {
    // Git ancestry of the fix commit; a tree without history falls back to the module's presence.
    const r = spawnSync('git', ['merge-base', '--is-ancestor', FIX_SHA, 'HEAD'], { cwd: root, stdio: 'ignore' });
    return r.status === 0 || existsSync(join(root, FEED));
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { createRedTeamFeed } = await import(pathToFileURL(join(sourceRoot, FEED)).href);
      const { buildReviewedShaMarker } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-escalation.mjs')).href);
      const head = 'b'.repeat(40);
      const pr = { number: 9, headRefOid: head, state: 'OPEN', isDraft: false, labels: ['red-team:pending'],
        comments: [{ author: { login: 'web-everything' }, body: buildReviewedShaMarker(head), createdAt: '2026-11-24T10:00:00Z' }] };
      const plan = createRedTeamFeed({})({ repo: CONSTELLATION_REPOS.we.slug, plan: { refusals: [] }, rawPrs: [pr] });
      if (!plan.refusals.some(r => r.kind === 'already-reviewed-head' && r.prNumber === 9 && r.headSha === head)) {
        violations.push('finished-review red-team:pending PR was never nominated to the queue');
      }
    } catch (error) { violations.push(`scenario failed: ${error.message}`); }
    return { violations };
  },
  judge: report => report.violations,
};
