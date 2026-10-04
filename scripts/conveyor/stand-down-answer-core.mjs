/** Operator ceremony record for we:scripts/conveyor/stand-down-answer.mjs. Pure readers. */
import { AUTOMATION_LOGINS, OPERATOR_LOGINS, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { STAND_DOWN_MARKER, isConcurrentAuthorStandDown, isStandDownSuperseded } from './stand-down.mjs';
import { isAdvisoryMechanismStandDownSuperseded } from './advisory-fix-mark.mjs';

export const OPERATOR_ANSWER_MARKER = '<!-- conveyor-stand-down-answer:v1 -->';

/**
 * #3850 (live 2026-10-04) — STRUCTURED DISPOSITIONS. An answer that rules the PR itself should not land (e.g.
 * "close as superseded") is not a repair: handed to an LLM fixer as free text, fix-3850 read it as "delete the
 * card's files" and was (rightly) denied `git rm`/AGENTS.md edits, ending `blocked-on-infra` with the PR open.
 * A disposition is executed MECHANICALLY by the conveyor (reconcile-core plans `close-superseded`; the
 * promote-draft pass closes the PR with a superseded comment) and never dispatches a fixer.
 */
export const DISPOSITIONS = Object.freeze(['close-superseded']);

/**
 * The disposition an answer carries: the explicit record field, or — for an answer recorded before the field
 * existed — a reason that OPENS with exactly "close as superseded" / "close this PR as superseded" and then ends
 * the clause (`:` `.` `—` `;` `,` or the end of the text). A DESTRUCTIVE action is never read out of looser prose:
 * "Supersedes the earlier ruling — keep the PR", "Supersede the old implementation with …" and "Close issue #123
 * as superseded; continue this repair" all name some OTHER object or ask for continued work, so they infer
 * nothing (an operator who means it uses `--disposition=close-superseded`).
 * @param {{disposition?: string, reason?: string}|null} answer
 * @returns {string|null}
 */
export function answerDisposition(answer) {
  if (!answer) return null;
  if (DISPOSITIONS.includes(answer.disposition)) return answer.disposition;
  const head = String(answer.reason ?? '').trim().toLowerCase();
  return /^close(?: (?:this|the) (?:pr|pull request))? as superseded\s*(?:[:.,;—–-]|$)/.test(head)
    && !/\b(?:continue|keep|retain|but|however|instead)\b/.test(head) ? 'close-superseded' : null;
}

export function buildOperatorAnswer({ standDownId, reason, actor, channel, disposition }) {
  for (const [key, value] of Object.entries({ standDownId, reason, actor, channel })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be non-empty`);
  }
  if (disposition !== undefined && !DISPOSITIONS.includes(disposition)) {
    throw new Error(`disposition must be one of: ${DISPOSITIONS.join(', ')}`);
  }
  if (!/^[\w=-]+$/.test(standDownId)) throw new Error('invalid stand-down comment id');
  if (!/^[\w-]+$/.test(actor)) throw new Error('actor must be a GitHub login');
  if (/[\r\n]/.test(channel)) throw new Error('channel must be one line');
  // Encode the record separately so arbitrary operator prose cannot manufacture another marker.
  const record = Buffer.from(JSON.stringify({ standDownId, reason, actor, channel, ...(disposition ? { disposition } : {}) })).toString('base64');
  const surface = channel.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
  const quote = reason.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').split('\n').map((line) => `> ${line}`).join('\n');
  return `${OPERATOR_ANSWER_MARKER}\n## Operator answer — ruling to implement\n\nRelayed on the operator's explicit instruction: @${actor}, via ${surface}.\nSupersedes stand-down comment \`${standDownId}\`. This answers the escalation; it does not clear review gates.\n\n${quote}\n\n${disposition ? `**Disposition:** \`${disposition}\` — executed mechanically by the conveyor; no fix agent is dispatched.\n\n` : ''}<!-- conveyor-stand-down-answer-record:${record} -->`;
}

export function parseOperatorAnswer(comment) {
  // Require the actual posting principal, never a body assertion or viewerDidAuthor alone.
  const login = String(comment?.author?.login ?? '').toLowerCase();
  if (![...AUTOMATION_LOGINS, ...OPERATOR_LOGINS].includes(login)) return null;
  const body = comment?.body;
  if (typeof body !== 'string' || !body.startsWith(`${OPERATOR_ANSWER_MARKER}\n`)) return null;
  const match = body.match(/\n<!-- conveyor-stand-down-answer-record:([A-Za-z0-9+/=]+) -->$/);
  if (!match) return null;
  try {
    const record = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    return buildOperatorAnswer(record) === body ? record : null;
  } catch { return null; }
}

function isTerminal(comment) {
  return isTrustedMarkerAuthor(comment) && typeof comment?.body === 'string'
    && comment.body.trimStart().startsWith(STAND_DOWN_MARKER) && !isConcurrentAuthorStandDown(comment);
}

export function operatorAnswerForStandDown(comments, index) {
  if (!Array.isArray(comments) || !isTerminal(comments[index]) || !comments[index].id) return null;
  const target = String(comments[index].id);
  for (let i = index + 1; i < comments.length; i += 1) {
    const answer = parseOperatorAnswer(comments[i]);
    if (answer?.standDownId === target) return answer;
  }
  return null;
}

export function isOperatorAnswerStandDownSuperseded(comments, index) {
  return operatorAnswerForStandDown(comments, index) !== null;
}

export function latestUnresolvedStandDown(comments) {
  if (!Array.isArray(comments)) throw new Error('PR comments were not returned');
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    if (isTerminal(comments[i]) && !isStandDownSuperseded(comments, i)
      && !isAdvisoryMechanismStandDownSuperseded(comments, i)
      && !isOperatorAnswerStandDownSuperseded(comments, i)) return comments[i];
  }
  return null;
}

export function latestOperatorAnswer(comments) {
  if (!Array.isArray(comments)) return null;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const answer = parseOperatorAnswer(comments[i]);
    if (answer && comments.slice(0, i).some((c) => isTerminal(c) && c.id != null
      && String(c.id) === answer.standDownId)) return answer;
  }
  return null;
}

