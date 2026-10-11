#!/usr/bin/env node
/**
 * @file scripts/readiness/red-main-remediation.mjs
 * @description RED-MAIN REMEDIATION — the stop-the-line half diff-driven shrink (WE #2681, under #2612) makes
 *   NECESSARY. Property 3 of the design jury's four: "a post-land full-suite red under a sole writer is a
 *   STOP-THE-LINE event. Specify dispatch-freeze + revert authority — not just 'the next item rebases.'"
 *
 * WHY THIS EXISTS. Once per-PR CI can SHRINK (run only the diff-related tests), a PR can land GREEN while a test
 * OUTSIDE its selected set is actually RED against the merged tree — a false-green (the very thing
 * {@link ./test-selection.mjs assessFalseGreen} measures). The `push:[main]` full-suite backstop then goes RED
 * AFTER the land. Under a SOLE WRITER to main (the drain, `scripts/merge-ai-prs.mjs`, #2290) that post-land red
 * is not a private inconvenience — it is a GLOBAL red: every subsequent land builds on a broken tree. The
 * pre-shrink world had no such hole (every PR ran the full suite), so the shrink is the thing that OPENS this
 * failure mode, and it must ship WITH its remediation. This module is that remediation, as an explicit,
 * testable state machine + the durable dispatch-freeze marker the drain consults.
 *
 * THE TWO LEVERS (the spec's exact words — "dispatch-freeze + revert authority"):
 *   1. DISPATCH-FREEZE. On a post-land `push:[main]` full-suite RED, the line STOPS: no further PR is landed
 *      until main is green again. Mechanized as a durable, gitignored `.conveyor/` marker
 *      ({@link FREEZE_MARKER_PATH}) that the sole writer (the drain) reads at the top of every sweep — a live
 *      freeze makes the drain refuse to land and surface the stop-the-line (mirroring the existing
 *      duplicate-id-on-main hard stop). This is symmetric to how the drain already treats a duplicate id on main
 *      as a globally-red, polling-won't-clear-it stop.
 *   2. REVERT AUTHORITY. The remediation of FIRST resort is REVERT-TO-GREEN, not "wait for a forward fix" — the
 *      offending merge (or the exact commit the full suite fingered) is reverted to restore a green main
 *      immediately, and only THEN is the fix pursued forward. {@link decidePostLand} names the revert target and
 *      asserts revert authority so the recovery path is explicit, not folded into "the next item rebases."
 *
 * FLAG-GATED / NOT DEFAULTED (DoD). The shrink is opt-in (`WE_DIFF_TEST_SELECTION`) and NOT defaulted until this
 * recovery path exists. This module IS that path: it may safely exist (and be consulted) before the shrink is
 * ever defaulted — with the shrink off, a post-land red simply never occurs, so the freeze never fires. Shipping
 * it first is the DoD's "a red-main recovery path exists" precondition, satisfied.
 *
 * PURITY. The decision core ({@link decidePostLand}) is pure. Only the marker helpers ({@link freezeDispatch} /
 * {@link unfreezeDispatch} / {@link readFreeze} / {@link isDispatchFrozen}) touch fs — injectable path for tests.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync, linkSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { daemonCloneRoots } from '../lib/daemon-clone-registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // scripts/readiness → repo root

/** The durable dispatch-freeze marker, in the host's coordination root (one source for every clone; see
 *  {@link resolveFreezeMarkerPath}; it used to be a per-clone GITIGNORED `.conveyor/` sidecar — {@link migrateLegacyFreeze}
 *  carries an old one across). Present ⇒ the line is STOPPED; absent ⇒ dispatch is clear.
 *  Env-overridable so a drain-only session (or a test) can point at a specific copy. */
export const FREEZE_MARKER_PATH = resolveFreezeMarkerPath();

/**
 * ONE well-defined freeze source (2026-10-09, held items 164/166). The marker used to live in `<ROOT>/.conveyor/`,
 * where ROOT is the clone the script is imported FROM — and the drain daemon flips its pass code root between the
 * data clone (`we-drain-daemon/lane-1`, no overlays) and the code clone (`we-drain-daemon/code`, overlays). A freeze
 * raised from the code clone on 2026-10-09 01:03Z was invisible to passes running from lane-1, so #4537/#4539/#4532
 * merged through it. The marker now lives in the host's coordination root (the same root as the safety net's
 * published `main-ci-red-state.json`), whatever clone writes or reads it. `WE_RED_MAIN_FREEZE` still overrides;
 * inside a test run the per-clone path is kept so a test can never read or write the live marker.
 */
