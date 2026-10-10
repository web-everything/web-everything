#!/usr/bin/env node
/**
 * @file scripts/readiness/test-selection.mjs
 * @description DIFF-DRIVEN TEST SELECTION with a DENY-BY-DEFAULT shrink allow-list (WE #2681, under #2612).
 *
 * WHAT THIS IS. Shrink per-item CI by running only the tests a PR's ACTUAL diff affects — soundly. The design
 * jury killed the original "map keyed on the declared/predicted `scope:`" idea (blind to reverse dependencies,
 * cross-cutting tests, and diff-drift). This module is the redesign: it selects off the REAL `git diff` — via
 * vitest's own module-graph (`vitest related`, sound-by-construction over the STATIC import graph) — gates the
 * shrink behind a DENY-BY-DEFAULT allow-list evaluated on the ACTUAL changed set, and produces the false-green
 * signal ({@link assessFalseGreen}) its own eventual default-on gate reads.
 *
 * THE JURY'S FOUR REQUIRED PROPERTIES (encoded here):
 *   1. SELECT OFF THE DIFF, NOT SCOPE — {@link changedFilesSince} computes the changed set from `git diff`, never
 *      from the authored `scope:` (which stays for dispatch-overlap arbitration only). vitest's module graph does
 *      the reverse-dependency walk; this module decides WHETHER we are allowed to shrink at all.
 *   2. DENY-BY-DEFAULT SHRINK ALLOW-LIST — {@link isShrinkablePath} returns true ONLY for a path that both (a)
 *      matches {@link SHRINK_ALLOW_LIST} AND (b) is NOT a sensitive surface ({@link isSensitivePath}). A path that
 *      matches nothing is NOT shrinkable — so a NEW sensitive surface is safe until someone explicitly allow-lists
 *      it. Keyed on the DIFF, never the prediction, so a diff that exceeds its declared scope cannot evade the
 *      boundary.
 *   3. RED-MAIN REMEDIATION — the "post-land full-suite red under a sole writer" stop-the-line lives in the
 *      sibling {@link ./red-main-remediation.mjs} (dispatch-freeze + revert authority); the drain consults it.
 *   4. KEEP THE `push:[main]` FULL SUITE — untouched in `.github/workflows/ci.yml`; this module only ever governs
 *      the per-PR shrink, and even then only when the flag is on.
 *
 * ROUND-2 SHARPENINGS (encoded here):
 *   • GLOB-EDGE GUARD ({@link hitsGlobEdge}). `vitest related` is sound only over the STATIC import graph.
 *     `import.meta.glob` / fs-readdir test→source edges (registry / backlog / capability-intent discovery tests
 *     that find files by DIRECTORY, not by import) are invisible to it. When a changed path falls under a
 *     glob-discovered fixture root ({@link GLOB_FIXTURE_ROOTS}) we force the FULL suite. "Sound-by-construction"
 *     applies to the static graph only.
 *   • PINNED MERGE-BASE ({@link changedFilesSince}). The changed set is the net diff from the PINNED
 *     `git merge-base origin/main HEAD` to HEAD — robust to a stacked / rebased / squash-merged branch. A wrong
 *     base would let a statute/hook/lockfile edit made EARLIER in the branch fall outside the computed set and
 *     evade the deny-by-default allow-list (the gate-self hole). Pinning the merge-base closes that.
 *   • FALSE-GREEN SIGNAL PRODUCED HERE ({@link assessFalseGreen}). #2680 measures DURATIONS; a false-green
 *     (selected-green while full-suite-red) is a test-OUTCOME fact. This module owns the shadow full-suite
 *     compare: given a full run's FAILING test files and the set selection WOULD have run, a failure OUTSIDE the
 *     selected set is a false-green selection would have missed. {@link recordFalseGreen} appends the signal to a
 *     gitignored `.conveyor/` sidecar (the evidence the default-on decision reads).
 *
 * FLAG-GATED / NOT DEFAULTED. {@link selectTests} returns the FULL suite unless the flag ({@link SELECTION_FLAG})
 * is explicitly on. Per the DoD it is NOT defaulted until the measured false-green rate (this module's shadow
 * compare) is acceptable AND a red-main recovery path exists ({@link ./red-main-remediation.mjs}) — and the
 * marginal win is re-justified against post-shard (#2682) wall-clock. The whole module may ultimately collapse to
 * "vitest related + shard with no bespoke map"; until the evidence says so, the deny-by-default boundary holds.
 *
 * PURITY. The decision core ({@link decideSelection}, {@link isShrinkablePath}, {@link isSensitivePath},
 * {@link hitsGlobEdge}, {@link assessFalseGreen}) is pure — no fs, no child_process, no clock. The git edge
 * ({@link changedFilesSince}) takes an injectable `runGit`, so tests drive it with a synthetic runner. Only the
 * CLI shell at the bottom touches git / fs for real.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { isBlastRadiusPath, isStatutePath, isGateSelfPath } from '../lib/review-escalation.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { admittedArgv } from './heavy-admission.mjs';

// ── the flag (NOT defaulted — DoD) ───────────────────────────────────────────────────────────────────────────

/** The env flag that turns diff-driven shrink ON. Unset/anything-but-"1" ⇒ full suite (the safe default). The
 *  DoD forbids defaulting this until the measured false-green rate is acceptable and a red-main recovery path
 *  exists — so it is opt-in, and CI keeps it OFF while the shadow compare gathers evidence. */
