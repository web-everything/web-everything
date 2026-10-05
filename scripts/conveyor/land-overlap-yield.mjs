#!/usr/bin/env node
/**
 * @file scripts/conveyor/land-overlap-yield.mjs
 * @description #4308 — the land-time complement of #4295 (dispatch-time overlap coordination). #4295 keeps
 *   build+build/fix+fix/build+fix work from colliding through the daemons' own claim stores; this module is
 *   the drain's LAND-time planner, over ACTUAL changed files, for every open PR the drain sees (orchestrator
 *   and human PRs, under-declared scope, two PRs already open) — the gap #2821/#2826 fell through on
 *   2026-09-27 (a 20-file PR conflicted twice with smaller PRs landing under it while it sat in review, costing
 *   a fixer round, a full CI run and a fresh review round). Ratified design: platform-decisions.md
 *   #drain-overlap-yield-landing-order (decision #4307, Fork 1 A).
 *
 * THE RULE (see backlog #4308 "Design" for the full prose). A ready PR X yields to an open PR Y when:
 *   1. Y is open, not a draft, targets the same base as X, and carries `review:pending`/`review:accepted`
 *      (never `review:changes`).
 *   2. X and Y share at least one changed file in the same repo, and BOTH file lists are complete (an unknown
 *      list — one that hit the listing cap — never yields).
 *   3. Y outranks X in ONE global order: total changed lines (bigger first), then LOWER PR number. A strict
 *      total order (PR numbers are unique) — cannot cycle ({@link outranksForLand}).
 *   4. Y does not depend on X (Y is not `blockedBy` X's item, not a stack descendant of X) — otherwise X would
 *      wait on a PR that is itself waiting on X.
 *   5. X is not exempt (`priority: high` / `tier: pinned` on X's own item — a missing/unreadable card reads
 *      "not exempt").
 *   6. X is still inside its OWN budget: `now < readyAt(X) + windowMsAtLabelTime(X)` — a NON-RENEWABLE budget
 *      fixed from the settings value in effect AT `readyAt(X)` (derived from the tracked config's git history,
 *      never live-recomputed), so neither a drain restart nor an operator widening the window mid-trial can
 *      resurrect an already-expired X ({@link windowMsAtLabelTime}).
 *   7. A Y whose required check concluded red is skipped (env-only opt-out).
 *
 * PURITY SPLIT (mirrors `we:scripts/readiness/file-locks.mjs` / `we:scripts/lib/target-registry.mjs`): the
 * DECISION logic ({@link overlapYieldWaits}, {@link windowMsAtLabelTime}, {@link validateOverlapYieldConfig},
 * {@link outranksForLand}, {@link resolveOverlapYieldSettings}, {@link parseOverlapYieldOverrides}) takes no
 * fs/network/clock — every timestamp and every config value is an argument. The impure IO shells
 * ({@link loadOverlapYieldConfig}, {@link writeOverlapYieldConfig}, {@link gitHistoryConfigAtReader},
 * {@link isShallowRepository}, {@link readyToMergeLabelTimeMs}, {@link computeOverlapContext}) are the only
 * surface that touches a filesystem, `git`, or `gh` — deliberately thin so the tested logic stays pure.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readShaCache, writeShaCache } from '../lib/pr-snapshot.mjs';
import { reserve, releaseLockDir } from '../readiness/file-locks.mjs';
import { readField } from '../backlog/frontmatter.mjs';

/** Code default — the fallback for a missing OR malformed settings file, and the shipped trial default
 *  (#4308 Window: anchored on the #2821 incident, "took 44 minutes end to end"). */
export const DEFAULT_OVERLAP_YIELD_CONFIG = Object.freeze({ enabled: true, windowMinutes: 45 });

/** The tracked settings file's path, repo-root-relative (POSIX, `/`-separated) — the exact pathspec `git
 *  show <sha>:<path>` / `git rev-list -- <path>` need, NEVER a filesystem path (#4308 Window: "a pure function
 *  of ... the repo history"). */