export function resolveFreezeMarkerPath(env = process.env) {
  if (env.WE_RED_MAIN_FREEZE) return env.WE_RED_MAIN_FREEZE;
  if (env.VITEST || env.WE_UNDER_TEST) return join(ROOT, '.conveyor', 'red-main-freeze.json');
  return join(resolveCoordinationRoot({ env }), 'red-main-freeze.json');
}

/** The pre-2026-10-09 per-clone marker location (`<this clone>/.conveyor/`). `WE_RED_MAIN_FREEZE_LEGACY` points a test at a temp copy. */
export function resolveLegacyFreezeMarkerPath(env = process.env) {
  return env.WE_RED_MAIN_FREEZE_LEGACY || join(ROOT, '.conveyor', 'red-main-freeze.json');
}

/**
 * EVERY clone's legacy marker location, not only the importing clone's (PR #4624 review). The freeze CLI ran from
 * whichever clone the operator was in (the primary checkout, either drain-daemon clone, any daemon clone), so a live
 * pre-move freeze can sit in a clone other than the one now running the drain — reading only `<this clone>` would drop
 * it, which is the very bug (#4537/#4539 merged through a freeze) the move fixed. This clone first, then the primary
 * checkout, the drain daemon's data (`lane-1`) and code clones, and every registered daemon clone. An explicit
 * `WE_RED_MAIN_FREEZE_LEGACY` (a test seam) or a test run names exactly that one path and touches no real clone.
 * @returns {string[]} deduped candidate marker paths (existence not checked)
 */
export function resolveLegacyFreezeMarkerPaths(env = process.env) {
  const own = resolveLegacyFreezeMarkerPath(env);
  if (env.WE_RED_MAIN_FREEZE_LEGACY || env.VITEST || env.WE_UNDER_TEST) return [own];
  const workspace = join(homedir(), 'workspace');
  const drain = join(workspace, '.lanes', 'we-drain-daemon');
  let roots = [];
  try { roots = daemonCloneRoots(workspace, { env }); } catch { /* the registry is best-effort; the fixed roots below still apply */ }
  const all = [own, ...[join(workspace, 'webeverything'), join(drain, 'lane-1'), join(drain, 'code'), ...roots].map((r) => join(r, '.conveyor', 'red-main-freeze.json'))];
  return [...new Set(all.map((p) => resolve(p)))];
}

/** The legacy markers that exist right now (every clone). Read-only. */
export function pendingLegacyFreezeMarkers(env = process.env) {
  return resolveLegacyFreezeMarkerPaths(env).filter((p) => { try { return existsSync(p); } catch { return false; } });
}

/**
 * Retire this clone's legacy marker (rename aside, never delete) so it can NEVER be read again. The new path is the
 * ONLY authority: an old file left lying around would be carried across by a later pass and re-freeze the line after
 * the operator lifted it (`unfreeze`) or re-raised it (`freeze`). No-op without a legacy file, under an explicit
 * `WE_RED_MAIN_FREEZE` override, or when both paths are the same (a test run). Never throws.
 * @returns {boolean} whether a legacy file was retired
 */
export function retireLegacyFreeze({ env = process.env, path = resolveFreezeMarkerPath(env), legacyPath, legacyPaths, suffix = 'retired', except = null } = {}) {
  if (env.WE_RED_MAIN_FREEZE) return false;
  const candidates = legacyPaths ?? (legacyPath ? [legacyPath] : resolveLegacyFreezeMarkerPaths(env));
  let retired = false;
  for (const p of candidates) {
    try {
      if (resolve(path) === resolve(p) || (except && resolve(except) === resolve(p)) || !existsSync(p)) continue;
      renameSync(p, `${p}.${suffix}`);
      retired = true;
    } catch { /* one clone's file failing must not leave the others readable */ }
  }
  return retired;
}

/**
 * One-time rollout migration: a freeze raised before the marker moved to the coordination root sits in the
 * `.conveyor/` of WHICHEVER clone raised it ({@link resolveLegacyFreezeMarkerPaths}), and readers now look only at the
 * new path — so an operator's live freeze would be silently dropped (review of PR #4624). With several, the newest
 * wins and the rest are set aside `*.superseded`. Move it across ONCE: copy it to the new path (stamped `migratedFrom`), then rename the old
 * file to `*.migrated` so only ONE source is ever read. When the new path already holds a marker it wins and the
 * legacy file is renamed `*.superseded` (never left to resurface after an `unfreeze`). The copy never clobbers a
 * marker raised concurrently (hard-link, EEXIST ⇒ the new path wins). No-op without a legacy marker, under an
 * explicit `WE_RED_MAIN_FREEZE` override, or when both paths are the same (a test run). Never throws; a failed
 * final rename still reports `migrated:true` (the copy happened — the marker is live at the new path).
 * @returns {{migrated:boolean, from?:string, to?:string, reason?:string}}
 */
