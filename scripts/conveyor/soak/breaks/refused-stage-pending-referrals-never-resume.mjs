/**
 * A stageVerdict refusal consumes confirm but retains cached pending referral keys.
 * Later standing rulings must release and rewind that same run, without another panel.
 * RED: the cached pending verdict keeps the refused run stuck after every ruling arrives.
 * GREEN: all keys ruled on this run/head resume; incomplete or mismatched evidence stays held.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HOLD = 'scripts/conveyor/review-referral-hold.mjs';
const LOOP = 'scripts/operations/review-loop-cli.mjs';

export default {
  id: 'refused-stage-pending-referrals-never-resume',
  title: 'a stageVerdict-refused run with cached pending referrals resumes only after every live same-run/head ruling',
  card: 'stageVerdict cached pending referrals (2026-11-06)',
  fixedBy: { sha: '065ad84674', where: 'main', paths: [HOLD, LOOP] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, HOLD), 'utf8').includes('export function refusedReferralsAreRuled')
        && readFileSync(join(root, LOOP), 'utf8').includes('parkedEvidence?.referralStageRefused');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const cases = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { createRegistry } = await load('scripts/operations/registry.mjs');
      const { createMemoryRunStore } = await load('scripts/operations/run-store.mjs');
      const { judgeOutcome } = await load('scripts/operations/cli-adapter.mjs');
      const { REVIEW_EFFECTS, reviewPrOperation } = await load('scripts/operations/review-pr.mjs');
      const { runReviewLoopOnce } = await load(LOOP);
      const { reviewRunEvidence, decideReferralHold, findResumableParkedRun } = await load(HOLD);
      const { referralFindingKey, normalizeFinding, mandatoryReferralReviewer, renderReferralRecord,
        mandatoryReferralState, buildOperatorRulingComment } = await load('scripts/lib/jury-core.mjs');
      const { AUTOMATION_LOGINS, OPERATOR_LOGINS } = await load('scripts/lib/marker-authorship.mjs');
      const head = 'a'.repeat(40);
      const repo = 'o/n';
      const pr = 4361;
      const body = '<!-- authored-by-actor: author -->';
      const path = 'scripts/operations/review-pr.mjs';
      const argv = [`--pr=${pr}`, `--repo=${repo}`];
      for (const kind of ['all-ruled-auto', 'all-ruled-explicit', 'unruled', 'partial', 'other-head', 'other-run', 'other-key']) {
        const runId = `soak-refused-${kind}`;
        const referrals = [1, 2].map(n => {
          const original = { file: path, line: n, summary: `confirmed defect ${n}`, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
          const seat = 'judgeCorrectnessAdvisory';
          return { key: referralFindingKey(seat, original), seat, original, finding: normalizeFinding(original) };
        });
        const rec = { version: 1, repo, pr, head, runId, reviewer: mandatoryReferralReviewer(runId),
          authorBody: body, attempted: true, referrals, rulings: [] };
        let comments = [{ body: renderReferralRecord(rec), author: { login: AUTOMATION_LOGINS[0] } }];
        const live = () => ({ headRefOid: head, number: pr, body, createdAt: '', comments });
        const declaration = reviewPrOperation({ minNonClaudeSeats: 0, readPr: subject => ({
          state: 'OPEN', createdAt: '', body, comments, headRefName: 'lane/soak',
          detail: { ...subject, title: 'refused referral soak', url: 'https://example.invalid/4361',
            labels: ['review:pending'], humanRequired: false, reviewClass: 'agent',
            disposition: { mode: 'converge', autoLand: false }, escalationReason: ['gate-self'],
            advisoryComment: null, humanComment: null, diffStat: [{ path, additions: 1, deletions: 0 }] },
          net: { paths: [path], base: 'abc123', rev: head, scored: true },
          diff: { text: '--- a/x\n+++ b/x\n+one line\n', scored: true },
        }) });
        const registry = createRegistry();
        registry.register(declaration);
        const store = createMemoryRunStore();
        let jurors = 0;
        const sinks = Object.fromEntries(Object.values(REVIEW_EFFECTS).map(type => [type, async () => ({ ok: true })]));
        sinks[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async () => mandatoryReferralState(comments,
          { repo, pr, head, body, cardReadable: () => true });
        const common = { declaration, registry, store, sinks, readAcceptancePr: live, cardReadable: () => true,
          makeJudge: () => async () => { jurors++; return judgeOutcome({ summary: 'gate seats clean', findings: [] }, {}); },
          acceptPolicy: { value: { unattendedAcceptRequiresCleanReferrals: false } },
          advisorySettings: () => ({ value: { mode: 'off' } }) };
        await runReviewLoopOnce({ ...common, argv, mintRunId: () => runId });
        const refused = await runReviewLoopOnce({ ...common, argv: [`--resume=${runId}`, '--answer=accept'] });
        const keys = referrals.map(f => f.key);
        const sameKeys = run => JSON.stringify(run?.verdict?.pendingReferrals) === JSON.stringify(keys);
        check(refused.stopped === 'step-refused' && refused.run.pending === null && sameKeys(refused.run)
          && declaration.steps[refused.run.cursor]?.name === 'stageVerdict', `${kind}: fixture must reach a real stageVerdict refusal with cached keys`);
        // Cache the durable projection BEFORE the later ruling; never refresh it from the thread.
        const rows = [reviewRunEvidence(refused.run)];
        const count = jurors;
        if (kind !== 'unruled') {
          const ruled = kind === 'partial' ? referrals.slice(0, 1) : referrals;
          comments = [...comments, { author: { login: OPERATOR_LOGINS[0] }, createdAt: '2026-11-06T13:25:00Z',
            body: buildOperatorRulingComment({ version: 1, repo, pr, head: kind === 'other-head' ? 'b'.repeat(40) : head,
              rulings: ruled.map(f => ({ runId: kind === 'other-run' ? 'other' : runId,
                key: kind === 'other-key' ? `other-${f.key}` : f.key, result: 'card', card: 'we:backlog/123-test.md' })),
              actor: OPERATOR_LOGINS[0], channel: 'terminal', reason: 'track separately',
              at: '2026-11-06T13:25:00Z', clearerId: 'operator-session' }) }];
        }
        const options = { repo, cardReadable: () => true };
        const held = decideReferralHold(live(), rows, options);
        const resumable = findResumableParkedRun(live(), rows, options);
        const clears = kind.startsWith('all-ruled');
        check(clears ? held === null && resumable?.id === runId && resumable?.head === head : held !== null && resumable === null,
          `${kind}: cached evidence must ${clears ? 'release only this ruled run' : 'keep the run blocked'}`);
        const out = await runReviewLoopOnce({ ...common,
          argv: kind === 'all-ruled-auto' ? argv : [`--resume=${runId}`],
          findResumableRun: () => resumable?.id ?? null, mintRunId: () => 'must-not-start' });
        if (clears) {
          check(out.stopped === 'complete' && out.run.id === runId && out.run.verdict?.verdict === 'accept'
            && out.run.verdict.pendingReferrals.length === 0 && out.run.findings.confirm === 'accept'
            && out.run.findings.stageVerdict?.applied === true && store.read('must-not-start') === null,
          `${kind}: later rulings must rewind and complete the refused run with no cached pending keys`);
        } else {
          check(out.stopped === 'refused' && out.run.id === runId && sameKeys(out.run), `${kind}: incomplete or mismatched rulings must preserve the refusal`);
        }
        check(jurors === count, `${kind}: resuming or refusing must never run another juror`);
        cases.push({ kind, stopped: out.stopped });
      }
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations, cases };
  },
  judge: report => report.violations,
};
