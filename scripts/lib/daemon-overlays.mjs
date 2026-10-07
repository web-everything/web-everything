/**
 * @file scripts/lib/daemon-overlays.mjs
 * @description Module B (card 4041-adjacent) of the daemon-clone rebuild
 *   (docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 5) — the per-clone OVERLAY LIST:
 *   an explicit, ordered list of fix branches a daemon clone merges onto `main` at every rebuild, each dropped
 *   automatically once `main` has it (clause 5(b)/(c)). This file owns only the LIST's storage and mutation;
 *   `scripts/lib/daemon-rebuild.mjs` (Module C) is what actually applies/drops entries during a rebuild, and
 *   `scripts/daemon-overlay.mjs` is the add/remove/list CLI built on top of these exports.
 *
 * WHY THE STATE FILE LIVES OUTSIDE THE CLONE. Clause 3(iii) pins per-clone daemon state (queue, scorecard,
 * overlay list) to a root given by env/flag, never inside the git tree the daemon rebuilds — a `git reset
 * --hard` (Module C) must never wipe the record of what to merge back in. `cloneKey(root)` derives a stable,
 * filesystem-safe id from the clone's canonical logical root (realpath first, falling back to a plain `resolve` if `realpathSync` throws,
 * e.g. a path that does not exist yet) so two different spellings of the same clone (a symlink vs. its
 * target) collide on the same state file, mirroring `daemon-clone-lock.mjs`'s own per-clone id scheme
 * (Module A, same ruling clause) — reuse this one function everywhere per-clone state lives, never re-derive.
 *
 * CORRUPTION IS FAIL-CLOSED, NEVER FAIL-LOUD. A hand-edited or half-written overlay file must never crash a
 * daemon tick: {@link readOverlayState} treats an unparsable or wrong-shaped file exactly like a missing one
 * (empty list) and only additionally flags `corrupt:true` so a caller CAN alert on it — it never throws. The
 * callers that act on the list MUST check that flag (`daemon-rebuild.mjs` refuses to move with an
 * `overlay-state-corrupt` alert, the CLI `list` exits 1): reading a corrupt file as "no overlays" and building
 * on it would silently drop every registered fix. {@link addOverlay}/{@link removeOverlay} throw on a corrupt
 * file rather than overwrite it with a fresh list, so the damaged file is left for a person to inspect.
 * {@link writeOverlays} writes `<file>.tmp-<pid>` then `renameSync`s over the real path, so a write that dies
 * mid-flight (kill -9, disk full) either fully lands or leaves the OLD file untouched — never a half-written
 * `.json` a later read would have to treat as corrupt in the first place. This module never itself takes the
 * clone's reader/writer lock (Module A) — callers serialize: the daemon calls these while already holding the
 * WRITE lock inside a rebuild, and the CLI (`scripts/daemon-overlay.mjs`) takes it around its own add/remove.
 *
 * `appendOverlayEvent` is the audit trail every overlay-list change is expected to leave: `added`/`removed` for
 * a manual CLI action, `auto-dropped` (clause 5(b), `in-main`/`pr-merged`/`pr-closed`/`ref-gone`) and
 * `conflict-dropped` (clause 5(c)) for what a rebuild does on its own — one JSON line per event, never
 * rewritten, so the history survives even though the list itself is mutated in place.
 */

import {
  readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, rmdirSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { canonicalCloneRoot } from './daemon-clone-layout.mjs';
import { isSafeBranchName } from './daemon-self-sync.mjs';

/** Env var that pins the overlay state root outside any git tree (ruling clause 3(iii)). */
export const WE_DAEMON_OVERLAY_DIR_ENV = 'WE_DAEMON_OVERLAY_DIR';

/** Default overlay state root when the env override is unset. */
function overlayDir(env = process.env) {
  const fromEnv = typeof env?.[WE_DAEMON_OVERLAY_DIR_ENV] === 'string' ? env[WE_DAEMON_OVERLAY_DIR_ENV].trim() : '';
  return fromEnv || join(homedir(), '.claude', 'daemon-overlays');
}

/** Resolve symlinks before mapping version folders back to their logical clone identity. */
function resolveCloneRoot(root) {
  return canonicalCloneRoot(root);
}

/**
 * Stable, filesystem-safe id for a clone root: sha256 of its canonical logical path, first 16 hex chars. Two spellings
 * of the same clone (symlink vs. target) collide on the same id. Reuse this everywhere per-clone state lives.
 * @param {string} root
 * @returns {string}
 */
export function cloneKey(root) {
  return createHash('sha256').update(resolveCloneRoot(root)).digest('hex').slice(0, 16);
}

/**
 * The overlay list's JSON state file for `root`, under the pinned overlay dir (env override or
 * `~/.claude/daemon-overlays`). `env` is a plain `process.env`-shaped object, not wrapped in an options bag.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function overlayFilePath(root, env = process.env) {
  return join(overlayDir(env), `${cloneKey(root)}.json`);
}

/** The append-only audit-trail file for `root`, sibling to its state file. */
function eventsFilePath(root, env = process.env) {
  return join(overlayDir(env), `${cloneKey(root)}.events.jsonl`);
}

/**
 * Read the full per-clone overlay state, never throwing. A missing file is the ordinary empty state
 * (`corrupt:false`); an unparsable file or one that is not `{overlays: [...]}`-shaped is `corrupt:true`, also
 * with an empty list — a caller decides whether/how to alert, this function only fails closed.
 * @param {string} root
 * @param {{env?:NodeJS.ProcessEnv}} [o]
 * @returns {{clone:string|null, overlays:Array<object>, corrupt:boolean}}
 */
export function readOverlayState(root, { env = process.env } = {}) {
  const file = overlayFilePath(root, env);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { clone: null, overlays: [], corrupt: false };
    return { clone: null, overlays: [], corrupt: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { clone: null, overlays: [], corrupt: true };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.overlays)) {
    return { clone: null, overlays: [], corrupt: true };
  }
  return { clone: typeof parsed.clone === 'string' ? parsed.clone : null, overlays: parsed.overlays, corrupt: false };
}