export const SELECTION_FLAG = 'WE_DIFF_TEST_SELECTION';

/** True iff the flag is explicitly enabled in `env` (default `process.env`). Pure w.r.t. the passed object. */
export function selectionFlagEnabled(env = process.env) {
  return String(env?.[SELECTION_FLAG] ?? '') === '1';
}

// ── the DENY surface (property 2) — the paths that must NEVER shrink ─────────────────────────────────────────

/**
 * Extra deny predicates NOT already covered by the ratified {@link isBlastRadiusPath} / {@link isStatutePath} /
 * {@link isGateSelfPath} set (`scripts/`, `.github/`, `.githooks/`, `.claude/skills/`, statute, standard/plug
 * definitions). The spec (#2681) also names the SUPPLY-CHAIN, CONFIG, and full `.claude/` surfaces — added here
 * so the deny surface is the UNION the spec requires. All match by pattern OR basename so they travel across
 * directories. Each is a "force full + review:human" surface.
 */
export const EXTRA_DENY = [
  // supply-chain: manifest + any lockfile (a dependency bump is a supply-chain change — never shrink it)
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  // build/test config: `*.config.{js,cjs,mjs,ts,cts,mts}` (vitest/vite/playwright/etc — changes what/how tests run)
  /(^|\/)[^/]+\.config\.(c|m)?[jt]s$/,
  // the FULL `.claude/` surface — hooks + settings + skills (MEMORY #43): the write-time gate lives here
  /(^|\/)\.claude\//,
  // `check-*` gate scripts anywhere (blast-radius already covers `scripts/check-*`; this catches a relocated one)
  /(^|\/)check-[\w-]+\.(c|m)?[jt]s$/,
];

/**
 * Is this repo-relative path a SENSITIVE surface that must force the FULL suite (and `review:human`)? Pure.
 * The UNION of the ratified escalation surfaces ({@link isBlastRadiusPath} — `scripts/`, CI, hooks, skills,
 * standard defs; {@link isStatutePath}; {@link isGateSelfPath} — the gate's policy tier) and {@link EXTRA_DENY}
 * (supply-chain / config / full `.claude/`). Composing the ratified predicates — never re-listing them — means
 * this can never drift from the escalation rubric the drain already enforces.
 * @param {string} path repo-relative (or repo-prefixed) path
 * @returns {boolean}
 */
export function isSensitivePath(path) {
  const p = String(path || '');
  if (!p) return true; // an empty/unknown path is treated as sensitive — the safe direction
  return isBlastRadiusPath(p) || isStatutePath(p) || isGateSelfPath(p) || EXTRA_DENY.some((re) => re.test(p));
}

// ── the SHRINK ALLOW-LIST (property 2) — the ONLY paths a shrink may cover ───────────────────────────────────

/**
 * The deny-by-default allow-list: the ONLY path shapes a shrink may cover. Deliberately CONSERVATIVE for the
 * measure phase — leaf, non-sensitive, non-glob-discovered surfaces whose edits genuinely cannot affect the
 * trust chain and whose tests the STATIC graph reaches:
 *   • `docs/` — documentation markdown (statute under `docs/agent/` is excluded by {@link isSensitivePath}).
 *   • `research/` — research topic markdown.
 *   • test files themselves — a changed test is directly selected by `vitest related`.
 * WIDENING THIS IS THE MEASURE-DRIVEN FOLLOW-UP: the shadow false-green rate ({@link assessFalseGreen}) is the
 * evidence for whether a wider allow-list is safe. Membership here is NECESSARY but not SUFFICIENT — a member
 * that is ALSO sensitive ({@link isSensitivePath}) or a glob-edge ({@link hitsGlobEdge}) still forces full. So
 * over-widening this list can never punch a hole in the deny surface; it can only add candidates the two harder
 * gates then re-filter.
 */
export const SHRINK_ALLOW_LIST = [
  /^docs\//,
  /^research\//,
  /(^|\/)__tests__\//,
  /(^|\/)[^/]+\.test\.(c|m)?[jt]sx?$/,
];

