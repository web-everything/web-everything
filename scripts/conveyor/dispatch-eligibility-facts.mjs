/** Pure adapters from read evidence to fail-closed dispatch eligibility facts. */
import { known, unread, POPULATIONS } from './dispatch-eligibility.mjs';
import { liveResultGateState, parseRedTeamComment } from '../lib/red-team-gate.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isResultId(value) {
  return value === null || (typeof value === 'string' && value.length > 0);
}

// Keep these value checks identical to dispatch-eligibility.mjs's validFact.
function validFact(name, value) {
  switch (name) {
    case 'population': return POPULATIONS.includes(value);
    case 'alreadyLanded': return ['landed', 'not-landed'].includes(value);
    case 'scope': return ['present', 'empty', 'too-large'].includes(value);
    case 'referral':
      return isRecord(value) && ['none', 'pending', 'human-parked',
        'auto-resolve-stays', 'auto-resolve-resumes'].includes(value.state);
    case 'redTeam':
      return isRecord(value)
        && ['none', 'clear', 'held', 'pending', 'blocked', 'send-back'].includes(value.state)
        && isResultId(value.resultId) && isResultId(value.sendBackResultId);
    case 'claim': return isRecord(value) && typeof value.claimed === 'boolean';
    case 'pause': return isRecord(value) && typeof value.paused === 'boolean';
    case 'sameHead': return isRecord(value) && typeof value.spent === 'boolean';
    case 'rounds':
      return isRecord(value) && Number.isFinite(value.attempts) && value.attempts >= 0
        && Number.isFinite(value.cap) && value.cap >= 0;
    default: return false;
  }
}

function readFact(name, value) {
  return value?.readFailed === true || !validFact(name, value) ? unread() : known(value);
}

/** Derive red-team evidence using the shared live-result and marker trust rules. */
export function redTeamFact(comments, prNumber, head) {
  if (!Array.isArray(comments) || typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) return unread();
  const s = liveResultGateState(comments, prNumber, head);
  if (s.result === null) {
    const olderResult = comments.some(comment => {
      if (!isTrustedMarkerAuthor(comment)) return false;
      const parsed = parseRedTeamComment(typeof comment === 'string' ? comment : comment?.body);
      return parsed !== null && parsed.pr === Number(prNumber) && parsed.rev !== head.toLowerCase();
    });
    return olderResult ? unread() : known({ state: 'none', resultId: null, sendBackResultId: null });
  }
  // A finding-shaped line the shared parser dropped means the result cannot be trusted as read.
  const live = head.toLowerCase();
  const malformed = comments.some(comment => {
    if (!isTrustedMarkerAuthor(comment)) return false;
    const body = String(typeof comment === 'string' ? comment : comment?.body ?? '').replace(/\r\n/g, '\n').trimStart();
    const parsed = parseRedTeamComment(body);
    if (!parsed || parsed.pr !== Number(prNumber) || parsed.rev !== live) return false;
    return body.split('\n').filter(line => /^\d+\. \[/.test(line)).length !== parsed.findings.length;
  });
  if (malformed) return unread();
  if (s.outcomes.has('operator-block')) {
    return known({ state: 'blocked', resultId: s.resultId, sendBackResultId: null });
  }
  const state = !s.result.findings.some(finding => finding.confirmed) ? 'clear'
    : s.sendBackOutcome === 'round-cap' ? 'held'
      : s.sendBackOutcome === 'sent-back' ? 'send-back' : 'pending';
  return known({ state, resultId: s.resultId, sendBackResultId: state === 'send-back' ? s.resultId : null });
}

/**
 * Build facts with unread evidence for absent, failed, or malformed local reads.
 * Containment enrichment only runs for conflict-labelled PRs: without an explicit
 * fact, those PRs remain unread; other PRs use the contract's known not-landed default.
 */
export function buildEligibilityFacts({ pr, comments, commentsComplete, population, locals, alreadyLanded }) {
  let landedFact;
  if (pr?.alreadyLandedInMain) {
    landedFact = known('landed');
  } else if (alreadyLanded !== undefined) {
    // An explicit failed or malformed read overrides the default even without a conflict label.
    landedFact = isRecord(alreadyLanded) && alreadyLanded.status === 'known'
      ? readFact('alreadyLanded', alreadyLanded.value) : unread();
  } else {
    const conflicting = Array.isArray(pr?.labels)
      && pr.labels.some(label => (typeof label === 'string' ? label : label?.name) === 'merge-status:conflicting');
    landedFact = conflicting ? unread() : known('not-landed');
  }
  return {
    population: readFact('population', population),
    referral: readFact('referral', locals?.referral),
    alreadyLanded: landedFact,
    scope: readFact('scope', locals?.scope),
    redTeam: commentsComplete === true ? redTeamFact(comments, pr?.number, pr?.headRefOid) : unread(),
    claim: readFact('claim', locals?.claim),
    pause: readFact('pause', locals?.pause),
    sameHead: readFact('sameHead', locals?.sameHead),
    rounds: readFact('rounds', locals?.rounds),
  };
}
