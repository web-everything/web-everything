/**
 * PR #5771 (2026-10-21): an accepted PR whose head moved was planned a `restore-review-label` (stale-accept) row by the
 * review daemon every tick, which held its red-team request, but only the fix daemon executes that row and its plan
 * never produces it. Review of the new head never went out. The planning daemon must execute the row and dispatch the
 * review in the same pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = 'example-org/example-repo';
const HEAD = 'b'.repeat(40);

export default {
  id: 'accepted-pr-stale-accept-row-never-executed',
  title: 'PR #5771: the review daemon plans a stale-accept re-arm row for a moved-head accepted PR but never executes it, so the new head is never reviewed',
  card: 'PR #5771 stale-accept re-arm never executed (review plan holds red-team request)',
  fixedBy: { sha: '6eddeeb525b7a24959c860605da2140603621f4b', where: 'lane/review-rearm-stale-accept-main', paths: ['scripts/conveyor/review-tick-promote.mjs', 'skills-src/conveyor/review-daemon.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/review-tick-promote.mjs'), 'utf8').includes('rearmStaleAcceptsThenReplan'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { buildCliDaemonEffects, runReviewTick } = await import(pathToFileURL(join(root, 'skills-src/conveyor/review-daemon.mjs')).href);
    const { promoteDraftsGuarded, rearmStaleAcceptanceGuarded, rearmStaleAcceptsThenReplan } = await import(pathToFileURL(join(root, 'scripts/conveyor/review-tick-promote.mjs')).href);
    const violations = [];
    // Observe the real factory's executor bindings as well as exercising the transaction below. Injecting
    // executors straight into runReviewTick alone missed a dropped production binding in review #5793.
    let ticks = 0;
    const priorFacts = process.env.WE_REVIEW_FACTS;
    process.env.WE_REVIEW_FACTS = '0';
    try {
      await buildCliDaemonEffects({
        owner: 'soak-wiring', log: { error() {} }, reapSessions: () => null,
        convertAdvisoryEnabled: false, runPrepReview: () => null,
        tick: (opts) => {
          ticks += 1;
          if (typeof opts.promoteDrafts !== 'function' || opts.promoteDrafts !== promoteDraftsGuarded) violations.push('production draft promoter is not wired');
          if (typeof opts.rearmStaleAccepts !== 'function' || opts.rearmStaleAccepts !== rearmStaleAcceptanceGuarded) violations.push('production stale-accept executor is not wired');
          if (typeof opts.noteRearms !== 'function') violations.push('production stale-accept reporting is not wired');
          return { reviewsOwed: 0, refusals: 0, dispatched: [], failed: [] };
        },
      }).tickOnce();
    } finally {
      if (priorFacts === undefined) delete process.env.WE_REVIEW_FACTS;
      else process.env.WE_REVIEW_FACTS = priorFacts;
    }
    if (!ticks) violations.push('production effects did not reach the per-repo tick');
    const pr = { number: 5771, state: 'OPEN', isDraft: false, headRefName: 'lane/x-5771', headRefOid: HEAD, isCrossRepository: false,
      labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }] };
    let live = [pr];
    const plan = (prs) => ({ refusals: [], dispatch: prs.map((p) => (p.labels.some((l) => l.name === 'review:accepted')
      ? { kind: 'restore-review-label', variant: 'stale-accept', prNumber: p.number, headRefOid: p.headRefOid, label: 'review:pending' }
      : { kind: 'review', prNumber: p.number, attempts: 0 })) });
    const reconcile = ({ readPrs } = {}) => plan(readPrs ? readPrs() : live);
    const dispatched = [];
    const args = { repo: REPO, readPrs: () => live, readAgents: () => [], reconcile,
      dispatch: ({ pr: n }) => { dispatched.push(n); return { mode: 'job', agentId: null, jobPid: 1000 + n }; },
      tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], holdReconcile: () => [] };
    // The daemon wires its executor exactly as the real tick does; an old tree has no such parameter and ignores it.
    runReviewTick({ ...args, rearmStaleAccepts: () => { live = [{ ...pr, labels: [{ name: 'review:pending' }] }]; return { ok: true }; }, noteRearms: () => {} });
    if (!dispatched.includes(5771)) violations.push('the stale-accept row was planned but the pass dispatched no review of the moved head');
    let invalidWrites = 0;
    rearmStaleAcceptsThenReplan({
      plan: plan([{ ...pr, headRefOid: undefined }]), repo: REPO,
      rearm: () => { invalidWrites += 1; return { ok: true }; },
    });
    if (invalidWrites) violations.push('a stale-accept row without a head reached the re-arm writer');
    return { violations };
  },
  judge(report) { return report.violations; },
};
