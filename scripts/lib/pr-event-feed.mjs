#!/usr/bin/env node
/**
 * @file scripts/lib/pr-event-feed.mjs
 * @description The shared consumer of the PR-events feed (step 1 of the event-driven daemon design, ruling E6,
 * 2026-10-08; card xlta0x5). Two things the in-memory waker in `pr-events.mjs` cannot do:
 *
 *   1. A PERSISTED CURSOR. The waker keeps its feed position in a closure, so every restart starts again at
 *      "now" and the boot sweep covers the gap (review restarted 113 times and fix 60 times in 48 h). Here the
 *      cursor lives in a state file per role, so a restarted consumer reads every event it missed.
 *   2. DIRTY-PR MARKING. An event only marks its PR as changed. It never says what to do (statute
 *      `#event-driven-land-is-wake-only`, #2692): the handler re-reads live state and decides. A CI event that
 *      names no PR (about 40% of them) is resolved through the head-commit → PR map: first the map this consumer
 *      learns from `pull_request` events it sees, then the Durable Object's own `shas` projection through the
 *      `pr-facts` mirror. An event that still resolves to nothing marks `<repo>#?` (look at everything), never
 *      nothing.
 *
 * AT LEAST ONCE. The cursor and the dirty marks are written together, in ONE atomic file write, after each page.
 * So a stored cursor never runs ahead of the marks its events produced. A handler `take()`s a snapshot of the
 * marks when it STARTS and `ack()`s that snapshot when it FINISHES; a mark made after the snapshot (the PR changed
 * again mid-handler) survives the ack, and a crash between take and ack leaves every mark in place for the next
 * start. A repeated mark is harmless: handlers are idempotent because they re-check live state.
 *
 * A `gap` (events pruned before we read them), a `reset` (the log was recreated) and a first start with no stored
 * cursor mark the full-sweep key `*`: something may have happened that no event will tell us about.
 *
 * MODES (setting `prEventFeed.<role>.mode` in `pr-event-feed-settings.json`; env `WE_PR_EVENT_FEED_<ROLE>` wins):
 *   off    — the consumer is not used at all.
 *   shadow — the consumer runs and logs what an event-driven handler would do; behaviour is unchanged.
 *   on     — the handler acts on the marks (for the drain: a mark wakes the next pass early).
 *
 * NEVER A MERGE GATE INPUT. A dirty mark is a hint about WHICH PR to look at. The drain still runs its full
 * merge gate on live GitHub state before every merge; nothing here is passed to `merge-ai-prs.mjs`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PR_EVENTS_DEFAULTS, PR_EVENTS_FLAG_ENV, classifyFeedHealth, defaultStateDir, isRelevantEvent, pollEvents,
  resolvePrEventsConfig, writeStatusFile,
} from './pr-events.mjs';

export const FEED_STATE_VERSION = 1;
export const FEED_MODES = Object.freeze(['off', 'shadow', 'on']);
export const FULL_SWEEP_KEY = '*';
export const FEED_SETTINGS_FILE = 'scripts/lib/pr-event-feed-settings.json';

export const FEED_DEFAULTS = Object.freeze({
  mode: 'off',
  pollEveryMs: 5_000,       // a Worker call (no GitHub budget) — how fast an event becomes a mark
  healthyIntervalSec: null, // null = the handler keeps its own interval; else the safety-net interval while healthy
  maxPages: 5,              // pages read per poll before yielding (the rest is read on the next poll)
  shaMapMax: 1_000,         // learned head-commit → PR entries kept (oldest dropped first)
  maxCauses: 3,             // causes remembered per dirty PR (for the log line)
  maxPrsPerSha: 20,         // PRs remembered for one head commit (a handful in practice; bounds the union)
});

/** Keep only positive safe integers, de-duplicated and bounded: what is written is always what the loader accepts. */
export const cleanPrs = (list) => (Array.isArray(list)
  ? [...new Set(list.filter((n) => Number.isSafeInteger(n) && n > 0))].slice(-FEED_DEFAULTS.maxPrsPerSha) : []);

// ── settings ────────────────────────────────────────────────────────────────────────────────────────────────

