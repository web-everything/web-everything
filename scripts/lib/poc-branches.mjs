/**
 * @file scripts/lib/poc-branches.mjs
 * @description THE POC-BRANCH REGISTRY (#3637 Fork 4) — the declared list of long-lived "POC branches" that
 *   items may target with `deliveryTarget:`, and the ONE place their names, purposes, owners and graduation
 *   targets live.
 *
 * WHY IT EXISTS. Doctrine rule 10 (`we:skills-src/mechanical-delivery-doctrine/SKILL.md`), as amended by
 * `#3637`'s ruling, says N POC branches may stand concurrently — and clause (c) of that same rule says every
 * one of them "must NAME what it is for and who graduates it (a registry entry: branch, graduation target,
 * scope, graduation item)". An *unnamed* divergent branch is the failure mode that cost a ~40-minute manual
 * reconciliation and 15 hand-resolved conflicts when `origin/lane/mechanical-dispatcher` drifted 97 commits
 * behind `main` behind a silently-failing sync loop. This file is that naming requirement, mechanized: a
 * branch nothing here declares is not a legal `deliveryTarget:` and is not a legal `poc-land` target.
 *
 * IT ALSO UN-DUPLICATES TWO CONSTANTS. `DEFAULT_DRIFT_BRANCH`/`DEFAULT_DRIFT_TARGET` were declared TWICE —
 * `we:scripts/conveyor/branch-drift.mjs:52-53` and again at `we:scripts/readiness/dispatch-plan.mjs:229-231`
 * — so a change to one silently did not reach the other (a latent bug `#3637`'s survey found and named,
 * independent of the design). Both now derive their defaults from {@link primaryPocBranch} below, so the
 * branch is declared once and read twice.
 *
 * SHAPE — follows `we:scripts/lib/constellation-repos.mjs`, this repo's existing small-typed-registry
 * precedent (a frozen table + pure lookups that FAIL CLOSED, returning `null` for an unknown key rather than
 * silently defaulting), with the table itself lifted into `./poc-branches.json` so the registry can be WRITTEN
 * (a new POC branch is registered, not hand-edited into a source file) as well as read.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors `we:scripts/lib/target-registry.mjs`). Everything above the "IO SHELL"
 * banner is pure — no fs, no clock — and unit-tested in `__tests__/poc-branches.test.mjs`. Only
 * {@link readRegistry}/{@link writeRegistry} touch the disk.
 *
 * NOT a config the product reads: this is delivery-machinery state, so it lives beside its consumers in
 * `we:scripts/lib/` (next to `invariant-catalogue.json` and `review-policy.contract.json`, the same shape) and
 * never in the product's `we:config/` TypeScript package.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { canonicalizeSlug } from './constellation-repos.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The registry file this module reads and writes. */
export const POC_REGISTRY_PATH = join(__dirname, 'poc-branches.json');

/** Schema version every registry file carries. Bump ONLY on a breaking field change. */
export const POC_REGISTRY_VERSION = 1;

/** The default graduation target when an entry names none — every POC branch graduates into `main` unless it
 *  says otherwise (a branch stacked on another POC branch is the case this leaves room for). */
export const DEFAULT_GRADUATION_TARGET = 'main';

/** The repo an entry belongs to when it names none (`owner/name` slug). Every entry registered before the
 *  `repo` field existed is a Web Everything branch, so the registry stays byte-compatible: an entry with no
 *  `repo` is exactly what it always was. A sibling-repo branch (e.g. plateau-app's alpha branch) sets `repo`
 *  so `poc-land` can land on it from that repo's own lane, while every WE-only consumer (the drift sweep, the
 *  mechanical sync, `deliveryTarget:`, the prototype-tracker guard) keeps seeing only WE branches. */
export const DEFAULT_POC_REPO = 'web-everything/web-everything';

