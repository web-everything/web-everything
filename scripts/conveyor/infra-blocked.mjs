#!/usr/bin/env node
/**
 * @file scripts/conveyor/infra-blocked.mjs
 * @description The CONVEYOR INFRA-BLOCKED STATE + auto-retry/resume loop (WE #2659, epic #2612). Owns the
 *   recovery of a PRE-PR infra failure: a delivery / prepare agent that BUILT successfully and already PUSHED
 *   its `lane/*` ref, but whose `gh pr create` then failed on an OUTSIDE dependency (a GitHub partial outage,
 *   a network fault). Before this, that built-and-pushed work was stranded with nowhere to be tracked — it is
 *   neither a review-park, a stall, nor gate-red, and the PR watcher (`pr-watch.mjs`) can't see it because no
 *   PR exists to watch. This module makes it a FIRST-CLASS state: the pushed handle is recorded so nothing is
 *   lost, an idempotent exponential-backoff retry loop resume-opens the PR once infra recovers, and after an
 *   attempt cap it surfaces to the operator. It NEVER merges the lane locally — the drain stays the sole writer
 *   to `main` (memory rule 104); "resume" only re-invokes the producer (`pr-land`), which itself never merges.
 *
 *   Grounded in the 2026-07-24 GitHub Partial System Outage that blocked #2654's PR-open — the incident that
 *   motivated this story.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors queue-store.mjs #2613 and conveyor-state.mjs #2611): the PURE core
 *   (`classifyPrOpenFailure` / `correlateCause` / `backoffMs` / `retryDecision` / `parseInfraStore` /
 *   `recordInfraBlock` / `markRetryAttempt` / `removeInfraBlock` / `deriveInfraByNum` / `serializeInfraStore`)
 *   has NO fs / clock / gh / network — callers inject the file text, an ISO `now`, and (for correlation) an
 *   already-fetched GitHub-status object. The thin fs/IO shell (`infraStorePath` / `resolveInfraStorePath` /
 *   `readInfraStore` / `writeInfraStore` / `recordInfraBlockIO` / `fetchGithubStatus` / the `main()` CLI) owns
 *   the boundary and is used by `pr-land.mjs` (records a block at the failed open) and by the /conveyor tick
 *   (`retry` — one resume pass per tick, the chained-sleep heartbeat IS the loop clock, no internal busy-loop).
 *
 * WHERE THE STORE LIVES — the PRIMARY checkout's session sidecar (`<primary>/.conveyor/infra-blocked.json`),
 *   gitignored like the conveyor queue (#2613) and the drain's `queued.json`. It is SESSION-LOCAL operational
 *   recovery state, never committed. `pr-land` runs in a LANE clone but writes the record into the PRIMARY (via
 *   the clone's git alternates — the same primary-root resolution `pr-land`'s `syncPrimaryMain` uses), because
 *   the /conveyor tick that runs the retry pass reads from the primary. The path resolves by SCRIPT LOCATION
 *   (never CWD) so writer and readers can't diverge; `CONVEYOR_INFRA_FILE` overrides it (tests + out-of-tree).
 *
 * SHAPE: a JSON ARRAY of entries, one per infra-blocked item:
 *   `{ num, ref, sha, base, cause, body, attempt, firstFailedAt, lastAttemptAt, nextRetryAt }`
 *   — `num` the backlog id (numeric run or JIT hash), `ref`/`sha`/`base` the RESUMABLE handle (the pushed lane
 *   ref, its tip, and the PR base), `cause` the failure CLASS shown to the operator (e.g. "GitHub outage"),
 *   `body` the PR body to re-open with (so nothing is lost), `attempt` the count of open attempts that have
 *   FAILED so far (the initial failed open is attempt 1), and the ISO clocks. A hand-edited / corrupt sidecar
 *   parses tolerantly to `[]` so a bad file never wedges a tick.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { normNum } from './queue-store.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
// #4348-open-pr-retry addendum — the SAME reason→bucket table `open-pr.mjs`'s own operation already declares
// (`unverified`/`check-red`/`bad-ref`/… → `refused`; `blocked-on-infra`/`gh-error`/… → `unrun`), reused here
// rather than re-derived: `resumeOpen` needs the identical "did a guard answer, or did the environment simply
// fail to run" split, for the identical reason (never let a fixable refusal masquerade as an unresolved outage).
// Imported from the table's LEAF, never `open-pr.mjs` itself: this module is in the driver-watchdog's pinned
// import graph, which must not pull in the operation registry (`driver-watchdog.test.mjs`).
import { HOME_REASONS } from '../operations/pr-land-reasons.mjs';

// ── TUNING (exported so a caller/test can override; the conveyor tick uses the defaults) ──────────────────────
import { canonicalizeSlug } from '../lib/constellation-repos.mjs';

/** Backoff base: the wait after the FIRST failure before the first retry (30s). */
export const DEFAULT_BASE_MS = 30_000;
/** Backoff multiplier per attempt (doubling). */
export const DEFAULT_FACTOR = 2;
/** Backoff ceiling: no single wait exceeds 30 min however many attempts have failed. */
export const DEFAULT_CAP_MS = 30 * 60_000;
/** Attempt cap: after this many FAILED open attempts, stop auto-retrying and SURFACE to the operator. */
export const DEFAULT_MAX_ATTEMPTS = 6;
/** Refusal wait: a FIXED interval between resumes that a guard REFUSED (no doubling — waiting does not fix a
 *  refusal, this only stops a zero-delay loop against git/GitHub). */
export const DEFAULT_REFUSAL_INTERVAL_MS = 5 * 60_000;
/** Refusal cap: after this many consecutive refusals (~1h at the interval above), SURFACE to the operator. Its
 *  own budget, separate from {@link DEFAULT_MAX_ATTEMPTS} — see {@link markRefusedAttempt}. */
export const DEFAULT_MAX_REFUSALS = 12;

// ── PURE CORE (no fs / clock / gh / network — every input is injected) ────────────────────────────────────────

/** ms since epoch for an ISO string (or a number passed through), NaN-safe → 0. */
function toMs(iso) {
  if (iso == null) return 0;
  if (typeof iso === 'number') return Number.isFinite(iso) ? iso : 0;
  const t = Date.parse(String(iso));
  return Number.isNaN(t) ? 0 : t;
}
const iso = (ms) => new Date(ms).toISOString();

