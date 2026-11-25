/**
 * @file scripts/lib/review-seat-routing.mjs
 * @description `review.seatRouting.correctness` (operator ruling B): the deciding correctness seat goes to the vendor
 *   that did NOT build the PR. Mode `A` (built-in) keeps today's route (claude/sonnet). Mode `B`: a Claude-built PR
 *   gets a codex correctness seat; a Codex-built PR keeps claude/sonnet; an UNKNOWN builder keeps today's route.
 *   Only the correctness seat's vendor changes: the security seat and every mandatory lens stay seated as before.
 *   Cascade: built-in `A` -> `we:scripts/settings/review.json` `seatRouting.correctness` -> env
 *   `WE_REVIEW_SEAT_ROUTING_CORRECTNESS`. PURE except the settings-file read.
 */
import { readFileSync } from 'node:fs';
import { parseDelegationMarker } from './delegation-marker.mjs';
import { REVIEW_SETTINGS_FILE } from './review-seat-settings.mjs';

export const SEAT_ROUTING_CORRECTNESS_ENV = 'WE_REVIEW_SEAT_ROUTING_CORRECTNESS';

const normMode = (v) => {
  const x = String(v ?? '').trim().toUpperCase();
  return x === 'A' || x === 'B' ? x : null;
};

/** Resolve the correctness routing mode: env > settings file > built-in `A`. Never throws. */
export function resolveCorrectnessSeatRouting({ env = process.env, file = REVIEW_SETTINGS_FILE, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const fromEnv = normMode(env?.[SEAT_ROUTING_CORRECTNESS_ENV]);
  if (fromEnv) return { value: fromEnv, source: 'env' };
  try {
    const f = normMode(JSON.parse(readFile(file))?.seatRouting?.correctness);
    if (f) return { value: f, source: 'settings' };
  } catch { /* built-in */ }
  return { value: 'A', source: 'default' };
}

/**
 * The builder whose work is under review: the PR's delegation marker when it carries one, else the
 * `Co-Authored-By: Claude ...` trailer of the head commit (or the PR body), else unknown. PURE.
 * @returns {{provider:string, model:string, taskType:(string|null), delegated:boolean, source:string}}
 */
export function resolveBuilder({ body = '', headMessage = '' } = {}) {
  const d = parseDelegationMarker(String(body ?? ''));
  if (d) return { provider: d.provider, model: d.model, taskType: d.taskType, delegated: true, source: 'delegation-marker' };
  const m = String(headMessage ?? '').match(/^Co-Authored-By:\s*Claude\s+([^<\n]+?)\s*</im);
  if (m) {
    const model = `claude-${m[1].replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/\s+/g, '-')}`;
    return { provider: 'claude', model, taskType: null, delegated: false, source: 'co-authored-by' };
  }
  return { provider: 'unknown', model: 'unknown', taskType: null, delegated: false, source: 'none' };
}

/**
 * Which vendor judges the correctness seat. `'codex'` only in mode B for a Claude-built PR; `'claude'` otherwise
 * (a Codex-built PR, an unknown builder, or mode A), which is today's route and never weaker. PURE.
 */
export function correctnessSeatVendor({ mode = 'A', body = '', headMessage = '' } = {}) {
  if (normMode(mode) !== 'B') return 'claude';
  return resolveBuilder({ body, headMessage }).provider === 'claude' ? 'codex' : 'claude';
}
