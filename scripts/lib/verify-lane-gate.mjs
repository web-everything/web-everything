/**
 * @file scripts/lib/verify-lane-gate.mjs
 * @description The pure decision core for `verify-lane.mjs`'s DEFAULT gate command (#3372).
 *
 * WHY. `verify-lane.mjs`'s default gate used to be a bare `npm run test:unit && npm run check:standards` —
 * unaware that diff-driven test selection (`scripts/readiness/test-selection.mjs`, #2681, under #2612) already
 * exists and is proven safe by its own deny-by-default allow-list. Under N concurrent lanes, N unscoped full-suite
 * runs compete for one local host — the resource-contention bottleneck this item exists to fix.
 *
 * WHY DEFAULTING THE SHRINK HERE DOES NOT VIOLATE #2681's "NOT DEFAULTED" DoD. `test-selection.mjs`'s own DoD
 * reads: "Flag-gated; not defaulted until the measured false-green rate is acceptable and a red-main recovery
 * path exists." That DoD governs defaulting the shrink onto the AUTHORITATIVE pre-merge gate: CI's required
 * `test`/`test-shard` jobs in `.github/workflows/ci.yml`, which still run the FULL, unshrunk, sharded suite
 * unconditionally — they never read `WE_DIFF_TEST_SELECTION` (only the separate, off-by-default
 * `test-selection-measure` evidence-gathering job does, and its own result gates nothing). `verify-lane.mjs` is
 * NOT that gate: per its own header it is a LOCAL, PRE-CI sanity check (#2833 — "run the suites synchronously so
 * a subagent can't background them and yield"). `pr-land.mjs` / the drain still wait for and require CI's real
 * full-suite check before merging — see `scripts/lib/lane-verify.mjs`'s own docs: "the required GitHub `test`
 * check — a red tree also fails it." So a false-green from this LOCAL shrink costs, at worst, a wasted local
 * round-trip (a lane that looked locally green bounces at the real CI gate) — never a merged regression. That is
 * a materially different, and much smaller, risk than the "post-land red under the sole writer" scenario
 * #2681/#3361 (still open, dispatch-freeze dormant) exists to guard against.
 *
 * LOCAL POLICY (fix-3311). Shared helper/fixture inputs use the related-test graph plus literal-reference
 * discovery. Broad config/dependency/deletion changes, an unknown/empty diff, opt-out, or an oversized
 * target list return `blocked` with no command. The CLI refuses before recording a request. The local gate
 * never automatically promotes a diff to the full suite; an explicit affected-test gate or CI is required.
 *
 * THE check:standards HALF (#1937/#3395). #1937 (`#gate-on-merged-tree-lane-fast-fail`) already ruled that a
 * lane gate is not the authority for whole-repo/cross-lane invariants — those belong on the merged tree, in CI —
 * and that a lane may run a scoped fast-fail instead. `check-standards.mjs` already has exactly that mode,
 * `--local --files=<list>` (`claimScope.mjs`'s `partitionLocal`): it demotes path-less GLOBAL/RELATIONAL findings
 * and findings on files OUTSIDE the given set to notes — it never skips checking a file that IS in the set. That
 * makes it safe to scope far more broadly than the vitest shrink: scoping check:standards does not risk missing a
 * check on a changed file the way an unsound `vitest related` walk could miss a reverse-dependent test, so it
 * does not need the vitest half's SHRINK_ALLOW_LIST/sensitive-surface gauntlet. It only needs to stay unscoped
 * for the two surfaces that gauntlet can't help with anyway:
 *   - `backlog/` — the stranded-hash false-red symptom (#3368's landing) reads `origin/main` directly, independent
 *     of the lane's own diff; a lane that itself touches `backlog/` keeps the unscoped run as an extra margin.
 *   - a gate-self/policy-core path (`isGateSelfPath`/`isPolicyCorePath`, `gate-config.mjs`) — the gate's own
 *     trust chain must always see the unscoped whole-repo signal on a change to itself.
 * See {@link canScopeCheckStandards}.
 *
 * `resolveDefaultGate` uses a cached settings file by default; inject fileConfig for pure tests. It takes an injectable `runGit` (mirroring
 * `test-selection.mjs`'s own convention) so tests drive it deterministically.
 *
 * PER-REPO SCRIPTS (#3919). The gate halves above name WE's own npm scripts (`test:unit`, `check:standards`), but
 * `verify-lane.mjs --repo=` also verifies sibling checkouts (plateau-app, frontierui). plateau-app has neither
 * script (its suite is `"test": "vitest run"`), so the WE-shaped gate always failed there with "Missing script".
 * The IO shell now injects the target checkout's npm script NAMES (`scripts`, read from its package.json) and
 * {@link composeGate} builds only the halves that checkout actually has:
 *   - vitest half: `test:unit` present ⇒ today's logic, unchanged (diff-driven shrink or `npm run test:unit`);
 *     absent but `test` present ⇒ `npm test` (full — the shrink's allow-list is WE-shaped, so it is never applied
 *     to a checkout without WE's `test:unit` convention); neither ⇒ skipped, with an explicit reason.
 *   - check:standards half: included (scoped exactly as before) only when the checkout has `check:standards`.
 * `scripts` omitted/unknown ⇒ assumed WE-shaped, so a WE checkout's command is byte-for-byte unchanged. frontierui
 * has both `test:unit` and `check:standards`, so it too gets today's gate unchanged.
 */
import { loadVerifySettingsFile, resolveVerifySettings } from './verify-settings.mjs';

import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { SELECTION_FLAG, pinnedMergeBase, decideLocalSelection, referencedTestNeedles, LOCAL_FULL_SUITE_TRIGGERS } from '../readiness/test-selection.mjs';
import { isPolicyCorePath } from './gate-config.mjs';
import { isAllowlistedLitterPath } from './lane-litter.mjs';
import { queueLaneOf } from '../readiness/heavy-queue-projection.mjs';
import { scanCommands } from './repo-scan-tests.mjs';
import { buildReverseImportGraph, selectRelatedTests } from './related-test-selection.mjs';

const defaultFileConfig = loadVerifySettingsFile();

/** The pathspecs `testsNaming` greps — every vitest test-file suffix (PR #2680 review: one list, pinned by a test). */
export const VITEST_TEST_PATHSPECS = Object.freeze(['*.test.ts', '*.test.tsx', '*.test.js', '*.test.jsx', '*.test.mjs', '*.test.cjs', '*.test.mts', '*.test.cts']);

/** Local discovery policy, resolved from environment, file, then safe built-ins. */
export function verifyRelatedMode(env, fileConfig = defaultFileConfig) {
  return resolveVerifySettings({ fileConfig, env }).values.relatedMode;
}

/** Vitest's own default per-test and per-hook timeouts, the base the local factor scales. */
export const VITEST_BASE_TIMEOUTS = Object.freeze({ testTimeout: 5_000, hookTimeout: 10_000 });

