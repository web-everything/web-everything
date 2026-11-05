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
export const FIX_MARKERS = {
  [CORE]: [
    // Release evidence: retain original thread indexes and require the actual producer sentence.
    ".flatMap((c, index) => isTrustedMarkerAuthor(c) && typeof c?.body === 'string'",
    '? [{ c, index, body: c.body.trimStart(), at: Date.parse(c.createdAt) }] : [])',
    'const named = fixClaimReleaseHead(last.c.body);',
    'const releaseHead = isEnd && fixClaimReleaseHead(marker.c.body);',
    'return { releasedAtMs: last.at, index: last.index, head, who, releases: [...releasesBySession.values()] };',
    'function fixClaimReleaseHead(body) {',
    `const release = ${RELEASE_SENTENCE}.exec(body);`,
    'return release?.[1].trim() ? release[2] : null;',
    // Every review-history selection, ordering and fail-closed return is part of the fix.
    'function latestHeadReview(pr, { currentHeadOnly = false } = {}) {',
    '.map((c, index) => ({ c, index }))',
    '.map(({ c, index }) => ({ index, head: reviewedHeadsOf(c).at(-1) ?? latestAdvisory([c])?.head, at: Date.parse(c.createdAt) }));',
    'if (!reviews.length || reviews.some(r => !r.head || !Number.isFinite(r.at))) return null;',
    'const current = reviews.filter(r => sameHeadSha(r.head, pr.headRefOid));',
    'if (currentHeadOnly) {',
    'return current.at(-1) ?? null;',
    'if (current.length || reviews.some((r, i) => i > 0 && r.at <= reviews[i - 1].at)) return null;',
    'return reviews.at(-1);',
    // Send-back admission: all evidence, head, chronology and one-shot checks must survive.
    'function operatorSendBackAfterReview(pr) {',
    'const review = latestHeadReview(pr, { currentHeadOnly: true });',
    'if (!review || !sameHeadSha(review.head, pr.headRefOid)) return null;',
    'const item = openOperatorSendBacks(pr).at(-1);',
    'if (!item?.body || !Number.isFinite(Date.parse(item.at)) || Date.parse(item.at) <= review.at',
    '|| item.index <= review.index',
    '|| (item.head && !sameHeadSha(item.head, pr.headRefOid))) return null;',
    'if (!item.id || !operatorSendBackRearm(pr, { verdictId: pr.comments[item.index].id })) return null;',
    'return { verdictId: item.id, login: item.login, body: item.body };',
    // Shared review emission must preserve advisory metadata and the ordinary send-back fallback.
    '...(advisoryReview ? { advisoryReview: { head: advisoryReview.head, reason: advisoryReview.reason,',
    '...(advisoryReview.ciWaived === true ? { ciWaived: true } : {}) } } : {}),',
    'why: advisoryReview?.why ?? reviewAfterFix,',
    "const sendBack = (phase === 'needs-human' ? operatorSendBackAfterReview(pr) : null)",
    "?? ((ciRepairOwed || (phase === 'bounced' && !withPhase.labels.includes(CONFLICT_LABEL)))",
    '? operatorSendBackRearm(pr, operatorBudget) : null);',
    'why: `operator send-back by @${sendBack.login} with a must-fix body — re-armed once as a fix (operator re-arm)`,',
    // Context pins repeated call/argument/continue lines to this producer, not another dispatch branch.
    'const lastReview = latestHeadReview(pr);',
    'const release = releasedFixClaim(pr);',
    'if (OWED[phase] && lastReview && release && release.releasedAtMs > lastReview.at',
    "&& !withPhase.labels.includes(CONFLICT_LABEL) && String(pr?.mergeStateStatus ?? '').toUpperCase() !== 'DIRTY'",
    '&& release.index > lastReview.index',
    '&& !sameHeadSha(lastReview.head, pr.headRefOid)) {',
    [
      '      dispatchReviewRow({ pr, requiredChecks, withPhase, base, attempts: roundAttempts(),',
      '        roundCap: effectiveRoundCap, refuse, refuseCapExhausted, dispatch, now,',
      '        ...(withPhase.labels.includes(REVIEW_LABELS.human)',
      "          ? { advisoryReview: { head: pr.headRefOid, reason: 'fix-pushed', why } }",
      '          : { reviewAfterFix: why }),',
      '      });',
      '      continue;',
    ].join('\n'),
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
    "const reviews = (Array.isArray(pr?.comments) ? pr.comments : [])",
    ".filter(({ c }) => isTrustedMarkerAuthor(c) && (isReviewVerdictComment(c) || latestAdvisory([c])))",
    ".filter(({ c }) => !isOperatorAuthored(c) || !openOperatorSendBacks({ comments: [c] }).length)",
    "if ((advisoryReview?.ciWaived !== true || pr.reviewTiming?.startAfter !== 'ci-green') && !reviewChecksAllow({ pr, requiredChecks, refuse, withPhase, extra })) return;",
    'advisoryReview = null, reviewAfterFix = null,',
    'if (advisoryReview || reviewAfterFix) {',
    'why: advisoryReview?.why ?? reviewAfterFix',
    ': { reviewAfterFix: why }),',
    "const why = 'the fixer released a new head after the last review — its review is owed before another repair';",
    "reason: 'fix-pushed'",
    "phase === 'needs-human' ? operatorSendBackAfterReview(pr) : null",
  ],
  [SEND_BACKS]: [
    "if (text.trimStart().startsWith('🔓 conveyor fix-end') && namesSendBack(text, item)) {",
    'const at = Date.parse(c.createdAt), requestedAt = Date.parse(item.at);',
    `const release = ${RELEASE_SENTENCE}.exec(text);`,
    'if (Number.isFinite(at) && Number.isFinite(requestedAt) && at > requestedAt',
    '&& head && (!item.head || differentHead(item.head, head))) return true;',
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
