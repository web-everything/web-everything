import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { queueFileOverlap } from './queue-file-overlap.mjs';

export const PRIORITY_RESERVE_LABELS = ['priority:now', 'priority:urgent'];
export const isPriorityLabels = labels => (labels || []).some(l => PRIORITY_RESERVE_LABELS.includes(typeof l === 'string' ? l : l?.name));

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
