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
    const { buildRearmComment, REARM_COMMENT_MARKER, countRearmComments } = await load('scripts/conveyor/rearm-review.mjs');
    const { planOrphanFixRound, CHANGES_VERDICT_PREFIX, ORPHAN_GUARD_MARKER } = await load('scripts/conveyor/orphan-fix-round.mjs');
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
      // R88 / PR #5925: keep the same remote state across a failed command and
      // its retry, including the pending-without-marker state after failed rollback.
      for (const rollbackFails of [false, true]) {
        const mode = rollbackFails ? '503 with failed rollback' : '503 with rollback';
        const at = '2026-10-26T12:00:00Z';
        const originalLabels = ['review:changes', 'ready-to-merge', 'unrelated'];
        const pr = { number: 5925, body: '', state: 'OPEN', isDraft: false,
          headRefOid: head, headRefName: 'lane/x', labels: originalLabels.map(name => ({ name })),
          comments: [
            { ...comment(`${CHANGES_VERDICT_PREFIX}\nFindings`, at), id: 'IC_503' },
            comment(FIX_END_MARKER, at),
            ...Array.from({ length: 2 }, () => comment(`${ORPHAN_GUARD_MARKER} — re-dispatched a fixer`, at)),
          ] };
        let unavailable = true, labelWrites = 0, commentAttempts = 0;
        const sleeps = [];
        const provider = {
          readPrState: () => ({ ...pr, labels: [...pr.labels], comments: [...pr.comments] }),
          readLabels: () => pr.labels,
          setLabels(_repo, _pr, { add, remove }) {
            labelWrites++;
            if (unavailable && rollbackFails && labelWrites === 2) throw new Error('rollback unavailable');
            const names = new Set(pr.labels.map(l => l.name).filter(name => !remove.includes(name)));
            for (const name of add.split(',').filter(Boolean)) names.add(name);
            pr.labels = [...names].map(name => ({ name }));
          },
          postComment(_repo, _pr, body) {
            commentAttempts++;
            if (unavailable) throw new Error('HTTP 503: comment unavailable');
            pr.comments.push(comment(body, at));
          },
        };
        const invoke = () => {
          const output = [];
          let exitCode = 0;
          try {
            runReviewLabelCli({ argv: ['5925', '--repo=o/n', `--expect-head=${head}`], fixedTo: 'rearm',
              provider, defaultActor: 'test', usage: 'soak', buildComment: buildRearmComment,
              rearmRetrySleep: ms => sleeps.push(ms), emit: line => output.push(line),
              successResult: o => o, refusalResult: o => o, signalFix() {} });
          } catch (error) {
            if (error?.signal !== exitSignal) throw error;
            exitCode = error.code;
          }
          return { exitCode, error: JSON.parse(output.join('') || '{}').error ?? '' };
        };
        const failed = invoke();
        const labelsAre = expected => JSON.stringify(pr.labels.map(l => l.name).sort()) === JSON.stringify([...expected].sort());
        const expectedError = rollbackFails ? /rollback unavailable.*review:pending without a marker/ : /503.*labels restored/;
        if (failed.exitCode !== 1 || !expectedError.test(failed.error)) violations.push(`${mode}: wrong failure outcome`);
        if (commentAttempts !== 3 || JSON.stringify(sleeps) !== '[1000,1000]') violations.push(`${mode}: retry bound changed`);
        if (labelWrites !== 2) violations.push(`${mode}: expected one swap and one rollback attempt`);
        if (countRearmComments(pr.comments) !== 0) violations.push(`${mode}: failed attempt consumed a round`);
        if (!labelsAre(rollbackFails ? ['review:pending', 'unrelated'] : originalLabels)) violations.push(`${mode}: wrong recovery labels`);
        if (!rollbackFails) {
          const plan = planOrphanFixRound({ pr, nowMs: Date.parse('2026-10-26T15:00:00Z'), cap: 2 });
          if (plan.decision !== 'escalate' || !plan.reason.includes('cap 2')) violations.push(`${mode}: orphan cap bypassed`);
        }
        unavailable = false;
        const retried = invoke();
        if (retried.exitCode !== 0 || commentAttempts !== 4 || countRearmComments(pr.comments) !== 1) {
          violations.push(`${mode}: successful retry did not record exactly one round`);
        }
        const expectedWrites = rollbackFails ? 2 : 3;
        if (labelWrites !== expectedWrites || !labelsAre(['review:pending', 'unrelated'])) {
          violations.push(`${mode}: retry did not preserve marker-only resume or pending labels`);
        }
        const duplicate = invoke();
        if (duplicate.exitCode !== 0 || labelWrites !== expectedWrites || commentAttempts !== 4
          || countRearmComments(pr.comments) !== 1) violations.push(`${mode}: completed retry was not idempotent`);
        log?.(`${mode}: failure=${failed.exitCode}, retry=${retried.exitCode}, duplicate=${duplicate.exitCode}, markers=${countRearmComments(pr.comments)}`);
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
