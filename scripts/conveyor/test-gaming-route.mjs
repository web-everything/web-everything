/**
 * Route a head-proven test-gaming-only hold through the existing advisory fixer.
 * The advisory comment is the per-head ledger and binding fixer input. No gate is
 * rerun or cleared; review:human preserves operator ownership of the final ruling.
 * Existing reconcile liveness/dispatch claims and advisory round caps still apply.
 */
import { ADVISORY_NOTE_MARKER } from './advisory-round-count.mjs';
import { latestFailingMergeGate, readMergeGateVerdict } from '../lib/merge-gate-hold-class.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { resolveReviewSettings } from '../lib/review-settings.mjs';
import { appendLines, feedPath, diffFeed } from '../operations/needs-you-feed.mjs';

const routeMarker = head => `<!-- test-gaming-route: ${head} -->`;
const noticeMarker = head => `<!-- test-gaming-needs-you: ${head} -->`;
const trusted = c => isTrustedMarkerAuthor(c) && typeof c?.body === 'string';
const labelsOf = pr => (pr.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
const live = pr => pr?.state === 'OPEN' && /^[a-f0-9]{40}$/.test(pr.headRefOid ?? '');

/** Pure decision. Unknown/mixed/stale evidence never admits a repair finding. */
export function planTestGamingRoute({ pr, verdict, enabled = true } = {}) {
  const skip = why => ({ action: 'skip', why });
  if (!enabled || !live(pr)) return skip('disabled or inactive PR');
  if (verdict?.error || verdict?.num !== pr.number || verdict.head_sha !== pr.headRefOid
    || verdict.ok !== false || !Array.isArray(verdict.results) || !verdict.results.length) return skip('unproven head or verdict');
  const blocked = verdict.results.filter(r => !['pass', 'queue', 'enqueue', 'skipped-by-policy'].includes(r?.status));
  if (blocked.length !== 1 || blocked[0].id !== 'test-gaming' || blocked[0].status !== 'hold') return skip('not a test-gaming-only hold');
  const comments = pr.comments ?? [];
  const routes = comments.flatMap((c, i) => trusted(c) && c.body.startsWith(ADVISORY_NOTE_MARKER)
    && /<!-- test-gaming-route: [a-f0-9]{40} -->/.test(c.body) ? [{ c, i }] : []);
  const latest = routes.at(-1);
  // A completed turn may have pushed a new head. Bind its returned justification
  // to this route episode and (when present) the live short/full fix-end head.
  const ended = latest && comments.slice(latest.i + 1).filter(c => trusted(c)
    && c.body.startsWith('🔓 conveyor fix-end') && !c.body.includes('<!-- fix-end-outcome: blocked-on-infra -->')
    && (!/ at `([a-f0-9]{7,40})`/.test(c.body)
      || pr.headRefOid.startsWith(/ at `([a-f0-9]{7,40})`/.exec(c.body)[1]))).at(-1);
  const justification = ended && /^test-removal-justified:[ \t]*(\S[^\r\n]*)$/m.exec(ended.body)?.[1];
  if (justification) return { action: 'needs-you', reason: `test-removal-justified: ${justification}`,
    marker: noticeMarker(pr.headRefOid), notified: comments.some(c => trusted(c) && c.body.includes(noticeMarker(pr.headRefOid))) };
  const existing = routes.find(r => r.c.body.includes(routeMarker(pr.headRefOid)));
  if (existing) return { action: ended ? 'completed' : 'admitted', body: existing.c.body };
  // Only the net-removal subtype supplies the binding removal count and paths.
  // Other test-gaming signals remain held for the ordinary review path.
  const reason = String(blocked[0].reason ?? '');
  const removals = [...reason.matchAll(/tests-removed: ([^\s<>`]+) \(net ([1-9]\d*) test case\(s\) removed\)/g)];
  if (!removals.length || removals.some(m => m[1].startsWith('/') || m[1].split('/').includes('..') || !Number.isSafeInteger(Number(m[2])))) return skip('no usable test-removal evidence');
  const count = removals.reduce((n, m) => n + Number(m[2]), 0);
  if (!Number.isSafeInteger(count)) return skip('invalid removal count');
  const files = [...new Set(removals.map(m => m[1]))].join(', ');
  const binding = `The merge gate flags a net removal of ${count} test case(s) in ${files}. Restore the removed test(s), or replace each with an equivalent test that still covers the same guarantee. If the removal is genuinely correct (the behaviour itself was removed), keep it, and state why in a \`test-removal-justified:\` line in the fix-end note.`;
  return { action: 'admit', binding, body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Changes requested\n\n**Advisory outcome:** \`changes\`\n\nAdmitted finding: ${binding}\n\n${routeMarker(pr.headRefOid)}\n\n---\n\nNet basis: \`${'0'.repeat(40)}..${pr.headRefOid}\`` };
}

function notifyNeedsYou(item) {
  appendLines(feedPath(), diffFeed([], [{ ...item, kind: 'ruling-needed' }], Date.now()).lines);
}

/** Injectable synchronous IO shell; dryRun reads actual evidence but never writes. */
export function routeTestGaming(pr, { repo, provider = createGhProvider(), readVerdict = readMergeGateVerdict,
  readComments = readCompletePrComments, notify = notifyNeedsYou, enabled = resolveReviewSettings().routeTestGamingToFixer,
  dryRun = false } = {}) {
  if (!enabled || !live(pr)) return { action: 'skip', why: 'disabled or inactive PR' };
  const row = latestFailingMergeGate(pr.statusCheckRollup);
  if (!row) return { action: 'skip', why: 'no failing merge-gate' };
  const jobId = Number(/\/job\/(\d+)/.exec(row.detailsUrl ?? row.details_url ?? '')?.[1] ?? row.id);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) return { action: 'skip', why: 'no job identity' };
  const verdict = readVerdict({ repo, jobId, prNumber: pr.number });
  const preliminary = planTestGamingRoute({ pr, verdict, enabled });
  if (preliminary.action === 'skip') return preliminary;
  // Always read a complete thread: the durable ledger may be beyond the list page.
  const state = provider.readPrState(repo, pr.number);
  if (!live(state) || state.headRefOid !== pr.headRefOid) return { action: 'skip', why: 'head moved or PR inactive' };
  const comments = readComments(pr.number, { repo });
  if (!Array.isArray(comments)) throw new Error('test-gaming route: incomplete comment read');
  const fresh = provider.readPrState(repo, pr.number);
  if (!live(fresh) || fresh.headRefOid !== pr.headRefOid) return { action: 'skip', why: 'head moved before write' };
  const current = { ...pr, ...fresh, number: pr.number, comments };
  const plan = planTestGamingRoute({ pr: current, verdict, enabled });
  if (dryRun || plan.action === 'skip') return plan;
  const labels = labelsOf(current);
  if (plan.action === 'admit') provider.postComment(repo, pr.number, plan.body);
  if (plan.action === 'needs-you') {
    if (!plan.notified) {
      notify({ repo, pr: pr.number, head: pr.headRefOid, reason: plan.reason });
      provider.postComment(repo, pr.number, `Test removal needs your ruling. ${plan.reason}\n\nThe merge-gate hold remains in force.\n\n${plan.marker}`);
    }
  }
  // Complete only our own finding episode; never remove a newer panel's label.
  const latestNote = comments.filter(c => isTrustedMarkerAuthor(c)
    && typeof c?.body === 'string' && c.body.startsWith(ADVISORY_NOTE_MARKER)).at(-1);
  const ownsNote = plan.action === 'admit' || latestNote?.body === plan.body
    || (plan.action === 'needs-you' && /<!-- test-gaming-route: [a-f0-9]{40} -->/.test(latestNote?.body ?? ''));
  if (!ownsNote) return plan;
  const active = ['admit', 'admitted'].includes(plan.action);
  // The existing advisory fixer requires needs-human. Never impersonate a human
  // send-back or weaken marker authorship to get there.
  const desired = ['review:human', ...(active ? ['advisory:changes'] : [])];
  const remove = ['review:pending', 'advisory:accepted', ...(!active ? ['advisory:changes'] : [])].filter(l => labels.includes(l));
  for (const label of desired) if (!labels.includes(label)) provider.setLabels(repo, pr.number, { add: label });
  if (remove.length) provider.setLabels(repo, pr.number, { remove });
  return { ...plan, snapshot: { ...pr, ...provider.readPrState(repo, pr.number), comments: readComments(pr.number, { repo }) } };
}

/** One bad PR never suppresses the rest of the daemon tick. */
export function sweepTestGamingRoutes({ prs = [], repo, log = line => console.error(line), ...options } = {}) {
  const results = [];
  for (const pr of (Array.isArray(prs) ? prs : [])) {
    try { const result = routeTestGaming(pr, { repo, ...options }); if (result.action !== 'skip') results.push({ pr: pr.number, ...result }); }
    catch (e) { log(`test-gaming-route: ${repo}#${pr.number}: ${String(e.message ?? e).split('\n')[0]}`); }
  }
  return results;
}
