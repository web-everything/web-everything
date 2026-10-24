/** Same-head blocking-label stall detection. Pure core with injected signal IO. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { cascadePolicy, formatCascadeSourcesLine, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { redactCommandLine } from '../operations/command-redact.mjs';
import { scrubText } from './health-watch-core.mjs';

export const DETECTOR_DEFAULTS = { enabled: true, sameLabelMinutes: 60, repeatedReasonCount: 5,
  blockingLabels: ['red-team:pending', 'review:pending', 'status:fixing'] };
const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '../settings/pr-stall-sweep.json');
const message = e => scrubText(redactCommandLine(stripVTControlCharacters(String(e?.message ?? e).slice(0, 4096))
  .normalize('NFKC').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' '))).slice(0, 200);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = v => Number.isSafeInteger(v) && v > 0;

/** Resolve every leaf independently; unusable leaves fall back to the standard. Never throws. */
export function resolveDetectorSettings({ env = process.env, read = readFileSync, log = console.error } = {}) {
  const errors = [], fallback = new Set();
  let tool = {};
  try {
    const root = JSON.parse(read(SETTINGS, 'utf8'));
    if (!object(root)) throw new Error('settings root is not an object');
    tool = root.prStallDetector ?? {};
  } catch (e) { errors.push(`settings: ${message(e)}`); }
  const platform = readPlatformPreferences({ env, readFile: read });
  errors.push(...platform.errors);
  const valid = { enabled: v => typeof v === 'boolean', sameLabelMinutes: positive, repeatedReasonCount: positive,
    blockingLabels: v => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim()) };
  const sanitize = (block, layer) => {
    if (!object(block)) { errors.push(`${layer}: prStallDetector is not an object`); return {}; }
    return Object.fromEntries(Object.keys(DETECTOR_DEFAULTS).filter(k => Object.hasOwn(block, k)).map(k => {
      if (valid[k](block[k])) return [k, block[k]];
      errors.push(`${layer}.${k}: invalid value; using standard`);
      fallback.add(`${layer}.${k}`);
      return [k, DETECTOR_DEFAULTS[k]];
    }));
  };
  const envValues = {};
  for (const k of ['enabled', 'sameLabelMinutes', 'repeatedReasonCount']) {
    const raw = env[`WE_PR_STALL_DETECTOR_${k.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`];
    if (raw === undefined) continue;
    envValues[k] = k === 'enabled' ? (['true', '1'].includes(raw) ? true : ['false', '0'].includes(raw) ? false : raw) : Number(raw);
    if (!valid[k](envValues[k])) {
      errors.push(`env.${k}: invalid value; using standard`); envValues[k] = DETECTOR_DEFAULTS[k]; fallback.add(`env.${k}`);
    }
  }
  const out = cascadePolicy('prStallDetector', sanitize(tool, 'tool'), { standard: DETECTOR_DEFAULTS,
    platform: sanitize(platform.prefs.prStallDetector ?? {}, 'platform'), envValues, valid, env, log: () => {} });
  for (const k of Object.keys(out.sources)) if (fallback.has(`${out.sources[k]}.${k}`)) out.sources[k] = 'standard';
  try { log(formatCascadeSourcesLine('prStallDetector', out)); } catch { /* logging is best effort */ }
  return { value: out.value, sources: out.sources, errors: [...errors, ...out.invalid] };
}

export function normalizeReason(line) {
  return String(line ?? '').replace(/^\s*(?:\[[^\]]+\]|\d{4}-\d{2}-\d{2}T\S+)\s*/, '')
    .replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);
}

export const REMEDIES = [
  { match: /already-reviewed-head/i, label: 'red-team:pending',
    remedy: 'red-team-on-skip not live on review daemon (load scripts/lib/review-red-team-on-skip.mjs via prototype-load)' },
  { match: /[\s\S]*/, label: 'review:pending', remedy: 'review daemon not dispatching: check review-daemon log / lane availability' },
  { match: /[\s\S]*/, label: 'status:fixing', remedy: 'fix claim has no live job: check fix-dispatch-daemon' },
  { match: /[\s\S]*/, label: 'red-team:pending', remedy: 'red team never ran: check red-team gate' },
  { match: /[\s\S]*/, remedy: 'inspect daemon log for the repeating reason' },
];

/** Validate a PR before either filtering or detecting, including unreadable properties. */
function identity(pr, blockingLabels) {
  if (!pr || typeof pr.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(pr.repo)
    || !positive(pr.number)) throw new Error('invalid PR identity');
  if (!Array.isArray(pr.labels)) throw new Error('labels are not an array');
  const labels = pr.labels.map(l => typeof l === 'string' ? l : l?.name);
  if (labels.some(l => typeof l !== 'string')) throw new Error('label missing or invalid');
  // Only a PR carrying a blocking label needs a readable head; others are out of scope, not errors.
  if (labels.some(l => blockingLabels.includes(l)) && (typeof pr.headRefOid !== 'string' || !/^[a-f0-9]{40}$/i.test(pr.headRefOid))) throw new Error('head missing or invalid');
  return { key: `${pr.repo}#${pr.number}`, head: String(pr.headRefOid ?? '').toLowerCase(), labels };
}
function prError(pr, e) {
  let n = 'unknown';
  try { n = pr?.number ?? n; } catch { /* unreadable identity */ }
  return `${n}: ${message(e)}`;
}
function failureKey(pr) {
  try {
    return typeof pr?.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(pr.repo) && positive(pr.number)
      ? `${pr.repo}#${pr.number}` : null;
  } catch { return null; }
}

