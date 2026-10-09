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
import { fileURLToPath } from 'node:url';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';

export function mainRedPriorityPath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'main-red-priority.json'); }

/** The live priority record, or null (absent, unreadable, malformed or expired). */
export function readMainRedPriority({ env = process.env, path, now = Date.now() } = {}) {
  // Hermetic by default: inside a test run only an explicit `path` is read, never the live coordination record.
  if (path === undefined && (env?.VITEST || env?.WE_UNDER_TEST)) return null;
  path ??= mainRedPriorityPath(env);
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

// ── Card xu1nixv — the published "main's CI is red" fact, for the builder's `main-red` freeze ────────────────
// File: `<coordination root>/main-ci-red-state.json` = `{red:true, firstRedSha, since, latestRedSha, setAt, expiresAt}`.
// Written every health tick while main is red, removed when main is green; a blind (unknown) read leaves it to
// expire on its own TTL, so a stopped health watch can never freeze the builder for longer than that.

export function mainRedStatePath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'main-ci-red-state.json'); }

/** The live main-red record, or null (absent, unreadable, malformed or expired) — null never freezes anything. */
export function readMainRedState({ env = process.env, path, now = Date.now() } = {}) {
  if (path === undefined && (env?.VITEST || env?.WE_UNDER_TEST)) return null; // hermetic: never the live record inside a test run
  path ??= mainRedStatePath(env);
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    return r && r.red === true && Number.isFinite(r.expiresAt) && now < r.expiresAt ? r : null;
  } catch { return null; }
}

/** Publish `record`, or clear the file when `record` is null. */
export function writeMainRedState(record, { path = mainRedStatePath() } = {}) {
  if (!record) { try { unlinkSync(path); } catch { /* already clear */ } return; }
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, record);
}

/**
 * Declared setting `freeze.mainRed` (`on` | `off`, built-in `on`): the builder's `main-red` freeze kind. `off` = before
 * this card (the builder never freezes for a red main). Env `WE_BUILD_FREEZE_MAIN_RED` > `we:scripts/dispatch-settings.json`
 * `freeze.mainRed` > built-in. Any unreadable / unknown value falls back to the built-in.
 */
export function resolveFreezeMainRed({ env = process.env, file = join(dirname(fileURLToPath(import.meta.url)), '../dispatch-settings.json') } = {}) {
  const norm = (v) => { const x = String(v ?? '').trim().toLowerCase(); return x === 'on' || x === 'off' ? x : null; };
  const fromEnv = norm(env?.WE_BUILD_FREEZE_MAIN_RED);
  if (fromEnv) return fromEnv;
  try { const f = norm(JSON.parse(readFileSync(file, 'utf8'))?.freeze?.mainRed); if (f) return f; } catch { /* built-in */ }
  return 'on';
}
