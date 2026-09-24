/**
 * @file scripts/operations/telemetry-store.mjs
 * @description THE THIN IO SHELL over {@link ./telemetry.mjs} (#3383) — where a delivery span/metric lands on
 * disk, and the never-throwing RECORDER handle every dispatch wrapper and the runner tick loop call.
 *
 * The pure core — what an event IS, how it validates, serializes, parses, and rolls up into the four golden
 * signals — lives next door and is re-exported here so a caller has ONE import. Same split as
 * `call-log.mjs`/`call-log-store.mjs` and `run-record.mjs`/`run-store.mjs`.
 *
 * ================================================================================================
 * WHERE IT LIVES, AND WHY THAT SHAPE — `we:.operations/telemetry/<YYYY-MM-DD>.jsonl`
 *
 * A gitignored, DAY-ROTATED, append-only NDJSON sidecar with an `OPERATION_TELEMETRY_DIR` override, rooted at
 * a SHARED workspace location so every clone of this repo on the host — the primary checkout and every lane
 * — agrees on one directory (fixed 2026-09, #3383 follow-on: it originally resolved by SCRIPT LOCATION alone,
 * mirroring `call-log-store.mjs`, which meant each lane clone wrote its own private, never-read sidecar —
 * see {@link TELEMETRY_ROOT}'s own docblock for the fix). Three properties decided the NDJSON shape over the
 * alternatives, each of which is a real store already in this directory:
 *
 *   1. ONE FILE PER RUN (the `run-store.mjs` / `completion-store.mjs` shape: temp-write + rename, one JSON
 *      document per key) was rejected because a span is not a document. A single delivery emits 8–12 spans
 *      from ONE process; a document store would either need 12 files or a read-modify-write of one file per
 *      span, and read-modify-write is precisely what breaks when N dispatched lanes run at once.
 *   2. APPEND-ONLY NDJSON IS CONCURRENCY-SAFE WITHOUT A LOCK. Every writer opens `O_APPEND` and writes ONE
 *      line; POSIX guarantees an append of at most `PIPE_BUF` (4096 bytes on macOS and Linux) is atomic, so
 *      lines from concurrent lanes interleave as whole lines and never corrupt each other. This is the
 *      reason `telemetry.mjs#MAX_LINE_BYTES` is 3800 rather than "large enough" — the bound is not a style
 *      preference, it is what makes the lock-free concurrency claim true. Nothing here takes a lock,
 *      which also means a telemetry write can never deadlock a delivery.
 *   3. DAY ROTATION MAKES THE ROLLING-WINDOW QUERY CHEAP. The rolling-24h capacity view
 *      (`we:backlog/3569-*`) reads at most TWO files regardless of how long the system has been running, and
 *      a retention sweep is `rm` of old days rather than a compaction pass.
 *
 * A SECOND STREAM WAS NOT MINTED. `.operations/calls/<day>.jsonl` (`call-log-store.mjs`) is the ACCESS log —
 * "operation X was called" — with four fields, no duration, no correlation id, and explicitly nothing
 * resumable. This is the TRACE log. Folding spans into the call log would break its own stated contract (a
 * line there is a single instant), and folding the call log into this one would put a `compute`-only
 * page-load read in the same stream as a 40-minute delivery. They are siblings on purpose.
 * ================================================================================================
 *
 * THE PURITY DISCIPLINE — THE LOAD-BEARING PROPERTY OF THIS FILE.
 *
 * This code runs INSIDE the critical path of every real delivery. The same rule the driver watchdog is held
 * to applies with full force: **a telemetry bug must never be able to break a delivery.** Concretely:
 *
 *   • NOTHING IN THE RECORDER THROWS. Every public method of {@link createTelemetryRecorder}'s handle is
 *     wrapped; a failure returns `{ok: false, error}` and is counted on the handle's own `errors` counter,
 *     never propagated. A caller may ignore the return value entirely, and every call site does.
 *   • NO SUBPROCESS, NO NETWORK, NO LOCK, NO TIMER, NO ASYNC. One `appendFileSync` of one bounded line. There
 *     is no exporter to flush, so there is nothing to lose at exit and nothing to shut down — which is why a
 *     `SIGKILL`ed process loses at most the span it was inside, and why {@link DURABLE_SPAN_NAMES} exists to
 *     make even that visible.
 *   • FAIL-OPEN ON READ, unlike `run-store.mjs`. A torn last line (a process killed mid-append) yields
 *     `corrupt: 1` and the remaining events, never a throw — nothing is ever RESUMED from this log, so the
 *     fail-closed reasoning that protects run records ("a torn record must not read as never-happened") does
 *     not apply and would only turn an observability file into an outage.
 *   • KILLABLE BY ENV. `WE_TELEMETRY=0` yields a recorder whose methods are no-ops with the identical shape,
 *     so disabling it changes nothing about call-site control flow.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyOutcomeStatus, deriveTraceId, newMetric, newSpanEnd, newSpanStart, parseTelemetryLines,
  serializeTelemetryEvent, validateTelemetryEvent, DURABLE_SPAN_NAMES,
} from './telemetry.mjs';
import { workspaceFor } from '../lib/lane-pool-paths.mjs';

export {
  DISPATCH_KINDS,
  ERROR_OUTCOMES,
  OK_OUTCOMES,
  classifyOutcomeStatus,
  DURABLE_SPAN_NAMES,
  EVENT_TYPES,
  MAX_ATTRIBUTE_KEYS,
  MAX_LINE_BYTES,
  MAX_VALUE_LENGTH,
  METRIC_NAMES,
  METRIC_UNITS,
  SPAN_NAMES,
  SPAN_STATUS,
  TELEMETRY_SCHEMA_VERSION,
  deriveTraceId,
  durationMs,
  goldenSignals,
  groupByTrace,
  newMetric,
  newSpanEnd,
  newSpanStart,
  normItemKey,
  normalizeAttributes,
  parseTelemetryLine,
  parseTelemetryLines,
  percentile,
  serializeTelemetryEvent,
  truncateValue,
  validateTelemetryEvent,
} from './telemetry.mjs';

// Resolved by SCRIPT LOCATION, never CWD — same reason `call-log-store.mjs#CALLS_ROOT` is.
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * THIS PROCESS'S OWN checkout root — the lane/primary clone the code is actually running from. Used ONLY
 * for git-resource detection ({@link readGitResource}/{@link resourceAttributes}): a span's `branch`/`commit`
 * resource attributes must describe the clone that produced it, which is necessarily per-clone and must
 * NEVER be repointed at the shared storage location below (that directory holds no `.git` of its own).
 */
