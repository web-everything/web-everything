/**
 * @file scripts/lib/free-lane-list.mjs
 * @description THE FREE-LANE LIST — a periodic sweep's ANSWER, handed to `acquire` as a HINT so it never pays
 *   for its own full-pool scan on the common path. Filed under #4122 (`xdtot9p`), parent #4075.
 *
 * THE PROBLEM this exists for (live, 2026-09-25): `we:scripts/lane-pool.mjs acquire`'s auto-pick sources
 * candidates from a shared, cached full-pool scan (`we:scripts/lane-pool.mjs#acquirableListCached`, #xn432dz).
 * That scan is cheap when idle (~35s over ~88 lanes) but grows with load — measured live at 240s for `acquire`
 * and 66s for `list --acquirable` — well past `acquire`'s 180s default wait, while 30+ lanes sat genuinely
 * free the whole time. `we:scripts/conveyor/lane-pool-health-watch.mjs` already walks the WHOLE pool every
 * tick (every few minutes, via launchd) for its own litter-reap/trim/reclaim passes, and already shells the
 * exact `list --acquirable` scan this module wants — it is FREE for this module to piggyback on: after each
 * sweep, {@link buildFreeLaneList} + {@link writeFreeLaneListAtomic} publish that tick's answer once, and
 * `acquire` reads it (near-instant, no git) instead of scanning.
 *
 * NEVER TRUSTED AS TRUTH ALONE. The list can be up to a few minutes stale by the time `acquire` reads it (a
 * lane it names may have gone dirty/leased since), so a consumer must ALWAYS still (1) take the lease
 * ATOMICALLY (the real lock — `we:scripts/lane-pool.mjs#tryClaimLane`'s O_EXCL create) and (2) re-verify ONLY
 * that one lane fresh, with the SAME guards the full scan applies (`we:scripts/lane-pool.mjs#provisionClaimedLane`
 * already does exactly this, unconditionally, for every candidate auto-pick claims — see its own #2924
 * doc-comment). This module never gates anything; it only narrows the candidate SEARCH, the way an index
 * narrows a table scan without ever replacing the row's own check constraint.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors `we:scripts/conveyor/queue-store.mjs`): {@link parseFreeLaneList},
 * {@link isFreeLaneListFresh}, {@link buildFreeLaneList}, {@link serializeFreeLaneList} and
 * {@link freeLaneCandidates} are PURE — no fs/clock — so every freshness/ordering/parse rule is unit-tested
 * without a real pool. {@link resolveFreeLaneListPath}, {@link readFreeLaneList} and
 * {@link writeFreeLaneListAtomic} are the thin IO shell.
 *
 * WHERE THE FILE LIVES (#4052 precedent, `we:scripts/conveyor/queue-store.mjs#STATE_ROOT_ENV`): pinned under
 * `CONVEYOR_STATE_ROOT` when an operator has set one (so a daemon clone rebuilt fresh from `origin/main` never
 * wipes the writer's own state, and every clone reads/writes the ONE physical file); otherwise it lives NEXT
 * TO THE POOL it describes (`<poolDir>/.free-lanes.json`, sibling to `we:scripts/lane-pool.mjs`'s own
 * `.list-acquirable-cache.json`), so an operator with no pinned root still gets a working file with zero
 * config. One file PER POOL (WE / frontierui / plateau-app each write their own), keyed by `repoName`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pinnedStateRoot } from '../conveyor/queue-store.mjs';

// ── PURE CORE (no fs / clock / process — every input is injected) ──────────────────────────────────────────

/** The on-disk schema version — bumped on a shape change so a reader from a mismatched version degrades to
 *  "missing" (never misparses an old/new shape as today's). */
export const FREE_LANE_LIST_VERSION = 1;

/** Default freshness ceiling: a list older than this is treated as STALE (never consulted) — the periodic
 *  sweep runs every few minutes (launchd), so this comfortably outlives one normal tick while still refusing
 *  a list from a health-watch that stopped ticking a while ago. `--free-list-max-age-ms` / the env below
 *  override it per call. */
