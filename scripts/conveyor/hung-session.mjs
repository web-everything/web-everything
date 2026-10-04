/**
 * hung-session.mjs — shared pure-core/IO-shell "hung session" detection (epic #3383 continuation).
 *
 * WHY THIS EXISTS (root cause, live 2026-09-24, web-everything/web-everything#2599/#2596/#2594/#2588/#2587/#2582).
 * `skills-src/review/review-agent-brief.md` tells a review agent, IN PROSE, to self-report
 * `status: done, outcome: blocked-on-infra` via `scripts/operations/completion-cli.mjs` before it exits on an
 * infra failure. Under stress (a crash, an unhandled error) an agent can exit WITHOUT ever running that
 * command, so its completion record is stuck at `status: started` forever. Two existing mechanisms depend on
 * that self-report and therefore never fire for such a session:
 *   - `we:scripts/conveyor/reconcile-core.mjs#markSelfReportedDone` (only acts once `rec.status === 'done'`).
 *   - `we:scripts/conveyor/session-reaper.mjs#classifySessionReapWithGroundTruth`'s axis 1
 *     (`completionFor(name)` → `record.done === true`).
 * The ONLY remaining path, session-reaper's axis 3 idle-timeout backstop, is a 6-HOUR last resort gated to
 * `state === 'blocked'` ONLY — it can never catch a session the listing still reports as `state: 'working'`.
 *
 * This module is a THIRD, MECHANICAL signal that never depends on the dispatched agent doing anything: the
 * session's OWN transcript file on disk simply stops growing when nothing is actually happening, self-report
 * or not. It is deliberately separate from, and does not touch, `assessLiveness`'s PR-level `transcriptMtimeMs`
 * evidence field (see that function's own pinned docblock/tests — freshness never grants liveness and
 * staleness never withdraws it, ON PURPOSE, for THAT field). This is a different fact about a different
 * object: not "how stale does the PR's transcript evidence look", but "has THIS session's own transcript file
 * been written to at all lately" — consumed as a new, separately-named `hung` flag on AGENT rows, never folded
 * into that pinned function.
 *
 * PURE CORE: {@link classifyHungSession} — given the transcript's last known real activity, now, a threshold,
 * and whether the newest transcript entry is a still-pending tool_use, decides hung/not. Every fact is a
 * parameter; no IO, no env, no clock read internally, per this codebase's pure/IO-shell law.
 *
 * IO SHELL: {@link readHungInfo} — resolves ONE session's own transcript path via
 * `we:scripts/operations/agent-usage-report.mjs#resolveSessionTranscript` (REUSED, not re-derived — it already
 * builds `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl` and falls back to a full-store scan by session
 * id), reads a BOUNDED tail (`tailLines`, never the whole file) via
 * `we:skills-src/inspect-agent-health/agent-health.mjs`, and asks that same file's `detectBlockedOnChild`
 * whether the newest tool-bearing entry has an unresolved call. WIDENS those exports rather than growing a
 * private reimplementation, matching this repo's own "WIDEN, do not grow a private copy" law
 * (`reconcile-core.mjs`'s own docblock states it verbatim).
 *
 * `lastActivityMs` PREFERS THE TRANSCRIPT'S OWN EMBEDDED ENTRY TIMESTAMPS OVER THE FILE'S mtime, and this is
 * load-bearing, not a style choice — MEASURED LIVE while building this axis (web-everything/web-everything
 * `review-2599`'s real transcript, 2026-09-24): its last real JSONL line carried `timestamp:
 * "2026-09-24T18:46:09Z"`, while `fs.statSync` on the very same file reported an `mtime` almost THREE HOURS
 * LATER. Something in this environment can bump a transcript file's mtime with no new content (a backup pass,
 * an indexing touch, a filesystem sync — the exact mechanism was not identified, only the effect). Trusting
 * mtime alone would have read that session as freshly active when its own content proves it went silent hours
 * earlier — precisely the false negative this axis exists to avoid. So `readHungInfo` takes the NEWEST
 * parseable `timestamp` field off the entries in the tail as ground truth, and consults the file's mtime only
 * as a last-resort fallback when nothing in the tail carries one at all (an all-metadata tail, or every line
 * failing to parse).
 *
 * Any read failure (missing file, unreadable store, no `cwd`/`sessionId` on the row) answers
 * `{ hung: false, reason: 'no-signal' }` — ABSENCE OF A TRANSCRIPT IS NEVER EVIDENCE OF HUNG, mirroring every
 * other resolver in this codebase (`markSelfReportedDone`'s "no record ⇒ untouched", session-reaper's
 * completion/ground-truth resolvers' "any read failure answers null, never a guess").
 *
 * {@link resolveHungThresholdMs} reads `WE_HUNG_TRANSCRIPT_MINUTES` (mirrors the `WE_BACKLOG_DIR`/
 * `OPERATION_COMPLETIONS_DIR` naming convention), default 30 minutes. The env lookup lives ONLY here, in the IO
 * shell; the pure core takes `thresholdMs` as a plain parameter.
 *
 * Imported by BOTH `we:scripts/conveyor/reconcile-core.mjs`'s `markHungSessions` pre-pass and
 * `we:scripts/conveyor/session-reaper.mjs`'s hung axis, so there is exactly ONE implementation of "is this
 * session's transcript stale", not two.
 *
 * SHARED LOW-LEVEL PRIMITIVE: {@link readTranscriptTailActivity} (#4312) is the ONE bounded-tail-read →
 * newest-parseable-entry-timestamp → mtime-fallback implementation. `readHungInfo` and `readIdleFinishedInfo`
 * below both call it (with this file's own `READ_TAIL_LINES`/`READ_MAX_BYTES`/`READ_FIELD_MAX`), and
 * `we:scripts/conveyor/session-reaper.mjs#resolveLastActivityMs` imports it too (with its own, larger,
 * constants) — so a future fix to the tail-parsing/mtime-fallback shape is applied in exactly one place, never
 * three near-identical copies. See that function's own doc for its full null-vs-timestamp contract.
 */
