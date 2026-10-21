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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalCloneRoot } from './daemon-clone-layout.mjs';
import { isSafeBranchName } from './daemon-self-sync.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { OPERATOR_LOGINS } from './marker-authorship.mjs';

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
 * `stackBases` (held item 212) records the PR's base-branch chain, nearest first (e.g. `['lane/b', 'lane/a']` for a PR
 * stacked on lane/b, itself on lane/a). The rebuild reads it only when gh cannot answer; leaving it out keeps it as is.
 * @param {{ref:string, pr?:number|null, addedBy?:string|null, reason?:string|null, now?:string, pinned?:boolean,
 *   stackBases?:string[]}} entry
 * @param {{env?:NodeJS.ProcessEnv}} [o]
 * @returns {Array<object>} the new list
 */
/**
 * allow-conflict gate (live 2026-10-21: two agents registered with `--allow-conflict` on the review clone in one
 * afternoon, which the operator forbids). A conflict override is the OPERATOR's call only, proven by CREDENTIAL, not by
 * a typed flag: `viewerLogin` must be the login the caller's GitHub credential authenticates as (read by the caller with
 * `extend-rounds-io.mjs#readViewerLogin`, the same check extend-rounds uses) and must be one of
 * `marker-authorship.mjs#OPERATOR_LOGINS`. An App/bot/other credential, or one that cannot be read, is refused, whatever
 * `--actor` says. The operator's own words (`--operator-instruction="<quote>"`, 3+ words) are recorded with the login.
 * Shared by `daemon-overlay add` and `daemon-load-overlay`. Pure: the caller does the credential read.
 * @returns {{ok:true, override:null|{instruction:string, actor:string, at:string}}|{ok:false, error:string}}
 */
export function allowConflictGate({
  allowConflict, operatorInstruction, viewerLogin, operatorLogins = OPERATOR_LOGINS, now,
} = {}) {
  if (!allowConflict) return { ok: true, override: null };
  const quote = typeof operatorInstruction === 'string' ? operatorInstruction.trim() : '';
  if (quote.split(/\s+/).filter(Boolean).length < 3 || quote.length > 1000) {
    return { ok: false, error: '--allow-conflict is the operator\'s call only: pass --operator-instruction="<the operator\'s own words authorising this override>" (3+ words), run under the operator\'s own GitHub credential' };
  }
  const viewer = typeof viewerLogin === 'string' ? viewerLogin.trim().toLowerCase() : '';
  if (!viewer || !operatorLogins.includes(viewer)) {
    return { ok: false, error: `--allow-conflict must run under the operator's own GitHub credential; this one is "${viewer || 'unknown'}" (a typed --actor does not count)` };
  }
  return { ok: true, override: { instruction: quote, actor: viewer, at: now || new Date().toISOString() } };
}

/** The caller's GitHub login for {@link allowConflictGate}, or null when it cannot be read (fails closed). */
export async function readOverrideViewerLogin() {
  try {
    const { readViewerLogin } = await import('../operations/extend-rounds-io.mjs');
    return String(readViewerLogin() ?? '').trim() || null;
  } catch { return null; }
}