/**
 * May a shrink cover this path? DENY-BY-DEFAULT: true ONLY when the path matches {@link SHRINK_ALLOW_LIST} AND is
 * NOT sensitive ({@link isSensitivePath}). A path matching neither list is NOT shrinkable — the whole point:
 * a surface is safe (full suite) until someone explicitly allow-lists it. Pure.
 * @param {string} path repo-relative path
 * @returns {boolean}
 */
export function isShrinkablePath(path) {
  const p = String(path || '');
  if (!p) return false;
  if (isSensitivePath(p)) return false; // sensitive always wins — the deny surface is hard
  return SHRINK_ALLOW_LIST.some((re) => re.test(p));
}

// ── the GLOB-EDGE GUARD (round-2) — the STATIC-graph blind spot ──────────────────────────────────────────────

/**
 * Fixture roots discovered by `import.meta.glob` / fs-readdir in the UNIT suite — the test→source edges the
 * static import graph (and therefore `vitest related`) CANNOT see. A changed path under any of these forces the
 * FULL suite ({@link hitsGlobEdge}), because the discovering test picks the file up by DIRECTORY, not by import.
 * Seeded from the repo's known directory-discovery tests (backlog loader/guard; capability/intent globs; demo
 * registry). EXTEND this when a new glob-discovery test lands — that is the one maintenance duty the "sound over
 * the static graph only" caveat imposes.
 */
export const GLOB_FIXTURE_ROOTS = [
  'backlog/',
  'demos/',
  'src/_data/capabilities/',
  'src/_data/intents/',
];

/**
 * Does this path fall under a glob-discovered fixture root ({@link GLOB_FIXTURE_ROOTS})? Pure. A hit means the
 * static graph is blind to the edge, so the caller MUST force the full suite regardless of allow-list status.
 * @param {string} path repo-relative path
 * @returns {boolean}
 */
export function hitsGlobEdge(path) {
  const p = String(path || '');
  return GLOB_FIXTURE_ROOTS.some((root) => p === root.replace(/\/$/, '') || p.startsWith(root));
}

// ── the DECISION (properties 1 + 2 + glob-edge) ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SelectionDecision
 * @property {'full'|'shrink'} mode         `shrink` ⇒ run only `vitest related` on {@link SelectionDecision.selectedFiles}; `full` ⇒ the whole suite.
 * @property {boolean} humanRequired        the diff touched a SENSITIVE surface ⇒ full suite AND `review:human`.
 * @property {string[]} selectedFiles       the changed files to hand to `vitest related` (only meaningful when `mode==='shrink'`).
 * @property {string[]} sensitiveFiles      the changed files that were sensitive (drove `humanRequired`).
 * @property {string[]} globEdgeFiles       the changed files that hit a glob-edge (forced full without being sensitive).
 * @property {string[]} unlistedFiles       the changed files that were neither sensitive nor allow-listed (forced full, deny-by-default).
 * @property {string[]} reasons             human-readable reasons the decision came out the way it did.
 */

/**
 * Decide, from the ACTUAL changed set, whether CI may SHRINK to `vitest related` or must run the FULL suite.
 * Pure — no git, no fs. The rule (deny-by-default, hard):
 *   • flag OFF ⇒ always FULL (the module is opt-in; #2681 DoD).
 *   • empty changed set ⇒ FULL (nothing to key a sound selection on — the conservative default).
 *   • ANY sensitive file ⇒ FULL + `humanRequired` (property 2 — the gate-self boundary, on the actual diff).
 *   • ANY glob-edge file ⇒ FULL (round-2 — the static-graph blind spot).
 *   • ANY file neither sensitive nor allow-listed ⇒ FULL (deny-by-default — unknown surface is not shrinkable).
 *   • otherwise (EVERY changed file is shrinkable, no glob-edge) ⇒ SHRINK, selecting the changed files.
 * @param {{changedFiles?: string[], flagEnabled?: boolean}} args
 * @returns {SelectionDecision}
 */
