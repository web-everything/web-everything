/**
 * @file scripts/conveyor/dispatch-eligibility.mjs
 * @description Pure, fail-closed dispatch eligibility from complete caller-supplied facts.
 */

/** Dispatch populations sharing the ordered eligibility rules. */
export const POPULATIONS = Object.freeze([
  'fix', 'ci-heal', 'rebase', 'stacked-rebase', 'restack', 'takeover',
  'block-ruled-referral', 'conflict-owes-rebase', 'promote-draft',
  'main-fix-green', 'red-team-send-back',
]);

/** Fact validation order; unknown evidence takes precedence over all holds. */
export const REQUIRED_FACTS = Object.freeze([
  'population', 'referral', 'alreadyLanded', 'scope', 'redTeam',
  'claim', 'pause', 'sameHead', 'rounds',
]);

/** Stable hold identifiers and prefixes. */
export const REASONS = Object.freeze({
  NOT_OPEN: 'not-open',
  DRAFT: 'draft',
  REFERRAL: 'referral',
  ALREADY_LANDED: 'already-landed',
  NO_SCOPE: 'no-scope',
  SCOPE_TOO_LARGE: 'scope-too-large',
  RED_TEAM_PREFIX: 'red-team-',
  RED_TEAM_STALE_SEND_BACK: 'red-team-stale-send-back',
  CLAIMED: 'claimed',
  PAUSED: 'paused',
  SAME_HEAD: 'same-head',
  CAP_PREFIX: 'cap-exhausted:',
});

/** @param {*} value Read evidence. @returns {{status: 'known', value: *}} */
export function known(value) {
  return { status: 'known', value };
}

/** @returns {{status: 'unread'}} Evidence that has not been read successfully. */
export function unread() {
  return { status: 'unread' };
}

/** @param {*} value @returns {boolean} Whether the value is a fact record. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {*} value @returns {boolean} Whether an optional result ID has a valid shape. */
function isResultId(value) {
  return value === null || (typeof value === 'string' && value.length > 0);
}

/** @param {string} name @param {*} value @returns {boolean} Whether evidence is well formed. */
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

/**
 * Evaluate eleven ordered rules without mutating inputs or reading external state.
 * @param {object} prState PR snapshot including thread completeness and head identity.
 * @param {object} facts Required facts wrapped by known() or unread().
 * @returns {{dispatch: true, population: string, evidence: {pr: *, head: *, rulesPassed: number}}
 *   | {hold: string} | {unknown: string}} First unknown, first hold, or dispatch evidence.
 */
export function eligibility(prState, facts) {
  if (prState?.commentsComplete !== true) return { unknown: 'thread' };
  if (!Number.isInteger(prState.number) || prState.number <= 0) return { unknown: 'pr' };
  if (!/^[0-9a-f]{40}$/i.test(String(prState.headRefOid ?? ''))) return { unknown: 'pr' };
  for (const name of REQUIRED_FACTS) {
    const fact = facts?.[name];
    if (!isRecord(fact) || fact.status !== 'known' || !validFact(name, fact.value)) {
      return { unknown: name };
    }
  }

  const population = facts.population.value;
  const redTeam = facts.redTeam.value;
  const boundSendBack = redTeam.state === 'send-back' && redTeam.resultId !== null
    && redTeam.sendBackResultId === redTeam.resultId;

  if (prState.state !== 'OPEN') return { hold: REASONS.NOT_OPEN };
  if (!Array.isArray(prState.labels) || typeof prState.isDraft !== 'boolean') return { unknown: 'pr' };
  const labelNames = prState.labels.map(l => (typeof l === 'string' ? l : l?.name));
  if (prState.isDraft && labelNames.includes('review-status:draft-withdrawn')) return { hold: REASONS.DRAFT };
  if (prState.isDraft !== false
    && population !== 'promote-draft' && population !== 'main-fix-green'
    && !(population === 'red-team-send-back' && boundSendBack)) {
    return { hold: REASONS.DRAFT };
  }
  if (['pending', 'human-parked', 'auto-resolve-stays'].includes(facts.referral.value.state)) {
    return { hold: REASONS.REFERRAL };
  }
  if (facts.alreadyLanded.value === 'landed') return { hold: REASONS.ALREADY_LANDED };
  if (facts.scope.value === 'empty') return { hold: REASONS.NO_SCOPE };
  if (facts.scope.value === 'too-large') return { hold: REASONS.SCOPE_TOO_LARGE };
  if (['held', 'pending', 'blocked'].includes(redTeam.state)) {
    return { hold: REASONS.RED_TEAM_PREFIX + redTeam.state };
  }
  if (redTeam.state === 'send-back' && !boundSendBack) {
    return { hold: REASONS.RED_TEAM_STALE_SEND_BACK };
  }
  if (facts.claim.value.claimed) return { hold: REASONS.CLAIMED };
  if (facts.pause.value.paused) return { hold: REASONS.PAUSED };
  if (facts.sameHead.value.spent) return { hold: REASONS.SAME_HEAD };
  if (facts.rounds.value.attempts >= facts.rounds.value.cap) {
    return { hold: REASONS.CAP_PREFIX + population };
  }
  return {
    dispatch: true,
    population,
    evidence: { pr: prState.number, head: prState.headRefOid, rulesPassed: 11 },
  };
}
