/** Live #7230 and five more: a review:human PR whose head moved mechanically never got a fresh advisory. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/conveyor/reconcile-core.mjs', 'scripts/operations/operator-why.mjs'];
const OLD = 'a'.repeat(40), HEAD = 'b'.repeat(40);

export default {
  id: 'advisory-rerun-head-move',
  title: 'a review:human PR whose head moved by a main merge owes one advisory on the live head',
  card: 'live #7230 stale advisory after a mechanical head move',
  fixedBy: { sha: 'HEAD', where: 'lane/advisory-rerun-head-move', paths: PATHS },
  fixPresent(root) {
    try { return /export\s+function\s+advisoryHeadMoveState\s*\(/.test(readFileSync(join(root, PATHS[0]), 'utf8')); }
    catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, PATHS[0])).href);
    const { ADVISORY_NOTE_MARKER } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/advisory-round-count.mjs')).href);
    const violations = [];
    const author = { login: 'web-everything' };
    const advisory = head => ({ author, createdAt: '2026-11-20T10:00:00Z',
      body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** accept\n\nok\n\n---\n\nNet basis: \`${'c'.repeat(40)}..${head}\` — 1 net changed file(s) vs current main` });
    const commit = (oid, messageHeadline) => ({ oid, messageHeadline, messageBody: '', authors: [{ login: 'someone' }] });
    const plan = (head, tip, extra = {}, options = {}) => planReconcile({
      prs: [{ number: 7230, state: 'OPEN', headRefName: 'lane/x', headRefOid: HEAD, labels: [{ name: 'review:human' }],
        mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
        commits: [commit(OLD, 'fix: it'), commit(HEAD, tip)], comments: [advisory(head)], ...extra }],
      agents: [], requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' }, now: Date.parse('2026-11-20T12:00:00Z'),
      advisoryReviewOnHumanHandoff: 'on', ...options,
    });
    const rows = (head, tip) => plan(head, tip).dispatch.filter(d => d.kind === 'review' && d.advisoryReview?.reason === 'head-moved-advisory');
    const owed = rows(OLD, "Merge branch 'main' into lane/x");
    if (owed.length !== 1 || owed[0].advisoryReview.head !== HEAD) violations.push(`stale advisory after a main merge: ${owed.length} advisory rows, expected 1 on the live head`);
    log?.(`stale advisory after main merge: rows=${owed.length}\n`);
    const covered = rows(HEAD, "Merge branch 'main' into lane/x");
    if (covered.length) violations.push('advisory already covering the head still got a row');
    const authored = rows(OLD, 'fix: another change');
    if (authored.length) violations.push('a non-merge author commit got a head-moved advisory row');
    // PR #7263 review: unreadable history may stop reviews, never the CI repair or operator send-back.
    const tip = "Merge branch 'main' into lane/x";
    const unreadable = { author, createdAt: '2026-11-20T10:00:00Z', body: `${ADVISORY_NOTE_MARKER}\n\nno basis` };
    const red = [{ name: 'gate', status: 'completed', conclusion: 'failure' }];
    const heal = plan(OLD, tip, { comments: [unreadable], statusCheckRollup: red });
    if (heal.dispatch.length !== 1 || heal.dispatch[0].kind !== 'ci-heal') violations.push('unreadable advisory suppressed red-CI heal');
    const request = { id: 'operator-send-back', author: { login: 'chalbert' }, createdAt: '2026-11-20T11:00:00Z',
      body: '🔁 review — changes requested\n\nRecorded by chalbert via console.\n\nMUST FIX: repair the export.' };
    const sendBack = plan(OLD, tip, { comments: [unreadable, request], statusCheckRollup: red });
    if (sendBack.dispatch.length !== 1 || sendBack.dispatch[0].mode !== 'operator-send-back') violations.push('unreadable advisory suppressed operator send-back');
    const { buildReviewedShaMarker } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-escalation.mjs')).href);
    const coveredState = plan(OLD, tip, { comments: [unreadable, { author,
      body: `✅ review — accepted\n${buildReviewedShaMarker(HEAD)}` }] });
    if (coveredState.refusals.some(r => r.kind === 'advisory-unreadable')) violations.push('covered head reported unreadable history');
    const disabled = plan(OLD, tip, {}, { advisoryReviewOnHumanHandoff: 'off' });
    if (disabled.dispatch.some(d => d.advisoryReview?.reason === 'head-moved-advisory')) violations.push('disabled advisory setting was bypassed');
    log?.(`unreadable history: heal=${heal.dispatch[0]?.kind}, send-back=${sendBack.dispatch[0]?.mode}; disabled rows=${disabled.dispatch.length}\n`);
    return { violations };
  },
  judge: report => report.violations,
};