export function decideSelection({ changedFiles = [], flagEnabled = false } = {}) {
  const files = (changedFiles || []).map((f) => String(f)).filter(Boolean);
  const full = (reasons, extra = {}) => ({
    mode: 'full', humanRequired: false, selectedFiles: [], sensitiveFiles: [], globEdgeFiles: [], unlistedFiles: [],
    reasons, ...extra,
  });

  if (!flagEnabled) return full([`flag ${SELECTION_FLAG} is off — full suite (diff-driven shrink is opt-in, #2681)`]);
  if (files.length === 0) return full(['empty changed set — full suite (no sound selection basis)']);

  const sensitiveFiles = files.filter(isSensitivePath);
  const globEdgeFiles = files.filter((f) => !isSensitivePath(f) && hitsGlobEdge(f));
  const unlistedFiles = files.filter((f) => !isSensitivePath(f) && !hitsGlobEdge(f) && !isShrinkablePath(f));

  const reasons = [];
  if (sensitiveFiles.length) reasons.push(`sensitive surface(s) changed (${sensitiveFiles.join(', ')}) — full suite + review:human (deny-by-default gate-self, on the actual diff)`);
  if (globEdgeFiles.length) reasons.push(`glob-discovered fixture root(s) changed (${globEdgeFiles.join(', ')}) — full suite (static-graph blind spot, round-2)`);
  if (unlistedFiles.length) reasons.push(`unlisted surface(s) changed (${unlistedFiles.join(', ')}) — full suite (deny-by-default: not on the shrink allow-list)`);

  if (sensitiveFiles.length || globEdgeFiles.length || unlistedFiles.length) {
    return {
      mode: 'full',
      humanRequired: sensitiveFiles.length > 0,
      selectedFiles: [],
      sensitiveFiles,
      globEdgeFiles,
      unlistedFiles,
      reasons,
    };
  }

  return {
    mode: 'shrink',
    humanRequired: false,
    selectedFiles: files.slice(),
    sensitiveFiles: [],
    globEdgeFiles: [],
    unlistedFiles: [],
    reasons: [`every changed file is on the shrink allow-list and clear of the glob-edge — selecting ${files.length} path(s) for \`vitest related\``],
  };
}

// ── the CHANGED SET (property 1 + pinned merge-base) ─────────────────────────────────────────────────────────

/**
 * The pinned merge-base between `base` and HEAD, or `null` if it cannot be computed. Pinning it (rather than
 * diffing the two branch TIPS) is what makes the changed set robust to a stacked / rebased / squash-merged
 * branch — see the round-2 note. `runGit(args) => string` is injectable so tests drive it deterministically.
 * @param {{base?: string, runGit: (args: string[]) => string}} args
 * @returns {string|null} the merge-base commit sha, or null on failure
 */
