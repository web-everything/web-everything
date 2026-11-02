/** R392(1): a repeated escalation owes an actor, bounded by trusted takeover evidence. */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { resolveCascade, readPlatformPreferences } from '../lib/policy-cascade.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && !!value.trim();
const timestamp = value => {
  const time = typeof value === 'string' && value.trim() ? Date.parse(value) : value;
  return typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 && time <= 8640000000000000 ? time : NaN;
};
const fresh = (seenAt, now, minutes) => {
  const seen = timestamp(seenAt);
  return Number.isFinite(seen) && seen <= now && now - seen <= minutes * 60000;
};
const validEntry = value => object(value) && text(value.head) && text(value.cause) && positive(value.streak)
  && text(value.lastSweepId) && Number.isFinite(timestamp(value.seenAt));

export function recordSweep({ ledger, items = [], sweepId, now, maxStreakAgeMinutes = 30 } = {}) {
  const next = {};
  const at = timestamp(now);
  if (!text(sweepId) || !Array.isArray(items) || !Number.isFinite(at) || !positive(maxStreakAgeMinutes)) return next;
  for (const item of items) {
    if (!positive(Number(item?.pr)) || !text(item?.head) || !text(item?.cause)) continue;
    const key = String(Number(item.pr));
    if (Object.hasOwn(next, key)) continue; // One observation per PR in a sweep.
    const old = object(ledger) ? ledger[key] : null;
    const matches = validEntry(old) && old.head === item.head && old.cause === item.cause;
    const replay = matches && old.lastSweepId === sweepId;
    const same = matches && fresh(old.seenAt, at, maxStreakAgeMinutes);
    next[key] = { head: item.head, cause: item.cause,
      streak: replay ? old.streak : same ? old.streak + 1 : 1, lastSweepId: sweepId,
      seenAt: replay ? old.seenAt : new Date(at).toISOString() };
  }
  return next;
}

export function owedTakeovers({ ledger, threshold = 2, takeoverCountsByHead, cap, now, maxStreakAgeMinutes = 30 } = {}) {
  const at = timestamp(now);
  if (!object(ledger) || !positive(threshold) || !positive(cap) || !object(takeoverCountsByHead)
    || !Number.isFinite(at) || !positive(maxStreakAgeMinutes)) return [];
  return Object.entries(ledger).flatMap(([key, value]) => {
    if (!positive(Number(key)) || !validEntry(value) || value.streak < threshold || !fresh(value.seenAt, at, maxStreakAgeMinutes)) return [];
    const count = takeoverCountsByHead[`${key}@${value.head}`] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count >= cap) return [];
    return [{ pr: Number(key), head: value.head, cause: value.cause, streak: value.streak }];
  });
}

const defaults = { enabled: true, threshold: 2, takeoverCapPerHead: 1, maxStreakAgeMinutes: 30 };
const variables = { enabled: 'WE_ESCALATION_ACTOR_ENABLED', threshold: 'WE_ESCALATION_ACTOR_THRESHOLD',
  takeoverCapPerHead: 'WE_ESCALATION_ACTOR_TAKEOVER_CAP', maxStreakAgeMinutes: 'WE_ESCALATION_ACTOR_MAX_STREAK_AGE_MINUTES' };
function defaultReadSettings() {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('../settings/needs-you-feed.json', import.meta.url)), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
}

function defaultReadPlatform(env) {
  const { prefs, errors } = readPlatformPreferences({ env });
  if (errors.length) throw new Error('platform preferences unreadable');
  return prefs.escalation?.actor;
}

export function resolveEscalationActorSettings({ env = process.env, readSettings = defaultReadSettings,
  readPlatform = () => defaultReadPlatform(env), log = () => {} } = {}) {
  let tool, platform;
  const readFailures = [];
  try {
    const file = readSettings();
    if (!object(file) || (file.escalation !== undefined && !object(file.escalation))) throw new Error('tool settings unreadable');
    tool = file.escalation?.actor;
    if (tool !== undefined && !object(tool)) throw new Error('tool actor settings unreadable');
  } catch { tool = {}; readFailures.push('tool-read-failed (actor disabled)'); }
  try {
    platform = readPlatform();
    if (platform !== undefined && !object(platform)) throw new Error('platform actor settings unreadable');
  } catch { platform = {}; readFailures.push('platform-read-failed (actor disabled)'); }
  const layers = { platform: {}, tool: {}, env: {} }, invalid = {};
  for (const key of Object.keys(defaults)) {
    for (const [source, raw] of [['platform', platform?.[key]], ['tool', tool?.[key]], ['env', env[variables[key]]]]) {
      if (raw === undefined) continue;
      const parsed = source === 'env' ? (key === 'enabled'
        ? ['true', '1'].includes(raw) ? true : ['false', '0'].includes(raw) ? false : undefined
        : typeof raw === 'string' && raw.trim() ? Number(raw) : undefined) : raw;
      const valid = key === 'enabled' ? typeof parsed === 'boolean'
        : Number.isSafeInteger(parsed) && parsed >= (key === 'takeoverCapPerHead' ? 0 : 1);
      layers[source][key] = valid ? parsed : key === 'enabled' ? false : 0;
      if (!valid) invalid[key] = [invalid[key], `${source}-invalid (actor disabled)`].filter(Boolean).join('; ');
    }
  }
  const resolved = resolveCascade({ standard: defaults, platform: layers.platform, tool: layers.tool, envValues: layers.env });
  for (const [key, source] of Object.entries(invalid)) if (source) resolved.sources[key] = `${resolved.sources[key]}; ${source}`;
  const invalidSources = Object.entries(invalid).filter(([, source]) => source);
  if (invalidSources.length || readFailures.length) {
    resolved.value.enabled = false;
    resolved.sources.enabled = `disabled by ${[...readFailures, ...invalidSources.map(([key, source]) => `${key}: ${source}`)].join('; ')}`;
  }
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
