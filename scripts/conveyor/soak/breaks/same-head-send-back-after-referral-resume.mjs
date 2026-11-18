/** A later changes verdict owes repair after a fixer attempt, even on a human-held, auto-resumed head. */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, '../../../../..');
const CORE = 'scripts/conveyor/reconcile-core.mjs';
const PR = 6945;
const HEAD = 'b'.repeat(40);

export default {
  id: 'same-head-send-back-after-referral-resume',
  title: 'a later same-head changes verdict dispatches repair after referral resume despite review:human',
  card: '#6945 same-head send-back after referral resume',
  fixedBy: { sha: 'pending', where: 'main', paths: [CORE] },
  fixPresent(root) {
    // Probe the requested tree's behavior, rather than guessing a future fix's source marker.
    try {
      const code = `import(${JSON.stringify(pathToFileURL(SELF).href)}).then(async ({ default: b }) => {
        const report = await b.run({ sourceRoot: ${JSON.stringify(root)} });
        process.exit(b.judge(report).length ? 1 : 0);
      }).catch(() => process.exit(2));`;
      execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', timeout: 60_000 });
      return true;
    } catch { return false; }
  },
  async run({ log, sourceRoot = process.env.SOAK_TREE_ROOT || ROOT } = {}) {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { planReconcile } = await load(CORE);
    const { buildFixBeginComment, buildFixEndComment } = await load('scripts/conveyor/fix-procedure.mjs');
    const { buildReviewedShaMarker } = await load('scripts/lib/review-escalation.mjs');
    const { ADVISORY_NOTE_MARKER } = await load('scripts/conveyor/advisory-round-count.mjs');
    const comment = (body, minute) => ({ body, author: { login: 'web-everything' },
      id: `same-head-${minute}`, createdAt: `2026-11-18T10:0${minute}:00Z` });
    const comments = [
      comment(`${ADVISORY_NOTE_MARKER}\n\n**Verdict:** changes\n\n### Findings (1)\n- Repair the head binding.\n\nNet basis: \`${'a'.repeat(40)}..${HEAD}\``, 1),
      comment(buildFixBeginComment({ who: 'same-head-fixer', why: 'repair', branch: 'lane/6945',
        headSha: HEAD, ttlMinutes: 60 }), 2),
      comment(buildFixEndComment({ who: 'same-head-fixer', headSha: HEAD }), 3),
    ];
    const request = comment(`🔁 review — changes requested\n\nRecorded by web-everything via review-pr.\n\n### Findings (1)\n- Repair the broken head binding.\n\n${buildReviewedShaMarker(HEAD)}`, 4);
    const pr = {
      number: PR, state: 'OPEN', isDraft: false, headRefName: 'lane/6945', headRefOid: HEAD,
      labels: ['review:human', 'status:sent-back-review'].map(name => ({ name })),
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
      referralHold: { kind: 'same-head', head: HEAD, count: 1, attemptsSinceWake: 1, why: 'findings need rulings' },
      referralHoldAutoResolve: { outcome: 'resume', head: HEAD, why: 'all findings ruled' },
    };
    const plan = thread => planReconcile({ prs: [{ ...pr, comments: thread }], agents: [],
      requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' },
      now: Date.parse('2026-11-18T12:00:00Z') });
    const report = { requested: plan([...comments, request]), withoutSendBack: plan(comments) };
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
