/** Live guards and observable effects for the not-owed carry machine. */
import { createHash } from 'node:crypto';
import { readDrainRedTeamEvidence, readRedTeamStatus, recordRedTeamStatus } from './drain-red-team-evidence.mjs';
import { cardOnlyHeadMoveCandidate, cardOnlySkipSettlementCandidate } from './review-red-team-on-skip.mjs';
import { proveCardOnlyHeadMove } from './card-only-head-move.mjs';
import { readRedTeamProbes, redTeamForHead, redTeamMarker, readRedTeamDisposition } from './red-team-gate.mjs';
import { parseReviewedSha, REVIEW_HOLD_LABELS } from './review-escalation.mjs';
import { isLaterVerdictBody } from './accept-carry-forward.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

const RESTAMP_HEADLINE = '📌 review — acceptance re-stamped after a rebase (no new review)';
function isCurrentHeadRestamp(comment, head) {
  if (!isTrustedMarkerAuthor(comment) || typeof comment.body !== 'string'
    || !comment.body.startsWith(RESTAMP_HEADLINE) || isLaterVerdictBody(comment.body)) return false;
  // Match the reviewed-sha parser's marker shape, but require every marker, not just its last match.
  const markers = [...comment.body.matchAll(/<!--\s*reviewed-sha:\s*([0-9a-fA-F]{7,40})\s*-->/g)];
  return markers.length > 0 && markers.every(([, sha]) => sha.toLowerCase() === head);
}

export function createRedTeamCarryIo({ env = process.env, readEvidence = readDrainRedTeamEvidence,
  readStatus = readRedTeamStatus, writeStatus = recordRedTeamStatus, readLive, readComments,
  proveMove = proveCardOnlyHeadMove, skipPolicy = () => readRedTeamProbes({ env }).value.skipCardOnly,
  applyLabel, postResult, checkpoint, lanePath } = {}) {
  let live, comments, proved = false, witness;
  const key = state => ({ repo: state.repo, pr: state.pr, head: state.head, env });
  return {
    env, checkpoint, witness: () => witness,
    eligible(state) {
      if (skipPolicy() !== true) return false;
      live = readLive(key(state));
      comments = readComments(key(state));
      if (live?.headRefOid !== state.head || !Array.isArray(live.labels) || !Array.isArray(comments)) return false;
      const labels = live.labels.map(label => typeof label === 'string' ? label : label?.name);
      if (labels.some(label => typeof label !== 'string' || REVIEW_HOLD_LABELS.includes(label)
        || label === 'red-team:blocked')) return false;
      const from = state.loopPayload.carriedFrom;
      let anchor = -1;
      for (let i = 0; i < comments.length; i++) {
        const reviewed = parseReviewedSha([comments[i]]);
        if (reviewed === from) anchor = i;
      }
      if (comments.slice(anchor + 1).some(comment => !isCurrentHeadRestamp(comment, state.head)
        && (parseReviewedSha([comment])
          || (isTrustedMarkerAuthor(comment) && isLaterVerdictBody(comment.body))))) return false;
      witness = createHash('sha256').update(JSON.stringify(comments.filter(comment => parseReviewedSha([comment])
        || (isTrustedMarkerAuthor(comment) && isLaterVerdictBody(comment.body))).map(comment => comment.body))).digest('hex');
      if (state.reviewWitness !== undefined && state.reviewWitness !== witness) return false;
      const disposition = readRedTeamDisposition({ ...key(state), comments });
      if (disposition.held.length || disposition.sendBack.length) return false;
      const evidence = readEvidence(key(state));
      if (evidence?.carryConflict || !(cardOnlyHeadMoveCandidate(evidence, state.head)
        || cardOnlySkipSettlementCandidate(evidence, state.head))) return false;
      // Once per execution, including a retry whose pinned read already names the new head.
      if (!proved) proved = from === state.head || proveMove({ fromSha: from, toSha: state.head, cwd: lanePath })?.ok === true;
      return proved;
    },
    intentRecorded(state) {
      const status = readStatus(key(state));
      return status?.status === 'finished' && status.result?.status === 'skipped'
        && status.result.policy === 'card-only' && status.loopPayload?.verdict === null
        && JSON.stringify(status.loopPayload) === JSON.stringify(state.loopPayload);
    },
    recordIntent(state) {
      writeStatus({ ...key(state), loopPayload: state.loopPayload, status: 'finished',
        result: { status: 'skipped', policy: 'card-only' } }, { env });
    },
    labelApplied(state) {
      const current = readLive(key(state));
      if (current?.headRefOid !== state.head || !Array.isArray(current.labels)) throw Error('carry label state unreadable or head changed');
      const labels = current.labels.map(label => typeof label === 'string' ? label : label?.name);
      if (labels.some(label => typeof label !== 'string' || REVIEW_HOLD_LABELS.includes(label)
        || label === 'red-team:blocked')) throw Error('carry label state held or unreadable');
      return labels.includes('red-team:clear') && !labels.includes('red-team:pending');
    },
    applyLabel: state => applyLabel(key(state)),
    resultVisible(state) {
      const thread = readComments(key(state));
      if (!Array.isArray(thread)) throw Error('carry comments unreadable');
      return Boolean(redTeamForHead(thread, state.pr, state.head));
    },
    postResult: state => postResult({ ...key(state), body: `${redTeamMarker(state.pr, state.head)}\n\nRed team not required on this head: card-only diff (policy redTeam.skipCardOnly)` }),
  };
}
