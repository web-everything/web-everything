/**
 * @file breaks/stale-referral-hold-never-resumes.mjs — live break, 2026-10-21 (stale-hold-resume).
 *
 * LIVE INCIDENT: PRs #5773, #5775 and #5800 sat "review paused: head … was already reviewed 1 time(s); it resumes on
 * a new push or an explicit re-arm" while EVERY referral finding on their live head already carried a ruling. No push
 * or re-arm was coming, so the review daemon's reconcile plan refused `review-referrals-pending` on every tick, forever.
 *
 * FIX: `review-referral-hold.mjs#decideReferralHoldAutoResolve` (+ `enrichPrsWithReferralHoldAutoResolve`, wired in
 * `reconcile-pass.mjs` after the ledger step) reads each live-head finding as the gate does; `reconcile-core.mjs`
 * turns an all-ruled `resume` into the next step: the human /review (`already-reviewed-head`, `review:human` kept)
 * when the head's advisory is current, or ONE advisory re-run when the head's only review left no advisory.
 *
 * SCENARIO: the production enrich chain (today's hold, then the auto-resolve step when the tree has it) and the
 * production planner, on the three live threads captured 2026-10-21 (the unit test's fixtures). No IO.
 * RED  = pre-fix: all three plans refuse `review-referrals-pending` with nothing to resume them.
 * GREEN = #5775 and #5800 move to the human gate, #5773 gets its one advisory review; the kill switch
 *         (WE_REFERRAL_HOLD_AUTO_RESOLVE=0) still pauses all three.
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
  id: 'stale-referral-hold-never-resumes',
  title: 'a same-head referral pause whose live-head findings are all ruled never resumes (no push or re-arm is coming)',
  card: 'stale-hold-resume (lane/stale-hold-resume), live PRs #5773 #5775 #5800',
  fixedBy: {
    sha: '6846d14cd', where: 'lane/stale-hold-resume',
    paths: ['scripts/conveyor/review-referral-hold.mjs', 'scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/reconcile-pass.mjs'],
  },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/conveyor/review-referral-hold.mjs'), 'utf8').includes('export function decideReferralHoldAutoResolve')
        && readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('enrichPrsWithReferralHoldAutoResolve');
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
        return planReconcile({ repo: 'we', prs: [pr], agents: [], requiredChecks: ['test'], now: Date.parse('2026-10-21T17:30:00Z'),
          reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false } });
      };
      const kinds = p => (p.refusals ?? []).map(r => r.kind);
      for (const n of [5775, 5800]) {
        const p = planFor(fx(n), {});
        check(!kinds(p).includes(PAUSED), `#${n}: every live-head finding is ruled, yet the plan still refuses ${PAUSED}`);
        check(kinds(p).includes('already-reviewed-head') && (p.dispatch ?? []).length === 0,
          `#${n}: an all-ruled review:human pause must move to the human /review (already-reviewed-head), no new panel`);
      }
      const p5773 = planFor(fx(5773), {});
      check(!kinds(p5773).includes(PAUSED), `#5773: every live-head finding is ruled, yet the plan still refuses ${PAUSED}`);
      check((p5773.dispatch ?? []).map(d => d.kind).join(',') === 'review',
        '#5773: its one finished review left no advisory, so exactly one advisory review is owed');
      for (const n of [5773, 5775, 5800]) {
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