/** LOCAL-only timeout multiplier (`WE_VERIFY_TEST_TIMEOUT_FACTOR`, default 3; 1 = vitest defaults). CI never reads it. */
export function verifyTestTimeoutFactor(env, fileConfig = defaultFileConfig) {
  return resolveVerifySettings({ fileConfig, env }).values.testTimeoutFactor;
}

/** The vitest flags for a factor: none at 1, so factor 1 is byte-identical to today's command. */
export function scaledTimeoutFlags(factor) {
  if (factor === 1) return '';
  const { testTimeout, hookTimeout } = VITEST_BASE_TIMEOUTS;
  return ` --testTimeout=${Math.round(testTimeout * factor)} --hookTimeout=${Math.round(hookTimeout * factor)}`;
}

/** Local target bound: refuse oversized selection; never promote it to a full suite. */
export const MAX_RELATED_TARGETS = 300;

/** The historical, always-safe fallback gate: the full unit suite plus the repo health gate. */
export const FULL_GATE = 'npm run test:unit && npm run check:standards';

/** Script names a WE-shaped checkout is assumed to have when the caller injects none (back-compat default). */
const WE_SCRIPTS = Object.freeze(['test:unit', 'check:standards']);

/**
 * Build the gate command from its two halves, keeping only the halves the checkout's npm scripts support (#3919).
 * Pure. With both WE scripts present the output is exactly `${vitestCmd} && ${checkStandardsCmd}` — today's shape.
 * @param {{vitestCmd: string, checkStandardsCmd: string, scripts?: Iterable<string>|null}} args
 * @returns {{command: string, gateReasons: string[]}}
 */
export function composeGate({ vitestCmd, checkStandardsCmd, scripts, scanCmds = [] }) {
  const have = new Set(scripts == null ? WE_SCRIPTS : scripts);
  const gateReasons = [];
  let testHalf = null;
  if (have.has('test:unit')) testHalf = vitestCmd;
  else if (have.has('test')) {
    testHalf = 'npm test';
    gateReasons.push('no `test:unit` script in this checkout — running `npm test` (full, no diff shrink)');
  } else gateReasons.push('no `test:unit` or `test` script in this checkout — test half skipped');
  let standardsHalf = null;
  if (have.has('check:standards')) standardsHalf = checkStandardsCmd;
  else if (checkStandardsCmd !== null) gateReasons.push('no `check:standards` script in this checkout — health-gate half skipped');
  // #3887 — repo-scanning tests `vitest related` can never select; run after the related half, only where a test half exists.
  const scanHalves = testHalf && have.has('test:unit') ? scanCmds : [];
  const halves = [testHalf, ...scanHalves, standardsHalf].filter(Boolean);
  if (halves.length === 0) {
    return { command: `echo ${shellQuote('verify-lane: no test:unit/test/check:standards npm script in this checkout — nothing to run')}`, gateReasons };
  }
  return { command: halves.join(' && '), gateReasons, testCommand: testHalf, standardsCommand: standardsHalf, scanCommands: scanHalves };
}

/** Single-quote a string for safe inclusion in a shell command (handles an embedded `'`). */
function shellQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

/** Is this repo-relative path under `backlog/` — the stranded-hash false-red surface #1937/#3395 routes around. */
function isBacklogPath(path) {
  return /^backlog\//.test(String(path || ''));
}

/**
 * May the check:standards half of the gate scope to `--local --files=<changedFiles>` (#1937)? Pure. True only
 * when the changed set is KNOWN (not `null` — an unreadable/unknown diff never shrinks) and non-empty, and no
 * changed file is under `backlog/` or is a gate-self/policy-core path (see the file header for why those two,
 * and only those two, keep the fail-safe unscoped run — unlike the vitest half, this scoping does not need the
 * full sensitive-surface gauntlet).
 * @param {string[]|null} changedFiles
 * @returns {boolean}
 */
export function canScopeCheckStandards(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  return !changedFiles.some((f) => isBacklogPath(f) || isPolicyCorePath(f));
}

// #verify-standards-auto — local policy; unknown settings preserve the existing gate.
export function verifyStandardsPolicy(env, fileConfig = defaultFileConfig) {
  return resolveVerifySettings({ fileConfig, env }).values.standards;
}

export const VERIFY_STANDARDS_POLICIES = Object.freeze(['always', 'auto', 'ci-only']);

/** The resolved value of one declared verify setting (environment over the running checkout's file). */
export function verifySetting(key, env, fileConfig = defaultFileConfig) {
  return resolveVerifySettings({ fileConfig, env }).values[key];
}

/** The timeout factor a stamped gate command was composed with (`--testTimeout=N`), or 1 when it carries none. */
export function stampedTimeoutFactor(gate) {
  const match = /--testTimeout=(\d+)(?:\s|$)/.exec(String(gate ?? ''));
  return match ? Number(match[1]) / VITEST_BASE_TIMEOUTS.testTimeout : 1;
}

/**
 * #66 — recognize a dispatched child's `--gate` as the requester's DEFAULT gate even when the requester resolved it
 * under different settings than this child (an older lane base without the settings file, or a session whose env
 * lacks the daemon's `WE_VERIFY_*`). Before this, only the standards policy was varied: a `relatedMode` or timeout
 * factor drift made the stamped command unrecognized, so the run fell back to whole-gate admission
 * (`admissionMode: gate`, `relatedMode: null`) — 16-21 min instead of 3-5 under contention (coroner-2, 2026-10-05).
 *
 * Returns the run plan, or null. The plan keeps the REQUESTER's target selection (relatedMode + timeout factor —
 * the exact vitest and scan commands that were stamped) and this child's own standards policy (the pre-existing
 * rule). Every variant must also have seen the same changed set as `resolved`. Pure over the injected resolver.
 * @param {{gate:string, env:object, resolved:object, resolveUnder:(env:object)=>object, variants?:boolean}} o
 */
export function matchRequestedDefaultGate({ gate, env, resolved, resolveUnder, variants = true }) {
  if (!resolved || typeof gate !== 'string') return null;
  const sameDiff = (variant) => JSON.stringify(variant.decision?.changedFiles) === JSON.stringify(resolved.decision?.changedFiles);
  const ours = { relatedMode: resolved.decision?.relatedMode, factor: resolved.decision?.testTimeoutFactor };
  const relatedModes = variants ? [...new Set([ours.relatedMode, 'all', 'import-only'].filter(Boolean))] : [ours.relatedMode];
  const factors = variants ? [...new Set([ours.factor, stampedTimeoutFactor(gate)].filter((f) => Number.isFinite(f) && f >= 1))] : [ours.factor];
  // #5128 — a requester without the bounded related selection (an older base, or the limit off) stamps plain
  // `vitest related`; the "limit off" variant recognizes it so it keeps phase admission instead of whole-gate.
  const ourLimit = resolved.decision?.selection?.maxTests;
  const limits = variants && ourLimit > 0 ? [null, 0] : [null];
  for (const relatedMode of relatedModes) {
    for (const factor of factors) {
      for (const limit of limits) {
        const selection = { WE_VERIFY_RELATED: relatedMode, WE_VERIFY_TEST_TIMEOUT_FACTOR: String(factor),
          ...(limit === null ? {} : { WE_VERIFY_RELATED_MAX_TESTS: String(limit) }) };
        for (const policy of VERIFY_STANDARDS_POLICIES) {
          let variant;
          try { variant = resolveUnder({ ...env, ...selection, WE_VERIFY_STANDARDS: policy }); } catch { continue; }
          if (variant?.command !== gate || !sameDiff(variant)) continue;
          if (relatedMode === ours.relatedMode && factor === ours.factor && limit === null) return resolved;
          const plan = resolveUnder({ ...env, ...selection });
          return sameDiff(plan) ? plan : null;
        }
      }
    }
  }
  return null;
}