const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Canonical `owner/name` for a repo value (legacy `chalbert/<dir>` slugs map to their current org). PURE. */
export function normalizeRepoSlug(repo) {
  const v = String(repo ?? '').trim().replace(/\.git$/i, '');
  return v ? canonicalizeSlug(v) : DEFAULT_POC_REPO;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE CORE — no fs, no clock
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A git branch name, conservatively: no leading/trailing slash or dot, no `..`, no whitespace, no shell
 *  metacharacters. Narrow on purpose — this value reaches `git push origin HEAD:<branch>` as an argument, so
 *  it is validated the same way `we:scripts/operations/dispatch-lane.mjs`'s `BRIEF_VALUE_RE` validates the
 *  values it interpolates into a command line. */
export const BRANCH_NAME_RE = /^(?!\/)(?!.*\/\/)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._\-/]*[A-Za-z0-9]$/;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strip a leading `origin/` (or any single remote name the caller already knows) so a branch written as
 * `origin/lane/mechanical-dispatcher` in one place and `lane/mechanical-dispatcher` in another compares equal.
 * Only `origin/` is stripped — a branch legitimately named `foo/bar` must not be silently truncated. PURE.
 * @param {string} ref
 * @returns {string}
 */
export function normalizeBranchRef(ref) {
  const v = String(ref ?? '').trim();
  return v.startsWith('origin/') ? v.slice('origin/'.length) : v;
}

/**
 * Validate ONE registry entry. Returns `{ ok, errors }` and NEVER throws on bad data — a malformed registry
 * must surface as a readable refusal, not a crash inside a lander that is holding a push lock (the
 * never-throw-on-read contract `validateManifest` and `validateVerdictRecord` already set in this repo).
 *
 * Rule 10(c)'s four named fields are all required — `branch`, `target` (graduation target), `scope`,
 * `graduationItem` — plus the two the `#3637` build brief added: `purpose` (what it is for, in words) and
 * `owner` (who graduates it). `scope` may legitimately be EMPTY (a branch carrying no unreconciled
 * drift-scope yet) but must be present as an array, so "nobody decided" and "deliberately none" stay distinct.
 * @param {object} entry
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validatePocBranch(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, errors: ['entry is not an object'] };
  if (!isNonEmptyString(entry.branch)) errors.push('`branch` is required (the ref this POC branch lands on)');
  else if (!BRANCH_NAME_RE.test(normalizeBranchRef(entry.branch))) errors.push(`\`branch\` ${JSON.stringify(entry.branch)} is not a plain git branch name`);
  if (!isNonEmptyString(entry.purpose)) errors.push('`purpose` is required — doctrine rule 10(c): a POC branch must NAME what it is for');
  if (!isNonEmptyString(entry.owner)) errors.push('`owner` is required — doctrine rule 10(c): a POC branch must name who graduates it');
  if (!isNonEmptyString(entry.dateOpened) || !ISO_DAY_RE.test(String(entry.dateOpened).trim())) errors.push('`dateOpened` is required and must be a YYYY-MM-DD day');
  const target = entry.target ?? DEFAULT_GRADUATION_TARGET;
  if (!isNonEmptyString(target) || !BRANCH_NAME_RE.test(normalizeBranchRef(target))) errors.push('`target` (the graduation target) must be a plain git branch name');
  else if (normalizeBranchRef(target) === normalizeBranchRef(entry.branch)) errors.push('`target` must differ from `branch` — a branch cannot graduate into itself');
  if (entry.scope != null && (!Array.isArray(entry.scope) || !entry.scope.every(isNonEmptyString))) errors.push('`scope` must be an array of repo-qualified `<repo>:<path>` strings');
  if (entry.graduationItem != null && !isNonEmptyString(entry.graduationItem)) errors.push('`graduationItem` must be an item id string (e.g. "3443")');
  if (entry.repo != null && !(typeof entry.repo === 'string' && SLUG_RE.test(entry.repo.trim()))) errors.push('`repo` must be an `owner/name` GitHub slug when present (default: web-everything/web-everything)');
  if (entry.autoSync != null && typeof entry.autoSync !== 'boolean') errors.push('`autoSync` must be a boolean when present (opts this branch in/out of #3383\'s mechanical target-into-branch sync)');
  return { ok: errors.length === 0, errors };
}

/**
 * Normalize a parsed registry file into a frozen, canonical `{ version, branches }`. Tolerant of a missing or
 * malformed file (⇒ an EMPTY registry, not a throw): an unreadable registry means "no POC branch is declared",
 * which fails CLOSED everywhere downstream — `deliveryTarget:` validation refuses, and `poc-land` refuses.
 * Entries that do not validate are DROPPED and reported in `dropped`, so one bad hand-edit never takes the
 * whole registry (and therefore every POC branch) offline silently. PURE.
 * @param {unknown} parsed
 * @returns {{version: number, branches: object[], dropped: {branch: string, errors: string[]}[]}}
 */