export const OVERLAP_YIELD_CONFIG_RELATIVE_PATH = 'scripts/drain-overlap-yield-config.json';

const REVIEW_BLOCK_LABEL = 'review:changes';
const REVIEW_OK_LABELS = Object.freeze(['review:pending', 'review:accepted']);
const READY_LABEL = 'ready-to-merge';
const CONFIG_WRITE_LOCK_KEY = '<overlap-yield-config:write>';
const CONFIG_WRITE_LOCK_LEASE_MINUTES = 1;

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The absolute path to the tracked settings file, resolved off THIS module's own location (never `cwd` —
 *  a lane clone and the resident daemon's clone both resolve the SAME repo-relative file). */
export function defaultOverlapYieldConfigPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', OVERLAP_YIELD_CONFIG_RELATIVE_PATH.replace(/^scripts\//, ''));
}

// ───────────────────────── pure: settings-file shape ─────────────────────────

/**
 * Strict validation of a parsed settings object (#4308 Malformed file: `enabled` must be boolean,
 * `windowMinutes` a finite number > 0 — never silently coerced either direction). Pure.
 * @param {*} raw
 * @returns {{ok:boolean, config:({enabled:boolean, windowMinutes:number}|null), errors:string[]}}
 */
export function validateOverlapYieldConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, config: null, errors: ['settings must be a JSON object'] };
  }
  const errors = [];
  if (typeof raw.enabled !== 'boolean') errors.push(`"enabled" must be a boolean, got ${JSON.stringify(raw.enabled)}`);
  const wm = raw.windowMinutes;
  if (!(typeof wm === 'number' && Number.isFinite(wm) && wm > 0)) errors.push(`"windowMinutes" must be a finite number > 0, got ${JSON.stringify(wm)}`);
  if (errors.length) return { ok: false, config: null, errors };
  return { ok: true, config: { enabled: raw.enabled, windowMinutes: raw.windowMinutes }, errors: [] };
}

/**
 * Full-replace resolution of a one-off CLI/env override against the settings file (#4308 Override precedence
 * — "fully REPLACE ... not merged field-by-field"). Pure.
 * @param {{fileConfig:{enabled:boolean, windowMinutes:number}, overrides?:{enable:(boolean|null), windowMinutes:(number|null), skipRed?:(boolean|null)}}} o
 */
export function resolveOverlapYieldSettings({ fileConfig, overrides = {} } = {}) {
  const base = fileConfig || DEFAULT_OVERLAP_YIELD_CONFIG;
  const enabled = overrides.enable != null ? !!overrides.enable : base.enabled;
  const windowMinutes = overrides.windowMinutes != null ? overrides.windowMinutes : base.windowMinutes;
  return { enabled, windowMinutes, skipRed: overrides.skipRed ?? true };
}

/**
 * Parse the drain CLI's one-off overrides: `--overlap-yield` / `--no-overlap-yield` (force enable/disable),
 * `--overlap-yield-window=<minutes>`, env `WE_DRAIN_OVERLAP_YIELD=0|1` and `WE_DRAIN_YIELD_SKIP_RED=0|1`.
 * A flag beats the enable env var; passing both enable+disable flags, or an env value other than `0`/`1`, is a usage error (throws) — #4308 Override
 * precedence. Pure.
 * @param {{argv?:string[], env?:object}} o
 * @returns {{enable:(boolean|null), windowMinutes:(number|null), skipRed:(boolean|null)}}
 */
