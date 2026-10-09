/**
 * @file scripts/conveyor/conflict-reassert-rule.mjs — card xkugvzd. Should the parked-PR conflict watch re-assert
 * its idle conflict finding on a `review:human` PR that is ALREADY labelled and STILL conflicting?
 *
 * Live 2026-10-08/09: WE PR #4481 sat 6+ hours with `review:human` + `merge-status:conflicting`, no `review:changes`.
 *   - 21:44Z a fixer started on an auto-policy review round. 21:59Z the conflict watch posted its finding
 *     (`review:changes` bounce). The already-running fixer re-pushed for the OTHER round and re-armed at 22:04Z
 *     (`review:changes` removed, `review:human` kept) without resolving the conflict.
 *   - After that no sweep acted: the #2793 idle re-assert (`idleConflictBounce`) excludes `review:human`, and the
 *     `review:human` recheck only acts on a PR carrying the watch's OWN stand-down marker. #4481 had a finding, not
 *     a stand-down, so it was skipped forever while the fix daemon refused its review-ci every tick.
 *
 * The new case: `review:human` + conflict label + no live `review:changes` + no live (unsuperseded) watcher
 * stand-down marker → re-assert, through the SAME #2793 path (same round cap, same once-per-round guard, same
 * finding, which keeps `review:human`). A live watcher marker keeps the statute recheck path, unchanged.
 *
 * Declared setting `conflict-reassert-settings.json` (`{ "conflictReassert": { "reviewHuman": "on" } }`), env
 * `WE_CONFLICT_REASSERT_REVIEW_HUMAN` beats the file; missing/malformed/`off` = the behaviour before this card.
 * An env override that is set but unparseable also resolves `off` (it never falls through to the file).
 * PURE except {@link resolveConflictReassertSettings}, which reads the settings file and FAILS to `off`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_LABELS, hasReviewLabel } from '../lib/review-escalation.mjs';
import { CONFLICT_LABEL } from './conflict-label.mjs';

export const CONFLICT_REASSERT_ENV = Object.freeze({ reviewHuman: 'WE_CONFLICT_REASSERT_REVIEW_HUMAN' });
/** Off for every switch: exactly the behaviour before card xkugvzd. */
export const CONFLICT_REASSERT_OFF = Object.freeze({ reviewHuman: false });

export const conflictReassertSettingsPath = () => join(dirname(fileURLToPath(import.meta.url)), 'conflict-reassert-settings.json');

const parseSwitch = (raw) => {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(on|true|1|yes)$/.test(s)) return true;
  if (/^(off|false|0|no)$/.test(s)) return false;
  return null;
};

/** The switches in force. Env beats the file; anything missing or malformed is `off` (today). */
export function resolveConflictReassertSettings(env = process.env, { path = conflictReassertSettingsPath(), read = readFileSync } = {}) {
  let file = {};
  try { file = JSON.parse(read(path, 'utf8'))?.conflictReassert ?? {}; } catch { file = {}; }
  if (!file || typeof file !== 'object') file = {};
  const out = {};
  for (const key of Object.keys(CONFLICT_REASSERT_OFF)) {
    const override = env?.[CONFLICT_REASSERT_ENV[key]];
    // An override that is SET but not understood (typo, empty, whitespace) fails OFF — it must never fall
    // through to the file's `on`. Only an absent override defers to the file.
    out[key] = override == null ? (parseSwitch(file[key]) ?? false) : (parseSwitch(override) ?? false);
  }
  return out;
}

/**
 * PURE. Decide whether to re-assert the idle conflict finding on an already-labelled, still-conflicting, parked
 * `review:human` PR. The caller has already established "parked + still conflicting + label already applied".
 * `hasStandDown`: the thread carries ANY trusted stand-down (a fix agent's own judgment call, or a watcher marker
 * already superseded) — never re-asserted over; a person or the statute recheck owns it.
 * @param {{labels?:Array, hasLiveWatcherMarker?:boolean, hasStandDown?:boolean, settings?:{reviewHuman?:boolean}}} [o]
 * @returns {{reassert:boolean, why:string}}
 */
export function decideConflictReassert({ labels = [], hasLiveWatcherMarker = false, hasStandDown = false, settings = CONFLICT_REASSERT_OFF } = {}) {
  if (!hasReviewLabel(labels, REVIEW_LABELS.human)) return { reassert: false, why: 'not review:human (the #2793 idle path owns it)' };
  if (!hasReviewLabel(labels, CONFLICT_LABEL)) return { reassert: false, why: `no ${CONFLICT_LABEL} label yet (fresh detection owns it)` };
  if (hasReviewLabel(labels, REVIEW_LABELS.changes)) return { reassert: false, why: 'a review:changes bounce is already live' };
  if (hasLiveWatcherMarker) return { reassert: false, why: "the watch's own stand-down marker stands (statute recheck owns it)" };
  if (hasStandDown) return { reassert: false, why: 'a stand-down is on the thread (a person owns it)' };
  if (settings?.reviewHuman !== true) return { reassert: false, why: 'conflictReassert.reviewHuman is off' };
  return { reassert: true, why: 'review:human PR still conflicting with no live review:changes and no watcher stand-down — re-assert the conflict finding' };
}
