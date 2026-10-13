/**
 * The `reviewClearance` settings block (we:scripts/settings/review-clearance.json), live #5193 (2026-10-13).
 * A leaf (no review-escalation import), so the pure clearance parser can read its one switch without a cycle.
 * Cascade: standard `on` -> platform preferences -> repo settings -> env; any invalid layer fails to `off`.
 */
import { readFileSync } from 'node:fs';
import { resolveHumanGateRemovalSetting } from './merge-gate-hold-class.mjs';
import { PLATFORM_PREFERENCES_PATH } from './merge-delivery-policy.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

export const REVIEW_CLEARANCE_SETTINGS = {
  rerunStaleGateOnClearance: { envKey: 'WE_REVIEW_CLEARANCE_RERUN_STALE_GATE' },
  reviewHoldIsNotCiFailure: { envKey: 'WE_REVIEW_CLEARANCE_REVIEW_HOLD_NOT_CI' },
  rearmRequiresHeadChange: { envKey: 'WE_REVIEW_CLEARANCE_REARM_REQUIRES_HEAD_CHANGE' },
  ciHealRequiresFailingChecks: { envKey: 'WE_REVIEW_CLEARANCE_CI_HEAL_REQUIRES_FAILING_CHECKS' },
  restoreNoPushRearm: { envKey: 'WE_REVIEW_CLEARANCE_RESTORE_NO_PUSH_REARM' },
  humanClearanceSurvivesSameShaAccept: { envKey: 'WE_REVIEW_CLEARANCE_HUMAN_SURVIVES_SAME_SHA_ACCEPT' },
};
export function resolveReviewClearanceSetting({ key, platform = {}, repo = {}, env = {}, readErrors = [] } = {}) {
  if (!REVIEW_CLEARANCE_SETTINGS[key]) return { value: 'off', source: 'unreadable', why: 'unknown reviewClearance setting' };
  if (readErrors.length) return { value: 'off', source: 'unreadable', why: readErrors.join('; ') };
  const { ignored, ...result } = resolveHumanGateRemovalSetting({ platform, repo, env, blockName: 'reviewClearance', key, envKey: REVIEW_CLEARANCE_SETTINGS[key].envKey });
  return result;
}
const logged = new Set();
export function loadReviewClearanceSetting({ key, env = process.env, readFile = readFileSync, readDeclared = readDeclaredSettings, log = line => console.error(line) } = {}) {
  let platform = {}, repo = {};
  const readErrors = [];
  try { platform = JSON.parse(readFile(PLATFORM_PREFERENCES_PATH, 'utf8')); }
  catch (e) { if (e?.code !== 'ENOENT') readErrors.push(`platform unreadable: ${e.message}`); }
  try {
    const declared = readDeclared();
    repo = declared.settings;
    if (declared.errors?.length) readErrors.push('repo settings unreadable');
    if (declared.duplicates?.some(d => /^reviewClearance(?:\.|$)/.test(d.path))) readErrors.push('duplicate reviewClearance settings');
  } catch (e) { readErrors.push(`repo settings unreadable: ${e.message}`); }
  const result = resolveReviewClearanceSetting({ key, platform, repo, env, readErrors });
  if (!logged.has(key)) {
    logged.add(key);
    log(`review-clearance · reviewClearance.${key}=${result.value} (source: ${result.source})`);
  }
  return result;
}