export function parseOverlapYieldOverrides({ argv = [], env = {} } = {}) {
  const hasEnable = argv.includes('--overlap-yield');
  const hasDisable = argv.includes('--no-overlap-yield');
  if (hasEnable && hasDisable) throw new Error('usage: --overlap-yield and --no-overlap-yield are mutually exclusive');
  let enable = hasEnable ? true : hasDisable ? false : null;
  if (enable === null && env.WE_DRAIN_OVERLAP_YIELD !== undefined) {
    const raw = String(env.WE_DRAIN_OVERLAP_YIELD);
    if (raw === '1') enable = true;
    else if (raw === '0') enable = false;
    else throw new Error(`usage: WE_DRAIN_OVERLAP_YIELD must be "0" or "1", got ${JSON.stringify(raw)}`);
  }
  const windowFlag = argv.find((a) => a.startsWith('--overlap-yield-window='));
  let windowMinutes = null;
  if (windowFlag) {
    const raw = windowFlag.slice('--overlap-yield-window='.length);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`usage: --overlap-yield-window expects a positive number of minutes, got ${JSON.stringify(raw)}`);
    windowMinutes = n;
  }
  let skipRed = null;
  if (env.WE_DRAIN_YIELD_SKIP_RED !== undefined) {
    const raw = String(env.WE_DRAIN_YIELD_SKIP_RED);
    if (raw === '1') skipRed = true;
    else if (raw === '0') skipRed = false;
    else throw new Error(`usage: WE_DRAIN_YIELD_SKIP_RED must be "0" or "1", got ${JSON.stringify(raw)}`);
  }
  return { enable, windowMinutes, skipRed };
}

// ───────────────────────── pure: the rule itself ─────────────────────────

function totalChangedLines(row) {
  const files = Array.isArray(row?.files) ? row.files : [];
  let n = 0;
  for (const f of files) n += (Number(f?.additions) || 0) + (Number(f?.deletions) || 0);
  return n;
}

function filePathSet(row) {
  const files = Array.isArray(row?.files) ? row.files : [];
  const out = new Set();
  for (const f of files) {
    const p = typeof f === 'string' ? f : f?.path;
    if (p) out.add(p);
  }
  return out;
}

function overlappingFiles(a, b) {
  const sa = filePathSet(a);
  const out = [];
  for (const p of filePathSet(b)) if (sa.has(p)) out.push(p);
  return out.sort();
}

function labelSet(row) {
  const out = new Set();
  for (const l of (Array.isArray(row?.labels) ? row.labels : [])) out.add(typeof l === 'string' ? l : l?.name);
  return out;
}

/** `` `${repo||''}#${number}` `` — the composite key every reader of {@link overlapYieldWaits}'s result Map
 *  must use. PR numbers are per-repo (a bare number would collide a WE PR with a same-numbered sibling-repo
 *  PR — #999/xq985wu's own documented hazard). Pure. */
export function overlapRowKey(row) {
  return `${row?.repo || ''}#${row?.number}`;
}

/** Rule 3 — does Y outrank X? Total changed lines, bigger first; a tie breaks on the LOWER PR number. A
 *  STRICT total order (PR numbers are unique within one repo, and cross-repo pairs never compare — rule 1
 *  already requires the same repo), so no cycle is representable, unlike an overlap-relative "bigger than the
 *  PR it overlaps" comparison (#4308 Codex finding 2: A>B>C>A). Pure. */
export function outranksForLand(y, x) {
  const ly = totalChangedLines(y);
  const lx = totalChangedLines(x);
  if (ly !== lx) return ly > lx;
  return Number(y.number) < Number(x.number);
}

function dependsOnCandidate(y, x) {
  if (x == null || x.item == null) return false;
  const s = y?.dependsOn;
  if (!s || typeof s.has !== 'function') return false;
  return s.has(x.item) || s.has(String(x.item));
}

