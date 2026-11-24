import { readFileSync } from 'node:fs';
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

