// Pure fold of the trusted, head-bound red-team comment evidence into one verdict (#6535 redesign, slice 1).
// It reuses the gate's own reader (trusted-author checks, carry chain, round-cap and operator-ruling rules live there)
// and adds no trust logic of its own: only evidence readRedTeamDisposition accepts can clear; anything else can only hold.
import { readRedTeamDisposition } from './red-team-gate.mjs';

export const RED_TEAM_VERDICTS = Object.freeze(['clear', 'held', 'owed-no-result', 'not-owed']);

const BREAK_REASON = 'post-accept red team confirmed a break requiring send-back';
const NO_RESULT_REASON = 'post-accept red team has no recorded result on the live head';

/**
 * Detail form: `{ verdict, reason }`. `reason` is one of break | unreadable | truncated | evidence-unknown | no-result | null.
 * Order matters (matches the drain): recorded breaks first, then unknown evidence, then owed/result.
 * `owed` is the caller's already-computed "a run is owed on this head"; `cardOnly` means the head is card-only and skipped.
 * `evidenceOk:false` (run evidence unreadable) and `truncated:true` (thread cut off) can only hold, never clear.
 */
export function deriveRedTeamVerdictDetail({ comments, pr, head, owed = false, cardOnly = false, standingRuling = null, repo = null,
  env = process.env, setting, evidenceOk = true, evidenceReason = null, truncated = false } = {}) {
  if (!Array.isArray(comments)) return { verdict: 'held', reason: 'unreadable' };
  let disposition;
  try {
    disposition = readRedTeamDisposition({ comments, pr, head, env, setting, repo, standingRuling });
  } catch {
    return { verdict: 'held', reason: 'unreadable' };
  }
  if (disposition.sendBack.length || disposition.held.length) return { verdict: 'held', reason: 'break' };
  if (truncated) return { verdict: 'held', reason: 'truncated' };
  if (evidenceOk === false) return { verdict: 'held', reason: 'evidence-unknown', detail: evidenceReason };
  if (disposition.result) return { verdict: 'clear', reason: null };
  if (cardOnly || !owed) return { verdict: 'not-owed', reason: null };
  return { verdict: 'owed-no-result', reason: 'no-result' };
}

export function deriveRedTeamVerdict(input = {}) {
  return deriveRedTeamVerdictDetail(input).verdict;
}

/** The drain's hold text for a detail, or null when nothing holds. Keeps the drain's wording byte-identical. */
export function redTeamVerdictHoldReason({ verdict, reason, detail } = {}) {
  if (verdict === 'clear' || verdict === 'not-owed') return null;
  if (reason === 'break') return BREAK_REASON;
  if (reason === 'evidence-unknown') return `post-accept red team evidence unknown (${detail ?? ''}); hold and inspect run evidence`;
  if (reason === 'no-result') return NO_RESULT_REASON;
  return `post-accept red team thread ${reason ?? 'unreadable'}; hold and inspect`;
}
