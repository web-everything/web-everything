/**
 * STANDDOWN-EMPTY-ROUND (we#7448/#7451). A PR whose only red is the stale `review:changes` hold deadlocked: the fixer
 * found nothing to change and stood down, rearm-review refuses an unchanged head, and the stand-down needs a human.
 * Ruling (review.loop.exit.STANDDOWN-EMPTY-ROUND, handling.autoRearmIsRecover): a daemon MAY request ONE fresh review
 * of the same head. That is recover-class: the request is a SEPARATE record (auto-rearm-request.mjs), never an operator
 * answer; only the reviewer-dispatch planner consumes it; it resolves nothing and reaches no fixer.
 *
 * Qualification (structured signals only, no prose matching):
 *   - review:changes, a complete label list, no red-team:blocked / red-team:pending, no review:human;
 *   - the latest changes-requested verdict carries no reviewer finding, only the merge-gate failure
 *     (isGateOnlyChangesVerdict); a fixer note ("fix still owed") or stand-down detail is never a qualifier;
 *   - an unresolved trusted head-bound needs-judgment stand-down after a fix-begin, head unchanged since fix-begin
 *     (decideEmptyFixRound);
 *   - the roster is policy-fresh (live/cache); every required check except merge-gate is SUCCESS on the exact head;
 *   - merge-gate is bound to the CURRENT check run: the latest FAILURE run's job id equals the rollup row's job id
 *     and the verdict that job logged; that verdict's ONLY blocking hold is the plain review hold;
 *   - once per head (reservation keyed by head, plus a prior request for the head refuses).
 * Every re-read (head, labels, comments, roster, bindings, rollup) happens AFTER the final check read and immediately
 * before the sole post; any change vetoes.
 */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { readRequiredCheckBindings } from '../lib/merge-queue-enqueue.mjs';
