/** Guarded settlement of a trusted published result, shared by review jobs and recovery. */
import { redTeamForHead, redTeamMarker, redTeamResultCommentForHead, redTeamHoldDecision,
  isPublishableRedTeamResult, redTeamResultId } from './red-team-gate.mjs';
import { markCarriedCheckUnpublished, settleUnknownEvidenceByComment } from './drain-red-team-evidence.mjs';
import { buildVerdictCarriedMarker } from './rebase-verdict-carry.mjs';
import { sealedFromStatus } from './red-team-sealed-status.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';
import { runGhSync } from './gh-throttle.mjs';

export function settleRedTeamResult(row, { repo, env, provider, readComments, readEvidence, readStatus,
  readSeal, freshSettlement = () => { throw Error('fresh carry proof missing; re-run review'); },
  postResult = ({ pr, body }) => runGhSync(['pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-'],
    { input: body, env, timeout: 60_000, maxBuffer: 1024 * 1024 }),
  syncLabels = syncRedTeamStatusLabels, note = () => {} }) {
  const key = { repo, pr: row.prNumber, head: row.head };
  const live = provider.readPrState(repo, row.prNumber);
  let comments = readComments(key);
  if (live?.headRefOid !== row.head || !Array.isArray(live.labels) || !Array.isArray(comments))
    throw Error('head moved or evidence unreadable before result settlement');
  const names = live.labels.map(label => typeof label === 'string' ? label : label?.name);
  if (names.some(name => typeof name !== 'string')) throw Error('result labels unreadable');
  // A blocked label is already a settled hold. Never let a clean comment replace it.
  if (names.includes('red-team:blocked')) return { blocked: true };
  const sourceHead = row.from ?? row.head;
  const result = redTeamForHead(comments, row.prNumber, sourceHead);
  if (!isPublishableRedTeamResult(result)) throw Error('trusted completed result missing or malformed');
  const evidence = settleUnknownEvidenceByComment(readEvidence(key), comments, row.prNumber, row.head, live.reviews);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.ok === false || evidence.inFlight || evidence.queued || evidence.carryConflict)
    throw Error('result evidence unreadable, superseded or still in flight');
  for (const sealHead of new Set([row.head, sourceHead])) {
    const status = readStatus({ ...key, head: sealHead });
    const seals = [readSeal?.({ ...key, head: sealHead, env }), sealedFromStatus(status, sealHead)];
    for (const seal of seals) {
      if (seal?.unreadable || seal?.unsealed || seal?.legacyHold)
        throw Error('result seal unreadable or publication incomplete');
      if (seal && redTeamHoldDecision({ comments, pr: row.prNumber, head: sealHead, sealed: seal }).held)
        throw Error('stored break differs from the result; settlement refused');
    }
  }
  if (row.from) {
    if (!freshSettlement(row)) return { blocked: true };
    const source = redTeamResultCommentForHead(comments, row.prNumber, row.from)?.comment?.body;
    if (typeof source !== 'string') throw Error('source result unreadable');
    const markerAt = source.indexOf(redTeamMarker(row.prNumber, row.from));
    if (markerAt < 0) throw Error('source result marker unreadable');
    const body = [buildVerdictCarriedMarker({ fromSha: row.from, toSha: row.head, patchId: row.patchId }),
      'Review verdict carried across an identical contribution.',
      source.slice(markerAt)
        .replace(redTeamMarker(row.prNumber, row.from), redTeamMarker(row.prNumber, row.head))].join('\n');
    if (provider.readPrState(repo, row.prNumber)?.headRefOid !== row.head) throw Error('head moved before result carry');
    markCarriedCheckUnpublished({ ...key, env });
    postResult({ ...key, body });
    comments = readComments(key);
    if (!redTeamForHead(comments, row.prNumber, row.head)) throw Error('carried result not visible');
  }
  const guarded = { ...provider,
    setLabels: (repo, pr, change) => {
      const state = provider.readPrState(repo, pr);
      if (state?.headRefOid !== row.head) throw Error('head moved before result label settlement');
      if (!Array.isArray(state.labels) || state.labels.some(label =>
        typeof (typeof label === 'string' ? label : label?.name) !== 'string'
        || (typeof label === 'string' ? label : label?.name) === 'red-team:blocked'))
        throw Error('blocked or unreadable labels before result settlement');
      const currentComments = readComments(key);
      const currentResult = redTeamForHead(currentComments, pr, row.head);
      const currentEvidence = settleUnknownEvidenceByComment(readEvidence(key), currentComments, pr, row.head, state.reviews);
      const seal = readSeal?.({ ...key, env });
      const stored = sealedFromStatus(readStatus(key), row.head);
      if (redTeamResultId(currentResult) !== redTeamResultId(result) || !currentResult
        || !currentEvidence || currentEvidence?.ok === false || currentEvidence?.inFlight || currentEvidence?.queued
        || currentEvidence?.carryConflict || [seal, stored].some(sealed => sealed && (
          sealed.unreadable || sealed.unsealed || sealed.legacyHold
          || redTeamHoldDecision({ comments: readComments(key), pr, head: row.head, sealed }).held)))
        throw Error('result evidence changed before label settlement');
      if (provider.readPrState(repo, pr)?.headRefOid !== row.head) throw Error('head moved before result label write');
      return provider.setLabels(repo, pr, change);
    } };
  const synced = syncLabels({ ...key, env, log: note, provider: guarded, comments, evidence });
  if (synced?.skipped) throw Error(`result label settlement refused: ${synced.skipped}`);
  return { blocked: synced?.add === 'red-team:blocked' || result.findings.some(finding => finding.confirmed) };
}