import { statSync } from 'node:fs';
import { tailLines, summarizeEntry, detectBlockedOnChild } from '../../skills-src/inspect-agent-health/agent-health.mjs';
import { resolveSessionTranscript } from '../operations/agent-usage-report.mjs';
import { DEFAULT_LEASE_TTL_MINUTES } from '../lib/lane-lease.mjs';

/** Default hung threshold (30 minutes) when `WE_HUNG_TRANSCRIPT_MINUTES` is unset/invalid. */
export const DEFAULT_HUNG_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * How much EXTRA grace (as a multiple of `thresholdMs`) a session gets when its newest transcript entry is a
 * still-unresolved tool_use — i.e. it may genuinely be mid a long foreground call (e.g. a `verify-lane` run)
 * rather than dead. Conservative on purpose, per this axis's own charter ("do not flag a session that's
 * genuinely still working a long foreground command"): a session with a PENDING call gets 3x the base
 * threshold before it is flagged hung too; a session with nothing pending — plain silence, no excuse — gets
 * no extra grace at all.
 */
export const PENDING_CALL_GRACE_MULTIPLIER = 3;

// Bounded read — never the whole file. This axis only needs to know whether the newest tool-bearing entry
// is still unresolved, which a short tail already answers; see `tailLines`'s own hard ceilings for why an
// unbounded read is never the right shape here regardless.
const READ_TAIL_LINES = 15;
const READ_MAX_BYTES = 400_000;
const READ_FIELD_MAX = 200;

/**
 * we:scripts/conveyor/hung-session.mjs#classifyHungSession — PURE. See file header for the full contract.
 * `lastActivityMs` is the newest known real activity — see {@link readHungInfo} for why this is the
 * transcript's OWN embedded entry timestamp, preferred over the file's mtime, not the raw mtime itself.
 * @param {{lastActivityMs:number, nowMs:number, thresholdMs:number, pendingToolUse?:boolean}} o
 * @returns {{hung:boolean, reason:string, ageMs:number|null}}
 */
export function classifyHungSession({ lastActivityMs, nowMs, thresholdMs, pendingToolUse = false } = {}) {
  if (!Number.isFinite(lastActivityMs) || !Number.isFinite(nowMs) || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return { hung: false, reason: 'no-signal', ageMs: null };
  }
  const ageMs = nowMs - lastActivityMs;
  if (ageMs < thresholdMs) return { hung: false, reason: 'fresh', ageMs };
  if (pendingToolUse && ageMs < thresholdMs * PENDING_CALL_GRACE_MULTIPLIER) {
    return { hung: false, reason: 'pending-foreground-call-within-grace', ageMs };
  }
  return { hung: true, reason: pendingToolUse ? 'stale-with-pending-call-past-grace' : 'stale-no-activity', ageMs };
}

