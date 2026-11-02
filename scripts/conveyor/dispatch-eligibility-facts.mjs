/** Pure adapters from read evidence to fail-closed dispatch eligibility facts. */
import { known, unread, POPULATIONS } from './dispatch-eligibility.mjs';
import { liveResultGateState, parseRedTeamGateMarker } from '../lib/red-team-gate.mjs';

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

/**
 * Red-team evidence from the gate's own store only (liveResultGateState). This module never parses comments or
 * markers itself: anything the gate does not decide for the current head (no result, an older head, no gate
 * record, an unknown outcome, a no-send-back record) is unread. There is no `clear` yet: it needs a gate-side
 * digest-bound clearance, which the gate does not write.
 */
export function redTeamFact(comments, prNumber, head) {
  if (!Array.isArray(comments) || typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) return unread();
  const s = liveResultGateState(comments, prNumber, head);
  if (s.result === null || s.resultId === null) return unread();
  const bound = state => known({ state, resultId: s.resultId, sendBackResultId: state === 'send-back' ? s.resultId : null });
  if (s.outcomes.has('operator-block')) return bound('blocked');
  if (s.sendBackOutcome === 'round-cap') return bound('held');
  if (s.sendBackOutcome === 'sent-back') {
    // Fail closed: only a marker that NAMES this result may bind a send-back; a legacy marker without `result=`
    // is associated by thread order, which is not a digest binding.
    const named = comments.some(c => {
      const m = parseRedTeamGateMarker(typeof c === 'string' ? c : c?.body);
      return m?.pr === Number(prNumber) && m.rev === head.toLowerCase() && m.outcome === 'sent-back' && m.result === s.resultId;
    });
    return named ? bound('send-back') : unread();
  }
  return unread();
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