/**
 * THE pure rule (#4308 rules 1-7). No fs, no network, no clock — every timestamp is an argument.
 *
 * `candidates` are this pass's READY PRs (the X side, i.e. this pass's `ready` set before the overlap check).
 * `openPrs` is the universe of open PRs that might be a yield TARGET (the Y side; `candidates` may also appear
 * in it — a candidate is itself an open PR). Both use the same snapshot-row shape: `{number, repo,
 * baseRefName, isDraft, labels, files:[{path,additions,deletions}], filesComplete, readyAtMs, windowMs, item,
 * exempt, dependsOn:Set, requiredCheckRed:boolean}`. `readyAtMs`/`windowMs` are PRECOMPUTED by the caller's IO layer (see
 * {@link computeOverlapContext}) — this function only ever compares them; it never fetches them.
 *
 * `ignoreBudget` runs rules 1-5 and 7 only (skips rule 6) — the cheap TRIAL pass {@link computeOverlapContext} uses
 * to discover which candidates need a real (IO-backed) `readyAtMs`/`windowMs` at all, so the label-time read
 * happens only "per yielding candidate" (#4308 Data), never for every ready PR.
 *
 * @param {{candidates:object[], openPrs:object[], nowMs:number, ignoreBudget?:boolean, skipRed?:boolean, skips?:(Map|null)}} o
 * @returns {Map<string, {yieldTo:number, repo:(string|null), files:string[], untilMs:number, windowMinutes:(number|null)}>}
 *   keyed by {@link overlapRowKey}.
 */
export function overlapYieldWaits({ candidates, openPrs, nowMs, ignoreBudget = false, skipRed = true, skips = null } = {}) {
  const out = new Map();
  const xs = Array.isArray(candidates) ? candidates : [];
  const ys = Array.isArray(openPrs) ? openPrs : [];
  for (const x of xs) {
    if (!x || x.exempt === true) continue; // rule 5
    if (x.filesComplete === false) continue; // rule 2 — an unknown file list never yields
    let best = null;
    for (const y of ys) {
      if (!y) continue;
      if ((y.repo || null) !== (x.repo || null)) continue; // rule 1 — same repo
      if (Number(y.number) === Number(x.number)) continue; // never yields to itself
      if (y.isDraft) continue; // rule 1
      if (!y.baseRefName || y.baseRefName !== x.baseRefName) continue; // rule 1 — same base
      const labels = labelSet(y);
      if (labels.has(REVIEW_BLOCK_LABEL)) continue; // rule 1
      if (!REVIEW_OK_LABELS.some((l) => labels.has(l))) continue; // rule 1
      if (y.filesComplete === false) continue; // rule 2 — Y's own list must be complete too
      if (!overlappingFiles(x, y).length) continue; // rule 2 — must share a changed file
      if (!outranksForLand(y, x)) continue; // rule 3
      if (dependsOnCandidate(y, x)) continue; // rule 4
      if (skipRed && y.requiredCheckRed === true) { // rule 7 — informational, independent of rule 6
        if (skips instanceof Map) {
          const key = overlapRowKey(x);
          const entries = skips.get(key) || [];
          if (!entries.some((entry) => entry.pr === Number(y.number))) {
            entries.push({ pr: Number(y.number), repo: x.repo ?? null, reason: 'red-ci', token: `overlap-yield-skipped:#${y.number}(red-ci)` });
          }
          skips.set(key, entries);
        }
        continue;
      }
      if (!best || outranksForLand(y, best)) best = y;
    }
    if (!ignoreBudget && Number.isFinite(x.readyAtMs) && Number.isFinite(x.windowMs) && Number.isFinite(nowMs)
      && nowMs >= x.readyAtMs + x.windowMs) continue; // rule 6 — past its own budget
    if (best) {
      out.set(overlapRowKey(x), {
        yieldTo: Number(best.number),
        repo: x.repo ?? null,
        files: overlappingFiles(x, best),
        untilMs: (Number.isFinite(x.readyAtMs) ? x.readyAtMs : nowMs) + (Number.isFinite(x.windowMs) ? x.windowMs : 0),
        windowMinutes: Number.isFinite(x.windowMs) ? x.windowMs / 60_000 : null,
      });
    }
  }
  return out;
}

