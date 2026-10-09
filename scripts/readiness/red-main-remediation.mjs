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

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { writeAllSync } from '../lib/write-all-sync.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // scripts/readiness → repo root

/** The durable dispatch-freeze marker: a GITIGNORED `.conveyor/` sidecar (the same convention as the #2680
 *  dispatch log / #2659 infra-blocked state). Present ⇒ the line is STOPPED; absent ⇒ dispatch is clear.
 *  Env-overridable so a drain-only session (or a test) can point at a specific copy. */
export const FREEZE_MARKER_PATH = process.env.WE_RED_MAIN_FREEZE || join(ROOT, '.conveyor', 'red-main-freeze.json');

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
  const marker = {
    frozen: true,
    at: meta.at || new Date().toISOString(),
    reason: meta.reason || REMEDIATION_SPEC.trigger,
    redRef: meta.redRef || 'main',
    mergeSha: meta.mergeSha || null,
    revertAuthority: true,
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + '\n');
  renameSync(tmp, path);
  return marker;
}

/** Lift the dispatch-freeze (main verified green again). Idempotent — a missing marker is a no-op. */
export function unfreezeDispatch(path = FREEZE_MARKER_PATH) {
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

function runCli(argv) {
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  if (cmd === 'freeze') {
    const m = freezeDispatch({ reason: flags.reason, redRef: flags['red-ref'], mergeSha: flags['merge-sha'] });
    process.stdout.write(JSON.stringify(m, null, 2) + '\n');
  } else if (cmd === 'unfreeze') {
    unfreezeDispatch();
    writeAllSync(1, JSON.stringify({ frozen: false }, null, 2) + '\n');
  } else if (cmd === 'status') {
    writeAllSync(1, JSON.stringify({ frozen: isDispatchFrozen(), marker: readFreeze() }, null, 2) + '\n');
  } else if (cmd === 'decide') {
    const d = decidePostLand({ trigger: flags.trigger, ref: flags.ref, result: flags.result, mergeSha: flags['merge-sha'] });
    writeAllSync(1, JSON.stringify(d, null, 2) + '\n');
    if (d.action === 'stop-the-line' && flags.apply) freezeDispatch({ reason: 'decide --apply', redRef: flags.ref, mergeSha: flags['merge-sha'] });
  } else if (cmd === 'publish') {
    // republish the current local state to the shared branch (below) — the retry after a failed publish
  } else {
    process.stderr.write('usage: red-main-remediation.mjs <freeze|unfreeze|status|decide|publish> [--flags]\n');
    process.exit(2);
  }
  // xyd06qo: every raise/clear ALSO publishes the local marker's state to the shared ops/* branch CI's merge-gate reads.
  if (['freeze', 'unfreeze', 'publish'].includes(cmd) || (cmd === 'decide' && flags.apply)) return import('../lib/red-main-freeze-shared.mjs').then((s) => s.publishFreezeFromCli({ marker: readFreeze() }));
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) runCli(process.argv.slice(2));
