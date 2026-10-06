/** @file scripts/lib/daemon-rebuild/state.mjs — Per-clone state files.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { overlayFilePath, cloneKey } from '../daemon-overlays.mjs';
import { daemonStateDir } from '../daemon-last-good.mjs';
import { join, dirname } from 'node:path';

/**
 * Is `root` a daemon-managed clone — one the rebuild moves with `reset --hard`? True once it has a rebuild
 * state file or a registered overlay list (both keyed on the same `cloneKey`). A plain checkout or lane has
 * neither. Never throws.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isDaemonManagedClone(root, env = process.env) {
  try {
    return existsSync(rebuildStatePath(root, env)) || existsSync(overlayFilePath(root, env));
  } catch {
    return false;
  }
}

// ── per-clone rebuild state (outside the git tree, per clause 3(iii) — same posture as daemon-overlays.mjs) ──

/** Env var pinning the rebuild-state root outside any git tree. */
export const WE_DAEMON_STATE_DIR_ENV = 'WE_DAEMON_STATE_DIR';

export function stateDir(env = process.env) {
  // One definition, shared with the staleness guard's last-good read (x5wbsbc) — never two spellings.
  return daemonStateDir(env);
}

/** `<stateDir>/<cloneKey>.rebuild.json` — reuses `daemon-overlays.mjs#cloneKey` so every per-clone state file
 *  (overlay list, rebuild state) keys on the SAME identity, never re-derived.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function rebuildStatePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.rebuild.json`);
}

export function alertsFilePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.alerts.jsonl`);
}

const EMPTY_STATE = Object.freeze({
  adopted: null, rejected: null, inProgress: null, quarantine: null, unverified: null, building: null, held: null, busySkippedTrees: null, smokePassed: null,
});

/**
 * Read the per-clone rebuild state, never throwing — a missing or corrupt file reads as the empty state (fail
 * closed to "nothing adopted, nothing rejected, nothing in progress", never a crash).
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{adopted:object|null, rejected:object|null, inProgress:object|null, quarantine:object|null,
 *   unverified:{head:string, prevHead:string}|null, building:object|null, smokePassed:Array<{key:string, tree:string, passedAt:string}>|null}}
 */
export function readRebuildState(root, env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(rebuildStatePath(root, env), 'utf8'));
    return {
      adopted: parsed?.adopted ?? null,
      rejected: parsed?.rejected ?? null,
      inProgress: parsed?.inProgress ?? null,
      quarantine: parsed?.quarantine ?? null,
      unverified: parsed?.unverified ?? null,
      building: parsed?.building ?? null,
      held: parsed?.held ?? null,
      busySkippedTrees: parsed?.busySkippedTrees ?? null,
      smokePassed: parsed?.smokePassed ?? null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Atomic write — `<file>.tmp-<pid>` then `renameSync`, same posture as `daemon-overlays.mjs#writeOverlays`. */
export function writeRebuildState(root, state, env = process.env) {
  const file = rebuildStatePath(root, env);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file);
}

// ── ready candidate — a PASSED smoke that could not be adopted yet (fix-rebuild-finalize) ─────────────────────
//
// Live 2026-09-26 on `wev-review-daemon`: a candidate passed its ~1-4 min off-lock smoke, then `finalizeRebuild`
// could not take the write lock within 60s because the SIBLING daemon had started a tick (read slot) during the
// smoke. The pass was thrown away; the next tick re-planned (main had moved — a new sha), re-smoked, and the
// sibling started another tick during THAT smoke. The build lease it left behind also made the sibling log
// `rebuild-in-progress` for up to 20 min. Registered overlay fixes were never adopted.
//
// Fix: a passing smoke is recorded here (`<cloneKey>.ready.json`, atomic rename, outside the git tree) BEFORE the
// finalize lock is attempted. Whichever process next holds the write lock — the mover itself on a later tick, or a
// SIBLING at its own tick start (a tick boundary: it holds no read slot then) — adopts it in `prepareRebuild`
// without re-smoking, as long as it was verified on top of the clone's CURRENT head. Written without the clone
// lock on purpose: only a build-lease holder writes it, the record fully describes itself, and every use of it
// re-checks it against the live HEAD under the write lock.

/** `<stateDir>/<cloneKey>.ready.json`. */
export function readyCandidatePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.ready.json`);
}

/** The recorded ready candidate, or `null` (missing/corrupt reads as none — never throws). */
export function readReadyCandidate(root, env = process.env) {
  try {
    const r = JSON.parse(readFileSync(readyCandidatePath(root, env), 'utf8'));
    return r && typeof r === 'object' && r.adopt?.finalSha && r.prevHead ? r : null;
  } catch {
    return null;
  }
}

export function writeReadyCandidate(root, record, env = process.env) {
  try {
    const file = readyCandidatePath(root, env);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function clearReadyCandidate(root, env = process.env) {
  try { unlinkSync(readyCandidatePath(root, env)); } catch { /* already gone */ }
}