export const STANDARDS_AUTO_PREFIXES =Object.freeze([
  'backlog/', 'docs/', 'config/', 'agent-memory-src/', 'skills-src/', '.claude/',
  '.github/', 'src/', 'blocks/', 'research/', 'site/',
]);

export function standardsRelevantPath(path) {
  return STANDARDS_AUTO_PREFIXES.some(prefix => path.startsWith(prefix))
    || (!path.includes('/') && (path.endsWith('.md') || ['package.json', 'package-lock.json'].includes(path)))
    || isPolicyCorePath(path);
}

export function decideStandardsHalf({ policy, changedFiles }) {
  const scoped = canScopeCheckStandards(changedFiles);
  if (changedFiles?.some(isPolicyCorePath)) {
    return { policy, run: true, scoped: false, reason: 'gate-self/policy-core path — unscoped run kept' };
  }
  if (policy === 'ci-only') {
    return { policy, run: false, scoped: false, reason: 'skipped (ci-only: CI runs check:standards)' };
  }
  if (policy === 'auto') {
    if (!changedFiles?.length) return { policy, run: true, scoped: false, reason: 'auto: diff unknown — run kept' };
    const relevant = changedFiles.find(standardsRelevantPath);
    return relevant
      ? { policy, run: true, scoped, reason: `auto: standards-relevant path ${relevant}` }
      : { policy, run: false, scoped: false, reason: 'skipped (auto: code-only diff)' };
  }
  return { policy, run: true, scoped,
    reason: 'always' + (scoped ? '' : '; unscoped: backlog/ or gate-self/policy-core path or unknown diff') };
}

// #verify-phase-admission — only existing queue kinds determine fast/slow routing.
export function verifyPhaseAdmissionEnabled(env, fileConfig = defaultFileConfig) {
  return resolveVerifySettings({ fileConfig, env }).values.phaseAdmission;
}

export function verifyFastTargets(env, fileConfig = defaultFileConfig) {
  return resolveVerifySettings({ fileConfig, env }).values.fastTargets;
}

export function phaseAdmissionKind({ phase, decision, standardsScoped, env, fileConfig = defaultFileConfig }) {
  let kind = 'other';
  if (phase === 'scan' || (phase === 'vitest' && decision?.targets?.length <= verifyFastTargets(env, fileConfig))) kind = 'files';
  if (phase === 'standards' && standardsScoped) kind = 'standards';
  return { kind, lane: queueLaneOf(kind) };
}

/**
 * Decide verify-lane's DEFAULT gate command from the actual diff against `base` (default `origin/main`).
 *   - the VITEST half: graph/reference selection, including shared helpers; at most 300 targets and
 *     32000 UTF-8 bytes. Unsafe or oversized selections are blocked with no runnable command.
 *   - the check:standards half: scoped to `--local --files=<changedFiles>` whenever
 *     {@link canScopeCheckStandards} allows it (#1937) — independently of the vitest half's mode, since it is a
 *     separately-safe, already-ratified mechanism, not gated behind the vitest shrink's not-yet-defaulted flag.
 * Selection is mandatory for the default local gate; opt-out requests require an explicit gate.
 * `scripts` (#3919): the target checkout's npm script names; omitted ⇒ WE-shaped (unchanged). See {@link composeGate}.
 * @param {{base?: string, runGit: (args:string[]) => string, env?: Record<string,string|undefined>, scripts?: Iterable<string>|null, fileExists?: (repoRelativePath: string) => boolean}} args
 * @returns {{ command: string, gateReasons: string[], decision: import('../readiness/test-selection.mjs').SelectionDecision & {changedFiles: string[]|null} }}
 */
