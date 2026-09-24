#!/usr/bin/env node
/**
 * @file scripts/readiness/dispatch-pause.mjs
 * @description MANUAL/EMERGENCY DISPATCH-PAUSE LEVER (#3609, epic #3383) — a deliberate operator kill-switch,
 *   DISTINCT from the automatic `MAX_CONCURRENT_LANES` admission ceiling (#3612/#xupukxa, both filed the same
 *   night from the 2026-09-07 42-lane/load-34.95 incident). That cap is a STANDING ceiling the dispatcher always
 *   respects; this is a manual override an operator (or a future automatic overload detector) flips to stop ALL
 *   new dispatch immediately — builds, prepare-scope, prepare-decision, fix, and ci-heal spawns alike — while
 *   letting already-running lanes finish normally, then resumes once cleared.
 *
 * KIND-SCOPED PAUSE (epic #3383) - the blanket switch above is the DEFAULT, not the only setting. An operator
 * who wants to stop NEW-ITEM dispatch (`build` / `prepare` / `prepare-decision` / `investigate`) while still
 * letting work on ALREADY-OPEN PRs proceed (`fix` / `ci-heal`) sets a SCOPED pause instead:
 * `dispatch-pause.mjs set --kinds=build,prepare,prepare-decision,investigate`. The scope lives in ONE optional
 * field, `pausedKinds`, read ONLY when `paused` is true:
 *
 *   - `pausedKinds` ABSENT / `null` / not an array / an EMPTY list => BLANKET: every kind in
 *     {@link PAUSABLE_KINDS} is held. This is what an OLD-FORMAT marker (`{paused, reason, by, at}`, the only
 *     shape that existed before this field) parses to, so a pre-existing state file keeps holding everything,
 *     exactly the behavior it had. That backward-compat guarantee is the whole reason "absent" reads as ALL
 *     rather than NONE.
 *   - `pausedKinds` a NON-EMPTY list of kind names => SCOPED: only those kinds are held; every other kind
 *     dispatches normally.
 *
 * An UNRECOGNIZED name in `pausedKinds` is kept verbatim (it matches no kind, so it holds nothing) - this
 * module FAILS OPEN everywhere, and a typo must never silently WIDEN a pause into a blanket one. The CLI
 * validates `--kinds` against {@link PAUSABLE_KINDS} at WRITE time, so a typo is refused loudly at the one
 * point a human introduces one.
 *
 * `review-dispatch` is deliberately NOT in {@link PAUSABLE_KINDS}: it is a separate mechanical pass that has
 * never been gated by this lever, blanket or scoped, and stays that way.
 *
 * WHY THIS EXISTS. The incident's own operator hand-rolled a pause using a plain JSON file under
 * `~/.claude/conveyor-runner-locks/<hash>/SESSION-RESUME-HOLD.json` that did NOT actually gate anything mechanically
 * — it only worked because the operator remembered to honor it themselves. This module is the REAL mechanical
 * lever: `we:scripts/readiness/dispatch-plan.mjs#dispatchPlan` and `we:scripts/conveyor/tick-core.mjs#planTick`
 * BOTH check it before computing any launch/spawn list, holding every otherwise-launchable item with the reason
 * `dispatch-paused` while it is set, and NEVER touching an already-running lane (this module has no lane/lease
 * knowledge at all — it is a pure upstream gate, read before any dispatch decision is made).
 *
 * SHAPE — mirrors `we:scripts/readiness/red-main-remediation.mjs`'s dispatch-freeze marker (a single-holder
 * advisory state file with SET / CLEAR / read-STATUS verbs) and `we:scripts/conveyor/infra-blocked.mjs`'s
 * persistence conventions (script-location path resolution — never CWD — an env-var override, and an ATOMIC
 * temp+rename write so a mid-write reader never observes partial JSON). Simpler than infra-blocked's own
 * array-of-entries + exponential-backoff retry state: this is ONE global advisory flag, not a per-item store —
 * `{ paused, pausedKinds, reason, by, at }`.
 *
 * WHERE THE STORE LIVES — `.conveyor/dispatch-pause.json`, a SESSION-LOCAL, gitignored sidecar alongside
 * `.conveyor/queue.json` / `.conveyor/infra-blocked.json` / `.conveyor/red-main-freeze.json`. Read OFFLINE by
 * both `dispatch-plan.mjs`'s and `tick-core.mjs`'s IO shells. FAILS OPEN on any read error — a missing or
 * corrupt marker reads as NOT paused, never the reverse: a state file must never itself wedge dispatch closed
 * forever with no way to recover short of hand-editing it.
 *
 * PURE-CORE / IO-SHELL SPLIT: {@link emptyPauseState} / {@link parsePauseState} / {@link setPause} /
 * {@link clearPause} / {@link serializePauseState} / {@link normalizePausedKinds} / {@link resolvePausedKinds} /
 * {@link isKindPaused} are PURE — no fs / clock (`now` is injected) — so they are unit-tested directly against
 * plain strings/objects, and BOTH pure dispatch cores ({@link ../conveyor/tick-core.mjs planTick},
 * {@link ./dispatch-plan.mjs dispatchPlan}) import {@link resolvePausedKinds} rather than re-deriving
 * "is THIS kind held" for themselves. The fs helpers (`resolvePauseStorePath` / `readPauseState` /
 * `writePauseState` / `isDispatchPaused` / `readPausedKinds`) and the `set` / `clear` / `status` CLI own the
 * fs/clock boundary.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeAllSync } from '../lib/write-all-sync.mjs';

// ── PURE CORE (no fs / clock — every input injected) ────────────────────────────────────────────────────────

/**
 * The spawn kinds this lever can hold, in dispatch order. These are the CANONICAL dispatch kind identifiers —
 * the same six `LAUNCH_KINDS` `we:scripts/operations/dispatch-lane.mjs` declares and `dispatch-lane-io.mjs`'s
 * `BRIEF_BY_KIND` keys its agent briefs by — NOT a parallel vocabulary invented here (note `investigate`, the
 * real kind name, rather than the looser prose word "investigation"). Kept as its own frozen literal rather
 * than imported so this small, fail-open marker module stays free of `dispatch-lane.mjs`'s own dependency
 * graph; `__tests__/dispatch-pause.test.mjs` asserts the two lists are identical, so they cannot drift.
 *
 * `review-dispatch` is absent ON PURPOSE — it is a separate mechanical pass, never gated by this lever.
 */
