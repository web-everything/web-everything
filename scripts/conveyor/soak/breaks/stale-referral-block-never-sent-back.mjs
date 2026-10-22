/**
 * @file breaks/stale-referral-block-never-sent-back.mjs — stale-hold-resume 2/2, live 2026-10-21.
 *
 * LIVE INCIDENT: #5775's same-head referral pause has no unruled finding. An operator BLOCK on its live
 * head owes a send-back to the fixer, but the pre-fix daemon only posts another "waiting on your ruling" notice.
 *
 * SCENARIO: replay the captured thread with the unit tests' live-head operator block, enrich and plan with
 * production code, then run three production review ticks with recorded IO. As in the planner unit test,
 * blockRuledReferrals is empty so the pause reaches the daemon rather than the planner dispatching a fix.
 * The listing deliberately stays unchanged: the daemon must remember a successful send-back itself.
 * RED = no send-back and a redundant ruling notice. GREEN = exactly one send-back and no ruling notice.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
// Same trusted-login mapping as the live-fixture unit tests; hermetic runs do not read host delivery settings.
const BOTS = new Set(['plateau-merger', 'plateau-reviewer', 'plateau-worker']);

export default {
  id: 'stale-referral-block-never-sent-back',
  title: 'a referral pause with a live-head block goes back to the fixer (stale-hold 2/2)',
  card: 'stale-hold-resume (lane/stale-hold-resume), live PR #5775',
  fixedBy: {
    sha: '6846d14cd', where: 'lane/stale-hold-resume',
    paths: ['skills-src/conveyor/review-daemon.mjs', 'scripts/conveyor/referral-hold-send-back.mjs'],
  },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'skills-src/conveyor/review-daemon.mjs'), 'utf8').includes('export function handleReferralHoldAutoResolve')
        && existsSync(join(root, 'scripts/conveyor/referral-hold-send-back.mjs'));
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const REPO = CONSTELLATION_REPOS.we.slug;
      const { buildOperatorRulingComment, readReferralRecords } = await load('scripts/lib/jury-core.mjs');
      const hold = await load('scripts/conveyor/review-referral-hold.mjs');
      const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
      const { runReviewTick } = await load('skills-src/conveyor/review-daemon.mjs');
      const fixture = 'scripts/conveyor/__tests__/fixtures/pr-5775-stale-referral-hold.json';
      const path = join(sourceRoot, fixture);
      // Pre-fix trees can predate the captured fixture; replay it from this break's own tree in that case.
      const raw = JSON.parse(readFileSync(existsSync(path) ? path : join(ROOT, fixture), 'utf8'));
      const fx = { ...raw, comments: raw.comments.map(c => (BOTS.has(c.author?.login) ? { ...c, author: { login: 'web-everything' } } : c)) };
      const rec = readReferralRecords(fx.comments, { head: fx.headRefOid }).records.find(r => r.head === fx.headRefOid);
      // After the operator's 10:57 not-real, before the 11:21 review: this is a ruling, not a wake.
      const at = '2026-10-21T10:58:00.000Z';
      const body = buildOperatorRulingComment({ version: 1, repo: REPO, pr: fx.number, head: fx.headRefOid,
        rulings: [{ runId: rec.runId, key: rec.referrals[0].key, result: 'block' }], actor: 'chalbert', channel: 'test',
        reason: 'operator: this must be fixed', at, clearerId: '' });
      const block = { author: { login: 'chalbert' }, authorAssociation: 'OWNER', body, createdAt: at };
      const index = fx.comments.findIndex(c => c.createdAt > '2026-10-21T10:58:00Z');
      const comments = [...fx.comments.slice(0, index), block, ...fx.comments.slice(index)];
      const subject = { number: fx.number, headRefOid: fx.headRefOid, body: fx.body, createdAt: fx.createdAt,
        isDraft: false, baseRefName: 'main', labels: fx.labels.map(name => ({ name })), comments,
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'ci' }] };
      const env = {};
      let [pr] = hold.enrichPrsWithReferralHolds([subject], { repo: REPO, readRuns: () => fx.runs, now: Date.parse(fx.capturedAt), env });
      if (typeof hold.enrichPrsWithReferralHoldAutoResolve === 'function') {
        [pr] = hold.enrichPrsWithReferralHoldAutoResolve([pr], { repo: REPO, env,
          decide: (p, h) => hold.decideReferralHoldAutoResolve(p, h, { repo: REPO, cardReadable: () => false, env }) });
      }
      const plan = planReconcile({ repo: 'we', prs: [{ ...pr, blockRuledReferrals: [] }], agents: [], requiredChecks: ['test'],
        now: Date.parse(fx.capturedAt), reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false } });
      const sends = [], notices = [];
      const autoResolveSeen = new Set();
      for (let tick = 0; tick < 3; tick++) {
        runReviewTick({ repo: REPO, reconcile: () => plan, dispatch: () => {}, readPrs: () => [subject], readAgents: () => [],
          holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, notifyReferral: args => notices.push(args),
          sendBackReferralHold: args => { sends.push(args); return { sentBack: true }; }, autoResolveSeen, log: () => {} });
      }
      const sent = sends.filter(s => s.repo === REPO && s.pr === fx.number && s.head === fx.headRefOid);
      check(sent.length > 0, '#5775: the owed send-back for its live-head block was never sent');
      check(sent.length <= 1, '#5775: the send-back for its live-head block was sent more than once');
      check(notices.length === 0, '#5775: a "waiting on your ruling" referral notice was posted for a pause with no unruled finding');
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
