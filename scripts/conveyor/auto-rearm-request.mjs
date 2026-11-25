/**
 * STANDDOWN-EMPTY-ROUND (we#7448/#7451), recover-class record. A SEPARATE comment type, never an operator answer:
 * it carries its own marker, so `parseOperatorAnswer` and every operator-answer reader ignore it. The ONLY consumer is
 * the reviewer-dispatch planner (reconcile-core.mjs): it plans ONE fresh review of the same head. It never resolves
 * the stand-down, never reaches fixers, never touches load-flake accounting, and never alters the unchanged-head
 * refusal that rearm-review.mjs applies to a rearm. Accepted only from an automation login (a human-posted copy is
 * ignored). Once per head: only the FIRST valid request naming a head counts, and a review verdict posted after it
 * consumes it.
 */
import { AUTOMATION_LOGINS, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { standDownComments } from './stand-down.mjs';

export const AUTO_REARM_REQUEST_MARKER = '<!-- conveyor-auto-rearm-request:v1 -->';
const RECORD_RE = /<!-- conveyor-auto-rearm-record:([A-Za-z0-9+/=]{1,2000}) -->\s*$/;
const VERDICT_HEADING_RE = /^\s*(?:🔁|✅)\s+(?:human\s+)?review\s+[—-]/i;
const CHANGES_HEADING_RE = /^\s*🔁\s+(?:human\s+)?review\s+[—-]\s+changes requested/i;
const GATE_FINDING = 'required check "merge-gate" FAILURE';
const login = c => String((c?.author ?? c?.user)?.login ?? '').toLowerCase();
const text = c => (typeof c === 'string' ? c : typeof c?.body === 'string' ? c.body : '');

/** The request comment body. `standDownId` names the stand-down it concerns; `head` the exact head to re-review. */
export function buildAutoRearmRequest({ standDownId, head, reason }) {
  if (!/^[\w=-]{1,200}$/.test(String(standDownId ?? '')) || !/^[0-9a-f]{40}$/.test(String(head ?? ''))) throw new Error('invalid auto-rearm request');
  const record = Buffer.from(JSON.stringify({ standDownId, head })).toString('base64');
  const why = String(reason ?? '').replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').replace(/\n+/g, ' ').slice(0, 1000);
  return `${AUTO_REARM_REQUEST_MARKER}\n## Fresh review requested (no code owed)\n\nPosted by the conveyor, NOT an operator ruling and NOT an answer to the stand-down. It asks the reviewer for ONE new verdict of the unchanged head \`${head.slice(0, 9)}\`. It clears no hold, resolves nothing, reaches no fixer and waives nothing.\n\n> ${why}\n\n<!-- conveyor-auto-rearm-record:${record} -->`;
}

/** {standDownId, head} for a well-formed request from an automation login, else null. */
export function parseAutoRearmRequest(comment) {
  const body = text(comment);
  if (!body.trimStart().startsWith(AUTO_REARM_REQUEST_MARKER)) return null;
  if (!AUTOMATION_LOGINS.includes(login(comment))) return null; // viewerDidAuthor / a human-posted copy never counts
  const m = RECORD_RE.exec(body);
  if (!m) return null;
  try {
    const r = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    return /^[\w=-]{1,200}$/.test(String(r?.standDownId)) && /^[0-9a-f]{40}$/.test(String(r?.head))
      ? { standDownId: String(r.standDownId), head: r.head } : null;
  } catch { return null; }
}

const trusted = c => isTrustedMarkerAuthor({ ...c, viewerDidAuthor: false });

/**
 * The one pending request for the live head, or null. Pending = the first valid request naming this head, posted after
 * the latest trusted stand-down and naming it, with no trusted review verdict posted after it.
 */
export function pendingAutoRearmRequest(comments, headRefOid) {
  const live = String(headRefOid ?? '').toLowerCase();
  if (!Array.isArray(comments) || !/^[0-9a-f]{40}$/.test(live)) return null;
  let stand = -1;
  comments.forEach((c, i) => { if (c && typeof c === 'object' && trusted(c) && standDownComments([c]).length > 0) stand = i; });
  const at = comments.findIndex(c => parseAutoRearmRequest(c)?.head === live);
  if (at < 0 || stand < 0 || at < stand) return null;
  const req = parseAutoRearmRequest(comments[at]);
  if (String(comments[stand]?.id ?? '') !== req.standDownId) return null;
  if (comments.some((c, i) => i > at && trusted(c) && VERDICT_HEADING_RE.test(text(c)))) return null;
  return { ...req, commentId: String(comments[at]?.id ?? '') };
}

/** True when a request for this head already exists (pending or consumed): the once-per-head cap. */
export const hasAutoRearmRequestForHead = (comments, head) => Array.isArray(comments)
  && comments.some(c => parseAutoRearmRequest(c)?.head === String(head ?? '').toLowerCase());

/**
 * The structured no-code signal: the latest trusted `changes requested` verdict carries NO reviewer finding. Its only
 * finding is the merge-gate check failing (the verdict the loop console records mechanically from a red gate). Free
 * prose in a fixer note, a stand-down detail or a "fix still owed" note is never consulted.
 */
export function isGateOnlyChangesVerdict(comments) {
  if (!Array.isArray(comments)) return false;
  const verdicts = comments.filter(c => c && typeof c === 'object' && trusted(c) && CHANGES_HEADING_RE.test(text(c)));
  const last = verdicts.at(-1);
  if (!last) return false;
  const lines = text(last).split('\n').slice(1).map(l => l.trim()).filter(l => l && !/^Recorded by [^\n]{1,200}\.$/.test(l));
  return lines.length > 0 && lines.every(l => l === GATE_FINDING);
}