export function addOverlay(root, {
  ref, pr = null, addedBy = null, reason = null, now, pinned, stackBases, conflictOverride,
} = {}, { env = process.env } = {}) {
  if (!isSafeBranchName(ref)) {
    throw new TypeError(`daemon-overlays: ref ${JSON.stringify(ref)} is not a safe branch name — refusing to add it`);
  }
  const bases = Array.isArray(stackBases) ? stackBases.filter((b) => isSafeBranchName(b)) : null;
  return withListLock(root, env, (pause) => {
    const list = readOverlaysForWrite(root, env).slice();
    pause();
    const idx = list.findIndex((o) => o && o.ref === ref);
    if (idx === -1) {
      list.push({
        ref, pr: pr ?? null, addedAt: now || new Date().toISOString(), addedBy: addedBy ?? null, reason: reason ?? null,
        ...(pinned === true ? { pinned: true } : {}),
        ...(bases ? { stackBases: bases } : {}),
        ...(conflictOverride ? { conflictOverride } : {}),
      });
    } else {
      const next = { ...list[idx], pr: pr ?? null, reason: reason ?? null };
      if (pinned === true) next.pinned = true;
      else if (pinned === false) delete next.pinned;
      if (bases) next.stackBases = bases;
      if (conflictOverride) next.conflictOverride = conflictOverride;
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

// ── overlay stacks (held item 212) ─────────────────────────────────────────────────────────────────────────────

/** Env override for `overlay.stackMode`. */
export const OVERLAY_STACK_MODE_ENV = 'WE_DAEMON_OVERLAY_STACK_MODE';
/** `tops`: a stack of overlay PRs applies only its tops (default). `independent`: every overlay applies on its own. */
export const OVERLAY_STACK_MODES = Object.freeze(['tops', 'independent']);
const OVERLAY_SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'daemon-rebuild-settings.json');

/**
 * IO: `overlay.stackMode` through the policy cascade (standard `tops` → platform → tool block `overlay` in
 * daemon-rebuild-settings.json → env {@link OVERLAY_STACK_MODE_ENV}). Never throws; an invalid value is ignored.
 * @returns {{mode:'tops'|'independent', source:string}}
 */
export function resolveOverlayStackMode(env = process.env, { settingsPath = OVERLAY_SETTINGS_PATH } = {}) {
  try {
    let tool;
    try { tool = JSON.parse(readFileSync(settingsPath, 'utf8'))?.overlay; } catch { tool = undefined; }
    const ev = typeof env?.[OVERLAY_STACK_MODE_ENV] === 'string' ? env[OVERLAY_STACK_MODE_ENV].trim() : undefined;
    const r = cascadePolicy('overlay', tool, {
      env,
      standard: { stackMode: 'tops' },
      envValues: { stackMode: ev || undefined },
      valid: { stackMode: (v) => OVERLAY_STACK_MODES.includes(v) },
    });
    const mode = r.value?.stackMode;
    return OVERLAY_STACK_MODES.includes(mode) ? { mode, source: r.sources?.stackMode ?? 'standard' } : { mode: 'tops', source: 'standard' };
  } catch {
    return { mode: 'tops', source: 'standard' };
  }
}

/** overlay-rebase-on-merge (2026-10-21) — what a rebuild does with an overlay that conflicts with a NEW main:
 *  `off` = today (hold/drop as before), `shadow` = log what it WOULD do (`overlay-auto-rebase-shadow`), `on` = rebase past
 *  a proven merged-PR old head (`overlay-auto-rebased`) or set the overlay aside (`overlay-set-aside`) and keep building.
 *  Cascade key `overlay.autoRebase` (standard `shadow`); `WE_DAEMON_OVERLAY_AUTO_REBASE=off` is the kill switch. */
export const OVERLAY_AUTO_REBASE_ENV = 'WE_DAEMON_OVERLAY_AUTO_REBASE';
export const OVERLAY_AUTO_REBASE_MODES = Object.freeze(['off', 'shadow', 'on']);

/** @returns {{mode:'off'|'shadow'|'on', source:string}} — never throws; an unreadable cascade reads as `shadow`. */
export function resolveOverlayAutoRebase(env = process.env, { settingsPath = OVERLAY_SETTINGS_PATH } = {}) {
  const ev = typeof env?.[OVERLAY_AUTO_REBASE_ENV] === 'string' ? env[OVERLAY_AUTO_REBASE_ENV].trim() : undefined;
  if (ev === 'off') return { mode: 'off', source: `env ${OVERLAY_AUTO_REBASE_ENV}` }; // kill switch wins outright
  try {
    let tool;
    try { tool = JSON.parse(readFileSync(settingsPath, 'utf8'))?.overlay; } catch { tool = undefined; }
    const r = cascadePolicy('overlay', tool, {
      env,
      standard: { autoRebase: 'shadow' },
      envValues: { autoRebase: ev || undefined },
      valid: { autoRebase: (v) => OVERLAY_AUTO_REBASE_MODES.includes(v) },
    });
    const mode = r.value?.autoRebase;
    return OVERLAY_AUTO_REBASE_MODES.includes(mode) ? { mode, source: r.sources?.autoRebase ?? 'standard' } : { mode: 'shadow', source: 'standard' };
  } catch {
    return { mode: 'shadow', source: 'standard' };
  }
}

/** Both reads are one small JSON row / one URL line; anything bigger is not what we asked for. */
const GH_MAX_BUFFER = 1024 * 1024;

/** What a gh runner returns when the call hit its timeout (as opposed to `undefined`: gh answered with an error). */
export const GH_TIMED_OUT = Symbol('gh-timed-out');
/** One gh call may wait this long… */
const GH_CALL_TIMEOUT_MS = 20_000;
/** …and all gh calls of one rebuild's base-chain reads together may wait this long (rebuild lock is held meanwhile). */
export const GH_CHAIN_BUDGET_MS = 60_000;

function ghSlug(root, timeoutMs = GH_CALL_TIMEOUT_MS) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: GH_MAX_BUFFER });
  const m = r.status === 0 ? String(r.stdout || '').trim().match(/github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?\/?$/) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

function ghJson(args, { env, timeoutMs = GH_CALL_TIMEOUT_MS } = {}) {
  const r = spawnSync('gh', args, {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: GH_MAX_BUFFER, ...(env ? { env } : {}),
  });
  if (r.error?.code === 'ETIMEDOUT') return GH_TIMED_OUT;
  if (r.status !== 0) return undefined;
  try { return JSON.parse(String(r.stdout || '')); } catch { return undefined; }
}

/**
 * IO: a `prBaseChain(pr)` for {@link planRebuild}: the PR's base branch, then that branch's own open PR's base, and so on
 * until `main` (nearest first, at most `maxDepth` hops). Asks gh; when gh cannot answer (no gh, no auth, a non-GitHub
 * origin) it falls back to the entry's recorded `stackBases`, else `null` (unknown — the rebuild then judges by ancestry
 * alone). Lookups are memoised for the life of the returned function (one rebuild).
 *
 * Time bound: gh runs synchronously inside the rebuild, so all its calls share one budget (`budgetMs`) and a circuit
 * breaker — the first gh timeout, or the budget running out, stops every further call; from then on each PR answers from
 * its recorded `stackBases` (never from a half-walked chain after a trip). A lookup that fails without a timeout in the
 * middle of a walk also answers from the recorded chain when there is one.
 * `fresh` (a property of the returned function) holds `pr → chain` for the chains gh answered completely, for
 * {@link persistStackBases}. `forcePushes(pr)` (also a property) reads the PR's force-push events for the rebuild's
 * "base moved" evidence, under the same budget.
 * @param {{root:string, overlays?:Array<object>, gh?:(args:string[], o?:{env?:object,timeoutMs?:number})=>unknown,
 *   maxDepth?:number, budgetMs?:number, now?:()=>number, slug?:string|null, env?:NodeJS.ProcessEnv}} o
 * @returns {((pr:number)=>Promise<string[]|null>) & {fresh:Map<number,string[]>,
 *   forcePushes:(pr:number)=>Promise<Array<{before:string,after:string|null}>|null>}}
 */
export function makePrBaseChain({
  root, overlays = [], gh = ghJson, maxDepth = 8, budgetMs = GH_CHAIN_BUDGET_MS, now = Date.now, slug: slugOverride, env,
} = {}) {
  const startedAt = now();
  let tripped = false;
  let slug = slugOverride;
  // The slug read is a local `git` call, but it waits under the same budget as the gh calls (and never longer than 5s).
  const slugOf = () => {
    if (slug === undefined) {
      const left = budgetMs - (now() - startedAt);
      if (left <= 0) { tripped = true; return null; }
      try { slug = ghSlug(root, Math.min(5_000, left)); } catch { slug = null; }
    }
    return slug;
  };
  /** One gh call under the shared budget; `undefined` once tripped, out of budget, or when gh could not answer. */
  const call = (args) => {
    if (tripped) return undefined;
    const left = budgetMs - (now() - startedAt);
    if (left <= 0) { tripped = true; return undefined; }
    let out;
    try { out = gh(args, { env, timeoutMs: Math.min(GH_CALL_TIMEOUT_MS, left) }); } catch { return undefined; }
    if (out === GH_TIMED_OUT) { tripped = true; return undefined; }
    return out;
  };
  const baseOfRef = new Map(); // head ref → its open PR's base branch, or null (no open PR: the end of the walk)
  const failedRefs = new Set();
  const memo = new Map();
  const fresh = new Map();
  const recorded = (pr) => {
    const e = overlays.find((o) => o && o.pr === pr);
    return Array.isArray(e?.stackBases) ? e.stackBases.filter((b) => typeof b === 'string' && b) : null;
  };
  const walk = (pr) => {
    const s = slugOf();
    const first = s ? call(['pr', 'view', String(pr), '--repo', s, '--json', 'baseRefName']) : undefined;
    const base = first?.baseRefName;
    if (typeof base !== 'string' || !base) return recorded(pr);
    const chain = [];
    let complete = true;
    let ref = base;
    while (ref && ref !== 'main' && chain.length < maxDepth && !chain.includes(ref)) {
      // A base name gh hands back is data from the PR author: it must be a safe branch name before it is used again.
      if (!isSafeBranchName(ref)) { complete = false; break; }
      chain.push(ref);
      if (!baseOfRef.has(ref)) {
        // `--head` matches the branch NAME in any fork, so ask for a few and take the first same-repository PR only.
        const rows = failedRefs.has(ref) ? undefined : call(['pr', 'list', '--repo', s, '--head', ref, '--state', 'open', '--json', 'baseRefName,isCrossRepository', '--limit', '10']);
        if (!Array.isArray(rows)) { failedRefs.add(ref); complete = false; break; }
        const own = rows.find((r) => r && r.isCrossRepository !== true);
        baseOfRef.set(ref, typeof own?.baseRefName === 'string' ? own.baseRefName : null);
      }
      ref = baseOfRef.get(ref);
    }
    if (ref && ref !== 'main') complete = false; // cut by maxDepth, a cycle, or an unsafe name: a prefix, not the whole chain
    if (tripped) return recorded(pr);
    if (!complete) return recorded(pr) ?? chain;
    fresh.set(pr, chain);
    return chain;
  };
  const chainOf = async (pr) => {
    if (pr == null) return null;
    if (!memo.has(pr)) memo.set(pr, walk(pr));
    return memo.get(pr);
  };
  chainOf.fresh = fresh;
  // The PR's head_ref_force_pushed events (newest 50) as `{before, after}`, under the same budget and breaker; `null`
  // (unknown) when gh cannot answer, answers in an unexpected shape, or names a commit it no longer has.
  const pushesMemo = new Map();
  chainOf.forcePushes = async (pr) => {
    const n = Number(pr);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (!pushesMemo.has(n)) {
      const s = slugOf();
      const [owner, name] = s ? s.split('/') : [];
      const out = owner && name
        ? call(['api', 'graphql', '-f', `query=${FORCE_PUSHES_QUERY}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${n}`])
        : undefined;
      const nodes = out && typeof out === 'object' && !out.errors ? out.data?.repository?.pullRequest?.timelineItems?.nodes : undefined;
      let events = null;
      if (Array.isArray(nodes)) {
        events = [];
        for (const e of nodes) {
          const before = e?.beforeCommit?.oid;
          const after = e?.afterCommit?.oid;
          if (typeof before !== 'string' || !OID.test(before)) { events = null; break; }
          events.push({ before, after: typeof after === 'string' && OID.test(after) ? after : null });
        }
      }
      pushesMemo.set(n, events);
    }
    return pushesMemo.get(n);
  };
  return chainOf;
}

const OID = /^[0-9a-f]{40}$/;
const FORCE_PUSHES_QUERY = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){'
  + 'timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],last:50){nodes{... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid}}}}}}}';

/**
 * Record the base chains gh answered completely (`fresh`: `pr → chain`, from {@link makePrBaseChain}) on the registered
 * entries, so a later rebuild that cannot reach gh still sees the stack. Writes only entries whose chain changed (an empty
 * chain clears the field), under the list lock and from a fresh read, so a concurrent add/remove is never overwritten and
 * an entry that vanished is skipped. Only `stackBases` is touched — `pr`, `reason` and the rest stay as they are. A
 * recorded chain only says which stack an overlay belongs to; setting a base aside still needs hard evidence it moved.
 * @param {string} root
 * @param {Map<number,string[]>} fresh
 * @param {{env?:NodeJS.ProcessEnv}} [o]
 * @returns {{written:number}}
 */
export function persistStackBases(root, fresh, { env = process.env } = {}) {
  if (!(fresh instanceof Map) || fresh.size === 0) return { written: 0 };
  return withListLock(root, env, () => {
    const list = readOverlaysForWrite(root, env).slice();
    let written = 0;
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i];
      if (!e || e.pr == null || !fresh.has(e.pr)) continue;
      const bases = (fresh.get(e.pr) ?? []).filter((b) => isSafeBranchName(b));
      const had = Array.isArray(e.stackBases) ? e.stackBases : null;
      if (had ? JSON.stringify(had) === JSON.stringify(bases) : bases.length === 0) continue;
      if (bases.length === 0) { const { stackBases, ...rest } = e; void stackBases; list[i] = rest; } else list[i] = { ...e, stackBases: bases };
      written += 1;
    }
    if (written > 0) writeOverlays(root, list, { env });
    return { written };
  });
}
