/** A later changes verdict owes repair after a fixer attempt, even on a human-held, auto-resumed head. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CORE = 'scripts/conveyor/reconcile-core.mjs';
const PR = 6945;
const HEAD = 'b'.repeat(40);

// Detect the repair independently of its replay outcome. Require its admission guards,
// not just a helper declaration, so an incomplete source tree fails closed.
export const FIX_MARKERS = {
  [CORE]: [
    'function sendBackAfterFixAttempt(pr) {',
    'const attempts = comments.map((c, index) => ({ c, index, at: Date.parse(c?.createdAt) })).filter(({ c }) => isFixAttempt(c));',
    'if (!attempts.length || attempts.some((a, i) => !Number.isFinite(a.at) || (i && a.at <= attempts[i - 1].at))) return null;',
    'const last = attempts.at(-1);',
    'const state = liveResultGateState(comments, pr.number, pr.headRefOid, pr.repo, pr.standingRuling);',
    'if (state.sendBackOutcome === GATE_OUTCOMES.ROUND_CAP && !state.reopened) return null;',
    'for (let index = comments.length - 1; index > last.index; index -= 1) {',
    'if (!(operator || changes)) continue;',
    'if (!Number.isFinite(at) || at <= last.at) return null;',
    "const pinned = verdictJudged(c, String(pr.headRefOid ?? '').toLowerCase())",
    '|| (operator?.head && sameHeadSha(operator.head, pr.headRefOid));',
    'if (!pinned || !mustFixEntries(c.body).length) return null;',
    'const gate = liveResultGateState(comments.filter(other => !isGate(other) || other === later),',
    'return gate.outcomes.size > 0;',
    'return superseded ? null : c;',
    '&& reviewedIndex >= 0 && attemptedIndex > reviewedIndex && !sendBackAfterFixAttempt(pr)) {',
  ],
};

export default {
  id: 'same-head-send-back-after-referral-resume',
  title: 'a later same-head changes verdict dispatches repair after referral resume despite review:human',
  card: '#6945 same-head send-back after referral resume',
  fixedBy: { sha: 'f08bcdca79', where: 'main', paths: [CORE] },
  fixPresent(root) {
    try {
      return Object.entries(FIX_MARKERS).every(([path, markers]) => {
        const source = readFileSync(join(root, path), 'utf8');
        return markers.every(marker => source.includes(marker));
      });
    } catch { return false; }
  },
  async run({ log, sourceRoot = process.env.SOAK_TREE_ROOT || ROOT } = {}) {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { planReconcile } = await load(CORE);
    const { buildFixBeginComment, buildFixEndComment } = await load('scripts/conveyor/fix-procedure.mjs');
    const { buildReviewedShaMarker } = await load('scripts/lib/review-escalation.mjs');
    const { ADVISORY_NOTE_MARKER } = await load('scripts/conveyor/advisory-round-count.mjs');
    // Keep the unit scenario's four comments and minute-based ordering, while
    // retaining the human-held, current-advisory referral-resume condition.
    const AUTOMATION = { login: 'web-everything' };
    const comment = (body, minute, author = AUTOMATION) => ({ body, author,
      id: `comment-${minute}`, createdAt: `2026-08-26T16:${String(minute).padStart(2, '0')}:00Z` });
    const reviewed = comment(`✅ review — accepted\n\n${buildReviewedShaMarker(HEAD)}`, 1);
    const attempt = comment(buildFixBeginComment({ who: 'fix-6945', why: 'repair', branch: 'lane/6945', headSha: HEAD, ttlMinutes: 60 }), 2);
    const release = comment(buildFixEndComment({ who: 'fix-6945', headSha: HEAD }), 3);
    const advisory = comment(`${ADVISORY_NOTE_MARKER}\n\n**Verdict:** accept\n\nNet basis: \`${'a'.repeat(40)}..${HEAD}\``, 0);
    const comments = [advisory, reviewed, attempt, release];
    const request = comment(`🔁 review — changes requested\n\nRecorded by ${AUTOMATION.login} via review-pr.\n\n### Findings (1)\n- Repair the broken head binding.\n\n${buildReviewedShaMarker(HEAD)}`, 4);
    const pr = {
      number: PR,
      state: 'OPEN',
      headRefName: 'lane/2612-converge-pr-drive',
      headRefOid: HEAD,
      labels: ['review:human', 'status:sent-back-review'].map(name => ({ name })),
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
      referralHold: { kind: 'same-head', head: HEAD, count: 1, attemptsSinceWake: 1, why: 'all findings ruled' },
      referralHoldAutoResolve: { outcome: 'resume', head: HEAD, why: 'all findings ruled' },
    };
    const plan = input => planReconcile({ prs: [input], agents: [],
      requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' },
      now: Date.parse('2026-08-26T17:34:00Z') });
    const input = { ...pr, comments: [...comments, request] };
    const report = { input, requested: plan(input), withoutSendBack: plan({ ...pr, comments }) };
    log?.(JSON.stringify(report));
    return report;
  },
  judge({ requested, withoutSendBack } = {}) {
    const violations = [];
    if (requested?.dispatch?.length !== 1 || requested.dispatch[0].kind !== 'fix'
      || requested.dispatch[0].prNumber !== PR || requested.dispatch[0].headRefOid !== HEAD
      || requested.refusals?.length !== 0) {
      violations.push('same-head-send-back-not-dispatched: later pinned changes must dispatch exactly one fixer without refusal');
    }
    if (withoutSendBack?.dispatch?.length !== 0 || withoutSendBack.refusals?.length !== 1
      || withoutSendBack.refusals[0].kind !== 'already-reviewed-head') {
      violations.push('missing-send-back-not-held: referral resume alone must keep the reviewed human head held');
    }
    return violations;
  },
};