export function migrateLegacyFreeze({ env = process.env, path = resolveFreezeMarkerPath(env), legacyPath, legacyPaths } = {}) {
  try {
    if (env.WE_RED_MAIN_FREEZE) return { migrated: false, reason: 'explicit-override' };
    const candidates = (legacyPaths ?? (legacyPath ? [legacyPath] : resolveLegacyFreezeMarkerPaths(env))).filter((p) => resolve(p) !== resolve(path));
    if (!candidates.length) return { migrated: false, reason: 'same-path' };
    const present = candidates.filter((p) => existsSync(p));
    if (!present.length) return { migrated: false, reason: 'no-legacy-marker' };
    const superseded = (reason) => { retireLegacyFreeze({ env, path, legacyPaths: present, suffix: 'superseded' }); return { migrated: false, reason }; };
    if (existsSync(path)) return superseded('new-path-already-holds-a-marker');
    // Several clones may each hold one (an operator raised it from one clone, re-raised from another): any one is a
    // live freeze, so carry the NEWEST across (fail closed) and set the rest aside so none can resurface.
    const readable = [];
    for (const p of present) {
      try {
        const m = JSON.parse(readFileSync(p, 'utf8'));
        if (m && typeof m === 'object') { const at = Date.parse(m.at); readable.push({ p, m, at: Number.isFinite(at) ? at : statSync(p).mtimeMs }); }
      } catch { /* a corrupt file in one clone must not hide a good one in another */ }
    }
    if (!readable.length) return { migrated: false, reason: 'unreadable-legacy-marker' };
    const { p: chosen, m: marker } = readable.reduce((a, b) => (b.at > a.at ? b : a));
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`; // per-process: two migrators (or a concurrent `freeze`) never share a temp file
    writeFileSync(tmp, JSON.stringify({ ...marker, migratedFrom: chosen }, null, 2) + '\n');
    try { linkSync(tmp, path); } // no-clobber: a fresher freeze raised in the gap keeps the new path
    catch (e) {
      if (e?.code === 'EEXIST') { unlinkSync(tmp); return superseded('new-path-already-holds-a-marker'); }
      // A filesystem without hard links (EPERM/EXDEV/ENOTSUP): fall back to an exclusive create, still no-clobber.
      try { writeFileSync(path, readFileSync(tmp), { flag: 'wx' }); }
      catch (e2) { unlinkSync(tmp); if (e2?.code === 'EEXIST') return superseded('new-path-already-holds-a-marker'); throw e2; }
    }
    unlinkSync(tmp);
    retireLegacyFreeze({ env, path, legacyPaths: [chosen], suffix: 'migrated' });
    retireLegacyFreeze({ env, path, legacyPaths: present, suffix: 'superseded' }); // every other clone's copy (chosen is already aside)
    return { migrated: true, from: chosen, to: path };
  } catch (e) {
    return { migrated: false, reason: `error: ${e?.message || e}` };
  }
}

/**
 * A one-line spec of the remediation, for logs / operator surfaces. Keeping the spec ADJACENT to the mechanism
 * (not only in prose docs) is the "specify — not just 'the next item rebases'" the jury asked for.
 */
export const REMEDIATION_SPEC = Object.freeze({
  trigger: 'post-land push:[main] full-suite RED under the sole writer (the drain)',
  levers: Object.freeze(['dispatch-freeze', 'revert-authority']),
  dispatchFreeze: 'the drain refuses to land ANY further PR while the freeze marker is present (stop-the-line)',
  revertAuthority: 'restore green by REVERTING the offending merge first (revert-to-green), then fix forward',
  clears: 'the freeze is lifted (unfreezeDispatch) once main is verified green again',
});

// ── the DECISION (pure) ──────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PostLandDecision
 * @property {'proceed'|'stop-the-line'} action  `stop-the-line` ⇒ freeze dispatch + revert; `proceed` otherwise.
 * @property {boolean} freezeDispatch            should the dispatch-freeze marker be raised?
 * @property {boolean} revertAuthority           is a revert-to-green authorized (and the first resort)?
 * @property {string|null} revertTarget          the merge/commit to revert to restore green, if known.
 * @property {string[]} reasons                  human-readable rationale.
 */

/**
 * Decide the remediation for a post-land CI result on main. Pure. A `push:[main]` (or equivalently, the
 * post-land full-suite backstop) that comes back RED is a stop-the-line: freeze dispatch and revert-to-green.
 * Any other result (green, or a non-main / non-post-land signal) proceeds. `revertTarget` names the commit to
 * revert when the caller knows it (the merge sha, or the commit the full suite fingered).
 * @param {{trigger?: string, ref?: string, result?: 'red'|'green'|string, mergeSha?: string|null}} args
 * @returns {PostLandDecision}
 */
export function decidePostLand({ trigger = 'push', ref = 'main', result = 'green', mergeSha = null } = {}) {
  const onMainPostLand = (trigger === 'push' || trigger === 'post-land') && (ref === 'main' || ref === 'refs/heads/main');
  const isRed = String(result).toLowerCase() === 'red' || String(result).toLowerCase() === 'failure';

  if (onMainPostLand && isRed) {
    return {
      action: 'stop-the-line',
      freezeDispatch: true,
      revertAuthority: true,
      revertTarget: mergeSha || null,
      reasons: [
        'post-land full-suite RED on main under the sole writer — GLOBAL red (every subsequent land builds on a broken tree)',
        'FREEZE dispatch: the drain lands no further PR until main is green again',
        mergeSha
          ? `REVERT-TO-GREEN authorized: revert ${mergeSha} first (revert is the first resort, not a forward-fix wait)`
          : 'REVERT-TO-GREEN authorized: revert the offending merge first (revert is the first resort, not a forward-fix wait)',
      ],
    };
  }

  return {
    action: 'proceed',
    freezeDispatch: false,
    revertAuthority: false,
    revertTarget: null,
    reasons: [onMainPostLand ? 'post-land main is green — proceed' : 'not a post-land main signal — no remediation'],
  };
}

// ── the dispatch-freeze MARKER (fs edge — injectable path) ───────────────────────────────────────────────────

/**
 * Read the current freeze marker, or `null` if dispatch is clear. Never throws — a missing/corrupt marker reads
 * as "not frozen" (fail-OPEN on the read is safe: the marker's PRESENCE is the stop signal, so a corrupt file is
 * conservatively ignored rather than silently jamming the line forever; re-raise it if the red persists).
 * @param {string} [path]
 * @returns {object|null}
 */
export function readFreeze(path = FREEZE_MARKER_PATH) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Is dispatch currently frozen (the stop-the-line marker present)? The predicate the sole writer consults. */
export function isDispatchFrozen(path = FREEZE_MARKER_PATH) {
  return readFreeze(path) != null;
}

/**
 * Raise the dispatch-freeze marker (atomic tmp+rename). Idempotent — re-raising overwrites with the latest cause.
 * @param {{reason?: string, redRef?: string, mergeSha?: string|null, at?: string}} [meta]
 * @param {string} [path]
 * @returns {object} the written marker
 */
export function freezeDispatch(meta = {}, path = FREEZE_MARKER_PATH) {
  return writeFreezeMarker(buildFreezeMarker(meta), path);
}

/** The marker a freeze would write (pure) — the CLI builds it once so the local write and the shared publish carry the same marker. */
export function buildFreezeMarker(meta = {}) {
  return {
    frozen: true,
    at: meta.at || new Date().toISOString(),
    reason: meta.reason || REMEDIATION_SPEC.trigger,
    redRef: meta.redRef || 'main',
    mergeSha: meta.mergeSha || null,
    revertAuthority: true,
  };
}

function writeFreezeMarker(marker, path) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + '\n');
  renameSync(tmp, path);
  if (path === FREEZE_MARKER_PATH) retireLegacyFreeze(); // the new path is the one authority
  return marker;
}

/** Lift the dispatch-freeze (main verified green again). Idempotent — a missing marker is a no-op. Also retires this
 *  clone's legacy marker (default path only), so an old file can never be carried across and re-freeze the line. */
export function unfreezeDispatch(path = FREEZE_MARKER_PATH) {
  // Legacy FIRST: a drain pass landing between the two steps would otherwise migrate the old file straight back.
  if (path === FREEZE_MARKER_PATH) retireLegacyFreeze();
  try { if (existsSync(path)) rmSync(path); } catch { /* best-effort */ }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Hand-rolled `--k=v` / `--k` flag parsing. */
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

async function runCli(argv) {
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  // xyd06qo: the shared ops/* copy CI's merge-gate reads. A RAISE writes the local marker FIRST (the drain stops at once,
  // whatever the publish does), then publishes; a local write error never skips the publish. A failed publish exits 1
  // with the retry named. Only an explicit CLEAR (`unfreeze`) may publish frozen:false —
  // "no marker here" (a clone without the gitignored file, or a corrupt one) is never a clear.
  const shared = () => import('../lib/red-main-freeze-shared.mjs');
  const raise = async (meta) => {
    const marker = buildFreezeMarker(meta);
    // LOCAL FIRST: the drain stops on this file, so no publish (slow, hung, retried) may ever delay it. A local write
    // error is held, never allowed to skip the publish: the shared copy still goes frozen, then the error surfaces.
    let written = null;
    let writeError = null;
    try { written = freezeDispatch(marker); } catch (e) { writeError = e; }
    try { await (await shared()).publishFreezeFromCli({ marker }); }
    catch (e) { process.stderr.write(`red-main freeze: ✗ the SHARED copy was NOT published (${String(e?.message || e).split('\n')[0].slice(0, 300)}); the local marker is ${written ? 'written' : 'NOT written'}. Retry: node scripts/readiness/red-main-remediation.mjs publish\n`); process.exitCode = 1; }
    if (writeError) throw writeError;
    return written;
  };
  if (cmd === 'freeze') {
    const m = await raise({ reason: flags.reason, redRef: flags['red-ref'], mergeSha: flags['merge-sha'] });
    process.stdout.write(JSON.stringify(m, null, 2) + '\n');
  } else if (cmd === 'unfreeze') {
    // The freeze this clear lifts: the shared clear refuses to wipe a DIFFERENT freeze it finds on the tip.
    const lifted = readFreeze();
    unfreezeDispatch();
    // The clear is published only once the local freeze is really gone: unfreezeDispatch swallows rm errors, and a
    // surviving (or legacy, migrate-back) marker means the drain is still frozen — clearing CI then would split the two.
    const legacyLeft = process.env.WE_RED_MAIN_FREEZE ? [] : pendingLegacyFreezeMarkers().filter((p) => resolve(p) !== resolve(FREEZE_MARKER_PATH));
    if (isDispatchFrozen() || legacyLeft.length) {
      process.stderr.write(`red-main freeze: ✗ unfreeze did not clear the local marker (${isDispatchFrozen() ? FREEZE_MARKER_PATH : legacyLeft[0]} still present); the SHARED copy is unchanged. Remove it, then re-run: node scripts/readiness/red-main-remediation.mjs unfreeze\n`);
      process.exitCode = 1;
      return;
    }
    writeAllSync(1, JSON.stringify({ frozen: false }, null, 2) + '\n');
    await (await shared()).publishFreezeFromCli({ marker: null, clear: true, ...(lifted ? { lifted } : {}) });
  } else if (cmd === 'status') {
    // Read-only: report a not-yet-migrated legacy marker instead of moving it (the next drain pass migrates it).
    const legacyPending = process.env.WE_RED_MAIN_FREEZE ? [] : pendingLegacyFreezeMarkers().filter((p) => resolve(p) !== resolve(FREEZE_MARKER_PATH));
    writeAllSync(1, JSON.stringify({ frozen: isDispatchFrozen(), path: FREEZE_MARKER_PATH, marker: readFreeze(), legacyMarkerPending: legacyPending[0] ?? null, legacyMarkersPending: legacyPending }, null, 2) + '\n');
  } else if (cmd === 'decide') {
    const d = decidePostLand({ trigger: flags.trigger, ref: flags.ref, result: flags.result, mergeSha: flags['merge-sha'] });
    writeAllSync(1, JSON.stringify(d, null, 2) + '\n');
    // A `proceed` decision raises nothing, so it publishes nothing either (it must not mirror an absent marker as a clear).
    if (d.action === 'stop-the-line' && flags.apply) await raise({ reason: 'decide --apply', redRef: flags.ref, mergeSha: flags['merge-sha'] });
  } else if (cmd === 'publish') {
    // Republish the current local FREEZE to the shared branch — the retry after a failed raise. No valid marker → refused.
    await (await shared()).publishFreezeFromCli({ marker: readFreeze() });
  } else {
    process.stderr.write('usage: red-main-remediation.mjs <freeze|unfreeze|status|decide|publish> [--flags]\n');
    process.exit(2);
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) runCli(process.argv.slice(2));
