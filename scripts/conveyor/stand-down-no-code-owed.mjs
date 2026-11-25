/**
 * STANDDOWN-EMPTY-ROUND (we#7448/#7451): a fixer that stood down with "no code defect to repair" on a PR whose only
 * red is the stale `review:changes` hold deadlocked: the fixer won't push, rearm-review refuses an unchanged head
 * (#6713 empty-round guard) and only a manual `stand-down-answer --disposition=rearm-review --no-code-owed` cleared it.
 * This is that same answer, posted mechanically, ONCE per head, and only when no code can be owed:
 *   - review:changes is on the PR; no red-team:blocked / red-team:pending;
 *   - the unresolved stand-down is a trusted `needs-judgment` one that says "no code defect";
 *   - the rearm guard's own `decideEmptyFixRound` proves the head is unchanged since fix-begin;
 *   - every required check except `merge-gate` (the hold itself) is SUCCESS on the exact head.
 * The answer is an ordinary strict operator answer (actor `auto-no-code-owed`); the review gates stay unchanged.
 */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { readRequiredCheckBindings } from '../lib/merge-queue-enqueue.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { buildOperatorAnswer, parseOperatorAnswer } from './stand-down-answer-core.mjs';
import { autoProceedStandDowns } from './stand-down-auto-proceed.mjs';
import { boundAutoProceedRuns } from './stand-down-auto-proceed.mjs';
import { readAutoProceedChecks, reserveAutoProceed } from './stand-down-auto-proceed-io.mjs';
import { decideEmptyFixRound, rearmWindow } from './rearm-review.mjs';

const hold = why => ({ action: 'hold', why });
const HOLD_CHECK = 'merge-gate';
const TRAILER = /<!--\s*stand-down reason=needs-judgment(?: head=([0-9a-f]{7,40}))?(?: findings=[A-Za-z0-9_-]+)?\s*-->\s*$/i;
const labelNames = pr => (Array.isArray(pr?.labels) ? pr.labels.map(l => (typeof l === 'string' ? l : l?.name)) : null);

/** PURE. Returns {action:'rearm-answer', standDownId, body} or {action:'hold', why}. */
export function classifyNoCodeOwedRearm({ pr, requiredChecks, requiredCheckBindings, checks } = {}) {
  const live = String(pr?.headRefOid ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(live) || !Array.isArray(pr?.comments)) return hold('missing head/thread');
  const labels = labelNames(pr);
  if (!labels || !labels.includes('review:changes')) return hold('no review:changes hold');
  if (labels.includes('red-team:blocked') || labels.includes('red-team:pending')) return hold('red-team verdict owes a fix');
  const pending = autoProceedStandDowns(pr);
  const target = pending.at(-1);
  if (!target || !/^[\w=-]+$/.test(String(target.id ?? ''))) return hold('no unresolved stand-down with an identity');
  if (!isTrustedMarkerAuthor({ ...target, viewerDidAuthor: false })) return hold('stand-down author not trusted');
  const trailer = String(target.body ?? '').match(TRAILER);
  if (!trailer || (trailer[1] && !live.startsWith(trailer[1].toLowerCase()))) return hold('stand-down is not a head-bound needs-judgment');
  if (!/\bno code defect\b/i.test(target.body)) return hold('stand-down does not say no code defect');
  const tag = `AUTO-REARM no-code-owed. Head ${live.slice(0, 7)}.`;
  if (pr.comments.some(c => typeof c?.body === 'string' && c.body.includes(tag) && parseOperatorAnswer(c))) return hold('already re-reviewed once on this head');
  if (decideEmptyFixRound({ comments: pr.comments, liveHead: live }).empty !== true) return hold('code may be owed (head moved or no empty round)');
  const win = rearmWindow(pr.comments);
  if (!win.wouldHonour({ standDownId: String(target.id), disposition: 'rearm-review', noCodeOwed: true })) return hold('rearm guard would ignore the answer');
  if (!Array.isArray(requiredChecks) || !requiredChecks.length || checks?.head !== live || checks?.complete !== true || !Array.isArray(checks.runs)) return hold('incomplete exact-head checks');
  const runs = boundAutoProceedRuns(checks.runs, requiredChecks, requiredCheckBindings);
  if (runs === null) return hold('unreadable required-check policy');
  const need = requiredChecks.filter(n => n !== HOLD_CHECK);
  if (!need.length) return hold('no required checks to prove green');
  for (const name of need) {
    const history = runs.filter(r => r.name === name);
    if (!history.length || history.some(r => r.head_sha !== live || String(r.status).toUpperCase() !== 'COMPLETED'
      || String(r.conclusion).toUpperCase() !== 'SUCCESS')) return hold(`required check ${name} is not green on this head`);
  }
  const reason = `${tag} The fixer stood down with no code defect; every required check except ${HOLD_CHECK} is green on this exact head and no red-team verdict stands, so the stale review verdict gets ONE re-review of the unchanged head. A second attempt on this head is refused.`;
  const body = buildOperatorAnswer({ standDownId: String(target.id), actor: 'auto-no-code-owed', channel: 'auto (no-code-owed)',
    reason, disposition: 'rearm-review', noCodeOwed: true });
  return { action: 'rearm-answer', standDownId: String(target.id), body };
}

