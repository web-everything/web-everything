/**
 * STANDDOWN-EMPTY-ROUND (we#7448/#7451). A fixer that found nothing to change and stood down on a PR whose only red is
 * the stale `review:changes` hold deadlocked: rearm-review refuses an unchanged head (#6713 empty-round guard) and the
 * stand-down needs a human. Ruling (SHIP-WM-139): a daemon MAY request ONE fresh review of an unchanged head. That is a
 * recover-class action: it asks the reviewer for a new verdict, it never clears a hold, approves or waives. So the
 * record posted here is the distinct `auto-rearm` disposition (actor `auto-rearm`), NOT an operator `--no-code-owed`
 * ruling, and the reviewer's new verdict decides.
 *
 * Preconditions (all structural, no prose matching):
 *   - review:changes on the PR, a complete label list, no red-team:blocked / red-team:pending;
 *   - a structured no-change record: a trusted `⚠️ conveyor fix — no change made` note (built by
 *     rearm-review.mjs#buildNoChangeComment, the guard's own refusal of a re-arm attempt, by the fixer or a relayed
 *     operator attempt) naming the live head, posted after the latest fix-begin; free prose never counts;
 *   - rearm-review's own `decideEmptyFixRound` proves the head is unchanged since fix-begin;
 *   - every required check except merge-gate passes the shared R123 exact-head evidence validation and is SUCCESS;
 *   - merge-gate's only red is the review hold itself, re-derived from its own head-bound job verdict;
 *   - once per head: the rearm window caps one auto-rearm per verdict, and a prior record for this head refuses.
 * The writer re-reads head, labels, merge-gate rows, comments and checks right before the sole post.
 */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { readRequiredCheckBindings } from '../lib/merge-queue-enqueue.mjs';
import { excuseMergeGateRows, readMergeGateVerdict } from '../lib/merge-gate-hold-class.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { buildOperatorAnswer, parseOperatorAnswer, isAutoRearmAnswer } from './stand-down-answer-core.mjs';
import { autoProceedStandDowns, latestRequiredRuns } from './stand-down-auto-proceed.mjs';
import { readAutoProceedChecks, reserveAutoProceed } from './stand-down-auto-proceed-io.mjs';
import { decideEmptyFixRound, rearmWindow, NO_CHANGE_COMMENT_MARKER } from './rearm-review.mjs';

const hold = why => ({ action: 'hold', why });
const HOLD_CHECK = 'merge-gate';
const TRAILER = /<!--\s*stand-down reason=needs-judgment(?: head=([0-9a-f]{7,40}))?(?: findings=[A-Za-z0-9_-]+)?\s*-->\s*$/i;
const NO_CHANGE_RE = new RegExp(`^${NO_CHANGE_COMMENT_MARKER}\\n\\n[^\\n\`]{1,200} asked to re-arm review, but the PR head is still \`([0-9a-f]{7,40})\``);
const FIX_BEGIN = '🔒 conveyor fix-begin — fix claim held';
const trusted = c => isTrustedMarkerAuthor({ ...c, viewerDidAuthor: false });

/** Complete, well-formed label names or null (a malformed entry never reads as "no red-team label"). */
function labelNames(pr) {
  if (!Array.isArray(pr?.labels)) return null;
  const names = pr.labels.map(l => (typeof l === 'string' ? l : l?.name));
  return names.every(n => typeof n === 'string' && n) ? names : null;
}

/** Re-derive that merge-gate's ONLY red is the review hold (head-bound job verdict). Null when not proven. */
export function mergeGateOnlyReviewHold(pr, { repo, readVerdict = readMergeGateVerdict } = {}) {
  try {
    const out = excuseMergeGateRows(pr.statusCheckRollup, { prNumber: pr.number, headSha: pr.headRefOid, labels: pr.labels,
      readVerdict: ({ jobId, prNumber }) => readVerdict({ repo, jobId, prNumber }), freeze: () => undefined, setting: 'on' });
    // Only review-class holds: the review-hold annotation, or an excusal whose kind is plain candidacy (never a freeze).
    const excusedKind = out.rows?.find(r => r?.mergeGateHoldExcused)?.mergeGateHoldExcused?.kind;
    return out.reviewHold === true || (out.excused === true && excusedKind === 'candidacy') ? out : null;
  } catch { return null; }
}