/**
 * Classify a `gh pr create` (or other post-push PR-open) failure into "is this a RETRYABLE outside-dependency
 * outage, and what's its class?". CONSERVATIVE by design: only KNOWN-transient signatures count as infra — a
 * genuine error (a validation failure, a bad/empty body, an auth problem, "a pull request already exists") is
 * NOT infra, so the caller falls through to its normal hard-fail rather than looping a doomed retry forever.
 * Pure — takes the error text, returns `{ infra, cause }` (cause is the failure CLASS, or null when not infra).
 * @param {string|null|undefined} text  the `gh`/git stderr+message
 * @returns {{infra:boolean, cause:(string|null)}}
 */
export function classifyPrOpenFailure(text) {
  const s = String(text ?? '').toLowerCase();
  if (!s.trim()) return { infra: false, cause: null };
  // Rate limiting — transient, clears on backoff (distinct class so the operator sees WHY).
  if (/\b(rate limit|secondary rate|abuse detection|api rate)\b/.test(s)) return { infra: true, cause: 'GitHub rate limit' };
  // GitHub 5xx / service degradation — the #2654 partial-outage class. A BARE 50x number is NOT enough (it would
  // misread "502 bytes" / "code 509" in an unrelated error as an outage → a doomed retry loop): the numeric form
  // must sit in an HTTP/status/GraphQL CONTEXT, alongside the named-phrase forms which are unambiguous on their own.
  if (
    /(?:\bhttps?\b|\bstatus(?:\s*code)?\b|\bgraphql\b)[^\n]{0,12}\b50[0-9]\b/.test(s) ||
    /\b50[0-9]\b[^\n]{0,12}(?:service unavailable|bad gateway|gateway time|internal server|server error)/.test(s) ||
    /internal server error|bad gateway|service unavailable|gateway time-?out|temporarily unavailable|github is (?:currently )?(?:un)?available|server error/.test(s)
  ) {
    return { infra: true, cause: 'GitHub outage' };
  }
  // Network / DNS / connection faults — transient reachability, not a real refusal.
  if (/could not resolve host|connection reset|econnreset|etimedout|timed out|timeout|network is unreachable|eai_again|connection refused|econnrefused|dial tcp|tls handshake|network error/.test(s)) {
    return { infra: true, cause: 'network' };
  }
  return { infra: false, cause: null };
}

/**
 * Refine a classified failure CAUSE against a fetched GitHub-status object — "tell a real outage from a one-off
 * failure" (#2659). Pure: the fetch happens in the IO shell (`fetchGithubStatus`); this only reads the result.
 *   • A live incident (`indicator` minor/major/critical) → "GitHub outage" — a REAL, wide outage.
 *   • Status page UNREACHABLE → keep a network-class cause (our own connectivity is the suspect).
 *   • Reachable + `none` (all systems operational) → the failure was a ONE-OFF, not a broad outage; tag the
 *     classified cause `(transient)` so the operator can read "this wasn't GitHub-wide".
 * @param {string} classified  the {@link classifyPrOpenFailure} cause
 * @param {{reachable?:boolean, indicator?:string}|null|undefined} githubStatus
 * @returns {string}
 */
export function correlateCause(classified, githubStatus) {
  const base = classified || 'infra';
  if (!githubStatus || typeof githubStatus !== 'object') return base;
  const indicator = String(githubStatus.indicator || '').toLowerCase();
  if (['minor', 'major', 'critical'].includes(indicator)) return 'GitHub outage';
  if (githubStatus.reachable === false) return base === 'GitHub outage' ? 'network' : base;
  // reachable + operational (indicator 'none'/absent) → the open failure was a one-off, not a wide outage.
  if (githubStatus.reachable === true) return /transient/.test(base) ? base : `${base} (transient)`;
  return base;
}

/**
 * Cluster same-cause external failures into ONE group per cause (#2661) — the "N lanes down on ONE outage is
 * ONE degraded-infra signal, not N alarms" primitive. Takes members each carrying a `cause` (an already-classified
 * / correlated failure class, e.g. "GitHub outage") plus an identity (`lane` / `num`); groups by the EXACT cause
 * string, and returns one `{ cause, count, members }` per distinct cause. A blank/absent cause folds to `'infra'`
 * so an un-labelled block never fragments the cluster. Deterministic order — most-affected cause first, then cause
 * name (stable) — so the caller renders/notes the widest outage first. Pure: no fs / clock / network (the caller
 * supplies already-refined causes; correlation against githubstatus happens upstream in {@link correlateCause}).
 * @param {Array<{cause?:string, lane?:*, num?:*}>|null|undefined} members
 * @returns {Array<{cause:string, count:number, members:Array<{lane:*, num:(string|null)}>}>}
 */
export function clusterByCause(members) {
  const groups = new Map();
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m !== 'object') continue;
    const cause = String(m.cause || 'infra').trim() || 'infra';
    if (!groups.has(cause)) groups.set(cause, []);
    groups.get(cause).push({ lane: m.lane ?? null, num: m.num != null ? String(m.num) : null });
  }
  const out = [];
  for (const [cause, list] of groups) out.push({ cause, count: list.length, members: list });
  out.sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
  return out;
}

/**
 * The backoff wait (ms) BEFORE the retry that follows a given failed attempt. `attempt` is 1-based (1 = the
 * initial failed open): wait = min(cap, base · factor^(attempt-1)). Deterministic (no jitter) so the retry
 * schedule is unit-testable; the conveyor tick's own cadence supplies the real-world spread.
 * @param {number} attempt  the 1-based number of the attempt that just failed
 * @returns {number} ms to wait before the next retry
 */
export function backoffMs(attempt, { baseMs = DEFAULT_BASE_MS, factor = DEFAULT_FACTOR, capMs = DEFAULT_CAP_MS } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const raw = baseMs * Math.pow(factor, n - 1);
  return Math.min(capMs, Math.max(0, raw));
}

/**
 * Tolerant parse of the `.conveyor/infra-blocked.json` text → a normalized entry array. NEVER throws: empty /
 * whitespace / bad JSON / a `{ blocked:[...] }` wrapper all degrade to `[]` (a corrupt sidecar must never wedge
 * a retry tick). Drops rows with no usable `num`; dedups by {@link normNum} (first wins).
 * @param {string|null|undefined} text
 * @returns {Array<object>}
 */