export const PAUSABLE_KINDS = Object.freeze(['build', 'prepare', 'prepare-decision', 'investigate', 'fix', 'ci-heal']);

/**
 * Normalize a raw `pausedKinds` value → a non-empty array of kind names, or `null` for "no scope declared"
 * (which every consumer reads as BLANKET — see the file header). Tolerant by design, since this parses
 * whatever a hand-edited marker happens to hold: a non-array, a list of non-strings, blank entries, and
 * duplicates all normalize away; a list that empties out entirely degrades to `null` (blanket), never to an
 * empty scope that would silently hold nothing while still reporting `paused: true`.
 *
 * Unrecognized names are KEPT (they match no kind, so they hold nothing) — see the header on why a typo must
 * fail open rather than widen the pause. Order is preserved so `status` echoes back what the operator typed.
 * @param {*} value
 * @returns {string[]|null}
 */
export function normalizePausedKinds(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const k of value) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.length === 0 ? null : out;
}

/**
 * A state object → the CONCRETE list of kinds currently held. The single predicate source both pure dispatch
 * cores consult, so "blanket means all six" is decided in exactly one place:
 *   not paused → `[]` · paused with no scope → every {@link PAUSABLE_KINDS} entry · paused with a scope → it.
 * @param {{paused?:boolean, pausedKinds?:(string[]|null)}|null|undefined} state
 * @returns {string[]}
 */