/**
 * `WE_HUNG_TRANSCRIPT_MINUTES` → ms, floor-clamped to 1 minute so a bad env value can't silently disable this
 * axis by going zero/negative; falls back to {@link DEFAULT_HUNG_THRESHOLD_MS} on anything unset/unparsable.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveHungThresholdMs(env = process.env) {
  const raw = env?.WE_HUNG_TRANSCRIPT_MINUTES;
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n) || n <= 0) return DEFAULT_HUNG_THRESHOLD_MS;
  return Math.max(1, n) * 60 * 1000;
}

/**
 * we:scripts/conveyor/hung-session.mjs#readTranscriptTailActivity — THE SHARED LOW-LEVEL PRIMITIVE (#4312)
 * behind {@link readHungInfo}, {@link readIdleFinishedInfo} and
 * `we:scripts/conveyor/session-reaper.mjs#resolveLastActivityMs`: resolve one session's own transcript path,
 * read a BOUNDED tail, and answer the newest known real activity — the transcript's own newest PARSEABLE entry
 * `ts`, preferred over the file's `mtime` (see file header for why), falling back to `mtime` only when NOTHING
 * in the tail carries a parseable timestamp at all.
 *
 * An unparseable line is skipped, never abandons the scan — the newest parseable timestamp among the
 * remaining lines still counts, and `entries` carries only the lines that DID parse. This is the ONE piece of
 * policy this primitive owns; it is deliberately silent on whether a caller may TRUST a partial `entries` list
 * for anything beyond a timestamp (see {@link readHungInfo}/{@link readIdleFinishedInfo} for why they do not).
 * `hadUnparseableLine` reports whether any line failed, so a caller that needs to know can act on it — this
 * primitive itself never rejects a read solely because SOME line failed; only an unresolvable/unreadable
 * transcript, or a failed `mtime` fallback with nothing else to go on, answers `null`.
 *
 * Every IO function AND the tail-size/byte-cap/field-cap are caller-injected on purpose — `readHungInfo` and
 * `readIdleFinishedInfo` pass this file's `READ_TAIL_LINES`/`READ_MAX_BYTES`/`READ_FIELD_MAX`,
 * `resolveLastActivityMs` passes its own larger constants — this primitive never hardcodes either set.
 * @param {{cwd?:string, sessionId?:string}|null|undefined} session
 * @param {{tailLines:number, maxBytes:number, fieldMax:number,
 *   resolveTranscript?:Function, tailLinesFn?:Function, summarizeEntryFn?:Function, statFn?:Function}} o
 * @returns {{file:string, entries:Array<object>, lastActivityMs:number, hadUnparseableLine:boolean}|null}
 */
export function readTranscriptTailActivity(session, {
  tailLines: tailLineCount,
  maxBytes,
  fieldMax,
  resolveTranscript = resolveSessionTranscript,
  tailLinesFn = tailLines,
  summarizeEntryFn = summarizeEntry,
  statFn = statSync,
} = {}) {
  const cwd = session?.cwd, sessionId = session?.sessionId;
  if (!cwd || !sessionId) return null;

  let file;
  try {
    file = resolveTranscript({ session: String(sessionId), cwd: String(cwd) });
  } catch {
    return null; // no transcript found — never guess
  }

  let lines;
  try {
    ({ lines } = tailLinesFn(file, tailLineCount, maxBytes));
    if (!Array.isArray(lines)) throw new Error('tailLinesFn returned a non-array lines field');
  } catch {
    return null; // unreadable transcript (or a malformed tailLinesFn result) — never guess, never throw
  }

  const entries = [];
  let lastActivityMs = null;
  let hadUnparseableLine = false;
  for (const raw of lines) {
    let entry;
    try {
      entry = summarizeEntryFn(raw, fieldMax);
    } catch {
      hadUnparseableLine = true; // this line is missing from `entries` below — see doc above
      continue; // one unparseable line never aborts the scan
    }
    entries.push(entry);
    const t = Date.parse(entry?.ts ?? '');
    if (Number.isFinite(t) && (lastActivityMs === null || t > lastActivityMs)) lastActivityMs = t;
  }
  if (lastActivityMs === null) {
    try {
      lastActivityMs = statFn(file).mtimeMs;
    } catch {
      return null;
    }
  }
  return { file, entries, lastActivityMs, hadUnparseableLine };
}