export function pinnedMergeBase({ base = 'origin/main', runGit } = {}) {
  try {
    const sha = String(runGit(['merge-base', base, 'HEAD'])).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** #xgqwuq5 — how many of the PR's own commits {@link findLastGreenAncestor} looks back through. */
export const LAST_GREEN_LOOKBACK = 50;

/**
 * #xgqwuq5 — the newest EARLIER commit of this PR (`<merge-base>..HEAD^`, newest first, at most
 * {@link LAST_GREEN_LOOKBACK}) that `hasGreen(sha)` vouches for, or null. Pure over `runGit` + `hasGreen`; any git
 * failure is null (no green ⇒ the caller keeps the whole-PR selection).
 * @param {{base?: string, runGit: (args: string[]) => string, hasGreen: (sha: string) => boolean}} args
 * @returns {string|null}
 */
export function findLastGreenAncestor({ base = 'origin/main', runGit, hasGreen } = {}) {
  if (typeof hasGreen !== 'function') return null;
  const mergeBase = pinnedMergeBase({ base, runGit });
  if (!mergeBase) return null;
  try {
    const shas = String(runGit(['rev-list', `--max-count=${LAST_GREEN_LOOKBACK}`, `${mergeBase}..HEAD^`]))
      .split('\n').map((s) => s.trim()).filter(Boolean);
    return shas.find((sha) => { try { return hasGreen(sha) === true; } catch { return false; } }) ?? null;
  } catch {
    return null;
  }
}

/**
 * #xgqwuq5 — may the gate select from `<greenSha>..HEAD` instead of the whole PR? Only when that range holds just the
 * PR's own commits: `greenSha` is a STRICT ancestor of HEAD, the range has no merge commit (a merge of main brings
 * code the green never saw), and the merge-base with `base` is the same for both ends (no rebase onto a newer main).
 * Pure over `runGit`; any git failure is `eligible: false` (fail closed to the whole-PR selection).
 * @param {{base?: string, runGit: (args: string[]) => string, greenSha: string|null}} args
 * @returns {{eligible: boolean, reason: string}}
 */
export function decideSinceLastGreen({ base = 'origin/main', runGit, greenSha } = {}) {
  if (!greenSha) return { eligible: false, reason: 'no green verify recorded for an earlier commit of this PR' };
  const short = String(greenSha).slice(0, 8);
  try {
    const head = String(runGit(['rev-parse', 'HEAD'])).trim();
    if (head === greenSha) return { eligible: false, reason: `last green ${short} is HEAD itself` };
    try { runGit(['merge-base', '--is-ancestor', greenSha, 'HEAD']); } catch {
      return { eligible: false, reason: `last green ${short} is not an ancestor of HEAD (rebased or rewritten)` };
    }
    const merges = String(runGit(['rev-list', '--merges', `${greenSha}..HEAD`])).trim();
    if (merges) return { eligible: false, reason: `${greenSha.slice(0, 8)}..HEAD contains a merge commit (${merges.split('\n')[0].slice(0, 8)})` };
    const headBase = String(runGit(['merge-base', base, 'HEAD'])).trim();
    const greenBase = String(runGit(['merge-base', base, greenSha])).trim();
    if (!headBase || headBase !== greenBase) return { eligible: false, reason: `merge-base with ${base} moved since last green ${short} (${greenBase.slice(0, 8)} → ${headBase.slice(0, 8)})` };
    return { eligible: true, reason: `${short}..HEAD holds only this PR's own commits` };
  } catch {
    return { eligible: false, reason: `could not check ${short}..HEAD with git` };
  }
}

/**
 * The NET changed set: the files that differ between the PINNED merge-base ({@link pinnedMergeBase}) and HEAD.
 * This is property 1 (select off the diff) + the round-2 merge-base pin. `runGit` is injectable. Returns a
 * de-duplicated, sorted list of repo-relative paths. On any git failure returns `null` — the caller MUST treat a
 * `null` (unknown) changed set as FULL, never as "empty ⇒ shrink".
 * @param {{base?: string, runGit: (args: string[]) => string}} args
 * @returns {string[]|null}
 */
export function changedFilesSince({ base = 'origin/main', runGit } = {}) {
  const mergeBase = pinnedMergeBase({ base, runGit });
  if (!mergeBase) return null;
  try {
    const out = String(runGit(['diff', '--name-only', mergeBase, 'HEAD']));
    const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return Array.from(new Set(files)).sort();
  } catch {
    return null;
  }
}

/**
 * End-to-end: compute the changed set off the pinned merge-base and decide. A `null` changed set (git failure)
 * is treated as FULL — we never shrink on an unknown diff. `runGit`/`env` injectable for tests.
 * @param {{base?: string, runGit: (args: string[]) => string, env?: Record<string,string|undefined>}} args
 * @returns {SelectionDecision & {changedFiles: string[]|null}}
 */
export function selectTests({ base = 'origin/main', runGit, env = process.env } = {}) {
  const flagEnabled = selectionFlagEnabled(env);
  const changedFiles = changedFilesSince({ base, runGit });
  if (changedFiles === null) {
    return {
      changedFiles: null,
      ...decideSelection({ changedFiles: [], flagEnabled: false }),
      reasons: ['could not compute the pinned-merge-base diff — full suite (never shrink on an unknown diff)'],
    };
  }
  return { changedFiles, ...decideSelection({ changedFiles, flagEnabled }) };
}

// ── the LOCAL agent-gate policy (xpnhz4o) — a DIFFERENT, wider shrink than the CI one above ─────────────────
//
// WHY A SECOND POLICY. {@link decideSelection} governs a shrink of the AUTHORITATIVE gate (CI), so it is
// deny-by-default: only docs/research/test-file diffs may shrink, and every `scripts/` change is sensitive ⇒ full.
// Reused for the LOCAL agent gate (`verify-lane`, #3372), that meant nearly every real PR fell back to the full
// suite — observed 2026-09-25: several fixers each running the 10+ minute suite at once, host load 1.8/core,
// starving lane pickup and every review. The local gate is NOT the authority: CI still runs the full, unshrunk
// suite on every PR and on `main`, so a local miss costs one CI round-trip, never a merged regression. The local
// policy therefore shrinks by default and falls back to the full suite ONLY where `vitest related`'s static
// module graph genuinely cannot see the effect of a change:
//   • supply chain — `package.json` / a lockfile (every test's dependency set moves);
//   • test/build config — `*.config.*`, `vitest.*` (setup / shared / workspace), `tsconfig*.json`;
//   • shared test helpers and fixtures — any NON-test file under `__tests__/`, `__fixtures__/`, `__mocks__/`,
//     `test-utils/`, `test-helpers/` (read by path or shared by many tests; the graph under-reports them);
//   • a DELETED non-test source file — its importers can no longer be found through the graph.
// Everything else runs `vitest related` on the changed files plus the tests that NAME a changed file (the
// spawn-the-CLI and read-the-file edges the graph misses — computed by the IO shell, {@link referencedTestNeedles}).

/** Non-test paths whose change forces the local FULL suite — see the block comment above. */
export const LOCAL_FULL_SUITE_TRIGGERS = [
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)[^/]+\.config\.(c|m)?[jt]s$/,
  /(^|\/)vitest\.[^/]+\.(c|m)?[jt]s$/,
  /(^|\/)tsconfig[^/]*\.json$/,
];

/** Directory names whose NON-test files are shared test helpers / fixtures (a local full-suite trigger). */
const SHARED_TEST_DIRS = /(^|\/)(__tests__|__fixtures__|__mocks__|test-utils|test-helpers)\//;
const TEST_FILE = /(^|\/)[^/]+\.(test|spec)\.(c|m)?[jt]sx?$/;
const SNAPSHOT_FILE = /(^|\/)__snapshots__\/([^/]+)\.snap$/;

/** Is this a test file itself (`*.test.*` / `*.spec.*`)? Pure. */
export function isTestFile(path) {
  return TEST_FILE.test(String(path || ''));
}

/** Does a change to this path force the LOCAL full suite? Pure. A snapshot is NOT a trigger (it maps to its test). */
export function isLocalFullSuiteTrigger(path) {
  const p = String(path || '');
  if (!p) return true;
  if (SNAPSHOT_FILE.test(p)) return false;
  if (LOCAL_FULL_SUITE_TRIGGERS.some((re) => re.test(p))) return true;
  return SHARED_TEST_DIRS.test(p) && !isTestFile(p);
}

/**
 * Decide the LOCAL agent gate's vitest half from the actual changed set. Pure.
 *   • `optOut` (`WE_DIFF_TEST_SELECTION=0`) ⇒ full.
 *   • `changedFiles === null` (the diff could not be computed) or empty ⇒ full (no sound selection basis).
 *   • any {@link isLocalFullSuiteTrigger} path, or any deleted non-test file ⇒ full, naming the paths.
 *   • otherwise ⇒ shrink: `relatedFiles` = the changed, still-present files (a `__snapshots__/x.snap` maps to its
 *     test `x`), handed to `vitest related` by the caller.
 * @param {{changedFiles: string[]|null, deletedFiles?: string[], optOut?: boolean}} args
 * @returns {{mode: 'full'|'shrink', relatedFiles: string[], triggerFiles: string[], deletedSourceFiles: string[], reasons: string[]}}
 */
export function decideLocalSelection({ changedFiles, deletedFiles = [], optOut = false } = {}) {
  const full = (reasons, extra = {}) => ({ mode: 'full', relatedFiles: [], triggerFiles: [], deletedSourceFiles: [], reasons, ...extra });
  if (optOut) return full([`${SELECTION_FLAG}=0 — full suite (explicit opt-out of the local diff selection)`]);
  if (changedFiles === null || changedFiles === undefined) return full(['could not compute the diff against the merge-base — full suite (never shrink on an unknown diff)']);
  const files = Array.from(new Set(changedFiles.map(String).filter(Boolean))).sort();
  if (files.length === 0) return full(['empty diff against the merge-base — full suite (no selection basis)']);
  const deleted = new Set((deletedFiles || []).map(String));
  const triggerFiles = files.filter(isLocalFullSuiteTrigger);
  const deletedSourceFiles = files.filter((f) => deleted.has(f) && !isTestFile(f) && !SNAPSHOT_FILE.test(f) && /\.(c|m)?[jt]sx?$/.test(f));
  const reasons = [];
  if (triggerFiles.length) reasons.push(`config / setup / dependency / shared-test-helper file(s) changed (${triggerFiles.join(', ')}) — full suite (the module graph cannot scope these)`);
  if (deletedSourceFiles.length) reasons.push(`source file(s) deleted (${deletedSourceFiles.join(', ')}) — full suite (their importers are no longer findable through the module graph)`);
  if (reasons.length) return full(reasons, { triggerFiles, deletedSourceFiles });
  const relatedFiles = Array.from(new Set(files
    .filter((f) => !deleted.has(f))
    .map((f) => { const m = SNAPSHOT_FILE.exec(f); return m ? f.replace(SNAPSHOT_FILE, `$1${m[2]}`) : f; }))).sort();
  return {
    mode: 'shrink', relatedFiles, triggerFiles: [], deletedSourceFiles: [],
    reasons: [`${files.length} changed path(s), none a config/setup/dependency/shared-helper trigger — running only the tests they reach (\`vitest related\`) plus tests that name them; CI still runs the full suite`],
  };
}

/** Basenames too generic to identify a file by name (would pull in unrelated tests). */
const GENERIC_BASENAME = /^(index|main|types|type|utils|util|constants|config|README|CHANGELOG|package)\.[^.]+$/i;

/** Glob-discovered roots whose tests find files by DIRECTORY; a change under one adds the tests naming the root.
 *  `backlog/` is deliberately absent: its content is validated by `check:standards`, which the gate runs UNSCOPED
 *  whenever `backlog/` is touched (`verify-lane-gate.mjs#canScopeCheckStandards`), and ~140 fixture tests name it. */
const LOCAL_GLOB_ROOT_NEEDLES = GLOB_FIXTURE_ROOTS.filter((r) => r !== 'backlog/').map((r) => r.replace(/\/$/, ''));

/**
 * The fixed strings whose occurrence in a test file marks that test as reaching a changed file by NAME rather
 * than by import — a test that spawns `node scripts/foo.mjs`, or reads `skills-src/x/brief.md` off disk. Pure.
 * The IO shell greps the test files for these and adds the hits to the `vitest related` set. Non-test changed
 * files only (a changed test is selected directly); generic / very short basenames are skipped.
 * @param {string[]} relatedFiles
 * @returns {string[]}
 */
export function referencedTestNeedles(relatedFiles = []) {
  const needles = new Set();
  for (const f of relatedFiles) {
    if (isTestFile(f)) continue;
    const base = f.split('/').pop();
    if (base && base.length >= 6 && !GENERIC_BASENAME.test(base)) needles.add(base);
    for (const root of LOCAL_GLOB_ROOT_NEEDLES) if (f.startsWith(`${root}/`)) needles.add(root);
  }
  return Array.from(needles).sort();
}

// ── the SHADOW FULL-SUITE COMPARE — the FALSE-GREEN signal (round-2) ─────────────────────────────────────────

/**
 * The shadow compare: given a FULL run's failing test files and the set selection WOULD have run, a false-green
 * is a failure OUTSIDE the selected set — a real regression the shrink would have reported GREEN. Pure. This is
 * the test-OUTCOME fact #2680 (durations) cannot produce; it is the evidence the eventual default-on gate reads.
 *
 * `selectedTestFiles` is the set `vitest related` would run for the decided shrink; `failedTestFiles` is the set
 * of test files that FAILED in the full run. `escaped` = failures not covered by the selection. When the decision
 * was FULL (not a shrink), selection ≡ full, so there is trivially no escape — pass `mode` to record that
 * faithfully.
 * @param {{failedTestFiles?: string[], selectedTestFiles?: string[], mode?: 'full'|'shrink'}} args
 * @returns {{falseGreen: boolean, escaped: string[], failedCount: number, selectedCount: number, mode: string}}
 */
export function assessFalseGreen({ failedTestFiles = [], selectedTestFiles = [], mode = 'shrink' } = {}) {
  const failed = Array.from(new Set((failedTestFiles || []).map((f) => normalizePath(f)).filter(Boolean)));
  const selected = new Set((selectedTestFiles || []).map((f) => normalizePath(f)).filter(Boolean));
  // A FULL decision covers everything — no shrink, so no false-green is possible from selection.
  const escaped = mode === 'full' ? [] : failed.filter((f) => !selected.has(f));
  return {
    falseGreen: escaped.length > 0,
    escaped: escaped.sort(),
    failedCount: failed.length,
    selectedCount: selected.size,
    mode,
  };
}

/** Normalize a path for set-membership: strip a leading `./`, collapse backslashes. Pure. */
function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

// ── IO SHELL (CLI only — owns git / fs / clock) ──────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // scripts/readiness → repo root

/** The false-green evidence sidecar: a GITIGNORED, ephemeral "small signal, not a durable store" — the same
 *  `.conveyor/` sidecar convention as the #2680 dispatch log. Env-overridable for tests / alternate runs. */
export const FALSE_GREEN_LOG_PATH = process.env.WE_FALSE_GREEN_LOG || join(ROOT, '.conveyor', 'false-green-log.json');

/** Real git runner for the CLI edge — `git <args>` from the repo root, trimmed stdout. */
function realGit(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Read + JSON-parse a file, or return `fallback` (never throws — a missing/corrupt file is a soft miss). */
function readJsonFile(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) ?? fallback; } catch { return fallback; }
}

