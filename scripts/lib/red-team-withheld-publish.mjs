/** Recover publication of a completed, head-bound red-team result without another model call. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { redTeamStatusDir } from './drain-red-team-evidence.mjs';
import { renderRedTeamComment, redTeamCommentPosted as markerPosted, priorRedTeamRow } from '../operations/review-extra-seats.mjs';
import { readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { redTeamMarker, parseRedTeamComment, sealedBreakKeys, postedBreakKeys, redTeamBreaksAgree, redTeamHoldDecision } from './red-team-gate.mjs';
import { scrubPublish } from './secret-scrub.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { buildSeal } from './red-team-result-schema.mjs';

export function needsPublish(status) {
  return status?.status === 'finished' && (status.result === 'ran'
    || (status.result?.status === 'ran' && ['withheld', 'error'].includes(status.result.comment)));
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
export function publishStoredRedTeamResult({ status, listComments, postComment, sealOnly = false,
  renderFull = renderRedTeamComment, renderMinimal = renderMinimalRedTeamComment,
  redTeamCommentPosted = markerPosted, scrub = scrubPublish,
  statusDir = redTeamStatusDir(), withLock = withFileLock,
  readStatus = path => JSON.parse(readFileSync(path, 'utf8')),
  readSeatRow = ({ repo, pr, head }) => priorRedTeamRow(
    readStore({ path: resolveScorecardStorePath(process.env), strict: true }).records, pr, head, repo),
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
    // The stored evidence's confirmed breaks, sealed into the status: the single authority every disposition reader holds on.
    let sealDirty = false;
    const seal = (findings, evidence = result) => {
      const built = buildSeal({ repo, pr: Number(pr), head, result: evidence, findings, now: status.seal?.sealedAt ?? now() });
      if (!built.ok) {
        const { sealedPosted: _p, seal: _s, ...rest } = status;
        status = { ...rest, sealedBreaks: 'unreadable' }; sealDirty = true;
        return false;
      }
      if (JSON.stringify(status.seal) !== JSON.stringify(built.seal)
        || JSON.stringify(status.sealedBreaks) !== JSON.stringify(built.seal.breaks)) {
        const { sealedPosted: _stale, ...rest } = status;
        status = { ...rest, sealedBreaks: built.seal.breaks, seal: built.seal }; sealDirty = true;
      }
      return true;
    };
    const holdLegacy = () => {
      // Its own flag: an earlier publish-failed alert must not silence this one (they name different problems).
      if (!status.legacyHoldPublished) {
        publishNeedsYou({ kind: 'red-team-legacy-ran-unreadable', pr, repo, head,
          reason: 'Legacy red-team evidence is unreadable or conflicts with the posted comment; operator review required.' });
        status = { ...status, legacyHoldPublished: true };
        writeStatus(status);
      } else if (sealDirty) writeStatus(status);
      return { status: 'held' };
    };
    const legacy = status.result === 'ran';
    let result = status.result;
    // Throws unless the exact-head seat row is complete and self-consistent.
    const recoverLegacy = () => {
      const row = readSeatRow({ repo, pr, head });
      if (!row || row.rev !== head || !buildSeal({ repo, pr: Number(pr), head, result: row, findings: row.findings, now: now() }).ok) {
        throw Error('invalid legacy red-team evidence');
      }
      return { status: 'ran', comment: 'withheld', provider: row.provider, model: row.model,
        callId: row.callId, foldedVerdict: row.foldedVerdict, confirmedMissCount: row.confirmedMissCount,
        recheckStatus: row.recheckStatus,
        findings: row.findings.map(f => ({ ...f, confirmed: f.confirmedByRecheck === true || f.confirmed === true })) };
    };
    const renderInput = res => ({ ...res, pr, rev: head, findings: res.findings.map(f => ({ ...f,
      confirmedByRecheck: f.confirmed === true || f.confirmedByRecheck === true })) });
    const escalate = () => {
      if (!status.needsYouPublished) {
        publishNeedsYou({ kind: 'red-team-publish-failed', pr, repo, head,
          reason: 'Red-team result publication failed twice; operator publication required.' });
        status = { ...status, needsYouPublished: true };
        writeStatus(status);
      } else if (sealDirty) writeStatus(status);
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
    let conflict = false;
    try {
      const comments = listComments ? listComments() : provider.readComments(repo, pr);
      if (!Array.isArray(comments)) throw Error('red-team comments unreadable');
      if (redTeamCommentPosted(comments, pr, head)) {
        if (!legacy) {
          // A comment is already up (a crash after the post, or a hand-posted marker): the stored result is still the
          // authority, so seal it before stepping aside. The shared hold decision compares the comment to it.
          seal(result?.findings);
          if (sealDirty) writeStatus(status);
          return { status: 'skipped' };
        }
        // The exact-head seat row is the single authority: when it cannot be read, nothing proves the posted comment
        // shows its breaks, so the head is held (with an operator alert), never cleared by the comment.
        let recovered = null;
        try { recovered = recoverLegacy(); } catch { /* held below */ }
        // The readable row is sealed as the authority; the shared hold decision compares WHOLE normalized lists (not counts,
        // not a marker), so the posted comment can only add holds.
        const sealedOk = recovered ? seal(recovered.findings, recovered) : seal(undefined);
        // Here an empty seal against a comment that shows a break is a conflict too (the operator hears of every difference).
        // Otherwise the shared hold decision rules (it also accepts this publisher's own sealed scrub-fallback body).
        const sealedNow = { breaks: status.sealedBreaks ?? [], ...(status.sealedPosted ? { posted: status.sealedPosted } : {}) };
        conflict = !recovered || !sealedOk || !(redTeamBreaksAgree({ comments, pr, head, breaks: sealedNow.breaks }).agree
          || (sealedNow.breaks.length > 0 && !redTeamHoldDecision({ comments, pr, head, sealed: sealedNow }).held));
        if (!conflict) {
          // The posted comment now agrees with the stored evidence: lift a hold an earlier pass recorded.
          if (status.legacyHoldPublished) {
            const { legacyHoldPublished: _lifted, ...rest } = status;
            status = rest;
            sealDirty = true;
          }
          if (sealDirty) writeStatus(status);
          return { status: 'skipped' };
        }
      }
    } catch { return sealOnly ? { status: 'retry' } : failedAttempt(); }
    // Outside the try: a failing alert write must not be counted as a publish attempt.
    if (conflict) return holdLegacy();
    if (legacy) {
      try { result = recoverLegacy(); } catch { seal(undefined); return holdLegacy(); }
    }
    // Sealed before any post (unreadable findings seal as unreadable), so a crash or a failed post leaves the hold in place.
    if (!seal(result?.findings)) {
      if (sealDirty) { writeStatus(status); sealDirty = false; }
      return sealOnly ? { status: 'held' } : failedAttempt();
    }
    // `sealOnly` (a superseded head a carried result came from): record the seal, never post or escalate for it.
    if (sealOnly) {
      // Reached only with the row recovered and no posted comment in conflict (e.g. the stale one was deleted): nothing
      // is left for the legacy flag to hold on, and no post will ever lift it for a superseded head, so lift it here.
      // The carried head still holds on this seal (redTeamHoldDecision compares it with the carried comment).
      if (legacy && status.legacyHoldPublished) {
        const { legacyHoldPublished: _lifted, ...rest } = status;
        status = rest;
        sealDirty = true;
      }
      if (sealDirty) writeStatus(status);
      return { status: 'sealed' };
    }
    if (status.publishAttempts >= 2) return escalate();
    try {
      if (!Array.isArray(result.findings)) throw Error('red-team findings unreadable');
      const input = renderInput(result);
      const full = renderFull(input);
      let body = full;
      if (scrub(body).length) body = renderMinimal(input);
      if (scrub(body).length) body = renderMinimal({ ...input, omitLocation: true });
      if (scrub(body).length) throw Error('red-team minimal comment failed secret scrub');
      // A rendered body must still show every confirmed break to the gate, or clear would be guessed.
      const breaks = sealedBreakKeys(result.findings).length;
      if (parseRedTeamComment(body).findings.filter(f => f.confirmed).length !== breaks
        || (legacy && breaks !== result.confirmedMissCount)) {
        throw Error('red-team comment drops confirmed findings');
      }
      // A scrub fallback cannot show the sealed fields: seal the exact body posted beside the breaks, so the publisher's
      // own comment agrees with its seal (the hold decision still demands every break shown as confirmed).
      if (body !== full && breaks) {
        const posted = postedBreakKeys(parseRedTeamComment(body));
        if (JSON.stringify(status.sealedPosted ?? null) !== JSON.stringify(posted)) { status = { ...status, sealedPosted: posted }; sealDirty = true; }
      }
      if (sealDirty) { writeStatus(status); sealDirty = false; }
      if (postComment) postComment({ repo, pr, body });
      else provider.postComment(repo, pr, body);
    } catch { return failedAttempt(); }
    const { legacyHoldPublished: _posted, ...kept } = status;
    writeStatus({ ...kept, publishedAt: now(), result: { ...result, comment: 'posted' } });
    return { status: 'posted' };
  });
}