export function normalizeRegistry(parsed) {
  const raw = (parsed && typeof parsed === 'object' && Array.isArray(parsed.branches)) ? parsed.branches : [];
  const branches = [];
  const dropped = [];
  const seen = new Set();
  for (const e of raw) {
    const verdict = validatePocBranch(e);
    const name = normalizeBranchRef(e?.branch);
    if (!verdict.ok) { dropped.push({ branch: name || String(e?.branch ?? ''), errors: verdict.errors }); continue; }
    const repo = normalizeRepoSlug(e.repo);
    const key = `${repo}#${name}`;
    if (seen.has(key)) { dropped.push({ branch: name, errors: ['duplicate `branch` in the same `repo` — the first entry wins'] }); continue; }
    seen.add(key);
    branches.push(Object.freeze({
      branch: name,
      // `undefined` for a WE entry that never named one, so `writeRegistry` round-trips the file unchanged.
      ...(e.repo != null ? { repo } : {}),
      purpose: String(e.purpose).trim(),
      owner: String(e.owner).trim(),
      dateOpened: String(e.dateOpened).trim(),
      target: normalizeBranchRef(e.target ?? DEFAULT_GRADUATION_TARGET),
      scope: Object.freeze(Array.isArray(e.scope) ? [...e.scope] : []),
      graduationItem: e.graduationItem != null ? String(e.graduationItem).trim() : null,
      // #3383 — see `resolveAutoSyncEnabled` below. `undefined` (not `false`) when the entry never set it, so
      // "explicitly off" and "never decided" stay distinct for the resolver's own env-default fallback, and so
      // `writeRegistry`'s JSON.stringify drops the key entirely for a branch that never opted in — no noisy
      // `"autoSync": false` line on every entry that doesn't care.
      autoSync: typeof e.autoSync === 'boolean' ? e.autoSync : undefined,
    }));
  }
  const version = Number.isFinite(Number(parsed?.version)) ? Number(parsed.version) : POC_REGISTRY_VERSION;
  return Object.freeze({ version, branches: Object.freeze(branches), dropped: Object.freeze(dropped) });
}

/**
 * Look one branch up in an already-normalized registry. Accepts either spelling (`origin/x` or `x`). Returns
 * `null` for an unknown branch — FAIL CLOSED, never a silent fall back to `main` (the exact posture
 * `repoKeyForDir` takes in `we:scripts/lib/constellation-repos.mjs`). PURE.
 * @param {{branches: object[]}} registry
 * @param {string} branch
 * @returns {object|null}
 */
export function findPocBranch(registry, branch, repo = DEFAULT_POC_REPO) {
  const want = normalizeBranchRef(branch);
  if (!want) return null;
  const wantRepo = normalizeRepoSlug(repo);
  return (registry?.branches ?? []).find((b) => b.branch === want && entryRepo(b) === wantRepo) ?? null;
}

/** The repo an (already-normalized or raw) entry belongs to. PURE. */
export function entryRepo(entry) { return normalizeRepoSlug(entry?.repo); }

/** Only the entries of one repo (default: Web Everything) — what every WE-only consumer iterates. PURE. */
export function branchesForRepo(registry, repo = DEFAULT_POC_REPO) {
  const want = normalizeRepoSlug(repo);
  return (registry?.branches ?? []).filter((b) => entryRepo(b) === want);
}

/**
 * Is `branch` a DECLARED POC branch? Pure sugar over {@link findPocBranch} for the many call sites that only
 * need the boolean.
 * @param {{branches: object[]}} registry
 * @param {string} branch
 * @returns {boolean}
 */
export function isPocBranch(registry, branch, repo = DEFAULT_POC_REPO) { return findPocBranch(registry, branch, repo) !== null; }

/** The env var {@link resolveAutoSyncEnabled} reads for its global default/kill-switch — mirrors
 *  `we:scripts/lib/lane-concurrency.mjs`'s `WE_MAX_CONCURRENT_LANES` and
 *  `we:scripts/readiness/heavy-admission.mjs`'s `WE_HEAVY_ADMISSION_CAP` naming convention. */
export const AUTO_SYNC_ENV_VAR = 'WE_POC_BRANCH_SYNC';

