#!/usr/bin/env node
/**
 * @file scripts/daemon-overlay.mjs
 * @description Operator/daemon CLI for the per-clone overlay list (`scripts/lib/daemon-overlays.mjs`, Module
 *   B) — docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 5: a daemon clone tracks
 *   `main` plus an explicit overlay list kept in a per-clone state file OUTSIDE the clone. This is the
 *   add/remove/list surface a person (or a future automated caller) uses to register/drop an overlay ref.
 *
 * THIS CLI NEVER TOUCHES THE CLONE'S WRITE LOCK (#4229/#2760 follow-up, epic #3383/#4075, 2026-09-26).
 * add/remove ONLY register/drop an entry in the overlay STORE (`~/.claude/daemon-overlays/<hash>.json`) and
 * return — the next automatic rebuild (`daemon-rebuild.mjs`'s object-DB build: main + overlays, smoke-gated,
 * falls back to last-good on a failed smoke) is what actually applies the overlay to the clone's tree. That
 * store already serializes its OWN read-modify-write under a tiny, separate mkdir-mutex
 * (`daemon-overlays.mjs#withListLock`, added for the #2640/#2641/#2643 lost-add incidents) held for
 * milliseconds — never across a smoke or a `git reset --hard` — so a concurrent add/remove and a rebuild's own
 * auto-drop can never race each other or lose an entry. Taking the CLONE's reader/writer lock
 * (`daemon-clone-lock.mjs`, Module A) on top of that added nothing but a way to block: a plain metadata write
 * has no reason to wait for the clone's tree to be quiet.
 *
 * HISTORY. Two earlier cuts both still took Module A's write lock around the mutation and only tightened HOW
 * that wait behaved:
 *   1. The very first cut used `withWriteLock(root, fn, {})` — an unbounded (raw 600s `acquireWrite` default)
 *      wait. A live operator `add --pinned` run against `wev-review-daemon` sat silently for 8+ minutes,
 *      refusing every daemon sharing that clone on every tick (xa4qo7n).
 *   2. xa4qo7n bounded that wait to `WE_DAEMON_OVERLAY_LOCK_WAIT_MS` (default 30s) and logged it. That
 *      shortened the freeze but did not remove it: whenever the daemon's OWN rebuild (which runs on every
 *      tick — often) held the writer slot, `add` still failed outright with `concurrent-mover`, no wait at
 *      all, because `acquireWrite` refuses immediately when another live writer already holds the key. Live
 *      2026-09-26: PR #2760 (`lane/4229-fix-dispatch-a-pr-refused-queue-cap-for-too-long-is-surfaced`) failed
 *      to register 4 times in a row this way, and an earlier `add` that DID win the race then hung holding the
 *      writer slot through its own readers-drain wait — freezing every other daemon on that clone meanwhile.
 * Both fixes treated the SYMPTOM (how long/loud the wait is). The actual fix is that this CLI never needed the
 * clone's lock in the first place — it never reads or writes anything inside the clone's working tree.
 *
 * IF SOMETHING EVER NEEDS "REGISTER AND ALSO APPLY RIGHT NOW, SYNCHRONOUSLY": that is a different, explicit
 * operation, not a hidden default here. `scripts/lib/daemon-load-overlay.mjs` already IS that — it registers
 * the ref (via the same `addOverlay`, Module B) and then runs a full gated `rebuildClone` (Module C, live-smoke
 * + adopt/rollback) under the clone's write lock, on purpose, as a one-shot manual CLI. A caller that truly
 * needs THIS CLI's mutation itself serialized with the clone's tree (rare — no current caller does) can already
 * compose that explicitly with `node scripts/lib/daemon-clone-lock.mjs hold --clone=<path> -- node
 * scripts/daemon-overlay.mjs add ...`, which takes the write lock around an arbitrary command. Nothing in this
 * file does that implicitly any more.
 *
 * USAGE:
 *   node scripts/daemon-overlay.mjs add    --clone=<path> --ref=<branch> [--pr=N] [--pinned|--unpinned] [--reason=..] [--by=..] [--json]
 *                                          [--check] [--allow-conflict --reason=..] [--allow-no-pr --reason=..]
 *   node scripts/daemon-overlay.mjs remove --clone=<path> --ref=<branch> [--reason=..] [--by=..] [--json]
 *   node scripts/daemon-overlay.mjs list   --clone=<path> [--json]
 *   node scripts/daemon-overlay.mjs approve-edge --clone=<path> --ref=<branch> --sha=<40-hex> [--by=..] [--reason=..] [--json]
 *
 * `approve-edge` records, on an already-registered overlay, the exact tip of its `origin/edge/<ref>` branch as
 * the approved conflict resolution. A rebuild resolves an overlay conflict through an edge branch ONLY when its
 * tip equals that recorded sha (`daemon-rebuild.mjs#resolveOverlayConflict`) — an arbitrary pushed `edge/*`
 * branch is never fetched or adopted.
 *
 * `--by` defaults to `$USER`. Every command prints the resulting list (remove also reports whether the ref was
 * actually present). `--no-lock` is still accepted (a no-op) so any older caller/script that still passes it
 * keeps working unchanged. Exit codes: 2 on bad usage (unknown command, missing `--clone`, `add`/`remove`
 * missing `--ref`, non-integer `--pr`); 1 on a fatal error (e.g. a corrupt overlay state file — `addOverlay`/
 * `removeOverlay` refuse to overwrite one, or the conflict guard below could not itself determine safety); 0
 * otherwise — including a `remove` of a ref that was never present, which is not a usage error.
 *
 * THE NO-PR WARNING (xkhtg2a, incident 2026-10-08 — overlays without review or a merge link).
 * Adding without --pr warns loudly; overlaySafety.noPr=refuse (or WE_OVERLAY_NO_PR=refuse) refuses with exit 3
 * before the conflict guard or its lock. Override with --allow-no-pr --reason=<why>; --check warns too.
 *
 * THE OVERLAY-CONFLICT GUARD (epic #3383/#4075, live incident 2026-09-27: `lane/promote-stale-green`/#2826 was
 * registered while KNOWINGLY conflicting with `lane/fix-procedure`/#2821 in `review-status-tag.mjs` — nothing
 * refused it, so the next rebuild silently dropped #2826 and its own fix never went live). `add` now checks,
 * BEFORE registering, whether `--ref` merges clean against `origin/main` plus every ALREADY-registered overlay
 * in apply order (`git merge-tree --write-tree`, via `scripts/lib/daemon-rebuild.mjs#previewOverlayConflict` —
 * read-only, the same scratch-repo-with-alternates isolation `dryRunRebuild` already uses; `root`'s own refs,
 * index, working tree are never touched). A conflict REFUSES the add (exit 3, naming the conflicting overlay(s)
 * and file(s)) unless the caller passes `--allow-conflict --reason=<why registering it anyway is safe>`, which
 * still prints the conflict before registering. `--check` runs ONLY this guard and reports the verdict —
 * `addOverlay`/`appendOverlayEvent` are never called — so a preview against a live clone's real overlay config
 * never mutates anything (exit 3 on a would-be-refused conflict, exit 1 if the guard itself could not resolve
 * something — a corrupt store included — 0 otherwise; `--json` gives the full `{check, wouldRegister}` shape).
 * Only merge-tree's own conflict status counts as a conflict; any other merge-tree failure is "could not verify"
 * (exit 1), which `--allow-conflict` does not override. A registered PINNED overlay that no longer folds onto
 * main is set aside and named in a warning, so it never blocks an unrelated add. A real `add` runs the check and
 * the registration under a per-clone add-guard lock, so two concurrent adds cannot both pass against a list that
 * holds neither (PR #2827 review).
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync, renameSync } from 'node:fs';
import {
  addOverlay, removeOverlay, readOverlayState, appendOverlayEvent, overlayFilePath, recordEdgeResolution,
} from './lib/daemon-overlays.mjs';
import { previewOverlayConflict } from './lib/daemon-rebuild.mjs';
import { overlaySafetySettings } from './lib/daemon-load-overlay.mjs';
import { pruneStaleOverlayRecords } from './lib/daemon-clone-registry.mjs';
import { workspaceFor } from './lib/lane-pool-paths.mjs';
import { edgeEnabled, registerPr } from './lib/daemon-edge.mjs';

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

function fail(msg) {
  process.stderr.write(`daemon-overlay: ${msg}\n`);
  process.exitCode = 2;
}

/** One line naming WHY the guard could not run — the reason plus whatever `detail` pins it down, so an operator
 *  never has to read source to learn that (say) an unrelated overlay is what broke the check. */
