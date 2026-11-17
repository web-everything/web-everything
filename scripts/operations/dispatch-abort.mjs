#!/usr/bin/env node
/**
 * @file scripts/operations/dispatch-abort.mjs
 * @description SAFELY STOP AND CLOSE OUT ONE DISPATCHED AGENT — the recurring by-hand sequence from #3383's
 *   2026-08-31 live-fire session, mechanized (the operator's own request: "prefer the creation of operation
 *   for all recurring commands").
 *
 * WHAT WENT WRONG WITHOUT IT. That session stopped a stuck dispatched agent with a raw OS `kill <pid>` instead
 * of `claude stop <id>`. `kill` ends the process; it does not deregister the session, and whatever keeps
 * background sessions resumable (the same machinery that backs the mobile "remote agent" view) brought it back
 * under a NEW pid minutes later — twice, across two different scratch clones. One resurrection raced a second,
 * legitimate dispatch onto the same lane, producing a real double-dispatch onto `lane-5` (caught and cleaned up
 * by hand; no damage done, because the lane was still clean when found). `claude stop <id>` does not have this
 * problem — every stop that session issued through it never came back.
 *
 * THE COMPOSITION THIS FILE OWNS: stop, THEN close out — in that order, so `we:scripts/operations/wake.mjs`'s
 * own `assertHandleNotLive` passes NATURALLY instead of needing `--force`. `--force` exists for the case
 * `wake.mjs`'s header names — a listing that cannot be read, or an operator who already knows by other means
 * the agent is gone — not for "I did not stop it properly first." This file's whole job is to make the
 * properly-first path as easy to reach for as the unsafe one.
 *
 * TRUST IS A SEPARATE, SMALLER PIECE, same file because the same session hit both gaps back to back:
 * `we:scripts/bootstrap-session.mjs`'s own `trustableDirs()` only ever trusts the primary checkout and
 * lane-pool lanes — never an ad-hoc scratch clone, which is exactly what #3353's live-run protocol calls for
 * (a checkout named anything other than `lane-N`). A fresh scratch clone is therefore ALWAYS untrusted on
 * first use, and a dispatched agent spawned into it stalls on a permission-prompt dialog with nobody there to
 * answer it — the same class of failure the bootstrap's own `trust` step already exists to prevent for lanes,
 * just never extended to cover this one other place agents are spawned into. `trustCheckout` below reuses the
 * exact primitive (`withTrustedDirs`) the bootstrap step already uses, rather than re-deriving it.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: release the lane a dispatch may have partially acquired. That is
 * one more judgement (is the lane actually clean? was ANYTHING started before the stop?) layered on top of two
 * already-real ones, and automating it risks silently discarding a dirty tree. `abortDispatch`'s report names
 * the lane from the effect's own payload when one was assigned, so the operator does not have to go looking —
 * releasing it stays a deliberate `node scripts/lane-pool.mjs release --lane=<n> --force` call.
 *
 * IO: `store`, `listAgents` and `exec` are all injected, exactly like `we:scripts/operations/wake.mjs` and
 * `we:scripts/operations/dispatch-lane-io.mjs`. The CLI block at the bottom is the only part that touches the
 * real filesystem, `claude agents --json`, `claude stop` and `~/.claude.json`.
 */

import { listSessions as readSessions } from '../lib/claude-sessions.mjs';
import { stopPlan, afterStopMiss, readStore } from '../lib/claude-stores.mjs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeOutEntry, flagValue } from './wake.mjs';
import { defaultListAgents, normalizeHandle } from './dispatch-lane-io.mjs';
import { createFileRunStore } from './run-store.mjs';
import { defaultIo, withTrustedDirs, untrustedDirs } from '../bootstrap-session.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';

// Named so a test can assert it survives, not just the call shape — a timeout buried as an inline default is
// exactly what PR #1211's review F5 found silently deleted from `dispatch-lane-io.mjs` because nothing pinned
// it (see that file's own `defaultSpawnAgent`/`defaultRunNode` for the precedent this follows).
export const STOP_EXEC_OPTS = Object.freeze({ encoding: 'utf8', timeout: 30_000 });

