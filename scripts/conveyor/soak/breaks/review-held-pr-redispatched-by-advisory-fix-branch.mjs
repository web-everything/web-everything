/**
 * @file breaks/review-held-pr-redispatched-by-advisory-fix-branch.mjs — live break 2026-10-04 03:50-04:05Z, card
 * xuxcsw6 (follow-up to #4918/xux0rs9). PR #3771 sat on one head (review:human + advisory:changes) with
 * CONFIRMED findings awaiting a block/card/not-real ruling. The referral hold from #4918 was in the daemon, yet the
 * review daemon re-dispatched a full review on the unchanged head (about 5 min and a full seat bill each time).
 *
 * MECHANISM: `reconcile-core.mjs#planReconcile` has two advisory-fix branches (a fix-mark postdates the newest
 * advisory; the newest advisory does not cover the head) that push `kind:'review'` directly. Only
 * `dispatchReviewRow` checked `pr.referralHold`. A review that parks for a human posts no fresh advisory note, so
 * "a fix postdates the advisory" stays true and a review is owed again on every tick.
 *
 * FIX: `refuseReferralHold` guards every review emission (kind `review-referrals-pending`).
 *
 * SCENARIO: the planner (through the real `decideReferralHold`) on the live shape, three ticks on one head. RED =
 * any review dispatch while the hold stands, or the hold not lifting on a new head (control).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const src = process.env.SOAK_SOURCE_ROOT;
const imp = (rel) => import(pathToFileURL(join(src, rel)).href);
const core = await imp('scripts/conveyor/reconcile-core.mjs');
const hold = await imp('scripts/conveyor/review-referral-hold.mjs');
const { ADVISORY_NOTE_MARKER } = await imp('scripts/conveyor/advisory-round-count.mjs');
const { buildAdvisoryFixComment } = await imp('scripts/conveyor/advisory-fix-mark.mjs');
const repo = 'owner/repo';
const head = '75b8199a815e7fa4b264b1dc222572c20ed31c7c';
const at = Date.parse('2026-10-04T03:50:00Z');
const evidence = { id: 'review-pr-1', repo, pr: 3771, head, startedAt: at, completedAt: at + 300_000,
  parked: true, pending: ['k'], attempted: true, persistenceFailed: false, count: 1, rulings: [] };
const basePr = (over = {}) => ({ number: 3771, state: 'OPEN', headRefName: 'lane/xjudge', headRefOid: head,
  labels: [{ name: 'review:human' }, { name: 'advisory:changes' }], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
  comments: [{ body: ADVISORY_NOTE_MARKER + '\\n\\nround 1', author: { login: 'web-everything' } },
    { body: buildAdvisoryFixComment({}), viewerDidAuthor: true }], ...over });
const plan = (pr) => core.planReconcile({ prs: [{ ...pr, referralHold: hold.decideReferralHold(pr, [evidence], { repo, now: at + 400_000 }) }],
  agents: [], now: at + 400_000, requiredChecks: ['gate'] });
const out = { heldReviews: 0, refusals: [], controlReviews: 0 };
for (let tick = 0; tick < 3; tick++) {
  const p = plan(basePr());
  out.heldReviews += p.dispatch.filter((d) => d.kind === 'review').length;
  out.refusals.push(...p.refusals.map((r) => r.kind));
}
out.controlReviews = plan(basePr({ headRefOid: 'b'.repeat(40) })).dispatch.filter((d) => d.kind === 'review').length;
process.stdout.write(JSON.stringify(out));
`;

export default {
  id: 'review-held-pr-redispatched-by-advisory-fix-branch',
  title: 'a PR held for unanswered mandatory referrals is re-reviewed every tick on an unchanged head through the advisory-fix review branches',
  card: 'card xuxcsw6; live incident PR #3771, 2026-10-04 03:50-04:05Z (follow-up to #4918)',
  fixedBy: { sha: '0dd46f7b3', where: 'lane/xuxcsw6-referral-hold-all-review-branches', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/reconcile-core.mjs');
    return existsSync(p) && readFileSync(p, 'utf8').includes('if (refuseReferralHold({ pr, refuse, withPhase })) continue;');
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-held-review-'));
    const violations = [];
    try {
      const childFile = join(dir, 'child.mjs');
      writeFileSync(childFile, CHILD);
      let out;
      try {
        out = JSON.parse(execFileSync('node', [childFile], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SOAK_SOURCE_ROOT: sourceRoot },
        }));
      } catch (e) {
        violations.push({ invariant: 'scenario-runs', detail: `the scenario child crashed: ${String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' | ')}` });
        return { violations };
      }
      log?.(`held reviews: ${out.heldReviews}; refusals: ${out.refusals.join(',')}; control reviews: ${out.controlReviews}`);
      if (out.heldReviews > 0) {
        violations.push({ invariant: 'held-pr-redispatched', detail: `${out.heldReviews} review(s) dispatched in 3 ticks on an unchanged head while mandatory referrals await a ruling` });
      }
      if (out.refusals.filter((k) => k === 'review-referrals-pending').length !== 3) {
        violations.push({ invariant: 'refusal-kind-logged', detail: `expected review-referrals-pending on each of 3 ticks, got: ${out.refusals.join(',') || 'none'}` });
      }
      if (out.controlReviews !== 1) {
        violations.push({ invariant: 'new-head-reviews', detail: `a new head must be owed a review (control), got ${out.controlReviews}` });
      }
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