/**
 * Just the overlay list — missing/corrupt file both read as `[]`, never throws.
 * @param {string} root
 * @param {{env?:NodeJS.ProcessEnv}} [o]
 * @returns {Array<{ref:string, pr:number|null, addedAt:string, addedBy:string|null, reason:string|null}>}
 */
export function readOverlays(root, { env = process.env } = {}) {
  return readOverlayState(root, { env }).overlays;
}

// ── the list mutex — every read-modify-write of the list runs under it ─────────────────────────────────────
//
// WHY. Live 2026-09-24/25 (#2640, #2641, #2643): an overlay `add` was LOST. `daemon-load-overlay.mjs` adds WITHOUT
// the clone lock, and the CLI has `--no-lock`; meanwhile a rebuild's auto-remove of a merged overlay read the
// list, then wrote it back — without the entry added in between. So the list itself now serializes its own
// read-modify-writes, whatever lock (if any) the caller holds: a `mkdir` mutex next to the state file, held for
// milliseconds (never across a smoke, unlike the clone write lock), so an add never waits minutes on a rebuild.
// A holder that died is detected by age (`LIST_LOCK_STALE_MS`) and its lock is broken.

const LIST_LOCK_STALE_MS = 30_000;
const LIST_LOCK_WAIT_MS = 20_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `fn` holding the overlay list's own mutex for `root`. Throws if it cannot be taken within the wait. */
function withListLock(root, env, fn) {
  const lockDir = `${overlayFilePath(root, env)}.lock`;
  mkdirSync(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + LIST_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LIST_LOCK_STALE_MS) { rmdirSync(lockDir); continue; }
      } catch { continue; /* released between our mkdir and stat — retry at once */ }
      if (Date.now() > deadline) throw new Error(`daemon-overlays: overlay list lock ${lockDir} still held after ${LIST_LOCK_WAIT_MS}ms`);
      sleepSync(10);
    }
  }
  try {
    // Test-only seam: widen the read→write window so a race test can prove the mutex (never set in production).
    const delay = Number(env?.WE_DAEMON_OVERLAYS_TEST_RMW_DELAY_MS);
    const marker = env?.WE_DAEMON_OVERLAYS_TEST_RMW_MARKER;
    return fn(delay > 0 ? () => { if (marker) writeFileSync(marker, String(process.pid)); sleepSync(delay); } : () => {});
  } finally {
    try { rmdirSync(lockDir); } catch { /* already broken as stale by another process — nothing to release */ }
  }
}

/** The list to MUTATE — like {@link readOverlays}, but throws on a corrupt file so a write never replaces it. */
function readOverlaysForWrite(root, env) {
  const state = readOverlayState(root, { env });
  if (state.corrupt) {
    throw new Error(`daemon-overlays: overlay state file ${overlayFilePath(root, env)} is corrupt — refusing to overwrite it; fix or remove it by hand`);
  }
  return state.overlays;
}

/**
 * Atomically replace the overlay list: write `<file>.tmp-<pid>` then `renameSync` over the real path, so a
 * reader never sees a half-written file and a killed write never corrupts the previous good one. `clone` is
 * always recomputed fresh from `root` at write time (never trusted from the prior file).
 * @param {string} root
 * @param {Array<object>} list
 * @param {{env?:NodeJS.ProcessEnv}} [o]
 * @returns {Array<object>} the same `list`, for chaining
 */
export function writeOverlays(root, list, { env = process.env } = {}) {
  const file = overlayFilePath(root, env);
  mkdirSync(dirname(file), { recursive: true });
  const payload = JSON.stringify({ clone: resolveCloneRoot(root), overlays: list }, null, 2);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, payload, 'utf8');
  renameSync(tmp, file);
  return list;
}

