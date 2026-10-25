/** PR #5765: failed retries must spend releases even when advise never finishes. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, writeRun } from '../../../operations/run-store.mjs';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';
import { planReconcile } from '../../reconcile-core.mjs';
import { enrichPrsWithReferralHolds, readReviewRunEvidence, raiseNoVerdictNeedsYou } from '../../review-referral-hold.mjs';

const SOURCE = 'scripts/conveyor/review-referral-hold.mjs';
const HOUR = 3600_000;
export default {
  id: 'stalled-review-pre-advise-crash',
  title: 'pre-advise crashes spend six growing cooldown releases and then hold permanently',
  card: 'PR #5765',
  fixedBy: { sha: 'HEAD', where: 'lane/grad-stalled-review-claim-2026-10-20', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('incomplete: true'); },
  async run() {
    const reports = [];
    for (const initialCompleted of [true, false, 'parked-wake']) reports.push(await runCase(initialCompleted));
    return { reports, violations: reports.flatMap(r => r.violations.map(v => `initialCompleted=${r.initialCompleted}: ${v}`)) };
  },
  judge(report) { return report.violations; },
};

async function runCase(initialCompleted) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-pre-advise-crash-'));
    try {
      const repo = ghRepoSlug('we'), head = 'a'.repeat(40), at = Date.parse('2026-10-20T12:00:00Z');
      const iso = t => new Date(t).toISOString();
      const pr = { number: 5765, headRefOid: head, headRefName: 'lane/stalled-review',
        body: '<!-- authored-by-actor: author -->', labels: [{ name: 'review:pending' }], comments: [],
        mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
      const save = (id, start, complete, parked = false) => {
        const r = newRunRecord({ id: `review-pr-${id}`, op: 'review-pr', input: { repo, pr: pr.number } });
        r.findings.read = { repo, pr: pr.number, netBasis: { rev: head } };
        r.stepTimings = [{ step: 'read', stepIndex: 0, startedAt: iso(start), finishedAt: iso(start + 1), durationMs: 1 }];
        if (complete) r.stepTimings.push({ step: 'advise', stepIndex: 8, startedAt: iso(start + 59_999), finishedAt: iso(start + 60_000), durationMs: 1 });
        if (parked) {
          r.findings.referralVerdict = { verdict: 'needs-human', pendingReferrals: ['parked-finding'] };
          r.findings.mandatoryReferrals = { effects: [{ type: 'review.mandatory-referrals', result: { records: [
            { repo, pr: pr.number, head, attempted: true, referrals: [{ key: 'parked-finding' }], rulings: [] },
          ] } }] };
        }
        writeRun(r, dir);
      };
      if (initialCompleted === 'parked-wake') {
        save('parked', at - HOUR, true, true);
        pr.comments.push({ body: 'Please review again.', createdAt: iso(at - 10 * 60_000), author: { login: 'chalbert' } });
      }
      for (let i = 0; i < 3; i++) save(`initial-${i}`, at - (initialCompleted === true ? 60_000 : 0) - i * 120_000, initialCompleted === true);
      const violations = [], cooldowns = [];
      const enriched = now => enrichPrsWithReferralHolds([pr], { repo, now,
        env: { WE_REVIEW_NO_VERDICT_COOLDOWN_RELEASES: '6' },
        readRuns: () => readReviewRunEvidence({ dir, memo: new Map() }) })[0];
      const reviews = now => planReconcile({ repo: 'we', prs: [enriched(now)], agents: [], now,
        requiredChecks: ['test'], reviewTiming: { startAfter: 'ci-green' } }).dispatch.filter(d => d.kind === 'review').length;
      if (reviews(at + 30 * 60_000)) violations.push('initial attempts bypassed the first cooldown');
      let due = at + HOUR;
      for (let release = 1; release <= 6; release++) {
        if (reviews(due) !== 1) violations.push(`release ${release}: due retry was not dispatched`);
        save(`crash-${release}`, due, false);
        const hold = enriched(due + 1).referralHold;
        if (reviews(due + 1)) violations.push(`release ${release}: crashed retry immediately dispatched again`);
        if (hold?.noVerdict?.releasesSpent !== release) violations.push(`release ${release}: attempt was not charged`);
        if (release < 6) {
          const delay = Math.min(HOUR * 2 ** release, 8 * HOUR);
          cooldowns.push(delay / HOUR);
          due += delay;
          if (hold?.retryAt !== due || reviews(due - 1)) violations.push(`release ${release}: growing cooldown was bypassed`);
        }
      }
      const held = enriched(due + 365 * 24 * HOUR).referralHold;
      if (!held?.noVerdict?.exhausted || held.retryAt !== null || reviews(due + 365 * 24 * HOUR)) {
        violations.push('seventh cooldown release remained eligible');
      }
      let alerts = 0;
      for (let tick = 0; tick < 3; tick++) raiseNoVerdictNeedsYou({ repo, prNumber: pr.number, hold: held, dir,
        now: due + tick, log: () => {}, publish: () => { alerts++; } });
      if (alerts !== 1) violations.push(`exhausted crashed retries published ${alerts} alerts, expected 1`);
      return { initialCompleted, cooldowns, alerts, violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