export function parseInfraStore(text) {
  if (!text || !String(text).trim()) return [];
  let raw;
  try { raw = JSON.parse(text); } catch { return []; }
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.blocked) ? raw.blocked : [];
  const seen = new Set();
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const key = normNum(e.num);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({
      num: String(e.num),
      ref: e.ref != null ? String(e.ref) : null,
      sha: e.sha != null ? String(e.sha) : null,
      base: e.base != null ? String(e.base) : 'main',
      // repo slug (e.g. "plateauapp/plateau-app") — which repo the pushed ref lives in. Absent → the WE repo (the
      // single-locus common case). Carried so a cross-locus couple's impl-half block is never resumed against the
      // WRONG repo (the resume guards on it) and the shape is couple-ready (#2659 review, finding 2).
      repo: e.repo != null ? String(e.repo) : null,
      cause: e.cause != null ? String(e.cause) : 'infra',
      body: typeof e.body === 'string' ? e.body : null,
      ...(typeof e.builderContext === 'string' ? { builderContext: e.builderContext } : {}),
      attempt: Number.isFinite(Number(e.attempt)) ? Math.max(1, Math.floor(Number(e.attempt))) : 1,
      refusals: Number.isFinite(Number(e.refusals)) ? Math.max(0, Math.floor(Number(e.refusals))) : 0,
      firstFailedAt: e.firstFailedAt != null ? String(e.firstFailedAt) : null,
      lastAttemptAt: e.lastAttemptAt != null ? String(e.lastAttemptAt) : null,
      nextRetryAt: e.nextRetryAt != null ? String(e.nextRetryAt) : null,
    });
  }
  return out;
}

/** Is `num` recorded as infra-blocked? Pure membership read (normalized). */
export function infraHas(store, num) {
  const key = normNum(num);
  if (key === '') return false;
  return (Array.isArray(store) ? store : []).some((e) => normNum(e?.num) === key);
}

/**
 * Record an infra-block for `num` — IDEMPOTENT (mirrors `addToQueue`): re-recording an already-blocked item
 * returns the store UNCHANGED (the retry loop, not a re-record, owns attempt progression — a second failed open
 * for the same still-blocked item must not reset its backoff or double-count). A blank/nullish `num`, or a
 * record carrying no resumable `ref`, is a no-op (nothing to resume → nothing to track). On a fresh record:
 * `attempt = 1`, `firstFailedAt = lastAttemptAt = now`, `nextRetryAt = now + backoff(1)`. `now` is injected.
 * @returns {Array<object>} a NEW array (never mutates the input)
 */
export function recordInfraBlock(store, { num, ref, sha = null, base = 'main', repo = null, cause = 'infra', body = null, builderContext = null } = {}, now = Date.now(), backoff = {}) {
  const s = Array.isArray(store) ? store : [];
  if (normNum(num) === '' || !ref) return s;
  if (infraHas(s, num)) {
    // idempotent — already tracked; the retry loop owns its progression. EXCEPT a re-record carrying a NEW
    // verified sha (the lane was rebuilt + re-pushed, and that open failed too): the resume pins to the recorded
    // sha (`resumeShaDecision`), so keeping the old one would refuse `sha-moved` until the refusal cap. Take the
    // new handle and clear the refusal count; the infra attempt budget is left alone.
    const key = normNum(num);
    const cur = s.find((e) => normNum(e?.num) === key);
    if (sha == null || String(sha) === String(cur?.sha ?? '')) return s;
    return s.map((e) => (normNum(e?.num) === key
      ? { ...e, ref: String(ref), sha: String(sha), body: typeof body === 'string' ? body : e.body, builderContext, refusals: 0 }
      : e));
  }
  const nowMs = toMs(now) || Number(now) || Date.now();
  const entry = {
    num: String(num),
    ref: String(ref),
    sha: sha != null ? String(sha) : null,
    base: String(base || 'main'),
    repo: repo != null ? String(repo) : null,
    cause: String(cause || 'infra'),
    body: typeof body === 'string' ? body : null,
    ...(typeof builderContext === 'string' ? { builderContext } : {}),
    attempt: 1,
    refusals: 0,
    firstFailedAt: iso(nowMs),
    lastAttemptAt: iso(nowMs),
    nextRetryAt: iso(nowMs + backoffMs(1, backoff)),
  };
  return [...s, entry];
}

/**
 * Advance an entry after a RESUME ATTEMPT FAILED (the retry loop): `attempt += 1`, `lastAttemptAt = now`,
 * `nextRetryAt = now + backoff(attempt)` (the doubled wait), and optionally update `cause` (a correlation
 * refinement). A no-op if `num` is absent. Returns a new array. `now` injected.
 * @returns {Array<object>}
 */
export function markRetryAttempt(store, num, now = Date.now(), { cause, backoff = {} } = {}) {
  const key = normNum(num);
  const nowMs = toMs(now) || Number(now) || Date.now();
  return (Array.isArray(store) ? store : []).map((e) => {
    if (normNum(e?.num) !== key) return e;
    const attempt = Math.max(1, Math.floor(Number(e.attempt) || 1)) + 1;
    return {
      ...e,
      cause: cause != null ? String(cause) : e.cause,
      attempt,
      refusals: 0, // the refusal cap counts CONSECUTIVE refusals — an infra failure in between breaks the run
      lastAttemptAt: iso(nowMs),
      nextRetryAt: iso(nowMs + backoffMs(attempt, backoff)),
    };
  });
}

/**
 * #4348-open-pr-retry addendum — advance an entry after a resume was REFUSED (a guard answered — `unverified`,
 * `check-red`, `bad-ref`, …), NOT after an infra failure. Unlike {@link markRetryAttempt}, `attempt` is left
 * UNCHANGED: only the passage of time (or a genuine outside-dependency recovery) ever resolves an infra block,
 * which is what the attempt cap + exponential backoff exist to bound, but NOTHING about waiting resolves a
 * refusal — only a code or data change does. Reusing the SAME budget for both meant a handful of refusals (a bug
 * like #4348's own missing `--no-require-verified`) could burn the entire cap and strand a build whose lane ref
 * was already pushed — confirmed live: #4348 hit `attempt: 6` and surfaced while `unverified` was the true, and
 * only, cause every single time.
 *
 * A refusal is still BOUNDED, by its own budget (PR #2899 review): `refusals += 1` and `nextRetryAt = now +
 * refusalIntervalMs` (a FIXED wait, no doubling). A refused resume is not free — every one does a `git fetch`
 * and spawns pr-land, and several refusal reasons (`check-red`, `pr-limit`, `behind`, `conflict`) answer only
 * after a gh call — so a zero-delay retry would loop against git/GitHub every tick. After
 * {@link DEFAULT_MAX_REFUSALS} consecutive refusals {@link retryDecision} surfaces the entry (`refusal-cap`)
 * for the operator, exactly as the attempt cap does; `rearm` clears both counters. `cause` becomes the refusal's
 * own reason, for observability. A no-op if `num` is absent. Returns a new array. `now` injected.
 * @returns {Array<object>}
 */