/**
 * `claude stop <id>` — the ONLY way to end a background session that also deregisters it. A raw `kill <pid>`
 * ends the process but leaves the session resumable, which is the exact gap this file exists to close (see
 * the file header). Injectable `exec`, same shape as `we:scripts/operations/dispatch-lane-io.mjs`'s
 * `defaultSpawnAgent`.
 *
 * A handle already gone (never started, or stopped by someone else already) is NOT an error here — `claude
 * stop` on an unknown id exits 1 with `No job matching '<id>'…` on its stderr, and `abortDispatch` calls this
 * unconditionally whenever a handle exists rather than pre-checking liveness itself (see that function's own
 * doc for why: the pre-check was a second, redundant `claude agents --json` read that could also fail OPEN on
 * a malformed listing). Any OTHER failure (missing `claude` binary, a real crash) still throws.
 *
 * @param {{handle: string, exec?: Function}} o
 * @returns {{stopped: true, alreadyGone: boolean, output: string}}
 */
export function stopSession({ handle, exec = execFileSync, env = process.env,
  listSessions = readSessions } = {}) {
  const id = normalizeHandle(handle);
  if (!id) throw new Error('dispatch-abort: stopSession needs a handle to stop');
  const plan = stopPlan(id, listSessions({ all: true, fresh: true, exec, env }));
  if (plan.action === 'gone') return { stopped: true, alreadyGone: true, output: '' };
  if (plan.action !== 'stop') throw new Error(`dispatch-abort: refusing stop: ${plan.reason}`);
  const childEnv = { ...env, ...plan.env };
  try {
    const output = String(exec('claude', ['stop', plan.argId], { ...STOP_EXEC_OPTS, env: childEnv }));
    return { stopped: true, alreadyGone: false, output };
  } catch (e) {
    const full = String(e?.stderr ?? e?.message ?? e);
    if (/No job matching/i.test(full)) {
      const store = { key: plan.storeKey, status: 'ok' };
      let read;
      try {
        read = readStore(store, { output: String(exec('claude', ['agents', '--json', '--all'], {
          ...STOP_EXEC_OPTS, env: childEnv, maxBuffer: 8 * 1024 * 1024 })) });
      } catch (error) { read = readStore(store, { error }); }
      if (afterStopMiss(id, plan.storeKey, read).action === 'gone') {
        return { stopped: true, alreadyGone: true, output: full.split('\n')[0] };
      }
      throw new Error('dispatch-abort: stop missed a matched session; owning store is unknown or session still listed');
    }
    throw new Error(`dispatch-abort: \`claude stop ${plan.argId}\` failed: ${full.split('\n')[0]}`);
  }
}

/**
 * Grant checkout trust the SAME way `we:scripts/bootstrap-session.mjs`'s own `trust` step grants it for a lane
 * — one additive boolean per directory in `~/.claude.json`, backed up first. Reuses `withTrustedDirs` rather
 * than re-deriving the shape, so this can never drift from what the bootstrap step itself considers "trusted".
 *
 * PURE over the injected `readConfig`/`writeConfig`; the CLI block binds the real ones from
 * `we:scripts/bootstrap-session.mjs#defaultIo` (its `readTrust`/`writeTrust`), the same pair the bootstrap
 * step itself uses — not a second copy of the backup-then-write logic.
 *
 * @param {{dir: string, readConfig: () => object|null, writeConfig: (next: object) => void}} o
 * @returns {string} one operator-facing line.
 */
export function trustCheckout({ dir, readConfig, writeConfig } = {}) {
  if (!dir) throw new Error('dispatch-abort: trustCheckout needs a directory');
  if (typeof readConfig !== 'function' || typeof writeConfig !== 'function') {
    throw new TypeError('dispatch-abort: trustCheckout needs injected readConfig/writeConfig — see the CLI block for the real binding');
  }
  const before = readConfig();
  if (before === null) return 'dispatch-abort: could not read the trust config — nothing trusted';
  if (!untrustedDirs(before, [dir]).length) return `dispatch-abort: ${dir} already trusted`;
  writeConfig(withTrustedDirs(before, [dir]));
  return `dispatch-abort: trusted ${dir}`;
}

