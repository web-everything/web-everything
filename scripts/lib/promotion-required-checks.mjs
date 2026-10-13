// Absent merge-time checks must not strand drafts: live #5060 (2026-10-13).
import { readFileSync } from 'node:fs';
import { PLATFORM_PREFERENCES_PATH } from './merge-delivery-policy.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

const key = 'absentRequiredChecksNotApplicable';
const envKey = 'WE_DRAFT_PROMOTION_ABSENT_NOT_APPLICABLE';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const checkNames = value => Array.isArray(value) && value.every(name => typeof name === 'string' && name.trim().length > 0);
let logged = false;

/** Promotion only: any existing row keeps the check required, regardless of verdict. */
export function promotionRequiredChecks(requiredChecks, rollupRows, notApplicable) {
  if (!Array.isArray(requiredChecks) || !requiredChecks.length || !Array.isArray(rollupRows)
    || !Array.isArray(notApplicable) || !notApplicable.length) return requiredChecks;
  const present = new Set(rollupRows.flatMap(row => [row?.name, row?.context]));
  const filtered = requiredChecks.filter(name => !notApplicable.includes(name) || present.has(name));
  // An empty required list would select reduceCheckState's exclusion mode.
  return filtered.length ? filtered : requiredChecks;
}

/** Standard → platform → declared repo → env; ignore and report invalid layers. */
export function loadPromotionRequiredChecksSetting({ env = process.env, readFile = readFileSync,
  readDeclared = readDeclaredSettings, log = line => console.error(line) } = {}) {
  let result = { value: ['merge-gate'], source: 'standard' };
  const ignored = [];
  const ignore = (source, reason) => ignored.push({ source, reason });
  const apply = (source, doc) => {
    if (!object(doc) || (doc.draftPromotion !== undefined && !object(doc.draftPromotion))) {
      ignore(source, 'invalid draftPromotion settings block');
      return;
    }
    const value = doc.draftPromotion?.[key];
    if (value === undefined) return;
    if (!checkNames(value)) { ignore(source, `invalid draftPromotion.${key}: expected an array of check names`); return; }
    result = { value: [...value], source };
  };
  try { apply('platform', JSON.parse(readFile(PLATFORM_PREFERENCES_PATH, 'utf8'))); }
  catch (e) { if (e?.code !== 'ENOENT') ignore('platform', `unreadable preferences: ${e.message}`); }
  try {
    const declared = readDeclared();
    for (const error of declared.errors ?? []) ignore('repo', `unreadable ${error.source}: ${error.error}`);
    if (declared.duplicates?.some(d => d.path === `draftPromotion.${key}` || d.path === 'draftPromotion')) {
      ignore('repo', `duplicate draftPromotion.${key}`);
    } else apply('repo', declared.settings);
  } catch (e) { ignore('repo', `unreadable settings: ${e.message}`); }
  const override = env?.[envKey];
  if (override !== undefined) {
    const value = typeof override === 'string' ? (override === '' ? [] : override.split(',').map(name => name.trim())) : null;
    if (checkNames(value)) result = { value, source: 'env' };
    else ignore('env', `invalid ${envKey}: expected comma-separated check names`);
  }
  if (!logged) {
    logged = true;
    log(`draft-promotion · draftPromotion.${key}=${JSON.stringify(result.value)} (source: ${result.source})`);
    for (const entry of ignored) log(`draft-promotion · ignored ${entry.source}: ${entry.reason}`);
  }
  return { ...result, ignored };
}
