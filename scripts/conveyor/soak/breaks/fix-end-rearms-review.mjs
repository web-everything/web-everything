/**
 * R618: a pushed repair retained review:human and stale advisory findings, so
 * its new head never got reviewed. A newer operator send-back could also be
 * refused as already reviewed after an auto-resolved same-head referral hold.
 * Fixtures mirror reconcile-core-push-rearms-review.test.mjs. Every production
 * import follows sourceRoot so the same replay exercises the pre-fix tree.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CORE = 'scripts/conveyor/reconcile-core.mjs';

export default {
  id: 'fix-end-rearms-review',
  title: 'a released fixer head owes review and a newer operator send-back owes repair',
  card: 'R618',
  fixedBy: {
    sha: '9e36a8389f', where: 'lane/r618-push-rearms-review',
    paths: [CORE, 'scripts/lib/operator-send-backs.mjs'],
  },
  fixPresent: root => {
    try {
      const source = readFileSync(join(root, CORE), 'utf8');
      return source.includes('function latestHeadReview(')
        && source.includes('function operatorSendBackAfterReview(')
        && source.includes('release.index > lastReview.index')
        && source.includes("reason: 'fix-pushed'")
        && source.includes("phase === 'needs-human' ? operatorSendBackAfterReview(pr) : null");
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { planReconcile } = await load(CORE);
      const { buildFixEndComment } = await load('scripts/conveyor/fix-procedure.mjs');
      const { ADVISORY_NOTE_MARKER } = await load('scripts/conveyor/advisory-round-count.mjs');
      const OLD = 'a'.repeat(40), HEAD = 'b'.repeat(40);
      const author = { login: 'web-everything' };
      const REVIEW_AT = '2026-11-05T10:00:00Z', SEND_AT = '2026-11-05T11:00:00Z';
      const END_AT = '2026-11-05T11:21:00Z';
      const advisory = (head = OLD) => ({ author, createdAt: REVIEW_AT,
        body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** changes\n\nRequired repair.\n\n---\n\nNet basis: \`${'c'.repeat(40)}..${head}\` — 1 net changed file(s) vs current main` });
      const end = { author, createdAt: END_AT,
        body: buildFixEndComment({ who: 'fix-session', headSha: HEAD }) };
      const sendBack = { id: 'send-back', author: { login: 'chalbert' }, createdAt: SEND_AT,
        body: `🔁 review — changes requested\n\nRecorded by chalbert via console.\n\nAt head \`${HEAD}\`: fix the export.` };
      const pr = {
        number: 6360, state: 'OPEN', headRefName: 'lane/r618', headRefOid: HEAD,
        labels: ['review:human', 'advisory:changes'], mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
        comments: [advisory(), end],
      };
      const plan = (extra = {}) => {
        const input = { ...pr, ...extra };
        return planReconcile({
          prs: [{ ...input, labels: input.labels.map(name => ({ name })) }], agents: [],
          requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' },
          now: Date.parse('2026-11-05T12:00:00Z'),
        });
      };
      const repaired = plan();
      check(repaired.dispatch.some(row => row.kind === 'review' && row.headRefOid === HEAD),
        'trusted fix-end on a new head did not dispatch review');
      const requested = plan({
        labels: ['review:human'], comments: [advisory(HEAD), sendBack],
        referralHold: { kind: 'same-head', head: HEAD, why: 'findings ruled' },
        referralHoldAutoResolve: { outcome: 'resume', head: HEAD, why: 'all ruled' },
      });
      check(requested.dispatch.some(row => row.kind === 'fix' && row.mode === 'operator-send-back'),
        'newer operator send-back did not dispatch fix after the same-head advisory');
      check(!requested.refusals.some(row => row.kind === 'already-reviewed-head'),
        'newer operator send-back was refused already-reviewed-head');
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