const gh = (args, options = {}) => JSON.parse(execFileSyncThrottled('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...options }));
const liveHead = ({ repo, number }) => gh(['pr', 'view', String(number), '--repo', repo, '--json', 'headRefOid']).headRefOid;
const COMMENT_WRITE = 'comments';

/** At most two candidates per tick; all IO injectable; no retry after a write starts. */
export function enrichPrsWithNoCodeOwedRearm(prs, { repo, requiredChecks, readBindings = readRequiredCheckBindings,
  readComments = (number, o) => readCompletePrComments(number, o), readHead = liveHead,
  readChecks = readAutoProceedChecks, reserve = reserveAutoProceed, env = process.env,
  post = ({ repo: r, number, body }) => gh(['api', `repos/${r}/issues/${number}/${COMMENT_WRITE}`, '--method', 'POST', '--input', '-'], { input: JSON.stringify({ body }) }),
  log = line => console.error(line) } = {}) {
  const cheap = pr => labelNames(pr)?.includes('review:changes') && autoProceedStandDowns(pr).length > 0;
  let budget = 2;
  return prs.map(pr => {
    if (!cheap(pr) || budget <= 0) return pr;
    budget -= 1;
    try {
      const requiredCheckBindings = readBindings();
      const fresh = { ...pr, comments: readComments(pr.number, { repo }) };
      const checks = readChecks({ repo, head: pr.headRefOid, requiredChecks, requiredCheckBindings });
      const d = classifyNoCodeOwedRearm({ pr: fresh, requiredChecks, requiredCheckBindings, checks });
      if (d.action !== 'rearm-answer') { log(`no-code-owed PR #${pr.number}: ${d.why}`); return fresh; }
      if (readHead({ repo, number: pr.number }) !== pr.headRefOid) throw new Error('head moved; hold retained');
      if (!reserve({ repo, number: pr.number, standDownId: `nco-${d.standDownId}`, env })) { log(`no-code-owed PR #${pr.number}: already reserved`); return fresh; }
      const posted = post({ repo, number: pr.number, body: d.body });
      const comment = { ...posted, author: posted?.author ?? posted?.user };
      if (comment.body !== d.body || !parseOperatorAnswer(comment)) throw new Error('posted answer unverified; inspect thread');
      return { ...fresh, comments: [...fresh.comments, comment] };
    } catch (e) {
      log(`no-code-owed PR #${pr.number}: operator answer required: ${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)}`);
      return pr;
    }
  });
}