/**
 * THE #3383 ON/OFF KNOB for "keep this POC branch mechanically synced with its graduation target" — the config
 * convention this repo already established for a feature toggle: a `WE_<NAME>` env var
 * ({@link AUTO_SYNC_ENV_VAR}), settable PER-BRANCH via this registry's own `autoSync` field, with a
 * conservative global default (OFF) when neither says otherwise. PURE.
 *
 * RESOLUTION ORDER, each one a deliberate footgun-avoidance choice:
 *   1. NO SUCH BRANCH (`entry` is `null`/not an object) is ALWAYS off, regardless of the env default — the
 *      global opt-in only ever applies to a branch that is genuinely REGISTERED but undecided (case 3 below);
 *      it must never be read as "sync anything, registered or not" (review finding: a caller that mistakenly
 *      passed a `null` entry — e.g. `findPocBranch` missing — must not have that mistake silently upgraded
 *      into a real sync attempt just because `WE_POC_BRANCH_SYNC=1` happens to be set).
 *   2. `env.WE_POC_BRANCH_SYNC === '0'` is a GLOBAL KILL SWITCH — it forces every REGISTERED branch OFF
 *      regardless of its own `autoSync: true`, so an operator can pause every mechanical branch-sync at once
 *      (e.g. mid-incident) without hand-editing the registry entry-by-entry.
 *   3. The entry's OWN `autoSync` (an explicit `true`/`false`) wins next — the registry is the durable,
 *      per-branch, committed decision, and is meant to win over a machine-local env default.
 *   4. Otherwise (a real, registered entry that never decided): `env.WE_POC_BRANCH_SYNC === '1'` opts it IN;
 *      anything else (unset, any other value) is the conservative default — OFF. A brand-new POC branch that
 *      forgets to set `autoSync` never gets pushed to automatically, matching this repo's "footguns first"
 *      default-safe convention (mirrors {@link resolveCap}-style resolvers' own min-1-not-0 floor).
 * @param {{autoSync?: boolean}|null} entry - a normalized registry entry (or `null` for "no such branch").
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function resolveAutoSyncEnabled(entry, env = process.env) {
  if (!entry || typeof entry !== 'object') return false;
  if (env?.[AUTO_SYNC_ENV_VAR] === '0') return false;
  if (typeof entry.autoSync === 'boolean') return entry.autoSync;
  return env?.[AUTO_SYNC_ENV_VAR] === '1';
}

/**
 * Add or replace one entry, returning a NEW registry object (the input is never mutated — every registry this
 * module hands out is frozen). Throws `TypeError` on an invalid entry: unlike the read path, a WRITE with bad
 * data is the caller's programming error and must be loud, mirroring `target-registry.mjs`'s own split between
 * tolerant validators and throwing builders. PURE.
 * @param {{version: number, branches: object[]}} registry
 * @param {object} entry
 * @returns {{version: number, branches: object[]}}
 */
export function upsertPocBranch(registry, entry) {
  const verdict = validatePocBranch(entry);
  if (!verdict.ok) throw new TypeError(`poc-branches: invalid entry — ${verdict.errors.join('; ')}`);
  const name = normalizeBranchRef(entry.branch);
  const repo = normalizeRepoSlug(entry.repo);
  const kept = (registry?.branches ?? []).filter((b) => !(b.branch === name && entryRepo(b) === repo));
  const next = normalizeRegistry({ version: registry?.version ?? POC_REGISTRY_VERSION, branches: [...kept, entry] });
  return next;
}

/**
 * Remove one entry by branch name. Returns a new registry; removing an unknown branch is a NO-OP (idempotent,
 * so a de-registration that already happened is never an error). PURE.
 * @param {{version: number, branches: object[]}} registry
 * @param {string} branch
 * @returns {{version: number, branches: object[]}}
 */
export function removePocBranch(registry, branch, repo = DEFAULT_POC_REPO) {
  const name = normalizeBranchRef(branch);
  const want = normalizeRepoSlug(repo);
  return normalizeRegistry({ version: registry?.version ?? POC_REGISTRY_VERSION, branches: (registry?.branches ?? []).filter((b) => !(b.branch === name && entryRepo(b) === want)) });
}

/**
 * Validate a `deliveryTarget:` frontmatter value against the registry — the Fork-3 filing-time check. The
 * ABSENT / `main` case is legal and means "the normal path, byte-identical to today"; anything else must be a
 * declared POC branch. Returns `{ ok, target, isPoc, error }` and never throws, so a lint can report it.
 *
 * `main` is deliberately NOT required to be in the registry: it is the default delivery target, not a POC
 * branch, and registering it would make "is this a POC landing?" ambiguous everywhere downstream.
 * @param {{branches: object[]}} registry
 * @param {string|null|undefined} value
 * @returns {{ok: boolean, target: string, isPoc: boolean, error: string|null}}
 */