export const DEFAULT_FREE_LANE_LIST_MAX_AGE_MS = 10 * 60_000;

/** Env override for {@link DEFAULT_FREE_LANE_LIST_MAX_AGE_MS}. */
export const FREE_LANE_LIST_MAX_AGE_ENV = 'LANE_POOL_FREE_LIST_MAX_AGE_MS';

/** Env override for the resolved file path itself — mirrors `we:scripts/conveyor/queue-store.mjs`'s
 *  `CONVEYOR_QUEUE_FILE`: tests + any caller that wants an out-of-tree, full-path-precise file. */
export const FREE_LANE_LIST_FILE_ENV = 'LANE_POOL_FREE_LIST_FILE';

/**
 * Tolerant parse of the free-lane list file's text → the list object, or `null` for anything that is not
 * EXACTLY today's shape (missing/corrupt file, a version bump, a hand-edited/truncated write mid-rename —
 * never possible past the atomic rename below, but a reader must not assume its own writer). NEVER throws.
 * @param {string|null|undefined} text
 * @returns {{v:number, writtenAt:number, repo:string, poolDir:(string|null),
 *   lanes:Array<{lane:number, path:(string|null), head:(string|null), branch:(string|null)}>}|null}
 */
export function parseFreeLaneList(text) {
  if (!text || !String(text).trim()) return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.v !== FREE_LANE_LIST_VERSION) return null;
  if (typeof raw.writtenAt !== 'number' || !Number.isFinite(raw.writtenAt)) return null;
  if (typeof raw.repo !== 'string' || !raw.repo) return null;
  if (!Array.isArray(raw.lanes)) return null;
  const lanes = [];
  for (const l of raw.lanes) {
    const lane = Number(l?.lane);
    if (!Number.isInteger(lane) || lane < 0) continue; // a malformed row is dropped, never lets a bad `lane` through
    lanes.push({
      lane,
      path: typeof l.path === 'string' ? l.path : null,
      head: typeof l.head === 'string' ? l.head : null,
      branch: typeof l.branch === 'string' ? l.branch : null,
      at: Number.isFinite(l.at) ? l.at : raw.writtenAt,
    });
  }
  return { v: raw.v, writtenAt: raw.writtenAt, repo: raw.repo, poolDir: typeof raw.poolDir === 'string' ? raw.poolDir : null, lanes };
}

/**
 * Is `list` fresh enough to consult AT ALL? A missing list (`null`) is never fresh. Clock-skewed (written in
 * the "future" by more than a second) is treated as NOT fresh either — the same fail-closed rule
 * `we:scripts/lane-pool.mjs#readListCache` already applies to its own cache file, so a wildly-wrong system
 * clock degrades to "scan instead" rather than trusting an unverifiable timestamp.
 * @param {ReturnType<typeof parseFreeLaneList>} list
 * @param {number} nowMs
 * @param {number} maxAgeMs
 * @returns {boolean}
 */
export function isFreeLaneListFresh(list, nowMs, maxAgeMs) {
  if (!list || typeof list.writtenAt !== 'number') return false;
  if (list.writtenAt > nowMs + 1000) return false; // clock skew — never trust a "future" write
  return nowMs - list.writtenAt < maxAgeMs;
}

/**
 * Build today's list object from the health-watch's OWN already-computed acquirable rows — never re-derives
 * eligibility itself (that verdict is `we:scripts/lane-pool.mjs list --acquirable`'s, cross-checked into
 * `we:scripts/conveyor/lane-pool-health-watch.mjs#watchLanePoolHealth`'s `acquirableLaneNumbers` already).
 * Sorted ascending by lane number — the same "lowest acquirable first" order `acquire`'s own auto-pick has
 * always used, so consuming this list changes WHICH lane a given acquire tries first only by removing the
 * scan, never by reordering the preference. Dedupes by lane number (first occurrence wins).
 * @param {{repoName:string, poolDir?:(string|null), writtenAt:number,
 *   lanes:Array<{lane:number, path?:string, head?:(string|null), branch?:(string|null)}>}} o
 * @returns {ReturnType<typeof parseFreeLaneList>}
 */