const envKey = (role) => `WE_PR_EVENT_FEED_${String(role).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * Resolve one role's feed settings: defaults ← `<root>/scripts/lib/pr-event-feed-settings.json` ← env.
 * An unreadable file or an unknown mode falls back to `off` (fail closed: no new behaviour), with `error` set.
 * @returns {{mode:'off'|'shadow'|'on', pollEveryMs:number, healthyIntervalSec:number|null, source:string, error:string|null}}
 */
export function resolveFeedSettings({ role, root = null, env = process.env, readFile = readFileSync } = {}) {
  let fromFile = {};
  let error = null;
  let source = 'defaults';
  if (root) {
    try {
      const raw = JSON.parse(String(readFile(join(root, FEED_SETTINGS_FILE), 'utf8')));
      fromFile = raw?.prEventFeed?.[role] || {};
      source = 'settings file';
    } catch (e) { error = `settings unreadable (${e?.code || e?.name || 'error'})`; }
  }
  const merged = { ...FEED_DEFAULTS, ...fromFile };
  const override = String(env[envKey(role)] ?? '').trim();
  if (override) { merged.mode = override; source = envKey(role); }
  if (!FEED_MODES.includes(merged.mode)) { error = `unknown mode ${JSON.stringify(merged.mode)}`; merged.mode = 'off'; }
  const pos = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    mode: merged.mode,
    pollEveryMs: pos(merged.pollEveryMs, FEED_DEFAULTS.pollEveryMs),
    healthyIntervalSec: merged.healthyIntervalSec == null ? null : pos(merged.healthyIntervalSec, null),
    source, error,
  };
}

/** The env name that overrides a role's mode (documented for operators). */
export const feedModeEnv = envKey;

// ── state (PURE helpers) ────────────────────────────────────────────────────────────────────────────────────

export function emptyFeedState(role) {
  return { v: FEED_STATE_VERSION, role, cursor: null, markSeq: 0, dirty: {}, shaPrs: {},
    stats: { events: 0, relevant: 0, marked: 0, resolvedBySha: 0, unresolved: 0, fullSweeps: 0 }, updatedAt: null };
}

export const dirtyKey = (repo, number) => `${String(repo).toLowerCase()}#${number == null ? '?' : number}`;
const shaKey = (repo, sha) => `${String(repo).toLowerCase()} ${sha}`;

/** Add (or refresh) one mark. Returns a NEW state. */
export function markDirty(state, { key, repo = null, number = null, cause, at }) {
  const next = { ...state, dirty: { ...state.dirty }, markSeq: state.markSeq + 1 };
  const prev = next.dirty[key];
  const causes = [...new Set([...(prev?.causes || []), cause])].slice(-FEED_DEFAULTS.maxCauses);
  next.dirty[key] = { repo, number, mark: next.markSeq, firstAt: prev?.firstAt ?? at, lastAt: at, causes };
  return next;
}

/** Remember head commit → PR numbers from an event that carries both. Bounded; oldest entries drop first. */
export function learnSha(state, event, { max = FEED_DEFAULTS.shaMapMax } = {}) {
  if (!event?.sha || !event.repo || !Array.isArray(event.prs) || !event.prs.length) return state;
  if (event.type !== 'pull_request') return state; // a PR event names a PR on its head; a check's list may be partial
  const prs = cleanPrs(event.prs);
  if (!prs.length) return state;
  const k = shaKey(event.repo, event.sha);
  const shaPrs = { ...state.shaPrs };
  const known = shaPrs[k] || []; // two PRs can share one head commit: keep every PR learned for it, never replace
  delete shaPrs[k]; // re-insert at the end: insertion order is the age order
  shaPrs[k] = cleanPrs([...known, ...prs]);
  const keys = Object.keys(shaPrs);
  for (const old of keys.slice(0, Math.max(0, keys.length - max))) delete shaPrs[old];
  return { ...state, shaPrs };
}

const describeEvent = (e) => `${e.type}.${e.action || ''}${e.label ? `(${e.label})` : ''}${e.conclusion ? `=${e.conclusion}` : ''}@${e.seq}`;

/**
 * Fold one page of events into the state. PURE. `relevant(e)` filters; `resolved` maps `"<repo> <sha>"` to PR
 * numbers already looked up (the caller fetched them). Returns `{ state, marked:[{key,cause}] }`.
 */
