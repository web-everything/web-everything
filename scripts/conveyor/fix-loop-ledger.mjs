/** Append-only evidence of repair sessions that have not moved a PR head. */
import { appendFileSync, mkdirSync, openSync, fstatSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
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
/** PRs #4992/#4993/#4965, 2026-10-12: a hold must have a bounded re-arm clock. */
export function fixLoopConfig(env = process.env, { readPlatform = readPlatformPreferences, readRepo = readSettings } = {}) {
  let rearmAfterMinutes = 120, rearmAfterMinutesSource = 'default';
  for (const [source, read] of [['platform', readPlatform], ['repo', readRepo], ['env', () => ({
    fix: { loopHold: { rearmAfterMinutes: env.WE_FIX_LOOP_REARM_AFTER_MINUTES } },
  })]]) {
    let raw;
    try { raw = read()?.fix?.loopHold?.rearmAfterMinutes; } catch { continue; }
    const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(value) && value > 0) { rearmAfterMinutes = value; rearmAfterMinutesSource = source; }
  }
  const max = Number(env.WE_FIX_LOOP_MAX_SESSIONS), hours = Number(env.WE_FIX_LOOP_WINDOW_HOURS);
  return {
    maxSessions: Number.isSafeInteger(max) && max >= 1 ? max : 3,
    windowHours: Number.isFinite(hours) && hours > 0 ? hours : 6,
    hold: env.WE_FIX_LOOP_HOLD !== '0',
    rearmAfterMinutes, rearmAfterMinutesSource,
  };
}
/** Rows written by the daemon-live-smoke's stub dispatchers (`stub-ci-heal`, `stub-fix`) are not real sessions:
 *  they once poisoned the live ledger and auto-held real red PRs (#4194, 2026-10-07). Never evidence. */
export const isStubSession = (session) => typeof session === 'string' && /^stub-/.test(session);
function validRow(row) {
  return !isStubSession(row?.session) && row?.v === 1 && typeof row.repo === 'string' && Number.isInteger(row.pr) && row.pr > 0
    && ['ci-heal', 'fix', 'rearm', 'park'].includes(row.kind)
    && (!['rearm', 'park'].includes(row.kind) || typeof row.reason === 'string') && /^[a-f\d]{40}$/i.test(row.head ?? '')
    && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at));
}
const isSession = row => ['ci-heal', 'fix'].includes(row.kind);
function windowRows(rows, now, config) {
  const end = new Date(now).getTime(), start = end - config.windowHours * 3600000;
  return (rows ?? []).filter(row => validRow(row) && isSession(row) && Date.parse(row.at) >= start && Date.parse(row.at) <= end)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
export function fixLoopSessionRows({ rows, repo, pr, head, now = Date.now(), config = fixLoopConfig() }) {
  return windowRows(rows, now, config).filter(row => row.repo === repo && row.pr === pr && row.head === head);
}
export function fixLoopState({ rows, repo, pr, head, now = Date.now(), config = fixLoopConfig(), infraFailures = 0 }) {
  const matches = fixLoopSessionRows({ rows, repo, pr, head, now, config });
  infraFailures = Number.isFinite(infraFailures) ? Math.max(0, Math.min(matches.length, Math.floor(infraFailures))) : 0;
  const count = matches.length - infraFailures;
  return { count, rawCount: matches.length, infraFailures, held: config.hold && count >= config.maxSessions,
    since: matches[0]?.at ?? null, sessions: matches.map(row => row.session).filter(session => typeof session === 'string') };
}

/** PRs #4992/#4993/#4965, 2026-10-12: failures before an agent runs are infrastructure, never repair evidence. */
export const FIX_RUN_INFRA_PATTERNS = Object.freeze([
  /^no-finding:/i, /^fix-run:/i, /^error:/i, /missing required flag/i, /has no fix launcher/i,
  /launch did not complete/i, /lane-pool/i, /Operation not permitted/i, /EPERM/i, /EACCES/i,
  /read-only file system/i, /index\.lock/i, /\.git\b/i, /sandbox/i, /could not (commit|push|stage)/i,
]);
export function classifyFixRunOutcome(line) {
  const match = /^fix-run: PR #(\d+) (failed|no-change|pushed) \((.*)\); claim/.exec(line);
  if (!match) return null;
  const [, pr, outcome, reason] = match;
  return { pr: Number(pr), outcome, reason, infra: outcome === 'failed' && FIX_RUN_INFRA_PATTERNS.some(pattern => pattern.test(reason)) };
}
export function infraFailureCount({ logText, pr, sessions }) {
  if (!(sessions > 0)) return 0;
  return String(logText ?? '').split('\n').map(classifyFixRunOutcome).filter(row => row?.pr === pr)
    .slice(-Math.floor(sessions)).filter(row => row.infra).length;
}
/** Control rows persist across the counting window: each head gets only one Claude re-arm.
 * Exact infra rows come from ordered log evidence; aggregate-only callers conservatively discount the newest rows. */
export function fixLoopDisposition({ rows, repo, pr, head, now = Date.now(), config = fixLoopConfig(), infraFailures = 0, build, infraRows = null }) {
  const identity = row => row.repo === repo && row.pr === pr && row.head === head;
  const controls = (rows ?? []).filter(row => validRow(row) && identity(row) && Date.parse(row.at) <= new Date(now).getTime());
  if (controls.some(row => row.kind === 'park')) return { action: 'parked' };
  const rearm = controls.find(row => row.kind === 'rearm');
  const matches = windowRows(rows, now, config).filter(identity);
  const state = fixLoopState({ rows, repo, pr, head, now, config, infraFailures });
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
  if (!state.held) return { action: 'dispatch' };
  if (build && counted.some(row => row.build !== build)) return { action: 'rearm', reason: 'fixer build-change' };
  if (new Date(now).getTime() >= Date.parse(until)) return { action: 'rearm', reason: 're-arm window elapsed' };
  return { action: 'hold', until };
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