export function resolveDefaultGate({ base = 'origin/main', runGit, env = process.env, scripts, fileExists, readRepoFile, fileConfig = defaultFileConfig } = {}) {
  // xpnhz4o — the changed set is the WORKING TREE against the pinned merge-base (tracked edits, staged or not,
  // plus untracked files), not HEAD's committed diff. The gate runs against the working tree, so that is the set
  // it must key on — and a fixer runs the gate BEFORE committing, which under the old "dirty ⇒ full" rule (#3389)
  // meant every fixer gate was a full-suite run.
  const { values: settings, sources: settingsSource } = resolveVerifySettings({ fileConfig, env });
  const { relatedMode, testTimeoutFactor } = settings;
  const timeoutFlags = scaledTimeoutFlags(testTimeoutFactor);
  const diff = localChangedSet({ base, runGit });
  const changedFiles = diff ? diff.changedFiles : null;
  const standards = decideStandardsHalf({ policy: settings.standards, changedFiles });
  const optOut = String(env?.[SELECTION_FLAG] ?? '') === '0';
  // #4540: only untracked allowlist matches are scratch; tracked names remain real inputs.
  // Keep the original diff for standards scoping and diagnostics.
  const untracked = new Set(diff?.untrackedFiles ?? []);
  const keepForVitest = (path) => !untracked.has(path) || !isAllowlistedLitterPath(path);
  const vitestChangedFiles = changedFiles?.filter(keepForVitest) ?? null;
  const vitestDeletedFiles = (diff?.deletedFiles ?? []).filter(keepForVitest);
  const scratchOnly = !optOut && changedFiles?.length > 0 && vitestChangedFiles.length === 0;
  let local = scratchOnly
    ? { mode: 'shrink', relatedFiles: [], triggerFiles: [], deletedSourceFiles: [], reasons: ['untracked lane scratch only — no Vitest targets remain'] }
    : decideLocalSelection({ changedFiles: vitestChangedFiles, deletedFiles: vitestDeletedFiles, optOut });

  // Shared helpers are ordinary graph inputs locally; literal references supplement dynamic reads.
  // CI still owns exhaustive coverage. A broad/unknown selection must never silently launch a full suite.
  if (local.mode === 'full' && !optOut && local.triggerFiles.length && !local.deletedSourceFiles.length
      && local.triggerFiles.every((f) => !LOCAL_FULL_SUITE_TRIGGERS.some((re) => re.test(f)))) {
    const ordinary = decideLocalSelection({
      changedFiles: vitestChangedFiles.filter((f) => !local.triggerFiles.includes(f)),
      deletedFiles: vitestDeletedFiles,
    });
    local = { ...local, mode: 'shrink',
      relatedFiles: [...new Set([...ordinary.relatedFiles, ...local.triggerFiles])].sort(),
      reasons: ['shared helpers/fixtures use the related-test graph plus reference discovery locally; CI owns exhaustive coverage'],
    };
  }
  const blocked = (reasons, extra = {}) => ({ command: null, gateReasons: [], decision: {
    ...local, mode: 'blocked', reasons, changedFiles, standards, settingsSource, relatedMode, referencedTests: [], targets: [], ...extra,
  } });
  if (local.mode === 'full') return blocked([
    ...local.reasons.map((r) => r.replaceAll('full suite', 'broad selection')),
    'No local full suite: supply an explicit affected-test --gate or use CI for exhaustive verification.',
  ]);

  // #1937: scope only the local, non-authoritative fast-fail — the central, unscoped check:standards CI runs
  // against the real merged tree remains the actual authority and is untouched by this local shrink.
  const checkStandardsCmd = !standards.run ? null : standards.scoped
    ? `npm run check:standards -- --local --files=${shellQuote(changedFiles.join(','))}`
    : 'npm run check:standards';

  if (local.mode === 'shrink') {
    const referencedTests = relatedMode === 'import-only' ? [] : testsNaming(referencedTestNeedles(local.relatedFiles), runGit);
    const targets = Array.from(new Set([...local.relatedFiles, ...referencedTests])).sort();
    if (targets.length > MAX_RELATED_TARGETS || Buffer.byteLength(targets.join(' '), 'utf8') > 32_000) {
      return blocked([`${targets.length} selection targets (limit ${MAX_RELATED_TARGETS}, 32000 bytes) — narrow the diff/base or supply an explicit affected-test --gate; no local full suite`], { referencedTests, targets });
    }
    // #5128 — a hub module can reach hundreds of tests through `vitest related`'s unbounded walk. Over the limit,
    // run the bounded list (direct importers always kept) and mark the run `selection-truncated`.
    const selection = relatedSelection({ targets, runGit, readRepoFile, settings });
    const decision = { ...local, changedFiles, standards, settingsSource, relatedMode, testTimeoutFactor, referencedTests, targets,
      ...(selection ? { selection } : {}) };
    // `--passWithNoTests`: a diff whose files no test reaches (docs, a backlog card) is a pass, not a failure.
    // Deletions or excluded untracked scratch can leave no target, and `vitest related` with no
    // positional file is an error (a false red); there is nothing for vitest to run, so say so and skip it.
    const vitestCmd = selection?.status === 'selection-truncated'
      ? `npx vitest run ${selection.tests.map(shellQuote).join(' ')} --passWithNoTests${timeoutFlags}`
      : targets.length
      ? `npx vitest related ${targets.map(shellQuote).join(' ')} --run --passWithNoTests${timeoutFlags}`
      : `echo ${shellQuote('verify-lane: no remaining changed file for vitest to relate — vitest half skipped (deletions or excluded untracked scratch)')}`;
    // #3887 — `vitest related` selects tests that IMPORT a changed file; a repo-SCANNING test reads files from disk and
    // imports nothing, so it was never selected. Run the marked scanners scoped to the changed files (cost ~ the number
    // of changed files, never the whole repo); see scripts/lib/repo-scan-tests.mjs. Scanner reach is the full changed
    // set (including scratch-excluded untracked files — a new file with a violation is exactly the case to catch).
    // `fileExists` is injected by the IO shell (this checkout's own files); omitted ⇒ no scan half, so a fixture or a
    // sibling checkout without these tests never gets a command naming a test it does not have.
    const scanCmds = typeof fileExists === 'function' ? scanCommands({ changedFiles, fileExists }).map((c) => c + timeoutFlags) : [];
    const composed = composeGate({ vitestCmd, checkStandardsCmd, scripts, scanCmds });
    if (!standards.run) composed.gateReasons.push(standards.reason);
    return { ...composed, decision };
  }
  throw new Error(`unexpected local selection mode: ${local.mode}`);
}

const graphCache = new WeakMap();

/**
 * #5128 — the bounded related-test selection, or null when it does not apply (limit off, no reader injected, no
 * target, or git/graph trouble — null keeps the plain `vitest related` gate, the pre-#5128 behaviour). The graph is
 * cached per injected reader, so the #66 variant matching re-resolves cheaply. A truncated list that is empty or too
 * long for one command line also falls back to `vitest related`.
 */
function relatedSelection({ targets, runGit, readRepoFile, settings }) {
  if (typeof readRepoFile !== 'function' || !(settings.relatedMaxTests > 0) || !targets.length) return null;
  try {
    let reverse = graphCache.get(readRepoFile);
    if (!reverse) {
      const files = String(runGit(['ls-files', '--cached', '--others', '--exclude-standard'])).split('\n').map((f) => f.trim()).filter(Boolean);
      reverse = buildReverseImportGraph({ files, readFile: readRepoFile });
      graphCache.set(readRepoFile, reverse);
    }
    const selection = selectRelatedTests({ changedFiles: targets, reverse, maxTests: settings.relatedMaxTests,
      maxDepth: settings.relatedDepth });
    if (selection.status === 'selection-truncated'
      && (!selection.tests.length || Buffer.byteLength(selection.tests.join(' '), 'utf8') > 32_000)) {
      return { ...selection, status: 'complete', tests: null, reason: `${selection.reason}; list unusable — kept vitest related` };
    }
    return selection;
  } catch {
    return null;
  }
}

/**
 * The working-tree changed set against the pinned merge-base: `{changedFiles, deletedFiles, untrackedFiles}`, or `null` when git
 * cannot answer (the caller then runs the full suite). Pure given `runGit`.
 * @param {{base: string, runGit: (args: string[]) => string}} args
 * @returns {{changedFiles: string[], deletedFiles: string[], untrackedFiles: string[]}|null}
 */
export function localChangedSet({ base = 'origin/main', runGit }) {
  const mergeBase = pinnedMergeBase({ base, runGit });
  if (!mergeBase) return null;
  const lines = (out) => String(out).split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    const tracked = lines(runGit(['diff', '--name-only', mergeBase]));
    const deletedFiles = lines(runGit(['diff', '--name-only', '--diff-filter=D', mergeBase]));
    const untracked = lines(runGit(['ls-files', '--others', '--exclude-standard']));
    return { changedFiles: Array.from(new Set([...tracked, ...untracked])).sort(), deletedFiles, untrackedFiles: untracked };
  } catch {
    return null;
  }
}

