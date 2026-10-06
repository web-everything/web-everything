/**
 * @file scripts/lib/automation-home.mjs
 * @description Decouple the automation from the operator's primary checkout (epic #4075). THE ONE place that
 *   says where the automation's CODE and STATE live, so nothing has to reach into the operator's own working
 *   copy (`~/workspace/webeverything`) — a checkout the operator keeps for their dev server and their own WIP,
 *   which is routinely a detached HEAD hundreds of commits behind `main` (live 2026-09-27: 449 behind; the
 *   #3604 trial dispatched from it and ran on Claude instead of Codex because it was running old code).
 *
 *   Two homes, both owned by the automation, neither inside the operator's checkout:
 *
 *   - STATE — {@link automationStateRoot}: `<WE_DAEMON_STATE_DIR || ~/.claude/daemon-self-sync-state>/conveyor-state`
 *     (or the operator's explicit `CONVEYOR_STATE_ROOT` pin). This is the SAME root the run scorecards and the
 *     health watch already use (`daemon-last-good.mjs#daemonConveyorStateRoot`, #4052) — re-exported here, not
 *     redefined, so there is one state home rather than two. The build queue (`.conveyor/queue.json`) now lives
 *     here too (`we:scripts/conveyor/queue-store.mjs`).
 *
 *   - CODE — {@link controlClonePath}: a dedicated clone (`<workspace>/wev-control`, or `WE_CONTROL_CLONE`)
 *     kept on `origin/main` by the existing daemon rebuild machinery (`daemon-self-sync.mjs#withSelfSync` →
 *     `daemon-rebuild.mjs#rebuildClone`) — the build-dispatch daemon runs FROM it with `--self-sync`, so the
 *     clone is exactly as current as every other daemon clone. Anything the automation EXECUTES by absolute
 *     path (the gh shim's throttle CLI; `run.mjs dispatch-lane` invocations) resolves here.
 *
 *   The operator's checkout stays usable for their own manual runs (every script still works from it), but it
 *   is never REQUIRED and never READ by the automation except through the one-release compatibility read of
 *   the old queue location ({@link legacyStateRoots}).
 *
 *   Import-light on purpose (node builtins + two leaf modules): `queue-store.mjs` and `gh-app-shim.mjs` both
 *   import this, and neither may drag in `bootstrap-session.mjs`'s or `daemon-rebuild.mjs`'s import graphs.
 */

import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { logicalCloneRoot } from './daemon-clone-layout.mjs';
import { daemonConveyorStateRoot } from './daemon-last-good.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';

/** Env override for the control clone's absolute path. */
export const CONTROL_CLONE_ENV = 'WE_CONTROL_CLONE';

/** The control clone's directory name, as a sibling of the other daemon clones (`wev-review-daemon`, ...). */
export const CONTROL_CLONE_DIRNAME = 'wev-control';

const LANE_MARKER = `${sep}.lanes${sep}`;

/**
 * The WORKSPACE a checkout sits in — the shared parent of every primary checkout, daemon clone and `.lanes/`.
 * A lane or daemon version folder answers `<ws>`; any other checkout answers its parent directory. PURE.
 * Deliberately NOT `bootstrap-session.mjs#primaryCheckout`: this must resolve without the primary existing.
 * @param {string} root
 */
export function workspaceOf(root) {
  const path = logicalCloneRoot(resolve(String(root)));
  const i = path.indexOf(LANE_MARKER);
  return i >= 0 ? path.slice(0, i) : dirname(path);
}

const HERE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Fallback workspace when nothing better is known: `~/workspace` (the laptop's and every VM's layout). */
function defaultWorkspace(root, home) {
  if (root) return workspaceOf(root);
  return join(home, 'workspace');
}

/**
 * The control clone's absolute path: `WE_CONTROL_CLONE` when set, else `<workspace>/wev-control`, where the
 * workspace is derived from `root` (default: `~/workspace`, NOT this file's own checkout — a lane or scratch
 * clone resolving its own parent would name a directory nobody provisions). PURE besides the env read.
 * @param {{env?:NodeJS.ProcessEnv, root?:string, home?:string}} [o]
 */
export function controlClonePath({ env = process.env, root, home = homedir() } = {}) {
  const v = env?.[CONTROL_CLONE_ENV];
  if (v && String(v).trim()) return resolve(String(v).trim());
  return join(defaultWorkspace(root, home), CONTROL_CLONE_DIRNAME);
}

/** Does the control clone exist as a git checkout? (A `.git` entry — file or directory.) Never throws. */
export function controlCloneExists({ env = process.env, root, home = homedir(), exists = existsSync } = {}) {
  try { return exists(join(controlClonePath({ env, root, home }), '.git')); } catch { return false; }
}

/** Is `root` the control clone? Compared on resolved paths. PURE besides the env read. */
export function isControlClone(root, { env = process.env, home = homedir() } = {}) {
  return resolve(String(root)) === controlClonePath({ env, home, root });
}

/** The automation's state home — see the file header. Same value as `daemonConveyorStateRoot`. */
export function automationStateRoot(env = process.env) {
  return daemonConveyorStateRoot(env);
}

/**
 * The OLD state root a one-release compatibility read may fall back to when the new home has no file yet: the WE
 * primary checkout in the workspace — where `/conveyor` wrote the queue, and where the build daemon was pinned
 * (`CONVEYOR_STATE_ROOT=<primary>`), before this change. Only the primary: a lane's or a scratch clone's own
 * `.conveyor/` was never the live queue (live 2026-09-27: `lane-1` carried a stale 7-entry sidecar that a
 * "this checkout too" rule would have merged in). Realpath'd (the laptop's primary answers to `webeverything`
 * AND the `web-everything` symlink alias), de-duplicated, existing-only, never the state root itself. Read-only
 * use ONLY — nothing may write here.
 * @param {{root?:string, stateRoot?:string, exists?:(p:string)=>boolean, realpath?:(p:string)=>string}} [o]
 * @returns {string[]}
 */
export function legacyStateRoots({ root = HERE_ROOT, stateRoot = automationStateRoot(), exists = existsSync, realpath = realpathSync } = {}) {
  const ws = workspaceOf(root);
  const real = (p) => { try { return realpath(p); } catch { return resolve(p); } };
  const seen = new Set([real(stateRoot)]);
  const out = [];
  for (const d of CONSTELLATION_REPOS.we?.dirs ?? []) {
    const p = join(ws, d);
    let ok = false;
    try { ok = exists(p); } catch { ok = false; }
    if (!ok) continue;
    const key = real(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