/**
 * we:scripts/conveyor/hung-session.mjs#readHungInfo — THE IO SHELL for one session (a `claude agents --json`
 * row, or a session-reaper listing row — both carry `cwd`+`sessionId`). NEVER throws; any failure to locate or
 * read the transcript answers `{ hung: false, reason: 'no-signal' }` rather than guessing.
 *
 * Unlike {@link readTranscriptTailActivity}'s own tolerant scan, THIS caller refuses the whole read the moment
 * `hadUnparseableLine` is true (#4312 converge review, correctness/security lenses) — never partial. A
 * dropped line's `entries` position is gone, and this axis's `detectBlockedOnChild` pending-tool-call check
 * (right below) has no way to tell "this line never had a tool call" apart from "this line HAD one and we
 * lost it" — the second of those, acted on, can reap a session genuinely still mid a tool call. Refusing
 * outright on ANY parse failure (matching this function's shape before #4312) is the only way to guarantee
 * that never happens; `resolveLastActivityMs` (`we:scripts/conveyor/session-reaper.mjs`) does not share this
 * restriction because it never reads `entries` for anything at all.
 * @param {{cwd?:string, sessionId?:string}} agent
 * @param {number} nowMs
 * @param {number} thresholdMs
 * @returns {{hung:boolean, reason:string, ageMs:number|null, transcriptPath?:string}}
 */
export function readHungInfo(agent, nowMs, thresholdMs) {
  const tail = readTranscriptTailActivity(agent, { tailLines: READ_TAIL_LINES, maxBytes: READ_MAX_BYTES, fieldMax: READ_FIELD_MAX });
  if (!tail || tail.hadUnparseableLine) return { hung: false, reason: 'no-signal', ageMs: null };

  const pendingToolUse = detectBlockedOnChild(tail.entries).pending === true;
  const verdict = classifyHungSession({ lastActivityMs: tail.lastActivityMs, nowMs, thresholdMs, pendingToolUse });
  return { ...verdict, transcriptPath: tail.file };
}

// ── NO-NET-OUTCOME STALL (#4090, epic #3383/#4075, statute `#conveyor-session-lifecycle-policy` clause 2) ─────
// A DIFFERENT axis from hung-transcript detection above: hung-transcript asks "did this session stop WRITING
// anything" (a crash/deadlock signal); this asks "is this session writing PLENTY, but producing no real
// outcome" — a looping bot that churns transcript activity forever without ever advancing its own work.
// Modeled on Temporal's own heartbeat (WINDOW, reset by an outcome) vs start-to-close (CEILING, absolute) pair,
// named explicitly in the ratified statute. Per-kind, because "an outcome" means something different per kind:
//
//   | kind (this repo's session-slug grammar) | statute's name | outcome signal                              |
//   | ---------------------------------------- | -------------- | -------------------------------------------- |
//   | `conveyor`                                | build           | a new commit ahead of the lane's base (a real diff change) |
//   | `fix`                                     | fix             | a new commit ahead of the lane's base (same signal — a fix IS a commit) |
//   | `review`                                  | review          | a new comment posted on the target PR         |
//   | `prepare` / `prepare-decision`            | prepare         | the target item's own backlog file changing   |
//
// `ci-heal`/`inspect` are NOT covered — the statute names exactly four kinds, and this axis follows it exactly
// rather than guessing an outcome shape for a kind it never named.

/** The kinds this axis covers — see the table above. Never `ci-heal`/`inspect`: the statute names exactly
 *  these four (with `prepare-decision` folded into `prepare`'s own outcome shape — the same "item file change"
 *  test applies to a decision-prep item exactly as it does to an ordinary one). */
export const NO_OUTCOME_KINDS = Object.freeze(['conveyor', 'fix', 'review', 'prepare', 'prepare-decision']);

/** Fallback defaults (minutes) when #3368's own step-timing data has not yet been read back into real
 *  per-kind numbers — the ratified statute's own stated fallback ("about 2x p95… until that data is read, the
 *  values are: build 45/240, fix 30/120, review 30/60, prepare 45/180"). `prepare-decision` mirrors `prepare`. */
const NO_OUTCOME_DEFAULT_MINUTES = Object.freeze({
  conveyor: Object.freeze({ window: 45, ceiling: 240 }),
  fix: Object.freeze({ window: 30, ceiling: 120 }),
  review: Object.freeze({ window: 30, ceiling: 60 }),
  prepare: Object.freeze({ window: 45, ceiling: 180 }),
  'prepare-decision': Object.freeze({ window: 45, ceiling: 180 }),
});

function noOutcomeEnvKey(kind, field) {
  return `WE_NO_OUTCOME_${kind.toUpperCase().replace(/-/g, '_')}_${field.toUpperCase()}_MIN`;
}

