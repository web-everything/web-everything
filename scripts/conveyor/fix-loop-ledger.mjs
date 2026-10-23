/** Append-only repair sessions and launcher outcomes: card 5947 (live #5045, 2026-10-13). */
import { appendFileSync, mkdirSync, openSync, fstatSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { execRead } from '../lib/proc-read.mjs';
import { computeMainRedWindows, isWithinRedWindow, isMainCurrentlyRed } from './main-red-recovery.mjs';
import { readSettings } from '../lib/settings-files.mjs';

export const FIX_HOLD_LABEL = 'hold:fix';
export const fixLoopLedgerPath = (env = process.env) => env.WE_FIX_LOOP_LEDGER || join(homedir(), '.claude', 'conveyor', 'fix-loop-ledger.jsonl');
export const fixDispatchKillFile = (env = process.env) => env.WE_FIX_DISPATCH_KILL_FILE || join(homedir(), '.claude', 'conveyor', 'fix-dispatch.kill');
export function fixDispatchKilled({ env = process.env, exists = existsSync } = {}) {
  return exists(fixDispatchKillFile(env));
}
export function hasFixHoldLabel(labels, env = process.env) {
  const label = env.WE_FIX_HOLD_LABEL || FIX_HOLD_LABEL;
  return (labels ?? []).some(value => (typeof value === 'string' ? value : value?.name) === label);
}
const readPlatformPreferences = () => {
  try { return JSON.parse(readFileSync(new URL('../lib/delivery-platform-preferences.json', import.meta.url), 'utf8')); }
  catch { return {}; }
};
const readMainRunsDefault = () => {
  // Like sibling conveyor readers, unit tests never read the live host.
  if (process.env.VITEST) throw new Error('main CI reader disabled under Vitest');
  return JSON.parse(execRead('gh', ['run', 'list', '--repo', CONSTELLATION_REPOS.we.slug,
    '--branch', 'main', '--workflow', 'CI', '--limit', '60', '--json', 'conclusion,status,updatedAt'],
  { encoding: 'utf8', timeout: 30000 }));
};
/** PRs #4992/#4993/#4965, 2026-10-12: a hold must have a bounded re-arm clock. */
export function fixLoopConfig(env = process.env, { readPlatform = readPlatformPreferences, readRepo = readSettings, readMainRuns = readMainRunsDefault } = {}) {
  let rearmAfterMinutes = 120, rearmAfterMinutesSource = 'default';
  let redMainDiscount = 'on', redMainDiscountSource = 'default';
  for (const [source, read] of [['platform', readPlatform], ['repo', readRepo], ['env', () => ({
    fix: { loopHold: { rearmAfterMinutes: env.WE_FIX_LOOP_REARM_AFTER_MINUTES, redMainDiscount: env.WE_FIX_LOOP_RED_MAIN_DISCOUNT } },
  })]]) {
    let raw;
    try { raw = read()?.fix?.loopHold; } catch { continue; }
    if (['on', 'off'].includes(raw?.redMainDiscount)) { redMainDiscount = raw.redMainDiscount; redMainDiscountSource = source; }
    raw = raw?.rearmAfterMinutes;
    const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(value) && value > 0) { rearmAfterMinutes = value; rearmAfterMinutesSource = source; }
  }
  let redMainWindows = null;
  if (redMainDiscount === 'on') {
    try {
      const runs = readMainRuns();
      if (Array.isArray(runs)) redMainWindows = computeMainRedWindows(runs);
    } catch { /* Unreadable history keeps the existing budgets and terminal holds. */ }
  }
  const max = Number(env.WE_FIX_LOOP_MAX_SESSIONS), hours = Number(env.WE_FIX_LOOP_WINDOW_HOURS);
  return {
    maxSessions: Number.isSafeInteger(max) && max >= 1 ? max : 3,
    windowHours: Number.isFinite(hours) && hours > 0 ? hours : 6,
    hold: env.WE_FIX_LOOP_HOLD !== '0',
    rearmAfterMinutes, rearmAfterMinutesSource, redMainDiscount, redMainDiscountSource,
    ...(redMainDiscount === 'on' ? { redMainWindows } : {}),
  };
}
/** Rows written by the daemon-live-smoke's stub dispatchers (`stub-ci-heal`, `stub-fix`) are not real sessions:
 *  they once poisoned the live ledger and auto-held real red PRs (#4194, 2026-10-07). Never evidence. */
