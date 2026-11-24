import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SELF = fileURLToPath(import.meta.url);
const FEED = 'scripts/lib/red-team-feed.mjs';
const FIX_SHA = '7c9e367a63b0e60e902db67bb6c2d3612d4ec519';

async function scenario(sourceRoot = ROOT) {
  const violations = [];
  try {
    const load = async rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { createRedTeamFeed } = await load(FEED);
    const { buildReviewedShaMarker } = await load('scripts/lib/review-escalation.mjs');
    const { createRedTeamDispatchQueue, runWithRedTeamQueue } = await load('scripts/lib/red-team-dispatch-queue.mjs');
    const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const repo = CONSTELLATION_REPOS.we.slug, head = 'b'.repeat(40);
    const pr = { number: 9, headRefOid: head, state: 'OPEN', isDraft: false, labels: ['red-team:pending'],
      comments: [{ author: { login: 'web-everything' }, body: buildReviewedShaMarker(head), createdAt: '2026-11-24T10:00:00Z' }] };
    const queue = createRedTeamDispatchQueue({ file: join(mkdtempSync(join(tmpdir(), 'rt-feed-')), 'queue.json'),
      readLivePr: () => ({ state: 'OPEN', headRefOid: head, comments: pr.comments, labels: pr.labels }) });
    const reconciled = planReconcile({ repo: 'we', prs: [pr], agents: [], now: Date.parse('2026-11-24T12:00:00Z') });
    if (!reconciled.refusals.some(r => r.prNumber === 9 && r.kind === 'nothing-owed' && r.phase === 'open')) {
      violations.push('fixture did not reach the real nothing-owed/open reconciliation path');
    }
    // Match review-daemon's recovery adaptation: queued heads are adapted, open heads stay nothing-owed.
    const refusals = reconciled.refusals.map(row => row.kind === 'nothing-owed' && row.phase === 'queued'
      ? { ...row, kind: 'already-reviewed-head', headSha: row.headRefOid } : row);
    const plan = createRedTeamFeed({})({ repo, plan: { ...reconciled, refusals }, rawPrs: [pr] });
    let admitted = [], queued = false;
    runWithRedTeamQueue({ queue, repo, plan, rawPrs: [pr], capacity: { lanes: 4, remainingStarts: 4 }, floor: {},
      readNetFiles: () => ({ ok: true, files: [FEED] }),
      run: o => {
        queued = queue.entries().some(e => e.pr === 9 && e.head === head);
        admitted = o.plan.refusals.filter(r => r.kind === 'already-reviewed-head').map(r => r.prNumber);
        return {};
      } });
    if (!queued) violations.push('finished-review red-team:pending PR never entered the red-team queue');
    if (!admitted.includes(9)) violations.push('queued PR was not admitted to the red-team runner');
  } catch (error) { violations.push(`scenario failed: ${error.message}`); }
  return violations;
}

export default {
  id: 'redteam-feed-pending-never-queued',
  title: 'a red-team:pending PR with a finished review reaches the red-team dispatch queue',
  card: 'REDTEAM-FEED: ~1 red-team process live against 16 allowed',
  fixedBy: { sha: FIX_SHA, where: 'lane/redteam-feed', paths: [FEED, 'skills-src/conveyor/review-daemon.mjs'] },
  // Decided by behaviour in a child process: the real feed + real queue must queue the PR. A missing module is false.
  fixPresent(root) {
    const code = `import(${JSON.stringify(pathToFileURL(SELF).href)}).then(m => m.scenario(${JSON.stringify(root)}))`
      + '.then(v => process.exit(v.length ? 1 : 0), () => process.exit(1))';
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', timeout: 60_000 }).status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) { return { violations: await scenario(sourceRoot) }; },
  judge: report => report.violations,
};
export { scenario };