/** `WE_NO_OUTCOME_<KIND>_WINDOW_MIN` → ms for `kind`, or `null` for a kind this axis does not cover (never a
 *  guessed window — see {@link NO_OUTCOME_KINDS}). An unparsable/non-positive override falls back to the
 *  named default rather than silently disabling the axis. */
export function resolveNoOutcomeWindowMs(kind, env = process.env) {
  const defaults = NO_OUTCOME_DEFAULT_MINUTES[kind];
  if (!defaults) return null;
  const raw = env?.[noOutcomeEnvKey(kind, 'window')];
  const n = raw !== undefined ? Number(raw) : defaults.window;
  return (Number.isFinite(n) && n > 0 ? n : defaults.window) * 60_000;
}

/** `WE_NO_OUTCOME_<KIND>_CEILING_MIN` → ms for `kind`, or `null` for an uncovered kind. Statute: "the ceiling
 *  never exceeds the lane lease TTL" — CLAMPED to {@link DEFAULT_LEASE_TTL_MINUTES} (240, `lane-lease.mjs`'s
 *  own default) regardless of what an operator configures, so a stuck bot can never legitimately outlive the
 *  very lane lease that would otherwise reclaim its lane out from under it. */
export function resolveNoOutcomeCeilingMs(kind, env = process.env) {
  const defaults = NO_OUTCOME_DEFAULT_MINUTES[kind];
  if (!defaults) return null;
  const raw = env?.[noOutcomeEnvKey(kind, 'ceiling')];
  const n = raw !== undefined ? Number(raw) : defaults.ceiling;
  const minutes = Number.isFinite(n) && n > 0 ? n : defaults.ceiling;
  return Math.min(minutes, DEFAULT_LEASE_TTL_MINUTES) * 60_000;
}

/** An outcome resolver's answer when the READ ITSELF failed (git/gh error, timeout, unreadable file) — distinct
 *  from `null`, which means "read fine, no outcome yet". See {@link classifyNoOutcomeStall} for why the two must
 *  never collapse (PR #2676 review). */
export const OUTCOME_UNREADABLE = 'unreadable';

/**
 * we:scripts/conveyor/hung-session.mjs#classifyNoOutcomeStall — PURE. Two independent triggers, checked in
 * this order (mirrors {@link classifyHungSession}'s own "ceiling wins" precedent, and `session-reaper.mjs
 * #classifyRetention`'s path-B-first ordering for the identical reason — an absolute cap must never be masked
 * by a still-ticking window):
 *   1. CEILING — `nowMs - startedAtMs >= ceilingMs`, regardless of how recently an outcome landed. A bot that
 *      DOES occasionally produce outcomes but never actually finishes still gets cut off eventually.
 *   2. WINDOW — `nowMs - baseline >= windowMs`, where `baseline` is the LAST outcome's own timestamp, or
 *      `startedAtMs` when there has been no outcome yet at all (never treats "no outcome ever" as automatically
 *      fresh — the window still counts from the bot's own start in that case). The baseline is CLAMPED to
 *      `startedAtMs`: an outcome older than the session (a fix session's lane already carrying the original
 *      build commit, a PR's pre-dispatch comments) is someone else's work, never this bot's, so it can never
 *      shorten a fresh session's own window (PR #2676 review).
 * `lastOutcomeAtMs === OUTCOME_UNREADABLE` (the outcome read FAILED — git/gh error, timeout, unreadable file)
 * disables the WINDOW only: "we could not look" is not "nothing happened", so it may never authorize a stop by
 * itself. The CEILING still applies, since it never depended on the outcome read at all.
 * `windowMs`/`ceilingMs` of `null` (an uncovered kind, see {@link resolveNoOutcomeWindowMs}) disables that
 * trigger — never a guessed value standing in for "this kind was never named".
 * @param {{startedAtMs:number, lastOutcomeAtMs?:number|null|typeof OUTCOME_UNREADABLE, nowMs:number, windowMs:number|null, ceilingMs:number|null}} o
 * @returns {{stall:boolean, reason:('ceiling'|'no-outcome-window'|'active'|'no-signal')}}
 */