/**
 * #4473 — a content hash of the CURRENT working tree against the pinned merge-base: the same "what will the
 * gate actually see" input {@link localChangedSet} derives (tracked diff, staged or not, plus untracked files),
 * but content-addressed rather than just a file list, so two calls with byte-identical tracked+untracked content
 * hash the SAME — even across separate process invocations (`request` then `request` again with no edit in
 * between), which is exactly what a file-list-only key cannot tell apart from "the same files, edited again".
 *
 * WHY THIS EXISTS. `verify-lane.mjs`'s marker is keyed only to `headSha` (the commit) — but a worker iterating
 * with UNCOMMITTED edits never moves `headSha` at all, while the gate's own inputs (`resolveDefaultGate` /
 * {@link localChangedSet}) are keyed off the WORKING TREE, not the commit. Before this, `request`/bare `verify`
 * unconditionally discarded any existing terminal record and started a fresh `running` marker on every call,
 * which `verify-dispatch.mjs` then re-ran to completion — the exact "same lane+sha verified repeatedly" waste
 * this item's transcript evidence measured. A content hash lets the caller tell "truly unchanged since the last
 * terminal record" (safe to answer from cache) apart from "same commit, but the tree moved since" (must re-run) —
 * a same-`headSha` check ALONE cannot make that distinction and would risk a false green.
 *
 * Returns `null` when git cannot answer (no computable merge-base, or a git failure) — the caller MUST treat
 * `null` as unknown, never as a fixed/comparable value (fail closed, same posture as {@link localChangedSet}).
 *
 * `fileMode` (PR #2982 review) reads an untracked path's `lstat` mode. The tracked diff already carries mode
 * changes (`old mode`/`new mode`), but `git hash-object` is content-only, so an untracked executable that loses
 * its execute bit would otherwise hash identically while the gate running it now fails. Omitted ⇒ `null` (fail
 * closed) whenever there is an untracked file, so a caller can never silently get a mode-blind key.
 * @param {{base?: string, runGit: (args: string[]) => string, fileMode?: (path: string) => number}} args
 * @returns {string|null}
 */
export function computeWorkingTreeHash({ base = 'origin/main', runGit, fileMode }) {
  const mergeBase = pinnedMergeBase({ base, runGit });
  if (!mergeBase) return null;
  try {
    // The tracked diff (staged + unstaged) against the merge-base — the same shape `localChangedSet`'s
    // `tracked` derives, but the full patch text (content), not just names.
    const trackedDiff = runGit(['diff', mergeBase, '--']);
    // `-z`: NUL-separated and never C-quoted, so a non-ASCII / newline-bearing path reaches `hash-object` as the
    // real filename instead of a quoted string it cannot find (which used to fail the whole hash closed).
    const untracked = String(runGit(['ls-files', '-z', '--others', '--exclude-standard']))
      .split('\0').filter(Boolean).sort();
    if (untracked.length && typeof fileMode !== 'function') return null;
    // Each untracked file's OWN content hash (`git hash-object`, deterministic and reads the file itself) plus
    // its file type + full permission bits (any x bit alone would miss 755 → 655, which the owner can no longer
    // execute) — never mtime/size, which can change with no content change and hash-flap.
    const untrackedDigest = untracked
      .map((f) => `${f}:${(fileMode(f) & 0o177777).toString(8)}:${String(runGit(['hash-object', '--', f])).trim()}`)
      .join('\n');
    return createHash('sha256').update(trackedDiff).update('\u0000').update(untrackedDigest).digest('hex');
  } catch {
    return null;
  }
}

/**
 * #4473 (PR #2982 round-2 review) — the tree hash a finished run may record: the start-of-run hash, but only when
 * every later sample (just before the gate ran, just after it exited) still equals it. A worker editing during
 * the admission wait or the gate itself means the gate saw a different tree than the one hashed at start, so the
 * run's result must not be cacheable for either — `null`, which never matches (fail closed). Known limit: an edit
 * made AND reverted entirely between two samples is invisible to sampling; this narrows the window, it cannot
 * close it.
 * @param {...(string|null|undefined)} samples - the tree hashes in the order they were taken
 * @returns {string|null}
 */
export function stableTreeHash(...samples) {
  if (!samples.length || samples.some((h) => typeof h !== 'string' || !h)) return null;
  return samples.every((h) => h === samples[0]) ? samples[0] : null;
}