export function resolvePausedKinds(state) {
  if (!state || typeof state !== 'object' || state.paused !== true) return [];
  const kinds = normalizePausedKinds(state.pausedKinds);
  return kinds == null ? [...PAUSABLE_KINDS] : kinds;
}

/**
 * Is THIS spawn kind held right now? The per-kind question every `dispatchPaused` check became once the pause
 * stopped being a single blanket boolean.
 * @param {{paused?:boolean, pausedKinds?:(string[]|null)}|null|undefined} state
 * @param {string} kind one of {@link PAUSABLE_KINDS}
 * @returns {boolean}
 */
export function isKindPaused(state, kind) {
  return resolvePausedKinds(state).includes(kind);
}

/** True when a pause is scoped to SOME kinds rather than holding all of them — the blanket-vs-scoped split the
 *  operator-facing hint/note text branches on. */
export function isScopedPause(state) {
  const held = resolvePausedKinds(state);
  return held.length > 0 && held.length !== PAUSABLE_KINDS.length;
}

/** A fresh, NOT-paused state — the read for "no file yet" and every fail-open path. */
export function emptyPauseState() {
  return { paused: false, pausedKinds: null, reason: null, by: null, at: null };
}

/**
 * Tolerant parse of `.conveyor/dispatch-pause.json` text → normalized `{ paused, pausedKinds, reason, by, at }`.
 * An OLD-FORMAT marker (no `pausedKinds` at all — the only shape written before the kind-scoped pause landed)
 * parses to `pausedKinds: null`, i.e. BLANKET: it keeps holding every kind, exactly as it did. NEVER
 * throws: empty/whitespace text, unparseable JSON, or a non-object all degrade to {@link emptyPauseState} —
 * a corrupt marker FAILS OPEN (read as not-paused) rather than silently wedging dispatch closed forever.
 * @param {string|null|undefined} text
 * @returns {{paused:boolean, pausedKinds:(string[]|null), reason:(string|null), by:(string|null), at:(string|null)}}
 */
export function parsePauseState(text) {
  if (!text || !String(text).trim()) return emptyPauseState();
  let raw;
  try { raw = JSON.parse(text); } catch { return emptyPauseState(); }
  // Array.isArray guard is load-bearing, not defensive noise: `typeof [] === 'object'` passes the check above,
  // and an array's own indices/prototype (e.g. `Array.prototype.at`) would otherwise shadow the fields read
  // below — a `[1,2,3]` marker must fail open exactly like any other malformed shape, never read a stray method.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyPauseState();
  const paused = raw.paused === true;
  return {
    paused,
    // A scope on a NOT-paused marker is meaningless (nothing is held), so it normalizes away — that keeps a
    // cleared state deep-equal to `emptyPauseState()` no matter what scope preceded the clear.
    pausedKinds: paused ? normalizePausedKinds(raw.pausedKinds) : null,
    reason: raw.reason != null ? String(raw.reason) : null,
    by: raw.by != null ? String(raw.by) : null,
    at: raw.at != null ? String(raw.at) : null,
  };
}

/**
 * Set (or re-set — idempotent) the pause. Pure — `now` injected so this stays directly unit-testable.
 * `kinds` omitted (or emptying to nothing) keeps the BLANKET pause this lever shipped with — every caller that
 * predates the kind-scoped pause therefore sets exactly the state it always did.
 * @param {{reason?:(string|null), by?:(string|null), kinds?:(string[]|null)}} [o]
 * @param {number} [now] epoch ms
 * @returns {{paused:true, pausedKinds:(string[]|null), reason:string, by:(string|null), at:string}}
 */
export function setPause({ reason = null, by = null, kinds = null } = {}, now = Date.now()) {
  return {
    paused: true,
    pausedKinds: normalizePausedKinds(kinds),
    reason: reason != null && String(reason).trim() ? String(reason).trim() : 'operator emergency pause',
    by: by != null && String(by).trim() ? String(by).trim() : null,
    at: new Date(now).toISOString(),
  };
}

