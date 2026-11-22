/**
 * @file scripts/lib/model-probation.mjs
 * @description THE PROBATION-STATUS REGISTRY (epic #3383) — the ONE place a `{provider, model}` identity's
 *   trust status is declared, per ROLE (`delivery`, `advisory-review`).
 *
 * WHY THIS EXISTS. The operator's ruling (2026-09-13): a not-yet-fully-trusted provider/model should be able
 * to do real work — real `fix`-kind delivery dispatches, a real advisory (non-blocking) review seat — while
 * data is collected on it, WITHOUT that data-collection ever gating anything. Codex (`gpt-6-astra`) is the
 * first real instance, but the status is deliberately keyed by **provider + model identity**, never
 * hardcoded to Codex: a future Claude version, a newly-integrated provider (Antigravity, Grok, an
 * open-weight model), or a Codex model UPGRADE all enter/leave probation the same way, through a registry
 * edit here, never a code change at a call site. A model upgrade does NOT inherit the outgoing model's
 * accumulated trust — `gpt-6-astra`'s entry says nothing about `gpt-7-something`; an unlisted `{provider,
 * model}` pair is `unvalidated` by construction (see {@link DEFAULT_STATUS}), so a new model starts over.
 *
 * SHAPE — follows `we:scripts/lib/poc-branches.mjs`'s already-ratified small-typed-registry precedent: a
 * frozen table lifted into a sibling `.json` file (so the registry can be WRITTEN — a status change is a
 * data edit, not a source edit — as well as read), a `version` field bumped only on a breaking shape change,
 * and PURE-CORE / IO-SHELL split (only {@link readRegistry}/{@link writeRegistry} touch disk). Fork 5 of
 * `#3649` (`we:backlog/3649-*.md`) sets the sibling precedent this module ALSO follows for its own, narrower
 * purpose: "stamped ... never inferred afterwards" — a dispatch's or a scorecard's probation status is read
 * off this registry AT THE TIME, not re-derived from behaviour, and a caller that wants a stable historical
 * record should stamp the read-back value onto its own record (see `run-scorecard-store.mjs`'s
 * `probationStatus` field) rather than re-querying the live registry later.
 *
 * STATUS VOCABULARY, per role:
 *   - `'unvalidated'` — no real trials yet for this role. FAIL-CLOSED DEFAULT for any `{provider, model,
 *     role}` triple this registry does not name — an unlisted pair is never silently treated as trusted.
 *   - `'probation'` — doing REAL work for this role (eligible for real dispatch / seating), specifically to
 *     accumulate real performance data (see `#3649`'s run-quality recorder) — but structurally barred from
 *     ever gating anything (see {@link NEVER_BLOCKING_ROLES} and the role docs below).
 *   - `'trusted'` — graduated out of probation on a later, separate ruling (never automatic — `#3651` names
 *     the trigger: one complete `rubricVersion` population).
 *
 * ROLES:
 *   - `'delivery'` — real `build`/`fix`/`ci-heal` dispatch work. A `probation` provider CAN be dispatched for
 *     real work in this role; nothing about delivery is "blocking" in the review sense, so this role has no
 *     veto-power question to begin with.
 *   - `'advisory-review'` — a non-blocking, opt-in-by-default-on-probation reviewer seat (`review-pr.mjs`'s
 *     `judgeAdvisory` step). THIS role is where "never blocks a merge, never gets veto power" is load-bearing:
 *     a `probation` (or even `trusted`) status here NEVER promotes the seat's lens out of `ADVISORY_LENSES`
 *     into `MANDATORY_LENSES` — that split is a STRUCTURAL property of `we:scripts/operations/review-pr.mjs`
 *     (`decideLensFloor`/`seatedLenses`), not a status this registry could override even if it wanted to. This
 *     module never grants veto power to any role; it only ever loosens whether a NON-gating seat runs by
 *     default. See `NEVER_BLOCKING_ROLES` below for the assertion that keeps this true even under a coding
 *     mistake at a call site.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isCriticalMiss as classifyCriticalMiss } from './critical-work.mjs';
import { readStore, appendScorecardUnlessJudged } from '../conveyor/run-scorecard-store.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The registry file this module reads and writes. */
export const PROBATION_REGISTRY_PATH = join(__dirname, 'model-probation.json');

