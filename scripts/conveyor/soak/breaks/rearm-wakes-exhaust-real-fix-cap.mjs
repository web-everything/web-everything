/** PR #6877 red-team replay: wake-only comments exhausted the real-fix round cap on an unchanged head. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
// Restore these existing readers for red/green replay; the new helper is unused by the pre-fix readers.
const paths = ['scripts/conveyor/rearm-review.mjs', 'scripts/conveyor/mechanical-round-cap.mjs', 'scripts/conveyor/reconcile-core.mjs'];

export default {
  id: 'rearm-wakes-exhaust-real-fix-cap',
  title: 'five trusted same-head wakes must not exhaust the real-fix negotiation cap',
  card: 'PR #6877 red-team send-back 2026-11-15',
  fixedBy: { sha: 'HEAD', where: 'lane/rearm-same-head-pause-v2', paths },
  fixPresent(root) {
    try { return paths.every(path => /isFixRoundRearmComment/.test(readFileSync(join(root, path), 'utf8'))); }
    catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { buildSameHeadWakeComment, countRearmComments } = await load(paths[0]);
    const { enrichPrsWithMechanicalRound } = await load(paths[1]);
    const { countRealFixRounds, planReconcile } = await load(paths[2]);
    const head = 'a'.repeat(40);
    const at = hour => `2026-11-15T0${hour}:00:00Z`;
    const comments = [1, 2, 3, 4, 5].map(hour => ({
      body: buildSameHeadWakeComment({ actor: 'chalbert', key: `wake-${hour}` }),
      author: { login: 'web-everything' }, createdAt: at(hour),
    }));
    const facts = { head, commits: [{ sha: head, parents: ['b'.repeat(40)], authoredAt: at(0), subject: 'original PR work' }] };
    const pr = { number: 6877, headRefOid: head, headRefName: 'lane/wake', baseRefName: 'main', isDraft: false,
      createdAt: at(0), labels: [{ name: 'review:pending' }], comments,
      files: [{ path: 'src/a.mjs' }], statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: head }] };
    let reads = 0;
    const enriched = enrichPrsWithMechanicalRound([pr], { roundCap: 5, readRoundCommits: () => { reads += 1; return facts; } })[0];
    // Preloaded evidence must be safe too, independently of whether the threshold fetched it this tick.
    const withFacts = { ...enriched, roundCommits: facts };
    const ordinary = countRearmComments(comments);
    const real = countRealFixRounds(withFacts);
    const plan = planReconcile({ prs: [withFacts], agents: [], durableCounts: {}, roundCap: 5,
      reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false }, requiredChecks: ['test'], now: Date.parse(at(9)) });
    const capped = plan.refusals.some(r => r.kind === 'cap-exhausted');
    const reviewed = plan.dispatch.some(d => d.kind === 'review' && d.attempts === 0);
    log?.(`ordinary=${ordinary}, commitReads=${reads}, real=${real.real}, total=${real.total}, capped=${capped}, reviewDispatched=${reviewed}\n`);
    log?.(`review attempts=${plan.dispatch.find(d => d.kind === 'review')?.attempts}\n`);
    const violations = [];
    if (ordinary !== 0) violations.push(`ordinary counter spent ${ordinary} rounds`);
    if (reads !== 0) violations.push(`wake comments triggered ${reads} commit reads`);
    if (!real.ok || real.real !== 0 || real.total !== 0) violations.push(`wake windows counted as ${JSON.stringify(real)}`);
    if (capped || !reviewed) violations.push('wake-only thread exhausted the cap or failed to dispatch the owed review');
    return { violations };
  },
  judge: report => report.violations,
};