/** Clear the pause — back to {@link emptyPauseState}, dropping any kind scope with it. Idempotent (clearing an
 *  already-clear state is a no-op), and TOTAL: `clear` always fully unpauses, whatever the prior scoping. */
export function clearPause() {
  return emptyPauseState();
}

/** Serialize a state object back to `dispatch-pause.json` text (a bare JSON object, newline-terminated). */
export function serializePauseState(state) {
  const s = state && typeof state === 'object' ? state : emptyPauseState();
  const paused = s.paused === true;
  return JSON.stringify({
    paused,
    pausedKinds: paused ? normalizePausedKinds(s.pausedKinds) : null,
    reason: s.reason ?? null,
    by: s.by ?? null,
    at: s.at ?? null,
  }, null, 2) + '\n';
}

// ── THIN FS/IO SHELL (the boundary — used by dispatch-plan.mjs and tick-core.mjs) ──────────────────────────────

// Resolve the repo root by SCRIPT LOCATION (this file is scripts/readiness/dispatch-pause.mjs → root is two up),
// NOT by CWD — so every consumer (regardless of its own cwd) resolves the SAME store (mirrors queue-store.mjs /
// infra-blocked.mjs).
const HERE = dirname(fileURLToPath(import.meta.url));
export const PAUSE_ROOT = resolve(HERE, '..', '..');

/** The session sidecar path: `<root>/.conveyor/dispatch-pause.json`. */
export function pauseStorePath(root = PAUSE_ROOT) {
  return join(root, '.conveyor', 'dispatch-pause.json');
}

/** The canonical sidecar path every consumer resolves to — `WE_DISPATCH_PAUSE_FILE` override wins, else
 *  script-location (tests + an out-of-tree checkout point at their own copy). */
export function resolvePauseStorePath() {
  const env = process.env.WE_DISPATCH_PAUSE_FILE;
  return env && env.trim() ? env.trim() : pauseStorePath();
}

/** Read + parse the marker → the normalized state. FAILS OPEN: a missing OR corrupt file reads as
 *  {@link emptyPauseState} (not paused) — never throws. */
export function readPauseState(path = resolvePauseStorePath()) {
  try {
    if (!existsSync(path)) return emptyPauseState();
    return parsePauseState(readFileSync(path, 'utf8'));
  } catch {
    return emptyPauseState();
  }
}

/**
 * Is ANY pause in effect? Deliberately UNCHANGED by the kind-scoped pause: a scoped pause still answers `true`
 * here, so a caller that only knows this boolean (anything written before `pausedKinds` existed) keeps doing
 * what it always did — hold everything. Per-kind callers ask {@link readPausedKinds} / {@link isKindPaused}
 * instead. Fails OPEN (see {@link readPauseState}) — an unreadable marker is never mistaken for a pause.
 */
export function isDispatchPaused(path = resolvePauseStorePath()) {
  return readPauseState(path).paused === true;
}

/** Read the marker → the CONCRETE list of kinds currently held (`[]` when not paused). The per-kind read the
 *  two dispatch IO shells do instead of {@link isDispatchPaused}. Fails OPEN exactly the same way. */
export function readPausedKinds(path = resolvePauseStorePath()) {
  return resolvePausedKinds(readPauseState(path));
}

/** Write the marker, ATOMICALLY (temp + rename), so a mid-write reader never sees partial JSON. */
export function writePauseState(state, path = resolvePauseStorePath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, serializePauseState(state));
  renameSync(tmp, path);
}

// ── CLI (runs only when invoked directly) ─────────────────────────────────────────────────────────────────────