export function withOperatorAnswer(prompt, answer) {
  if (!answer) return prompt;
  // #3850 — a disposition is never a fixer's job (reconcile-core routes it before any dispatch). Belt-and-braces
  // for a prompt that still carries one: say so, and forbid the file deletion fix-3850 attempted.
  if (answerDisposition(answer)) {
    return `# Operator ruling — DISPOSITION \`${answerDisposition(answer)}\` (conveyor-executed)\n\nThe operator ruled this PR should not land (verbatim: ${answer.reason}). The conveyor closes it mechanically. Do NOT delete, revert or edit files to implement this; stop and report.\n\n${prompt}`;
  }
  return `# Operator ruling — implement this answer to the stand-down\n\nRelayed on @${answer.actor}'s explicit instruction via ${answer.channel}.\nThe operator's answer, verbatim:\n\n${answer.reason}\n\nApply this ruling to the escalated question. Review gates remain in force. Escalate any remaining conflict with the goal or ratified decisions; do not infer permission to change lifecycle fields.\n\n${prompt}`;
}

/** #3850 — the marker on the conveyor's own superseded-close comment (posted by the promote-draft pass). */
export const CLOSE_SUPERSEDED_MARKER = '<!-- conveyor-close-superseded:v1 -->';

/**
 * #3850 — has the latest operator answer's `close-superseded` ALREADY been executed? True when a trusted
 * {@link CLOSE_SUPERSEDED_MARKER} comment postdates the latest answer comment. Without it a PR a human reopens
 * (to rescue its card, say) is re-planned `close-superseded` — and re-closed with another comment — every tick
 * until someone deletes the answer. A NEW answer posted after the marker is a fresh ruling and plans again.
 * @param {Array<object>|null|undefined} comments - oldest first, as `gh pr view --json comments` returns them.
 * @returns {boolean}
 */
export function isCloseSupersededExecuted(comments) {
  if (!Array.isArray(comments)) return false;
  // The SAME "latest answer" the planner acts on (`latestOperatorAnswer`: it must answer a stand-down that
  // precedes it) — a stray well-formed answer naming no stand-down must not move the boundary.
  let answerAt = -1;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const answer = parseOperatorAnswer(comments[i]);
    if (answer && comments.slice(0, i).some((c) => isTerminal(c) && c.id != null && String(c.id) === answer.standDownId)) { answerAt = i; break; }
  }
  if (answerAt < 0) return false;
  return comments.slice(answerAt + 1).some((c) => isTrustedMarkerAuthor(c) && typeof c?.body === 'string'
    && c.body.trimStart().startsWith(CLOSE_SUPERSEDED_MARKER));
}