/** Schema version every registry file carries. Bump ONLY on a breaking field change. */
export const PROBATION_REGISTRY_VERSION = 1;

/** The full status vocabulary, ordered least → most trusted. */
export const PROBATION_STATUSES = Object.freeze(['unvalidated', 'probation', 'trusted']);

/** The roles this registry tracks per `{provider, model}` identity. */
export const PROBATION_ROLES = Object.freeze(['delivery', 'advisory-review']);

/** Fail-closed default for any identity/role this registry does not name. */
export const DEFAULT_STATUS = 'unvalidated';

/**
 * Roles that structurally can NEVER gate a merge or acquire veto power, regardless of status. This is not a
 * config a status could flip — it exists so a caller asking "can this role ever block" gets a single,
 * grep-able `true`/`false` answer sourced from ONE place, backed by `review-pr.mjs`'s own mandatory/advisory
 * lens split (the actual structural enforcement lives there — `ADVISORY_LENSES` vs `MANDATORY_LENSES` — this
 * is a restatement for callers who only have this module in scope, not a second, independent enforcement
 * point that could drift from it).
 */
export const NEVER_BLOCKING_ROLES = Object.freeze(['advisory-review']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalize a `{provider, model}` pair into the registry's lookup key. PURE. */
export function identityKey({ provider, model } = {}) {
  return `${String(provider ?? '').trim().toLowerCase()}::${String(model ?? '').trim()}`;
}

/**
 * Validate ONE registry entry. Never throws — a malformed registry must degrade to "nothing declared"
 * (fail-closed, per {@link normalizeRegistry}), not crash a caller mid-dispatch decision.
 * @param {object} entry
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProbationEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, errors: ['entry is not an object'] };
  if (!isNonEmptyString(entry.provider)) errors.push('`provider` is required (e.g. "codex", "anthropic")');
  if (!isNonEmptyString(entry.model)) errors.push('`model` is required (e.g. "gpt-6-astra") — identity is ALWAYS provider+model, never provider alone');
  if (!isNonEmptyString(entry.since) || !ISO_DAY_RE.test(String(entry.since).trim())) errors.push('`since` is required and must be a YYYY-MM-DD day');
  if (!isNonEmptyString(entry.owner)) errors.push('`owner` is required — the item/epic that put this identity on probation');
  if (!entry.roles || typeof entry.roles !== 'object' || Array.isArray(entry.roles)) {
    errors.push('`roles` is required — an object mapping each declared role to a status');
  } else {
    for (const [role, status] of Object.entries(entry.roles)) {
      if (!PROBATION_ROLES.includes(role)) errors.push(`\`roles\` names unknown role ${JSON.stringify(role)} — one of ${PROBATION_ROLES.join('|')}`);
      if (!PROBATION_STATUSES.includes(status)) errors.push(`\`roles.${role}\` must be one of ${PROBATION_STATUSES.join('|')}, got ${JSON.stringify(status)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Normalize a parsed registry file into a frozen, canonical `{version, entries}`. Tolerant of a missing or
 * malformed file (⇒ an EMPTY registry, not a throw) — an unreadable registry means "nothing is declared",
 * which fails CLOSED everywhere downstream (every identity reads back {@link DEFAULT_STATUS}). Bad entries
 * are dropped and reported in `dropped` rather than taking the whole registry offline. PURE.
 * @param {unknown} parsed
 * @returns {{version: number, entries: object[], dropped: {identity: string, errors: string[]}[]}}
 */
export function normalizeRegistry(parsed) {
  const raw = (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) ? parsed.entries : [];
  const entries = [];
  const dropped = [];
  const seen = new Set();
  for (const e of raw) {
    const verdict = validateProbationEntry(e);
    const key = identityKey(e ?? {});
    if (!verdict.ok) { dropped.push({ identity: key, errors: verdict.errors }); continue; }
    if (seen.has(key)) { dropped.push({ identity: key, errors: [`duplicate identity ${JSON.stringify(key)} — first entry wins`] }); continue; }
    seen.add(key);
    entries.push(Object.freeze({ ...e, roles: Object.freeze({ ...e.roles }) }));
  }
  return Object.freeze({ version: PROBATION_REGISTRY_VERSION, entries: Object.freeze(entries), dropped: Object.freeze(dropped) });
}

/**
 * PURE lookup: what registry entry (if any) declares `{provider, model}`? Returns `null` for an unknown pair.
 * @param {{version:number, entries:object[]}} registry
 * @param {{provider:string, model:string}} identity
 * @returns {object|null}
 */
export function findEntry(registry, identity) {
  const key = identityKey(identity);
  return (registry?.entries ?? []).find((e) => identityKey(e) === key) ?? null;
}

/**
 * PURE: the declared status of `{provider, model}` for `role`. Fail-closed to {@link DEFAULT_STATUS} when the
 * identity is unlisted, the role is unlisted on that identity's entry, or `role` itself is not a known role —
 * an unknown role is refused loudly (a typo must not silently read as "unvalidated" for the WRONG reason),
 * everything else degrades quietly.
 * @param {{version:number, entries:object[]}} registry
 * @param {{provider:string, model:string, role:string}} o
 * @returns {'unvalidated'|'probation'|'trusted'}
 */
export function statusFor(registry, { provider, model, role } = {}) {
  if (!PROBATION_ROLES.includes(role)) {
    throw new TypeError(`model-probation: \`role\` must be one of ${PROBATION_ROLES.join('|')}, got ${JSON.stringify(role)}`);
  }
  const entry = findEntry(registry, { provider, model });
  const status = entry?.roles?.[role];
  return PROBATION_STATUSES.includes(status) ? status : DEFAULT_STATUS;
}

/** PURE convenience: is `{provider, model}` on probation (exactly, not `trusted`) for `role`?
 *  @test-only-export-ok: public API mirroring `liveStatusFor`'s convenience shape (`codexAdvisoryFromEnv`
 *  uses `liveStatusFor` directly today); kept for a future `delivery`-role call site (e.g. `fix-run.mjs`'s
 *  own provider selection) that is owed follow-on wiring, not built this session. */
export function isOnProbation(registry, o) {
  return statusFor(registry, o) === 'probation';
}

/** PURE convenience: is `{provider, model}` eligible for REAL work in `role` — `probation` or `trusted`?
 *  @test-only-export-ok: same rationale as `isOnProbation` above — public API for a future delivery-side
 *  eligibility check, not yet wired to a permanent caller. */
export function isDispatchEligible(registry, o) {
  const status = statusFor(registry, o);
  return status === 'probation' || status === 'trusted';
}

/**
 * PURE, and the one assertion this module makes about ITSELF: no role this registry tracks may ever gate a
 * merge, whatever its status. Throws if ever called with a role outside {@link NEVER_BLOCKING_ROLES} that a
 * caller believed was blocking-safe — a defensive check for a future role addition, not a live code path
 * today (both current roles are already correctly classified).
 * @param {string} role
 * @returns {true}
 * @test-only-export-ok: a defensive self-check with no permanent caller by design (see the docblock above) —
 *   exists to be exercised by a FUTURE role's own guard, not by anything this build wires today.
 */
export function assertRoleNeverBlocks(role) {
  if (!NEVER_BLOCKING_ROLES.includes(role)) {
    throw new Error(`model-probation: ${JSON.stringify(role)} is not declared in NEVER_BLOCKING_ROLES — do not assume it is non-gating without checking review-pr.mjs's own mandatory/advisory split first`);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// IO SHELL — the only functions that touch disk.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Read the live registry off disk. NEVER THROWS — an unreadable/malformed file degrades to the empty
 * registry (see {@link normalizeRegistry}), which fails every {@link statusFor} lookup closed to
 * {@link DEFAULT_STATUS}.
 * @param {{path?: string, read?: (p: string) => string}} [io]
 * @returns {{version: number, entries: object[], dropped: object[]}}
 */
export function readRegistry({ path = PROBATION_REGISTRY_PATH, read = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    return normalizeRegistry(JSON.parse(read(path)));
  } catch {
    return normalizeRegistry(null);
  }
}

/**
 * Write the registry back to disk, pretty-printed. The IO half of a status change (e.g. graduating an
 * identity out of probation) — callers doing that are expected to read, mutate the plain entries array, and
 * write back; this function does not validate (that is `validateProbationEntry`'s job, run by
 * {@link normalizeRegistry} on the NEXT read), so a caller SHOULD validate before writing.
 * @param {{version: number, entries: object[]}} registry
 * @param {{path?: string, write?: (p: string, s: string) => void}} [io]
 */
export function writeRegistry(registry, { path = PROBATION_REGISTRY_PATH, write = (p, s) => writeFileSync(p, s) } = {}) {
  write(path, `${JSON.stringify({ version: registry.version ?? PROBATION_REGISTRY_VERSION, entries: registry.entries ?? [] }, null, 2)}\n`);
}

/**
 * Convenience one-shot: read the live registry off disk and answer `statusFor` in one call, for a caller that
 * does not want to hold the registry object itself (the common case — a call site deciding one default).
 * @param {{provider:string, model:string, role:string}} o
 * @param {{path?: string, read?: (p:string)=>string}} [io]
 * @returns {'unvalidated'|'probation'|'trusted'}
 */
export function liveStatusFor(o, io) {
  return statusFor(readRegistry(io), o);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// GRADUATION PROGRESS (agy-launcher-probation) — the operator's numbers, and a report against them.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE GRADUATION NUMBERS — the operator's decision of Sun 2026-09-27, codified as an ordinary finding under
 * `we:docs/agent/platform-decisions.md#model-probation-graduation-criteria` (it fills the numbers #3654 left open).
 * Per task type × provider (the trust unit stays exact: `{provider, model, taskType}`), ALL of:
 *   - at least `minTrials` independently-verified trials;
 *   - at least `minInformative` informative trial (a confirmed catch, or a documented cross-reviewer severity
 *     disagreement — read ONLY from the row's own `informative: true` field, never inferred);
 *   - at most `maxCriticalMisses` confirmed critical misses (`critical-work.mjs#criticalMissesFor`, which fails
 *     closed: a miss row with no recorded scope counts as critical);
 *   - a run rating no worse than Claude's on the same task type (mean `score` of `grade`-carrying rating rows).
 * Meeting all four makes a triple ELIGIBLE FOR A PROMOTION REVIEW. Promotion itself stays an explicit human
 * decision — nothing here, or anywhere, flips a registry status on its own.
 */
export const GRADUATION_NUMBERS = Object.freeze({
  minTrials: 20,
  minInformative: 1,
  maxCriticalMisses: 0,
  runRatingNoWorseThanClaude: true,
  decidedOn: '2026-09-27',
  statute: 'docs/agent/platform-decisions.md#model-probation-graduation-criteria',
  promotion: 'explicit human decision',
});

const COUNTED_VERIFIERS = Object.freeze(['claude-subagent', 'independent-claude']);
const CLAUDE_PROVIDERS = Object.freeze(['claude', 'anthropic', 'claude-native']);
/** Run-rating rows carry a `dispatchKind`, not a `taskType`; the kinds whose task type is unambiguous. */
const RATING_KIND_TASK_TYPE = Object.freeze({ 'ci-heal': 'ci-heal', fix: 'bugfix' });

/** A work trial row: an external worker's delivery trial, never a review seat or a red-team miss. PURE. */
function isWorkTrialRow(r) {
  if (!r || typeof r !== 'object' || r.subjectClass !== 'work-agent') return false;
  if (typeof r.taskType !== 'string' || !r.taskType.trim()) return false;
  if (r.taskType.startsWith('review-lens:') || r.taskType.startsWith('red-team-miss:')) return false;
  if (r.dispatchKind === 'review-seat') return false;
  return typeof r.provider === 'string' && typeof r.model === 'string' && !CLAUDE_PROVIDERS.includes(r.provider);
}

/** A run-rating row (#2811's shape: a `grade` plus a numeric `score`), with the task type it rates. PURE. */
function ratingOf(r) {
  if (!r || typeof r !== 'object' || typeof r.grade !== 'string' || typeof r.score !== 'number') return null;
  const taskType = typeof r.taskType === 'string' ? r.taskType : RATING_KIND_TASK_TYPE[r.dispatchKind] ?? null;
  return taskType ? { taskType, provider: r.provider, model: r.model, score: r.score } : null;
}

const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// LAUNCH → JUDGED TRIAL (#4290) — a probation launch row becomes a trial once its PR's review verdict lands.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The rubric/kind every converted trial row carries — distinct from the launch row it judges. */
export const PROBATION_TRIAL_RUBRIC = 'probation-trial.1';
export const PROBATION_TRIAL_KIND = 'probation-trial';

/** The key tying a trial back to its launch: the launch's session handle and PR. PURE. */
const launchKey = (r) => JSON.stringify([r?.handle ?? null, r?.pr ?? null]);

/** Launches that already have a judged trial on record. PURE. */
function judgedLaunchKeys(rows) {
  return new Set(rows.filter((r) => r?.dispatchKind === PROBATION_TRIAL_KIND).map(launchKey));
}

/**
 * Launch rows still waiting for a verdict: the worker's heal was PUSHED (`launchOutcome: 'healed'` — anything
 * else never reached a review, so no verdict will ever judge it), the row names a PR, and no trial row for the
 * same `{handle, pr}` exists yet. The last clause is what makes the sweep idempotent. PURE.
 * @param {Array<object>} records
 * @returns {object[]}
 */
export function pendingProbationLaunches(records) {
  const rows = Array.isArray(records) ? records : [];
  const judged = judgedLaunchKeys(rows);
  return rows.filter((r) => r?.dispatchKind === 'probation-launch' && r.outcome == null && r.launchOutcome === 'healed'
    && Number.isInteger(r.pr) && r.pr > 0 && !judged.has(launchKey(r)));
}

/**
 * The trial outcome a PR's current state implies, or `null` while no verdict has landed. PURE.
 *   - merged → `landed`; closed unmerged → `rejected`;
 *   - open with `review:changes` → `reworked` (the review sent it back);
 *   - anything else (pending, accepted-but-not-merged, parked to a human) → `null`, judged on a later sweep.
 * @param {{state?: string, mergedAt?: string|null, labels?: Array<string|{name: string}>}|null} pr
 * @param {{launchScoredAt?: string|null}} [options] - label verdicts must postdate this launch;
 *   omitted retains the historical pure-call behavior. Merge/close outcomes are unaffected.
 * @returns {'landed'|'reworked'|'rejected'|null}
 */
export function trialOutcomeFromPr(pr, { launchScoredAt } = {}) {
  if (!pr || typeof pr !== 'object') return null;
  const state = String(pr.state ?? '').toUpperCase();
  if (state === 'MERGED' || (typeof pr.mergedAt === 'string' && pr.mergedAt)) return 'landed';
  if (state === 'CLOSED') return 'rejected';
  const labels = (Array.isArray(pr.labels) ? pr.labels : []).map((l) => (typeof l === 'string' ? l : l?.name));
  if (launchScoredAt !== undefined && !(Date.parse(pr.reviewLabelAt) > Date.parse(launchScoredAt))) return null;
  return labels.includes('review:changes') ? 'reworked' : null;
}

/**
 * The judged trial row for one launch. PURE. `verifiedBy` is the independent review that produced the verdict;
 * `informative` is written `false`, never inferred from the outcome — a confirmed catch is recorded by hand.
 * `filesTouched` is the PR's changed files, so `critical-work.mjs#isCriticalMiss` judges a miss on its real scope
 * rather than failing closed for lack of one; `criticalMiss` stamps that answer on the row.
 * @param {object} launch - a `probation-launch` row.
 * @param {{outcome: 'landed'|'reworked'|'rejected', changedFiles?: string[]|null, scoredAt?: string,
 *   reviewed?: boolean, isCriticalMiss: (row: object) => boolean}} o
 */
export function judgedTrialRow(launch, { outcome, changedFiles = null, scoredAt, reviewed = false, isCriticalMiss }) {
  if (!['landed', 'reworked', 'rejected'].includes(outcome)) {
    throw new TypeError(`model-probation: a judged trial needs outcome landed|reworked|rejected, got ${JSON.stringify(outcome)}`);
  }
  if (typeof isCriticalMiss !== 'function') throw new TypeError('model-probation: isCriticalMiss evaluator is required');
  const files = Array.isArray(changedFiles) ? changedFiles.filter((f) => typeof f === 'string' && f) : null;
  const row = {
    rubricVersion: PROBATION_TRIAL_RUBRIC,
    provider: launch.provider,
    model: launch.model,
    subjectClass: 'work-agent',
    dispatchKind: PROBATION_TRIAL_KIND,
    taskType: launch.taskType,
    criteriaEvaluated: 0,
    score: null,
    deductions: [],
    outcome,
    verifiedBy: outcome === 'landed' && !reviewed ? 'unreviewed-merge' : 'independent-claude',
    informative: false,
    executor: launch.executor ?? null,
    worker: launch.worker ?? null,
    pr: launch.pr,
    repo: launch.repo ?? null,
    handle: launch.handle ?? null,
    item: launch.item ?? null,
    changedFiles: files,
    ...(files ? { filesTouched: files } : {}),
    ...(scoredAt ? { scoredAt } : {}),
  };
  return { ...row, criticalMiss: isCriticalMiss(row) === true };
}

/**
 * THE SWEEP: judge every pending launch whose PR now carries a verdict, appending one trial row each. The IO is
 * handed in (`lookupPr` → `{state, mergedAt, labels, files, changedFiles, reviewLabelAt}` or `null`; `append` writes one row). A lookup that
 * fails leaves the launch pending for the next sweep — never a guessed outcome. Promotion is untouched: this only
 * adds evidence rows, it never writes the registry. `reviewLabelAt` is the newest labeled-event time
 * for the current verdict label. Launches are scored at PR opening, before review; re-armed earlier
 * labels stay pending until a fresh event. Missing/invalid timestamps fail closed.
 * Null/throwing lookups are `failed`; a null append is `skipped` (a concurrent sweep already judged it).
 * @param {Array<object>} records
 * @param {{lookupPr: (launch: object) => object|null, append?: (row: object) => object|null|void,
 *   isCriticalMiss?: (row: object) => boolean, now?: () => string}} io
 * @returns {{judged: object[], pending: object[], failed: object[], skipped: object[]}}
 */
export function judgePendingTrials(records, { lookupPr, append = () => {}, isCriticalMiss = classifyCriticalMiss, now = () => new Date().toISOString() }) {
  const judged = [];
  const pending = [];
  const failed = [];
  const skipped = [];
  for (const launch of pendingProbationLaunches(records)) {
    let pr = null;
    try { pr = lookupPr(launch); } catch { pr = null; }
    if (!pr) { failed.push(launch); continue; }
    const outcome = trialOutcomeFromPr(pr, { launchScoredAt: launch.scoredAt ?? null });
    const labels = (Array.isArray(pr.labels) ? pr.labels : []).map(l => typeof l === 'string' ? l : l?.name);
    const reviewed = labels.includes('review:accepted');
    if (!outcome || (outcome === 'landed' && !reviewed)) { pending.push(launch); continue; }
    const complete = Array.isArray(pr.files) && pr.files.length < 100
      && (pr.changedFiles === undefined || pr.changedFiles === pr.files.length);
    const files = complete ? pr.files.map(f => typeof f === 'string' ? f : f?.path) : null;
    const row = judgedTrialRow(launch, { outcome, reviewed, changedFiles: files, scoredAt: now(), isCriticalMiss });
    if (append(row) === null) { skipped.push(launch); continue; }
    judged.push(row);
  }
  return { judged, pending, failed, skipped };
}

/** Read the PR and paginated label history. Any failed call propagates as a failed lookup. */
function lookupPrWithGh(launch) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 };
  const pr = JSON.parse(execFileSync('gh', [
    'pr', 'view', String(launch.pr), ...(launch.repo ? ['--repo', launch.repo] : []),
    '--json', 'state,mergedAt,labels,files,changedFiles',
  ], options));
  // --slurp preserves page boundaries as valid JSON, including more than one REST page.
  const pages = JSON.parse(execFileSync('gh', [
    'api', '--paginate', '--slurp', `repos/${launch.repo || '{owner}/{repo}'}/issues/${launch.pr}/events`,
  ], options));
  const labels = (pr.labels ?? []).map(l => typeof l === 'string' ? l : l?.name);
  const verdictLabel = labels.includes('review:changes') ? 'review:changes' : 'review:accepted';
  const events = pages.flat().filter(e => e.event === 'labeled' && e.label?.name === verdictLabel
    && labels.includes(e.label.name) && Number.isFinite(Date.parse(e.created_at)));
  pr.reviewLabelAt = events.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.created_at;
  return pr;
}

/** Run the judge command with injectable lookup, store IO and logging; never modifies the registry. */
export function runJudge({ lookupPr = lookupPrWithGh, io = {}, dryRun = false, log = console.log } = {}) {
  const { judged, pending, failed } = judgePendingTrials(readStore(io).records, {
    lookupPr, append: dryRun ? () => {} : row => appendScorecardUnlessJudged(row, io),
  });
  for (const t of judged) log(`${dryRun ? '(dry run) ' : ''}PR #${t.pr} ${t.provider}/${t.model} · ${t.taskType}: ${t.outcome}${t.criticalMiss ? ' (critical miss)' : ''}`);
  const result = { judged: judged.length, pending: pending.length, failed: failed.length };
  log(`${result.judged} judged, ${result.pending} awaiting a verdict, ${result.failed} lookups failed`);
  return result;
}

/**
 * PROGRESS AGAINST {@link GRADUATION_NUMBERS}, per `{provider, model, taskType}`. PURE: rows and the critical-miss
 * reader are handed in (the CLI reads the shared scorecard store and imports `critical-work.mjs`).
 * @param {Array<object>} records - the scorecard store's rows.
 * @param {{numbers?: object, criticalMissesFor?: (rows: object[], taskType: string) => object[],
 *   registry?: {entries: object[]}}} [o]
 * @returns {{numbers: object, triples: object[], providers: object[]}}
 */
export function graduationProgress(records, { numbers = GRADUATION_NUMBERS, criticalMissesFor = null, registry = { entries: [] } } = {}) {
  const rows = Array.isArray(records) ? records : [];
  const groups = new Map();
  for (const r of rows.filter(isWorkTrialRow)) {
    const key = JSON.stringify([r.provider, r.model, r.taskType]);
    if (!groups.has(key)) groups.set(key, { provider: r.provider, model: r.model, taskType: r.taskType, rows: [] });
    groups.get(key).rows.push(r);
  }
  const ratings = rows.map(ratingOf).filter(Boolean);
  const judgedLaunches = judgedLaunchKeys(rows);
  const triples = [...groups.values()].map((g) => {
    const judged = g.rows.filter((r) => r.outcome != null);
    const verified = judged.filter((r) => COUNTED_VERIFIERS.includes(r.verifiedBy));
    const launched = g.rows.filter((r) => r.dispatchKind === 'probation-launch' && r.outcome == null && !judgedLaunches.has(launchKey(r))).length;
    const outcomes = {};
    for (const r of judged) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    const informative = verified.filter((r) => r.informative === true).length;
    // Fail closed: no reader means the veto cannot be evaluated, never "zero misses".
    const misses = typeof criticalMissesFor === 'function'
      ? criticalMissesFor(g.rows, g.taskType).filter((m) => m.provider === g.provider && m.model === g.model).length
      : null;
    const own = mean(ratings.filter((x) => x.taskType === g.taskType && x.provider === g.provider && x.model === g.model).map((x) => x.score));
    const claude = mean(ratings.filter((x) => x.taskType === g.taskType && CLAUDE_PROVIDERS.includes(x.provider)).map((x) => x.score));
    const ratingStatus = own == null || claude == null ? 'not-measured' : own >= claude ? 'met' : 'not-met';
    const criteria = {
      trials: { have: verified.length, need: numbers.minTrials, met: verified.length >= numbers.minTrials },
      informative: { have: informative, need: numbers.minInformative, met: informative >= numbers.minInformative },
      criticalMisses: { have: misses, max: numbers.maxCriticalMisses, met: misses != null && misses <= numbers.maxCriticalMisses },
      runRating: { own, claude, status: ratingStatus, met: ratingStatus === 'met' },
    };
    const eligible = Object.values(criteria).every((c) => c.met);
    return {
      provider: g.provider, model: g.model, taskType: g.taskType,
      status: statusFor(registry, { provider: g.provider, model: g.model, role: 'delivery' }),
      recorded: g.rows.length, judged: judged.length, verified: verified.length, launched, outcomes, criteria,
      eligibleForPromotionReview: eligible,
      next: eligible
        ? 'Eligible for a promotion review — promotion stays an explicit human decision.'
        : Object.entries(criteria).filter(([, c]) => !c.met).map(([k, c]) => (
          k === 'trials' ? `${c.need - c.have} more verified trial(s)`
            : k === 'informative' ? 'one informative trial (a confirmed catch or a documented severity disagreement)'
              : k === 'criticalMisses' ? (c.have == null ? 'a critical-miss reader (not supplied, so the veto cannot be checked)' : `${c.have} critical miss(es) on record — a veto`)
                : c.status === 'not-measured' ? 'run ratings for this worker and for Claude on this task type' : 'a run rating no worse than Claude\'s'
        )).join('; '),
    };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.taskType.localeCompare(b.taskType));
  const byProvider = new Map();
  for (const t of triples) {
    const p = byProvider.get(t.provider) ?? { provider: t.provider, recorded: 0, byTaskType: {} };
    p.recorded += t.recorded;
    const tt = p.byTaskType[t.taskType] ?? { recorded: 0, outcomes: {} };
    tt.recorded += t.recorded;
    for (const [o, n] of Object.entries(t.outcomes)) tt.outcomes[o] = (tt.outcomes[o] ?? 0) + n;
    p.byTaskType[t.taskType] = tt;
    byProvider.set(t.provider, p);
  }
  return { numbers, triples, providers: [...byProvider.values()] };
}

/** Plain-text rendering of {@link graduationProgress}. PURE. */
export function renderGraduationProgress(report, { openedTaskTypes = [] } = {}) {
  const n = report.numbers;
  const lines = [
    `Probation graduation progress (numbers decided ${n.decidedOn}: >=${n.minTrials} verified trials, >=${n.minInformative} informative, ${n.maxCriticalMisses} critical misses, run rating no worse than Claude; promotion = ${n.promotion})`,
    '',
    'Evidence by provider (work rows with a task type):',
  ];
  for (const p of report.providers) {
    const parts = Object.entries(p.byTaskType).sort(([a], [b]) => a.localeCompare(b))
      .map(([tt, v]) => `${tt} ${v.recorded}${Object.keys(v.outcomes).length ? ` (${Object.entries(v.outcomes).map(([o, c]) => `${c} ${o}`).join(', ')})` : ''}`);
    lines.push(`  ${p.provider}: ${p.recorded} — ${parts.join('; ')}`);
  }
  for (const tt of openedTaskTypes) {
    if (!report.triples.some((t) => t.taskType === tt)) lines.push(`  (${tt}, opened on probation: 0 trials by any provider)`);
  }
  lines.push('', 'Per task type x provider/model:');
  for (const t of report.triples) {
    const c = t.criteria;
    lines.push(`  ${t.provider}/${t.model} · ${t.taskType} [${t.status}] — trials ${c.trials.have}/${c.trials.need}, informative ${c.informative.have}/${c.informative.need}, critical misses ${c.criticalMisses.have == null ? 'unknown (critical-miss reader not supplied)' : c.criticalMisses.have}, run rating ${c.runRating.status}${t.launched ? `, ${t.launched} launched awaiting review` : ''}`);
    lines.push(`      next: ${t.next}`);
  }
  return lines.join('\n');
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_CLI) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'report' && cmd !== 'judge') {
    console.error('usage: node scripts/lib/model-probation.mjs report [--json] [--store=<path>]\n'
      + '       node scripts/lib/model-probation.mjs judge [--dry-run] [--store=<path>]   (launches whose review landed → judged trials)');
    process.exit(2);
  }
  const storeFlag = rest.find((a) => a.startsWith('--store='));
  if (cmd === 'judge') {
    runJudge({ io: storeFlag ? { path: storeFlag.slice('--store='.length) } : {}, dryRun: rest.includes('--dry-run') });
    process.exit(0);
  }
  const [{ resolveScorecardStorePath }, { criticalMissesFor }, { CRITICAL_WORK_GATE }] = await Promise.all([
    import('../conveyor/run-scorecard-store.mjs'), import('./critical-work.mjs'), import('./provider-routing.mjs'),
  ]);
  const path = storeFlag ? storeFlag.slice('--store='.length) : resolveScorecardStorePath();
  let records = [];
  // Read-only: parse the file directly (never the store's migrating reader).
  try { records = JSON.parse(readFileSync(path, 'utf8')).records ?? []; } catch { records = []; }
  const report = graduationProgress(records, { criticalMissesFor, registry: readRegistry() });
  const opened = Object.entries(CRITICAL_WORK_GATE.openForNonCritical).filter(([, v]) => v === true).map(([k]) => k);
  if (rest.includes('--json')) console.log(JSON.stringify({ store: path, openedTaskTypes: opened, ...report }, null, 2));
  else console.log(`${renderGraduationProgress(report, { openedTaskTypes: opened })}\n\n(store: ${path}; opened on probation: ${opened.join(', ')})`);
}
