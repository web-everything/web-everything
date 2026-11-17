/** Head-bound requests share the daemon's ordinary recovery queue, never a direct dispatch. */
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { redTeamForHead } from './red-team-gate.mjs';
import { isRealHead } from './red-team-skip-outcome.mjs';

const PREFIX = '<!-- red-team-request: ';
export const RED_TEAM_REQUEST_KIND = 'red-team-requested';
export const isRedTeamRecoveryRefusal = row => ['already-reviewed-head', RED_TEAM_REQUEST_KIND].includes(row?.kind);

export function validateRedTeamRequest(input) {
  if (!Number.isSafeInteger(input?.pr) || input.pr < 1) throw Error('red-team-enqueue: --pr must be a positive safe integer');
  if (typeof input.repo !== 'string' || input.repo.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.repo)) throw Error('red-team-enqueue: --repo must be owner/repo');
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
  const json = JSON.stringify({ version: 1, repo: record.repo, pr: record.pr, head: record.head, reason: record.reason })
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
      if (record.version === 1 && record.repo === repo && record.pr === pr && record.head === head) return record;
    } catch { /* A malformed or untrusted marker grants no authority. */ }
  }
  return null;
}

/** rawPrs is the daemon's open-PR snapshot. Preserve refusal metadata and nominate each PR once. */
export function redTeamRecoveryRefusals({ repo, refusals = [], rawPrs = [] }) {
  const result = [...refusals];
  for (const raw of rawPrs ?? []) {
    const pr = Number(raw?.number), head = raw?.headRefOid;
    if (!Number.isSafeInteger(pr) || pr < 1 || !isRealHead(head) || raw.isDraft !== false
      || raw.state != null && raw.state !== 'OPEN' || !Array.isArray(raw.labels)
      || raw.labels.some(label => typeof (typeof label === 'string' ? label : label?.name) !== 'string')
      || !Array.isArray(raw.comments) || raw.comments.some(comment => typeof comment?.body !== 'string')
      || redTeamForHead(raw.comments, pr, head)) continue;
    const human = raw.labels.some(label => (typeof label === 'string' ? label : label.name) === 'review:human');
    const request = redTeamRequestForHead(raw.comments, { repo, pr, head });
    if ((!human && !request) || result.some(row => isRedTeamRecoveryRefusal(row) && Number(row.prNumber) === pr)) continue;
    result.push({ kind: RED_TEAM_REQUEST_KIND, prNumber: pr, headSha: head,
      why: human ? 'human hold needs a live-head red-team result' : 'head-bound operator red-team request' });
  }
  return result;
}