/**
 * The DURATION (ms) X's yield budget runs for, fixed from the setting in effect AT X's own `readyAtMs` label
 * time (rule 6) — never the live value, so neither an operator widening `windowMinutes` mid-trial nor a drain
 * restart can resurrect an already-expired X (#4308 Window / #4308 advisory review round 2, finding 2). Pure
 * given `configAt` (an injected reader — see {@link gitHistoryConfigAtReader} for the real, git-backed one;
 * tests supply a fake).
 *
 * `configAt(ms)` returns:
 *   - `{ trusted: true, windowMinutes: (number|null) }` — `windowMinutes: null` means the tracked file did not
 *     exist yet in history at `ms` ⇒ the CODE default (never the untrusted fallback);
 *   - `{ trusted: false }` (or a throw) — history could not be trusted (a git error, or a shallow clone where
 *     "no commit found" cannot be told apart from "history was cut off") ⇒ the SMALLER of
 *     `currentWindowMinutes` and `codeDefaultMinutes` — a best-effort floor, never a guarantee (#4308 Window).
 * @param {{readyAtMs:number, configAt:(ms:number)=>({trusted:boolean, windowMinutes?:(number|null)}),
 *   codeDefaultMinutes?:number, currentWindowMinutes?:number}} o
 * @returns {number} the window length in ms
 */
export function windowMsAtLabelTime({
  readyAtMs, configAt, codeDefaultMinutes = DEFAULT_OVERLAP_YIELD_CONFIG.windowMinutes, currentWindowMinutes = codeDefaultMinutes,
} = {}) {
  let result;
  try { result = typeof configAt === 'function' ? configAt(readyAtMs) : null; } catch { result = null; }
  let minutes;
  if (result && result.trusted === true) {
    const wm = result.windowMinutes;
    minutes = (typeof wm === 'number' && Number.isFinite(wm) && wm > 0) ? wm : codeDefaultMinutes;
  } else {
    const cur = (typeof currentWindowMinutes === 'number' && Number.isFinite(currentWindowMinutes) && currentWindowMinutes > 0)
      ? currentWindowMinutes : codeDefaultMinutes;
    minutes = Math.min(cur, codeDefaultMinutes);
  }
  return minutes * 60_000;
}

/** The WE backlog directory, resolved off THIS module's own location — same convention as
 *  {@link defaultOverlapYieldConfigPath}, so a sibling-repo candidate reads WE's OWN backlog (where every
 *  item's card lives, #96), never a repo-relative guess. */
export function defaultBacklogDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backlog');
}

/**
 * Rule 5 — is X's own item exempt (`priority: high` or `tier: pinned` — "a blocker fix never waits")? A
 * missing or unreadable card reads "not exempt" (#4308 rule 5), never throws.
 * @param {(number|string|null)} itemId
 * @param {{backlogDir?:string, readdir?:Function, readFile?:Function}} o
 * @returns {boolean}
 */
export function isExemptItem(itemId, { backlogDir = defaultBacklogDir(), readdir = readdirSync, readFile = readFileSync } = {}) {
  if (itemId == null) return false;
  try {
    const prefix = `${itemId}-`;
    const file = readdir(backlogDir).find((f) => f.startsWith(prefix) && f.endsWith('.md'));
    if (!file) return false;
    const text = readFile(join(backlogDir, file), 'utf8');
    const priority = readField(text, 'priority');
    const tier = readField(text, 'tier');
    return priority === 'high' || tier === 'pinned';
  } catch {
    return false;
  }
}

// ───────────────────────── impure: settings-file IO ─────────────────────────

/**
 * Read the LIVE settings file. Absent ⇒ the code default, silently (the ordinary case: before this file is
 * ever committed to a tree, or in a fixture with none). Present-but-malformed ⇒ the code default TOO, but
 * with a warning — never silently coerced to `enabled:false` (a read-error fail-open would silently kill the
 * trial) nor `enabled:true` (a write-race fail-open would silently resurrect a disabled trial) — #4308
 * Malformed file.
 * @param {{path?:string, warn?:(msg:string)=>void}} o
 * @returns {{enabled:boolean, windowMinutes:number}}
 */