/** A full or abbreviated hex commit sha — never a ref name, a flag-shaped string, or anything else `git diff`
 *  could misread as an option. `recordSha` comes off the `.lane-verify` marker (JSON on disk, not literally
 *  attacker input, but not a value this function itself produced either); validating its SHAPE before it ever
 *  reaches a revision-argument position is cheap and removes the question entirely. */
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * #4296 — of the files that changed between a lane-verify marker's RECORDED sha and the `headSha` about to land,
 * which are still LANE-RELEVANT — i.e. part of THIS lane's own diff against `base` (default `origin/main`) either
 * as of the record OR as of `headSha`? Pure given `runGit`.
 *
 * WHY THIS IS THE RIGHT KEY. Today's finish-guard (`verifyGateDecision` in `lane-verify.mjs`) keys a marker's
 * validity to an EXACT sha match, so any new commit — including a no-op merge of `base` that conflicts only on a
 * file the lane itself never touches — invalidates a green marker and forces a full re-run (the evidence in this
 * item: a mid-work merge that conflicted solely on `ci-heal-pr-dispatch.mjs`, outside the lane's own touch-set).
 * The fix reuses the SAME "what does this lane actually touch" shape `resolveDefaultGate`/{@link localChangedSet}
 * already derive for gate selection — a diff against `base` — as the validity key, instead of the raw commit
 * identity: a marker recorded for an EARLIER sha still covers `headSha` when the overlap here is empty.
 *
 * WHY RECOMPUTING THE RELEVANT SET FRESH (never reusing whatever set the recorded run itself saw) is what makes
 * a no-op merge of `base` safe, with no special-casing for "was this a merge": after merging `base` forward, a
 * file `base` alone changed — one the lane never touches — is now IDENTICAL between `headSha` and the
 * (also-advanced) `base`, so a fresh diff against `base` no longer lists it at all. A file the lane genuinely
 * edited stays in the relevant set no matter how it arrived (a direct edit, brought back by a merge, whatever).
 *
 * WHY THE RELEVANT SET IS THE UNION OF "relevant at `recordSha`" AND "relevant at `headSha`" — NOT `headSha`
 * alone. Filtering only against `diff(base, headSha)` misses the case where the LANE ITSELF reverts one of its
 * own already-verified edits (undoes a change, or a later commit deletes a file back to `base`'s content) while
 * another lane edit remains: the reverted file is real changedSinceRecord (its content differs between
 * `recordSha` and `headSha`), but once reverted it is IDENTICAL to `base` again, so a `headSha`-only relevant set
 * silently drops it — carrying the old green forward onto a tree whose revert was never verified. Folding in
 * `diff(base, recordSha)` too closes this: a file relevant at EITHER end stays relevant, whichever side of the
 * revert `headSha` lands on — which is why this function takes TWO merge-base calls, not one.
 *
 * ACCEPTED LIMITATION (deliberately not closed here). "Lane-relevant" means "in the lane's own diff vs `base`" —
 * the SAME proxy `resolveDefaultGate` already uses for gate SELECTION, per this item's own instruction to reuse
 * it. It does not follow the import/dependency graph: a merge that changes a file the lane never touched but the
 * lane's OWN files import (or otherwise depend on) carries the old green forward even though that upstream
 * file's new content was never locally verified — a real LOOSENING of the local gate versus the pre-#4296
 * exact-sha check, which forced a re-verify on ANY new commit including this one. What keeps this safe to ship
 * is that the required CI `test` check independently runs the FULL suite on the PR regardless of this local
 * marker (the same backstop `resolveDefaultGate`'s own diff-driven test shrink already leans on, per this file's
 * header) — never a claim that the pre-#4296 base was "no safer": it was, for this one local signal. Closing the
 * gap fully means intersecting with `resolveDefaultGate`'s own `referencedTests`/`targets` (which follow
 * `vitest related`'s import graph) rather than only `changedFiles` — left for a follow-up, since that graph walk
 * is exactly the same "reachable from what changed" shape this function already reuses, and widening it is a
 * genuine feature, not a fix.
 *
 * @param {{recordSha: string|null|undefined, headSha: string|null|undefined, base?: string,
 *   runGit: (args: string[]) => string}} args
 * @returns {string[]|null} the overlap — empty means the marker still covers `headSha`. `null` means git could
 *   not answer (an unreadable ref, `recordSha` unreachable, no computable merge-base) — the caller MUST treat
 *   `null` as unknown, never as "no overlap" (fail closed, same posture as {@link localChangedSet}'s `null`).
 *   CONTRACT ON `runGit`: this function fails closed ONLY if a git failure actually THROWS — exactly the same
 *   contract {@link localChangedSet} and {@link pinnedMergeBase} in this same file already rely on. A `runGit`
 *   that swallows a failure into an empty string (a `tryGit`-shaped helper) would read "recordSha unreachable"
 *   as "nothing changed" and fail OPEN. Both real callers (`we:scripts/verify-lane.mjs`'s `git`,
 *   `we:scripts/pr-land.mjs`'s `gitC`) are bare `execFileSync` wrappers that throw on a non-zero exit — never
 *   their `tryGit` siblings, which is exactly what makes this safe; this is a contract on the caller, not
 *   something this function can enforce from inside itself without another git call.
 */
export function laneRelevantChangeSince({ recordSha, headSha, base = 'origin/main', runGit }) {
  if (!recordSha || !headSha) return null;
  if (recordSha === headSha) return [];
  if (!HEX_SHA_RE.test(recordSha) || !HEX_SHA_RE.test(headSha)) return null;
  const lines = (out) => Array.from(new Set(String(out).split('\n').map((s) => s.trim()).filter(Boolean))).sort();
  const relevantAgainstBase = (sha) => {
    // Pinned explicitly to `sha`, NEVER the literal `HEAD` {@link pinnedMergeBase} uses — a caller may verify a
    // `headSha` that is not (or is no longer) this checkout's actual current HEAD (e.g. an explicit `--sha=`).
    const mergeBase = String(runGit(['merge-base', base, sha])).trim() || null;
    if (!mergeBase) return null;
    return lines(runGit(['diff', '--name-only', mergeBase, sha, '--']));
  };
  try {
    // The trailing `--` separates the two revisions from a pathspec (there is none) so a validly-hex-shaped but
    // still-unexpected value can never be read as a path or a further option either.
    const changedSinceRecord = lines(runGit(['diff', '--name-only', recordSha, headSha, '--']));
    if (changedSinceRecord.length === 0) return [];
    // The UNION of "relevant at record time" and "relevant at headSha" — see the header doc above for why
    // `headSha` alone misses a lane-side revert of its own already-verified work.
    const relevantAtHead = relevantAgainstBase(headSha);
    if (!relevantAtHead) return null;
    const relevantAtRecord = relevantAgainstBase(recordSha);
    if (!relevantAtRecord) return null;
    const stillRelevant = new Set([...relevantAtHead, ...relevantAtRecord]);
    return changedSinceRecord.filter((f) => stillRelevant.has(f));
  } catch {
    return null;
  }
}

/**
 * #4296 (converge round 1, simplicity juror) — the ONE guard for "is there even a stale-sha record worth
 * computing an overlap for", so `we:scripts/verify-lane.mjs` (both the bare `check` path and the `check --wait=`
 * resolver) and `we:scripts/pr-land.mjs`'s finish-guard share ONE implementation instead of three independent
 * copies of the same `record && !record.corrupt && record.sha && record.sha !== headSha` condition — the drift
 * risk the finding named: a future change to what counts as a comparable record only has to land here. Pure
 * given `runGit`; wraps {@link laneRelevantChangeSince}.
 * @param {{record: object|null, headSha: string|null|undefined, base?: string, runGit: (args: string[]) => string}} args
 * @returns {string[]|null|undefined} `undefined` when there is nothing to compute (no record, a corrupt one, no
 *   recorded sha, or an exact match — {@link laneRelevantChangeSince} already short-circuits an exact match to
 *   `[]`, but skipping the call entirely here also skips the pointless git IO). Otherwise {@link laneRelevantChangeSince}'s own `string[]|null`.
 */
export function laneRelevantChangeSinceForRecord({ record, headSha, base = 'origin/main', runGit }) {
  if (!record || record.corrupt || !record.sha || record.sha === headSha) return undefined;
  return laneRelevantChangeSince({ recordSha: record.sha, headSha, base, runGit });
}

/** The vitest test files that contain any of `needles` as a fixed string (`git grep -l -F`). `git grep` exits 1
 *  on no match, which `runGit` surfaces as a throw — that is "no referencing tests", not an error. Pure given
 *  `runGit`. */
export function testsNaming(needles, runGit) {
  if (!needles.length) return [];
  const args = ['grep', '-l', '-F'];
  for (const n of needles) args.push('-e', n);
  // Every vitest test-file suffix (`*.test.*`, incl. jsx/cts). `*.spec.*` is deliberately absent: in this
  // constellation `.spec.*` files are Playwright specs, which vitest's own `include` never runs.
  args.push('--', ...VITEST_TEST_PATHSPECS);
  try {
    return String(runGit(args)).split('\n').map((s) => s.trim()).filter(Boolean).sort();
  } catch {
    return [];
  }
}

const VITEST_SEGMENT = /^(?:npx\s+)?vitest\s+(related|run)(?=\s|$)/;
/** The whole-suite test commands, exactly — `npm test` is what `composeGate` emits for a sibling repo with no `test:unit`. */
const FULL_TEST_SEGMENT = /^npm\s+(?:run\s+test:unit|test)$/;
const CHECK_STANDARDS_SEGMENT = /^npm\s+run\s+check:standards(?=\s|$)/;
/** The only vitest flags an explicit gate may carry. Anything else can silence or redirect the run:
 *  `--passWithNoTests`, `--config`/`--root`/`--dir` (point at other code), `--reporter` (arbitrary module),
 *  `--exclude`, `-t`/`--testNamePattern` (select zero tests). */
const ALLOWED_VITEST_FLAG = /^--(?:run|bail(?:=\d+)?)$/;

/**
 * When the DEFAULT local selection is blocked (config / dependency / unknown / oversized diff — the highest-risk
 * surfaces), an agent must supply its own `--gate`. That string becomes the recorded `suites` and a green marker
 * satisfies the mandatory landing check, so it may not be an arbitrary command (`true`, `exit 0`, `vitest … || true`).
 * Accept only `&&`-joined segments of `vitest related|run <targets…> [--run|--bail]` / `npm run test:unit` /
 * `npm test` / `npm run check:standards …`, at least one of which really runs tests (`vitest related` needs at
 * least one target; no flag that can silence or redirect the run — see {@link ALLOWED_VITEST_FLAG}; the whole-suite
 * commands take no arguments), with no `;`, `|`, `||`, lone `&`, backticks, `$(…)` or redirections. A SHAPE check,
 * not proof of strength — CI still runs the full suite. Pure.
 * @param {string} gate
 * @returns {string|null} a refusal reason, or `null` when the gate shape is acceptable
 */
export function explicitGateRefusal(gate) {
  const text = String(gate ?? '').trim();
  if (!text) return 'the explicit gate is empty';
  if (/[;|`<>\n\r]|\$\(/.test(text) || text.replaceAll('&&', '').includes('&')) {
    return 'the explicit gate contains a shell operator other than `&&` (`;`, `|`, `||`, `&`, backticks, `$(…)`, redirection)';
  }
  let runsTests = false;
  for (const segment of text.split('&&').map((s) => s.trim())) {
    const vitest = VITEST_SEGMENT.exec(segment);
    if (vitest) {
      const tokens = segment.slice(vitest[0].length).split(/\s+/).filter(Boolean);
      const badFlag = tokens.find((t) => t.startsWith('-') && !ALLOWED_VITEST_FLAG.test(t));
      if (badFlag) return `\`${badFlag}\` is not an allowed flag in an explicit gate (only --run and --bail; others can silence or redirect the run)`;
      if (vitest[1] === 'related' && !tokens.some((t) => !t.startsWith('-'))) return '`vitest related` in the explicit gate names no target file';
      runsTests = true;
    } else if (FULL_TEST_SEGMENT.test(segment)) {
      runsTests = true;
    } else if (!CHECK_STANDARDS_SEGMENT.test(segment)) {
      return 'every `&&` segment of the explicit gate must be `vitest related|run <targets>`, `npm run test:unit` / `npm test` (no arguments) or `npm run check:standards`';
    }
  }
  if (!runsTests) return 'the explicit gate runs no tests (check:standards alone is not an affected-test gate)';
  return null;
}

/**
 * One human-readable block describing what the default gate decided — printed by `verify-lane.mjs` before the
 * gate runs, so an agent (and the operator reading its transcript) can see whether this was a SELECTED run or a
 * FULL-SUITE fallback, and why. Pure.
 * @param {{command: string, decision: object}} gate - `resolveDefaultGate`'s return value
 * @returns {string}
 */
export function describeGate({ command, decision, scanCommands = [] }) {
  if (decision.mode === 'blocked') return `verify-lane gate: BLOCKED selection — ${decision.reasons.join('; ')}`;
  const out = [];
  if (decision.mode === 'shrink') {
    out.push(`verify-lane gate: SELECTED tests only — ${decision.changedFiles.length} changed path(s) → \`vitest related\` on ${decision.targets.length} target(s) (${decision.referencedTests.length} added because they name a changed file). CI still runs the full suite.`);
    if (decision.selection) out.push(`  related-test selection: ${decision.selection.status} — ${decision.selection.reason}`
      + (decision.selection.hubs?.length ? ` (hubs: ${decision.selection.hubs.map((h) => `${h.file} ${h.direct}/${h.transitive}`).join(', ')})` : ''));
  } else {
    out.push('verify-lane gate: FULL SUITE (fallback) — the diff could not be safely scoped:');
  }
  for (const r of decision.reasons || []) out.push(`  - ${r}`);
  if (scanCommands.length) out.push(`  repo-scanning tests (#3887, not reachable by \`vitest related\`): ${scanCommands.length} command(s), scoped to the changed files where the test supports it`);
  if (decision.standards?.run === false) out.push(`  check:standards: ${decision.standards.reason}`);
  out.push(`  command: ${command}`);
  return out.join('\n');
}


/** Extract the first text-mode standards error's rule id or bounded message (#5141). */
export function firstStandardsErrorId(text) {
  const message = stripVTControlCharacters(text).match(/^[\t ]*error[\t ]+([^\r\n]+)/m)?.[1].trim();
  return message ? (message.match(/^([a-z0-9][a-z0-9-]*):/i)?.[1] ?? message).slice(0, 200) : null;
}

/** Derive non-gating telemetry from one phase's final command result (#5141). */
export function buildPhaseOutcome({ kind, exitCode, signal, failureDetails, output, decision }) {
  if (exitCode == null && !signal) return { result: 'skipped' };
  if (exitCode === 0 && !signal) return { result: 'pass' };
  const file = failureDetails?.tests?.[0]?.file;
  const fallback = signal ? `signal ${signal}` : `exit ${exitCode}`;
  const reason = kind === 'standards'
    // Output over the capture cap is null; the collector's bounded tail still holds the last error lines.
    ? firstStandardsErrorId(output ? `${output.stdout ?? ''}\n${output.stderr ?? ''}` : failureDetails?.summary ?? '') ?? fallback
    : file || fallback;
  return { result: 'fail', reason: reason.slice(0, 200), ...(kind === 'vitest' ? {
    source: file && decision?.referencedTests?.includes(file) && !decision?.relatedFiles?.includes(file)
      ? 'literal-reference' : 'import-graph',
  } : {}) };
}

/**
 * #99 — the always-run guard command: the declared `alwaysRunTests` files that exist in this checkout and are not
 * already run by a scan command, as ONE `vitest run` (one startup). Independent of the related selection, so a small
 * or truncated selection can never skip them. Null when nothing applies (empty set, sibling checkout, no test half).
 * Pure over the injected `fileExists`. With `reportFile` the run ALSO writes vitest's JSON report there (the default
 * reporter stays on, so failure output is unchanged): vitest treats file arguments as filters, so a guard its config
 * excludes is dropped silently while the others still pass — `alwaysRunInventory` reads the report to prove each ran.
 * @returns {{command: string|null, declared: string[], files: string[], skipped: string[]}}
 */
export function alwaysRunPlan({ declared = [], fileExists, scanCommands = [], testTimeoutFactor = 1, reportFile = null } = {}) {
  const wanted = [...new Set(declared.map(f => typeof f === 'string' ? f.replace(/^\.\//, '') : f))];
  const files = [], skipped = [];
  for (const f of wanted) {
    // Defence in depth behind the settings validation: an entry is a file argument, never a vitest option.
    if (typeof f !== 'string' || !f || f.startsWith('-')) skipped.push(f);
    else if (typeof fileExists === 'function' && !fileExists(f)) skipped.push(f);
    else if (scanCommands.some(c => c.includes(shellQuote(f)))) skipped.push(f);
    else files.push(f);
  }
  const reporter = reportFile ? ` --reporter=default --reporter=json --outputFile.json=${shellQuote(reportFile)}` : '';
  const command = files.length ? `npx vitest run ${files.map(shellQuote).join(' ')}${reporter}${scaledTimeoutFlags(testTimeoutFactor)}` : null;
  return { command, declared: wanted, files, skipped };
}

/**
 * #99 — which planned guard files appear in vitest's executed-file inventory (its JSON report). Pure. A planned file
 * missing from the report was excluded or matched no test; an absent / unparseable report proves nothing, so every
 * file is missing (`reason: 'inventory-unavailable'`). A file counts as executed when it has a result entry, whatever
 * its outcome — a red guard is reported by the run's own exit code, not here.
 * @param {{reportText: string|null|undefined, files: string[], cwd: string}} a
 * @returns {{executed: string[], missing: string[], reason: 'ok'|'inventory-unavailable'}}
 */
export function alwaysRunInventory({ reportText, files = [], cwd }) {
  let names;
  try {
    const parsed = JSON.parse(String(reportText ?? ''));
    if (!parsed || !Array.isArray(parsed.testResults)) throw new Error('no testResults');
    // A file whose every assertion was skipped / todo ran nothing: only an entry with a real result counts.
    const ranSomething = (r) => !Array.isArray(r?.assertionResults) || !r.assertionResults.length
      || r.assertionResults.some(a => a?.status !== 'skipped' && a?.status !== 'pending' && a?.status !== 'todo');
    names = new Set(parsed.testResults.filter(ranSomething)
      .map(r => relative(cwd, String(r?.name ?? '')).split(sep).join('/').replace(/^\.\//, '')));
  } catch {
    return { executed: [], missing: [...files], reason: 'inventory-unavailable' };
  }
  const executed = files.filter(f => names.has(f.replace(/^\.\//, '')));
  return { executed, missing: files.filter(f => !executed.includes(f)), reason: 'ok' };
}

/** Build normalized, non-gating phase telemetry for verify markers and CLI results (#5141). */
export function buildVerifyPhases({ admissionWaitMs, vitestMs, scanMs, standardsMs, gateMs, decision, outcomes = {}, admission, alwaysRun }) {
  const ms = value => Number.isFinite(value) ? Math.round(value) : null;
  const admissionMode = admission?.mode === 'phase' ? 'phase' : 'gate';
  const admissionPhases = admissionMode === 'phase' ? admission.phases ?? {} : null;
  const standardsOutcome = decision?.standards?.run === false
    ? { result: 'skipped', reason: decision.standards.reason } : { result: 'skipped' };
  return {
    admissionMode,
    admissionPhases,
    settingsSource: decision?.settingsSource ?? null,
    standardsPolicy: decision?.standards?.policy ?? null,
    relatedMode: decision?.relatedMode ?? null,
    testTimeoutFactor: decision?.testTimeoutFactor ?? null,
    admissionWaitMs: ms(admissionPhases ? Object.values(admissionPhases).reduce((sum, phase) => sum + phase.waitedMs, 0) : admissionWaitMs),
    vitestMs: ms(vitestMs),
    scanMs: ms(scanMs),
    standardsMs: ms(standardsMs),
    gateMs: ms(gateMs),
    targetFileCount: Array.isArray(decision?.targets) ? decision.targets.length : null,
    changedFileCount: Array.isArray(decision?.changedFiles) ? decision.changedFiles.length : null,
    importGraphTargetCount: Array.isArray(decision?.relatedFiles) ? decision.relatedFiles.length : null,
    literalReferenceTargetCount: Array.isArray(decision?.referencedTests) && Array.isArray(decision?.relatedFiles)
      ? decision.referencedTests.filter(file => !decision.relatedFiles.includes(file)).length : null,
    // #5128 — what the related-test selection ran and why; `status: 'selection-truncated'` means farther tests were left to CI.
    selection: decision?.selection ? {
      status: decision.selection.status, fullTestCount: decision.selection.fullTestCount,
      selectedTestCount: decision.selection.selectedTestCount, directTestCount: decision.selection.directTestCount,
      droppedCount: decision.selection.droppedCount, depth: decision.selection.depth, maxDepth: decision.selection.maxDepth,
      maxTests: decision.selection.maxTests, hubs: decision.selection.hubs, reason: decision.selection.reason,
    } : null,
    // #99 — the always-run guard files planned, whether they actually executed (`ran` is empty when an earlier red or
    // a signal stopped the gate first), the files declared but skipped, and the result.
    // `ran` is vitest's own executed-file inventory when one was read; `missing` are planned guards it did NOT execute.
    ...(alwaysRun ? { alwaysRun: { planned: alwaysRun.files, ran: alwaysRun.executed === true ? (alwaysRun.ran ?? alwaysRun.files) : [], executed: alwaysRun.executed === true,
      missing: alwaysRun.missing ?? [], skipped: alwaysRun.skipped, ms: ms(alwaysRun.ms), result: alwaysRun.result ?? null } } : {}),
    // The guard's own outcome appears only when it ran, so a scanner's `scan` outcome is never replaced by it.
    outcomes: Object.fromEntries([...['vitest', 'scan', 'standards'], ...(outcomes.guard ? ['guard'] : [])].map(kind => [kind, outcomes[kind] ?? (kind === 'standards' ? standardsOutcome : { result: 'skipped' })])),
  };
}

/** Format the available phase telemetry as one short stderr line (#5141). */
export function formatVerifyPhases(phases) {
  const fields = { admission: phases.admissionWaitMs, vitest: phases.vitestMs, scan: phases.scanMs,
    standards: phases.standardsMs, gate: phases.gateMs, targets: phases.targetFileCount, changed: phases.changedFileCount };
  const counts = { alwaysRun: phases.alwaysRun ? (phases.alwaysRun.executed ? `${phases.alwaysRun.ran.length}files/${phases.alwaysRun.ms ?? '?'}ms` : 'not-run') : null, selection: phases.selection ? `${phases.selection.status}(${phases.selection.selectedTestCount}/${phases.selection.fullTestCount})` : null, graph: phases.importGraphTargetCount, literal: phases.literalReferenceTargetCount, related: phases.relatedMode, timeoutFactor: phases.testTimeoutFactor, standardsPolicy: phases.standardsPolicy, admission: phases.admissionMode };
  return ['phaseMs', ...Object.entries(fields).filter(([, value]) => value != null)
    .map(([name, value]) => `${name}=${value}`),
  ...Object.entries(phases.outcomes ?? {}).map(([name, outcome]) =>
    `${name}=${outcome.result}${outcome.reason ? `(${outcome.reason.replace(/[\r\n\u2028\u2029]/g, ' ')})` : ''}`),
  ...Object.entries(counts).filter(([, value]) => value != null).map(([name, value]) => `${name}=${value}`),
  ...(phases.settingsSource ? [`settingsSource=${JSON.stringify(phases.settingsSource)}`] : []),
  ...Object.entries(phases.admissionPhases ?? {}).map(([name, phase]) => `${name}Wait=${phase.waitedMs}(${phase.lane})`)].join(' ');
}