export function buildFreeLaneList({ repoName, poolDir = null, writtenAt, lanes }) {
  const seen = new Set();
  const rows = [];
  for (const l of Array.isArray(lanes) ? lanes : []) {
    const lane = Number(l?.lane);
    if (!Number.isInteger(lane) || lane < 0 || seen.has(lane)) continue;
    seen.add(lane);
    rows.push({ lane, path: l.path ?? null, head: l.head ?? null, branch: l.branch ?? null, at: Number.isFinite(l.at) ? l.at : writtenAt });
  }
  rows.sort((a, b) => a.lane - b.lane);
  return { v: FREE_LANE_LIST_VERSION, writtenAt, repo: repoName, poolDir, lanes: rows };
}

/** Serialize the list back to its on-disk text (newline-terminated). Pure. */
export function serializeFreeLaneList(list) {
  return JSON.stringify(list, null, 2) + '\n';
}

/**
 * The candidate lane NUMBERS a consumer should try, in order — every listed lane not in `exclude`. Pure; the
 * caller (`we:scripts/lane-pool.mjs#cmdAcquire`) is the one that turns a number back into a directory, claims
 * it atomically, and re-verifies it fresh — this function only answers "what order to try", never "is this
 * one still actually free".
 * @param {ReturnType<typeof parseFreeLaneList>} list
 * @param {{exclude?:Set<number>}} [o]
 * @returns {number[]}
 */
export function freeLaneCandidates(list, { exclude = new Set(), nowMs = null, maxAgeMs = null } = {}) {
  if (!list || !Array.isArray(list.lanes)) return [];
  // With a clock + limit, each ENTRY must itself be within the limit (an event-driven touch refreshes the list's
  // writtenAt but never an old entry's own `at`).
  const young = (l) => nowMs == null || maxAgeMs == null || !Number.isFinite(l.at) || (l.at <= nowMs + 1000 && nowMs - l.at < maxAgeMs);
  return list.lanes.filter((l) => young(l)).map((l) => l.lane).filter((n) => !exclude.has(n));
}

