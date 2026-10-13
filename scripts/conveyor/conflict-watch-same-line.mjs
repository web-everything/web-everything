import { readFileSync } from 'node:fs';
import { PLATFORM_PREFERENCES_PATH } from '../lib/merge-delivery-policy.mjs';
import { readDeclaredSettings } from '../lib/settings-files.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Invalid layers fail closed to stand-down; later valid layers still win. */
export function resolveSameLineConflictSetting({ platform = {}, repo = {}, env = {}, readErrors = [] } = {}) {
  let result = { value: 'fixer', source: 'standard' };
  const ignored = [...readErrors];
  for (const [source, doc] of [['platform', platform], ['repo', repo], ['env', env]]) {
    if (readErrors.some(error => error.source === source)) {
      result = { value: 'stand-down', source };
      continue;
    }
    const block = doc?.conflictWatch;
    if (source !== 'env' && (!object(doc) || (block !== undefined && !object(block)))) {
      ignored.push({ source, reason: 'invalid conflictWatch settings block' });
      result = { value: 'stand-down', source };
      continue;
    }
    const value = source === 'env' ? doc?.WE_CONFLICT_WATCH_SAME_LINE : block?.sameLineConflict;
    if (value === undefined) continue;
    if (!['fixer', 'stand-down'].includes(value)) {
      ignored.push({ source, reason: 'invalid conflictWatch.sameLineConflict: expected fixer|stand-down' });
      result = { value: 'stand-down', source };
      continue;
    }
    result = { value, source };
  }
  return { ...result, ignored };
}

let logged = false;
/** Read the cascade and log its effective setting once per process. */
export function loadSameLineConflictSetting({ env = process.env, readFile = readFileSync, readDeclared = readDeclaredSettings, log = line => console.error(line) } = {}) {
  let platform = {}, repo = {};
  const readErrors = [];
  try { platform = JSON.parse(readFile(PLATFORM_PREFERENCES_PATH, 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') readErrors.push({ source: 'platform', reason: `platform unreadable: ${error.message}` }); }
  try {
    const declared = readDeclared();
    repo = declared.settings;
    if (declared.errors?.length) readErrors.push({ source: 'repo', reason: 'repo settings unreadable' });
    if (declared.duplicates?.some(d => /^conflictWatch(?:\.|$)/.test(d.path))) readErrors.push({ source: 'repo', reason: 'duplicate conflictWatch settings' });
  } catch (error) { readErrors.push({ source: 'repo', reason: `repo settings unreadable: ${error.message}` }); }
  const result = resolveSameLineConflictSetting({ platform, repo, env, readErrors });
  if (!logged) {
    logged = true;
    log(`parked-pr-conflict-watch · conflictWatch.sameLineConflict=${result.value} (source: ${result.source})`);
  }
  for (const { source, reason } of result.ignored) log(`parked-pr-conflict-watch · fail-closed ${source}: ${reason}`);
  return result;
}