/**
 * Append one false-green sample to the sidecar (atomic tmp+rename), returning the updated row array. The row is
 * the {@link assessFalseGreen} result plus an `at` ISO stamp and the decided `changedCount`/`humanRequired`. This
 * is the measure-mode recorder — the rate over rows is the evidence the default-on decision reads.
 * @param {object} sample the row to append (already scrubbed of anything but generalized signal)
 * @param {string} [path] override the sidecar path (default {@link FALSE_GREEN_LOG_PATH})
 * @returns {object[]} the full row array after the append
 */
export function recordFalseGreen(sample, path = FALSE_GREEN_LOG_PATH) {
  const rows = readJsonFile(path, []);
  const list = Array.isArray(rows) ? rows : Array.isArray(rows?.rows) ? rows.rows : [];
  list.push(sample);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  renameSync(tmp, path);
  return list;
}

/** Hand-rolled `--k=v` / `--k` flag parsing (mirrors the readiness-module convention). */
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

/** Every test-file name in a vitest `--reporter=json` output object (pass OR fail). Tolerant of shape drift. */
function allFilesFromVitestJson(report) {
  if (!report || !Array.isArray(report.testResults)) return [];
  return report.testResults.filter((f) => f.name).map((f) => normalizePath(String(f.name).replace(`${ROOT}/`, '')));
}

