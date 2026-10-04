/** Operator ceremony record for we:scripts/conveyor/stand-down-answer.mjs. Pure readers. */
import { AUTOMATION_LOGINS, OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { standDownComments, isStandDownSuperseded } from './stand-down.mjs';
import { isAdvisoryMechanismStandDownSuperseded } from './advisory-fix-mark.mjs';

export const OPERATOR_ANSWER_MARKER = '<!-- conveyor-stand-down-answer:v1 -->';

export function buildOperatorAnswer({ standDownId, reason, actor, channel }) {
  for (const [key, value] of Object.entries({ standDownId, reason, actor, channel })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be non-empty`);
  }
  if (!/^[\w=-]+$/.test(standDownId)) throw new Error('invalid stand-down comment id');
  if (!/^[\w-]+$/.test(actor)) throw new Error('actor must be a GitHub login');
  if (/[\r\n]/.test(channel)) throw new Error('channel must be one line');
  // Encode the record separately so arbitrary operator prose cannot manufacture another marker.
  const record = Buffer.from(JSON.stringify({ standDownId, reason, actor, channel })).toString('base64');
  const surface = channel.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
  const quote = reason.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').split('\n').map((line) => `> ${line}`).join('\n');
  return `${OPERATOR_ANSWER_MARKER}\n## Operator answer — ruling to implement\n\nRelayed on the operator's explicit instruction: @${actor}, via ${surface}.\nSupersedes stand-down comment \`${standDownId}\`. This answers the escalation; it does not clear review gates.\n\n${quote}\n\n<!-- conveyor-stand-down-answer-record:${record} -->`;
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
  return standDownComments([comment]).length > 0;
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
  return `# Operator ruling — implement this answer to the stand-down\n\nRelayed on @${answer.actor}'s explicit instruction via ${answer.channel}.\nThe operator's answer, verbatim:\n\n${answer.reason}\n\nApply this ruling to the escalated question. Review gates remain in force. Escalate any remaining conflict with the goal or ratified decisions; do not infer permission to change lifecycle fields.\n\n${prompt}`;
}