export function classifyNoOutcomeStall({ startedAtMs, lastOutcomeAtMs = null, nowMs, windowMs, ceilingMs }) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return { stall: false, reason: 'no-signal' };
  if (typeof ceilingMs === 'number' && ceilingMs > 0 && (nowMs - startedAtMs) >= ceilingMs) {
    return { stall: true, reason: 'ceiling' };
  }
  if (lastOutcomeAtMs === OUTCOME_UNREADABLE) return { stall: false, reason: 'no-signal' };
  if (typeof windowMs !== 'number' || windowMs <= 0) return { stall: false, reason: 'active' };
  const baseline = Number.isFinite(lastOutcomeAtMs) ? Math.max(startedAtMs, lastOutcomeAtMs) : startedAtMs;
  if ((nowMs - baseline) >= windowMs) return { stall: true, reason: 'no-outcome-window' };
  return { stall: false, reason: 'active' };
}

// ── CLAUDE AUTH-EXPIRED DETECTION (epic #3383/#4075 continuation) ──────────────────────────────────────────────
// LIVE INCIDENT, night of 2026-09-25/26 ET: the operator's own Claude login expired. Every daemon-dispatched
// session (`ci-heal-2711`/`ci-heal-2712`, re-dispatched repeatedly until 06:53) ended IMMEDIATELY — its entire
// transcript is one synthetic assistant turn:
//   {"type":"assistant","error":"authentication_failed","isApiErrorMessage":true,
//    "message":{...,"content":[{"type":"text","text":"Login expired · Please run /login"}]}}
// (measured live off the real sessions, `~/.claude/projects/*/f61f0de3-*.jsonl` / `751f205c-*.jsonl`). Neither
// existing axis in this file catches it promptly: `classifyHungSession` only fires after `thresholdMs` (default
// 30 min) of silence, and this failure IS the session's only content — nothing subsequent ever appends, so the
// session is genuinely done the instant that one turn lands, not merely quiet. Reaping it on the generic hung
// timer alone would have left it sitting `blocked`/`idle` (a live pid, nothing working it) for up to 30+ minutes
// per session, all night, exactly what happened before this axis existed.
//
// PROVENANCE, NOT PROSE (PR #2717 review). This axis reaps instantly, with no staleness window, so free text
// alone is far too weak a signal: a healthy agent working this repo's own GitHub-auth code routinely writes
// "got a 401 Unauthorized", "authentication_failed", or quotes this very incident's phrase. The only turn that
// may fire is the CLI's OWN synthetic API-error turn — `isApiErrorMessage: true` — which a model can never
// author. `summarizeEntry` (the shared reader) drops those top-level fields, so the IO shell below carries
// them through alongside its summary (see `summarizeWithApiError`).

/** The Claude CLI's own login-failure phrasing — case-insensitive, tolerant of the `/login` spelling. Consulted
 *  ONLY on an `isApiErrorMessage` turn; the generic 401/"Unauthorized" fallback was dropped as too broad. */
export const CLAUDE_AUTH_EXPIRED_TEXT_RE = /login expired|please run\s*\/login|authentication_error/i;
/** The structured `error` code the CLI stamps on that synthetic turn. */
export const CLAUDE_AUTH_EXPIRED_ERROR = 'authentication_failed';

// Bounded read — mirrors this file's own `READ_TAIL_LINES`/`READ_MAX_BYTES`/`READ_FIELD_MAX` above. The window
// counts RAW lines, and the CLI appends metadata lines (system, custom-title, mode, cost-state, …) after the
// failure — 9 in the live incident, ~7 more per re-attach — so it is sized well past that, never "a short tail".
const AUTH_EXPIRED_TAIL_LINES = 200;
const AUTH_EXPIRED_MAX_BYTES = 400_000;
const AUTH_EXPIRED_FIELD_MAX = 500;

/**
 * we:scripts/conveyor/hung-session.mjs#classifyClaudeAuthExpired — PURE. Decides off the NEWEST assistant
 * entry ALONE (see {@link readClaudeAuthExpiredInfo} for the IO shell that builds the entries). It fires only
 * when that turn is the CLI's own synthetic API-error turn (`isApiErrorMessage: true`) AND carries either the
 * structured `authentication_failed` code or the CLI's login phrasing ({@link CLAUDE_AUTH_EXPIRED_TEXT_RE}).
 * Ordinary assistant text/thinking never fires, whatever it says. Any newer assistant turn — including a bare
 * `tool_use` one — means the session moved on, so an older failure is never flagged. A newer `user` TEXT entry
 * (the operator re-driving the session after `/login`) clears it too: the model may think for a while before
 * its first assistant line lands. A `user` entry never signals, and a tool_result-only one neither signals nor
 * clears.
 * @param {Array<{kind?:string, isApiErrorMessage?:boolean, apiError?:string,
 *   blocks?:Array<{kind?:string, text?:string}>}>} entries
 * @returns {{authExpired:boolean, reason:string}}
 */
