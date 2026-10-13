/**
 * @file scripts/lib/ledger-readiness-daily.mjs
 * @description The NIGHTLY ledger-readiness check — a product feature run by the health watch's tick
 * (we:scripts/conveyor/health-watch.mjs), not a chat ritual. Once per ET day it computes the same measure as
 * `node scripts/ledger-readiness.mjs` (we:scripts/lib/ledger-promotion-readiness.mjs), appends ONE JSON line to the
 * history file, and hands the latest line to the `ledger-readiness-regressed` health smell.
 *
 * READ-ONLY toward PRs and settings: it never changes mergeGate.reviewAuthority, labels, or any PR. It only appends
 * to its own history file.
 *
 * WHEN — cascade setting `verdictLedger.promotion.dailyCheck` (standard → repo settings → env), source layer logged:
 *   enabled (bool, standard true; env WE_LEDGER_DAILY_CHECK_ENABLED=true|false)
 *   at      ('quiet-start' | 'HH:MM', standard 'quiet-start'; env WE_LEDGER_DAILY_CHECK_AT)
 *           'quiet-start' = the quiet-hours start (we:scripts/quiet-hours-settings.json `start`, default 22:00 in its
 *           time zone, America/New_York). 'HH:MM' = that local time in the quiet-hours time zone.
 *   Either way, the operator turning quiet mode on (the quiet-mode toggle file, "good night") runs it early.
 *   At most one line per ET day: a line already written for today's ET day means "not due".
 *
 * HISTORY FILE — `<health dir>/ledger-readiness-history.jsonl` (the health watch's pinned state dir, see
 * `health-watch-section.mjs#healthDir`; by default `<daemon state root>/.conveyor/health/`). Append-only JSONL, one
 * object per ET day, `schema: 1`:
 *   { schema, day, at, trigger, ready, blockers[], agreementPct, previousAgreementPct, agreementDelta, agree,
 *     disagree, unreadable, transient, unsafe, comparedPRs, shadowDays, window{from,to}, minAgreementPct,
 *     maxUnsafeDisagreements, unsafeOverLimit, agreementDropped, topDisagreeReasons[{reason,n}] (top 5),
 *     settings (formatted promotion settings with source layers), dailyCheck (formatted dailyCheck settings) }
 * A morning status reads the LAST line (`readLatestLines(path, 2)` returns it plus the line before).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { etDay } from './review-ledger-history.mjs';
import { measureReadiness, readShadowRuns, resolvePromotionSettings, formatPromotionSettings } from './ledger-promotion-readiness.mjs';
import { readSettings } from './settings-files.mjs';
import { DEFAULT_QUIET_SETTINGS, localMinutes, mergeSettings, parseHHMM, toggleActive } from './quiet-hours.mjs';
import { loadQuietSettings, readToggle } from './quiet-hours-io.mjs';

export const HISTORY_FILE = 'ledger-readiness-history.jsonl';
export const HISTORY_SCHEMA = 1;
/** Mirrors PLATFORM_VERDICT_LEDGER_DEFAULTS.promotion.dailyCheck in config/platformDefaults.ts (a test pins it). */
export const DAILY_CHECK_DEFAULTS = Object.freeze({ enabled: true, at: 'quiet-start' });
const ENV_KEYS = { enabled: 'WE_LEDGER_DAILY_CHECK_ENABLED', at: 'WE_LEDGER_DAILY_CHECK_AT' };

export const ledgerReadinessHistoryPath = (healthDirPath) => join(healthDirPath, HISTORY_FILE);

const validAt = (v) => v === 'quiet-start' || (typeof v === 'string' && parseHHMM(v) !== null);
const envBool = (raw) => ({ true: true, on: true, 1: true, false: false, off: false, 0: false })[String(raw).trim().toLowerCase()];

