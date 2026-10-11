/**
 * @file scripts/lib/cost-admission-facts.mjs
 * @description Card x60i0ie — the IO half of `cost-admission.mjs`: read the declared settings and the plain facts
 *   the pure rule decides on. Every read fails OPEN (an unreadable fact is `null`, which never refuses).
 *
 *   - settings:        `we:scripts/dispatch-settings.json#costAdmission` + env (`resolveCostAdmissionSettings`).
 *   - claudeUsdToday:  Claude spend for the current America/New_York day, summed from the official Claude Code
 *                      OpenTelemetry export (`claude_code.cost.usage`) that `claude-otel-collector.mjs` writes to
 *                      `<collector root>/<UTC day>.jsonl`. The ET day spans two UTC files, so both are read.
 *   - host sample:     `host-sample.mjs#sampleHost` (cached CPU idle % + free memory %), the same sample every
 *                      dispatch gate reads.
 *
 *   Codex usage is NOT re-derived here: its quota gauge already gates each launch at dispatch time
 *   (`dispatch-provider-availability.mjs` → `provider-quota-hold.mjs`), which falls back to Claude.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMemFreeMinPct } from './dispatch-throttle.mjs';
import { readSettings } from './settings-files.mjs';
import { sampleHost } from './host-sample.mjs';
import { resolveCostAdmissionSettings } from './cost-admission.mjs';
import { cutoverDecision, loadResourceGateSettings } from './resource-gate.mjs';
import { resolveCollectorRoot, etDayKeyOnly, utcDayKey } from '../operations/telemetry-summary-io.mjs';

export const COST_FACTS_TIMEZONE = 'America/New_York';
export const CLAUDE_SPEND_CACHE_MS = 60_000;

/** Settings from the declared files (we:scripts/lib/settings-files.mjs — legacy dispatch-settings.json + scripts/settings/*.json)
 *  + env; `path` reads that one file instead (tests). Never throws. */
export function readCostAdmissionSettings({ env = process.env, path } = {}) {
  let file = null;
  if (path) { try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { file = null; } } else file = readSettings();
  return resolveCostAdmissionSettings({ env, file });
}

/**
 * PURE: Claude spend (USD) in `records` whose `receivedAt` falls on ET day `dayKey`. `null` when no cost record
 * exists for that day at all (no data is not "$0 spent").
 */
export function sumClaudeUsdForDay(records, dayKey, timeZone = COST_FACTS_TIMEZONE) {
  let usd = 0;
  let seen = false;
  for (const r of Array.isArray(records) ? records : []) {
    if (r?.name !== 'claude_code.cost.usage') continue;
    const t = new Date(r.receivedAt);
    if (!Number.isFinite(t.getTime()) || etDayKeyOnly(t, timeZone) !== dayKey) continue;
    const v = Number(r.value);
    if (Number.isFinite(v)) { usd += v; seen = true; }
  }
  return seen ? usd : null;
}

/** Parse only the cost lines of a collector day file (the file is ~30k lines; most are other metrics). */
function readCostRecords(path) {
  if (!existsSync(path)) return [];
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('claude_code.cost.usage')) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return out;
}

let spendCache = null;

/** Claude USD spent today (ET). Cached for {@link CLAUDE_SPEND_CACHE_MS}. `null` when unreadable. Never throws. */
export function readClaudeUsdToday({ now = Date.now(), env = process.env, root = resolveCollectorRoot({ env }), cacheMs = CLAUDE_SPEND_CACHE_MS } = {}) {
  if (spendCache && spendCache.root === root && now - spendCache.at < cacheMs) return spendCache.usd;
  let usd = null;
  try {
    const nowDate = new Date(now);
    const dayKey = etDayKeyOnly(nowDate, COST_FACTS_TIMEZONE);
    // The ET day [00:00, 24:00) lies inside the UTC files for `today` and `today - 1` (UTC-4/-5).
    const files = [...new Set([utcDayKey(nowDate), utcDayKey(new Date(now - 24 * 3600_000))])];
    const records = files.flatMap((k) => readCostRecords(join(root, `${k}.jsonl`)));
    usd = sumClaudeUsdForDay(records, dayKey);
  } catch { usd = null; }
  spendCache = { root, at: now, usd };
  return usd;
}

/**
 * Every fact the rule needs except the per-tick in-flight count (the caller knows that). Never throws.
 * @returns {{cpuIdlePct:number|null, memFreePct:number|null, minMemFreePct:number, claudeUsdToday:number|null}}
 */
export function readCostFacts({ env = process.env, sample = () => sampleHost(), now = Date.now(), resource = lightResourceDecision } = {}) {
  let s = null;
  try { s = sample(); } catch { s = null; }
  const ok = s?.ok && Number.isFinite(s.idlePct);
  const facts = {
    cpuIdlePct: ok ? s.idlePct : null,
    memFreePct: ok && Number.isFinite(s.memFreePct) ? s.memFreePct : null,
    minMemFreePct: resolveMemFreeMinPct({ env }),
    claudeUsdToday: readClaudeUsdToday({ now, env }),
  };
  // x6nuodj — the light host check (CPU floor + free memory) decides through admit({kind:'light'}); the legacy
  // floor is its logged comparison. `null` (no decision) leaves the legacy checks in admitLaunch.
  let decision = null;
  try { decision = resource?.({ env, facts, now }) ?? null; } catch { decision = null; }
  return decision ? { ...facts, resource: decision } : facts;
}

/** IO: the shared `light` decision with the legacy light floor (`WE_MIN_CPU_IDLE_PCT_LIGHT` + free memory) logged
 *  next to it. Never throws. */
export function lightResourceDecision({ env = process.env, facts = {}, now = Date.now(), settings, gateSettings } = {}) {
  const cost = settings ?? readCostAdmissionSettings({ env });
  let legacy = { admit: true, note: 'light floor met' };
  if (Number.isFinite(facts.cpuIdlePct) && facts.cpuIdlePct < cost.lightCpuIdleMinPct) {
    legacy = { admit: false, kind: 'light-cpu-floor', why: `cpu idle ${facts.cpuIdlePct.toFixed(1)}% < light floor ${cost.lightCpuIdleMinPct}%` };
  } else if (Number.isFinite(facts.memFreePct) && Number.isFinite(facts.minMemFreePct) && facts.memFreePct < facts.minMemFreePct) {
    legacy = { admit: false, kind: 'mem-free', why: `${facts.memFreePct}% memory free < ${facts.minMemFreePct}%` };
  }
  let mode = 'enforce';
  try { mode = (gateSettings ?? loadResourceGateSettings({ env }).settings).cutover; } catch { /* the standard */ }
  return cutoverDecision({ gate: 'cost-admission.light', kind: 'light', legacy, mode, env, nowMs: now });
}