/** PURE: retain only current PR/head/label clocks, and emit at most one item per PR/head. */
export function detectStalls({ prs, daemons = {}, seen = {}, now = Date.now(), settings = DETECTOR_DEFAULTS }) {
  const items = new Map(), nextSeen = {}, errors = [], failedPrKeys = [];
  if (!Array.isArray(prs)) return { items: [], nextSeen, errors: ['PR listing is not an array'] };
  for (const pr of prs) {
    try {
      const { key, head, labels } = identity(pr, settings.blockingLabels);
      const blocking = labels.filter(l => settings.blockingLabels.includes(l));
      if (!blocking.length) continue;
      const entries = Object.hasOwn(daemons, key) ? daemons[key] : [];
      if (!Array.isArray(entries)) throw new Error('daemon signals are not an array');
      const groups = new Map(); let progress = -Infinity;
      for (const entry of entries) {
        // Health refusals carry epoch milliseconds; log entries carry ISO dates (T or space separator).
        const at = typeof entry?.at === 'number' ? entry.at
          : typeof entry?.at === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(entry.at) ? Date.parse(entry.at) : NaN;
        if (!Number.isFinite(at) || !['progress', 'refusal', 'diagnostic'].includes(entry?.kind)) throw new Error('unreadable daemon timestamp or kind');
        if (entry.kind === 'progress') { progress = Math.max(progress, at); continue; }
        if (typeof entry.reason !== 'string') throw new Error('unreadable daemon reason');
        const reason = message(entry.reason);
        const normalized = normalizeReason(reason);
        const group = groups.get(normalized) ?? { count: 0, first: at, last: at, raw: reason };
        group.count++; group.first = Math.min(group.first, at); group.last = Math.max(group.last, at);
        groups.set(normalized, group);
      }
      const top = [...groups.values()].sort((a, b) => b.count - a.count)[0];
      const repeating = [...groups.values()].filter(g => g.count > 1);
      const earliest = repeating.length ? Math.min(...repeating.map(g => g.first)) : now;
      const candidates = [], clocks = {};
      for (const label of new Set(blocking)) {
        const clock = `${key}@${head}|${label}`;
        if (seen[clock] !== undefined && !Number.isFinite(seen[clock])) throw new Error('invalid first-seen clock');
        const since = Math.min(seen[clock] ?? now, earliest);
        clocks[clock] = since;
        if (now - since <= settings.sameLabelMinutes * 60000
          && !(top?.count > settings.repeatedReasonCount && progress <= top.last)) continue;
        const stalledMinutes = Math.max(0, Math.floor((now - since) / 60000));
        const reasonLine = top?.raw ?? 'no repeating reason observed';
        candidates.push({ lane: 'operator', repo: pr.repo, pr: pr.number, head, state: 'stalled-same-head',
          title: pr.title, label, stalledMinutes, reason: `${label} on same head ${stalledMinutes} min; repeating: ${reasonLine}`,
          repeatingReason: top?.raw ?? '', repeatCount: top?.count ?? 0,
          remedy: REMEDIES.find(r => (!r.label || r.label === label) && r.match.test(reasonLine)).remedy,
          command: `gh pr view ${pr.number} --repo ${pr.repo} --comments`,
          evidence: [`${label} since ${new Date(since).toISOString()}`, `${top?.count ?? 0} matching daemon lines`, reasonLine],
          action: 'stalled-detector' });
      }
      for (const item of candidates) {
        const id = `${key}@${head}`;
        if (!items.has(id) || items.get(id).stalledMinutes < item.stalledMinutes) items.set(id, item);
      }
      Object.assign(nextSeen, clocks);
    } catch (e) { errors.push(prError(pr, e)); const key = failureKey(pr); if (key) failedPrKeys.push(key); }
  }
  return { items: [...items.values()], nextSeen, errors, failedPrKeys };
}

/** IO shell: read the blocking PRs' signals once and adapt collectOwnerSignals' prKey map. */
export async function runDetector({ prs, readSignals, seen = {}, now = Date.now(), env = process.env, log = console.error }) {
  const resolved = resolveDetectorSettings({ env, log });
  const { enabled } = resolved.value;
  const errors = [...resolved.errors];
  if (!enabled) return { enabled, items: [], nextSeen: seen, errors };
  const filtered = [], failedPrKeys = [];
  if (!Array.isArray(prs)) errors.push('PR listing is not an array');
  for (const pr of Array.isArray(prs) ? prs : []) {
    try { if (identity(pr, resolved.value.blockingLabels).labels.some(l => resolved.value.blockingLabels.includes(l))) filtered.push(pr); }
    catch (e) { errors.push(prError(pr, e)); const key = failureKey(pr); if (key) failedPrKeys.push(key); }
  }
  const daemons = {};
  try {
    const signals = await readSignals({ prs: filtered });
    if (!object(signals)) throw new Error('owner signals are not an object');
    for (const pr of filtered) {
      const { key } = identity(pr, resolved.value.blockingLabels);
      if (!Array.isArray(signals[key]?.daemons)) errors.push(`${key}: daemon signals missing or unreadable`);
      daemons[key] = signals[key]?.daemons ?? null;
    }
  } catch (e) {
    errors.push(`signals: ${message(e)}`);
    return { enabled, items: [], nextSeen: seen, errors };
  }
  const out = detectStalls({ prs: filtered, daemons, seen, now, settings: resolved.value });
  return { ...out, enabled, errors: [...errors, ...out.errors], failedPrKeys: [...failedPrKeys, ...out.failedPrKeys] };
}