/**
 * Add (or, for a ref already present, update in place) one overlay entry. `ref` is validated with
 * {@link isSafeBranchName} (`daemon-self-sync.mjs`) — an unsafe ref throws a `TypeError` rather than ever
 * being written to disk or later spliced into a git argv. A duplicate `ref` updates `pr`/`reason` and keeps
 * its ORIGINAL position, `addedAt`, and `addedBy` — re-registering an overlay is not a re-add.
 * `pinned:true` marks an overlay the rebuild must never drop for a conflict (it refuses instead — see
 * `daemon-rebuild.mjs#REBUILD_MECHANISM_PATHS`); `pinned:false` clears the flag; leaving it out keeps it as is.
 * @param {string} root
 * @param {{ref:string, pr?:number|null, addedBy?:string|null, reason?:string|null, now?:string, pinned?:boolean}} entry
 * @param {{env?:NodeJS.ProcessEnv}} [o]
 * @returns {Array<object>} the new list
 */
export function addOverlay(root, {
  ref, pr = null, addedBy = null, reason = null, now, pinned,
} = {}, { env = process.env } = {}) {
  if (!isSafeBranchName(ref)) {
    throw new TypeError(`daemon-overlays: ref ${JSON.stringify(ref)} is not a safe branch name — refusing to add it`);
  }
  return withListLock(root, env, (pause) => {
    const list = readOverlaysForWrite(root, env).slice();
    pause();
    const idx = list.findIndex((o) => o && o.ref === ref);
    if (idx === -1) {
      list.push({
        ref, pr: pr ?? null, addedAt: now || new Date().toISOString(), addedBy: addedBy ?? null, reason: reason ?? null,
        ...(pinned === true ? { pinned: true } : {}),
      });
    } else {
      const next = { ...list[idx], pr: pr ?? null, reason: reason ?? null };
      if (pinned === true) next.pinned = true;
      else if (pinned === false) delete next.pinned;
      list[idx] = next;
    }
    return writeOverlays(root, list, { env });
  });
}

/**
 * Record WHO approved WHICH `origin/edge/<ref>` tip as the conflict resolution for a registered overlay
 * (`edgeResolution: {sha, by, at, reason?}` on its entry). The rebuild adopts an edge branch only when its tip
 * equals this sha (`daemon-rebuild.mjs#recordedEdgeSha`), so a branch anyone pushed under `edge/` is never run.
 * `sha` must be a full lowercase 40-hex sha and `by` a non-empty actor; the overlay must already be registered
 * (an approval for an unregistered ref would sit unused and misleading). Re-recording replaces the previous
 * approval; removing the overlay drops it with the entry. Leaves an audit event.
 * @param {string} root
 * @param {string} ref
 * @param {{sha:string, by:string, reason?:string|null, now?:string}} approval
 * @param {{env?:NodeJS.ProcessEnv}} [o]
 * @returns {Array<object>} the new list
 */
export function recordEdgeResolution(root, ref, {
  sha, by, reason = null, now,
} = {}, { env = process.env } = {}) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new TypeError(`daemon-overlays: edge resolution sha ${JSON.stringify(sha)} must be a full 40-hex sha`);
  }
  if (typeof by !== 'string' || by.trim() === '') {
    throw new TypeError('daemon-overlays: an edge resolution needs a non-empty actor (by)');
  }
  const list = withListLock(root, env, (pause) => {
    const current = readOverlaysForWrite(root, env).slice();
    pause();
    const idx = current.findIndex((o) => o && o.ref === ref);
    if (idx === -1) throw new Error(`daemon-overlays: overlay ${JSON.stringify(ref)} is not registered — cannot record an edge resolution for it`);
    current[idx] = {
      ...current[idx],
      edgeResolution: { sha, by: by.trim(), at: now || new Date().toISOString(), ...(reason ? { reason } : {}) },
    };
    return writeOverlays(root, current, { env });
  });
  appendOverlayEvent(root, { kind: 'edge-resolution-recorded', ref, sha, by: by.trim(), reason }, { env });
  return list;
}

/**
 * Remove one overlay entry by ref, if present. Idempotent — removing an absent ref is not an error, just
 * `removed:false`. `why` is accepted for the caller's own bookkeeping (e.g. the CLI's audit event / a
 * rebuild's `remove` reason) but is not itself written by this function — pair it with
 * {@link appendOverlayEvent} when the removal should be recorded.
 * @param {string} root
 * @param {string} ref
 * @param {{env?:NodeJS.ProcessEnv, why?:string}} [o]
 * @returns {{removed:boolean, list:Array<object>}}
 */
export function removeOverlay(root, ref, { env = process.env, why } = {}) {
  void why; // caller bookkeeping only — see JSDoc above.
  return withListLock(root, env, (pause) => {
    const list = readOverlaysForWrite(root, env);
    pause();
    const idx = list.findIndex((o) => o && o.ref === ref);
    if (idx === -1) return { removed: false, list };
    const next = list.slice(0, idx).concat(list.slice(idx + 1));
    writeOverlays(root, next, { env });
    return { removed: true, list: next };
  });
}

/**
 * Append one line to the per-clone audit trail (`<cloneKey>.events.jsonl`) — never rewritten, so it survives
 * every later mutation of the list itself. `event` should carry at least `{kind, ref}`; `at` is stamped here.
 * @param {string} root
 * @param {object} event
 * @param {{env?:NodeJS.ProcessEnv}} [o]
 * @returns {void}
 */
export function appendOverlayEvent(root, event, { env = process.env } = {}) {
  const file = eventsFilePath(root, env);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
}
