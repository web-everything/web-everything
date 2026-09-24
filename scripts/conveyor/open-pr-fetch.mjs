/** One open-PR snapshot per mechanical tick, shared across subprocesses via --prs-file=<path>.
 * The runner owns the file's lifetime; standalone passes retain their narrower, throttled queries.
 */
import { readFileSync } from 'node:fs';
import { runGhSync } from '../lib/gh-throttle.mjs';

// #3383 — `baseRefName` joined the union once `reconcile-pass.mjs` and `parked-pr-conflict-watch.mjs` each
// started reading it (the STACKED-BASE CONFLICT branch needs it to tell a PR stacked on another lane/PR apart
// from an ordinary conflict against `main`); `open-pr-fetch.test.mjs` pins this as the DEDUPLICATED UNION of
// every standalone reader's own field list, so a reader that starts reading a new field and forgets to widen
// this one goes red here, not silently.
export const OPEN_PR_LIST_FIELDS = 'number,headRefName,title,body,labels,files,mergeable,mergeStateStatus,headRefOid,baseRefName,statusCheckRollup,comments';
export const PR_LIST_LIMIT = 200;

/** Throws on a failed fetch so the runner can fall back to each pass's standalone discovery. */
export function defaultFetchOpenPrs({ repo = null, exec = runGhSync } = {}) {
  const argv = ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', OPEN_PR_LIST_FIELDS];
  if (repo) argv.push('--repo', repo);
  const out = exec(argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

/** A missing, malformed, or non-array snapshot is an empty safe list, never another network read. */
export function readPrsFromFile(path, { readFile = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFile(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