export function markRefusedAttempt(store, num, now = Date.now(), { reason = 'refused', refusalIntervalMs = DEFAULT_REFUSAL_INTERVAL_MS } = {}) {
  const key = normNum(num);
  const nowMs = toMs(now) || Number(now) || Date.now();
  return (Array.isArray(store) ? store : []).map((e) => {
    if (normNum(e?.num) !== key) return e;
    const refusals = Math.max(0, Math.floor(Number(e.refusals) || 0)) + 1;
    return { ...e, cause: String(reason || 'refused'), refusals, lastAttemptAt: iso(nowMs), nextRetryAt: iso(nowMs + refusalIntervalMs) };
  });
}

/** Update only the `cause` of an entry (a correlation refinement that did not consume a retry). Pure. */
export function updateCause(store, num, cause) {
  const key = normNum(num);
  return (Array.isArray(store) ? store : []).map((e) => (normNum(e?.num) === key ? { ...e, cause: String(cause || e.cause) } : e));
}

/** Remove `num` from the store — the success path (the PR resume-opened) or a manual clear. No-op if absent. */
export function removeInfraBlock(store, num) {
  const key = normNum(num);
  if (key === '') return Array.isArray(store) ? store : [];
  return (Array.isArray(store) ? store : []).filter((e) => normNum(e?.num) !== key);
}

/**
 * #4348-open-pr-retry addendum — the SANCTIONED escape hatch for an entry that hit `attempt >= maxAttempts`
 * (surfaced) BEFORE {@link markRefusedAttempt} existed, so its stored `attempt` count was inflated by resumes
 * that were never actually infra failures (#4348's own live case: all 6 recorded attempts were `unverified`
 * refusals, a bug this PR also fixes — see `resumeOpen`'s own `--no-require-verified` addition). Resets
 * `attempt` to 1 and `nextRetryAt` to `now` (immediately eligible again) so the NEXT retry pass tries it once
 * more under the corrected code; `firstFailedAt`/`ref`/`sha`/`base`/`repo`/`body` — the actual resumable handle
 * — are left untouched, because nothing about them was ever wrong. Deliberately narrow: this is a rearm, never
 * a record write — it does not (and must not) resurrect a record that was already removed. No-op (same array
 * reference) if `num` is absent, matching {@link removeInfraBlock}'s own convention. `now` injected.
 * @returns {Array<object>}
 */
export function rearmInfraBlock(store, num, now = Date.now()) {
  const key = normNum(num);
  const s = Array.isArray(store) ? store : [];
  if (key === '' || !infraHas(s, key)) return s;
  const nowMs = toMs(now) || Number(now) || Date.now();
  return s.map((e) => (normNum(e?.num) === key ? { ...e, attempt: 1, refusals: 0, lastAttemptAt: iso(nowMs), nextRetryAt: iso(nowMs) } : e));
}

/** Serialize the store back to `.conveyor/infra-blocked.json` text (a bare JSON array, newline-terminated). */
export function serializeInfraStore(store) {
  return JSON.stringify(Array.isArray(store) ? store : [], null, 2) + '\n';
}

/**
 * The retry decision for ONE entry, given the clock. Pure state machine:
 *   • `attempt >= maxAttempts` → **surface** — the attempt cap is hit; STOP auto-retrying and hand to the
 *     operator (never loop a doomed resume forever).
 *   • `refusals >= maxRefusals` → **surface** — a guard kept refusing the resume; same hand-off, own budget.
 *   • `now >= nextRetryAt`     → **retry** — the backoff has elapsed; attempt a resume-open this pass.
 *   • otherwise                → **wait**  — still backing off; `waitMs` is how long remains.
 * @param {{attempt?:number, refusals?:number, nextRetryAt?:string}} entry
 * @param {{now?:number, maxAttempts?:number, maxRefusals?:number}} o
 * @returns {{action:'surface'|'retry'|'wait', reason?:string, waitMs?:number}}
 */
export function retryDecision(entry, { now = Date.now(), maxAttempts = DEFAULT_MAX_ATTEMPTS, maxRefusals = DEFAULT_MAX_REFUSALS } = {}) {
  const attempt = Math.max(1, Math.floor(Number(entry?.attempt) || 1));
  if (attempt >= maxAttempts) return { action: 'surface', reason: 'attempt-cap' };
  if (Math.floor(Number(entry?.refusals) || 0) >= maxRefusals) return { action: 'surface', reason: 'refusal-cap' };
  const nowMs = toMs(now) || Number(now) || Date.now();
  const dueMs = toMs(entry?.nextRetryAt);
  if (nowMs >= dueMs) return { action: 'retry' };
  return { action: 'wait', waitMs: dueMs - nowMs };
}

/**
 * Which sha a resume may open (PR #2899 review). The resume runs with pr-land's verify gate OFF
 * (`--no-require-verified`), which is only sound for the EXACT commit the original build verified — the one
 * recorded in `entry.sha`. So the resume pins `--sha` to that recorded sha, and refuses (a guard answer, via
 * {@link markRefusedAttempt}) when the lane ref's current tip is not it:
 *   • tip unresolvable      → `bad-ref`         (the ref is gone from origin);
 *   • no recorded sha       → `no-recorded-sha` (nothing verified to pin to — resume by hand);
 *   • tip ≠ recorded sha    → `sha-moved`       (someone pushed since; never open an unverified newer tip).
 * A short recorded sha (at least {@link MIN_SHA_PREFIX} hex chars) matches its full tip by prefix; the answer
 * is always the FULL tip sha it was checked against. Pure.
 * @param {{recordedSha?:string|null, tipSha?:string|null, ref?:string}} o
 * @returns {{ok:true, sha:string} | {ok:false, refused:true, reason:string, detail:string}}
 */