export function loadOverlapYieldConfig({ path = defaultOverlapYieldConfigPath(), warn = (msg) => process.stderr.write(`${msg}\n`) } = {}) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { ...DEFAULT_OVERLAP_YIELD_CONFIG }; }
  const v = validateOverlapYieldConfig(safeJsonParse(text));
  if (!v.ok) {
    warn(`⚠ overlap-yield config at ${path} is malformed (${v.errors.join('; ')}) — falling back to the code `
      + `default (enabled:${DEFAULT_OVERLAP_YIELD_CONFIG.enabled}, windowMinutes:${DEFAULT_OVERLAP_YIELD_CONFIG.windowMinutes})`);
    return { ...DEFAULT_OVERLAP_YIELD_CONFIG };
  }
  return v.config;
}

/**
 * The ONE sanctioned writer for the tracked settings file — a validated read-modify-write, never a bare
 * `writeFileSync` (#4308 Interfaces / Malformed file). ATTEMPTS a short-TTL per-file lock around it
 * (`we:scripts/readiness/file-locks.mjs`) to serialize a concurrent editor; on a genuine race it DEGRADES to an
 * unlocked write rather than refusing the edit — the same fail-soft posture
 * `we:scripts/lib/target-registry.mjs#appendRegistryEntry` documents for its own identical lock (stamping
 * `unlocked: true` there; the returned `locked: false` here is the caller-facing equivalent — 2026-09-29 review
 * finding: an earlier revision's CLI wording claimed "no concurrent writer detected" on `locked: false`, which
 * does not hold when `reserve()` failed because ANOTHER writer holds the lock, not because none exists; the
 * caller must read `locked` and say "lock unavailable", never assert who does or doesn't hold it). Refuses —
 * and writes nothing — when the resulting config would itself be invalid, regardless of lock state.
 * @param {{path?:string, patch?:object, owner?:string}} o
 * @returns {{ok:boolean, config?:{enabled:boolean, windowMinutes:number}, errors:string[], locked:boolean}}
 */
export function writeOverlapYieldConfig({ path = defaultOverlapYieldConfigPath(), patch = {}, owner = `${process.pid}@${Date.now()}` } = {}) {
  const lockRoot = `${dirname(path)}-locks`;
  let locked = false;
  try {
    mkdirSync(lockRoot, { recursive: true });
    locked = reserve(
      lockRoot, CONFIG_WRITE_LOCK_KEY, owner, Date.now(), new Date().toISOString(), process.pid, 'unknown', CONFIG_WRITE_LOCK_LEASE_MINUTES,
    ).ok === true;
  } catch { locked = false; }
  try {
    const current = loadOverlapYieldConfig({ path, warn: () => {} });
    const next = { ...current, ...patch };
    const v = validateOverlapYieldConfig(next);
    if (!v.ok) return { ok: false, errors: v.errors, locked };
    writeFileSync(path, `${JSON.stringify(v.config, null, 2)}\n`);
    return { ok: true, config: v.config, errors: [], locked };
  } finally {
    if (locked) { try { releaseLockDir(lockRoot, CONFIG_WRITE_LOCK_KEY); } catch { /* TTL reclaims it */ } }
  }
}

// ───────────────────────── impure: git-history + label-time IO ─────────────────────────

/** `git rev-parse --is-shallow-repository` → `true` / `false` / `null` (unreadable — treated the SAME as
 *  shallow: #4308 Window — "in a shallow clone 'no commit found' cannot be told apart from 'history was cut
 *  off'", so an unreadable answer must fail the SAME safe direction, not the opposite one). */