export function classifyClaudeAuthExpired(entries) {
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind === 'user' && (entry.blocks ?? []).some((b) => b.kind === 'text')) break; // re-driven
    if (entry?.kind !== 'assistant') continue; // never signals — see doc above
    const matched = entry.isApiErrorMessage === true && (
      entry.apiError === CLAUDE_AUTH_EXPIRED_ERROR
      || (entry.blocks ?? []).some((b) => b.kind === 'text' && CLAUDE_AUTH_EXPIRED_TEXT_RE.test(b.text ?? '')));
    return { authExpired: matched, reason: matched ? 'claude-auth' : 'no-signal' };
  }
  return { authExpired: false, reason: 'no-signal' };
}

/** `summarizeEntry` plus the two top-level fields it drops — the provenance {@link classifyClaudeAuthExpired}
 *  requires. Never throws: an unparseable line keeps `summarizeEntry`'s own answer. */
function summarizeWithApiError(summarize, line, fieldMax) {
  const summary = summarize(line, fieldMax);
  try {
    const o = JSON.parse(line);
    if (o?.isApiErrorMessage === true) return { ...summary, isApiErrorMessage: true, apiError: o.error ?? null };
  } catch { /* summarize already reported it unparseable */ }
  return summary;
}

// ── IDLE-TURN-ENDED BACKSTOP (#4075/xg7m2wq, live incident PR #2724, 2026-09-26) ───────────────────────────────
// LIVE INCIDENT. `ci-heal-2724` finished its work at ~13:50 ET ("rebased PR #2724 onto main and pushed; no code
// change was needed") but `fix-agent-ci-brief.md` never told it to report completion — no kind in
// `COMPLETION_KINDS` existed for `ci-heal` at all, until this same card added one (see `completion-record.mjs`).
// That is the ROOT-CAUSE fix; THIS axis is the requested BACKSTOP for the case a brief forgets to report again,
// for ANY kind, not only the ones `markSelfReportedDone`/`markAuthExpiredSessions` already understand.
//
// Different question from `classifyHungSession` above. That axis asks "has this session's transcript gone
// stale" and grants extra grace (`PENDING_CALL_GRACE_MULTIPLIER`) when the newest entry is a still-unresolved
// tool call, because a long foreground command (a gate run) can legitimately keep a session quiet for a while.
// This axis asks a narrower, safer question: has the session's last assistant TURN fully ENDED — no pending
// tool call at all — and then sat idle past a much shorter threshold. A session mid a real tool call is never
// flagged here, at any age; only a session that has nothing left in flight and has simply gone quiet counts as
// finished. That narrower gate is what makes a much shorter default threshold (10 minutes, a fifth of the
// 30-minute hung default) safe to use for every kind, including ones (`conveyor`/`prepare`/`investigate`) this
// file's other axes never cover at all.

/** Default idle-finished threshold (10 minutes) when `WE_IDLE_FINISHED_MINUTES` is unset/invalid — short on
 *  purpose: this axis only ever fires once the session's last turn has fully ended, so there is no foreground
 *  work it could be mistaking for idleness. */
export const DEFAULT_IDLE_FINISHED_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * we:scripts/conveyor/hung-session.mjs#classifyIdleFinished — PURE. See file header for the full contract.
 * Unlike {@link classifyHungSession}, a pending tool call is an ABSOLUTE gate here, never merely a grace
 * period: this axis exists specifically for "the turn ended and nothing followed", so a session still mid a
 * tool call never counts as finished by this axis, at any age (the hung axis, with its own longer threshold and
 * grace multiplier, is still what eventually catches a session genuinely stuck mid a long call).
 * @param {{lastActivityMs:number, nowMs:number, thresholdMs:number, pendingToolUse?:boolean}} o
 * @returns {{finished:boolean, reason:string, ageMs:number|null}}
 */
export function classifyIdleFinished({ lastActivityMs, nowMs, thresholdMs, pendingToolUse = false } = {}) {
  if (!Number.isFinite(lastActivityMs) || !Number.isFinite(nowMs) || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return { finished: false, reason: 'no-signal', ageMs: null };
  }
  const ageMs = nowMs - lastActivityMs;
  if (pendingToolUse) return { finished: false, reason: 'pending-tool-call', ageMs };
  if (ageMs < thresholdMs) return { finished: false, reason: 'fresh', ageMs };
  return { finished: true, reason: 'turn-ended-idle', ageMs };
}