export const isStubSession = (session) => typeof session === 'string' && /^stub-/.test(session);
function validRow(row) {
  return !isStubSession(row?.session) && row?.v === 1 && typeof row.repo === 'string' && Number.isInteger(row.pr) && row.pr > 0
    && ['ci-heal', 'fix', 'rearm', 'park', 'outcome'].includes(row.kind)
    && (row.kind !== 'outcome' || (typeof row.session === 'string' && row.session.trim().length > 0
      && ['pushed', 'no-change', 'no-change-unproven', 'failed'].includes(row.outcome) && typeof row.infra === 'boolean'
      && (row.reason === undefined || typeof row.reason === 'string')))
    && (!['rearm', 'park'].includes(row.kind) || typeof row.reason === 'string') && /^[a-f\d]{40}$/i.test(row.head ?? '')
    && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at));
}
const isSession = row => ['ci-heal', 'fix'].includes(row.kind);
const hasRedMainDiscount = config => config.redMainDiscount === 'on' && Array.isArray(config.redMainWindows);
// PR #5248 review: only a CLOSED window discounts. While main is still red every
// session counts, so the per-head ceilings keep bounding spend through the outage.
const inClosedRedWindow = (row, config) => hasRedMainDiscount(config)
  && isWithinRedWindow(Date.parse(row.at), config.redMainWindows.filter(window => Number.isFinite(Date.parse(window?.end))));
