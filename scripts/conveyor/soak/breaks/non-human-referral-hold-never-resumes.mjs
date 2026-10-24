/**
 * @file breaks/non-human-referral-hold-never-resumes.mjs — PR #5865 (lane/port-referral-hold-resume), live shape #5806.
 *
 * BREAK: a same-head referral pause whose live-head findings are ALL ruled resumed only for `review:human` PRs.
 * A PR that is not `review:human` (e.g. `review:pending`, #5806) stayed paused `review-referrals-pending` forever:
 * nothing was left to rule and no push or re-arm was coming. FIX: `reconcile-core.mjs#planReconcile`'s pre-pass
 * clears the hold for non-human PRs too and dispatches the ordinary `review` once.
 *
 * SCENARIO: the production enrich chain and planner on the captured #5775/#5800 threads, relabelled `review:pending`
 * after enrichment (the same relabel the unit test uses). No IO.
 * RED  = pre-fix: the plan refuses `review-referrals-pending`, no review dispatched.
 * GREEN = no such refusal and exactly one `review` dispatch; the kill switch still pauses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
// The live per-role bot logins come from host delivery settings a hermetic run does not read; the legacy bot login
// stands in for them (both are the automation's own trusted identity) — the same mapping the unit test uses.
const BOTS = new Set(['plateau-merger', 'plateau-reviewer', 'plateau-worker']);
const PAUSED = 'review-referrals-pending';

export default {
  id: 'non-human-referral-hold-never-resumes',
  title: 'a same-head referral pause whose live-head findings are all ruled never resumes on a PR that is not review:human',
  card: 'PR #5865 (lane/port-referral-hold-resume), live shape #5806',
  fixedBy: {
    sha: 'ecdbcac78b', where: 'lane/port-referral-hold-resume',
    paths: ['scripts/conveyor/reconcile-core.mjs'],
  },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes("const next = human ? 'advisory-review' : 'review';");
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const REPO = CONSTELLATION_REPOS.we.slug;
      const hold = await load('scripts/conveyor/review-referral-hold.mjs');
      const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
      const fixtures = join(sourceRoot, 'scripts/conveyor/__tests__/fixtures');
      const fx = n => {
        const path = join(fixtures, `pr-${n}-stale-referral-hold.json`);
        // A pre-fix tree has no fixtures either: replay the captured threads from this file's own tree.
        const raw = JSON.parse(readFileSync(existsSync(path) ? path : join(ROOT, 'scripts/conveyor/__tests__/fixtures', `pr-${n}-stale-referral-hold.json`), 'utf8'));
        return { ...raw, comments: raw.comments.map(c => (BOTS.has(c.author?.login) ? { ...c, author: { login: 'web-everything' } } : c)) };
      };
      const asPr = f => ({ number: f.number, headRefOid: f.headRefOid, body: f.body, createdAt: f.createdAt, isDraft: false,
        baseRefName: 'main', labels: f.labels.map(name => ({ name })), comments: f.comments,
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'ci' }] });
      const planFor = (f, env) => {
        let [pr] = hold.enrichPrsWithReferralHolds([asPr(f)], { repo: REPO, readRuns: () => f.runs, now: Date.parse(f.capturedAt), env });
        if (typeof hold.enrichPrsWithReferralHoldAutoResolve === 'function') {
          [pr] = hold.enrichPrsWithReferralHoldAutoResolve([pr], { repo: REPO, env,
            decide: (p, h) => hold.decideReferralHoldAutoResolve(p, h, { repo: REPO, cardReadable: () => false, env }) });
        }
        pr = { ...pr, labels: [{ name: 'review:pending' }] };
        return planReconcile({ repo: 'we', prs: [pr], agents: [], requiredChecks: ['test'], now: Date.parse('2026-10-21T17:30:00Z'),
          reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false } });
      };
      const kinds = p => (p.refusals ?? []).map(r => r.kind);
      for (const n of [5775, 5800]) {
        const p = planFor(fx(n), {});
        check(!kinds(p).includes(PAUSED), `#${n} (review:pending): every live-head finding is ruled, yet the plan still refuses ${PAUSED}`);
        check((p.dispatch ?? []).map(d => d.kind).join(',') === 'review', `#${n} (review:pending): exactly one review is owed once the pause lifts`);
        const off = planFor(fx(n), { WE_REFERRAL_HOLD_AUTO_RESOLVE: '0' });
        check(kinds(off).includes(PAUSED) && (off.dispatch ?? []).length === 0, `#${n}: the kill switch must keep today's pause`);
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