export function isShallowRepository({ exec = execFileSync, cwd = process.cwd() } = {}) {
  try {
    const out = String(exec('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    if (out === 'true') return true;
    if (out === 'false') return false;
    return null;
  } catch { return null; }
}

/**
 * The REAL `configAt` reader {@link windowMsAtLabelTime} takes: a commit-time lookup against `origin/main` —
 * ALWAYS WE `main`, never a candidate's own base/repo (#4308 Window) — via `git rev-list -1
 * --before=<readyAt> origin/main -- <path>` then `git show <sha>:<path>`. Memoized per exact `ms` for the
 * lifetime of the returned function — an in-memory nicety only (losing it changes nothing; #4308 Window /
 * "An in-memory memo ... only saves the git call").
 * @param {{exec?:Function, cwd?:string, configPath?:string, branch?:string}} o
 * @returns {(ms:number)=>({trusted:boolean, windowMinutes?:(number|null)})}
 */
export function gitHistoryConfigAtReader({
  exec = execFileSync, cwd = process.cwd(), configPath = OVERLAP_YIELD_CONFIG_RELATIVE_PATH, branch = 'origin/main',
} = {}) {
  const shallow = isShallowRepository({ exec, cwd });
  const memo = new Map();
  return function configAt(ms) {
    if (memo.has(ms)) return memo.get(ms);
    let result;
    if (shallow !== false) {
      result = { trusted: false }; // true OR unreadable(null) — never distinguished from a cut-off history
    } else {
      try {
        const iso = new Date(ms).toISOString();
        const sha = String(exec('git', ['rev-list', '-1', `--before=${iso}`, branch, '--', configPath], {
          cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        })).trim();
        if (!sha) {
          result = { trusted: true, windowMinutes: null }; // no commit at/before readyAt ⇒ the file did not exist yet
        } else {
          try {
            const text = String(exec('git', ['show', `${sha}:${configPath}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
            const v = validateOverlapYieldConfig(safeJsonParse(text));
            result = { trusted: true, windowMinutes: v.ok ? v.config.windowMinutes : null };
          } catch {
            result = { trusted: true, windowMinutes: null }; // the path existed at an EARLIER commit, not this one
          }
        }
      } catch {
        result = { trusted: false };
      }
    }
    memo.set(ms, result);
    return result;
  };
}

/**
 * The `ready-to-merge` label's most recent add-time for (repo, num), from GitHub's REST issue events (`gh api
 * repos/<owner>/<repo>/issues/<num>/events`) — cached per (PR, head sha) via the shared by-sha cache
 * ({@link readShaCache}/{@link writeShaCache}, `we:scripts/lib/pr-snapshot.mjs`) so a watch re-reads it only
 * when the head changes (#4308 Data). Returns `null` when the label was never seen (should not happen for a
 * real ready candidate, but never throws on it — the caller's safe direction is "cannot compute a budget ⇒
 * never yield", never "yield forever").
 * @param {{repo:(string|null), num:number, sha:string, exec?:Function, env?:object, dir?:(string|null), label?:string}} o
 * @returns {(number|null)}
 */
export function readyToMergeLabelTimeMs({ repo, num, sha, exec = execFileSyncThrottled, env = process.env, dir = null, label = READY_LABEL } = {}) {
  const kind = 'overlap-yield-ready-at';
  const cached = readShaCache({ repo, num, sha, kind, env, dir });
  if (cached !== undefined) return cached;
  const slug = repo || null;
  if (!slug || !sha) return null;
  let events;
  try {
    const out = exec('gh', ['api', `repos/${slug}/issues/${num}/events`, '--paginate'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
      throttle: { op: 'overlap-yield ready-at' },
    });
    events = JSON.parse(String(out || '[]'));
  } catch { return null; }
  let atMs = null;
  for (const e of (Array.isArray(events) ? events : [])) {
    if (e?.event === 'labeled' && e?.label?.name === label && e?.created_at) {
      const ms = Date.parse(e.created_at);
      if (Number.isFinite(ms)) atMs = ms; // chronological order (GitHub + the fixture) — the LAST add wins
    }
  }
  writeShaCache({ repo, num, sha, kind, value: atMs, env, dir });
  return atMs;
}

/**
 * The drain's own IO orchestration for ONE planning pass (#4308 "plugs in inside `planLabelDrain` ... one more
 * `waitOn` source"). Reads the settings file FRESH every call (#4308 Read cadence — "not once per drain
 * process lifetime"): the caller (`we:scripts/merge-ai-prs.mjs`) is expected to call this again on every
 * `replan`, not hoist it out of the cascade.
 *
 * Two passes over the pure {@link overlapYieldWaits}: a cheap TRIAL (`ignoreBudget: true`) finds which
 * candidates would yield at all under rules 1-5 and 7 (no IO needed for those); only for THOSE candidates does it do
 * the real IO — the label-time read (cached by head sha) and the git-history-backed window — before the REAL
 * pass that also enforces rule 6. A candidate whose label time cannot be read is marked `exempt` for the real
 * pass (never lets a data gap yield forever — the safe direction is "cannot compute a budget ⇒ don't yield").
 * @param {{candidateRows:object[], openPrRows:object[], nowMs?:number, exec?:Function, ghExec?:Function,
 *   cwd?:string, overrides?:{enable:(boolean|null), windowMinutes:(number|null), skipRed?:(boolean|null)}}} o
 * @returns {{waits:Map, skips:Map, settings:{enabled:boolean, windowMinutes:number, skipRed:boolean}}}
 */
export function computeOverlapContext({
  candidateRows, openPrRows, nowMs = Date.now(), exec = execFileSync, ghExec = execFileSyncThrottled,
  cwd = process.cwd(), overrides = {},
} = {}) {
  const fileConfig = loadOverlapYieldConfig({});
  const settings = resolveOverlapYieldSettings({ fileConfig, overrides });
  if (!settings.enabled) return { waits: new Map(), skips: new Map(), settings };
  const xs = Array.isArray(candidateRows) ? candidateRows : [];
  const ys = Array.isArray(openPrRows) ? openPrRows : [];
  const trialSkips = new Map();
  const trial = overlapYieldWaits({ candidates: xs, openPrs: ys, nowMs, ignoreBudget: true, skipRed: settings.skipRed, skips: trialSkips });
  if (!trial.size) return { waits: new Map(), skips: trialSkips, settings };
  const configAt = gitHistoryConfigAtReader({ exec, cwd });
  const enriched = xs.map((x) => {
    if (!trial.has(overlapRowKey(x))) return x;
    const readyAtMs = readyToMergeLabelTimeMs({ repo: x.repo, num: x.number, sha: x.headSha, exec: ghExec });
    if (readyAtMs == null) return { ...x, exempt: true };
    // #4308 Override precedence (2026-09-29 review finding) — an explicit `--overlap-yield-window` override
    // "applies to every candidate's budget in that run" UNCONDITIONALLY, not only when the git-history read is
    // untrusted. `windowMsAtLabelTime`'s `currentWindowMinutes` param feeds ONLY its untrusted-history fallback
    // (`min(current, codeDefault)`) — folding the override in there left it silently inert on an ordinary,
    // trusted (non-shallow) clone, which is the common case. An explicit override BYPASSES the history lookup
    // entirely instead: it is a one-off operator action for this run only, never persisted (Override precedence).
    const windowMs = overrides.windowMinutes != null
      ? overrides.windowMinutes * 60_000
      : windowMsAtLabelTime({
        readyAtMs, configAt, codeDefaultMinutes: DEFAULT_OVERLAP_YIELD_CONFIG.windowMinutes, currentWindowMinutes: settings.windowMinutes,
      });
    return { ...x, readyAtMs, windowMs };
  });
  const skips = new Map();
  const waits = overlapYieldWaits({ candidates: enriched, openPrs: ys, nowMs, skipRed: settings.skipRed, skips });
  return { waits, skips, settings };
}