/** PURE. Returns {action:'auto-rearm', standDownId, body} or {action:'hold', why}. `mergeGateReviewOnly` is the proof. */
export function classifyNoCodeOwedRearm({ pr, requiredChecks, requiredCheckBindings, checks, mergeGateReviewOnly } = {}) {
  const live = String(pr?.headRefOid ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(live) || !Array.isArray(pr?.comments)) return hold('missing head/thread');
  if (pr.comments.length > 2000) return hold('thread exceeds 2000 comments');
  const labels = labelNames(pr);
  if (!labels) return hold('label list incomplete or malformed');
  if (!labels.includes('review:changes')) return hold('no review:changes hold');
  if (labels.includes('red-team:blocked') || labels.includes('red-team:pending')) return hold('red-team verdict owes a fix');
  const pending = autoProceedStandDowns(pr);
  if (!pending.length || pending.some(c => !/^[\w=-]+$/.test(String(c.id ?? '')) || !trusted(c))) return hold('no trusted unresolved stand-down with an identity');
  const target = pending.at(-1);
  const trailer = String(target.body ?? '').match(TRAILER);
  if (pending.some(c => !TRAILER.test(String(c.body ?? ''))) || (trailer?.[1] && !live.startsWith(trailer[1].toLowerCase()))) return hold('unresolved stand-down is not a head-bound needs-judgment');
  // The fixer's structured no-change record, between the latest fix-begin and the stand-down.
  const ids = pr.comments.map(c => String(c?.id ?? ''));
  const standAt = ids.lastIndexOf(String(target.id));
  const beginAt = pr.comments.reduce((at, c, i) => (typeof c?.body === 'string' && c.body.startsWith(FIX_BEGIN) && trusted(c) ? i : at), -1);
  const noteAt = pr.comments.findIndex((c, i) => i > beginAt && trusted(c)
    && (m => m && live.startsWith(m[1].toLowerCase()))(String(c.body ?? '').match(NO_CHANGE_RE)));
  if (beginAt < 0 || standAt < 0 || noteAt < 0) return hold('no trusted no-change record after the latest fix-begin');
  const tag = `Head ${live.slice(0, 7)}.`;
  if (pr.comments.some(c => isAutoRearmAnswer(parseOperatorAnswer(c)) && String(parseOperatorAnswer(c).reason).includes(tag))) return hold('already re-reviewed once on this head');
  if (decideEmptyFixRound({ comments: pr.comments, liveHead: live }).empty !== true) return hold('code may be owed (head moved or no empty round)');
  if (!rearmWindow(pr.comments).wouldHonour({ standDownId: String(target.id), disposition: 'auto-rearm', actor: 'auto-rearm' })) return hold('rearm guard would ignore the request');
  const need = (requiredChecks ?? []).filter(n => n !== HOLD_CHECK);
  if (!need.length) return hold('no required checks to prove green');
  const evidence = latestRequiredRuns({ head: live, requiredChecks: need, requiredCheckBindings, checks });
  if (evidence.hold) return hold(evidence.hold.why);
  if (evidence.latest.some(r => String(r.conclusion).toUpperCase() !== 'SUCCESS')) return hold('a required check is not green on this head');
  if (!mergeGateReviewOnly) return hold('merge-gate red is not proven to be only the review hold');
  const reason = `AUTO-REARM no-code-owed. ${tag} The fixer recorded no change on this head and stood down; every required check except ${HOLD_CHECK} is green on this exact head, no red-team verdict stands, and ${HOLD_CHECK}'s only red is the review hold. This requests ONE fresh review of the unchanged head; the reviewer's new verdict decides. A second request on this head is refused.`;
  const body = buildOperatorAnswer({ standDownId: String(target.id), actor: 'auto-rearm', channel: 'auto (no code owed)', reason, disposition: 'auto-rearm' });
  return { action: 'auto-rearm', standDownId: String(target.id), body };
}

