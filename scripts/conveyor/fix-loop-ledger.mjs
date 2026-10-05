/** Append-only evidence of repair sessions that have not moved a PR head. */
import { appendFileSync, mkdirSync, openSync, fstatSync, readSync, closeSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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
export function fixLoopConfig(env = process.env) {
  const max = Number(env.WE_FIX_LOOP_MAX_SESSIONS), hours = Number(env.WE_FIX_LOOP_WINDOW_HOURS);
  return {
    maxSessions: Number.isSafeInteger(max) && max >= 1 ? max : 3,
    windowHours: Number.isFinite(hours) && hours > 0 ? hours : 6,
    hold: env.WE_FIX_LOOP_HOLD !== '0',
  };
}
function validRow(row) {
  return row?.v === 1 && typeof row.repo === 'string' && Number.isInteger(row.pr) && row.pr > 0
    && ['ci-heal', 'fix'].includes(row.kind) && /^[a-f\d]{40}$/i.test(row.head ?? '')
    && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at));
}
function windowRows(rows, now, config) {
  const end = new Date(now).getTime(), start = end - config.windowHours * 3600000;
  return (rows ?? []).filter(row => validRow(row) && Date.parse(row.at) >= start && Date.parse(row.at) <= end)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
export function fixLoopState({ rows, repo, pr, head, now = Date.now(), config = fixLoopConfig() }) {
  const matches = windowRows(rows, now, config).filter(row => row.repo === repo && row.pr === pr && row.head === head);
  return { count: matches.length, held: config.hold && matches.length >= config.maxSessions,
    since: matches[0]?.at ?? null, sessions: matches.map(row => row.session).filter(session => typeof session === 'string') };
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
