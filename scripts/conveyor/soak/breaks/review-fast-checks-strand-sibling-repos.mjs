/** PR #5465: WE's fast-check names applied to every repo, so green sibling PRs never reached review. */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'review-fast-checks-strand-sibling-repos',
  title: 'fast-check review timing never strands a repository that does not publish those checks',
  card: 'PR #5465 red-team finding 1, 2026-10-17',
  fixedBy: { sha: 'HEAD', where: 'lane/review-timing', paths: ['scripts/lib/review-timing.mjs', 'scripts/lib/review-ci-gate-io.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/review-timing.mjs'), 'utf8').includes('export function fastChecksFor');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { REVIEW_TIMING_DEFAULTS } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-timing.mjs')).href);
    const { readReviewCiGate } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-ci-gate-io.mjs')).href);
    const now = Date.parse('2026-10-17T14:00:00Z');
    const head = 'b'.repeat(40);
    const check = name => ({ name, conclusion: 'SUCCESS', head_sha: head, status: 'COMPLETED', completedAt: new Date(now - 60000).toISOString() });
    const violations = [];
    // The checks each sibling workflow really publishes (we:scripts/lib/required-status-checks.mjs DECLARED set).
    const { CONSTELLATION_REPOS } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/constellation-repos.mjs')).href);
    for (const [repo, published] of [['frontierui', ['test']], ['plateau-app', ['test', 'e2e']]]) {
      const slug = CONSTELLATION_REPOS[repo].slug;
      const pr = { number: 9, state: 'OPEN', headRefOid: head, headRefName: 'lane/xabc-test',
        labels: [{ name: 'review:pending' }], comments: [], files: [{ path: 'src/example.ts' }],
        statusCheckRollup: published.map(check) };
      const plan = planReconcile({ repo, prs: [pr], requiredChecks: published, now, reviewTiming: REVIEW_TIMING_DEFAULTS });
      const kinds = plan.dispatch.map(d => d.kind);
      log?.(`planReconcile ${repo}: ${kinds.join(',') || 'none'}`);
      if (!kinds.includes('review')) violations.push(`${repo}: green required CI but planReconcile dispatched ${kinds.join(',') || 'nothing'}`);
      const gate = readReviewCiGate({ repo: slug, pr: 9, readHead: () => head,
        readChecks: () => published.map(name => ({ name, status: 'completed', conclusion: 'success', head_sha: head })),
        readRequired: () => ({ source: 'declared', checks: published }), policy: REVIEW_TIMING_DEFAULTS });
      log?.(`readReviewCiGate ${slug}: ${gate.allowed ? 'allowed' : gate.reason}`);
      if (!gate.allowed) violations.push(`${slug}: green required CI but readReviewCiGate refused (${gate.reason})`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
