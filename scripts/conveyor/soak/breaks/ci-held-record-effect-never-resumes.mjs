/** #6940: a failed CI-held record effect must get a bounded resume, not an endless unfinished hold. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HOLD = 'scripts/conveyor/review-referral-hold.mjs';
const RECOVERY = 'scripts/lib/review-red-team-on-skip.mjs';

export default {
  id: 'ci-held-record-effect-never-resumes',
  title: 'CI-held record effects resume within the bound and escalate after it',
  card: '#6940',
  fixedBy: { sha: 'uncommitted', where: 'working tree', paths: [HOLD, RECOVERY] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, HOLD), 'utf8').includes('ciHeldRecordRetry = { attempts:')
        && readFileSync(join(root, RECOVERY), 'utf8').includes('unfinished review is held only on pending CI at record; resume it (bounded)');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [], cases = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { reviewRunEvidence, findResumableParkedRun } = await load(HOLD);
      const { planRedTeamOnSkip } = await load(RECOVERY);
      const repo = 'o/n', pr = 6940, head = 'a'.repeat(40), now = 2_000_000;
      for (const kind of ['first', 'at-bound', 'over-bound', 'off', 'operator-wake', 'other-head', 'non-CI', 'cooldown', 'body-file']) {
        const bodyFile = kind === 'body-file';
        const attempts = kind === 'at-bound' ? 3 : kind === 'over-bound' ? 4 : bodyFile ? 0 : 1;
        const run = { id: 'review-pr-soak-ci-held', op: 'review-pr', pending: { kind: 'effect', step: 'record' },
          findings: { read: { repo, pr, netBasis: { rev: head } } },
          stepTimings: [{ step: 'read', startedAt: new Date(1).toISOString() }],
          effects: [{ type: 'review.write-up', status: 'applied' }, { type: 'review.label-swap',
            status: bodyFile ? 'pending' : 'failed', unknownAttempts: attempts,
            error: bodyFile ? '--body-file=gone is unreadable (ENOENT)' : kind === 'non-CI' ? 'network timeout'
              : 'review held: CI still pending on reviewed head' }] };
        const row = reviewRunEvidence(run);
        const max = kind === 'off' ? 0 : 3;
        const live = { number: pr, headRefOid: kind === 'other-head' ? 'b'.repeat(40) : head, reviews: [],
          comments: kind === 'operator-wake' ? [{ body: 'fresh review', createdAt: new Date(2).toISOString(),
            author: { login: 'chalbert' } }] : [] };
        const resumable = findResumableParkedRun(live, [row], { repo, ciHeldRecordRetryMax: max });
        const decision = planRedTeamOnSkip({ repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: live.headRefOid }],
          rawPrs: [live], readEvidence: () => ({ ok: false, reason: 'review-unfinished' }),
          readReviewRuns: () => [row], headNeverReviewed: () => false, env: {}, now,
          lastDispatch: new Map(kind === 'cooldown' ? [[`${repo}#${pr}@${head}`, now]] : []),
          setting: { enabled: true, retryCooldownMin: 30, ciHeldRecordRetryMax: max } })[0];
        const resumes = ['first', 'at-bound', 'body-file', 'cooldown'].includes(kind);
        check(resumes ? resumable?.id === run.id : resumable === null, `${kind}: resume guard mismatch`);
        if (kind === 'cooldown') check(decision.action === 'skip' && decision.why === 'retry cooldown active', 'cooldown: retry must wait');
        else if (resumes) check(decision.action === 'review', `${kind}: unfinished review must resume`);
        else check(decision.action === 'skip' && decision.why === 'review-unfinished' && decision.escalate === true,
          `${kind}: unsafe or exhausted retry must escalate review-unfinished`);
        if (!bodyFile) check(row.retryableRecordEffect !== true, `${kind}: CI failure must never claim pre-write safety`);
        cases.push({ kind, action: decision.action });
      }
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations, cases };
  },
  judge: report => report.violations,
};
