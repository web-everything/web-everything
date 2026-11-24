import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

/** The closed list of reason codes a queue entry may be held (skipped) under. */
export const BLOCK_REASON_CODES = Object.freeze(['review-unfinished', 'planner-skip']);

/**
 * The ONE check behind every skip/blocked write: a closed-list reason code plus non-empty evidence, or it throws.
 * Returns the validated { code, evidence }.
 */
export function assertBlockReason({ code, evidence } = {}) {
  const text = boundedReason(evidence);
  if (!BLOCK_REASON_CODES.includes(code) || !text) {
    throw new Error(`red-team skip needs a reason code from [${BLOCK_REASON_CODES.join(', ')}] and evidence (got code=${String(code)}, evidence=${text ? 'present' : 'missing'})`);
  }
  return { code, evidence: text };
}

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

// Re-request inbox: one file per (repo, pr, head), created exclusively. The drain never rewrites the queue file;
// the queue object consumes these inside its own tick. A `.req` or `.done` file for the head is the shared
// once-per-head ledger across both gate sources and restarts.
export const reprobeInboxDir = (env = process.env) => join(dirname(defaultQueueFile(env)), 'red-team-reprobe-requests');
const requestName = ({ repo, pr, head }) => encodeURIComponent(`${repo}#${pr}@${head}`);

export function requestRedTeamReprobe({ repo, pr, head, env = process.env, now = Date.now,
  mkdir = mkdirSync, exists = existsSync, writeFile = writeFileSync }) {
  try {
    const dir = reprobeInboxDir(env), base = join(dir, requestName({ repo, pr, head }));
    mkdir(dir, { recursive: true });
    if (exists(`${base}.req`) || exists(`${base}.done`)) return { requested: false, deduped: true };
    writeFile(`${base}.req`, JSON.stringify({ repo, pr: Number(pr), head, requestedAt: now() }), { encoding: 'utf8', flag: 'wx' });
    return { requested: true };
  } catch { return { requested: false }; }
}

/** Pending requests in the inbox, each with the path to mark consumed. Unreadable files are skipped. */
export function readReprobeRequests(dir, { readdir = readdirSync, readFile = readFileSync } = {}) {
  const out = [];
  let names;
  try { names = readdir(dir); } catch { return out; }
  for (const name of names.filter(n => n.endsWith('.req')).sort()) {
    try {
      const request = JSON.parse(readFile(join(dir, name), 'utf8'));
      if (typeof request?.repo === 'string' && Number.isSafeInteger(request.pr) && typeof request.head === 'string') out.push({ ...request, path: join(dir, name) });
    } catch { /* skipped */ }
  }
  return out;
}

export function markReprobeConsumed(path, { rename = renameSync } = {}) {
  try { rename(path, path.replace(/\.req$/, '.done')); } catch { /* retried next tick; the entry change is idempotent */ }
}