/** Pure cascade (standard → repo → env). An invalid higher layer is reported and leaves the lower layer in place. */
export function resolveDailyCheckSettings({ repo, env } = {}) {
  const settings = { ...DAILY_CHECK_DEFAULTS }, sources = { enabled: 'standard', at: 'standard' }, invalid = [];
  const layer = repo?.verdictLedger?.promotion?.dailyCheck;
  if (layer && typeof layer === 'object') {
    if (Object.hasOwn(layer, 'enabled')) {
      if (typeof layer.enabled === 'boolean') { settings.enabled = layer.enabled; sources.enabled = 'repo'; }
      else invalid.push('repo.verdictLedger.promotion.dailyCheck.enabled');
    }
    if (Object.hasOwn(layer, 'at')) {
      if (validAt(layer.at)) { settings.at = layer.at; sources.at = 'repo'; }
      else invalid.push('repo.verdictLedger.promotion.dailyCheck.at');
    }
  }
  const rawEnabled = env?.[ENV_KEYS.enabled];
  if (rawEnabled !== undefined && rawEnabled !== '') {
    const b = envBool(rawEnabled);
    if (typeof b === 'boolean') { settings.enabled = b; sources.enabled = 'env'; } else invalid.push(`env.${ENV_KEYS.enabled}`);
  }
  const rawAt = env?.[ENV_KEYS.at];
  if (rawAt !== undefined && rawAt !== '') {
    if (validAt(String(rawAt).trim())) { settings.at = String(rawAt).trim(); sources.at = 'env'; } else invalid.push(`env.${ENV_KEYS.at}`);
  }
  return { settings, sources, invalid };
}

export function formatDailyCheckSettings(r) {
  return `dailyCheck.enabled=${r.settings.enabled} (${r.sources.enabled}), dailyCheck.at=${r.settings.at} (${r.sources.at})`
    + (r.invalid?.length ? ` · ignored invalid: ${r.invalid.join(', ')}` : '');
}

/**
 * Is the daily check due at `now`? Pure.
 * @returns {{due: boolean, day: string|null, trigger?: string, reason?: string}}
 */
export function dailyCheckDue({ now, settings = DAILY_CHECK_DEFAULTS, quietSettings = DEFAULT_QUIET_SETTINGS, toggle = null, lastDay = null } = {}) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const day = etDay(nowMs);
  if (!day) return { due: false, day: null, reason: 'invalid clock' };
  if (!settings.enabled) return { due: false, day, reason: 'disabled' };
  if (lastDay === day) return { due: false, day, reason: `already ran for ${day}` };
  if (toggleActive(toggle, nowMs)) return { due: true, day, trigger: 'quiet-mode turned on' };
  const q = mergeSettings(quietSettings);
  const atText = settings.at === 'quiet-start' ? q.start : settings.at;
  const atMin = parseHHMM(atText);
  if (atMin === null) return { due: false, day, reason: `no valid time (${settings.at} → ${atText}); only quiet mode triggers it` };
  let min;
  try { min = localMinutes(nowMs, q.timeZone); } catch { return { due: false, day, reason: `bad time zone ${q.timeZone}` }; }
  return min >= atMin
    ? { due: true, day, trigger: settings.at === 'quiet-start' ? `quiet-hours start ${atText} ${q.timeZone}` : `at ${atText} ${q.timeZone}` }
    : { due: false, day, reason: `before ${atText} ${q.timeZone}` };
}

const round2 = (n) => Math.round(n * 100) / 100;