/** `WE_IDLE_FINISHED_MINUTES` → ms, floor-clamped to 1 minute so a bad env value can't silently disable this
 *  axis by going zero/negative; falls back to {@link DEFAULT_IDLE_FINISHED_THRESHOLD_MS} on anything
 *  unset/unparsable. Mirrors {@link resolveHungThresholdMs}'s own env-lookup shape. */
export function resolveIdleFinishedThresholdMs(env = process.env) {
  const raw = env?.WE_IDLE_FINISHED_MINUTES;
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n) || n <= 0) return DEFAULT_IDLE_FINISHED_THRESHOLD_MS;
  return Math.max(1, n) * 60 * 1000;
}

/**
 * we:scripts/conveyor/hung-session.mjs#readIdleFinishedInfo — THE IO SHELL for one session (same row shape
 * {@link readHungInfo} takes: a `claude agents --json` row or a session-reaper listing row, both carrying
 * `cwd`+`sessionId`). Reuses the SAME bounded transcript read and `detectBlockedOnChild` pending-call check
 * `readHungInfo` already does — ONE implementation of "read this session's own tail and find its last real
 * activity + whether a tool call is still pending", never a second copy. NEVER throws; any failure to locate or
 * read the transcript answers `{ finished: false, reason: 'no-signal' }` rather than guessing. Same
 * ANY-unparseable-line-refuses-the-whole-read rule as {@link readHungInfo} (#4312 converge review) — see that
 * function's own doc for why a partial `entries` list is never safe for this axis's pending-call check.
 * @param {{cwd?:string, sessionId?:string}} agent
 * @param {number} nowMs
 * @param {number} thresholdMs
 * @returns {{finished:boolean, reason:string, ageMs:number|null, transcriptPath?:string}}
 */
export function readIdleFinishedInfo(agent, nowMs, thresholdMs) {
  const tail = readTranscriptTailActivity(agent, { tailLines: READ_TAIL_LINES, maxBytes: READ_MAX_BYTES, fieldMax: READ_FIELD_MAX });
  if (!tail || tail.hadUnparseableLine) return { finished: false, reason: 'no-signal', ageMs: null };

  const pendingToolUse = detectBlockedOnChild(tail.entries).pending === true;
  const verdict = classifyIdleFinished({ lastActivityMs: tail.lastActivityMs, nowMs, thresholdMs, pendingToolUse });
  return { ...verdict, transcriptPath: tail.file };
}

/**
 * we:scripts/conveyor/hung-session.mjs#readClaudeAuthExpiredInfo — THE IO SHELL for one session (same row
 * shape `readHungInfo` takes: a `claude agents --json` row or a session-reaper listing row, both carrying
 * `cwd`+`sessionId`). NEVER throws; any failure to locate or read the transcript answers
 * `{ authExpired: false, reason: 'no-signal' }` rather than guessing — mirrors every other resolver in this
 * file's own try/catch-to-null discipline.
 * @param {{cwd?:string, sessionId?:string}} agent
 * @param {{resolveTranscript?:Function, tailLinesFn?:Function, summarizeEntryFn?:Function}} [io]
 * @returns {{authExpired:boolean, reason:string, transcriptPath?:string}}
 */
export function readClaudeAuthExpiredInfo(agent, {
  resolveTranscript = resolveSessionTranscript,
  tailLinesFn = tailLines,
  summarizeEntryFn = summarizeEntry,
} = {}) {
  const cwd = agent?.cwd, sessionId = agent?.sessionId;
  if (!cwd || !sessionId) return { authExpired: false, reason: 'no-signal' };
  let file;
  try {
    file = resolveTranscript({ session: String(sessionId), cwd: String(cwd) });
  } catch {
    return { authExpired: false, reason: 'no-signal' }; // no transcript found — never guess
  }
  let entries;
  try {
    const { lines } = tailLinesFn(file, AUTH_EXPIRED_TAIL_LINES, AUTH_EXPIRED_MAX_BYTES);
    entries = lines.map((l) => summarizeWithApiError(summarizeEntryFn, l, AUTH_EXPIRED_FIELD_MAX));
  } catch {
    return { authExpired: false, reason: 'no-signal' }; // unreadable transcript — never guess
  }
  return { ...classifyClaudeAuthExpired(entries), transcriptPath: file };
}
