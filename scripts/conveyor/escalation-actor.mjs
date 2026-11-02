/** R392(1): a repeated escalation owes an actor, bounded by trusted takeover evidence. */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { resolveCascade, platformPreference } from '../lib/policy-cascade.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && !!value.trim();
const validEntry = value => object(value) && text(value.head) && text(value.cause) && positive(value.streak) && text(value.lastSweepId);

export function recordSweep({ ledger, items = [], sweepId } = {}) {
  const next = {};
  if (!text(sweepId) || !Array.isArray(items)) return next;
  for (const item of items) {
    if (!positive(Number(item?.pr)) || !text(item?.head) || !text(item?.cause)) continue;
    const key = String(Number(item.pr));
    if (Object.hasOwn(next, key)) continue; // One observation per PR in a sweep.
    const old = object(ledger) ? ledger[key] : null;
    const same = validEntry(old) && old.head === item.head && old.cause === item.cause;
    next[key] = { head: item.head, cause: item.cause,
      streak: same ? old.streak + (old.lastSweepId === sweepId ? 0 : 1) : 1, lastSweepId: sweepId };
  }
  return next;
}

export function owedTakeovers({ ledger, threshold = 2, takeoverCountsByHead, cap } = {}) {
  if (!object(ledger) || !positive(threshold) || !positive(cap) || !object(takeoverCountsByHead)) return [];
  return Object.entries(ledger).flatMap(([key, value]) => {
    if (!positive(Number(key)) || !validEntry(value) || value.streak < threshold) return [];
    const count = takeoverCountsByHead[`${key}@${value.head}`] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count >= cap) return [];
    return [{ pr: Number(key), head: value.head, cause: value.cause, streak: value.streak }];
  });
}

const defaults = { enabled: true, threshold: 2, takeoverCapPerHead: 1 };
const variables = { enabled: 'WE_ESCALATION_ACTOR_ENABLED', threshold: 'WE_ESCALATION_ACTOR_THRESHOLD', takeoverCapPerHead: 'WE_ESCALATION_ACTOR_TAKEOVER_CAP' };
function defaultReadSettings() {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('../settings/needs-you-feed.json', import.meta.url)), 'utf8')); }
  catch { return {}; }
}

export function resolveEscalationActorSettings({ env = process.env, readSettings = defaultReadSettings,
  readPlatform = () => platformPreference('escalation', { env })?.actor, log = () => {} } = {}) {
  let tool, platform;
  try { tool = readSettings()?.escalation?.actor; } catch { tool = {}; }
  try { platform = readPlatform(); } catch { platform = {}; }
  const layers = { platform: {}, tool: {}, env: {} }, invalid = {};
  for (const key of Object.keys(defaults)) {
    for (const [source, raw] of [['platform', platform?.[key]], ['tool', tool?.[key]], ['env', env[variables[key]]]]) {
      if (raw === undefined) continue;
      const parsed = source === 'env' ? (key === 'enabled'
        ? ['true', '1'].includes(raw) ? true : ['false', '0'].includes(raw) ? false : undefined
        : typeof raw === 'string' && raw.trim() ? Number(raw) : undefined) : raw;
      const valid = key === 'enabled' ? typeof parsed === 'boolean'
        : Number.isSafeInteger(parsed) && parsed >= (key === 'threshold' ? 1 : 0);
      layers[source][key] = valid ? parsed : defaults[key];
      invalid[key] = valid ? null : `${source}-invalid (standard default)`;
    }
  }
  const resolved = resolveCascade({ standard: defaults, platform: layers.platform, tool: layers.tool, envValues: layers.env });
  for (const [key, source] of Object.entries(invalid)) if (source) resolved.sources[key] = source;
  for (const key of Object.keys(defaults)) log(`escalation.actor.${key}=${resolved.value[key]} source=${resolved.sources[key]}`);
  return { ...resolved.value, sources: resolved.sources };
}

// Namespace by feed filename; the JSON contains one PR-keyed ledger per repository slug.
export const escalationLedgerPath = feed => `${feed}.escalation-streaks.json`;
export function loadEscalationLedger(path, { read = readFileSync } = {}) {
  try { const value = JSON.parse(read(path, 'utf8')); return object(value) ? value : {}; }
  catch { return {}; }
}
export function saveEscalationLedger(path, ledger, { mkdir = mkdirSync, write = writeJsonAtomic } = {}) {
  mkdir(dirname(path), { recursive: true });
  write(path, ledger);
}