export function resumeShaDecision({ recordedSha, tipSha, ref } = {}) {
  const rec = String(recordedSha || '').trim().toLowerCase();
  const tip = String(tipSha || '').trim().toLowerCase();
  if (!tip) return { ok: false, refused: true, reason: 'bad-ref', detail: `lane ref ${ref} does not resolve on origin` };
  if (!new RegExp(`^[0-9a-f]{${MIN_SHA_PREFIX},40}$`).test(rec)) {
    return { ok: false, refused: true, reason: 'no-recorded-sha', detail: `record for ${ref} carries no usable verified sha to pin the resume to` };
  }
  if (!tip.startsWith(rec)) {
    return { ok: false, refused: true, reason: 'sha-moved', detail: `lane ref ${ref} moved to ${tip.slice(0, 9)} since the recorded ${rec.slice(0, 9)} — not resuming an unverified tip` };
  }
  return { ok: true, sha: tip };
}
/** The shortest recorded sha {@link resumeShaDecision} accepts as a prefix (git's own default abbreviation). */
export const MIN_SHA_PREFIX = 7;

/**
 * Derive the per-item infra detail the tick view attaches to lanes (`{ [normNum]: { cause, attempt,
 * nextRetrySec, capped } }`) — the shape `status-board.mjs`'s `infraOf` reads for its ⊘ marker + OUTAGE banner
 * (#2660). `capped` is true once the attempt cap or the refusal cap is reached (auto-retry exhausted → the board tells the
 * operator to resume by hand, not "retrying"); `nextRetrySec` is the countdown to the next retry (null when
 * capped). `now` injected (determinism). Pure.
 * @param {Array<object>} store
 * @param {number} now  epoch ms
 * @param {{maxAttempts?:number}} o
 * @returns {Record<string, {cause:string, attempt:number, nextRetrySec:(number|null), capped:boolean}>}
 */
export function deriveInfraByNum(store, now = Date.now(), { maxAttempts = DEFAULT_MAX_ATTEMPTS, maxRefusals = DEFAULT_MAX_REFUSALS } = {}) {
  const nowMs = toMs(now) || Number(now) || Date.now();
  const out = {};
  for (const e of Array.isArray(store) ? store : []) {
    const key = normNum(e?.num);
    if (key === '') continue;
    const attempt = Math.max(1, Math.floor(Number(e.attempt) || 1));
    const capped = attempt >= maxAttempts || Math.floor(Number(e.refusals) || 0) >= maxRefusals;
    out[key] = {
      cause: String(e.cause || 'infra'),
      attempt,
      nextRetrySec: capped ? null : Math.max(0, Math.round((toMs(e.nextRetryAt) - nowMs) / 1000)),
      capped,
    };
  }
  return out;
}

// ── THIN FS/IO SHELL (the boundary — used by pr-land.mjs and the /conveyor tick) ──────────────────────────────

// Resolve the repo root by SCRIPT LOCATION (this file is scripts/conveyor/infra-blocked.mjs → root is two up),
// NOT by CWD — so the /conveyor tick's reader and this writer coincide (same rationale as queue-store.mjs).
const HERE = dirname(fileURLToPath(import.meta.url));
export const INFRA_ROOT = resolve(HERE, '..', '..');

/** The session sidecar path: `<root>/.conveyor/infra-blocked.json`. */
export function infraStorePath(root = INFRA_ROOT) {
  return join(root, '.conveyor', 'infra-blocked.json');
}

/** The canonical sidecar path every consumer resolves to — `CONVEYOR_INFRA_FILE` override wins, else script-location. */
export function resolveInfraStorePath() {
  const env = process.env.CONVEYOR_INFRA_FILE;
  return env && env.trim() ? env.trim() : infraStorePath();
}

/**
 * Resolve the PRIMARY checkout root from a LANE clone (via the clone's git alternates — a lane is
 * `git clone --reference <primary>`, so `<clone>/.git/objects/info/alternates` → `<primary>/.git/objects`).
 * Returns the primary root, or null when `cloneRoot` is not a lane clone (i.e. IS the primary). Lets `pr-land`,
 * which runs in a lane clone, write the infra record into the PRIMARY store the /conveyor tick reads.
 * @param {string} cloneRoot
 * @returns {string|null}
 */
export function primaryRootFromClone(cloneRoot) {
  try {
    const alt = readFileSync(resolve(cloneRoot, '.git/objects/info/alternates'), 'utf8').trim().split('\n')[0];
    if (!alt) return null;
    return resolve(alt, '..', '..'); // <primary>/.git/objects → <primary>
  } catch {
    return null;
  }
}

/** Read + parse the sidecar → the entry array (empty on a missing/corrupt file). */
export function readInfraStore(path = resolveInfraStorePath()) {
  if (!existsSync(path)) return [];
  try { return parseInfraStore(readFileSync(path, 'utf8')); }
  catch { return []; }
}

/** Write the store to the sidecar, ATOMICALLY (temp + rename, so a mid-write reader never sees partial JSON). */
export function writeInfraStore(store, path = resolveInfraStorePath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, serializeInfraStore(store));
  renameSync(tmp, path);
}

/**
 * Run `fn` inside a cross-PROCESS advisory lock on the store, so a read-modify-write is SERIALIZED. Atomic rename
 * only prevents a partial file — it does NOT prevent a LOST UPDATE: during a GitHub outage MANY agents call
 * `recordInfraBlockIO` on the SAME primary store at once, and the retry pass mutates it too, so an unserialized
 * read→modify→write can clobber a concurrently-added record — stranding the very work this state exists to save
 * (#2659 review, finding 1). The lock is a `<path>.lock` exclusive-create file; a STALE lock (older than
 * `staleMs` — a crashed holder) is stolen, and if the lock can't be taken within `timeoutMs` we proceed anyway
 * (best-effort — a lock must never DEADLOCK a tick; the worst case degrades to the pre-lock last-write-wins). The
 * critical section is a fast in-memory read-modify-write (microseconds), so contention is brief; `fn` must NOT do
 * slow IO (e.g. a blocking `pr-land`) while holding it. Returns `fn()`'s result.
 * Set `requireLock` to refuse an unlocked fallback write when preserving concurrent updates is required.
 */
