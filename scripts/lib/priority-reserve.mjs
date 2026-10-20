import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { queueFileOverlap } from './queue-file-overlap.mjs';
import { isOperatorAuthored } from './marker-authorship.mjs';

export const PRIORITY_RESERVE_LABELS = ['priority:now', 'priority:urgent'];
export const isPriorityLabels = labels => (labels || []).some(l => PRIORITY_RESERVE_LABELS.includes(typeof l === 'string' ? l : l?.name));

/**
 * IO: true only when the LAST time this PR got its priority:now/urgent label, the operator added it (same
 * provenance rule as the drain's order override). Any unreadable or malformed read is false (fail closed).
 * @param {{repo:string, num:number, labels:Array<string|{name:string}>, exec:Function}} o  exec = execFileSync-shaped
 */
export function readOperatorPriority({ repo, num, labels, exec }) {
  const names = (labels || []).map(l => (typeof l === 'string' ? l : l?.name)).filter(n => PRIORITY_RESERVE_LABELS.includes(n));
  if (!names.length || !repo || !Number.isInteger(Number(num))) return false;
  try {
    const events = JSON.parse(String(exec('gh', ['api', `repos/${repo}/issues/${num}/events`, '--paginate'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }) || '[]'));
    const list = Array.isArray(events) ? events : [];
    return names.some((name) => {
      const last = list.filter(e => e?.event === 'labeled' && e?.label?.name === name).at(-1);
      return isOperatorAuthored({ author: { login: last?.actor?.login } });
    });
  } catch { return false; }
}

export function readReserves(path) {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}
export function writeReserves(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, obj);
}

export function activeReserveBlockers({ candidate, reserves, now, ttlMs = 30 * 60_000, includeCards = true, isValid = () => true }) {
  return Object.entries(reserves).filter(([key, stamp]) => key !== candidate.key
    && stamp && Number.isFinite(stamp.at) && now >= stamp.at && (stamp.rt || now - stamp.at < ttlMs)
    && Array.isArray(stamp.files) && stamp.files.every(f => typeof f === 'string')
    && isValid(stamp)
    && queueFileOverlap({ candidateFiles: candidate.files, queuedEntries: [stamp], includeCards }).overlap)
    .map(([, stamp]) => stamp);
}
