/**
 * @file scripts/operations/sessions-io.mjs
 * @description Card x4z1vez (Plateau /sessions, slice S2) — the IO shell for `./sessions.mjs`. Two reads, both
 * tolerant (a missing or odd file is skipped, never thrown), and ONE reuse:
 *   - live rows: `createLiveWorkCollector` + `assessLiveWork` (`./live-work*.mjs`) verbatim. No second join.
 *   - ended Claude sessions: `~/.claude/jobs/<id>/state.json` (D7), read through `normalizeJob`. Bounded by file
 *     mtime (window + slack) so the folder can grow without the read growing. Folder missing or unreadable ->
 *     `degraded: ['jobs']`, never a silent empty history.
 *   - review history: `completions/review-*.json` in the CURRENT clone's completion store. That store is per-clone
 *     until D6 moves it to one shared folder, so the verdict ALWAYS carries {@link REVIEW_HISTORY_GAP} until then;
 *     flip `REVIEW_STORE_SHARED` when D6 lands and the gap disappears with no other change.
 * Not here (S3): Codex end detection, chat end rule. Not done: the `claude agents --json --all` fallback of D7.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createLiveWorkCollector } from './live-work-io.mjs';
import { assessLiveWork } from './live-work.mjs';
import { claudeJobsDir } from './agent-activity-io.mjs';
import { resolveCompletionsDir } from './completion-store.mjs';
import { normalizeJob, REVIEW_HISTORY_GAP } from './sessions.mjs';

/** Flip to true when D6 (run records into one shared folder) has landed. */
export const REVIEW_STORE_SHARED = false;

/** Files older than window + this are not even opened. Wide enough for the live-row dedupe (6 h aged-out rule). */
const SLACK_MS = 6 * 3_600_000 + 3_600_000;

/** Parsed `*.json` files in `dir` whose name passes `accept` and whose mtime is within `maxAgeMs`. Missing dir -> null. */
function readJsonFiles(dir, { accept, file = (n) => n, now, maxAgeMs }) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const out = [];
  for (const n of names) {
    if (!accept(n)) continue;
    const path = join(dir, file(n));
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) continue;
      out.push(JSON.parse(readFileSync(path, 'utf8')));
    } catch { /* skip an unreadable or odd record */ }
  }
  return out;
}

/**
 * @param {{jobsDir?:string, completionsDir?:string}} [o]
 * @returns {(a:{windowMs:number, now:number}) => {jobs:object[], reviews:object[], degraded:string[]}}
 */
export function createSessionHistoryReader({ jobsDir = claudeJobsDir(), completionsDir } = {}) {
  return ({ windowMs, now }) => {
    const maxAgeMs = Math.max(windowMs, 0) + SLACK_MS;
    const degraded = [];
    const states = readJsonFiles(jobsDir, { accept: (n) => !n.startsWith('.'), file: (n) => join(n, 'state.json'), now, maxAgeMs });
    if (states === null) degraded.push('jobs');
    const jobs = (states ?? []).map(normalizeJob).filter(Boolean);
    let reviews = [];
    if (windowMs > 0) {
      const dir = completionsDir ?? resolveCompletionsDir();
      const found = readJsonFiles(dir, { accept: (n) => /^review-.*\.json$/.test(n), now, maxAgeMs });
      if (found === null) degraded.push('review-completions');
      reviews = found ?? [];
    }
    if (!REVIEW_STORE_SHARED) degraded.push(REVIEW_HISTORY_GAP);
    return { jobs, reviews, degraded };
  };
}

/** The default `collectLive`: the live-work collector, assessed. */
export function createLiveCollector(o = {}) {
  const collect = createLiveWorkCollector(o);
  return () => assessLiveWork(collect());
}