export function validateDeliveryTarget(registry, value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return { ok: true, target: DEFAULT_GRADUATION_TARGET, isPoc: false, error: null };
  const target = normalizeBranchRef(raw);
  if (target === DEFAULT_GRADUATION_TARGET) return { ok: true, target, isPoc: false, error: null };
  if (findPocBranch(registry, target)) return { ok: true, target, isPoc: true, error: null };
  const known = branchesForRepo(registry).map((b) => b.branch);
  return {
    ok: false,
    target,
    isPoc: false,
    error: `deliveryTarget "${target}" is not a registered POC branch (known: ${known.length ? known.join(', ') : 'none'}; omit the field, or use "main", for the normal path). `
      + 'Doctrine rule 10(c): a POC branch must be DECLARED — register it in we:scripts/lib/poc-branches.json first.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// IO SHELL — the only part that touches the disk
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Read + normalize the registry from disk. A missing or malformed file yields an EMPTY registry rather than a
 * throw (see {@link normalizeRegistry}). `path` is injectable so tests never touch the real file.
 * @param {{path?: string, read?: (p: string) => string}} [o]
 * @returns {{version: number, branches: object[], dropped: object[]}}
 */
export function readRegistry({ path = POC_REGISTRY_PATH, read = (p) => readFileSync(p, 'utf8') } = {}) {
  let parsed = null;
  try { parsed = JSON.parse(read(path)); } catch { parsed = null; }
  return normalizeRegistry(parsed);
}

/**
 * Write a registry back to disk, pretty-printed with a trailing newline (so a diff of a registration is one
 * readable block, not a one-line reflow). Normalizes first, so a write can never persist an entry the read
 * path would then drop.
 * @param {{registry: object, path?: string, write?: (p: string, s: string) => void}} o
 * @returns {{version: number, branches: object[]}}
 */
export function writeRegistry({ registry, path = POC_REGISTRY_PATH, write = (p, s) => writeFileSync(p, s, 'utf8') } = {}) {
  const next = normalizeRegistry(registry);
  write(path, `${JSON.stringify({ version: next.version, branches: next.branches.map((b) => ({ ...b, scope: [...b.scope] })) }, null, 2)}\n`);
  return next;
}

/**
 * The FIRST registered POC branch, or `null` when none is registered. This is what
 * `we:scripts/conveyor/branch-drift.mjs` and `we:scripts/readiness/dispatch-plan.mjs` derive their
 * `DEFAULT_DRIFT_BRANCH`/`DEFAULT_DRIFT_TARGET`/`DEFAULT_DRIFT_SCOPE` defaults from, so those constants are
 * declared ONCE here instead of twice there. Both remain flag/env-overridable exactly as before — this only
 * changes where their DEFAULT comes from.
 * @param {{path?: string}} [o]
 * @returns {object|null}
 */
export function primaryPocBranch(o = {}) {
  const reg = readRegistry(o);
  return branchesForRepo(reg)[0] ?? null;
}

/**
 * The drift-sweep defaults, derived from {@link primaryPocBranch} — the SINGLE source
 * `we:scripts/conveyor/branch-drift.mjs` and `we:scripts/readiness/dispatch-plan.mjs` both read, replacing the
 * two independent copies of these three constants they used to declare (a change to one silently did not reach
 * the other; `#3637`'s survey named it a latent bug independent of the design).
 *
 * An EMPTY registry yields `{ branch: null, target: 'main', scope: [] }` rather than a throw: no POC branch is
 * declared, so there is nothing to sweep, and both consumers already accept an explicit `--branch=`/`--target=`
 * for that case. It is the CONSUMER's job to refuse when it needs a branch and has none.
 * @param {{path?: string}} [o]
 * @returns {{branch: string|null, target: string, scope: string[]}}
 */
export function driftDefaults(o = {}) {
  const first = primaryPocBranch(o);
  return Object.freeze({
    branch: first?.branch ?? null,
    target: first?.target ?? DEFAULT_GRADUATION_TARGET,
    scope: Object.freeze(first ? [...first.scope] : []),
  });
}
