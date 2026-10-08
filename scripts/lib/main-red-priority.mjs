/**
 * @file scripts/lib/main-red-priority.mjs
 * @description Card xu1nixv — the ONE published fact "while main is red, PR #N owns the fix: put it first".
 *   Written every health tick by we:scripts/conveyor/main-ci-red-io.mjs (from the pure rule
 *   `main-ci-red-core.mjs#planPriority`), cleared when main is green or nobody owns the fix. Read by any queue that
 *   orders PRs (draft promotion, review queue, drain) with {@link readMainRedPriority} +
 *   `main-ci-red-core.mjs#mainRedPriorityRank` as its first sort term.
 *
 *   Import-light on purpose (fs + path only) so a queue can read it without pulling the health watch in. The record
 *   carries its own `expiresAt`: a stopped health watch can never pin a PR first for longer than the TTL.
 *
 *   File: `<coordination root>/main-red-priority.json` = `{repo, pr, firstRedSha, reason, setAt, expiresAt}`.
 */
import { readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';

export function mainRedPriorityPath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'main-red-priority.json'); }

/** The live priority record, or null (absent, unreadable, malformed or expired). */
export function readMainRedPriority({ env = process.env, path = mainRedPriorityPath(env), now = Date.now() } = {}) {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    return r && Number.isInteger(r.pr) && Number.isFinite(r.expiresAt) && now < r.expiresAt ? r : null;
  } catch { return null; }
}

/** Publish `record`, or clear the file when `record` is null. */
export function writeMainRedPriority(record, { path = mainRedPriorityPath() } = {}) {
  if (!record) { try { unlinkSync(path); } catch { /* already clear */ } return; }
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, record);
}
