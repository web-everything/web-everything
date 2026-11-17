/** #6940: a failed CI-held record effect must get a bounded resume, not an endless unfinished hold. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HOLD = 'scripts/conveyor/review-referral-hold.mjs';
const DRIVER = 'scripts/operations/review-loop-cli.mjs';
const RECOVERY = 'scripts/lib/review-red-team-on-skip.mjs';

export default {
  id: 'ci-held-record-effect-never-resumes',
  title: 'CI-held record effects resume within the bound and escalate after it',
  card: '#6940',
  fixedBy: { sha: 'uncommitted', where: 'working tree', paths: [HOLD, RECOVERY, DRIVER] },
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
      const { runReviewLoopOnce, defaultFindResumableRun } = await load(DRIVER);
      const { reviewPrOperation, REVIEW_EFFECTS } = await load('scripts/operations/review-pr.mjs');
      const { createRegistry } = await load('scripts/operations/registry.mjs');
      const { createMemoryRunStore } = await load('scripts/operations/run-store.mjs');
      const { judgeOutcome } = await load('scripts/operations/cli-adapter.mjs');
      const { notApplied } = await load('scripts/operations/effect-executor.mjs');
      for (const [kind, max, attempts, resumes, completedResume = false] of [
        ['driver-first', 3, 1, true], ['driver-at-bound', 3, 3, true],
        ['driver-over-bound', 3, 4, false], ['driver-off', 0, 1, false],
        ['driver-referral-resume-first', 3, 1, true, true], ['driver-referral-resume-at-bound', 3, 3, true, true],
        ['driver-referral-resume-over-bound', 3, 4, false, true], ['driver-referral-resume-off', 0, 1, false, true],
      ]) {
        const declaration = reviewPrOperation({ readPr: () => ({
          state: 'OPEN', createdAt: '', body: '<!-- authored-by-actor: author -->',
          detail: { repo, pr, title: 'CI-held soak', labels: ['review:pending'], humanRequired: false,
            reviewClass: 'pending', disposition: { mode: 'converge', autoLand: false },
            diffStat: [{ path: 'scripts/example.mjs', additions: 1, deletions: 0 }] },
          net: { paths: ['scripts/example.mjs'], base: 'b'.repeat(40), rev: head, scored: true },
          diff: { text: '+one line', scored: true },
        }) });
        const registry = createRegistry(); registry.register(declaration);
        const store = createMemoryRunStore();
        let judges = 0, labels = 0, writes = 0;
        const sinks = Object.fromEntries(Object.values(REVIEW_EFFECTS).map(type => [type, async () => { writes++; return { ok: true }; }]));
        sinks[REVIEW_EFFECTS.LABEL] = async () => { labels++; throw notApplied('review held: CI still pending on reviewed head'); };
        const args = { declaration, registry, store, sinks, argv: [`--pr=${pr}`, `--repo=${repo}`, '--json'],
          makeJudge: () => async () => { judges++; return judgeOutcome({ summary: 'clean', findings: [] }, {}); },
          mintRunId: () => 'ci-held-original',
          acceptPolicy: { value: { unattendedAcceptRequiresCleanReferrals: false } },
          advisorySettings: () => ({ value: { mode: 'off' } }), recordAdvisoryLoops: () => null, recordAdvisoryRating: () => null,
          findFiledPrevention: () => null, findFiledRoundCards: () => null,
          redTeamOnSkipSettings: () => ({ value: { ciHeldRecordRetryMax: max } }),
          readAcceptancePr: () => ({ headRefOid: head, body: '<!-- authored-by-actor: author -->', comments: [] }),
        };
        await runReviewLoopOnce(args);
        const saved = store.read('ci-held-original');
        check(saved?.pending?.step === 'record', `${kind}: fixture must reach record`);
        const label = saved.effects.find(e => e.type === REVIEW_EFFECTS.LABEL);
        check(label?.status === 'failed', `${kind}: fixture must save a failed effect`);
        label.unknownAttempts = attempts;
        if (completedResume) saved.resumeOf = { verdict: saved.findings.referralVerdict,
          mandatoryReferrals: saved.findings.mandatoryReferrals, attempts: 1 };
        store.write(saved);
        const before = { judges, writes, labels };
        const out = await runReviewLoopOnce({ ...args, mintRunId: () => 'fresh-panel',
          findResumableRun: input => defaultFindResumableRun(input, {
            readPr: () => ({ headRefOid: head, comments: [] }),
            readRuns: () => [reviewRunEvidence(store.read(saved.id))],
          }),
        });
        check(out.run?.id === (resumes ? saved.id : 'fresh-panel'), `${kind}: driver resume guard mismatch`);
        if (resumes) {
          check(judges === before.judges && writes === before.writes, `${kind}: panel and applied writes must not replay`);
          check(labels === before.labels + 1, `${kind}: failed label swap must retry`);
          check(out.run?.recordEffectResumeAttempts === 1 && Boolean(out.run?.resumedAt)
            && Boolean(out.run?.resumeOf) === completedResume,
            `${kind}: resume must spend the record budget in place`);
          check(out.run?.effects.find(e => e.type === REVIEW_EFFECTS.LABEL)?.status === 'failed', `${kind}: pending CI must keep holding`);
        } else check(judges > before.judges, `${kind}: fresh panel fallback must remain reachable`);
        cases.push({ kind, runId: out.run?.id });
        if (kind === 'driver-first') {
          // A second pre-write failure must not erase the first CI hold's retry policy.
          let clearanceReads = 0;
          const retryArgs = { ...args, argv: [`--resume=${saved.id}`, '--json'],
            acceptPolicy: { value: { unattendedAcceptRequiresCleanReferrals: true } },
            readAcceptancePr: () => { clearanceReads++; return {
              headRefOid: head, body: '<!-- authored-by-actor: author -->', comments: [],
            }; },
          };
          sinks[REVIEW_EFFECTS.LABEL] = async () => {
            throw notApplied('review-set-label.mjs could not be started, nothing was written: EAGAIN');
          };
          await runReviewLoopOnce(retryArgs);
          const interrupted = reviewRunEvidence(store.read(saved.id));
          check(interrupted?.ciHeldRecordRetry?.attempts === 3,
            'pre-write retry: EAGAIN must retain CI-held evidence and its spent attempts');
          check(findResumableParkedRun({ number: pr, headRefOid: head, comments: [] }, [interrupted],
            { repo, ciHeldRecordRetryMax: 3 })?.id === saved.id, 'pre-write retry: discovery must retain the held run');
          clearanceReads = 0;
          let strictGate = false;
          sinks[REVIEW_EFFECTS.LABEL] = async (_payload, ctx) => {
            strictGate = ctx.requireCiGate === true;
            throw notApplied('review held: CI still pending on reviewed head');
          };
          const retry = await runReviewLoopOnce(retryArgs);
          check(strictGate && clearanceReads > 0, 'pre-write retry: both CI and acceptance guards must survive');
          check(retry.stopped === 'effect-halted', 'pre-write retry: pending CI must keep the run held');
          cases.push({ kind: 'driver-prewrite-failure-preserves-ci-hold', runId: retry.run?.id });
        }
      }

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