import { latestFailingMergeGate, readMergeGateVerdict } from '../lib/merge-gate-hold-class.mjs';
import { getRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { autoProceedStandDowns, latestRequiredRuns } from './stand-down-auto-proceed.mjs';
import { readAutoProceedChecks, reserveAutoProceed } from './stand-down-auto-proceed-io.mjs';
import { decideEmptyFixRound } from './rearm-review.mjs';
import { buildAutoRearmRequest, parseAutoRearmRequest, hasAutoRearmRequestForHead, isGateOnlyChangesVerdict } from './auto-rearm-request.mjs';

const hold = why => ({ action: 'hold', why });
const HOLD_CHECK = 'merge-gate';
const FRESH_ROSTERS = ['live', 'cache'];
const TRAILER = /<!--\s*stand-down reason=needs-judgment(?: head=([0-9a-f]{7,40}))?(?: findings=[A-Za-z0-9_-]+)?\s*-->\s*$/i;
const FIX_BEGIN = '🔒 conveyor fix-begin — fix claim held';
const trusted = c => isTrustedMarkerAuthor({ ...c, viewerDidAuthor: false });
const jobIdOf = url => Number(/\/actions\/runs\/\d+\/job\/(\d+)$/.exec(String(url ?? ''))?.[1] ?? 0);

/** Complete, well-formed label names or null (a malformed entry never reads as "no red-team label"). */
function labelNames(pr) {
  if (!Array.isArray(pr?.labels)) return null;
  const names = pr.labels.map(l => (typeof l === 'string' ? l : l?.name));
  return names.every(n => typeof n === 'string' && n) ? names : null;
}

/**
 * Read the merge-gate verdict for the CURRENT failing rollup row. {jobId, verdict} or null. The caller's classifier
 * re-checks that jobId equals the check-run evidence's job.
 */
export function readCurrentGateVerdict(pr, { repo, readVerdict = readMergeGateVerdict } = {}) {
  try {
    const row = latestFailingMergeGate(pr.statusCheckRollup);
    const jobId = jobIdOf(row?.detailsUrl ?? row?.details_url);
    if (!jobId) return null;
    return { jobId, verdict: readVerdict({ repo, jobId, prNumber: pr.number }) };
  } catch { return null; }
}

/** The verdict's only blocking hold must be the plain review hold (never test-gaming, workflow, freeze, human review). */
function onlyPlainReviewHold(v, { head, number }) {
  if (!v || v.error || v.num !== number || String(v.head_sha ?? '').toLowerCase() !== head || v.ok !== false || !Array.isArray(v.results)) return false;
  const blocking = v.results.filter(r => r?.status === 'hold' || r?.status === 'fail-closed');
  // Review-owned holds only: the plain label hold, or the human-only workflow-touch acceptance hold. Any other blocking
  // result (test-gaming, freeze, red-team, a code check) disqualifies, so a human-review hold WITH other findings never passes.
  const reviewOwned = r => r.status === 'hold' && (r.id === 'review-hold-labels' && !/review:human/.test(String(r.reason ?? ''))
    || (r.id === 'review-acceptance' && /^human-only: the diff at [0-9a-f]{9} touches \.github\/(?:workflows|actions)\//.test(String(r.reason ?? ''))));
  return blocking.length > 0 && blocking.every(reviewOwned);
}

/** PURE. Returns {action:'request-review', standDownId, body} or {action:'hold', why}. */
export function classifyNoCodeOwedRearm({ pr, requiredChecks, requiredCheckBindings, checks, rosterSource, gate } = {}) {
  const live = String(pr?.headRefOid ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(live) || !Array.isArray(pr?.comments)) return hold('missing head/thread');
  if (pr.comments.length > 2000) return hold('thread exceeds 2000 comments');
  if (!FRESH_ROSTERS.includes(rosterSource)) return hold('required-check roster is not policy-fresh');
  const labels = labelNames(pr);
  if (!labels) return hold('label list incomplete or malformed');
  if (!labels.includes('review:changes')) return hold('no review:changes hold');
  if (['red-team:blocked', 'red-team:pending', 'review:human'].some(l => labels.includes(l))) return hold('a judgment or human-review hold also stands');
  if (!isGateOnlyChangesVerdict(pr.comments)) return hold('the latest changes verdict carries a reviewer finding (not only the merge-gate failure)');
  const pending = autoProceedStandDowns(pr);
  if (!pending.length || pending.some(c => !/^[\w=-]+$/.test(String(c.id ?? '')) || !trusted(c))) return hold('no trusted unresolved stand-down with an identity');
  const target = pending.at(-1);
  const trailer = String(target.body ?? '').match(TRAILER);
  if (pending.some(c => !TRAILER.test(String(c.body ?? ''))) || (trailer?.[1] && !live.startsWith(trailer[1].toLowerCase()))) return hold('unresolved stand-down is not a head-bound needs-judgment');
  const ids = pr.comments.map(c => String(c?.id ?? ''));
  const standAt = ids.lastIndexOf(String(target.id));
  const beginAt = pr.comments.reduce((at, c, i) => (typeof c?.body === 'string' && c.body.startsWith(FIX_BEGIN) && trusted(c) ? i : at), -1);
  if (beginAt < 0 || standAt < beginAt) return hold('no stand-down after the latest fix-begin');
  if (hasAutoRearmRequestForHead(pr.comments, live)) return hold('already re-reviewed once on this head');
  if (decideEmptyFixRound({ comments: pr.comments, liveHead: live }).empty !== true) return hold('code may be owed (head moved or no empty round)');
  const need = (requiredChecks ?? []).filter(n => n !== HOLD_CHECK);
  if (!need.length || !(requiredChecks ?? []).includes(HOLD_CHECK)) return hold('required roster lacks merge-gate or any code check');
  const evidence = latestRequiredRuns({ head: live, requiredChecks, requiredCheckBindings, checks });
  if (evidence.hold) return hold(evidence.hold.why);
  const gateRun = evidence.latest.find(r => r.name === HOLD_CHECK);
  if (evidence.latest.some(r => r.name !== HOLD_CHECK && String(r.conclusion).toUpperCase() !== 'SUCCESS')) return hold('a required check is not green on this head');
  if (!gateRun || String(gateRun.conclusion).toUpperCase() !== 'FAILURE') return hold('merge-gate is not a completed failure on this head');
  const runJob = jobIdOf(gateRun.details_url);
  if (!runJob || !gate || gate.jobId !== runJob) return hold('merge-gate verdict is not bound to the current check run');
  if (!onlyPlainReviewHold(gate.verdict, { head: live, number: pr.number })) return hold('merge-gate red is not only the plain review hold');
  const reason = `Head ${live.slice(0, 7)}. The latest changes verdict carries only the merge-gate failure, every other required check is green on this exact head, and merge-gate's only red is the plain review hold. One fresh review of the unchanged head is requested; the reviewer's verdict decides. A second request on this head is refused.`;
  return { action: 'request-review', standDownId: String(target.id), body: buildAutoRearmRequest({ standDownId: String(target.id), head: live, reason }) };
}

const gh = (args, options = {}) => JSON.parse(execFileSyncThrottled('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...options }));
const readPrState = ({ repo, number }) => gh(['pr', 'view', String(number), '--repo', repo, '--json', 'headRefOid,labels,statusCheckRollup']);

/** Everything the post depends on, minus the checks; compared before and after the final re-read. */
const signature = ({ state, comments, roster, bindings }) => JSON.stringify({
  head: state.headRefOid, labels: (state.labels ?? []).map(l => (typeof l === 'string' ? l : l?.name)).sort(),
  rollup: (state.statusCheckRollup ?? []).map(r => [r?.name, r?.status, r?.conclusion, r?.detailsUrl ?? r?.details_url]),
  comments: comments.map(c => [c?.id, String(c?.body ?? '').length]), roster: [roster.source, [...roster.checks].sort()],
  bindings: (bindings ?? []).map(b => [b.context, b.integration_id]).sort(),
});

/** At most two candidates per tick; all IO injectable; no retry after the write starts. */
export function enrichPrsWithNoCodeOwedRearm(prs, { repo, defaultBranch = 'main', readBindings = readRequiredCheckBindings,
  readComments = (number, o) => readCompletePrComments(number, o), readState = readPrState,
  readRoster = () => getRequiredStatusChecks({ repo, branch: defaultBranch }),
  readChecks = readAutoProceedChecks, readVerdict = readMergeGateVerdict, reserve = reserveAutoProceed, env = process.env,
  post = ({ repo: r, number, body }) => gh(['api', `repos/${r}/issues/${number}/comments`, '--method', 'POST', '--input', '-'], { input: JSON.stringify({ body }) }),
  log = line => console.error(line) } = {}) {
  const cheap = pr => labelNames(pr)?.includes('review:changes') && autoProceedStandDowns(pr).length > 0;
  let budget = 2;
  return prs.map(pr => {
    if (!cheap(pr) || budget <= 0) return pr;
    budget -= 1;
    let fresh = pr; // keep the latest complete thread even when a later step refuses or fails
    try {
      const snap = () => {
        const state = readState({ repo, number: pr.number });
        if (state.headRefOid !== pr.headRefOid) throw new Error('head moved; hold retained');
        const comments = readComments(pr.number, { repo });
        const roster = readRoster();
        const bindings = readBindings();
        return { state, comments, roster, bindings };
      };
      const judge = (s, checks, source = s.roster.source) => {
        const now = { ...pr, labels: s.state.labels, statusCheckRollup: s.state.statusCheckRollup, comments: s.comments };
        fresh = now;
        const gate = readCurrentGateVerdict(now, { repo, readVerdict });
        return classifyNoCodeOwedRearm({ pr: now, requiredChecks: s.roster.checks, requiredCheckBindings: s.bindings, checks, rosterSource: source, gate });
      };
      // Phase 1: read everything, the check evidence LAST.
      const first = snap();
      const checks = readChecks({ repo, head: pr.headRefOid, requiredChecks: first.roster.checks, requiredCheckBindings: first.bindings });
      const decision = judge(first, checks);
      if (decision.action !== 'request-review') { log(`no-code-owed PR #${pr.number}: ${decision.why}`); return fresh; }
      // Phase 2: re-read head, labels, rollup, comments, roster and bindings AFTER the final check read.
      const last = snap();
      const again = judge(last, checks);
      if (signature(first) !== signature(last) || again.action !== 'request-review' || again.standDownId !== decision.standDownId) {
        log(`no-code-owed PR #${pr.number}: state changed before post; hold retained`); return fresh;
      }
      // Keyed by HEAD (not stand-down id): a second stand-down on the same head can never earn a second request.
      if (!reserve({ repo, number: pr.number, standDownId: `auto-rearm-head-${pr.headRefOid}`, env })) { log(`no-code-owed PR #${pr.number}: already reserved for this head`); return fresh; }
      const posted = post({ repo, number: pr.number, body: again.body });
      const comment = { ...posted, author: posted?.author ?? posted?.user };
      if (comment.body !== again.body || !parseAutoRearmRequest(comment)) throw new Error('posted record unverified; inspect thread');
      return { ...fresh, comments: [...fresh.comments, comment] };
    } catch (e) {
      log(`no-code-owed PR #${pr.number}: operator answer required: ${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)}`);
      return fresh;
    }
  });
}