function describeFailure(check) {
  const d = check.detail;
  const extra = d && (d.detail?.ref ? `${d.reason}: ${d.detail.ref}` : d.reason || d.stderr);
  return extra ? `${check.reason} — ${extra}` : check.reason;
}

/** Name every registered PINNED overlay the guard had to leave out because it no longer folds onto main — a
 *  real rebuild refuses until it is fixed, so it must never be swallowed silently. */
function warnSetAside(check) {
  for (const s of check.setAside || []) {
    process.stderr.write(`daemon-overlay: warning — registered pinned overlay ${s.ref}${s.pr != null ? ` (PR #${s.pr})` : ''} `
      + `no longer folds onto main (${s.reason}${s.dropReason ? `: ${s.dropReason}` : ''}); checked without it. `
      + 'The daemon rebuild refuses until it is rebased or removed.\n');
  }
}

// ── the add-guard lock — serializes check-then-register across concurrent `add`s (PR #2827 review) ──────────
// A `mkdir` mutex next to the overlay state file, SEPARATE from the list's own millisecond mutex
// (`daemon-overlays.mjs#withListLock`): it is held across a git fetch, so it must never block a rebuild's
// auto-remove, which only takes the list mutex. The holder's `owner` file carries a unique `<pid>:<uuid>` token,
// written temp-file + rename so a reader never sees a partial one.
//
// A gone holder (dead pid, older than ADD_GUARD_STALE_MS, or an owner-less dir older than 5s) is recovered
// under a SECOND mkdir mutex, `<lockDir>.recover`: while the dead dir exists no one can `mkdir` the lock, so
// exclusivity is never released mid-recovery. The recoverer removes the dir only if token, inode and mtime are
// all still what it inspected — a fresh holder (whose owner write changes token and mtime) is never removed.
// Named, accepted residual: a recoverer paused between its re-check and its rename for > RECOVER_STALE_MS while
// a replacement lock lands in that gap; closing it needs a true atomic compare-and-remove primitive.
const ADD_GUARD_STALE_MS = 10 * 60_000;
const ADD_GUARD_OWNERLESS_MS = 5_000;
const ADD_GUARD_RECOVER_STALE_MS = 30_000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function readAddGuardOwner(lockDir) {
  try { return readFileSync(join(lockDir, 'owner'), 'utf8').trim(); } catch { return ''; /* not written yet, or gone */ }
}

/** Write `token` as `dir`'s owner atomically (temp file + rename). */
function writeAddGuardOwner(dir, token) {
  const tmp = join(dir, `owner.tmp-${randomUUID()}`);
  writeFileSync(tmp, token);
  renameSync(tmp, join(dir, 'owner'));
}

/** The pid prefix of an owner token; a legacy bare-pid owner parses too. NaN when unparseable. */
function addGuardOwnerPid(token) {
  const m = /^(\d+)(?::.*)?$/.exec(token);
  return m ? Number(m[1]) : NaN;
}

/** Snapshot of the lock dir — `{token, ino, mtimeMs, gone}` — or `null` once it is released. `gone` is true for a
 *  holder that is dead or stale; a fresh owner-less dir (a live holder between `mkdir` and its owner write) is NOT gone. */
function inspectAddGuardLock(lockDir) {
  let st;
  try { st = statSync(lockDir); } catch { return null; }
  const token = readAddGuardOwner(lockDir);
  const ageMs = Date.now() - st.mtimeMs;
  const snap = { token, ino: st.ino, mtimeMs: st.mtimeMs, gone: false };
  if (ageMs > ADD_GUARD_STALE_MS) { snap.gone = true; return snap; }
  const pid = addGuardOwnerPid(token);
  if (!token || !Number.isInteger(pid) || pid <= 0) { snap.gone = ageMs > ADD_GUARD_OWNERLESS_MS; return snap; }
  try { process.kill(pid, 0); } catch (e) { snap.gone = e.code === 'ESRCH'; }
  return snap;
}

/** Take the `.recover` mutex (breaking one older than ADD_GUARD_RECOVER_STALE_MS) — returns our token, or `null`. */
function takeRecoverMutex(recoverDir) {
  for (let tries = 0; tries < 2; tries++) {
    try {
      mkdirSync(recoverDir);
      const token = `${process.pid}:${randomUUID()}`;
      writeAddGuardOwner(recoverDir, token);
      return token;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let ageMs;
      try { ageMs = Date.now() - statSync(recoverDir).mtimeMs; } catch { continue; /* released meanwhile */ }
      if (ageMs <= ADD_GUARD_RECOVER_STALE_MS) return null;
      const aside = `${recoverDir}.stale-${process.pid}-${randomUUID()}`;
      try { renameSync(recoverDir, aside); } catch { return null; /* someone else broke it first */ }
      rmSync(aside, { recursive: true, force: true });
    }
  }
  return null;
}

/** Remove the gone lock `seen` — serialised behind `.recover`, and only if it is still exactly what was inspected. */
async function recoverAddGuardLock(lockDir, seen, hooks) {
  const recoverDir = `${lockDir}.recover`;
  const mine = takeRecoverMutex(recoverDir);
  if (!mine) return false;
  try {
    await hooks.onPhase?.('removing', { lockDir, seen });
    const now = inspectAddGuardLock(lockDir);
    if (now && now.gone && now.token === seen.token && now.ino === seen.ino && now.mtimeMs === seen.mtimeMs) {
      const aside = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
      try { renameSync(lockDir, aside); rmSync(aside, { recursive: true, force: true }); } catch { /* gone already */ }
    }
  } finally {
    // Only our own mutex — a paused recoverer's was broken as stale and may now belong to someone else.
    if (readAddGuardOwner(recoverDir) === mine) rmSync(recoverDir, { recursive: true, force: true });
  }
  await hooks.onPhase?.('removed', { lockDir, seen });
  return true;
}

/** `hooks.onPhase?.(phase, ctx)` (awaited) is a test seam — phases `attempt`, `inspected`, `removing`, `removed`.
 *  Production callers pass none. */
export async function withAddGuardLock(root, env, fn, hooks = {}) {
  const lockDir = `${overlayFilePath(root, env)}.add-guard.lock`;
  mkdirSync(dirname(lockDir), { recursive: true });
  const waitMs = Number(env.WE_DAEMON_OVERLAY_ADD_GUARD_WAIT_MS) > 0 ? Number(env.WE_DAEMON_OVERLAY_ADD_GUARD_WAIT_MS) : 180_000;
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    await hooks.onPhase?.('attempt', { lockDir });
    try {
      mkdirSync(lockDir);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const seen = inspectAddGuardLock(lockDir);
      if (!seen) continue; // released meanwhile
      if (seen.gone) {
        await hooks.onPhase?.('inspected', { lockDir, seen });
        if (await recoverAddGuardLock(lockDir, seen, hooks)) continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`add-guard lock ${lockDir} still held after ${waitMs}ms — another \`add\` is checking; retry`);
      }
      await sleep(seen.gone ? 50 : 100);
      continue;
    }
    try { writeAddGuardOwner(lockDir, token); } catch (e) { rmSync(lockDir, { recursive: true, force: true }); throw e; }
    break;
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock — if it was broken as stale meanwhile, the dir now belongs to someone else.
    if (readAddGuardOwner(lockDir) === token) rmSync(lockDir, { recursive: true, force: true });
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'add' && cmd !== 'remove' && cmd !== 'list' && cmd !== 'approve-edge') {
    fail(`expected add|remove|list|approve-edge, got ${JSON.stringify(cmd ?? null)}`);
    return;
  }

  try {
    pruneStaleOverlayRecords(workspaceFor(dirname(fileURLToPath(import.meta.url))));
  } catch { /* self-heal is best-effort */ }
  const flags = parseFlags(rest);
  const clone = typeof flags.clone === 'string' ? flags.clone : null;
  if (!clone) return fail('--clone=<path> is required');
  const root = resolve(clone);

  if ((cmd === 'add' || cmd === 'remove' || cmd === 'approve-edge') && typeof flags.ref !== 'string') {
    return fail(`--ref=<branch> is required for ${cmd}`);
  }
  if (cmd === 'approve-edge' && typeof flags.sha !== 'string') {
    return fail('--sha=<full 40-hex tip of origin/edge/<ref>> is required for approve-edge');
  }

  let pr = null;
  if (typeof flags.pr === 'string') {
    pr = Number(flags.pr);
    if (!Number.isInteger(pr)) return fail(`--pr must be an integer, got ${JSON.stringify(flags.pr)}`);
  }
  const reason = typeof flags.reason === 'string' ? flags.reason : null;
  const by = typeof flags.by === 'string' ? flags.by : (process.env.USER || null);
  // `--pinned`: the rebuild refuses (keeps the current tree) rather than ever conflict-drop this overlay.
  let pinned;
  if (flags.pinned) pinned = true;
  else if (flags.unpinned) pinned = false;
  const asJson = !!flags.json;
  const env = process.env;

  let output;
  if (cmd === 'list') {
    // A corrupt file must not read as a plain empty list: flag it and exit 1 (add/remove throw on it instead).
    const state = readOverlayState(root, { env });
    output = state.corrupt ? { list: [], corrupt: true } : { list: state.overlays };
    if (state.corrupt) {
      process.stderr.write('daemon-overlay: overlay state file is corrupt — fix or remove it by hand\n');
      process.exitCode = 1;
    }
  } else if (cmd === 'add') {
    const allowNoPr = !!flags['allow-no-pr'];
    if (allowNoPr && !reason?.trim()) {
      return fail('--allow-no-pr requires --reason=<why>');
    }
    const { noPr } = overlaySafetySettings(process.env);
    if (pr == null) {
      const refused = noPr === 'refuse' && !allowNoPr;
      if (!refused || flags.check) {
        process.stderr.write(`daemon-overlay: WARNING — ${flags.ref} is being added with NO PR. Nothing reviewed this code and nothing ties it to a merge.\n`
          + `  Pass --pr=<N>. (overlaySafety.noPr=${noPr}; set WE_OVERLAY_NO_PR=refuse or overlaySafety.noPr=refuse to block this.)\n`);
      }
      if (refused) {
        process.stderr.write(`daemon-overlay: REFUSED — ${flags.ref} has NO PR. Pass --pr=<N> or --allow-no-pr --reason=<why>.\n`);
        if (flags.check && asJson) {
          process.stdout.write(`${JSON.stringify({ check: { ok: false, reason: 'no-pr' }, wouldRegister: false })}\n`);
        }
        process.exitCode = 3;
        return;
      }
    }
    // THE CONFLICT GUARD (epic #3383/#4075 — live incident: `lane/promote-stale-green`/#2826 was registered
    // while KNOWINGLY conflicting with `lane/fix-procedure`/#2821 in `review-status-tag.mjs`; nothing refused
    // it, so the next rebuild silently DROPPED #2826 and its fix never went live). Read-only (see
    // `previewOverlayConflict`'s own header) — runs BEFORE any state-file mutation, never after.
    const allowConflict = !!flags['allow-conflict'];
    if (allowConflict && !reason) {
      return fail('--allow-conflict requires --reason=<why registering it anyway is safe>');
    }
    // A corrupt store gets no guard run (it would waste a real git fetch): `--check` reports it as a failure
    // (exit 1, `wouldRegister:false` — never a false "would register", PR #2827 review), and a real add falls
    // straight through to `addOverlay`, whose own refusal throws rather than overwrite a damaged file.
    const runGuard = async () => {
      const overlayState = readOverlayState(root, { env });
      if (overlayState.corrupt) return { ok: false, reason: 'overlay-store-corrupt', corruptStore: true };
      return previewOverlayConflict({ root, ref: flags.ref, pr, existingOverlays: overlayState.overlays, env });
    };

    // `--check`: report the SAME guard result and stop — never calls `addOverlay`/`appendOverlayEvent`, so a
    // preview against a live clone's real overlay config never registers or removes anything (the exact
    // "dry-run/check mode" this guard was built to be provable with).
    if (flags.check) {
      const check = await runGuard();
      warnSetAside(check);
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ check, wouldRegister: check.ok && (check.clean || allowConflict) })}\n`);
      } else if (!check.ok) {
        process.stdout.write(`daemon-overlay --check: could not verify — ${describeFailure(check)}\n`);
      } else if (check.clean) {
        process.stdout.write(`daemon-overlay --check: ${flags.ref} merges clean against origin/main + every registered overlay — would register.\n`);
      } else {
        const against = check.conflicting.map((o) => `${o.ref}${o.pr != null ? ` (PR #${o.pr})` : ''}`).join(', ') || '(none named)';
        process.stdout.write(`daemon-overlay --check: ${flags.ref} CONFLICTS in ${check.files.join(', ')} with: ${against} — `
          + `would be REFUSED${allowConflict ? ' (but --allow-conflict is set, so it would register anyway)' : ''}.\n`);
      }
      if (check.ok && !check.clean && !allowConflict) process.exitCode = 3;
      else if (!check.ok) process.exitCode = 1;
      return;
    }

    // Check-then-register runs under the per-clone ADD-GUARD lock, and the guard re-reads the overlay list INSIDE
    // it: without that, two concurrent adds of mutually-conflicting refs each checked a list that did not yet
    // hold the other, and BOTH registered — the exact incident this guard exists to stop (PR #2827 review).
    // Only guarded adds take this lock; the list's own millisecond mutex (and so a rebuild's auto-remove) never
    // waits on it.
    const registered = await withAddGuardLock(root, env, async () => {
      const check = await runGuard();
      if (check.corruptStore) {
        throw new Error(`overlay state file ${overlayFilePath(root, env)} is corrupt — refusing to overwrite it; fix or remove it by hand`);
      }
      warnSetAside(check);
      if (!check.ok) {
        // The guard itself could not determine safety (no network, unresolved ref, a merge-tree error, …) — fail
        // CLOSED: refuse rather than register on an unproven merge. `--allow-conflict` names a KNOWN conflict it
        // is safe to override; it does not cover "the check itself could not run".
        process.stderr.write(`daemon-overlay: could not verify ${flags.ref} merges clean (${describeFailure(check)}) — refusing to register. Pass --allow-conflict --reason=... only for a CONFIRMED conflict this guard itself reported.\n`);
        process.exitCode = 1;
        return null;
      }
      if (!check.clean) {
        const against = check.conflicting.length
          ? check.conflicting.map((o) => `${o.ref}${o.pr != null ? ` (PR #${o.pr})` : ''}`).join(', ')
          : '(no already-registered overlay diff names the file — check main itself, or a ref this guard could not resolve)';
        const detail = `${flags.ref}${pr != null ? ` (PR #${pr})` : ''} does not merge clean against origin/main + `
          + `the already-registered overlay(s) in apply order. Conflicting file(s): ${check.files.join(', ')}. `
          + `Conflicts with: ${against}.`;
        if (!allowConflict) {
          process.stderr.write(`daemon-overlay: REFUSED — ${detail}\n`
            + 'Rebase the branch onto the conflicting overlay (or main) first, or override with '
            + '--allow-conflict --reason=<why>.\n');
          process.exitCode = 3;
          return null;
        }
        process.stderr.write(`daemon-overlay: registering DESPITE a known conflict (--allow-conflict) — ${detail}\n`);
      }

      // Register-only: `addOverlay` (Module B) does its own atomic read-modify-write under the list's own tiny
      // mutex and returns immediately — this never touches the clone's tree or its reader/writer lock. See the
      // file header for why that lock was dropped here.
      const list = addOverlay(root, {
        ref: flags.ref, pr, addedBy: by, reason, pinned,
      }, { env });
      appendOverlayEvent(root, {
        kind: 'added', ref: flags.ref, pr, by, reason, ...(pinned !== undefined ? { pinned } : {}),
        ...(pr == null ? { noPr: true } : {}),
        ...(!check.clean ? { conflictOverride: { files: check.files, conflicting: check.conflicting } } : {}),
      }, { env });
      return { list, check };
    });
    if (!registered) return;
    output = { list: registered.list, conflictCheck: registered.check };
    // daemon-edge slice 1 (epic x59tqsg): ONLY with WE_DAEMON_EDGE=1 (default off) is the PR also registered
    // for the kept `daemon-edge` branch (admission check vs main + edge). Flag off ⇒ this block never runs.
    if (edgeEnabled(env) && pr != null) {
      const url = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      output.edge = url.status === 0
        ? registerPr({ pr, ref: flags.ref, remoteUrl: String(url.stdout).trim(), env, by, reason })
        : { ok: false, reason: 'no-origin-url' };
    }
  } else if (cmd === 'remove') {
    const { removed, list } = removeOverlay(root, flags.ref, { env, why: reason || 'operator' });
    if (removed) appendOverlayEvent(root, { kind: 'removed', ref: flags.ref, by, reason }, { env });
    output = { removed, list };
  } else if (cmd === 'approve-edge') {
    // The ONLY way an `origin/edge/<ref>` branch becomes adoptable by a rebuild: record actor + exact tip sha on
    // the registered overlay. A malformed sha, a missing actor or an unregistered ref is a usage error (exit 2).
    if (!by) return fail('--by=<actor> is required for approve-edge (or set $USER)');
    try {
      output = { list: recordEdgeResolution(root, flags.ref, { sha: flags.sha, by, reason }, { env }) };
    } catch (e) {
      return fail(String((e && e.message) || e));
    }
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } else if (cmd === 'approve-edge') {
    process.stdout.write(`daemon-overlay: approved edge/${flags.ref} @ ${flags.sha} by ${by} list=${JSON.stringify(output.list)}\n`);
  } else if (cmd === 'remove') {
    process.stdout.write(`daemon-overlay: removed=${output.removed} list=${JSON.stringify(output.list)}\n`);
  } else {
    process.stdout.write(`daemon-overlay: list=${JSON.stringify(output.list)}\n`);
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main().catch((e) => {
    process.stderr.write(`daemon-overlay: fatal: ${String((e && e.message) || e)}\n`);
    process.exitCode = 1;
  });
}