// ── THIN FS SHELL ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the free-lane list's path for one pool. An explicit `LANE_POOL_FREE_LIST_FILE` env override wins
 * (tests + any caller that wants an out-of-tree, full-path-precise file — mirrors `CONVEYOR_QUEUE_FILE`).
 * Otherwise: `we:scripts/conveyor/queue-store.mjs#pinnedStateRoot` (`CONVEYOR_STATE_ROOT`, #4052) when an
 * operator has set one — nested under `.conveyor/lane-pool-free-lanes/<repoName>.json`, the same `.conveyor/`
 * sidecar convention that module's own `queuePath` uses, keyed by pool so WE/frontierui/plateau-app never
 * collide under one pinned root. Unset, the file sits NEXT TO THE POOL it describes
 * (`<poolDir>/.free-lanes.json`), needing zero config and matching
 * `we:scripts/lane-pool.mjs`'s own `.list-acquirable-cache.json` sibling convention.
 * @param {{repoName:string, poolDir:string, env?:NodeJS.ProcessEnv}} o
 * @returns {string}
 */
export function resolveFreeLaneListPath({ repoName, poolDir, env = process.env }) {
  const override = env?.[FREE_LANE_LIST_FILE_ENV];
  if (override && String(override).trim()) return String(override).trim();
  const pinned = pinnedStateRoot(env);
  if (pinned) return join(pinned, '.conveyor', 'lane-pool-free-lanes', `${repoName}.json`);
  return join(poolDir, '.free-lanes.json');
}

/** Read + parse the list at `path` — `null` on a missing/corrupt/mismatched-version file (never throws). */
export function readFreeLaneList(path) {
  if (!existsSync(path)) return null;
  try { return parseFreeLaneList(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Write the list ATOMICALLY: a temp file in the SAME directory, then `rename` into place, so a concurrent
 * `acquire` reading mid-write never sees partial JSON (which would parse-fail to `null` anyway — see
 * {@link parseFreeLaneList} — but the temp+rename avoids even that transient miss). Same temp+rename shape as
 * `we:scripts/conveyor/queue-store.mjs#writeQueueFile` / `we:scripts/lane-pool.mjs#writeListCache`, hardened
 * with the exclusive temp create below (those two still use a plain `writeFileSync` on a predictable name).
 *
 * The temp file is created EXCLUSIVELY (`wx` — O_CREAT|O_EXCL, which also refuses to follow a symlink planted
 * at that name) under an unguessable name, retrying under a fresh name on `EEXIST`: a plain `writeFileSync` on
 * a predictable `<path>.<pid>.<ms>.tmp` would follow a pre-placed symlink and overwrite its target (PR #2679
 * security review).
 * @param {string} path
 * @param {ReturnType<typeof buildFreeLaneList>} list
 * @param {{ tmpPathFor?: (path: string, attempt: number) => string, maxAttempts?: number }} [opts] test seams
 */
export function writeFreeLaneListAtomic(path, list, { tmpPathFor = defaultTmpPathFor, maxAttempts = 5 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const text = serializeFreeLaneList(list);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tmp = tmpPathFor(path, attempt);
    try {
      writeFileSync(tmp, text, { flag: 'wx' });
    } catch (e) {
      if (e && e.code === 'EEXIST') continue; // something already sits at that name — never touch it, pick another
      throw e;
    }
    try {
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true }); // never leave our own exclusive temp file behind
      throw e;
    }
    return;
  }
  throw new Error(`writeFreeLaneListAtomic: could not create an exclusive temp file next to ${path} after ${maxAttempts} attempts`);
}

const defaultTmpPathFor = (path) => `${path}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`;

/**
 * Event-driven refresh: apply ONE lane's change (a release makes it free, an acquire/trim makes it not) to the
 * published list and stamp it fresh NOW, without waiting for the periodic health-watch pass (its cadence was
 * 8-44 min apart on 2026-11-03, so the list sat past its freshness limit and `acquire` fell into the full
 * per-lane scan). Carried entries keep their own `at` and are dropped once older than the freshness limit; `acquire` also re-claims and
 * re-verifies every candidate it takes from the list. Best-effort and never throws, so a lane-pool command can
 * never fail because of it.
 * @param {{path:string, repoName:string, poolDir:string, lane:number, free:boolean, now?:number, laneDir?:string, head?:(string|null), branch?:(string|null)}} o
 * @returns {boolean} whether the list was rewritten
 */
export function touchFreeLaneList({ path, repoName, poolDir, lane, free, now = Date.now(), maxAgeMs = DEFAULT_FREE_LANE_LIST_MAX_AGE_MS, laneDir = null, head = null, branch = null }) {
  try {
    if (!Number.isInteger(lane) || lane < 0) return false;
    const prior = readFreeLaneList(path);
    // Carried entries keep their OWN timestamp and are pruned once older than the freshness limit, so an
    // unrelated lane event can never keep an old candidate "fresh" past the maximum age.
    const kept = (prior?.lanes ?? []).filter((l) => l.lane !== lane && Number.isFinite(l.at) && l.at <= now + 1000 && now - l.at < maxAgeMs);
    if (free) kept.push({ lane, path: laneDir ?? join(poolDir, `lane-${lane}`), head, branch, at: now });
    writeFreeLaneListAtomic(path, buildFreeLaneList({ repoName, poolDir, writtenAt: now, lanes: kept }));
    return true;
  } catch { return false; }
}
