import { readFileSync } from 'node:fs';
import { PLATFORM_PREFERENCES_PATH } from '../lib/merge-delivery-policy.mjs';
import { readDeclaredSettings } from '../lib/settings-files.mjs';

const keys = {
  advisoryReviewOnHumanHandoff: { standard: 'on', values: ['on', 'off'], env: 'WE_PR_OWNERSHIP_ADVISORY_ON_HANDOFF' },
  unlabeledRedAgentPr: { standard: 'review-label', values: ['review-label', 'off'], env: 'WE_PR_OWNERSHIP_UNLABELED_RED' },
};

/** Cards 273/278: each ownership preference resolves independently; invalid layers are ignored. */
export function resolvePrOwnershipSettings({ env = {}, platform = {}, repo = {} } = {}) {
  return Object.fromEntries(Object.entries(keys).map(([key, config]) => {
    let result = { value: config.standard, source: 'standard' };
    const ignored = [];
    for (const [source, doc] of [['platform', platform], ['repo', repo], ['env', env]]) {
      const block = doc?.prOwnership;
      if (source !== 'env' && (!doc || typeof doc !== 'object' || Array.isArray(doc)
          || (block !== undefined && (!block || typeof block !== 'object' || Array.isArray(block))))) {
        ignored.push({ source, reason: 'invalid prOwnership settings block' });
        continue;
      }
      const value = source === 'env' ? doc?.[config.env] : block?.[key];
      if (value === undefined) continue;
      if (!config.values.includes(value)) {
        ignored.push({ source, reason: `invalid prOwnership.${key}: expected ${config.values.join('|')}` });
        continue;
      }
      result = { value, source };
    }
    return [key, ignored.length ? { ...result, ignored } : result];
  }));
}

/** Unreadable settings throw so the shell can retain the pure core's defaults. */
export function loadPrOwnershipSettings({ env = process.env, readFile = readFileSync, readDeclared = readDeclaredSettings } = {}) {
  let platform = {};
  try { platform = JSON.parse(readFile(PLATFORM_PREFERENCES_PATH, 'utf8')); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
  const declared = readDeclared();
  if (declared.errors?.length || declared.duplicates?.some(d => /^prOwnership(?:\.|$)/.test(d.path))) {
    throw new Error('prOwnership declared settings unreadable');
  }
  return resolvePrOwnershipSettings({ env, platform, repo: declared.settings });
}