const CHECKOUT_ROOT = resolve(HERE, '..', '..');

/**
 * THE SHARED STORAGE ROOT — bugfix (#3383 follow-on, storage fragmentation). Before this fix `TELEMETRY_ROOT`
 * WAS `CHECKOUT_ROOT`, so every lane clone (each its own full `git clone` under `we:.lanes/<pool>/lane-N` —
 * confirmed on disk to be a real `.git` DIRECTORY, not a linked worktree, so nothing shares an object store
 * or a common dir the way a `git worktree add` clone would) resolved its own private
 * `<clone>/.operations/telemetry/`, and a rolling-window rollup run from any ONE clone only ever saw that
 * clone's own slice of dispatch history — silently, with no error, which is exactly how the fragmentation
 * went unnoticed.
 *
 * Fixed by reusing {@link workspaceFor} — the IDENTICAL "many clones, one source of truth" derivation
 * `lane-pool-paths.mjs` already established for `LANE_POOL_ROOT` (`defaultPoolRoot`), rather than inventing a
 * second convention: it strips a path at its `.lanes` segment (a lane clone) or takes the parent (a primary
 * checkout), so `<workspace>/webeverything` and `<workspace>/.lanes/<pool>/lane-N` both resolve to the SAME
 * `<workspace>` — one physical directory every clone on the host agrees on, with no coordination between them.
 *
 * Wrapped in a try/catch and falling back to this clone's own `CHECKOUT_ROOT` on any failure — degrading to
 * the (fragmented, but previously-shipped) per-clone behavior rather than throwing, because a telemetry-root
 * bug must never be able to break a delivery (see the file header's purity discipline).
 *
 * `OPERATION_TELEMETRY_DIR` (below) remains the escape hatch for a fully explicit override of the final
 * directory, independent of this root.
 */
export const TELEMETRY_ROOT = (() => {
  try {
    return workspaceFor(CHECKOUT_ROOT);
  } catch {
    return CHECKOUT_ROOT;
  }
})();

/** The env var that turns recording off entirely. Any value other than `0`/`false`/`off` leaves it on. */
export const TELEMETRY_ENV = 'WE_TELEMETRY';

/** `<root>/.operations/telemetry` — the sidecar directory, overridable via `OPERATION_TELEMETRY_DIR`. */
export function telemetryDir(root = TELEMETRY_ROOT) {
  const override = process.env.OPERATION_TELEMETRY_DIR;
  if (override && String(override).trim() !== '') return resolve(String(override));
  return join(root, '.operations', 'telemetry');
}

/**
 * The day key (`YYYY-MM-DD`) an event at `isoOrDate` belongs to.
 *
 * UTC, NEVER THE OPERATOR'S LOCAL DAY — and that is a deliberate departure from `local-date.mjs`'s standing
 * rule (#2747), so it is justified rather than assumed. That rule governs a date-only stamp a HUMAN reads as
 * a calendar day: `dateOpened` on a backlog card, a report's filename. This is neither. It is a STORAGE
 * PARTITION KEY for a machine log whose every record already carries a full UTC instant, and it has to satisfy
 * two properties the local day cannot:
 *
 *   1. Two machines in different zones appending to the same log must agree on which file a given instant
 *      belongs in. A local-day key would file the same instant under two different names.
 *   2. The rolling-window read (`telemetry-cli.mjs#daysInWindow`) derives candidate day keys by UTC
 *      arithmetic on the event instants themselves; a locally-keyed filename would not line up with it, and a
 *      DST transition would silently drop or duplicate an hour of events.
 *
 * This is exactly the "UTC-anchored arithmetic rather than a wall-clock read" case the scan's own exemption
 * names. `call-log-store.mjs#dayKey` — the sibling append-only store — makes the same choice.
 *
 * utc-day-slice-ok: a machine log's storage partition key, not an operator-facing calendar date; must be
 * zone-independent so concurrent writers on different hosts agree which day file an instant belongs to, and
 * so the rolling-window reader's UTC arithmetic lines up with the filenames.
 */
export function dayKey(isoOrDate = new Date()) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(String(isoOrDate));
  const usable = Number.isNaN(d.getTime()) ? new Date() : d;
  // utc-day-slice-ok: a machine log's storage PARTITION KEY, not an operator-facing calendar date. It must be
  // zone-independent so two hosts appending to one log agree which day file an instant belongs in, and so the
  // rolling-window reader's UTC arithmetic lines up with the filenames. Full reasoning in the docblock above;
  // `call-log-store.mjs#dayKey`, the sibling append-only store, makes the same call.
  return usable.toISOString().slice(0, 10);
}