const discountedSession = (row, config) => isSession(row) && inClosedRedWindow(row, config);
function windowRows(rows, now, config) {
  const end = new Date(now).getTime(), start = end - config.windowHours * 3600000;
  return (rows ?? []).filter(row => validRow(row) && isSession(row) && Date.parse(row.at) >= start && Date.parse(row.at) <= end)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
export function fixLoopSessionRows({ rows, repo, pr, head, now = Date.now(), config = fixLoopConfig() }) {
  return windowRows(rows, now, config).filter(row => !discountedSession(row, config) && row.repo === repo && row.pr === pr && row.head === head);
}
/** PURE. Pair each session with its first outcome before the next attempt of that name.
 * Card 5947 (live #5045, 2026-10-13): shared log positions cannot identify infrastructure refusals. */
export function ledgerInfraRows({ rows, repo, pr, head }) {
  const matches = (rows ?? []).filter(row => validRow(row) && row.repo === repo && row.pr === pr && row.head === head)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const sessions = matches.filter(isSession);
  return sessions.filter((session, i) => {
    if (typeof session.session !== 'string' || !session.session.trim()) return false;
    const next = sessions.slice(i + 1).find(row => row.session === session.session);
    const outcome = matches.find(row => row.kind === 'outcome' && row.session === session.session
      && Date.parse(row.at) >= Date.parse(session.at) && (!next || Date.parse(row.at) < Date.parse(next.at)));
    return outcome?.infra === true;
  });
}
export function fixLoopState({ rows, repo, pr, head, now = Date.now(), config = fixLoopConfig(), infraFailures = 0 }) {
  const matches = fixLoopSessionRows({ rows, repo, pr, head, now, config });
  // Retain old attempts for pairing boundaries, but never use future outcomes
  // as evidence for a session inside the current observation window.
  const observed = (rows ?? []).filter(row => Date.parse(row?.at) <= new Date(now).getTime());
  infraFailures = Math.max(Number.isFinite(infraFailures) ? infraFailures : 0,
    ledgerInfraRows({ rows: observed, repo, pr, head }).filter(row => matches.includes(row)).length);
  infraFailures = Number.isFinite(infraFailures) ? Math.max(0, Math.min(matches.length, Math.floor(infraFailures))) : 0;
  const count = matches.length - infraFailures;
  const redMainDiscounted = windowRows(rows, now, config).filter(row => row.repo === repo && row.pr === pr
    && row.head === head && discountedSession(row, config)).length;
  return { count, redMainDiscounted, rawCount: matches.length, infraFailures, held: config.hold && count >= config.maxSessions,
    since: matches[0]?.at ?? null, sessions: matches.map(row => row.session).filter(session => typeof session === 'string') };
}

/** PRs #4992/#4993/#4965, 2026-10-12: failures before an agent runs are infrastructure, never repair evidence.
 * Card 5947 (live #5045, 2026-10-13) also classifies an absent CI failure. */
export const FIX_RUN_INFRA_PATTERNS = Object.freeze([
  /^no-finding:/i, /^no-ci-failure:/i, /^fix-run:/i, /^error:/i, /missing required flag/i, /has no fix launcher/i,
  /launch did not complete/i, /lane-pool/i, /Operation not permitted/i, /EPERM/i, /EACCES/i,
  /read-only file system/i, /index\.lock/i, /\.git\b/i, /sandbox/i, /could not (commit|push|stage)/i,
]);
/** PURE. Only failed launcher infrastructure outcomes are discounted, including card 5947 (live #5045, 2026-10-13). */
export function isInfraFixRunOutcome(outcome, reason) {
  return outcome === 'failed' && FIX_RUN_INFRA_PATTERNS.some(pattern => pattern.test(String(reason ?? '')));
}
export function classifyFixRunOutcome(line) {
  const match = /^fix-run: PR #(\d+) (failed|no-change|no-change-unproven|pushed) \((.*)\); claim/.exec(line);
  if (!match) return null;
  const [, pr, outcome, reason] = match;
  return { pr: Number(pr), outcome, reason, infra: isInfraFixRunOutcome(outcome, reason) };
}
export function infraFailureCount({ logText, pr, sessions }) {
  if (!(sessions > 0)) return 0;
  return String(logText ?? '').split('\n').map(classifyFixRunOutcome).filter(row => row?.pr === pr)
    .slice(-Math.floor(sessions)).filter(row => row.infra).length;
}
/** Control rows persist across the counting window: each head gets only one Claude re-arm.
 * Card 5947 (live #5045, 2026-10-13): ledger outcomes join caller evidence; aggregate-only callers discount the newest rows. */
export function fixLoopDisposition({ rows, repo, pr, head, now = Date.now(), config = fixLoopConfig(), infraFailures = 0, build, infraRows = null }) {
  if (!config.hold) return { action: 'dispatch' };
  const identity = row => row.repo === repo && row.pr === pr && row.head === head;
  const observed = (rows ?? []).filter(row => validRow(row) && identity(row) && Date.parse(row.at) <= new Date(now).getTime());
  const controls = observed.filter(row => !discountedSession(row, config) && !(!isMainCurrentlyRed(config.redMainWindows)
      && ['park', 'rearm'].includes(row.kind) && inClosedRedWindow(row, config)));
  if (controls.some(row => row.kind === 'park')) return { action: 'parked' };
  const rearm = controls.find(row => row.kind === 'rearm');
  // Log text is not authenticated launcher evidence. Bound spend independently of
  // log-based discounts and the rolling window, allowing one extra attempt and a final re-arm.
  // Red-main discounts get their own hard cap: past one raw budget, discounted sessions count too.
  const discounted = observed.filter(row => discountedSession(row, config)).length;
  const rawCount = controls.filter(isSession).length + Math.max(0, discounted - (config.maxSessions + 2));
  if (rawCount >= config.maxSessions + 2) return { action: 'park', reason: 'raw per-head repair session ceiling reached' };
  const matches = fixLoopSessionRows({ rows, repo, pr, head, now, config });
  // Discounted attempts still delimit reused session names: their outcomes must
  // never become infrastructure evidence for an earlier counted attempt.
  const ledgerInfra = ledgerInfraRows({ rows: observed, repo, pr, head });
  if (infraRows !== null || ledgerInfra.length) infraRows = [...new Set([...(infraRows ?? []), ...ledgerInfra])];
  const state = fixLoopState({ rows, repo, pr, head, now, config,
    infraFailures: Math.max(infraFailures, infraRows?.filter(row => matches.includes(row)).length ?? 0) });
  const counted = infraRows ? matches.filter(row => !infraRows.includes(row)) : matches.slice(0, matches.length - state.infraFailures);
  const until = new Date(Math.max(Date.parse(counted.at(-1)?.at ?? rearm?.at ?? new Date(now).toISOString()),
    rearm ? Date.parse(rearm.at) : 0)
    + (config.rearmAfterMinutes ?? 120) * 60000).toISOString();
  if (rearm) {
    const newer = counted.filter(row => Date.parse(row.at) > Date.parse(rearm.at));
    if (newer.length) return { action: 'park', reason: 'the Claude re-arm also produced nothing' };
    // A failed/held launch after recording the re-arm must not leave a terminal marker.
    if (new Date(now).getTime() >= Date.parse(until)) return { action: 'dispatch' };
    return { action: 'hold', until };
  }
  if (!state.held) {
    if (rawCount >= config.maxSessions + 1) return { action: 'rearm', reason: 'final attempt before raw per-head session ceiling' };
    return { action: 'dispatch' };
  }
  if (build && counted.some(row => row.build !== build)) return { action: 'rearm', reason: 'fixer build-change' };
  if (new Date(now).getTime() >= Date.parse(until)) return { action: 'rearm', reason: 're-arm window elapsed' };
  return { action: 'hold', until };
}
/** A red-main park may lapse only after recovery and a fresh budget evaluation. Pure. */
export function fixLoopRedMainLapse({ rows, repo, pr, head, now = Date.now(), config }) {
  if (!hasRedMainDiscount(config) || isMainCurrentlyRed(config.redMainWindows)) return false;
  if (!(rows ?? []).some(row => validRow(row) && row.repo === repo && row.pr === pr && row.head === head
    && row.kind === 'park' && Date.parse(row.at) <= new Date(now).getTime())) return false;
  // PR #5248 review: judge the park with holds on, so disabling holds never releases a park red main did not cause.
  return !['park', 'parked'].includes(fixLoopDisposition({ rows, repo, pr, head, now, config: { ...config, hold: true } }).action);
}
export function fixLoopBreaches({ rows, prs, now = Date.now(), config = fixLoopConfig() }) {
  const current = new Map((prs ?? []).map(pr => [`${pr.repo}#${pr.number}`, pr.headRefOid]));
  const groups = new Map();
  for (const row of windowRows(rows, now, config)) {
    if (current.get(`${row.repo}#${row.pr}`) !== row.head) continue;
    const key = `${row.repo}#${row.pr}#${row.head}`;
    if (!groups.has(key)) groups.set(key, { repo: row.repo, pr: row.pr, head: row.head, count: 0, kinds: {}, firstAt: row.at, lastAt: row.at });
    const group = groups.get(key);
    group.count++;
    group.kinds[row.kind] = (group.kinds[row.kind] ?? 0) + 1;
    group.lastAt = row.at;
  }
  return [...groups.values()].filter(group => group.count >= config.maxSessions);
}
export function readFixLoopRows({ env = process.env } = {}) {
  let fd;
  try {
    fd = openSync(fixLoopLedgerPath(env), 'r');
    const size = fstatSync(fd).size, start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, count).toString('utf8');
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return text.split('\n').flatMap(line => {
      try { const row = JSON.parse(line); return validRow(row) ? [row] : []; } catch { return []; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function appendFixLoopRow(row, { env = process.env, now = Date.now() } = {}) {
  const record = { ...row, v: 1, at: new Date(now).toISOString() };
  if (!validRow(record)) throw new Error('Invalid fix-loop ledger row');
  const path = fixLoopLedgerPath(env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}
