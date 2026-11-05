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
const SEND_BACKS = 'scripts/lib/operator-send-backs.mjs';
const RELEASE_SENTENCE = String(/^🔓 conveyor fix-end — fix claim released\r?\n\r?\n`([^`\r\n]+)` released the fix claim at `([a-f0-9]{7,40})`\.(?:[ \t]|\r?\n|$)/i);
// Require the complete R618 delta: either file alone (or a helper declaration) is insufficient.
const FIX_MARKERS = {
  [CORE]: [
    'function latestHeadReview(',
    'function operatorSendBackAfterReview(',
    'reviews.some(r => !r.head || !Number.isFinite(r.at))',
    'if (current.length || reviews.some(',
    'if (current.some((r, i) => i > 0 && r.at <= current[i - 1].at)) return null;',
    'latestHeadReview(pr, { currentHeadOnly: true })',
    'Date.parse(item.at) <= review.at',
    'item.index <= review.index',
    'operatorSendBackRearm(pr, { verdictId: pr.comments[item.index].id })',
    'Math.max(countRearmComments(after), countAdvisoryComments(after)) > 0',
    'const named = fixClaimReleaseHead(last.c.body)',
    'const releaseHead = isEnd && fixClaimReleaseHead(marker.c.body)',
    `${RELEASE_SENTENCE}.exec(body)`,
    'release.releasedAtMs > lastReview.at',
    'release.index > lastReview.index',
    "!withPhase.labels.includes(CONFLICT_LABEL) && String(pr?.mergeStateStatus ?? '').toUpperCase() !== 'DIRTY'",
    'advisoryReview = null, reviewAfterFix = null,',
    'if (advisoryReview || reviewAfterFix) {',
    'why: advisoryReview?.why ?? reviewAfterFix',
    ': { reviewAfterFix: why }),',
    "const why = 'the fixer released a new head after the last review — its review is owed before another repair';",
    "reason: 'fix-pushed'",
    "phase === 'needs-human' ? operatorSendBackAfterReview(pr) : null",
  ],
  [SEND_BACKS]: [
    "text.trimStart().startsWith('🔓 conveyor fix-end') && namesSendBack(text, item)",
    `${RELEASE_SENTENCE}.exec(text)`,
    'const head = release?.[1].trim() ? release[2] : null;',
    'Number.isFinite(at) && Number.isFinite(requestedAt) && at > requestedAt',
    'head && (!item.head || differentHead(item.head, head))) return true;',
  ],
};

export default {
  id: 'fix-end-rearms-review',
  title: 'a released fixer head owes review and a newer operator send-back owes repair',
  card: 'R618',
  fixedBy: {
    sha: '9e36a8389f', where: 'lane/r618-push-rearms-review',
    paths: [CORE, SEND_BACKS],
  },
  fixPresent: root => {
    try {
      return Object.entries(FIX_MARKERS).every(([path, markers]) => {
        const source = readFileSync(join(root, path), 'utf8');
        return markers.every(marker => source.includes(marker));
      });
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
