/** PR #5925: a push or concurrent same-head send-back between re-arm writes
 * must not leave a marker that suppresses orphan recovery. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'pinned-rearm-orphan-marker',
  title: 'pinned re-arm never leaves an orphan marker suppressing recovery',
  card: 'PR #5925 / x1b8hlo: head movement and concurrent send-back',
  fixedBy: { sha: 'pending', where: 'lane/port-c-orphan-rearm', paths: ['scripts/review-set-label.mjs', 'scripts/conveyor/orphan-fix-round.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/review-set-label.mjs'), 'utf8').includes('pinnedPlainRearm');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { runReviewLabelCli } = await load('scripts/review-set-label.mjs');
    const { buildRearmComment, REARM_COMMENT_MARKER } = await load('scripts/conveyor/rearm-review.mjs');
    const { planOrphanFixRound, CHANGES_VERDICT_PREFIX } = await load('scripts/conveyor/orphan-fix-round.mjs');
    const { FIX_END_MARKER } = await load('scripts/conveyor/fix-procedure.mjs');
    const { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey,
      renderReferralRecord } = await load('scripts/lib/jury-core.mjs');
    const violations = [];
    const ledgerDir = mkdtempSync(join(tmpdir(), 'soak-pinned-rearm-'));
    const savedLedgerDir = process.env.WE_VERDICT_LEDGER_DIR;
    const savedLedgerStore = process.env.WE_VERDICT_LEDGER_STORE;
    const realExit = process.exit;
    const exitSignal = Symbol('expected CLI exit');
    const head = 'a'.repeat(40), moved = 'b'.repeat(40);
    const comment = (body, createdAt) => ({ body, createdAt, author: { login: 'web-everything' } });
    try {
      process.env.WE_VERDICT_LEDGER_DIR = ledgerDir;
      process.env.WE_VERDICT_LEDGER_STORE = 'home';
      process.exit = code => { throw { signal: exitSignal, code }; };
      for (const mode of ['third-read push', 'label write failure']) {
        let reads = 0, exitCode;
        const output = [];
        const pr = { number: 5925, labels: [{ name: 'review:changes' }], headRefOid: head,
          headRefName: 'lane/x', state: 'OPEN', isDraft: false, body: '', comments: [
            comment(`${CHANGES_VERDICT_PREFIX}\nNet basis: \`${'d'.repeat(40)}..${'c'.repeat(40)}\``, '2026-10-25T12:00:00Z'),
            comment('## 🔧 conveyor fix — evidence for the review:changes round', '2026-10-25T13:00:00Z'),
            comment(FIX_END_MARKER, '2026-10-25T13:01:00Z'),
          ] };
        const provider = {
          readPrState() {
            if (++reads >= 3 && mode === 'third-read push') pr.headRefOid = moved;
            return { ...pr };
          },
          readLabels: () => pr.labels,
          setLabels(_repo, _pr, { add, remove }) {
            if (mode === 'label write failure') throw new Error('label transport failed');
            pr.labels = [...pr.labels.filter(l => !remove.includes(l.name)), { name: add }];
          },
          postComment(_repo, _pr, body) { pr.comments.push(comment(body, '2026-10-25T13:02:00Z')); },
        };
        try {
          runReviewLabelCli({ argv: ['5925', '--repo=o/n', `--expect-head=${head}`], fixedTo: 'rearm',
            provider, defaultActor: 'test', usage: 'soak', buildComment: buildRearmComment,
            emit: line => output.push(line), successResult: o => o, refusalResult: o => o, signalFix() {} });
        } catch (error) {
          if (error?.signal !== exitSignal) throw error;
          exitCode = error.code;
        }
        const plan = planOrphanFixRound({ pr, nowMs: Date.parse('2026-10-25T15:00:00Z') });
        const error = JSON.parse(output.join('') || '{}').error ?? '';
        const expectedError = mode === 'third-read push' ? 'live head differs from --expect-head' : 'label transport failed';
        if (exitCode !== 1) violations.push(`${mode}: expected refusal`);
        if (!error.includes(expectedError)) violations.push(`${mode}: wrong refusal reason`);
        if (pr.comments.some(c => c.body.startsWith(REARM_COMMENT_MARKER))) violations.push(`${mode}: orphan marker remains`);
        if (plan.reason.includes('already re-armed')) violations.push(`${mode}: recovery suppressed`);
        if (mode === 'third-read push' && reads !== 3) violations.push(`${mode}: expected exactly three head reads`);
        if (mode === 'label write failure' && plan.decision !== 'rearm') violations.push(`${mode}: retry no longer actionable`);
        log?.(`${mode}: exit=${exitCode}, recovery=${plan.decision}, markers=${pr.comments.filter(c => c.body.startsWith(REARM_COMMENT_MARKER)).length}`);
      }
      // PR #5925 / x1b8hlo: a new send-back can land on the SAME SHA at either
      // write boundary. Settle that new referral only after the stale marker lands.
      for (const mode of ['after swap', 'final head read', 'during comment', 'same timestamp']) {
        const repo = 'o/n', runId = 'review-pr-5925-race', seat = 'judgeCorrectnessAdvisory';
        const reviewer = mandatoryReferralReviewer(runId);
        const original = { summary: 'concurrent referral', file: 'scripts/x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
        const key = referralFindingKey(seat, original);
        const body = '<!-- authored-by-actor: author -->';
        const record = { version: 1, repo, pr: 5925, head, runId, reviewer, authorBody: body, attempted: true,
          referrals: [{ key, seat, original, finding: normalizeFinding(original) }],
          rulings: [{ id: `${runId}:0`, key, reviewerId: reviewer.id, lens: 'correctness', result: 'block', rationale: 'checked', evidence: ['diff'] }] };
        const verdictBody = `${CHANGES_VERDICT_PREFIX}\n\n### Blocked referral findings\n\non head \`${head}\``;
        const oldVerdict = { ...comment(verdictBody, '2026-10-25T12:00:00Z'), id: 'IC_old' };
        const newVerdict = { ...comment(verdictBody, mode === 'same timestamp' ? oldVerdict.createdAt : '2026-10-25T13:00:00Z'), id: 'IC_new' };
        const pr = { number: 5925, body, createdAt: '2026-10-24T12:00:00Z', state: 'OPEN', isDraft: false,
          headRefOid: head, headRefName: 'lane/x', labels: [{ name: 'review:changes' }, { name: 'review:human' }],
          comments: [oldVerdict] };
        const sendBack = () => {
          pr.comments.push(comment(renderReferralRecord(record), '2026-10-25T12:59:00Z'), newVerdict);
          pr.labels = [{ name: 'review:changes' }, { name: 'review:human' }];
        };
        let reads = 0, exitCode = 0;
        const provider = {
          readPrState() {
            if (++reads === 3 && mode === 'final head read') sendBack();
            return { ...pr, comments: [...pr.comments] };
          },
          readLabels: () => pr.labels,
          setLabels(_repo, _pr, { add, remove }) {
            pr.labels = [...pr.labels.filter(l => !remove.includes(l.name)), { name: add }];
            if (mode === 'after swap' || mode === 'same timestamp') sendBack();
          },
          postComment(_repo, _pr, text) {
            if (mode === 'during comment') sendBack();
            pr.comments.push(comment(text, '2026-10-25T13:02:00Z'));
          },
        };
        try {
          runReviewLabelCli({ argv: ['5925', `--repo=${repo}`, `--expect-head=${head}`], fixedTo: 'rearm',
            provider, defaultActor: 'test', usage: 'soak', buildComment: buildRearmComment,
            emit() {}, successResult: o => o, refusalResult: o => o, signalFix() {} });
        } catch (error) {
          if (error?.signal !== exitSignal) throw error;
          exitCode = error.code;
        }
        pr.comments.push(comment(buildOperatorRulingComment({ version: 1, repo, pr: 5925, head,
          actor: 'chalbert', channel: 'claude-code-chat', reason: 'Operator settled the new referral',
          at: '2026-10-25T14:00:00Z', clearerId: 'session-5925', rulings: [{ runId, key, result: 'not-real' }] }), '2026-10-25T14:00:00Z'));
        const plan = planOrphanFixRound({ pr, repo, nowMs: Date.parse('2026-10-25T15:00:00Z') });
        if (exitCode !== 0) violations.push(`${mode}: re-arm unexpectedly failed`);
        if (!pr.labels.some(l => l.name === 'review:human')) violations.push(`${mode}: human hold lost`);
        if (plan.decision !== 'rearm') violations.push(`${mode}: ${plan.reason}`);
        log?.(`${mode}: exit=${exitCode}, recovery=${plan.decision}, reason=${plan.reason}`);
      }
    } finally {
      process.exit = realExit;
      if (savedLedgerDir === undefined) delete process.env.WE_VERDICT_LEDGER_DIR;
      else process.env.WE_VERDICT_LEDGER_DIR = savedLedgerDir;
      if (savedLedgerStore === undefined) delete process.env.WE_VERDICT_LEDGER_STORE;
      else process.env.WE_VERDICT_LEDGER_STORE = savedLedgerStore;
      rmSync(ledgerDir, { recursive: true, force: true });
      rmSync(`${ledgerDir}-locks`, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