/** The ONE history line for a day. Pure. Agreement compares at two decimals so float noise is never a "drop". */
export function buildDailyLine({ measure: m, previous = null, promotion, dailyCheck, day, at, trigger }) {
  const s = promotion.settings;
  const agreementPct = round2(m.agreementPct);
  const prev = typeof previous?.agreementPct === 'number' ? previous.agreementPct : null;
  return {
    schema: HISTORY_SCHEMA, day, at, trigger,
    ready: m.ready, blockers: m.blockers,
    agreementPct, previousAgreementPct: prev, agreementDelta: prev === null ? null : round2(agreementPct - prev),
    agree: m.agree, disagree: m.disagree, unreadable: m.unreadable, transient: m.transient, unsafe: m.unsafe,
    comparedPRs: m.comparedPRs, shadowDays: m.shadowDays, window: m.window,
    minAgreementPct: s.minAgreementPct, maxUnsafeDisagreements: s.maxUnsafeDisagreements,
    unsafeOverLimit: m.unsafe > s.maxUnsafeDisagreements,
    agreementDropped: prev !== null && agreementPct < prev,
    topDisagreeReasons: (m.topDisagreeReasons ?? []).slice(0, 5),
    settings: formatPromotionSettings(promotion),
    dailyCheck: formatDailyCheckSettings(dailyCheck),
  };
}

/** The last `n` parseable lines of the history file (oldest first). A missing file is []; a torn line is skipped. */
export function readLatestLines(path, n = 2) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o === 'object' && typeof o.day === 'string') out.push(o); } catch { /* torn line */ }
  }
  return out.slice(-n);
}

export function formatDailyLine(line) {
  return `ledger-readiness daily ${line.day}: ${line.ready ? 'READY' : 'NOT READY'} · agreement ${line.agreementPct}%`
    + (line.previousAgreementPct === null ? '' : ` (prev ${line.previousAgreementPct}%)`)
    + ` · unsafe ${line.unsafe}/≤${line.maxUnsafeDisagreements} · PRs ${line.comparedPRs} · days ${line.shadowDays}`
    + ` · trigger: ${line.trigger} · ${line.dailyCheck}`;
}

/**
 * Run the check when due and return the latest line(s) for the smell. IO is injectable. Throws only on a real IO
 * failure (the health tick's `attempt` records it as a probe error); never touches a PR.
 * @returns {{ran: boolean, reason: string, latest: object|null, previous: object|null, dailyCheck: string}}
 */
export function runDailyReadinessCheck({
  now = Date.now(), historyPath, env = process.env, repoSettings, readRuns = readShadowRuns,
  quiet = () => { const settings = loadQuietSettings({ env }); return { settings, toggle: readToggle(settings, { env }) }; },
  append = (p, text) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, text); },
  log = (s) => process.stderr.write(`${s}\n`), dryRun = false,
} = {}) {
  if (!historyPath) throw new TypeError('historyPath is required');
  const repo = repoSettings ?? readSettings();
  const dailyCheck = resolveDailyCheckSettings({ repo, env });
  const lines = readLatestLines(historyPath, 2);
  let latest = lines.at(-1) ?? null;
  let previous = lines.length > 1 ? lines.at(-2) : null;
  let q;
  try { q = quiet(); } catch { q = { settings: DEFAULT_QUIET_SETTINGS, toggle: null }; }
  const due = dailyCheckDue({ now, settings: dailyCheck.settings, quietSettings: q.settings, toggle: q.toggle, lastDay: latest?.day ?? null });
  const fmt = formatDailyCheckSettings(dailyCheck);
  if (!due.due) return { ran: false, reason: due.reason, latest, previous, dailyCheck: fmt };
  const promotion = resolvePromotionSettings({ repo, env });
  const { runs } = readRuns();
  const at = new Date(now).toISOString();
  const measure = measureReadiness(runs, { now: at, settings: promotion.settings });
  const line = buildDailyLine({ measure, previous: latest, promotion, dailyCheck, day: due.day, at, trigger: due.trigger });
  if (!dryRun) append(historyPath, `${JSON.stringify(line)}\n`);
  log(`${formatDailyLine(line)}${dryRun ? ' · dry-run, not recorded' : ` · recorded ${historyPath}`}`);
  previous = latest;
  latest = line;
  return { ran: true, reason: due.trigger, latest, previous, dailyCheck: fmt };
}