/**
 * Parse + VALIDATE a `--kinds=a,b,c` flag value → `{ kinds, error }`. PURE, so the refusal is unit-tested
 * without spawning a process.
 *   - flag ABSENT (`undefined`/`null`) → `{ kinds: null }`: a blanket pause, i.e. `set` with no `--kinds`
 *     behaves exactly as it always has.
 *   - a BARE `--kinds` with no value, or a value that is nothing but separators → an ERROR, never a silent
 *     fall-back to a blanket pause: the operator asked for a narrower hold and must get one or be told why not
 *     (falling back would WIDEN the pause they asked to narrow — the worst possible direction to guess in).
 *   - any name outside {@link PAUSABLE_KINDS} → an ERROR naming the offender and the valid set. This is the
 *     WRITE-time validation the file header promises: the marker itself keeps unknown names verbatim and
 *     fails open, so the CLI is the one place a human's typo can be caught loudly.
 * @param {*} value the raw flag value (`true` for a bare `--kinds`, a string for `--kinds=...`)
 * @returns {{kinds:(string[]|null), error:(string|null)}}
 */
export function parseKindsFlag(value) {
  if (value === undefined || value === null) return { kinds: null, error: null };
  const needsValue = `--kinds needs at least one kind, e.g. --kinds=${PAUSABLE_KINDS.join(',')}`;
  if (typeof value !== 'string') return { kinds: null, error: needsValue };
  const names = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return { kinds: null, error: needsValue };
  const unknown = names.filter((n) => !PAUSABLE_KINDS.includes(n));
  if (unknown.length > 0) {
    return { kinds: null, error: `unknown dispatch kind(s): ${unknown.join(', ')} — valid kinds are ${PAUSABLE_KINDS.join(', ')}` };
  }
  return { kinds: normalizePausedKinds(names), error: null };
}

/** The one-line operator gloss for WHAT a state holds — `set` and `status` both print it, so a scoped pause is
 *  never reported with the blanket wording (or vice versa). PURE. */
export function describeHeldKinds(state) {
  const held = resolvePausedKinds(state);
  if (held.length === 0) return 'nothing — dispatch is running';
  return isScopedPause(state) ? `${held.join(', ')} (other kinds still dispatch)` : `ALL kinds (${held.join(', ')})`;
}

/** Hand-rolled `--k=v` / `--flag` parsing (+ positional subcommand). */
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
  const path = resolvePauseStorePath();

  if (cmd === 'set' || cmd === 'pause') {
    const { kinds, error } = parseKindsFlag(flags.kinds);
    if (error) { process.stderr.write(`✗ ${error}\n`); process.exit(2); }
    const state = setPause({ reason: flags.reason, by: flags.by || process.env.USER || null, kinds });
    writePauseState(state, path);
    process.stderr.write(`⏸ dispatch PAUSED — ${state.reason}${state.by ? ` (by ${state.by})` : ''}\n`);
    process.stderr.write(`  holding: ${describeHeldKinds(state)}\n`);
    writeAllSync(1, JSON.stringify(state, null, 2) + '\n');
    return;
  }
  if (cmd === 'clear' || cmd === 'unpause' || cmd === 'resume') {
    // TOTAL, whatever the prior scoping — `clear` is the one verb that always returns to fully-unpaused.
    writePauseState(clearPause(), path);
    process.stderr.write('▶ dispatch RESUMED — pause cleared (all kinds)\n');
    writeAllSync(1, JSON.stringify({ paused: false, pausedKinds: null }, null, 2) + '\n');
    return;
  }
  if (cmd === 'status') {
    const state = readPauseState(path);
    process.stderr.write(`holding: ${describeHeldKinds(state)}\n`);
    // `heldKinds` is DERIVED for display only (the blanket `pausedKinds: null` expanded to the concrete six) —
    // it is never written to the marker, so `status` output stays a superset of the state, not a rival shape.
    writeAllSync(1, JSON.stringify({ ...state, heldKinds: resolvePausedKinds(state) }, null, 2) + '\n');
    return;
  }
  process.stderr.write(
    'usage: dispatch-pause.mjs <set|clear|status> [--reason=<text>] [--by=<who>] [--kinds=<a,b,c>]\n'
    + `       --kinds scopes the pause to those kinds only (default: every kind). Valid: ${PAUSABLE_KINDS.join(', ')}\n`,
  );
  process.exit(2);
}

const IS_CLI = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (IS_CLI) runCli(process.argv.slice(2));
