/**
 * @file scripts/lib/review-final-head-seats.mjs
 * @description R365 fix 5 — RUN THE ADDED (non-Claude) REVIEW SEATS ONLY ON THE HEAD THAT WILL BE JUDGED FINAL.
 *
 *   The added seats (`review-extra-seats.mjs`) used to run on every reviewed head, so a bounced or superseded head
 *   paid 3 Codex seat runs (354 a day) for a verdict nobody would keep. A head gets NO seat only when it is
 *   positively intermediate: the mandatory lenses returned `changes` on it (a fixer push follows), or a full 40-char
 *   live head differs from the full reviewed head (superseded). Anything else runs the seats, including accepts,
 *   human-advisory accepts, parked or unknown verdicts and unknown live heads. FAIL-OPEN throughout, so the final
 *   accepted head never loses its seats to a lookup failure. There is no time debounce.
 *   The seat floor (`minNonClaudeSeats`) lives in `review-pr.mjs` and is untouched by this.
 *
 *   SETTING `review.finalHeadSeats` (policy cascade: standard → platform → tool `finalHeadSeats` in
 *   `scripts/settings/review.json` → env `WE_REVIEW_FINAL_HEAD_SEATS`): `off` (every head, the old order),
 *   `shadow` (log what would be skipped, still run — the standard), `on` (skip). PURE except the settings read.
 */
import { readFileSync } from 'node:fs';
import { cascadePolicy } from './policy-cascade.mjs';
import { VERDICTS } from './jury-core.mjs';
import { redTeamOwedFor } from './review-red-team-policy.mjs';
import { TOOL_SETTINGS_FILE } from './review-speculative-red-team.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/i;
export const FINAL_HEAD_SEATS_ENV = 'WE_REVIEW_FINAL_HEAD_SEATS';
export const FINAL_HEAD_SEATS_MODES = ['off', 'shadow', 'on'];

/** @returns {{mode:'off'|'shadow'|'on'}} */
export function resolveFinalHeadSeats({ env = process.env, file = TOOL_SETTINGS_FILE, readFile = (p) => readFileSync(p, 'utf8'), platform, log } = {}) {
  let tool = {};
  try { const t = JSON.parse(readFile(file))?.finalHeadSeats; if (t && typeof t === 'object') tool = t; } catch { /* layer absent */ }
  const envMode = String(env?.[FINAL_HEAD_SEATS_ENV] ?? '').trim().toLowerCase();
  const r = cascadePolicy('review.finalHeadSeats', tool, {
    standard: { mode: 'shadow' },
    ...(platform === undefined ? {} : { platform }),
    env,
    ...(log ? { log } : {}),
    envValues: { mode: FINAL_HEAD_SEATS_MODES.includes(envMode) ? envMode : undefined },
    valid: { mode: (v) => FINAL_HEAD_SEATS_MODES.includes(v) },
  });
  return { mode: r.value?.mode ?? 'shadow' };
}

/**
 * Should the added seats run for this finished review? PURE.
 * @param {{loopPayload:object, liveHead?:string|null, setting:{mode:string}}} o
 * @returns {{run:boolean, skip:boolean, reason:string}} `skip` is true only when mode is `on` and the head is not final;
 *   `reason` names why a head is not final (also in shadow, where `run` stays true).
 */
export function decideFinalHeadSeats({ loopPayload, liveHead = null, setting }) {
  const mode = setting?.mode ?? 'shadow';
  if (mode === 'off') return { run: true, skip: false, reason: 'final-head seats off' };
  const reviewed = loopPayload?.findings?.read?.netBasis?.rev;
  let notFinal = null;
  if (!loopPayload?.verdict || typeof loopPayload.verdict !== 'object') return { run: true, skip: false, reason: 'no verdict to judge finality by (fail-open)' };
  // Only a POSITIVE `changes` verdict (a fixer push follows) proves the head intermediate; parked, unknown or odd
  // verdicts may still be the head a human accepts, so they run.
  if (loopPayload.verdict.verdict === VERDICTS.CHANGES && !redTeamOwedFor(loopPayload)) notFinal = 'the mandatory lenses asked for changes on this head (a fix push follows)';
  else if (FULL_SHA.test(String(liveHead)) && FULL_SHA.test(String(reviewed)) && liveHead.toLowerCase() !== reviewed.toLowerCase()) {
    notFinal = `head superseded: reviewed ${reviewed.slice(0, 12)}, live ${liveHead.slice(0, 12)}`;
  }
  if (!notFinal) return { run: true, skip: false, reason: 'final head' };
  return { run: mode !== 'on', skip: mode === 'on', reason: notFinal };
}
