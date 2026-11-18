/** Head-bound requests share the daemon's ordinary recovery queue, never a direct dispatch. */
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { isRealHead } from './red-team-skip-outcome.mjs';
const PREFIX = '<!-- red-team-request: ';
export function validateRedTeamRequest(input) {
  if (!Number.isSafeInteger(input?.pr) || input.pr < 1) throw Error('red-team-enqueue: --pr must be a positive safe integer');
  if (typeof input.repo !== 'string' || input.repo.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.repo)) throw Error('red-team-enqueue: --repo must be owner/repo');
  if (typeof input.actor !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(input.actor)) throw Error('red-team-enqueue: --actor must be an explicit login');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000
    || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(input.reason)) {
    throw Error('red-team-enqueue: --reason needs 1–1000 characters without controls; shorten the reason and retry');
  }
  return { ...input, reason: input.reason.trim() };
}
export function redTeamRequestBody(request) {
  const record = validateRedTeamRequest(request);
  if (!isRealHead(record.head)) throw Error('red-team-enqueue: live head unreadable');
  // Escape delimiters inside JSON; PR text never becomes a second marker or executable input.
  const json = JSON.stringify({ version: 1, repo: record.repo, pr: record.pr, head: record.head, actor: record.actor, reason: record.reason, time: new Date().toISOString() })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${PREFIX}${json} -->\nRed-team run requested at the recorded head. The daemon applies its normal evidence, queue and capacity guards.`;
}
export function redTeamRequestForHead(comments, { repo, pr, head }) {
  if (!Array.isArray(comments)) return null;
  for (const comment of [...comments].reverse()) {
    if (!isTrustedMarkerAuthor(comment) || typeof comment.body !== 'string' || comment.body.length > 8192
      || !comment.body.startsWith(PREFIX)) continue;
    try {
      const end = comment.body.indexOf(' -->\n');
      const record = JSON.parse(comment.body.slice(PREFIX.length, end));
      validateRedTeamRequest(record);
      if (typeof record.time !== 'string' || !Number.isFinite(Date.parse(record.time))) continue;
      if (record.version === 1 && record.repo === repo && record.pr === pr && record.head === head) return record;
    } catch { /* A malformed or untrusted marker grants no authority. */ }
  }
  return null;
}
