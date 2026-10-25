/** Recover publication of a completed, head-bound red-team result without another model call. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { redTeamStatusDir } from './drain-red-team-evidence.mjs';
import { renderRedTeamComment, redTeamCommentPosted as markerPosted } from '../operations/review-extra-seats.mjs';
import { redTeamMarker } from './red-team-gate.mjs';
import { scrubPublish } from './secret-scrub.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';

export function needsPublish(status) {
  return status?.status === 'finished' && status.result?.status === 'ran'
    && ['withheld', 'error'].includes(status.result.comment);
}

/** Only fixed text plus scrubbed, single-line category/location fields; keep the gate's exact grammar. */
export function renderMinimalRedTeamComment({ pr, rev, findings, omitLocation = false }) {
  const one = value => String(value ?? '').replace(/[\r\n\p{Cc}\p{Cf}]/gu, ' ').trim();
  const category = value => {
    const text = one(value).replace(/[,()]/g, ' ');
    return !text || scrubPublish(text).length ? 'uncategorised' : text;
  };
  return [redTeamMarker(pr, rev), '### Post-accept red team', '', ...findings.map((f, i) => {
    const tag = f.confirmedByRecheck ? '**confirmed**' : 'unverifiable';
    const file = one(f.file).replaceAll('`', "'");
    const at = Number.isInteger(f.line) ? `:${f.line}` : '';
    const where = !omitLocation && file ? ` \`${file}${at}\`` : '';
    return `${i + 1}. [${tag}] (${category(f.category)}, impact?)${where} — [summary withheld: failed the secret scrub]`;
  })].join('\n');
}

/** Synchronous IO shell, like the sweep. Persist retry/escalation state atomically, with a two-attempt bound. */
export function publishStoredRedTeamResult({ status, listComments, postComment,
  renderFull = renderRedTeamComment, renderMinimal = renderMinimalRedTeamComment,
  redTeamCommentPosted = markerPosted, scrub = scrubPublish,
  statusDir = redTeamStatusDir(), withLock = withFileLock,
  readStatus = path => JSON.parse(readFileSync(path, 'utf8')),
  writeStatus,
  publishNeedsYou = publishAttention, now = () => new Date().toISOString(),
} = {}) {
  const { repo, pr, head } = status;
  if (typeof repo !== 'string' || !Number.isInteger(Number(pr)) || Number(pr) <= 0
    || !/^[a-f0-9]{40}$/i.test(head ?? '')) throw Error('invalid red-team publication identity');
  const statusPath = join(statusDir, `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);
  writeStatus ??= next => writeJsonAtomic(statusPath, next);
  return withLock(`${statusPath}.lock`, () => {
    status = readStatus(statusPath);
    if (!status || status.repo !== repo || Number(status.pr) !== Number(pr) || status.head !== head) {
      throw Error('red-team publication status identity mismatch');
    }
    if (!needsPublish(status)) return { status: 'skipped' };
    const escalate = () => {
      if (!status.needsYouPublished) {
        publishNeedsYou({ kind: 'red-team-publish-failed', pr, repo, head,
          reason: 'Red-team result publication failed twice; operator publication required.' });
        status = { ...status, needsYouPublished: true };
        writeStatus(status);
      }
      return { status: 'failed' };
    };
    const failedAttempt = () => {
      // Never copy gh/model error text to the status or needs-you feed: it may contain secrets.
      if (!(status.publishAttempts >= 2)) {
        status = { ...status, publishAttempts: (status.publishAttempts ?? 0) + 1 };
        writeStatus(status);
      }
      return status.publishAttempts >= 2 ? escalate() : { status: 'retry' };
    };
    const provider = (!listComments || !postComment) ? createGhProvider() : null;
    try {
      const comments = listComments ? listComments() : provider.readComments(repo, pr);
      if (!Array.isArray(comments)) throw Error('red-team comments unreadable');
      if (redTeamCommentPosted(comments, pr, head)) return { status: 'skipped' };
    } catch { return failedAttempt(); }
    if (status.publishAttempts >= 2) return escalate();
    try {
      if (!Array.isArray(status.result.findings)) throw Error('red-team findings unreadable');
      const findings = status.result.findings.map(f => ({ ...f,
        confirmedByRecheck: f.confirmed === true || f.confirmedByRecheck === true }));
      const input = { ...status.result, pr, rev: head, findings };
      let body = renderFull(input);
      if (scrub(body).length) body = renderMinimal(input);
      if (scrub(body).length) body = renderMinimal({ ...input, omitLocation: true });
      if (scrub(body).length) throw Error('red-team minimal comment failed secret scrub');
      if (postComment) postComment({ repo, pr, body });
      else provider.postComment(repo, pr, body);
    } catch { return failedAttempt(); }
    writeStatus({ ...status, publishedAt: now(), result: { ...status.result, comment: 'posted' } });
    return { status: 'posted' };
  });
}