export function withInfraLock(path, fn, { staleMs = 15_000, timeoutMs = 5_000, requireLock = false } = {}) {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  let held = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx'); // atomic exclusive create — fails if a holder exists
      try { writeFileSync(fd, String(process.pid)); } catch { /* pid stamp is advisory */ }
      closeSync(fd);
      held = true;
      break;
    } catch (e) {
      if (e && e.code !== 'EEXIST') { break; } // unexpected fs error → proceed unlocked (never fail a tick)
      // A holder exists — steal a STALE lock, else spin briefly, else give up (proceed unlocked).
      let age = Infinity;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { age = Infinity; }
      if (age > staleMs) { try { unlinkSync(lockPath); } catch { /* someone else stole it */ } continue; }
      if (Date.now() - start > timeoutMs) break; // give up waiting — degrade to best-effort
      const spinUntil = Date.now() + 8; while (Date.now() < spinUntil) { /* brief busy-wait — sections are µs */ }
    }
  }
  if (requireLock && !held) throw new Error(`could not acquire store lock: ${lockPath}`);
  try { return fn(); }
  finally { if (held) { try { unlinkSync(lockPath); } catch { /* already gone */ } } }
}

/** The origin repo slug (`owner/name`) of a checkout, or null. Lets the resume guard against opening a PR in the
 *  WRONG repo when a record carries a `repo` that isn't the local one (#2659 review, finding 2). */
export function originSlugOf(cwd = INFRA_ROOT) {
  try {
    // #x5n4zn3 — was bare (no timeout); a local config read, short budget.
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024 }).trim();
    const m = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return m ? canonicalizeSlug(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Record an infra-block into the on-disk store — the IO convenience `pr-land` calls at a failed open. Reads,
 * idempotently upserts (see {@link recordInfraBlock}), writes. `path` targets the store to write (pr-land passes
 * the PRIMARY store path; a caller in the primary itself omits it). Best-effort by construction — never throws
 * past the caller's own guard (a record hiccup must not fail an already-diagnosed open failure).
 * @returns {{recorded:boolean, num:string}}
 */
export function recordInfraBlockIO(entry, { now = Date.now(), path = resolveInfraStorePath() } = {}) {
  // Serialize the read→record→write so a concurrent record/retry never clobbers this one (#2659 review, finding 1).
  return withInfraLock(path, () => {
    const store = readInfraStore(path);
    const next = recordInfraBlock(store, entry, now);
    if (next !== store) writeInfraStore(next, path);
    return { recorded: next !== store, num: String(entry?.num ?? '') };
  });
}

/**
 * Apply a pure store transform under the lock, re-reading the CURRENT on-disk store first — so a mutation from
 * the retry pass merges with any record a concurrent agent added while a (slow, UNLOCKED) resume ran, instead of
 * clobbering it with a stale snapshot (#2659 review, finding 1). `transform(store)` is a pure fn returning the new
 * store. Writes only when it changed. Returns the new store.
 */
export function mutateInfraStore(transform, { path = resolveInfraStorePath() } = {}) {
  return withInfraLock(path, () => {
    const store = readInfraStore(path);
    const next = typeof transform === 'function' ? transform(store) : store;
    if (next !== store) writeInfraStore(next, path);
    return next;
  });
}

// ── GitHub status correlation (IO — the pure `correlateCause` reads the result) ───────────────────────────────

/**
 * Fetch the GitHub status summary from the public statuspage API. Returns `{ reachable, indicator, description }`
 * — `reachable:false` on ANY error (offline, DNS, timeout), never throwing. `indicator` ∈ none|minor|major|
 * critical. Best-effort + short-timeout: a status probe must never itself stall a retry tick.
 * @returns {Promise<{reachable:boolean, indicator:(string|null), description:(string|null)}>}
 */
export async function fetchGithubStatus({ timeoutMs = 5_000 } = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let json;
    try {
      const res = await fetch('https://www.githubstatus.com/api/v2/status.json', { signal: ctrl.signal });
      if (!res.ok) return { reachable: true, indicator: null, description: `status HTTP ${res.status}` };
      json = await res.json();
    } finally {
      clearTimeout(t);
    }
    return {
      reachable: true,
      indicator: json?.status?.indicator ?? 'none',
      description: json?.status?.description ?? null,
    };
  } catch {
    return { reachable: false, indicator: null, description: null };
  }
}

// ── CLI (runs only when invoked directly) ─────────────────────────────────────────────────────────────────────

const log = (m) => process.stderr.write(m + '\n');

/** Hand-rolled `--k=v` / `--flag` parsing (+ positional subcommand). */
function parseArgv(argv) {
  const flags = {};
  const pos = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else pos.push(a);
  }
  return { flags, pos };
}

/**
 * Resume-open the PR for one recorded entry — the ONLY "resume" mechanism, and it NEVER merges: it re-invokes
 * the producer `pr-land --label-on-green` against the ALREADY-PUSHED lane ref (fetched from origin so the tip
 * exists locally). `pr-land` opens the PR, waits for green, labels `ready-to-merge`, and STOPS — the drain lands
 * it (memory rule 104: the drain is the sole writer to main). The local-merge break-glass flag is NEVER passed,
 * so no local merge path can be reached. Returns `{ ok, prNumber?, refused?, reason?, detail }` — `refused`
 * (#4348-open-pr-retry addendum) is `true` when pr-land's own `reason` is a GUARD ANSWER
 * (`open-pr.mjs#HOME_REASONS`), never an infra outage; the caller (the `retry` CLI below) reads it to decide
 * {@link markRefusedAttempt} vs {@link markRetryAttempt}. Best-effort — a failure just bumps the attempt (or,
 * for a refusal, does not — see that function's own docblock).
 */