const gh = (args, options = {}) => JSON.parse(execFileSyncThrottled('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...options }));
const readPrState = ({ repo, number }) => gh(['pr', 'view', String(number), '--repo', repo, '--json', 'headRefOid,labels,statusCheckRollup']);
const COMMENT_WRITE = 'comments';

/** At most two candidates per tick; all IO injectable; no retry after the write starts. */
export function enrichPrsWithNoCodeOwedRearm(prs, { repo, requiredChecks, readBindings = readRequiredCheckBindings,
  readComments = (number, o) => readCompletePrComments(number, o), readState = readPrState,
  readChecks = readAutoProceedChecks, readVerdict = readMergeGateVerdict, reserve = reserveAutoProceed, env = process.env,
  post = ({ repo: r, number, body }) => gh(['api', `repos/${r}/issues/${number}/${COMMENT_WRITE}`, '--method', 'POST', '--input', '-'], { input: JSON.stringify({ body }) }),
  log = line => console.error(line) } = {}) {
  const cheap = pr => labelNames(pr)?.includes('review:changes') && autoProceedStandDowns(pr).length > 0;
  let budget = 2;
  return prs.map(pr => {
    if (!cheap(pr) || budget <= 0) return pr;
    budget -= 1;
    let fresh = pr; // keep the latest complete thread even when a later step refuses or fails
    try {
      const requiredCheckBindings = readBindings();
      // One full evaluation from freshly read state; run twice around the check reads so a rerun, a new label,
      // a new stand-down/answer or a moved head vetoes the sole post.
      const evaluate = () => {
        const state = readState({ repo, number: pr.number });
        if (state.headRefOid !== pr.headRefOid) throw new Error('head moved; hold retained');
        const now = { ...pr, labels: state.labels, statusCheckRollup: state.statusCheckRollup, comments: readComments(pr.number, { repo }) };
        fresh = now;
        const checks = readChecks({ repo, head: pr.headRefOid, requiredChecks, requiredCheckBindings });
        const mergeGateReviewOnly = mergeGateOnlyReviewHold(now, { repo, readVerdict }) !== null;
        return classifyNoCodeOwedRearm({ pr: now, requiredChecks, requiredCheckBindings, checks, mergeGateReviewOnly });
      };
      const first = evaluate();
      if (first.action !== 'auto-rearm') { log(`no-code-owed PR #${pr.number}: ${first.why}`); return fresh; }
      const last = evaluate();
      if (last.action !== 'auto-rearm' || last.standDownId !== first.standDownId) { log(`no-code-owed PR #${pr.number}: state changed before post; hold retained`); return fresh; }
      // Keyed by HEAD (not stand-down id): a second stand-down on the same head can never earn a second request.
      if (!reserve({ repo, number: pr.number, standDownId: `auto-rearm-head-${pr.headRefOid}`, env })) { log(`no-code-owed PR #${pr.number}: already reserved for this head`); return fresh; }
      const posted = post({ repo, number: pr.number, body: last.body });
      const comment = { ...posted, author: posted?.author ?? posted?.user };
      if (comment.body !== last.body || !isAutoRearmAnswer(parseOperatorAnswer(comment))) throw new Error('posted record unverified; inspect thread');
      return { ...fresh, comments: [...fresh.comments, comment] };
    } catch (e) {
      log(`no-code-owed PR #${pr.number}: operator answer required: ${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)}`);
      return fresh;
    }
  });
}
