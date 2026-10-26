/** PR #5925 / x1b8hlo: sanctioned operator rulings use the automation account. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'automation-operator-ruling-orphan',
  title: 'automation-posted operator rulings recover an unowned referral bounce',
  card: '5726 / PR #5925',
  fixedBy: { sha: 'pending', where: 'lane/port-c-orphan-rearm', paths: ['scripts/conveyor/orphan-fix-round.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/conveyor/orphan-fix-round.mjs'), 'utf8');
    return source.includes('trusted.slice(vIndex + 1)')
      && source.includes("return none('malformed referral history — it stays with a person')");
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { runOrphanFixRoundPass, CHANGES_VERDICT_PREFIX } = await load('scripts/conveyor/orphan-fix-round.mjs');
    const { FIX_END_MARKER } = await load('scripts/conveyor/fix-procedure.mjs');
    const { openReferralFindings } = await load('scripts/operations/record-referral-ruling.mjs');
    const { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey,
      renderReferralRecord } = await load('scripts/lib/jury-core.mjs');
    const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
    const repo = CONSTELLATION_REPOS.we.slug, number = 5925, head = 'a'.repeat(40);
    const body = '<!-- authored-by-actor: author -->';
    const card = 'we:backlog/x1b8hlo-follow-up.md';
    const cardReadable = ref => ref === card;
    const comment = (at, body) => ({ createdAt: `2026-10-25T${at}:00Z`, body, author: { login: 'web-everything' } });
    const runId = 'review-pr-5925', seat = 'judgeCorrectnessAdvisory';
    const reviewer = mandatoryReferralReviewer(runId);
    const original = { summary: 'referral bounce', file: 'scripts/x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const key = referralFindingKey(seat, original);
    const record = { version: 1, repo, pr: number, head, runId, reviewer, authorBody: body, attempted: true,
      referrals: [{ key, seat, original, finding: normalizeFinding(original) }],
      rulings: [{ id: `${runId}:0`, key, reviewerId: reviewer.id, lens: 'correctness', result: 'block',
        rationale: 'checked', evidence: ['diff'] }] };
    const violations = [];
    for (const [result, history] of ['card', 'not-real'].flatMap(result =>
      ['later', 'same-second', 'malformed'].map(history => [result, history]))) {
      const answerAt = history === 'same-second' ? '12:00' : '13:00';
      const pr = { number, body, createdAt: '2026-10-24T12:00:00Z', headRefOid: head, isDraft: false,
        labels: ['review:changes', 'review:human'], comments: [
          comment('11:00', renderReferralRecord(record)),
          comment('12:00', `${CHANGES_VERDICT_PREFIX}\n\n### Blocked referral findings\n\non head \`${head}\``),
          comment(answerAt, buildOperatorRulingComment({ version: 1, repo, pr: number, head,
            actor: 'chalbert', channel: 'claude-code-chat', reason: 'Operator answered the referral',
            at: `2026-10-25T${answerAt}:00Z`, clearerId: 'session-5925',
            rulings: [{ runId, key, result, ...(result === 'card' ? { card } : {}) }] })),
        ] };
      if (history === 'malformed') {
        pr.labels = ['review:changes'];
        pr.comments.push(comment('13:01', '## Operator ruling on mandatory referrals\n\n<!-- mandatory-referral-operator-ruling-v1: not-base64 -->'),
          comment('13:02', '## 🔧 conveyor fix — evidence\n\nFindings addressed'), comment('13:03', FIX_END_MARKER));
      }
      const gate = openReferralFindings({ comments: pr.comments, repo, pr: number, head, body,
        createdAt: pr.createdAt, cardReadable });
      if (history === 'malformed') {
        if (!gate.malformed && !gate.protectionMalformed) violations.push(`${result}: malformed fixture did not close the gate`);
      } else if (gate.open.length || gate.ruled.length !== 1 || gate.pending.length || gate.blocked.length || gate.disputed.length
        || gate.malformed || gate.protectionMalformed) violations.push(`${result}: fixture did not settle the referral gate`);
      const calls = [];
      const pass = await runOrphanFixRoundPass({ repos: [{ key: 'we', slug: repo }], env: {},
        nowMs: Date.parse('2026-10-25T14:00:00Z'), listBounced: () => [pr],
        readComments: async () => pr.comments, isOwned: async () => false, cardReadable,
        rearm: async args => { calls.push(args); return { ok: true }; }, postComment() {},
        redispatch: async () => { throw new Error('no fix is owed'); },
        escalate: async () => { throw new Error('settled ruling needs no escalation'); },
      });
      if (history === 'malformed') {
        if (calls.length || pass.rows.length) violations.push(`${result}: malformed history triggered recovery`);
      } else if (calls.length !== 1 || calls[0]?.head !== head || calls[0]?.pr !== number || calls[0]?.slug !== repo
        || pass.rows[0]?.result !== 're-armed') violations.push(`${result}: settled automation ruling never reached pinned re-arm`);
      log?.(`${result}/${history}: open=${gate.open.length}, rearm calls=${calls.length}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