export function foldEvents(state, events, { relevant, resolved = {}, at }) {
  let s = { ...state, stats: { ...state.stats } };
  const marked = [];
  for (const e of events || []) {
    if (!e || typeof e !== 'object') continue;
    s.stats.events += 1;
    s = learnSha(s, e);
    if (!relevant(e)) continue;
    s.stats.relevant += 1;
    let prs = Array.isArray(e.prs) ? e.prs.filter((n) => Number.isSafeInteger(n) && n > 0) : [];
    let cause = describeEvent(e);
    if (!prs.length && e.sha) {
      const k = shaKey(e.repo, e.sha);
      // Union of what this consumer learned and what the Durable Object knows: a PR sharing the head commit that
      // this consumer never saw (older than its cursor, evicted from the map) is still marked.
      const hit = cleanPrs([...(s.shaPrs[k] || []), ...(Array.isArray(resolved[k]) ? resolved[k] : [])]);
      if (hit.length) { prs = hit; cause += ' via head commit'; s.stats.resolvedBySha += 1; }
    }
    if (!prs.length) {
      s.stats.unresolved += 1;
      const key = dirtyKey(e.repo, null);
      s = markDirty(s, { key, repo: String(e.repo).toLowerCase(), number: null, cause: `${cause} (no PR found)`, at });
      marked.push({ key, cause });
      continue;
    }
    for (const n of prs) {
      const key = dirtyKey(e.repo, n);
      s = markDirty(s, { key, repo: String(e.repo).toLowerCase(), number: n, cause, at });
      marked.push({ key, cause });
    }
    s.stats.marked += prs.length;
  }
  return { state: s, marked };
}

/** The handler-start snapshot: key → mark number. PURE. */
export function takeSnapshot(state) {
  return Object.fromEntries(Object.entries(state.dirty).map(([k, v]) => [k, v.mark]));
}

/** Drop every mark the snapshot covered and that was not re-marked since. PURE. */
export function ackSnapshot(state, snapshot) {
  const dirty = { ...state.dirty };
  for (const [k, mark] of Object.entries(snapshot || {})) if (dirty[k] && dirty[k].mark <= mark) delete dirty[k];
  return { ...state, dirty };
}

/**
 * A one-line summary of a set of marks for a log: how many PRs, how long the oldest has waited. PURE.
 * @returns {{count:number, full:boolean, keys:string[], oldestWaitMs:number|null, medianWaitMs:number|null}}
 */
export function describeDirty(dirty, now) {
  const entries = Object.entries(dirty || {});
  const waits = entries.map(([, v]) => now - v.firstAt).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: entries.length, full: entries.some(([k]) => k === FULL_SWEEP_KEY),
    keys: entries.map(([k]) => k).sort(),
    oldestWaitMs: waits.length ? waits[waits.length - 1] : null,
    medianWaitMs: waits.length ? waits[Math.floor(waits.length / 2)] : null,
  };
}

// ── state file (IO) ─────────────────────────────────────────────────────────────────────────────────────────