/**
 * THE COMPOSITION: stop the dispatched agent (unconditionally, whenever its run record carries a handle),
 * THEN close the run record out — in that order, so `wake.mjs`'s own `assertHandleNotLive` passes on its own
 * merits and this does not need `force: true` for the common case. Mirrors
 * `we:scripts/operations/wake.mjs#closeOutEntry`'s signature closely on purpose; this is that function plus
 * the one step tonight's session kept doing by hand in front of it.
 *
 * STOPS UNCONDITIONALLY RATHER THAN PRE-CHECKING LIVENESS ITSELF, DELIBERATELY. An earlier cut called
 * `listAgents()` here first to decide whether a stop was needed at all — a second, redundant read of the same
 * question `closeOutEntry`'s own `assertHandleNotLive` asks right after, AND one that failed OPEN (silently
 * skipped the stop) on a listing that came back malformed or unreadable, rather than failing closed the way
 * `assertHandleNotLive` and `stampLiveness` both do. `claude stop` on an already-gone handle is cheap and
 * benign (see {@link stopSession}), so there is no case where skipping the pre-check costs anything but one
 * subprocess call, and it removes an entire way this could get the fail-open case wrong.
 *
 * @param {object} o
 * @param {string} o.runId
 * @param {string} o.key - the effect key, exactly as `wake.mjs --status` printed it.
 * @param {'failed'|'applied'} [o.status]
 * @param {string} [o.note]
 * @param {boolean} [o.force] - passed straight through to `closeOutEntry` — the same escape hatch
 *   `wake.mjs --resolve --force` offers, for when `claude agents --json` itself is unreadable.
 * @param {{read: Function, write: Function}} o.store
 * @param {() => object[]} [o.listAgents]
 * @param {Function} [o.exec]
 * @returns {string} one operator-facing line, including a lane hint when the dispatch had one.
 */
export function abortDispatch({ runId, key, status = 'failed', note = '', force = false, store, listAgents = defaultListAgents, exec = execFileSync, listSessions = readSessions } = {}) {
  if (!runId || !key) throw new Error('dispatch-abort: needs both runId and key (wake.mjs --status prints them)');
  const run = store.read(runId);
  if (!run) throw new Error(`dispatch-abort: no run record for ${JSON.stringify(runId)}`);
  const entry = (run.effects || []).find((e) => e.key === key);
  if (!entry) throw new Error(`dispatch-abort: no effect ${JSON.stringify(key)} on run ${JSON.stringify(runId)}`);

  const handle = normalizeHandle(entry.handle);
  let stopLine = 'no handle to stop';
  if (handle) {
    const res = stopSession({ handle, exec, listSessions });
    stopLine = res.alreadyGone ? `${handle} was already gone — nothing to stop` : `stopped ${handle}`;
  }

  const closeLine = closeOutEntry({ runId, key, status, note, force, store, listAgents });
  const lane = entry?.payload?.lane;
  const laneHint = lane != null
    ? ` Lane ${lane} may still be leased from this dispatch — release it by hand once you've checked it: `
      + `\`node scripts/lane-pool.mjs release --lane=${lane} --force\` (only if it is clean).`
    : '';
  return `dispatch-abort: ${stopLine}; ${closeLine}${laneHint}`;
}

/**
 * VALIDATE THE `--trust` ARGUMENT BEFORE IT REACHES `resolve()`, extracted out of the `IS_CLI` block so a
 * unit test can exercise it directly — the jury review of PR #1737 found the guarantee this implements
 * ("empty is a refusal, not trust the cwd") was asserted in prose across three files but tested nowhere: the
 * check lived only inside `IS_CLI`, which a `vitest` import can never make true, so the guard itself was dead
 * code as far as the suite could tell.
 *
 * `--trust` with no `=value` returns `''` from `flagValue`, and `resolve('')` silently resolves to
 * `process.cwd()`. Trust-granting is a deliberate, per-directory opt-in; an operator who forgot the directory
 * argument (or hit a shell-quoting mistake) must see an error, not have whatever directory they happened to
 * be standing in trusted for them.
 *
 * @param {string} trustDir - `flag('trust')`'s raw return value (`''` for a bare `--trust`, a path otherwise).
 * @returns {string} the validated directory, unresolved — the caller still owns `resolve()`.
 */
export function requireTrustDir(trustDir) {
  if (!trustDir) throw new Error('dispatch-abort: --trust needs a directory, e.g. --trust=/path/to/scratch-clone');
  return trustDir;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => flagValue(argv, name);

  const trustDir = flag('trust');
  if (trustDir !== undefined) {
    try {
      const { readTrust, writeTrust } = defaultIo();
      writeAllSync(1, `${trustCheckout({ dir: resolve(requireTrustDir(trustDir)), readConfig: readTrust, writeConfig: writeTrust })}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  } else {
    try {
      writeAllSync(1, `${abortDispatch({
        runId: flag('abort'),
        key: flag('key'),
        status: flag('status') || 'failed',
        note: flag('note') || '',
        force: flag('force') !== undefined,
        store: createFileRunStore(),
      })}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
}
