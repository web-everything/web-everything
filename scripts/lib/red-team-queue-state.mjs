import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function defaultQueueFile(env = process.env, home = homedir()) {
  return env.WE_RED_TEAM_QUEUE_FILE || join(home, 'workspace', '.operations', 'red-team-dispatch-queue.json');
}

// Bounded, terminal-safe diagnostics are evidence of a hold, never clearance.
export const boundedReason = reason => {
  if (typeof reason !== 'string') return null;
  const text = reason.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
  if (!text) return null;
  return text.length <= 500 ? text : `${text.slice(0, 465)} [truncated; inspect planner logs]`;
};

/** Read only the exact queued identity; absent/corrupt reasons never authorize a bypass. */
export function readQueuePlannerBlock({ repo, pr, head, env = process.env, readFile = readFileSync }) {
  try {
    const entries = JSON.parse(readFile(defaultQueueFile(env), 'utf8'));
    if (!Array.isArray(entries)) return null;
    const matches = entries.filter(entry => entry?.repo === repo && entry.pr === Number(pr) && entry.head === head
      && entry.key === `${repo}#${pr}`);
    return matches.length === 1 && matches[0].blocked ? boundedReason(matches[0].blockedReason) : null;
  } catch { return null; }
}


/**
 * Re-request a red-team round for a planner-skipped queue entry: clears the block so the next tick re-probes it.
 * The skip reason is re-checked on the exact head first (a real skip is never overridden here), and the old reason
 * stays on the entry as `reprobeReason` so the queue shows why it was re-requested.
 */
export function requestPlannerSkipReprobe({ repo, pr, head, env = process.env, readFile = readFileSync,
  writeFile = writeFileSync, rename = renameSync, now = Date.now }) {
  const file = defaultQueueFile(env);
  try {
    const entries = JSON.parse(readFile(file, 'utf8'));
    if (!Array.isArray(entries)) return { requested: false };
    const matches = entries.filter(entry => entry?.repo === repo && entry.pr === Number(pr) && entry.head === head && entry.key === `${repo}#${pr}`);
    if (matches.length !== 1 || matches[0].blocked !== 'planner-skip') return { requested: false };
    const entry = matches[0];
    entry.reprobeReason = boundedReason(entry.blockedReason) ?? 'planner-skip (no reason recorded)';
    entry.reprobeRequestedAt = now();
    delete entry.blocked; delete entry.blockedReason; delete entry.lastProbeTurn;
    const temp = `${file}.${process.pid}.reprobe.tmp`;
    writeFile(temp, JSON.stringify(entries), 'utf8');
    rename(temp, file);
    return { requested: true };
  } catch { return { requested: false }; }
}