/** `<stateDir>/feeds/<role>.json` — a sub-directory, so the waker status probe (`*.json` in stateDir) never reads it. */
export function feedStatePath(stateDir, role) {
  return join(stateDir, 'feeds', `${role}.json`);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isNumOrNull = (v) => v == null || Number.isFinite(v);

/**
 * Validate a parsed state file against the shape `markDirty` / `takeSnapshot` / `foldEvents` rely on. PURE.
 * Anything off (a null or array where an object belongs, a non-integer cursor, a mark that cannot be acked, a
 * `markSeq` behind a stored mark, a `__proto__` key) is rejected as a whole: the caller treats the file as a
 * first start rather than crash-looping on it. Optional fields may be absent (the empty state fills them).
 * @returns {string|null} null when valid, else the reason
 */
export function validateFeedState(s, role) {
  if (!isPlainObject(s)) return 'not an object';
  if (s.v !== FEED_STATE_VERSION) return 'version';
  if (s.role !== role) return 'role';
  if (s.cursor != null && !isCount(s.cursor)) return 'cursor';
  if (s.markSeq != null && !isCount(s.markSeq)) return 'markSeq';
  if (!isNumOrNull(s.updatedAt)) return 'updatedAt';
  if (!isPlainObject(s.dirty)) return 'dirty';
  let maxMark = 0;
  for (const [k, m] of Object.entries(s.dirty)) {
    if (k === '__proto__' || !isPlainObject(m) || !isCount(m.mark)) return 'dirty entry';
    if (m.repo != null && typeof m.repo !== 'string') return 'dirty entry repo';
    if (m.number != null && !(Number.isSafeInteger(m.number) && m.number > 0)) return 'dirty entry number';
    if (!Number.isFinite(m.firstAt) || !Number.isFinite(m.lastAt)) return 'dirty entry time'; // describeDirty needs a real first-mark time
    if (m.causes != null && m.causes.length > FEED_DEFAULTS.maxCauses) return 'dirty entry causes (bound)';
    if (m.causes != null && !(Array.isArray(m.causes) && m.causes.every((c) => typeof c === 'string'))) return 'dirty entry causes';
    maxMark = Math.max(maxMark, m.mark);
  }
  if ((s.markSeq ?? 0) < maxMark) return 'markSeq behind a stored mark'; // a new mark would look already acked
  if (!isPlainObject(s.shaPrs)) return 'shaPrs';
  const shaKeys = Object.entries(s.shaPrs);
  if (shaKeys.length > FEED_DEFAULTS.shaMapMax) return 'shaPrs (bound)';
  for (const [k, v] of shaKeys) {
    if (k === '__proto__' || !Array.isArray(v) || v.length > FEED_DEFAULTS.maxPrsPerSha || !v.every((n) => Number.isSafeInteger(n) && n > 0)) return 'shaPrs entry';
  }
  if (s.stats != null) {
    if (!isPlainObject(s.stats) || !Object.values(s.stats).every((n) => Number.isFinite(n))) return 'stats';
  }
  return null;
}

/** Read a role's state; a missing, unreadable or malformed file is a first start (empty state, cursor null). */
export function loadFeedState(path, role, { readFile = readFileSync } = {}) {
  try {
    const s = JSON.parse(String(readFile(path, 'utf8')));
    const invalid = validateFeedState(s, role);
    if (invalid) return { state: emptyFeedState(role), loaded: false, invalid };
    const empty = emptyFeedState(role);
    return {
      state: {
        ...empty, cursor: s.cursor ?? null, markSeq: s.markSeq ?? 0, dirty: s.dirty, shaPrs: s.shaPrs,
        stats: { ...empty.stats, ...(s.stats || {}) }, updatedAt: s.updatedAt ?? null,
      },
      loaded: true,
    };
  } catch { return { state: emptyFeedState(role), loaded: false }; }
}

/** Write the whole state atomically (temp file + rename on the same filesystem). Throws on failure. */
export function saveFeedState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

// ── head commit → PR through the Durable Object's projection (the pr-facts mirror) ──────────────────────────

/** Default resolver: the `shas` bucket of the pr-facts mirror (one host-shared file; a Worker call at most every 15 s). */
export async function resolveShaFromMirror(repo, sha, { env = process.env } = {}) {
  const { loadMirror } = await import('./pr-facts.mjs');
  const { mirror } = await loadMirror({ repo, env });
  const hit = mirror?.buckets?.shas?.[JSON.stringify([String(repo).toLowerCase(), sha])];
  return Array.isArray(hit) && hit.length ? hit : null;
}

// ── the consumer (IO) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * One role's feed consumer. Construct once per process; call `pollOnce()` on a timer, `take()` when a handler
 * starts and `ack(snapshot)` when it ends.
 *
 * @param {{role:string, url:string, token:string, stateDir?:string, statePath?:string, repos?:string[]|null,
 *   relevant?:(e:object)=>boolean, poll?:Function, resolveSha?:(repo:string, sha:string)=>Promise<number[]|null>,
 *   now?:()=>number, save?:Function, load?:Function, writeStatus?:Function|null, maxPages?:number, log?:{error:Function}}} o
 */
export function createFeedConsumer(o) {
  const {
    role, url, token, repos = null, poll = pollEvents, resolveSha = resolveShaFromMirror,
    now = () => Date.now(), save = saveFeedState, load = loadFeedState, maxPages = FEED_DEFAULTS.maxPages,
    log = console, staleAfterMs = PR_EVENTS_DEFAULTS.staleAfterMs,
  } = o;
  const stateDir = o.stateDir ?? defaultStateDir();
  const statePath = o.statePath ?? feedStatePath(stateDir, role);
  const relevant = o.relevant ?? ((e) => isRelevantEvent(e, role, { repos }));
  const writeStatus = o.writeStatus !== undefined ? o.writeStatus : (s) => writeStatusFile(stateDir, role, s);
  const loaded = load(statePath, role);
  if (loaded.invalid) log.error(`pr-event-feed(${role}): stored state rejected (${loaded.invalid}); treating as a first start`);
  let state = loaded.state;
  const health = { lastOkAt: null, lastFailAt: null, lastDeliveryAt: null, lastEventAt: null, lastError: null };
  const resumedFrom = loaded.loaded ? state.cursor : null;

  function persist() {
    state = { ...state, updatedAt: now() };
    try { save(statePath, state); return true; }
    catch (e) { log.error(`pr-event-feed(${role}): state write failed (marks kept in memory; the next write retries): ${String(e?.message || e).split('\n')[0]}`); return false; }
  }

  function report() {
    if (!writeStatus) return;
    try {
      writeStatus({ role, repos, health: classifyFeedHealth({ ...health, now: now(), staleAfterMs }), cursor: state.cursor,
        ...health, effectiveIntervalMs: null, pollEveryMs: null, staleAfterMs, dirty: Object.keys(state.dirty).length,
        persisted: true, updatedAt: now() });
    } catch { /* status is observability only */ }
  }

  /** Read every page available since the stored cursor (bounded), marking as we go. Never throws. */
  async function pollOnce() {
    const fromCursor = state.cursor;
    const marked = [];
    let events = 0; let gap = false; let reset = false; let error = null; let more = false;
    for (let page = 0; page < maxPages; page += 1) {
      const r = await poll(state.cursor, { url, token });
      if (!r || !r.ok) { health.lastFailAt = now(); health.lastError = error = r?.error || 'poll failed'; break; }
      health.lastOkAt = now(); health.lastError = null;
      health.lastDeliveryAt = r.lastDeliveryAt ?? health.lastDeliveryAt; health.lastEventAt = r.lastEventAt ?? health.lastEventAt;
      const at = now();
      if (state.cursor == null || r.reset || r.gap) {
        const cause = state.cursor == null ? 'first start: no stored cursor' : r.gap ? 'feed gap (events pruned before read)' : 'feed reset (log recreated)';
        if (r.gap) gap = true; else reset = true;
        state = markDirty(state, { key: FULL_SWEEP_KEY, cause, at });
        state = { ...state, stats: { ...state.stats, fullSweeps: state.stats.fullSweeps + 1 } };
        marked.push({ key: FULL_SWEEP_KEY, cause });
      }
      // Look up the head commits we cannot resolve locally, once each, before the pure fold.
      const resolved = {};
      for (const e of r.events || []) {
        if (!e?.sha || (Array.isArray(e.prs) && e.prs.length) || !relevant(e)) continue;
        const k = shaKey(e.repo, e.sha);
        if (k in resolved) continue; // once per head commit per page; the local map is unioned with it, not a substitute
        try { resolved[k] = await resolveSha(e.repo, e.sha); } catch { resolved[k] = null; }
      }
      const folded = foldEvents(state, r.events || [], { relevant, resolved, at });
      state = { ...folded.state, cursor: r.cursor };
      marked.push(...folded.marked);
      events += (r.events || []).length;
      persist(); // cursor + marks in ONE write: the stored cursor never runs ahead of its marks
      more = !!r.more;
      if (!r.more) break;
    }
    report();
    return { ok: !error, error, fromCursor, cursor: state.cursor, events, marked, gap, reset, more };
  }

  return {
    pollOnce,
    /** Snapshot the marks at handler start. */
    take: () => takeSnapshot(state),
    /** Clear the snapshot's marks at handler end (marks made since survive). Persists. */
    ack(snapshot) { state = ackSnapshot(state, snapshot); persist(); },
    dirty: () => ({ ...state.dirty }),
    hasDirty: () => Object.keys(state.dirty).length > 0,
    health: () => classifyFeedHealth({ ...health, now: now(), staleAfterMs }),
    state: () => state,
    statePath,
    resumedFrom,
  };
}

/**
 * Build a consumer from env (the pr-events URL + read token) for a role, or `{ consumer:null, reason }`.
 * The `WE_PR_EVENTS` flag is not required here: the role's mode setting is the switch.
 */
export function createFeedConsumerFromEnv({ role, env = process.env, ...rest } = {}) {
  const cfg = resolvePrEventsConfig({ ...env, [PR_EVENTS_FLAG_ENV]: '1' });
  if (!cfg.enabled) return { consumer: null, reason: `feed not configured (missing ${cfg.missing.join(', ') || cfg.tokenError})` };
  return { consumer: createFeedConsumer({ role, url: cfg.url, token: cfg.token, stateDir: cfg.stateDir, ...rest }), reason: null };
}
