/**
 * @file breaks/non-human-referral-hold-never-resumes.mjs — PR #5865 (lane/port-referral-hold-resume), live shape #5806.
 *
 * BREAK: a same-head referral pause whose live-head findings are ALL ruled resumed only for `review:human` PRs.
 * A PR that is not `review:human` (e.g. `review:pending`, #5806) stayed paused `review-referrals-pending` forever:
 * nothing was left to rule and no push or re-arm was coming. FIX: `reconcile-core.mjs#planReconcile`'s pre-pass
 * clears the hold for non-human PRs too and dispatches the ordinary `review` once.
 *
 * SCENARIO: the production enrich chain and planner on the captured #5775/#5800 threads, relabelled `review:pending` BEFORE enrichment (round/status labels kept)
 * with the hold clock inside the verdict grace. Negatives: an unruled finding stays held; a second finished review stays held. No IO.
 * RED  = pre-fix: the plan refuses `review-referrals-pending`, no review dispatched.
 * GREEN = no such refusal and exactly one `review` dispatch; the kill switch still pauses.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
// The live per-role bot logins come from host delivery settings a hermetic run does not read; the legacy bot login
// stands in for them (both are the automation's own trusted identity) — the same mapping the unit test uses.
const BOTS = new Set(['plateau-merger', 'plateau-reviewer', 'plateau-worker']);
const PAUSED = 'review-referrals-pending';

const module_default = {
  id: 'non-human-referral-hold-never-resumes',
  title: 'a same-head referral pause whose live-head findings are all ruled never resumes on a PR that is not review:human',
  card: 'PR #5865 (lane/port-referral-hold-resume), live shape #5806',
  fixedBy: {
    sha: 'ecdbcac78b', where: 'lane/port-referral-hold-resume',
    paths: ['scripts/conveyor/reconcile-core.mjs'],
  },
  // Behavioural: run the real scenario against THIS tree (child process, so a missing module never throws here).
  fixPresent(root) {
    const src = `import(${JSON.stringify(import.meta.url)}).then(m => m.probe(${JSON.stringify(root)})).then(ok => process.exit(ok ? 0 : 1), () => process.exit(1));`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 60_000 }).status === 0;
  },
  async run({ sourceRoot = ROOT, positiveOnly = false } = {}) {
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
      const asPr = (f, comments = f.comments) => ({ number: f.number, headRefOid: f.headRefOid, body: f.body, createdAt: f.createdAt, isDraft: false,
        baseRefName: 'main', labels: f.labels.map(name => ({ name: name === 'review:human' ? 'review:pending' : name })), comments,
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'ci' }] });
      // Hold clock inside the verdict write-back grace of the head's last finished run: a review:pending PR past it is the
      // no-verdict retry path (hold.noVerdict), which is deliberately never auto-resolved, not the path under test.
      const graceNow = (f, runs) => Math.max(...runs.filter(r => r.head === f.headRefOid && Number.isFinite(r.completedAt)).map(r => r.completedAt)) + 60_000;
      // Review:human dropped BEFORE enrichment (round/status/red-team labels kept), so the non-human hold path is the one built.
      const planFor = (f, env, { comments, runs = f.runs } = {}) => {
        let [pr] = hold.enrichPrsWithReferralHolds([asPr(f, comments)], { repo: REPO, readRuns: () => runs, now: graceNow(f, runs), env });
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
        check(!kinds(p).includes(PAUSED), `#${n} (review:pending): every live-head finding is ruled, yet the plan still refuses ${PAUSED}`);
        check((p.dispatch ?? []).map(d => d.kind).join(',') === 'review', `#${n} (review:pending): exactly one review is owed once the pause lifts`);
        const off = planFor(fx(n), { WE_REFERRAL_HOLD_AUTO_RESOLVE: '0' });
        if (positiveOnly) continue;
        check(kinds(off).includes(PAUSED) && (off.dispatch ?? []).length === 0, `#${n}: the kill switch must keep today's pause`);
      }
      if (!positiveOnly) {
        const f = fx(5775);
        // NEGATIVE 1: a finding with no ruling must stay held (drop the ruling comments), never resume.
        const unruled = f.comments.filter(c => !/^## (Automatic policy|Operator) ruling/.test(c.body));
        const pend = planFor(f, {}, { comments: unruled });
        check(kinds(pend).includes(PAUSED) && (pend.dispatch ?? []).length === 0,
          `#5775 (review:pending): a finding with no ruling must stay held ${PAUSED}, not resume`);
        // NEGATIVE 2: a second finished review of the head must NOT resume again.
        const last = f.runs.filter(r => r.head === f.headRefOid).sort((x, y) => x.completedAt - y.completedAt).at(-1);
        const again = { ...last, id: `${last.id}-again`, startedAt: last.completedAt + 60_000, completedAt: last.completedAt + 120_000 };
        const twice = planFor(f, {}, { runs: [...f.runs, again] });
        check((twice.dispatch ?? []).length === 0, '#5775 (review:pending): a second attempt on the head must not resume a review again');
        check(kinds(twice).length > 0, '#5775 (review:pending): the second-attempt plan must still carry a refusal, not vanish');
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};

/** The fix is present when the positive resume works on this tree (used by fixPresent, in a child process). */
export default module_default;
export async function probe(root) {
  const { violations } = await module_default.run({ sourceRoot: root, positiveOnly: true });
  return violations.length === 0;
}