/** Whether telemetry is enabled for this process. */
export function telemetryEnabled(env = process.env) {
  const v = String(env[TELEMETRY_ENV] ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

// ── RESOURCE ATTRIBUTES ──────────────────────────────────────────────────────────────────────────────

let cachedResource = null;

/**
 * Read the commit sha and branch WITHOUT spawning `git` — `.git/HEAD`, then either the loose ref file or a
 * scan of `.git/packed-refs`. A subprocess in the recorder's constructor would violate the no-subprocess rule
 * above (and would cost ~30ms on every wrapper start for a value that never changes mid-process).
 *
 * Handles the worktree/lane-clone case where `.git` is a FILE (`gitdir: …`) rather than a directory. Returns
 * `{branch, commit}` with `null`s rather than throwing on anything unexpected.
 * @param {string} [root]
 * @returns {{branch: (string|null), commit: (string|null)}}
 */
export function readGitResource(root = CHECKOUT_ROOT) {
  try {
    let gitPath = join(root, '.git');
    if (!existsSync(gitPath)) return { branch: null, commit: null };
    const stat = readFileSync;
    // `.git` as a FILE means a worktree/submodule: it holds `gitdir: <path>`.
    let isDir = true;
    try {
      readdirSync(gitPath);
    } catch {
      isDir = false;
    }
    if (!isDir) {
      const pointer = String(stat(gitPath, 'utf8')).trim();
      const m = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!m) return { branch: null, commit: null };
      gitPath = resolve(root, m[1].trim());
    }
    const head = String(readFileSync(join(gitPath, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return { branch: null, commit: /^[0-9a-f]{40}$/i.test(head) ? head : null };
    const refName = ref[1].trim();
    const branch = refName.replace(/^refs\/heads\//, '');
    const loose = join(gitPath, refName);
    if (existsSync(loose)) return { branch, commit: String(readFileSync(loose, 'utf8')).trim() || null };
    const packed = join(gitPath, 'packed-refs');
    if (existsSync(packed)) {
      for (const line of String(readFileSync(packed, 'utf8')).split('\n')) {
        const pm = /^([0-9a-f]{40})\s+(.+)$/.exec(line.trim());
        if (pm && pm[2] === refName) return { branch, commit: pm[1] };
      }
    }
    return { branch, commit: null };
  } catch {
    return { branch: null, commit: null };
  }
}

/**
 * The RESOURCE bag — OTel's "which entity produced this telemetry". Identical for every span in a process, so
 * it is computed ONCE and cached: repo root, branch + short commit sha (so a span can be attributed to the
 * exact code that produced it — the thing `we:backlog/3439-*` showed a stale checkout can silently violate),
 * host, pid, and the runner/session identity when one is in the environment.
 * @param {{root?: string, env?: object}} [o]
 * @returns {object}
 */
export function resourceAttributes({ root = CHECKOUT_ROOT, env = process.env } = {}) {
  if (cachedResource) return cachedResource;
  let git = { branch: null, commit: null };
  let host = null;
  try { git = readGitResource(root); } catch { /* resource detection is best-effort by construction */ }
  try { host = hostname(); } catch { /* ignore */ }
  cachedResource = {
    repo: 'web-everything',
    branch: git.branch,
    commit: git.commit ? String(git.commit).slice(0, 12) : null,
    host,
    pid: process.pid,
    runner: env.WE_CONVEYOR_RUNNER_ID || env.CONVEYOR_RUNNER_ID || null,
    session: env.CLAUDE_CODE_SESSION_ID || null,
  };
  return cachedResource;
}

/** Test seam: forget the cached resource bag so a test can vary the environment.
 *  @test-only-export-ok: the cache exists precisely so the git read happens ONCE per process, which is what
 *  keeps the recorder subprocess-free and ~free per span. Production must therefore never reset it; a test
 *  that varies the repo root or the environment has no other way to observe a second detection. */
export function resetResourceCache() {
  cachedResource = null;
}

// ── THE STORE HANDLE ─────────────────────────────────────────────────────────────────────────────────

/**
 * The FILE-backed store: `append` one event, `readDay`/`days`/`readAll` back. Mirrors
 * `call-log-store.mjs#createFileCallLogStore`'s shape (an `append` rather than `read/write/delete`, since a
 * telemetry log is write-mostly), and is the documented #2626 swap point for a future non-file backend.
 * @param {{dir?: string}} [o]
 */
export function createFileTelemetryStore({ dir = telemetryDir() } = {}) {
  return {
    dir,
    /** Append one already-serialized line. Returns `{ok}`; never throws. */
    append(line, day) {
      try {
        if (!line) return { ok: false, error: 'empty line' };
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `${day}.jsonl`), line);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },
    /** The day keys present on disk, ascending. */
    days() {
      try {
        if (!existsSync(dir)) return [];
        // `<day>.jsonl.gz` is a rolled-over day (`host-sampler-retention.mjs`): history stays readable, never dropped.
        return [...new Set(readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)).map((f) => f.slice(0, 10)))].sort();
      } catch {
        return [];
      }
    },
    /** Parse one day file → `{events, corrupt}`. A missing day is `{events: [], corrupt: 0}`, not an error. */
    readDay(day) {
      try {
        const p = join(dir, `${day}.jsonl`);
        if (existsSync(p)) return parseTelemetryLines(readFileSync(p, 'utf8'));
        const gz = `${p}.gz`;
        if (existsSync(gz)) return parseTelemetryLines(gunzipSync(readFileSync(gz)).toString('utf8'));
        return { events: [], corrupt: 0 };
      } catch {
        return { events: [], corrupt: 0 };
      }
    },
    /** Every event across the named days (default: all days on disk), concatenated in day order. */
    readAll(dayList) {
      const wanted = Array.isArray(dayList) ? dayList : this.days();
      const events = [];
      let corrupt = 0;
      for (const d of wanted) {
        const r = this.readDay(d);
        events.push(...r.events);
        corrupt += r.corrupt;
      }
      return { events, corrupt };
    },
  };
}

/**
 * The MEMORY store twin — serializes then re-parses on append, exactly like `run-store.mjs`'s memory twin, so
 * a test using it catches the same shape and size bugs the real file store would (a test against a store that
 * keeps live object references would silently pass on a record that cannot actually round-trip).
 *
 * Every store in this directory ships a memory twin alongside its file store — createMemoryRunStore and
 * createMemoryCallLogStore are the two precedents — as the documented #2626 backend-swap point.
 *
 * @test-only-export-ok: production deliberately binds the FILE store; the twin is the seam a test, and a
 * future non-file backend, binds instead. Dropping it would break the convention every sibling store follows.
 */
export function createMemoryTelemetryStore() {
  const byDay = new Map();
  return {
    dir: '<memory>',
    append(line, day) {
      if (!line) return { ok: false, error: 'empty line' };
      byDay.set(day, (byDay.get(day) || '') + line);
      return { ok: true };
    },
    days() {
      return [...byDay.keys()].sort();
    },
    readDay(day) {
      return parseTelemetryLines(byDay.get(day) || '');
    },
    readAll(dayList) {
      const wanted = Array.isArray(dayList) ? dayList : this.days();
      const events = [];
      let corrupt = 0;
      for (const d of wanted) {
        const r = this.readDay(d);
        events.push(...r.events);
        corrupt += r.corrupt;
      }
      return { events, corrupt };
    },
    /** Test-only: the raw NDJSON text for a day. */
    raw(day) {
      return byDay.get(day) || '';
    },
  };
}

// ── THE RECORDER — the surface every wrapper calls ───────────────────────────────────────────────────

let spanCounter = 0;

/** A short, collision-resistant-enough span id. Not a UUID: a span id appears in every line of a hot log, and
 *  16 hex characters is OTel's own span-id width. Monotone counter + randomness, so two spans from the same
 *  process in the same millisecond still differ. */
function defaultSpanId() {
  spanCounter = (spanCounter + 1) % 0xffff;
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const seq = spanCounter.toString(16).padStart(4, '0');
  const t = (Date.now() & 0xffff).toString(16).padStart(4, '0');
  return `${rand}${seq}${t}`;
}

/** The no-op handle a disabled recorder hands out — identical SHAPE, zero side effects, so a call site never
 *  needs an `if (telemetry)` guard and control flow is byte-identical whether recording is on or off. */
function nullSpan() {
  const h = {
    spanId: null,
    traceId: null,
    end() { return { ok: true, skipped: true }; },
    ok() { return { ok: true, skipped: true }; },
    fail() { return { ok: true, skipped: true }; },
    setAttributes() { return h; },
    child() { return nullSpan(); },
  };
  return h;
}

/** A fully disabled recorder. */
export function createNullRecorder() {
  return {
    enabled: false,
    traceId: null,
    errors: 0,
    root: null,
    startSpan() { return nullSpan(); },
    startRoot() { return nullSpan(); },
    closeRoot() { return { ok: true, skipped: true }; },
    recordMetric() { return { ok: true, skipped: true }; },
    withTrace() { return createNullRecorder(); },
  };
}

/**
 * CREATE A RECORDER bound to one trace and one dispatch kind. This is the whole caller-facing surface.
 *
 * Usage in a wrapper, which is deliberately three lines of ceremony and no error handling:
 *
 *   const tel = createTelemetryRecorder({ kind: 'build', item });
 *   const root = tel.startSpan('dispatch', { attributes: { item, lane } });
 *   const lane = root.child('lane.acquire');
 *   try { … ; lane.ok({ lane: lanePath }); } catch (e) { lane.fail(e); throw e; }
 *   …
 *   root.ok({ pr: prResult.pr, outcome: 'merged-pending' });
 *
 * A span that is never ended writes nothing (except its `span.start`, if durable) — which is the abandoned
 * signal, not a leak. There is no timer, no finalizer, and no process-exit hook: nothing to unregister and
 * nothing that can keep a process alive.
 *
 * @param {{kind?: string, item?: *, pr?: *, traceId?: string|null, attributes?: object, resource?: object,
 *          store?: object, now?: () => Date, newSpanId?: () => string, enabled?: boolean, root?: string}} [o]
 *   `root` (default {@link CHECKOUT_ROOT}) governs ONLY git-resource detection (this clone's own
 *   branch/commit) — it never affects where events are written; that is always {@link TELEMETRY_ROOT}
 *   (the shared storage root) unless `store` or `OPERATION_TELEMETRY_DIR` override it.
 */
export function createTelemetryRecorder({
  kind = 'unknown', item = null, pr = null, traceId = null, attributes = {},
  resource = null, store = null, now = () => new Date(), newSpanId = defaultSpanId,
  enabled = null, root = CHECKOUT_ROOT,
} = {}) {
  const on = enabled === null ? telemetryEnabled() : !!enabled;
  if (!on) return createNullRecorder();

  let backing;
  let res;
  let baseTrace;
  try {
    backing = store || createFileTelemetryStore();
    res = resource || resourceAttributes({ root });
    baseTrace = traceId || deriveTraceIdSafe({ item, pr }) || `r${newSpanId()}`;
  } catch {
    // A recorder that cannot even be CONSTRUCTED degrades to the null recorder rather than taking the
    // wrapper down with it — construction happens before any real work, so this is the single most
    // dangerous place a telemetry bug could live.
    return createNullRecorder();
  }

  const self = {
    enabled: true,
    traceId: baseTrace,
    errors: 0,
    kind,
    /** The root `dispatch` span, once {@link startRoot} has opened one. See its docblock. */
    root: null,

    /** Write one already-built event. Internal; never throws, counts its own failures. */
    _emit(rec) {
      try {
        const v = validateTelemetryEvent(rec);
        if (!v.ok) { self.errors += 1; return { ok: false, error: v.errors.join('; ') }; }
        const line = serializeTelemetryEvent(rec);
        if (!line) { self.errors += 1; return { ok: false, error: 'unserializable' }; }
        const stamp = rec.event === 'metric' ? rec.timestamp : (rec.endedAt || rec.startedAt);
        const r = backing.append(line, dayKey(stamp));
        if (!r.ok) self.errors += 1;
        return r;
      } catch (e) {
        self.errors += 1;
        return { ok: false, error: String((e && e.message) || e) };
      }
    },

    /**
     * OPEN a span. Returns a handle whose `end`/`ok`/`fail` write the `span.end` line. A
     * {@link DURABLE_SPAN_NAMES} span also writes its `span.start` immediately, so a process killed
     * mid-phase leaves the abandoned span visible.
     * @param {string} name one of `SPAN_NAMES`
     * @param {{parent?: string|null, attempt?: number, attributes?: object, kind?: string}} [opts]
     */
    startSpan(name, opts = {}) {
      try {
        const spanId = newSpanId();
        const startedAt = now().toISOString();
        const spanKind = opts.kind || kind;
        const attempt = Number.isInteger(opts.attempt) && opts.attempt > 0 ? opts.attempt : 1;
        let attrs = { ...attributes, ...(opts.attributes || {}) };
        // OTel'S ACTIVE-SPAN SEMANTICS, and the reason the ambient recorder is not enough on its own. A span
        // opened without an explicit parent nests under this recorder's ROOT when one is open. Without this,
        // a span emitted by a SHARED helper — `acquireLane` and `runVerifyOperation`, which are the whole
        // point of the ambient design and cannot be passed a parent — would land at the top level, and a
        // trace would read as a flat list of siblings rather than as the phase tree it actually is.
        // `opts.parent === null` is honoured as an explicit "no parent"; only `undefined` inherits.
        const parentSpanId = opts.parent === undefined
          ? (self.root && self.root.spanId ? self.root.spanId : null)
          : opts.parent;

        if (DURABLE_SPAN_NAMES.includes(name)) {
          self._emit(newSpanStart({
            traceId: baseTrace, spanId, parentSpanId, name, kind: spanKind,
            attempt, startedAt, attributes: attrs, resource: res,
          }));
        }

        let ended = false;
        const handle = {
          spanId,
          traceId: baseTrace,
          name,
          startedAt,
          /** Merge more attributes into the span before it ends. Chainable. */
          setAttributes(more) {
            try { attrs = { ...attrs, ...(more || {}) }; } catch { self.errors += 1; }
            return handle;
          },
          /** Close the span with an explicit status. Idempotent — a second `end` is a no-op, so a
           *  `finally`-based close after an explicit `fail` can never double-count. */
          end({ status = 'unset', statusMessage = null, attributes: extra = null } = {}) {
            if (ended) return { ok: true, skipped: true };
            ended = true;
            return self._emit(newSpanEnd({
              traceId: baseTrace, spanId, parentSpanId, name, kind: spanKind, attempt,
              startedAt, endedAt: now().toISOString(), status, statusMessage,
              attributes: extra ? { ...attrs, ...extra } : attrs, resource: res,
            }));
          },
          /** Close as `ok`, optionally adding attributes (the common case: `span.ok({ pr: 2131 })`). */
          ok(extra = null) {
            return handle.end({ status: 'ok', attributes: extra });
          },
          /** Close as `error`, taking an Error, a string, or `{error, ...attrs}`. The wrapper's own richer
           *  outcome word belongs in `attributes.outcome` — `goldenSignals` counts it as the classified
           *  reason, which is what turns an error COUNT into an error DIAGNOSIS. */
          fail(err, extra = null) {
            const msg = err && err.message ? err.message : String(err ?? 'error');
            return handle.end({ status: 'error', statusMessage: msg, attributes: extra });
          },
          /** Open a child span parented to this one. */
          child(childName, childOpts = {}) {
            return self.startSpan(childName, { ...childOpts, parent: spanId });
          },
        };
        return handle;
      } catch (e) {
        self.errors += 1;
        return nullSpan();
      }
    },

    /**
     * OPEN the root `dispatch` span AND remember it on the recorder, so a wrapper's existing
     * terminal-outcome chokepoint can close it without the span having to be threaded there.
     *
     * WHY THIS EXISTS RATHER THAN "just close the span at each return". Four of the six wrappers declare
     * their terminal outcome in ONE private helper — `reportDone({sessionSlug, classified})`, which shells
     * the completion CLI — and then call it from eleven or thirteen different exit branches. Hooking that one
     * helper closes the root span correctly on EVERY branch, including the ones a future edit adds, whereas
     * editing eleven `return` statements is eleven chances to miss one and leave a permanently-abandoned
     * span. Reusing the wrapper's own "this is where the outcome becomes official" seam is also what keeps
     * the span's outcome and the completion record's outcome from ever disagreeing — they are read from the
     * same object, at the same moment.
     */
    startRoot(attributes = {}) {
      const span = self.startSpan('dispatch', { attributes });
      self.root = span;
      return span;
    },

    /**
     * CLOSE the root span from a wrapper's own classified outcome, mapping its vocabulary onto an OTel status
     * via the shared {@link classifyOutcomeStatus} table. Idempotent (the span's own `end` is), so a wrapper
     * that both calls this and has a `finally` cannot double-count. A no-op when no root was opened.
     * @param {{outcome?: *, label?: *, error?: *, attributes?: object}} [o]
     */
    closeRoot({ outcome = null, label = null, error = null, attributes: extra = null } = {}) {
      try {
        if (!self.root) return { ok: true, skipped: true };
        const attrs = { outcome: outcome == null ? null : String(outcome), ...(extra || {}) };
        const status = error ? 'error' : classifyOutcomeStatus(outcome);
        if (status === 'error') {
          return self.root.end({
            status: 'error',
            statusMessage: (error && error.message) || String(error ?? label ?? outcome ?? 'error'),
            attributes: attrs,
          });
        }
        return self.root.end({ status, statusMessage: label == null ? null : String(label), attributes: attrs });
      } catch (e) {
        self.errors += 1;
        return { ok: false, error: String((e && e.message) || e) };
      } finally {
        // SELF-UNINSTALL. A wrapper that opened a root and has now closed it has no further claim on the
        // ambient slot, and in a real dispatch the process exits moments later so it would not matter. It
        // matters in TESTS, which drive several dispatches through one process: a leaked recorder would make
        // the next test's `lane.acquire` span land in the previous test's trace. Closing the root is the
        // natural moment to let go, and it means no wrapper needs its own `finally` to do it.
        if (ambientRecorder === self) ambientRecorder = null;
      }
    },

    /**
     * Record one metric sample — the saturation signal spans cannot express. `traceId` defaults to `null`
     * (a lane-pool gauge belongs to the host, not to an item); pass `{ trace: true }` to attach it to this
     * recorder's trace instead.
     * @param {string} name one of `METRIC_NAMES`
     * @param {number} value
     * @param {{unit?: string, attributes?: object, kind?: string, trace?: boolean}} [opts]
     */
    recordMetric(name, value, opts = {}) {
      try {
        return self._emit(newMetric({
          name, value,
          unit: opts.unit || 'count',
          kind: opts.kind || kind,
          timestamp: now().toISOString(),
          traceId: opts.trace ? baseTrace : null,
          attributes: opts.attributes || {},
          resource: res,
        }));
      } catch (e) {
        self.errors += 1;
        return { ok: false, error: String((e && e.message) || e) };
      }
    },

    /** A sibling recorder on a DIFFERENT trace, sharing this one's store and resource bag — used by the
     *  runner, which emits host-level metrics under its own trace but must stamp per-item spans under the
     *  item's. Avoids re-reading the git resource per dispatch. */
    withTrace({ item: i = null, pr: p = null, traceId: t = null, kind: k = kind, attributes: a = null } = {}) {
      return createTelemetryRecorder({
        // `attributes` REPLACED, not merged, when the caller supplies its own: a derived recorder describes a
        // DIFFERENT unit of work, and inheriting the parent's `item`/`sessionSlug` would stamp the wrong ones
        // onto every one of its spans.
        kind: k, item: i, pr: p, traceId: t, attributes: a === null ? attributes : a, resource: res,
        store: backing, now, newSpanId, enabled: true, root,
      });
    },
  };

  return self;
}

/** `deriveTraceId` behind a never-throw guard — it is called during recorder construction, the one place a
 *  throw would be fatal before any work has started. */
function deriveTraceIdSafe(o) {
  try {
    return deriveTraceId(o);
  } catch {
    return null;
  }
}

// ── AMBIENT CONTEXT — how a SHARED helper emits a span without every caller plumbing a recorder ───────

/**
 * THE AMBIENT ACTIVE RECORDER, and the argument for it.
 *
 * `minimal-context-provider.mjs#acquireLane` is imported by all SIX dispatch wrappers, and
 * `#runVerifyOperation` by three. Instrumenting those two functions once buys `lane.acquire` and
 * `verify.gate` spans across every dispatch kind, with no per-wrapper edit — which is exactly the "find the
 * seam, don't bolt on six parallel systems" requirement. But they take no recorder, and threading one through
 * every call site of a 6/6 shared helper (and through every existing test that calls it) is a large, risky
 * diff for a purely observational feature.
 *
 * So this module keeps ONE module-level active recorder, set by whichever wrapper is driving, exactly the way
 * OpenTelemetry's own API keeps an implicit ACTIVE CONTEXT rather than demanding a tracer parameter on every
 * function. The usual objection to ambient state — that concurrent work interleaves and one task reads
 * another's context — DOES NOT APPLY HERE, and the reason is structural rather than hopeful:
 *
 *   • ONE PROCESS PER DISPATCH. Concurrent deliveries are separate OS processes (`dispatch-lane-io.mjs`
 *     spawns each provider detached, with its own `pid:<n>` handle), not concurrent tasks in one process.
 *     Two dispatches can never share this module instance.
 *   • The wrappers are straight-line code. `deliverItem` and friends `await` exactly one thing at a time;
 *     there is no `Promise.all` over two instrumented phases anywhere in the six.
 *
 * If either of those ever stops being true, the fix is `AsyncLocalStorage` — a drop-in replacement for the
 * two accessors below and nothing else. Named here so the next reader does not have to re-derive it.
 *
 * A wrapper that forgets to set it loses nothing but the two shared spans: {@link activeRecorder} returns the
 * NULL recorder when unset, so an uninstrumented caller behaves exactly as it does today.
 */
let ambientRecorder = null;

/** The recorder shared helpers should emit into — the null recorder when nothing is active. Never throws. */
export function activeRecorder() {
  return ambientRecorder || createNullRecorder();
}

/**
 * Install `recorder` as the active one and return a `restore()` that puts back whatever was there. Callers
 * use the returned function in a `finally` so a nested dispatch (ci-heal calls into fix's helpers) cannot
 * leave a stale recorder installed.
 * @param {object|null} recorder
 * @returns {() => void}
 */
export function setActiveRecorder(recorder) {
  const prior = ambientRecorder;
  ambientRecorder = recorder || null;
  return () => { ambientRecorder = prior; };
}

/**
 * THE RECORDER FACTORY EVERY WRAPPER ACTUALLY CALLS — mint a recorder for this dispatch, but REUSE the
 * already-active one's store and resource bag when there is one.
 *
 * Two things this buys, and the second is why it exists rather than the wrappers calling
 * {@link createTelemetryRecorder} directly:
 *
 *   1. IN PRODUCTION nothing is active when a wrapper starts (it is a fresh process), so this is exactly
 *      `createTelemetryRecorder` — a file-backed recorder on a fresh trace. No behaviour change.
 *   2. IN TESTS — and in the nested case, where `ci-heal` reuses `fix`'s helpers inside one process — the
 *      caller installs a recorder over a MEMORY store first, and the wrapper's spans land there instead of on
 *      real disk. Without this the wrapper would unconditionally mint a file-backed recorder and a test could
 *      only assert on the filesystem, which is precisely the kind of untestable seam that lets wiring rot
 *      unnoticed. The alternative — a `telemetry` parameter on all six wrapper signatures — is a much larger
 *      diff through code that is not otherwise being changed, and six more things to keep in step.
 *
 * The trace is always FRESH (`withTrace` re-derives it from this dispatch's own item/PR); only the transport
 * and the resource bag are inherited.
 *
 * @param {{kind?: string, item?: *, pr?: *, traceId?: string|null, attributes?: object}} o
 */
export function recorderFor({ kind = 'unknown', item = null, pr = null, traceId = null, attributes = {} } = {}) {
  try {
    const active = ambientRecorder;
    if (active && active.enabled && typeof active.withTrace === 'function') {
      return active.withTrace({ kind, item, pr, traceId, attributes });
    }
    return createTelemetryRecorder({ kind, item, pr, traceId, attributes });
  } catch {
    return createNullRecorder();
  }
}

/**
 * Run `fn` inside a span on the ACTIVE recorder, closing it `ok` on return and `error` on throw, then
 * rethrowing. The ergonomic form for instrumenting an existing straight-line call in ONE line:
 *
 *   const lanePath = spanAround('lane.acquire', { attributes: { purpose } }, () => acquireLaneInner(...));
 *
 * NEVER changes the wrapped function's behaviour: its return value is passed through untouched, its throw is
 * rethrown unchanged, and every telemetry failure inside is swallowed. If `fn` itself is the thing that
 * throws, the span records the error AND the original error still propagates — the telemetry is a bystander,
 * never a participant.
 *
 * @template T
 * @param {string} name one of `SPAN_NAMES`
 * @param {{attributes?: object, attempt?: number, kind?: string, parent?: string|null, recorder?: object}} opts
 * @param {() => T} fn
 * @returns {T}
 */
export function spanAround(name, opts, fn) {
  const rec = (opts && opts.recorder) || activeRecorder();
  let span;
  try {
    span = rec.startSpan(name, opts || {});
  } catch {
    span = nullSpan();
  }
  let out;
  try {
    out = fn();
  } catch (e) {
    try { span.fail(e); } catch { /* a telemetry failure never masks the real one */ }
    throw e;
  }
  try { span.ok(); } catch { /* ignore */ }
  return out;
}

/** The `async` twin of {@link spanAround} — same contract, for a phase that awaits (every wrapper's
 *  `agent.turn` does). Kept separate rather than making `spanAround` polymorphic over a thenable, because
 *  auto-detecting a promise would silently mis-time a function that happens to return one. */
export async function spanAroundAsync(name, opts, fn) {
  const rec = (opts && opts.recorder) || activeRecorder();
  let span;
  try {
    span = rec.startSpan(name, opts || {});
  } catch {
    span = nullSpan();
  }
  let out;
  try {
    out = await fn();
  } catch (e) {
    try { span.fail(e); } catch { /* ignore */ }
    throw e;
  }
  try { span.ok(); } catch { /* ignore */ }
  return out;
}

// ── PER-DISPATCH CPU ATTRIBUTION (#3383 follow-on — the harder, per-agent-turn case) ────────────────────
//
// `hostMetrics`/`readHostSample` (the earlier #3383 landing) only ever answer "is the HOST loaded" — never
// "how much of THIS ONE dispatch's cost was CPU". This is the per-span half: sample `process.cpuUsage()`
// immediately before and after the wrapped call, and merge the delta into the span's own `ok`/`fail`
// attributes, so `agent.turn` (and any other span a caller wraps this way) carries a real resource-cost number
// next to its wall-clock duration, not just the duration alone.
//
// #3383 MECHANICAL-DISPATCHER FOLLOW-UP — THE SPAWN SIDE WAS FIXED; THE CPU NUMBER ITSELF WAS NOT, AND THAT IS
// AN HONEST FINDING, NOT A DEFERRAL. This section originally documented, correctly, that `process.cpuUsage()`
// measures the WRAPPER process, never the spawned agent, because every dispatch wrapper spawned its agent via
// the SYNCHRONOUS `execFileSync`/`spawnSync`. The follow-up brief assumed the fix was `ChildProcess
// #resourceUsage()` on the ASYNC `child_process.spawn()` API. THAT METHOD DOES NOT EXIST — verified against
// real Node v18.2.0 and v22.1.0 (`ChildProcess.prototype` has no such member, for a plain `spawn()` OR a
// `fork()`) and against `@types/node`'s own `child_process.d.ts` (silent on it) versus `process.d.ts` (which
// DOES declare `resourceUsage()`, but on `process` — the CURRENT process — never a child). See
// `scripts/lib/spawn-to-completion.mjs`'s own header for the full verification trail.
//
// What DID land: every wrapper's full-turn agent spawn now goes through `scripts/lib/spawn-to-completion.mjs
// #spawnToCompletion` (via `dispatch-lane-io.mjs#spawnAgentToCompletion` / `codex-delivery-provider.mjs
// #defaultSpawnCodexAgent`) — a real, tested improvement (async, streaming, non-blocking-event-loop, the exact
// `execFileSync` contract preserved) — but it does not, and cannot, supply a real per-child rusage reading on
// today's Node. `recordChildResourceUsage`/`takeChildResourceUsage` below are kept anyway, as the narrow,
// ambient side-channel (mirroring this file's own `setActiveRecorder`/`activeRecorder` pattern) a provider's
// `spawn()` would use to hand a real reading up to the `agent.turn` span IF one were ever available — a
// forward-compatible no-op today, never a fabricated number. `resolveTurnCpuAttributes` reflects this honestly:
// it prefers a real child reading when one exists (`cpuSource: 'child'`), and otherwise falls back to the
// ORIGINAL wrapper-only `process.cpuUsage()` delta (`cpuSource: 'wrapper'`) — which, in practice, is what every
// `agent.turn` span reports today. The genuinely reliable per-agent-cost signal remains what the prior #3383
// landing already built for exactly this reason: `host-process-sample.mjs`'s external, `ps`-based sampling of
// the live dispatched child from OUTSIDE the wrapper process.
/**
 * PURE-ISH (its only external effect is reading `process.cpuUsage()`, a snapshot with no side effect of its
 * own) — the millisecond delta between two `process.cpuUsage()` reads, keyed the way a span's `attributes` bag
 * expects. Microseconds → milliseconds, rounded (a span attribute is not the place for sub-millisecond noise).
 * @param {{user: number, system: number}} before - a prior `process.cpuUsage()` snapshot.
 * @returns {{cpuUserMs: number, cpuSystemMs: number, cpuTotalMs: number}}
 */
export function cpuUsageDeltaMs(before) {
  const delta = process.cpuUsage(before);
  const userMs = Math.round(delta.user / 1000);
  const systemMs = Math.round(delta.system / 1000);
  return { cpuUserMs: userMs, cpuSystemMs: systemMs, cpuTotalMs: userMs + systemMs };
}

/**
 * PURE. A child's `userCPUTime`/`systemCPUTime` (Node's `getrusage(2)`-shaped convention, both in
 * MICROSECONDS — the same unit `process.cpuUsage()` uses) → the same `cpuUserMs`/`cpuSystemMs`/`cpuTotalMs`
 * shape {@link cpuUsageDeltaMs} produces, so a span attribute reader never has to know which of the two
 * measured it. Returns `null` for a `null`/missing `resourceUsage` — which is EVERY real call today: real
 * Node's `ChildProcess` has no `resourceUsage()` method at all (see `spawn-to-completion.mjs`'s own header for
 * the verification trail), so this function exists only to stay forward-compatible with a future/injected
 * spawn primitive that does supply one, never because today's real spawns populate it.
 * @param {{userCPUTime: number, systemCPUTime: number}|null} resourceUsage
 * @returns {{cpuUserMs: number, cpuSystemMs: number, cpuTotalMs: number}|null}
 */
export function childCpuUsageMs(resourceUsage) {
  if (!resourceUsage) return null;
  const userMs = Math.round(resourceUsage.userCPUTime / 1000);
  const systemMs = Math.round(resourceUsage.systemCPUTime / 1000);
  return { cpuUserMs: userMs, cpuSystemMs: systemMs, cpuTotalMs: userMs + systemMs };
}

// The ambient side-channel a provider's `spawn()` uses to hand its just-finished child's `resourceUsage`
// (always `null` today — see above) back up to whichever `agent.turn` span wraps it — the same shape this
// file's own `setActiveRecorder`/`activeRecorder` pair already establishes for the telemetry recorder itself.
// Module-local and single-slot: every real dispatch wrapper process runs exactly ONE agent spawn (or one fresh
// spawn then one resume spawn, strictly sequential, never concurrent) per process lifetime, so there is never
// a second write to race the first read.
let lastChildResourceUsage = null;

/** Record a just-finished child's `resourceUsage()` (or `null`) for the next {@link takeChildResourceUsage}
 *  read. Called by a provider's `spawn()` right after its spawn settles — on the SUCCESS path with the
 *  resolved value's `resourceUsage`, and on the FAILURE path with the rejected error's own `.resourceUsage`
 *  (see `spawn-to-completion.mjs`'s header for why a rejection carries one too). Never throws. */
export function recordChildResourceUsage(resourceUsage) {
  lastChildResourceUsage = resourceUsage || null;
}

/** Read back and CLEAR the last {@link recordChildResourceUsage} write — clearing means a span that finds
 *  nothing recorded (no spawn happened inside it) never accidentally reads a STALE reading left over from an
 *  earlier, unrelated span. Never throws. */
export function takeChildResourceUsage() {
  const ru = lastChildResourceUsage;
  lastChildResourceUsage = null;
  return ru;
}

/**
 * THE COMBINATOR both {@link spanAroundAsyncWithCpu} and `deliver-item-wrapper.mjs`'s own manual `agent.turn`
 * span code use: prefer the REAL child `resourceUsage` a provider's `spawn()` just recorded over the
 * wrapper-process-only `cpuUsageDeltaMs` fallback, and NAME which one produced the numbers (`cpuSource`) so a
 * reader of the span never mistakes one for the other — the exact confusion the original, wrapper-only
 * measurement risked.
 * @param {{user: number, system: number}} before - a prior `process.cpuUsage()` snapshot (the fallback path).
 * @returns {{cpuUserMs: number, cpuSystemMs: number, cpuTotalMs: number, cpuSource: ('child'|'wrapper')}}
 */
export function resolveTurnCpuAttributes(before) {
  const ru = takeChildResourceUsage();
  const child = childCpuUsageMs(ru);
  if (child) return { ...child, cpuSource: 'child' };
  return { ...cpuUsageDeltaMs(before), cpuSource: 'wrapper' };
}

/**
 * THE `async` TWIN OF {@link spanAroundAsync}, WITH A CPU SAMPLE MERGED IN. Identical contract otherwise —
 * `fn`'s return value and any throw pass through completely unaltered, and every telemetry call inside is
 * never-throwing by construction. See the section header above for exactly what `cpuUserMs`/`cpuSystemMs`/
 * `cpuTotalMs`/`cpuSource` do and do not measure before reading them as "the agent's CPU cost" — `cpuSource:
 * 'child'` is the real figure; `cpuSource: 'wrapper'` is the old, honest-but-not-the-agent fallback.
 * @param {string} name one of `SPAN_NAMES` (used for `agent.turn` today)
 * @param {{attributes?: object, attempt?: number, kind?: string, parent?: string|null, recorder?: object}} opts
 * @param {() => Promise<T>} fn
 * @template T
 * @returns {Promise<T>}
 */
export async function spanAroundAsyncWithCpu(name, opts, fn) {
  const rec = (opts && opts.recorder) || activeRecorder();
  let span;
  try {
    span = rec.startSpan(name, opts || {});
  } catch {
    span = nullSpan();
  }
  const before = process.cpuUsage();
  let out;
  try {
    out = await fn();
  } catch (e) {
    let cpu = {};
    try { cpu = resolveTurnCpuAttributes(before); } catch { /* telemetry must never mask the real error */ }
    try { span.fail(e, cpu); } catch { /* ignore */ }
    throw e;
  }
  let cpu = {};
  try { cpu = resolveTurnCpuAttributes(before); } catch { /* ignore */ }
  try { span.ok(cpu); } catch { /* ignore */ }
  return out;
}

// ── SELF-TRACKED TOKEN USAGE RECORDING (epic #3383, usage-ledger follow-up) ────────────────────────────────
//
// ONE place every provider's own turn-result parser converges, so the usage-ledger aggregator
// (`scripts/usage-report/usage-report.mjs`) reads ONE consistent shape regardless of which CLI produced the
// numbers. Ambient by design — same pattern `acquireLane`/`runVerifyOperation` already use (see the header
// above): a provider's spawn function calls this directly, with no recorder threaded through its signature,
// and it degrades to the null recorder's no-op when nothing is active (a test that never installed one, or
// telemetry disabled via `WE_TELEMETRY=0`).
//
// TODAY THIS IS CODEX-ONLY. Claude's own token usage is covered by the OFFICIAL OpenTelemetry export Claude
// Code itself emits (`claude_code.token.usage`/`claude_code.cost.usage`, ingested by the sibling
// `claude-otel-collector.mjs` into its own store) — that is real, harness-reported data covering EVERY
// Claude Code process (the interactive orchestrator included), not just this repo's own dispatched agents, so
// it is strictly better than a per-dispatch estimate reconstructed from a spawn's own stdout. Codex has no
// such export, so its dispatch wrappers (`deliver-item-wrapper.mjs`'s `CODEX_PROVIDER`,
// `fix-dispatch-wrapper.mjs`'s `FIX_CODEX_PROVIDER`, `ci-heal-dispatch-wrapper.mjs`'s codex provider)
// call this directly from their own already-captured `--json` stdout.
/**
 * Record one model's token usage as four count metrics (`dispatch.tokens.*`), tagged `provider`/`model` in
 * their attributes. Never throws (`recordMetric` already isn't).
 * @param {{provider: string, model?: (string|null), tokensIn?: number, tokensOut?: number,
 *          tokensCacheRead?: number, tokensCacheWrite?: number}} usage
 * @param {{recorder?: object}} [o] - inject a specific recorder (tests); defaults to whichever is ACTIVE.
 */
export function recordTokenUsage({
  provider, model = null, tokensIn = 0, tokensOut = 0, tokensCacheRead = 0, tokensCacheWrite = 0,
} = {}, { recorder = null } = {}) {
  try {
    const rec = recorder || activeRecorder();
    const attributes = { provider: String(provider || 'unknown'), model: model == null ? null : String(model) };
    rec.recordMetric('dispatch.tokens.input', tokensIn, { unit: 'count', attributes, trace: true });
    rec.recordMetric('dispatch.tokens.output', tokensOut, { unit: 'count', attributes, trace: true });
    rec.recordMetric('dispatch.tokens.cache_read', tokensCacheRead, { unit: 'count', attributes, trace: true });
    rec.recordMetric('dispatch.tokens.cache_write', tokensCacheWrite, { unit: 'count', attributes, trace: true });
  } catch { /* telemetry must never mask a real spawn result */ }
}