/** The FAILING test-file list from a vitest `--reporter=json` output object. Tolerant of shape drift. */
function failedFilesFromVitestJson(report) {
  if (!report || !Array.isArray(report.testResults)) return [];
  const out = [];
  for (const f of report.testResults) {
    const status = f.status || (Array.isArray(f.assertionResults) && f.assertionResults.some((a) => a.status === 'failed') ? 'failed' : 'passed');
    if (status === 'failed' && f.name) out.push(normalizePath(String(f.name).replace(`${ROOT}/`, '')));
  }
  return out;
}

/**
 * The TRUE selected TEST-file set: the test files `vitest related <changedFiles>` actually resolves off the
 * static module graph. Runs vitest in the CLI edge (measure-only) into a temp json report and reads its file
 * list. Returns `null` on any failure so the caller can fall back to the (conservatively-biased) changed-file
 * approximation rather than silently mis-measure. Measure-mode only — never on the hot path.
 */
function vitestRelatedSelectedFiles(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return [];
  const out = join(ROOT, '.conveyor', `related-${process.pid}.json`);
  try {
    mkdirSync(dirname(out), { recursive: true });
    // `vitest related` maps changed SOURCE files → the test files that import them (the module-graph walk).
    // xaipsbs — a real vitest run, so it waits for a slot in the host admission pool.
    const admitted = admittedArgv('npx', ['vitest', 'related', ...changedFiles, '--run', '--reporter=json', `--outputFile=${out}`]);
    execFileSync(admitted.file, admitted.args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* a non-zero exit (e.g. a related test failed) still writes the report — read it below */ }
  const report = readJsonFile(out, null);
  try { rmSync(out, { force: true }); } catch { /* best-effort cleanup */ }
  return report ? allFilesFromVitestJson(report) : null;
}

function runCli(argv) {
  const flags = parseFlags(argv);
  const base = typeof flags.base === 'string' ? flags.base : 'origin/main';
  const decision = selectTests({ base, runGit: realGit, env: process.env });

  // --measure: run the shadow compare against a FULL-run vitest json report and record the false-green sample.
  // A false-green = a full-suite FAILURE that falls OUTSIDE what `vitest related` on the diff would have run.
  if (flags.measure) {
    const report = typeof flags['vitest-json'] === 'string' ? readJsonFile(flags['vitest-json'], null) : null;
    const failedTestFiles = failedFilesFromVitestJson(report);
    // The TRUE selected set is the TEST files `vitest related <changedFiles>` resolves — not the changed source
    // files. Prefer a caller-supplied `--selected-json` (a vitest-related report), else compute it here, else
    // fall back to the changed-file approximation (conservatively biased — it over-reports escapes, never under)
    // and flag it `approx`. Only meaningful for a SHRINK decision; a FULL decision covers everything (no escape).
    let selectedTestFiles = [];
    let approx = false;
    if (decision.mode === 'shrink') {
      const selReport = typeof flags['selected-json'] === 'string' ? readJsonFile(flags['selected-json'], null) : null;
      if (selReport) selectedTestFiles = allFilesFromVitestJson(selReport);
      else {
        const computed = flags['no-related'] ? null : vitestRelatedSelectedFiles(decision.selectedFiles);
        if (computed) selectedTestFiles = computed;
        else { selectedTestFiles = decision.selectedFiles; approx = true; }
      }
    }
    const fg = assessFalseGreen({ failedTestFiles, selectedTestFiles, mode: decision.mode });
    const sample = {
      at: new Date().toISOString(),
      mode: decision.mode,
      humanRequired: decision.humanRequired,
      changedCount: Array.isArray(decision.changedFiles) ? decision.changedFiles.length : null,
      selectedCount: fg.selectedCount,
      failedCount: fg.failedCount,
      falseGreen: fg.falseGreen,
      escaped: fg.escaped,
      hadReport: report != null,
      approx, // true ⇒ selectedTestFiles is the changed-file approximation, not the real `vitest related` set
    };
    recordFalseGreen(sample);
    writeAllSync(1, JSON.stringify({ decision, falseGreen: fg, recorded: sample }, null, 2) + '\n');
    process.exit(0);
  }

  // --decide (default): print the decision as JSON (CI / callers consume this).
  process.stdout.write(JSON.stringify(decision, null, 2) + '\n');
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) runCli(process.argv.slice(2));