function resumeOpen(entry, { cwd = INFRA_ROOT, localSlug = null } = {}) {
  const ref = entry?.ref;
  const base = entry?.base || 'main';
  if (!ref) return { ok: false, detail: 'no resumable ref recorded' };
  // #2659 review, finding 2 — NEVER resume a cross-repo record against the WRONG repo: a couple's impl-half block
  // (repo ≠ this checkout's) is not this tick's to open. Surface it (a `skip` — do NOT burn a retry attempt);
  // its auto-resume is a scoped follow-up. A record with no `repo` (the WE single-locus common case) always runs.
  if (entry.repo && localSlug && entry.repo !== localSlug) {
    return { ok: false, skip: true, detail: `cross-repo record (${entry.repo}) — auto-resume owned by its repo; surfaced for the operator` };
  }
  // The ref is already on origin (it was pushed before the open failed). Fetch its objects so pr-land's push of
  // <sha>:<ref> is a local no-op and the create has a head to point at.
  // #x5n4zn3 — was bare (no timeout): a real network fetch.
  try { execFileSync('git', ['fetch', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`], { cwd, stdio: ['ignore', 'ignore', 'pipe'], timeout: 10 * 60_000, killSignal: 'SIGKILL' }); }
  catch (e) {
    // An OUTAGE during the fetch is an infra failure (the attempt/backoff budget), never a refusal — otherwise
    // the tip check below would read "no ref" and burn the refusal budget under a misleading `bad-ref`. Any
    // other fetch error (e.g. the ref is gone) falls through to that check.
    const text = `${String(e?.message || e)}\n${String(e?.stderr || '')}`;
    if (e?.signal === 'SIGKILL' || classifyPrOpenFailure(text).infra) return { ok: false, detail: `fetch of ${ref} failed (${text.split('\n')[0]})` };
  }
  // PR #2899 review — pin the resume to the RECORDED (verified) sha, and refuse if the ref moved since.
  let tipSha = null;
  try { tipSha = execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}^{commit}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, maxBuffer: 256 * 1024 * 1024 }).trim() || null; }
  catch { tipSha = null; }
  const pin = resumeShaDecision({ recordedSha: entry.sha, tipSha, ref });
  if (!pin.ok) return { ok: false, refused: true, reason: pin.reason, detail: pin.detail };
  // Re-open with the recorded body (so nothing is lost). Write it to a temp file for --body-file (robust to
  // multi-line bodies). pr-land refuses a bodyless create, so a missing body is surfaced as a resume failure.
  let bodyFile = null;
  if (typeof entry.body === 'string' && entry.body.trim()) {
    bodyFile = join(tmpdir(), `infra-resume-${normNum(entry.num)}-${Date.now()}.md`);
    try { writeFileSync(bodyFile, entry.body); } catch { bodyFile = null; }
  }
  const prLand = resolve(INFRA_ROOT, 'scripts', 'pr-land.mjs');
  // `--no-require-verified` — THE SAME opt-out the drain (`we:scripts/lane-drain.mjs#buildPrLandArgs`) and the
  // parallel `/workflow` producer already pass, and for the identical reason (pr-land.mjs's own #3321 comment,
  // ~line 145): this call lands from the PRIMARY checkout (`cwd: INFRA_ROOT`, never a lane clone) against a
  // lane ref built somewhere else entirely — the ORIGINAL delivery lane's own `.git/.lane-verify` marker, if it
  // ever recorded one, cannot exist here, and by the time an infra-blocked entry is old enough to retry that
  // lane has typically already been released back to the pool. Omitting this flag was the ROOT CAUSE of the
  // live #4348 stall confirmed by this session (never a rate-limit issue after the first failure): every
  // resume was refused `unverified` by pr-land's own #2833 finish-guard, silently, because `resumeOpen`'s own
  // failure `detail` reached only `log()` on stderr — see the new `failed` field on the retry command's JSON
  // output below, added for exactly this visibility gap. The posture is sound the same way the drain's is: the
  // PR's required CI check gates the actual merge (the drain never merges directly either), and the ORIGINAL
  // build already ran its own synchronous gate before the open ever failed — this call is not skipping
  // verification, it is re-opening a PR for work that was already verified once, from a checkout structurally
  // unable to prove that itself. Pinned by `we:scripts/__tests__/lane-verify.test.mjs`'s caller sweep. That
  // argument holds only for the verified commit itself, so `--sha` is the RECORDED sha (`pin.sha`, checked
  // above against the live tip) — never `origin/<ref>`, which could be a newer, unverified push.
  const args = [prLand, `--ref=${ref}`, `--sha=${pin.sha}`, `--base=${base}`, '--label-on-green', '--no-require-verified', '--json'];
  if (bodyFile) args.push(`--body-file=${bodyFile}`);
  // Parse pr-land's LAST JSON line whether it exited 0 or non-zero (execFileSync throws on non-zero, with the
  // stdout on `e.stdout`). A PR NUMBER in the result means the PR now EXISTS — the open SUCCEEDED, even if the
  // green-wait then went red/timeout (exit 2/3): the item is no longer infra-blocked, it is a normal open PR the
  // watcher/drain own, so we clear the record (#2659 review, finding 3). Only a result with NO PR (pr-land
  // re-failed blocked-on-infra, or push/gh error) keeps the record for another backoff round.
  const parse = (out) => { try { return JSON.parse(String(out || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch { return {}; } };
  try {
    // #x5n4zn3 — was bare (no timeout). `pr-land.mjs --label-on-green` has its OWN internal wait-for-green
    // deadline (`--timeout-min`, default 15 min) — this outer bound must exceed that, with margin for gh/push
    // overhead, or it would kill a wait pr-land itself would have given up on cleanly moments later.
    const res = parse(execFileSync('node', args, { cwd, env: { ...process.env, WE_BUILD_PR_CONTEXT: entry.builderContext || '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000, killSignal: 'SIGKILL' }));
    return { ok: true, prNumber: res.pr ?? null, detail: res.detail || 'resume-opened' };
  } catch (e) {
    const res = parse(e.stdout);
    if (res.pr != null) return { ok: true, prNumber: res.pr, detail: res.detail || `PR #${res.pr} opened (${res.reason || 'non-green'})` };
    // #4348-open-pr-retry addendum — WHICH BUCKET pr-land's own `reason` falls in, reusing `open-pr.mjs`'s
    // declared table rather than a second opinion: `refused` means a GUARD ANSWERED (`unverified`, `check-red`,
    // `bad-ref`, …) — fixable only by a code/data change, never by waiting, so the caller must NOT spend the
    // SAME attempt/backoff budget an actual outside-dependency outage needs (see `markRefusedAttempt`). An
    // unrecognised/absent reason (a spawn error, unparseable output) is conservatively NOT `refused` — this
    // never guesses an entry out of its real infra backoff.
    const refused = !!res.reason && HOME_REASONS[res.reason] === 'refused';
    return { ok: false, refused, reason: res.reason ?? null, detail: (res.detail || String(e.message || e)).split('\n')[0] };
  }
}

async function main(argv) {
  const { flags, pos } = parseArgv(argv);
  const sub = pos[0] || 'list';
  const path = resolveInfraStorePath();
  const asJson = !!flags.json;
  const maxAttempts = Number.isFinite(Number(flags['max-attempts'])) ? Number(flags['max-attempts']) : DEFAULT_MAX_ATTEMPTS;
  const nowMs = Date.now();

  if (sub === 'record') {
    const rec = recordInfraBlockIO(
      { num: flags.num, ref: flags.ref, sha: flags.sha ?? null, base: flags.base ?? 'main', repo: flags.repo ?? null, cause: flags.cause ?? 'infra', body: flags.body ?? null },
      { now: nowMs, path },
    );
    process.stdout.write(JSON.stringify(rec) + '\n');
    return 0;
  }

  if (sub === 'resolve' || sub === 'clear' || sub === 'remove') {
    const store = readInfraStore(path);
    const next = removeInfraBlock(store, flags.num);
    if (next !== store) writeInfraStore(next, path);
    process.stdout.write(JSON.stringify({ removed: next.length !== store.length, num: String(flags.num ?? '') }) + '\n');
    return 0;
  }

  if (sub === 'rearm') {
    // #4348-open-pr-retry addendum — THE SANCTIONED escape hatch for an entry SURFACED before
    // `markRefusedAttempt` existed (its stored `attempt` count is inflated by refusals that were never really
    // infra failures, e.g. #4348's own 6 `unverified` attempts). This is the CLI verb, never a hand-edit of
    // `.conveyor/infra-blocked.json`: it goes through the same lock + pure transform as every other mutation
    // here (`rearmInfraBlock`), so a concurrent retry pass can never race it. `--num=` is required — this never
    // rearms "everything", which would silently reopen every genuinely-still-outage-blocked entry's cap too.
    if (!flags.num) { log('infra-blocked rearm: --num=<n> is required'); return 1; }
    const rearmed = mutateInfraStore((s) => rearmInfraBlock(s, flags.num, nowMs), { path });
    process.stdout.write(JSON.stringify({ rearmed: infraHas(rearmed, flags.num), num: String(flags.num ?? '') }) + '\n');
    return 0;
  }

  if (sub === 'github-status') {
    const status = await fetchGithubStatus();
    process.stdout.write(JSON.stringify(status) + '\n');
    return 0;
  }

  if (sub === 'list') {
    const store = readInfraStore(path);
    process.stdout.write(JSON.stringify({ blocked: store, byNum: deriveInfraByNum(store, nowMs, { maxAttempts }) }, null, asJson ? 2 : 0) + '\n');
    return 0;
  }

  if (sub === 'retry') {
    // ONE resume pass — the /conveyor tick is the loop clock (no internal busy-loop). Correlate every entry's
    // cause against GitHub status once (a real outage vs a one-off), then for each entry act on its decision.
    // Every store WRITE re-reads the CURRENT store under the lock and applies a pure transform — so a slow,
    // UNLOCKED resume never clobbers a record a concurrent agent added meanwhile (#2659 review, finding 1).
    const snapshot = readInfraStore(path);
    if (snapshot.length === 0) {
      process.stdout.write(JSON.stringify({ retried: [], resumed: [], surfaced: [], waiting: [], failed: [] }) + '\n');
      return 0;
    }
    const status = await fetchGithubStatus();
    const localSlug = originSlugOf(INFRA_ROOT);
    const only = flags.num ? normNum(flags.num) : null;
    // #4348-open-pr-retry addendum — `failed` (`{num, detail, refused?}`) is NEW: before this, a resume failure's
    // own `detail` reached only `log()` on stderr, never the JSON a caller (the build-dispatch daemon's own
    // tick, `infraRetry` in its report) actually reads — which is exactly how #4348 sat surfaced for hours with
    // its true cause (`unverified`) invisible to anything but a human tailing this process's own stderr.
    const retried = [], resumed = [], surfaced = [], waiting = [], failed = [];
    for (const entry of snapshot) {
      const key = normNum(entry.num);
      if (only && key !== only) continue;
      // Refine the cause (real outage vs one-off) — persist it under the lock so the board/operator sees it.
      const refined = correlateCause(entry.cause, status);
      if (refined !== entry.cause) mutateInfraStore((s) => updateCause(s, entry.num, refined), { path });
      const decision = retryDecision({ ...entry, cause: refined }, { now: Date.now(), maxAttempts });
      if (decision.action === 'surface') { surfaced.push({ num: entry.num, cause: refined, attempt: entry.attempt, reason: decision.reason }); continue; }
      if (decision.action === 'wait') { waiting.push({ num: entry.num, waitSec: Math.round((decision.waitMs || 0) / 1000) }); continue; }
      // action === 'retry' → attempt a resume-open (never a local merge). The resume itself is UNLOCKED (it can
      // block for minutes on pr-land's green-wait); only the short store mutation after it takes the lock.
      retried.push(entry.num);
      const r = resumeOpen(entry, { localSlug });
      if (r.skip) { surfaced.push({ num: entry.num, cause: refined, attempt: entry.attempt, reason: 'cross-repo' }); log(`  ⊘ #${entry.num} ${r.detail}`); continue; }
      if (r.ok) { mutateInfraStore((s) => removeInfraBlock(s, entry.num), { path }); resumed.push({ num: entry.num, pr: r.prNumber ?? null }); continue; }
      if (r.refused) {
        // NEVER the infra attempt/backoff budget — its OWN refusal counter + fixed interval instead (see
        // `markRefusedAttempt`); `retryDecision` surfaces it once that refusal cap is hit.
        mutateInfraStore((s) => markRefusedAttempt(s, entry.num, Date.now(), { reason: r.reason }), { path });
        failed.push({ num: entry.num, detail: r.detail, refused: true, reason: r.reason ?? null });
        log(`  ⊘ #${entry.num} resume REFUSED (${r.detail}) — a guard answered, not an infra outage; retrying on the refusal interval, surfaced at the refusal cap`);
        continue;
      }
      mutateInfraStore((s) => markRetryAttempt(s, entry.num, Date.now(), { cause: refined }), { path });
      failed.push({ num: entry.num, detail: r.detail });
      log(`  ⊘ #${entry.num} resume still failing (${r.detail}) — backing off`);
    }
    writeAllSync(1, JSON.stringify({ retried, resumed, surfaced, waiting, failed }) + '\n');
    return 0;
  }

  log(`infra-blocked: unknown subcommand "${sub}" (expected: record | retry | list | resolve | rearm | github-status)`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`infra-blocked: ${String(e?.message || e)}\n`);
    process.exit(1);
  });
}
