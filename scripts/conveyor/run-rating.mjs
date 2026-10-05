#!/usr/bin/env node
/**
 * @file scripts/conveyor/run-rating.mjs
 * @description RUN RATING & EFFICIENCY, slice 1 (parent #4075) — (a) an automatic per-run MECHANICAL grade and
 *   (d) token efficiency per demand. MECHANICAL ONLY: no LLM judge reads the diff or the reasoning quality here
 *   — that is slice (b), cross-model judge rating, filed as a follow-up. Everything in this file is a
 *   deterministic function of a session transcript / review-job log plus its completion record; the same input
 *   always produces the same grade.
 *
 * WHY MECHANICAL FIRST: a judge call costs real tokens and real judgment; a mechanical pass costs neither and
 * already answers "was this run clean or wasteful" for the bulk of cases (guard blocks, repeated calls, blown
 * wall-clock budgets, an outcome that never needed the work at all). Slice (b) later adds the harder question
 * ("was the CODE actually good") on top of this — never instead of it.
 *
 * INPUTS THIS MODULE READS (never writes, except the scorecard store below):
 *   • a dispatched daemon session's OWN transcript — under a `~/.claude/projects/` directory whose name contains
 *     `operations-dispatch`, one `<sessionId>.jsonl` file per dispatched agent
 *     (`fix-<pr>` / `ci-heal-<pr>` / `review-<pr>` [session mode] / `conveyor-<item>` sessions). Every line is one
 *     JSON object; `type:'assistant'` lines carry `message.usage` (`input_tokens`, `output_tokens`,
 *     `cache_read_input_tokens`, `cache_creation` split `ephemeral_5m_input_tokens`/`ephemeral_1h_input_tokens`)
 *     and `message.model`; `type:'custom-title'`'s `customTitle` is the session's own dispatcher-minted slug;
 *     `tool_use` blocks live on assistant lines, their `tool_result` counterpart on a later `user` line, joined
 *     by `tool_use_id`.
 *   • a review-job's plain-text log (`.operations/review-jobs/review-<pr>.log`, `we:scripts/operations/
 *     review-job.mjs`) for the default job-mode review dispatch, which has NO transcript of its own (no
 *     `sessionId` — see that file's header). Its final line is a structured JSON summary (`timings`, `outcome`,
 *     `verdict`). KNOWN GAP (documented, not silently papered over): a job-mode review's OWN token/cost is not
 *     observable from this log — the jurors it spawns (`we:scripts/lib/judge-spawn.mjs`) are separate `claude -p`
 *     processes with their own session ids this slice does not chase down. `rateReviewJobLog` reports
 *     `tokens: null, costUsd: null, dataQuality: 'job-log-only'` for these rows rather than guessing — a reader
 *     must check `dataQuality` before summing tokens across rows.
 *   • the session's completion record (`we:scripts/operations/completion-store.mjs#tryReadCompletion`) for the
 *     final `outcome` — this file never re-derives an outcome by scraping the transcript's text.
 *   • `we:scripts/backlog/cost-rates.mjs` — THE canonical Claude per-token USD table (reused verbatim, never
 *     duplicated — see that file's own header on why a duplicate table is exactly the bug this whole area
 *     already had once).
 *
 * PURE CORE / IO SHELL split, same discipline as `run-scorecard-store.mjs` / `lease-reaper.mjs`:
 *   • PURE (no fs, no clock, no process): every `extract*`/`compute*`/`count*`/`classify*`/`grade*` function
 *     below, plus {@link rateTranscript} and {@link rateReviewJobTimings} which only combine them. Unit-tested
 *     directly against fixture transcript arrays — no tmpdir, no real jsonl file needed.
 *   • IO SHELL: {@link findTranscriptPath}, {@link readTranscriptLines}, {@link rateSession},
 *     {@link rateReviewJobLog} (reads a real log file), {@link appendRunRating}, {@link rateAndRecordSession} (the
 *     function hooked into `session-reaper.mjs` / `review-job.mjs`), and the `report` CLI.
 *
 * WHERE A RATING LANDS: appended to the ALREADY-CANONICAL scorecard store (`run-scorecard-store.mjs`) — never a
 * second store. `validateScorecard`'s required fields are satisfied with a mechanical proxy (`score` = a fixed
 * per-grade number, `deductions[]` = one entry per mechanical criterion that cost points); every other field this
 * module cares about (`grade`, `wallMs`, `shares`, `tokens`, `costUsd`, `cacheHitRatio`, `outcome`) rides through
 * as an EXTRA field, which that store's own docs say pass through unvalidated.
 *
 * NEVER PRINTS raw tool content, transcript text, or secrets — only counts, ms, USD, and grades. A guard-block /
 * error match only ever contributes to a COUNT; the matched text itself is never retained past the check.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { rateFor, usdFromTokens } from '../backlog/cost-rates.mjs';
import { appendScorecard, readStore } from './run-scorecard-store.mjs';
import { tryReadCompletion } from '../operations/completion-store.mjs';
import { readField } from '../backlog/frontmatter.mjs';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';

/** A row with no `repo` is a WE row (pre-multi-repo records) — resolved from the registry, never a literal. */
const DEFAULT_REPO_SLUG = CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ── DECLARED CONSTANTS ──────────────────────────────────────────────────────────────────────────────────────────

/** Stamped on every row this module writes — bump when the rubric's weights below change (Fork 3 discipline,
 *  same as `run-scorecard-store.mjs`: a rubric change never re-scores old history). `.3`/`.4` are same-day
 *  correctness bumps, not rubric-philosophy changes — all found and fixed before `.2`'s numbers were ever
 *  reported anywhere: `.3` fixed `computeTimeShares` losing the leading/trailing gap and the per-demand rollup
 *  printing an unmeasured total as a bare `$0.00`/`0 tok`; `.4` fixed the backfill script's own review-juror
 *  join resolving `.operations/runs/` relative to ITS OWN checkout (this lane clone) instead of the daemon
 *  clone that actually ran the review — silently failing nearly every join in `.3`'s own backfill. Each bump
 *  exists so corrected numbers are never silently mixed with a prior version's rows in the same store. */
// `.5`: per-model turn pricing (a mixed-model run is no longer priced wholesale at its dominant model), explicit
// unpriced usage, and refused / no-loop review jobs no longer graded — same-day correctness, same discipline.
export const RUBRIC_VERSION = 'run-rating-mechanical.5';

/** The four mechanical criteria {@link toScorecardRow} always evaluates (guard blocks, non-guard tool errors,
 *  repeated identical calls, test/gate reruns) — `criteriaEvaluated` on every row this module appends. */
export const MECHANICAL_CRITERIA_COUNT = 4;

export const GRADES = Object.freeze(['A', 'B', 'C', 'D']);

/** The conceptual outcome buckets the operator asked for. `unclassified` is not a failure of this module — it
 *  is the honest answer for a raw outcome word this file's {@link OUTCOME_MAP} has never seen (never guessed
 *  into a bucket it might not belong in). */
export const OUTCOME_BUCKETS = Object.freeze(['accepted', 'bounced', 'escalated', 'nothing-to-fix', 'pushed', 'unclassified']);

/**
 * Raw completion-record `outcome` strings (fix/ci-heal brief vocabulary — `we:skills-src/conveyor/
 * fix-agent-brief.md` / `ci-heal-*` — and review-job vocabulary — `we:scripts/operations/review-job.mjs`) →
 * one of {@link OUTCOME_BUCKETS}. Anything starting with `escalated` but not listed here still resolves to
 * `escalated` (a closed prefix rule, not a guess); anything else unseen resolves to `unclassified`.
 */
export const OUTCOME_MAP = Object.freeze({
  're-armed': 'pushed',
  healed: 'pushed',
  done: 'pushed',
  'gate-red': 'escalated',
  diagnosed: 'escalated',
  'no-change': 'nothing-to-fix',
  'not-applicable': 'nothing-to-fix',
  blocked: 'escalated',
  'blocked-on-infra': 'escalated',
  'blocked-on-permission': 'escalated',
  'escalated-needs-human': 'escalated',
  'escalated-needs-judgment': 'escalated',
  'escalated-conflict': 'escalated',
  'escalated-rearm-refused': 'escalated',
  'needs-human': 'escalated',
  'needs-human-judgment': 'escalated',
  'waiting-on-system-fix': 'escalated',
  'auto-cleared': 'accepted',
  parked: 'escalated',
  bounced: 'bounced',
  'deferred-no-lane': 'unclassified',
});

/**
 * Median wall time baselines by dispatch kind, from the delivery-time report
 * (https://claude.ai/artifact/UhgARA3ySm91z9aC3tgngd): a daemon FIX session runs ~10 min median; a WORKER
 * (item-kind build/conveyor session) runs ~40 min median. `review`/`ci-heal` share the fix-session daemon
 * family; `conveyor`/`prepare`/`prepare-decision` share the worker family. An unrecognised kind falls back to
 * the fix baseline (the more common, shorter case — a false "this ran long" is cheaper to mis-flag than a false
 * "this was fine").
 */
export const BASELINE_WALL_MS_BY_KIND = Object.freeze({
  fix: 10 * 60 * 1000,
  'ci-heal': 10 * 60 * 1000,
  review: 10 * 60 * 1000,
  inspect: 10 * 60 * 1000,
  conveyor: 40 * 60 * 1000,
  prepare: 40 * 60 * 1000,
  'prepare-decision': 40 * 60 * 1000,
});
export const DEFAULT_BASELINE_WALL_MS = BASELINE_WALL_MS_BY_KIND.fix;

/** Same report: "~4 guard blocks/session is bad; target <1." */
export const GUARD_BLOCKS_BAD = 4;
export const GUARD_BLOCKS_TARGET = 1;

/** The report's other baseline: a fix session's median tests/gates time SHARE is ~65%. Recorded for the CLI
 *  report to compare against, not currently used as a per-run grading deduction (a below-baseline tests share
 *  is not necessarily bad — it can mean a genuinely small diff). */
export const BASELINE_TESTS_SHARE_FIX = 0.65;

export const TOOL_CATEGORIES = Object.freeze(['tests-gates', 'gh', 'git', 'edits', 'platform-ops', 'other']);

/**
 * RECALIBRATION (rubric v2, #4075, operator-directed 2026-09-27): the v1 rubric graded 182/204 backfilled
 * rows A while independently measured delivery efficiency runs ~35%, review-verdict bounce runs ~47%, and
 * worker sessions average ~4 guard blocks + ~6 repeated calls — a grade that agrees with almost nothing is not
 * a signal anyone can act on. v2's fix is two-fold: (1) an A is now a HARD CONJUNCTION, not a soft point total
 * — within-baseline time AND near-zero waste AND a good outcome, all three, or it is not an A; (2) OUTCOME now
 * CAPS the grade before mechanical hygiene is even considered — a mechanically spotless run that found nothing
 * to fix, or whose PR later bounced, or that escalated with nothing resolving it, was never a clean success.
 *
 * BASELINE SOURCE for every wall-time number below: the same delivery-time report {@link BASELINE_WALL_MS_BY_KIND}
 * already cites (https://claude.ai/artifact/UhgARA3ySm91z9aC3tgngd) — fix-session median ~10 min, worker median
 * ~40 min. The waste-allowance numbers (`aGuardBlocksMax`/`aRepeatedCallsMax`/`aTestRerunsMax`) have no baseline
 * report to cite — they are first-pass declared constants chosen so "~zero waste" means what it says relative
 * to the coordinator's own observed fleet averages (~4 guard blocks, ~6 repeated calls per worker session):
 * anything within noise of zero qualifies, not anything close to the observed average. Revisit once slice (b)'s
 * judge scores give an independent quality signal to calibrate against.
 */
export const GRADE_THRESHOLDS = Object.freeze({
  // An A requires wallMs <= baseline(kind, size) * aTimeMultiplier — "within-baseline", not "not egregiously over".
  aTimeMultiplier: 1.0,
  bTimeMultiplier: 1.5,
  cTimeMultiplier: 2.5,
  // "≤1 guard block" (the coordinator's own words) / "0 repeated identical calls beyond N" (N=1: one incidental
  // repeat — e.g. checking `git status` twice — is noise, not waste) / "no test rerun loops" (exactly zero).
  aGuardBlocksMax: 1,
  aRepeatedCallsMax: 1,
  aTestRerunsMax: 0,
  // Sub-A point-deduction bands (a run that fails the hard A-gate, but isn't outcome-capped, still lands
  // somewhere on B/C/D by degree) — unchanged in spirit from rubric v1.
  bScoreMin: 65,
  cScoreMin: 40,
});

/** First-pass declared constant (no baseline report covers size-stratified worker timing): the story size a
 *  BUILD kind's baseline is defined AT — `we:scripts/backlog/frontmatter.mjs`-tagged `size` fields in this
 *  backlog skew toward small/medium stories, and 3 is a common one absent a stated median. Revisit once real
 *  size-stratified timing data exists (this is exactly the kind of thing slice (b)'s judge data will surface). */
export const REFERENCE_STORY_SIZE = 3;

/** Item-kind (`we:scripts/conveyor/session-slug.mjs#ITEM_KINDS`) dispatches whose baseline scales with the
 *  backlog item's own `size` — a size-8 build legitimately runs longer than a size-1 one; a size-scaled baseline
 *  is closer to "true" than one flat median for every size. PR-kind kinds (fix/ci-heal/review/inspect) are NOT
 *  size-scaled — they are keyed to a PR, not a sized backlog item, and #4075's operator ruling above only asked
 *  for "kind/size" scaling on the worker family. */
export const SIZE_SCALED_KINDS = Object.freeze(new Set(['conveyor', 'prepare', 'prepare-decision']));

/** The two dispatch-kind families {@link gradeRun}'s outcome caps apply to. */
export const BUILD_KINDS = Object.freeze(new Set(['conveyor', 'prepare', 'prepare-decision']));
export const REWORK_KINDS = Object.freeze(new Set(['fix', 'ci-heal']));

/**
 * `kind`'s baseline wall time, scaled by `size` when the kind is in {@link SIZE_SCALED_KINDS} and `size` is a
 * finite positive number — else the flat per-kind median unchanged. The scale is clamped to [0.5x, 3x] the flat
 * baseline so an extreme size (a mis-tagged size-1 epic slice, a size-13 outlier) can't blow the baseline out to
 * something no run could plausibly meet or a nearly-infinite one nothing could fail.
 * @param {string|null} kind
 * @param {number|null} [size]
 * @returns {number}
 */
export function baselineWallMs(kind, size = null) {
  const base = BASELINE_WALL_MS_BY_KIND[kind] ?? DEFAULT_BASELINE_WALL_MS;
  if (!SIZE_SCALED_KINDS.has(kind) || !Number.isFinite(size) || size <= 0) return base;
  const scaled = base * (size / REFERENCE_STORY_SIZE);
  return Math.min(Math.max(scaled, base * 0.5), base * 3);
}

const GRADE_ORDER = ['A', 'B', 'C', 'D'];
/** The WORSE (further from A) of two grades — used to combine an outcome cap with a mechanical grade, or two
 *  caps with each other. `null`/`undefined` never worsens anything (an absent cap is not a "no cap" grade). */
export function worseGrade(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return GRADE_ORDER[Math.max(GRADE_ORDER.indexOf(a), GRADE_ORDER.indexOf(b))];
}

const TEST_GATE_RE = /\b(npm run (?:test\S*|check:standards)|vitest|verify-lane\.mjs|heavy-admission\.mjs|check-standards\.mjs)\b/;
const GH_RE = /(^|[\s;&|(])gh(\s|$)/;
const GIT_RE = /(^|[\s;&|(])git(\s|$)/;
const OPS_RE = /scripts\/(?:operations|conveyor|lib|backlog)\/[\w.-]+\.mjs/;
const GUARD_BLOCK_RE = /hook error:\s*blocked/i;

// ── PURE: transcript extraction ─────────────────────────────────────────────────────────────────────────────────

/** Is this an assistant turn's `message.model` the harness's own synthetic marker (an auth failure / internal
 *  error turn) rather than a real model call? Its `usage` is meaningless and must never be summed. */
export function isSyntheticModel(model) {
  return typeof model === 'string' && model.trim().startsWith('<') && model.trim().endsWith('>');
}

/**
 * Every REAL (non-synthetic) assistant turn's `{ts, model, usage}`, in transcript order.
 * @param {object[]} lines - already-JSON-parsed transcript lines.
 * @returns {{ts:number|null, model:string|null, in:number, out:number, cacheRead:number, cacheWrite5m:number,
 *   cacheWrite1h:number, thinkingTokens:number}[]}
 */
export function extractTurns(lines) {
  const turns = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (line?.type !== 'assistant') continue;
    const message = line.message ?? {};
    const model = typeof message.model === 'string' ? message.model : null;
    if (isSyntheticModel(model)) continue;
    const usage = message.usage ?? {};
    const cacheCreation = usage.cache_creation ?? null;
    const cacheWrite5m = Number(cacheCreation?.ephemeral_5m_input_tokens) || 0;
    // No per-tier split reported (older/plain shape) — the whole amount is priced at the 1h tier, same
    // assumption `cost-rates.mjs` itself documents for this user's sessions.
    const cacheWrite1h = cacheCreation
      ? (Number(cacheCreation.ephemeral_1h_input_tokens) || 0)
      : (Number(usage.cache_creation_input_tokens) || 0);
    const ts = Date.parse(line.timestamp ?? '');
    turns.push({
      ts: Number.isFinite(ts) ? ts : null,
      model,
      in: Number(usage.input_tokens) || 0,
      out: Number(usage.output_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
      cacheWrite5m,
      cacheWrite1h,
      thinkingTokens: Number(usage.output_tokens_details?.thinking_tokens) || 0,
    });
  }
  return turns;
}

/** The dispatcher-minted slug this transcript's own `custom-title` line names, or `null` if absent. */
export function sessionNameFromLines(lines) {
  for (const line of Array.isArray(lines) ? lines : []) {
    if (line?.type === 'custom-title' && typeof line.customTitle === 'string') return line.customTitle;
  }
  return null;
}

/** First and last parseable `timestamp` across every line — the session's own wall-clock span, in ms. `null`
 *  when fewer than two timestamps are found (nothing to measure). */
export function computeWallMs(lines) {
  const bounds = sessionTimeBounds(lines);
  return bounds.startTs !== null && bounds.endTs !== null && bounds.endTs >= bounds.startTs ? bounds.endTs - bounds.startTs : null;
}

/** The session's own absolute `{startTs, endTs}` (first/last parseable `timestamp` across every line) —
 *  {@link computeWallMs}'s own scan, exposed separately so a caller (namely {@link rateTranscript}) can hand
 *  the ABSOLUTE start to {@link computeTimeShares} and correctly bound the leading/trailing gap, not just the
 *  duration. `null`/`null` with fewer than two timestamps found. */
export function sessionTimeBounds(lines) {
  let min = null;
  let max = null;
  for (const line of Array.isArray(lines) ? lines : []) {
    const ts = Date.parse(line?.timestamp ?? '');
    if (!Number.isFinite(ts)) continue;
    if (min === null || ts < min) min = ts;
    if (max === null || ts > max) max = ts;
  }
  return { startTs: min, endTs: max };
}

/**
 * Every `tool_use`/`tool_result` pair, joined by `tool_use_id`. A `tool_use` with no matching result (the
 * session is still running, or the transcript was truncated) is still reported, with `endTs`/`durationMs: null`
 * — never dropped, since it is still real evidence of what the run attempted.
 * @returns {{id:string, name:string|null, input:*, startTs:number|null, endTs:number|null, durationMs:number|null,
 *   isError:boolean, category:string, resultText:string}[]}
 */
export function pairToolEvents(lines) {
  const pending = new Map();
  const events = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const ts = Date.parse(line?.timestamp ?? '');
    const tsOrNull = Number.isFinite(ts) ? ts : null;
    if (line?.type === 'assistant') {
      const content = Array.isArray(line.message?.content) ? line.message.content : [];
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          pending.set(block.id, { name: typeof block.name === 'string' ? block.name : null, input: block.input ?? null, startTs: tsOrNull });
        }
      }
    } else if (line?.type === 'user') {
      const content = Array.isArray(line.message?.content) ? line.message.content : [];
      for (const block of content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        const resultText = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => (typeof c === 'string' ? c : (typeof c?.text === 'string' ? c.text : ''))).join('\n')
            : '';
        const startTs = call?.startTs ?? null;
        const name = call?.name ?? null;
        const input = call?.input ?? null;
        events.push({
          id: block.tool_use_id, name, input, startTs, endTs: tsOrNull,
          durationMs: startTs !== null && tsOrNull !== null && tsOrNull >= startTs ? tsOrNull - startTs : null,
          isError: block.is_error === true,
          category: classifyToolCall(name, input),
          // bounded — a mechanical guard-block/error CHECK only, never retained or printed past this module.
          resultText: resultText.slice(0, 4000),
        });
      }
    }
  }
  for (const [id, call] of pending) {
    events.push({
      id, name: call.name, input: call.input, startTs: call.startTs, endTs: null, durationMs: null,
      isError: false, category: classifyToolCall(call.name, call.input), resultText: '',
    });
  }
  return events;
}

/** PURE — which mechanical bucket a tool call belongs to. `Bash` is further split by command text; every other
 *  tool name resolves by name alone. */
export function classifyToolCall(name, input) {
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edits';
  if (name === 'Bash') {
    const cmd = String(input?.command ?? '');
    if (TEST_GATE_RE.test(cmd)) return 'tests-gates';
    if (GH_RE.test(cmd)) return 'gh';
    if (GIT_RE.test(cmd)) return 'git';
    if (OPS_RE.test(cmd)) return 'platform-ops';
    return 'other';
  }
  return 'other';
}

/**
 * Wall time attributed to each mechanical category, plus the leftover (no tool call in flight) split into
 * `reasoning` (a real assistant turn with `thinkingTokens > 0` falls inside the gap) vs `idle` (no such turn —
 * e.g. waiting on lane/admission, or a plain non-thinking turn). This is a MECHANICAL, approximate split:
 * overlapping parallel tool calls each contribute their own full duration to their own category (so category
 * totals can sum to slightly over 100% of wall time when calls ran in parallel) — documented here rather than
 * built out into a true interval union, which slice 1 does not need.
 * `sessionStartTs` (from {@link sessionTimeBounds}) anchors the wall span on the absolute timeline so the
 * lead-in (before the first tool call) and trailing (after the last tool result) gaps are counted too —
 * invariant: busy union + reasoningMs + idleMs === wallMs. Without it only the between-call gaps are counted.
 * @returns {{testsMs:number, ghMs:number, gitMs:number, editsMs:number, opsMs:number, otherMs:number,
 *   reasoningMs:number, idleMs:number, shares:Record<string, number|null>}}
 */
export function computeTimeShares(events, turns, wallMs, sessionStartTs = null) {
  const byCategory = { 'tests-gates': 0, gh: 0, git: 0, edits: 0, 'platform-ops': 0, other: 0 };
  const known = (Array.isArray(events) ? events : []).filter((e) => typeof e.durationMs === 'number');
  for (const e of known) byCategory[e.category] = (byCategory[e.category] ?? 0) + e.durationMs;

  // Busy-time union (deduplicated) purely to size the leftover "gap" time correctly even when calls overlap.
  const intervals = known
    .filter((e) => e.startTs !== null && e.endTs !== null)
    .map((e) => [e.startTs, e.endTs])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of intervals) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const busyMs = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
  const leftoverMs = typeof wallMs === 'number' ? Math.max(0, wallMs - busyMs) : null;

  // Gaps = the complement of the busy union, ACROSS THE WHOLE SESSION SPAN — not just between tool calls.
  // CONFIRMED review finding (antigravity-review/Logic, PR #2811): the earlier version only ever looked
  // BETWEEN merged busy intervals, so the gap before the FIRST tool call and after the LAST one (routinely
  // most of a session's wall time — e.g. a 20-minute session with one 2-minute tool call at the 10-minute
  // mark loses all 18 remaining minutes) was never counted as either idle or reasoning at all. Fixed by
  // seeding the walk with the session's own absolute start (`sessionStartTs`, when the caller has it — see
  // `rateTranscript`) and closing it out with an explicit trailing gap to the session's absolute end.
  let reasoningMs = 0;
  let idleMs = 0;
  const realTurns = (Array.isArray(turns) ? turns : []).filter((t) => t.ts !== null);
  if (leftoverMs !== null) {
    const gapBounds = [];
    if (sessionStartTs !== null && typeof wallMs === 'number') {
      const sessionEndTs = sessionStartTs + wallMs;
      let cursor = sessionStartTs;
      for (const [s, e] of merged) {
        if (s > cursor) gapBounds.push([cursor, s]);
        cursor = Math.max(cursor, e);
      }
      if (cursor < sessionEndTs) gapBounds.push([cursor, sessionEndTs]);
    } else {
      // No absolute session bounds given (an older/direct call, or bounds genuinely unavailable) — fall back
      // to the previous, KNOWN-INCOMPLETE behavior (between-call gaps only, or one bulk gap with no busy
      // intervals at all) rather than fabricate bounds this function was never given.
      let cursor = null;
      for (const [s, e] of merged) {
        if (cursor !== null && s > cursor) gapBounds.push([cursor, s]);
        cursor = cursor === null ? e : Math.max(cursor, e);
      }
      if (merged.length === 0 && typeof wallMs === 'number') gapBounds.push([null, null]);
    }
    for (const [gs, ge] of gapBounds) {
      const span = gs === null ? leftoverMs : Math.max(0, ge - gs);
      const hasThinking = gs === null
        ? realTurns.some((t) => t.thinkingTokens > 0)
        : realTurns.some((t) => t.ts >= gs && t.ts <= ge && t.thinkingTokens > 0);
      if (hasThinking) reasoningMs += span; else idleMs += span;
    }
  }

  const denom = typeof wallMs === 'number' && wallMs > 0 ? wallMs : null;
  const share = (ms) => (denom === null ? null : ms / denom);
  return {
    testsMs: byCategory['tests-gates'], ghMs: byCategory.gh, gitMs: byCategory.git,
    editsMs: byCategory.edits, opsMs: byCategory['platform-ops'], otherMs: byCategory.other,
    reasoningMs, idleMs,
    shares: {
      tests: share(byCategory['tests-gates']), gh: share(byCategory.gh), git: share(byCategory.git),
      edits: share(byCategory.edits), ops: share(byCategory['platform-ops']), other: share(byCategory.other),
      reasoning: share(reasoningMs), idle: share(idleMs),
    },
  };
}

/** Guard-hook refusals — the literal `hook error: Blocked` marker on an errored tool result. Counted, never
 *  the matched text retained. */
export function countGuardBlocks(events) {
  return (Array.isArray(events) ? events : []).filter((e) => e.isError && GUARD_BLOCK_RE.test(e.resultText)).length;
}

/** Every errored tool result (guard blocks are a SUBSET of this — see {@link countGuardBlocks} — callers that
 *  want non-guard errors alone compute `errors - guardBlocks`). */
export function countErrors(events) {
  return (Array.isArray(events) ? events : []).filter((e) => e.isError).length;
}

/** A stable signature for "the same call again": `name` + a deterministic stringify of `input` (sorted keys,
 *  so key order never hides a duplicate). */
function callSignature(name, input) {
  const stable = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(stable);
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  };
  try { return `${name ?? ''}::${JSON.stringify(stable(input))}`; } catch { return `${name ?? ''}::[unstringifiable]`; }
}

/** Total REPEAT calls (occurrences beyond the first) sharing an identical `(name, input)` signature — the
 *  waste this exists to catch: the same read, the same failing command, tried again with no change. */
export function countRepeatedCalls(events) {
  const counts = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    const sig = callSignature(e.name, e.input);
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  let repeats = 0;
  for (const n of counts.values()) if (n > 1) repeats += n - 1;
  return repeats;
}

/** {@link countRepeatedCalls}, restricted to `tests-gates` calls — the "ran the same test/gate command over
 *  and over" waste specifically (a stronger signal than a generic repeated call: no code changed in between,
 *  by definition, if the command AND its context are identical). */
export function countTestReruns(events) {
  return countRepeatedCalls((Array.isArray(events) ? events : []).filter((e) => e.category === 'tests-gates'));
}

/** Sum every real turn's usage into one `{in, out, cacheRead, cacheWrite5m, cacheWrite1h}` bag. */
export function sumTokens(turns) {
  const sums = { in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  for (const t of Array.isArray(turns) ? turns : []) {
    sums.in += t.in; sums.out += t.out; sums.cacheRead += t.cacheRead;
    sums.cacheWrite5m += t.cacheWrite5m; sums.cacheWrite1h += t.cacheWrite1h;
  }
  return sums;
}

/** The most-common real model id across turns, or `null` when there are none — never guessed as "probably
 *  opus" the way `cost-rates.mjs` itself refuses to (see that file's `rateFor` doc). */
export function dominantModel(turns) {
  const counts = new Map();
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t.model) continue;
    counts.set(t.model, (counts.get(t.model) ?? 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [model, n] of counts) if (n > bestN) { best = model; bestN = n; }
  return best;
}

/**
 * USD for a token bag, priced at `model`'s rate (`we:scripts/backlog/cost-rates.mjs`, the ONE declared price
 * table — never duplicated here). `null` for an unrecognised model family — matches `rateFor`'s own
 * "no silent opus fallback" rule; a caller must not sum a `null` cost into a total as if it were 0.
 */
export function computeCostUsd(tokenSums, model) {
  if (!rateFor(model)) return null;
  const cost5m = usdFromTokens({ cw: tokenSums.cacheWrite5m }, model, { cacheTier: '5m' });
  const cost1h = usdFromTokens(
    { in: tokenSums.in, cr: tokenSums.cacheRead, out: tokenSums.out, cw: tokenSums.cacheWrite1h },
    model,
    { cacheTier: '1h' },
  );
  return cost5m + cost1h;
}

/**
 * USD for a run's turns, each priced at ITS OWN model's rate (a mixed-model session is never priced wholesale at
 * the dominant model). Usage on a turn whose model has no rate is never guessed: it is counted in
 * `unpricedTokens`, `costUsdPartial` says the priced sum is a lower bound, and `costUsd` is `null` when nothing
 * at all could be priced (never a misleading 0).
 * @returns {{costUsd:number|null, costUsdPartial:boolean, unpricedTokens:number}}
 */
export function computeTurnsCost(turns) {
  const byModel = new Map();
  for (const t of Array.isArray(turns) ? turns : []) {
    const key = t.model ?? null;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push(t);
  }
  let costUsd = null;
  let unpricedTokens = 0;
  for (const [model, group] of byModel) {
    const sums = sumTokens(group);
    const cost = computeCostUsd(sums, model);
    if (cost === null) unpricedTokens += sums.in + sums.out + sums.cacheRead + sums.cacheWrite5m + sums.cacheWrite1h;
    else costUsd = (costUsd ?? 0) + cost;
  }
  return { costUsd, costUsdPartial: costUsd !== null && unpricedTokens > 0, unpricedTokens };
}

/** Of every input token this run needed (fresh + served-from-cache), what share was served from cache —
 *  `cacheRead / (in + cacheRead)`. `null` when neither occurred (nothing to rate a hit ratio on). */
export function computeCacheHitRatio(tokenSums) {
  const denom = (tokenSums.in ?? 0) + (tokenSums.cacheRead ?? 0);
  return denom > 0 ? tokenSums.cacheRead / denom : null;
}

// ── PURE: outcome + grade ───────────────────────────────────────────────────────────────────────────────────────

/** Raw completion-record `outcome` string → one of {@link OUTCOME_BUCKETS}. See {@link OUTCOME_MAP}'s own doc
 *  for the closed-prefix `escalated-*` rule. */
export function classifyOutcome(rawOutcome) {
  if (typeof rawOutcome !== 'string' || !rawOutcome.trim()) return 'unclassified';
  if (Object.hasOwn(OUTCOME_MAP, rawOutcome)) return OUTCOME_MAP[rawOutcome];
  return rawOutcome.startsWith('escalated') ? 'escalated' : 'unclassified';
}

/** Matches a `completion-cli.mjs report ... --status=done ... --outcome=<value>` Bash invocation — the exact
 *  shape every fix/ci-heal/review brief runs to self-report (`we:scripts/operations/completion-cli.mjs`,
 *  `we:skills-src/conveyor/fix-agent-brief.md`). `--status=done` is required in the SAME command so a `started`
 *  report (which also carries no `--outcome`) never matches. */
const COMPLETION_REPORT_DONE_RE = /completion-cli\.mjs\s+report\b[^\n]*--status=done\b[^\n]*--outcome=([^\s'"]+)/;

/**
 * FALLBACK outcome recovery, straight from the transcript's OWN tool calls — not the completion-store sidecar.
 * WHY THIS EXISTS: `we:scripts/operations/completion-store.mjs`'s own header calls its store a "gitignored
 * SESSION-LOCAL sidecar" — by design, ephemeral, swept by `session-reaper.mjs`'s retention pass well before a
 * 48h-old backfill runs. Live-caught running rubric v1's own backfill: 63 of 204 rows (31%) read `outcome:
 * null` purely because the completion record had already been pruned by read time, NOT because nothing was
 * ever reported — every dispatched agent's OWN Bash history still names its outcome verbatim, in the SAME
 * transcript this module already reads, and that text outlives the sidecar file. Scans every Bash `tool_use`
 * for the done-report shape above and returns the LAST match (a retried/re-reported session's most recent
 * self-report wins) — `null` when no such call appears (a still-running or crashed-before-reporting session;
 * never guessed).
 * @param {{name:string|null, input:*}[]} events
 * @returns {string|null}
 */
export function outcomeFromTranscriptEvents(events) {
  let found = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (e.name !== 'Bash') continue;
    const cmd = String(e.input?.command ?? '');
    const m = COMPLETION_REPORT_DONE_RE.exec(cmd);
    if (m) found = m[1];
  }
  return found;
}

/**
 * THE MECHANICAL GRADING RUBRIC (rubric v2, A–D — see {@link GRADE_THRESHOLDS}'s own doc for why v1 was
 * recalibrated and where every number below comes from).
 *
 * TWO KINDS OF RULE, applied in this order:
 *   1. OUTCOME CAPS (checked first — they can only make a grade WORSE than the mechanical one, never better):
 *      · a REWORK kind (`fix`/`ci-heal`) whose outcome is `nothing-to-fix` is graded `D` outright — a wasted
 *        dispatch, full stop, regardless of how clean the tool-call hygiene was (mechanical cleanliness was
 *        never the question; the dispatch itself should not have been needed).
 *      · a BUILD kind (`conveyor`/`prepare`/`prepare-decision`) whose produced PR later bounced (`prBounced:
 *        true`, an injected fact — this module does not itself decide "bounced", the caller supplies it) caps
 *        at `C` — the build might have been fast and clean, but its actual output needed rework.
 *      · an `escalated` outcome with no real decision behind it (`decisionReached: false`, the DEFAULT — see
 *        the param doc) caps at `C` — escalating is sometimes the right call, but slice 1 has no mechanical way
 *        to confirm a decision actually resolved it, so it conservatively never rewards an unresolved escalation
 *        with an A/B.
 *   2. MECHANICAL GRADE — an A is a HARD CONJUNCTION (`we:reports/` operator ruling, 2026-09-27): wallMs within
 *      baseline (`baselineWallMs(kind, size) * GRADE_THRESHOLDS.aTimeMultiplier`) AND guard blocks/repeated
 *      calls/test reruns all at or under their `GRADE_THRESHOLDS` allowances AND the outcome itself is one this
 *      dispatch kind counts as "good" (`accepted`/`pushed`, or `nothing-to-fix` for a kind where finding nothing
 *      IS the correct verdict — never for a REWORK kind, which already returned `D` above). Failing ANY of
 *      those, the run falls to the same point-deduction scoring rubric v1 used (still declared here, weights
 *      unchanged) to land on B/C/D by degree.
 * The final grade is the WORSE of the outcome cap (if any) and the mechanical grade — a cap can only pull a
 * grade down, never up (a mechanically messy run with a `nothing-to-fix` REWORK outcome is still the hard `D`
 * from rule 1, not "D capped to something worse than D", which doesn't exist).
 *
 * @param {{guardBlocks?:number, errors?:number, repeatedCalls?:number, testReruns?:number, wallMs?:number|null,
 *   kind?:string|null, size?:number|null, outcome?:string|null,
 *   prBounced?:boolean|null, decisionReached?:boolean}} o
 * @param {boolean|null} [o.prBounced] - ONLY meaningful for a {@link BUILD_KINDS} row: did the PR this build
 *   produced later carry a bounce (a `review:changes` round, or worse)? `null` = unknown/not checked (no cap
 *   applied — this module never assumes a bounce without evidence the caller supplies).
 * @param {boolean} [o.decisionReached] - did a REAL decision resolve this escalation? Always `false` unless a
 *   caller explicitly supplies otherwise — slice 1 has no mechanical way to confirm this (that confirmation is
 *   follow-up card #4075(c)'s own job), so the conservative default is "no decision", which is the common case.
 * @returns {'A'|'B'|'C'|'D'}
 */
export function gradeRun({
  guardBlocks = 0, errors = 0, repeatedCalls = 0, testReruns = 0, wallMs = null, kind = null, size = null,
  outcome = null, prBounced = null, decisionReached = false,
} = {}) {
  if (REWORK_KINDS.has(kind) && outcome === 'nothing-to-fix') return 'D';

  let cap = null;
  if (BUILD_KINDS.has(kind) && prBounced === true) cap = worseGrade(cap, 'C');
  if (outcome === 'escalated' && !decisionReached) cap = worseGrade(cap, 'C');

  const baseline = baselineWallMs(kind, size);
  const withinBaselineForA = typeof wallMs !== 'number' || baseline <= 0 || wallMs <= baseline * GRADE_THRESHOLDS.aTimeMultiplier;
  const zeroWasteForA = guardBlocks <= GRADE_THRESHOLDS.aGuardBlocksMax
    && repeatedCalls <= GRADE_THRESHOLDS.aRepeatedCallsMax
    && testReruns <= GRADE_THRESHOLDS.aTestRerunsMax;
  // `nothing-to-fix` is only a GOOD outcome for a kind where "nothing needed doing" is itself the correct
  // verdict (review/inspect) — a REWORK kind already returned the hard `D` above and never reaches this line.
  const goodOutcomeForA = outcome === 'accepted' || outcome === 'pushed' || outcome === 'nothing-to-fix';

  let mechanicalGrade;
  if (withinBaselineForA && zeroWasteForA && goodOutcomeForA) {
    mechanicalGrade = 'A';
  } else {
    let score = 100;
    score -= guardBlocks * 15;
    score -= Math.max(0, errors - guardBlocks) * 5;
    score -= repeatedCalls * 3;
    score -= testReruns * 5;
    if (typeof wallMs === 'number' && baseline > 0) {
      const ratio = wallMs / baseline;
      if (ratio > GRADE_THRESHOLDS.cTimeMultiplier) score -= 30;
      else if (ratio > GRADE_THRESHOLDS.bTimeMultiplier) score -= 15;
      else if (ratio > GRADE_THRESHOLDS.aTimeMultiplier) score -= 5;
    }
    score = Math.max(0, Math.min(100, score));
    mechanicalGrade = score >= GRADE_THRESHOLDS.bScoreMin ? 'B' : (score >= GRADE_THRESHOLDS.cScoreMin ? 'C' : 'D');
  }
  return worseGrade(mechanicalGrade, cap);
}

/**
 * THE REVIEW-JOB GRADE — deliberately separate from {@link gradeRun}: a job-mode review has no tool-call
 * hygiene to measure (no transcript — see this file's header), so it is graded on duration vs baseline plus
 * whether its verdict later held, per the operator's 2026-09-27 ruling.
 *
 * `verdictHeld` is NEVER computed here, and NEVER at score/append time at all — see {@link resolveReviewGrade}'s
 * own doc for why: at the moment a review is scored, "did the accept hold" is category­ically unknowable (no
 * FUTURE round can exist yet), so an `accepted` outcome ALWAYS stores `grade: 'pending'` — an honest fact about
 * what was knowable when this row was written, not a placeholder to be silently overwritten later (the
 * scorecard store's own Fork 3: a historical row is never re-normalised). `resolveReviewGrade` derives the
 * EFFECTIVE grade at REPORT time instead, from whatever later rounds the store has accumulated since.
 * @returns {'A'|'B'|'C'|'D'|'pending'}
 */
export function gradeReviewJob({ wallMs = null, outcome = null } = {}) {
  if (outcome === 'accepted') return 'pending';
  const baseline = BASELINE_WALL_MS_BY_KIND.review;
  let grade = 'B';
  if (typeof wallMs === 'number' && baseline > 0) {
    const ratio = wallMs / baseline;
    if (ratio <= GRADE_THRESHOLDS.aTimeMultiplier) grade = 'A';
    else if (ratio <= GRADE_THRESHOLDS.bTimeMultiplier) grade = 'B';
    else if (ratio <= GRADE_THRESHOLDS.cTimeMultiplier) grade = 'C';
    else grade = 'D';
  }
  if (outcome === 'escalated') grade = worseGrade(grade, 'C');
  // `bounced` needs no further adjustment — the review already told the truth immediately, nothing to "hold".
  return grade;
}

/**
 * REPORT-TIME resolution of a `pending` review row: does the CURRENT store (which may hold rounds scored well
 * after this one) show a later round on the same PR that bounced or escalated? If so, the accept did not
 * hold — report it as the effective `D` it always should have been. If this is still the most recent round for
 * its PR, it stays `pending` (genuinely not yet knowable). Every non-`pending` row passes through unchanged.
 * PURE: `laterSameyPr` is handed in by the caller (the `report` CLI queries the store and does the grouping/
 * ordering — see {@link ourRows}) — this function has no store access of its own.
 * @param {{grade:string, pr?:number|string|null}} row
 * @param {{outcome:string, scoredAt:string}[]} laterRowsSamePr - every OTHER review row for the same PR scored
 *   strictly after `row`, in any order.
 * @returns {'A'|'B'|'C'|'D'|'pending'}
 */
export function resolveReviewGrade(row, laterRowsSamePr = []) {
  if (row?.grade !== 'pending') return row?.grade ?? 'pending';
  const contradicted = laterRowsSamePr.some((l) => l.outcome === 'bounced' || l.outcome === 'escalated');
  return contradicted ? 'D' : 'pending';
}

// ── PURE: waste-minutes/tokens attribution ─────────────────────────────────────────────────────────────────────

/** The closed set of waste causes {@link classifyRunWaste} reports — the per-demand rollup's "top waste causes
 *  by minutes/by tokens" ranks over exactly these. `guard-block` carries a COUNT only (no minutes/tokens are
 *  mechanically attributable to a single refused call), so it never appears in a by-minutes/by-tokens ranking —
 *  it is still reported separately, by count, so it is never silently dropped from the picture. */
export const WASTE_CAUSES = Object.freeze([
  'nothing-to-fix-dispatch', 'test-rerun', 'repeated-call', 'escalated-no-decision', 'unheld-review-accept', 'guard-block',
]);

/**
 * Per-run waste attribution, in minutes and tokens, over the closed {@link WASTE_CAUSES} set. Two precise
 * causes (measured directly from paired tool-call durations, never estimated): `test-rerun` sums the
 * `durationMs` of every test/gate call beyond the first identical one; `repeated-call` does the same for every
 * OTHER repeated identical call. Two whole-run causes (the entire dispatch was the waste, not one call inside
 * it): `nothing-to-fix-dispatch` (a REWORK kind that found nothing) and `escalated-no-decision` (an unresolved
 * escalation) count the run's FULL wallMs/tokens/cost. Token amounts for the two precise causes are a
 * PROPORTIONAL ESTIMATE (repeat-call count share of all paired calls × total session tokens) — documented as
 * approximate, since no per-tool-call token cost is directly observable from a transcript's turn-level usage.
 * @param {object} events - {@link pairToolEvents}'s own output (needed for per-call durationMs; not stored on
 *   the scorecard row, so this must run at rating time, not report time).
 * @param {{wallMs:number|null, tokens:{in:number,out:number,cacheRead:number,cacheWrite:number}|null,
 *   costUsd:number|null, kind:string|null, outcome:string|null}} rating
 * @returns {{cause:string, minutes:number, tokens:number}[]}
 */
export function classifyRunWaste(events, rating) {
  const list = Array.isArray(events) ? events : [];
  const out = [];
  const totalTokens = rating.tokens ? (rating.tokens.in + rating.tokens.out + rating.tokens.cacheRead + rating.tokens.cacheWrite) : 0;
  const totalCalls = list.length;

  const bySig = new Map();
  for (const e of list) {
    const sig = callSignature(e.name, e.input);
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(e);
  }
  let testRerunCalls = 0;
  let testRerunMinutes = 0;
  let repeatedCallCalls = 0;
  let repeatedCallMinutes = 0;
  for (const group of bySig.values()) {
    if (group.length <= 1) continue;
    for (const e of group.slice(1)) {
      const minutes = typeof e.durationMs === 'number' ? e.durationMs / 60000 : 0;
      if (e.category === 'tests-gates') { testRerunCalls += 1; testRerunMinutes += minutes; }
      else { repeatedCallCalls += 1; repeatedCallMinutes += minutes; }
    }
  }
  if (testRerunCalls > 0) {
    out.push({ cause: 'test-rerun', minutes: testRerunMinutes, tokens: totalCalls > 0 ? totalTokens * (testRerunCalls / totalCalls) : 0 });
  }
  if (repeatedCallCalls > 0) {
    out.push({ cause: 'repeated-call', minutes: repeatedCallMinutes, tokens: totalCalls > 0 ? totalTokens * (repeatedCallCalls / totalCalls) : 0 });
  }
  if (REWORK_KINDS.has(rating.kind) && rating.outcome === 'nothing-to-fix') {
    out.push({ cause: 'nothing-to-fix-dispatch', minutes: (rating.wallMs ?? 0) / 60000, tokens: totalTokens });
  }
  if (rating.outcome === 'escalated') {
    out.push({ cause: 'escalated-no-decision', minutes: (rating.wallMs ?? 0) / 60000, tokens: totalTokens });
  }
  return out;
}

// ── PURE: orchestrator ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Combine every pure piece above into one rating record. `rawOutcome` is INJECTED (read from the completion
 * record by the IO shell) when available; when it is `null` (the completion sidecar has already been pruned —
 * the common case for anything more than a few hours old, see {@link outcomeFromTranscriptEvents}'s own doc)
 * this function falls back to recovering it from the transcript's own self-report, still never scraping
 * anything OTHER than that one declared shape.
 * @returns {object} the full per-run rating shape the operator asked for.
 */
export function rateTranscript(lines, {
  kind, pr = null, item = null, sessionName = null, rawOutcome = null, size = null, prBounced = null, decisionReached = false,
} = {}) {
  const turns = extractTurns(lines);
  const events = pairToolEvents(lines);
  const bounds = sessionTimeBounds(lines);
  const wallMs = bounds.startTs !== null && bounds.endTs !== null && bounds.endTs >= bounds.startTs ? bounds.endTs - bounds.startTs : null;
  const time = computeTimeShares(events, turns, wallMs, bounds.startTs);
  const guardBlocks = countGuardBlocks(events);
  const errors = countErrors(events);
  const repeatedCalls = countRepeatedCalls(events);
  const testReruns = countTestReruns(events);
  const tokenSums = sumTokens(turns);
  const model = dominantModel(turns);
  const { costUsd, costUsdPartial, unpricedTokens } = computeTurnsCost(turns);
  const cacheHitRatio = computeCacheHitRatio(tokenSums);
  const resolvedRawOutcome = rawOutcome ?? outcomeFromTranscriptEvents(events);
  const outcome = classifyOutcome(resolvedRawOutcome);
  const grade = gradeRun({ guardBlocks, errors, repeatedCalls, testReruns, wallMs, kind, size, outcome, prBounced, decisionReached });
  const tokens = { in: tokenSums.in, out: tokenSums.out, cacheRead: tokenSums.cacheRead, cacheWrite: tokenSums.cacheWrite5m + tokenSums.cacheWrite1h };
  const rating = {
    kind: kind ?? null, pr, item, sessionName: sessionName ?? sessionNameFromLines(lines), model,
    wallMs,
    testsMs: time.testsMs, ghMs: time.ghMs, gitMs: time.gitMs, editsMs: time.editsMs, opsMs: time.opsMs,
    otherMs: time.otherMs, reasoningMs: time.reasoningMs, idleMs: time.idleMs, shares: time.shares,
    guardBlocks, errors, repeatedCalls, testReruns,
    outcome, rawOutcome: resolvedRawOutcome ?? null,
    tokens, costUsd, costUsdPartial, unpricedTokens, cacheHitRatio, grade,
    dataQuality: 'transcript',
  };
  rating.waste = classifyRunWaste(events, rating);
  return rating;
}

/**
 * A review-job (job-mode dispatch, no transcript of its own — see this file's header) rated from its parsed
 * log summary alone. Tokens/cost/guard-blocks are NOT observable at this layer — reported `null`/`0` with
 * `dataQuality: 'job-log-only'` so a reader never mistakes an absence for a real zero. Grade comes from
 * {@link gradeReviewJob} (duration + pending-verdict), never {@link gradeRun} — see that function's own doc.
 */
export function rateReviewJobTimings({ pr = null, outcome = null, timings = {} } = {}) {
  const wallMs = Number.isFinite(timings?.totalMs) ? timings.totalMs : null;
  const classified = classifyOutcome(outcome);
  const grade = gradeReviewJob({ wallMs, outcome: classified });
  const rating = {
    kind: 'review', pr, item: null, sessionName: null, model: null,
    wallMs,
    testsMs: 0, ghMs: 0, gitMs: 0, editsMs: 0, opsMs: 0, otherMs: 0, reasoningMs: 0, idleMs: 0,
    shares: { tests: null, gh: null, git: null, edits: null, ops: null, other: null, reasoning: null, idle: null },
    guardBlocks: 0, errors: 0, repeatedCalls: 0, testReruns: 0,
    outcome: classified, rawOutcome: outcome ?? null,
    tokens: null, costUsd: null, cacheHitRatio: null, grade,
    dataQuality: 'job-log-only',
  };
  rating.waste = classified === 'escalated' ? [{ cause: 'escalated-no-decision', minutes: (wallMs ?? 0) / 60000, tokens: 0 }] : [];
  return rating;
}

// ── IO SHELL: locating and reading real transcripts / logs ─────────────────────────────────────────────────────

/** `~/.claude/projects` (or `WE_CLAUDE_PROJECTS_DIR` for tests / an alternate machine layout). */
export function defaultProjectsRoot(env = process.env) {
  const override = env?.WE_CLAUDE_PROJECTS_DIR;
  return override && override.trim() ? resolve(override.trim()) : join(homedir(), '.claude', 'projects');
}

function firstLineJson(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const nl = text.indexOf('\n');
    const first = nl === -1 ? text : text.slice(0, nl);
    if (!first.trim()) return null;
    return JSON.parse(first);
  } catch { return null; }
}

/**
 * Locate a dispatched session's own transcript file. Fast path: `sessionId` known (from `claude agents --json`)
 * → direct filename match. Fallback (a finished/backfill session, no longer in the live listing): scan every
 * `*operations-dispatch*` directory's files for one whose OWN first line is `{type:'custom-title', customTitle:
 * sessionName}` — bounded by `sinceMs` (an mtime floor) so a backfill sweep never re-scans the whole directory.
 * `null` when nothing matches (never guessed).
 */
export function findTranscriptPath(sessionName, { sessionId = null, projectsRoot = defaultProjectsRoot(), sinceMs = null } = {}) {
  if (!existsSync(projectsRoot)) return null;
  let dirEntries;
  try { dirEntries = readdirSync(projectsRoot, { withFileTypes: true }); } catch { return null; }
  const dirs = dirEntries.filter((d) => d.isDirectory() && d.name.includes('operations-dispatch')).map((d) => join(projectsRoot, d.name));
  if (sessionId) {
    for (const dir of dirs) {
      const p = join(dir, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  }
  if (!sessionName) return null;
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const p = join(dir, name);
      if (sinceMs !== null) {
        try { if (statSync(p).mtimeMs < sinceMs) continue; } catch { /* fall through to checking it anyway */ }
      }
      const first = firstLineJson(p);
      if (first?.type === 'custom-title' && first.customTitle === sessionName) return p;
    }
  }
  return null;
}

/** Parse a transcript file into an array of line objects, skipping any line that fails to parse (never
 *  throws — a torn last line from a still-writing session is expected, not corrupt). */
export function readTranscriptLines(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch { /* torn/partial line — skip it, not fatal */ }
  }
  return lines;
}

/**
 * Rate ONE dispatched session end-to-end: find its transcript, read it, read its completion record for the
 * real outcome, and combine via {@link rateTranscript}. Returns `{ok:false, reason}` rather than throwing when
 * evidence is missing (a session whose transcript has already been pruned, or was never a real dispatch).
 */
export function rateSession({
  sessionName, sessionId = null, kind, pr = null, item = null, sinceMs = null, transcriptPath = null,
  size = null, prBounced = null, decisionReached = false,
} = {}) {
  const path = transcriptPath ?? findTranscriptPath(sessionName, { sessionId, sinceMs });
  if (!path) return { ok: false, reason: 'transcript-not-found', sessionName, kind, pr, item };
  const lines = readTranscriptLines(path);
  if (!lines.length) return { ok: false, reason: 'transcript-unreadable-or-empty', sessionName, kind, pr, item, transcriptPath: path };
  let record = null;
  try { record = tryReadCompletion(sessionName); } catch { record = null; }
  const rating = rateTranscript(lines, {
    kind, pr, item, sessionName, rawOutcome: record?.outcome ?? null, size, prBounced, decisionReached,
  });
  return { ok: true, transcriptPath: path, ...rating };
}

/**
 * Rate ONE review-job log file (`.operations/review-jobs/<slug>.log`). Parses the LAST line that is valid JSON
 * (the job's own structured summary, written once at exit — see `we:scripts/operations/review-job.mjs`'s
 * `finally` block) rather than the whole log, since every earlier line is plain narrative text.
 */
/**
 * The one run record a review-job's own `runId` names (`.operations/runs/<runId>.json`, `we:scripts/operations/
 * run-store.mjs`) — read directly by id, never scanned, since the log already told us exactly which one.
 * Returns `null` on anything (missing file, unparseable JSON, no `telemetry`) — never guessed. Sums EVERY seat's
 * REAL token count (accurate regardless of provider) but only a Claude-priced seat's own `costUsd` (a
 * Codex/antigravity seat's `costUsd` is always reported `0` upstream — folding that in would UNDERSTATE this
 * review's true cost, not accurately report zero; `costUsdPartial: true` flags when this happened).
 */
function readReviewRunTelemetry(runId, { runsDir = resolve(REPO_ROOT, '.operations', 'runs') } = {}) {
  if (!runId) return null;
  let record;
  try { record = JSON.parse(readFileSync(join(runsDir, `${runId}.json`), 'utf8')); } catch { return null; }
  const seats = Array.isArray(record?.telemetry) ? record.telemetry : [];
  if (seats.length === 0) return null;
  let tokens = zeroTokenBag();
  let costUsd = 0;
  let costUsdPartial = false;
  for (const seat of seats) {
    const usage = seat?.usage ?? {};
    tokens = addTokenBag(tokens, {
      in: Number(usage.input_tokens) || 0, out: Number(usage.output_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0, cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
    });
    if (rateFor(seat?.model ?? '') !== null) costUsd += Number(seat?.costUsd) || 0;
    else costUsdPartial = true;
  }
  return { tokens, costUsd, costUsdPartial };
}

/**
 * Rate ONE review-job log file (`.operations/review-jobs/<slug>.log`). Parses the LAST line that is valid JSON
 * (the job's own structured summary, written once at exit — see `we:scripts/operations/review-job.mjs`'s
 * `finally` block) rather than the whole log, since every earlier line is plain narrative text. Then, best
 * effort, JOINS the summary's own `runId` back to that judge run's telemetry record ({@link
 * readReviewRunTelemetry}) so this row's tokens/cost are filled in from the ACTUAL juror seats this review ran
 * — the fix for the operator's own 2026-09-27 finding ("reviews stop being tokens=null"). Falls back to
 * `dataQuality: 'job-log-only'`/`tokens: null` unchanged when no run record joins (an old log predating the run
 * record's own retention, or a `--mode=session` review that never had one).
 */
export function rateReviewJobLog(logPath, io = {}) {
  let text;
  try { text = readFileSync(logPath, 'utf8'); } catch { return { ok: false, reason: 'log-unreadable', logPath }; }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let summary = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { summary = JSON.parse(lines[i]); break; } catch { /* keep looking backwards */ }
  }
  if (!summary) return { ok: false, reason: 'no-summary-line', logPath };
  // A job that never ran a review loop (refused as a duplicate, failed to acquire a lane) did no review work —
  // skip it rather than append a degenerate, trivially-A row to the scorecard. A loop that CRASHED after taking
  // a lane (loopMs null, but lanePath set) did cost real work, so it is still rated. `review-job.mjs` always
  // writes `timings.loopMs` (null until the loop runs), so only an explicit null counts as "no loop ran".
  if (summary.refused === true || (summary.timings?.loopMs === null && !summary.lanePath)) {
    return { ok: false, reason: 'no-review-loop-ran', logPath, outcome: summary.outcome ?? null };
  }
  const rating = rateReviewJobTimings({ pr: summary.pr ?? null, outcome: summary.outcome ?? null, timings: summary.timings ?? {} });
  const telemetry = readReviewRunTelemetry(summary.runId, io);
  if (telemetry) {
    rating.tokens = telemetry.tokens;
    rating.costUsd = telemetry.costUsd;
    rating.costUsdPartial = telemetry.costUsdPartial;
    rating.dataQuality = 'juror-telemetry';
  }
  return { ok: true, logPath, ...rating, sessionName: summary.sessionSlug ?? null, verdict: summary.verdict ?? null };
}

/**
 * BEST-EFFORT live `gh` lookup: did the PR built from backlog item `item` (branch `lane/<item>-*`, `we:scripts/
 * conveyor/lease-reaper.mjs#laneRefItemNum`'s own grammar) ever carry a bounce? Returns `true`/`false` only on a
 * confident read (a matching PR was found); `null` on ANYTHING else (no matching PR, `gh` unavailable, a parse
 * failure) — {@link gradeRun}'s own doc: a `null` `prBounced` applies NO cap, never assumed bounced without
 * evidence. Never called from the live per-session hook (one more `gh` call per reaped build session is a cost
 * a caller opts into deliberately, e.g. the backfill script) — `rateAndRecordSession`'s default leaves this off.
 * @param {string|number} item
 * @param {{exec?: typeof execFileSync}} [io]
 * @returns {boolean|null}
 */
export function resolvePrBouncedViaGh(item, { exec = execFileSync, repo = DEFAULT_REPO_SLUG } = {}) {
  if (!item) return null;
  let out;
  try {
    out = exec('gh', ['pr', 'list', '--repo', repo, '--search', `head:lane/${item}-`, '--state', 'all', '--json', 'number,labels', '--limit', '5'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  let list;
  try { list = JSON.parse(out); } catch { return null; }
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.some((pr) => Array.isArray(pr.labels) && pr.labels.some((l) => l?.name === 'review:changes'));
}

// ── IO SHELL: recording a rating onto the scorecard store ───────────────────────────────────────────────────────

/**
 * A rating record → a valid `run-scorecard-store.mjs` row. Required-schema fields get a MECHANICAL proxy
 * (`score`: a fixed number per grade band, `deductions[]`: one entry per criterion that cost points); every
 * field this module actually cares about rides through as an extra field (that store's own docs: "extra
 * fields pass through").
 */
export function toScorecardRow(rating, { provider = 'anthropic', repoRoot = REPO_ROOT, preparedForItem: preparedResolver } = {}) {
  const resolvePrepared = preparedResolver ?? ((item) => preparedForItem(item, { repoRoot }));
  const gradeScore = { A: 95, B: 80, C: 55, D: 25 }[rating.grade] ?? null;
  // Evidence strings are deliberately plain plural, never `(s)` — that reads to the append-time secret scrub
  // as call-syntax (`name(...)`) and gets refused outright (Fork 2's amendment: deny on a hit, never redact —
  // found live running this module's own backfill against real production rows).
  const deductions = [];
  if (rating.guardBlocks > 0) {
    deductions.push({ criterion: 'guard-blocks', evidence: `${rating.guardBlocks} hook-error:Blocked tool results, target under ${GUARD_BLOCKS_TARGET}` });
  }
  const nonGuardErrors = Math.max(0, (rating.errors ?? 0) - (rating.guardBlocks ?? 0));
  if (nonGuardErrors > 0) deductions.push({ criterion: 'tool-errors', evidence: `${nonGuardErrors} non-guard tool errors` });
  if (rating.repeatedCalls > 0) deductions.push({ criterion: 'repeated-calls', evidence: `${rating.repeatedCalls} identical repeated tool calls` });
  if (rating.testReruns > 0) deductions.push({ criterion: 'test-reruns', evidence: `${rating.testReruns} identical test/gate reruns` });
  return {
    rubricVersion: RUBRIC_VERSION,
    provider,
    model: rating.model ?? 'unknown',
    subjectClass: 'work-agent',
    dispatchKind: rating.kind ?? 'unknown',
    criteriaEvaluated: MECHANICAL_CRITERIA_COUNT,
    score: gradeScore,
    deductions,
    item: rating.item ?? null,
    pr: rating.pr ?? null,
    handle: rating.sessionName ?? null,
    grade: rating.grade,
    wallMs: rating.wallMs ?? null,
    outcome: rating.outcome ?? null,
    rawOutcome: rating.rawOutcome ?? null,
    guardBlocks: rating.guardBlocks ?? 0,
    errors: rating.errors ?? 0,
    repeatedCalls: rating.repeatedCalls ?? 0,
    testReruns: rating.testReruns ?? 0,
    tokens: rating.tokens ?? null,
    costUsd: rating.costUsd ?? null,
    unpricedTokens: rating.unpricedTokens ?? 0,
    cacheHitRatio: rating.cacheHitRatio ?? null,
    shares: rating.shares ?? null,
    dataQuality: rating.dataQuality ?? 'transcript',
    waste: Array.isArray(rating.waste) ? rating.waste : [],
    costUsdPartial: rating.costUsdPartial ?? false,
    prepared: resolvePrepared(rating.item ?? null),
  };
}

/** Append a rating to the scorecard store. Returns what `appendScorecard` returns (the stored row), or `null`
 *  if the rating was not `ok` (nothing to append). Never throws on a missing-evidence rating — that is a
 *  normal, expected outcome (session gone, log not yet written), not a bug. */
export function appendRunRating(rating, io) {
  if (!rating || rating.ok === false) return null;
  return appendScorecard(toScorecardRow(rating), io);
}

/**
 * THE HOOK: rate a just-finished daemon session and append it — best-effort, NEVER throws (a rating failure
 * must never block the reap/report path that calls it). Called from `session-reaper.mjs` right after a session
 * is confirmed stopped, and from `review-job.mjs`'s own `finally` block for a job-mode review.
 */
export function rateAndRecordSession(params, io) {
  try {
    const rating = rateSession(params);
    if (!rating.ok) return rating;
    appendRunRating(rating, io);
    return rating;
  } catch (e) {
    return { ok: false, reason: `rate-and-record threw: ${String(e?.message || e).split('\n')[0]}` };
  }
}

/** Same best-effort contract as {@link rateAndRecordSession}, for a review-job log instead of a session
 *  transcript. */
export function rateAndRecordReviewJob(logPath, io) {
  try {
    const rating = rateReviewJobLog(logPath);
    if (!rating.ok) return rating;
    appendRunRating(rating, io);
    return rating;
  } catch (e) {
    return { ok: false, reason: `rate-and-record threw: ${String(e?.message || e).split('\n')[0]}` };
  }
}

// ── PURE: per-demand rollup ─────────────────────────────────────────────────────────────────────────────────────

const PHASE_BY_KIND = Object.freeze({
  fix: 'rework', 'ci-heal': 'rework', inspect: 'rework',
  review: 'review',
  conveyor: 'build', prepare: 'build', 'prepare-decision': 'build',
});

/** Which phase bucket (`build` / `review` / `rework`) a dispatch kind's tokens belong to for the per-demand
 *  token table. Unknown kinds land in `other` — never silently folded into one of the three named phases. */
export function phaseForKind(kind) {
  return PHASE_BY_KIND[kind] ?? 'other';
}

/** The demand a row belongs to: `<repo>#<pr-or-item>`. Rows with neither `pr` nor `item` are their own
 *  singleton group (`sessionName` keyed) rather than silently merged together under one `#unknown` bucket. */
export function rollupKey(row) {
  const repo = row.repo ?? DEFAULT_REPO_SLUG;
  if (row.pr) return `${repo}#pr${row.pr}`;
  if (row.item) return `${repo}#item${row.item}`;
  return `${repo}#session:${row.sessionName ?? 'unknown'}`;
}

/**
 * Group scored rows by demand (card/PR), summing tokens/cost per phase. `sizeForItem(itemOrPr)` is an
 * injectable resolver (defaults to reading the backlog frontmatter `size` field via `we:scripts/backlog/
 * frontmatter.mjs#readField` when the demand names a backlog item) so `tokensPerStoryPoint` can be computed
 * without this pure function itself touching the filesystem.
 */
export function rollupByDemand(rows, { sizeForItem = () => null } = {}) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = rollupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        key, repo: row.repo ?? DEFAULT_REPO_SLUG, pr: row.pr ?? null, item: row.item ?? null,
        sessions: 0, byPhase: {},
      });
    }
    const g = groups.get(key);
    g.sessions += 1;
    const phase = phaseForKind(row.dispatchKind ?? row.kind);
    if (!g.byPhase[phase]) {
      g.byPhase[phase] = {
        sessions: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0,
        unknownCost: false, unknownTokens: false, unknownSessions: 0,
      };
    }
    const p = g.byPhase[phase];
    p.sessions += 1;
    const t = row.tokens;
    if (t) { p.tokensIn += t.in ?? 0; p.tokensOut += t.out ?? 0; p.tokensCacheRead += t.cacheRead ?? 0; p.tokensCacheWrite += t.cacheWrite ?? 0; }
    else { p.unknownTokens = true; p.unknownSessions += 1; }
    if (typeof row.costUsd === 'number') p.costUsd += row.costUsd;
    else p.unknownCost = true;
    // A row priced only in part (some usage on an unpriced model) makes this phase's cost a lower bound too.
    if (row.costUsdPartial === true) p.unknownCost = true;
  }
  return [...groups.values()].map((g) => {
    const phases = Object.values(g.byPhase);
    const totalTokens = phases.reduce((s, p) => s + p.tokensIn + p.tokensOut + p.tokensCacheRead + p.tokensCacheWrite, 0);
    const totalCostUsd = phases.reduce((s, p) => s + p.costUsd, 0);
    const size = g.item ? sizeForItem(g.item) : (g.pr ? sizeForItem(g.pr) : null);
    // A demand's total is INCOMPLETE (never silently presented as the whole truth) whenever ANY phase
    // couldn't measure every session's tokens/cost — e.g. a job-log-only review row with no run-record join.
    // Live-caught in review of this very PR: printing a bare "0 tok, $0.00" for an all-unmeasured demand read
    // as "this cost nothing", not "this was never measured" — the exact confusion the rest of this module
    // works hard everywhere else to avoid.
    const hasUnknownTokens = phases.some((p) => p.unknownTokens);
    const hasUnknownCost = phases.some((p) => p.unknownCost);
    const unmeasuredSessions = phases.reduce((s, p) => s + p.unknownSessions, 0);
    return {
      ...g, totalTokens, totalCostUsd, hasUnknownTokens, hasUnknownCost, unmeasuredSessions,
      size: Number.isFinite(size) && size > 0 ? size : null,
      tokensPerStoryPoint: Number.isFinite(size) && size > 0 ? totalTokens / size : null,
    };
  });
}

/** Shared by {@link backlogSizeForItem} and {@link preparedForItem} — both are "read one frontmatter field off
 *  `backlog/<num>-*.md`" with the same numeric-id gate, directory glob and not-found handling; this is the one
 *  place that logic lives. `null` when the id isn't a plain numeric item (a hash-identified item this glob
 *  can't match), no card is found, or the file can't be read — never throws. */
function readBacklogCardContent(itemOrPr, { repoRoot = REPO_ROOT } = {}) {
  const num = String(itemOrPr ?? '').trim();
  if (!/^\d+$/.test(num)) return null;
  let names;
  try { names = readdirSync(join(repoRoot, 'backlog')); } catch { return null; }
  const match = names.find((n) => n.startsWith(`${num}-`) && n.endsWith('.md'));
  if (!match) return null;
  try { return readFileSync(join(repoRoot, 'backlog', match), 'utf8'); } catch { return null; }
}

/** Default `sizeForItem` — reads `backlog/<num>-*.md`'s `size:` frontmatter field via the canonical reader
 *  (`readField`), never a hand-rolled YAML parse. `null` for anything not found (no card, no size stamped, or
 *  a hash-identified item this glob can't match). */
export function backlogSizeForItem(itemOrPr, { repoRoot = REPO_ROOT } = {}) {
  const content = readBacklogCardContent(itemOrPr, { repoRoot });
  if (content === null) return null;
  const size = Number(readField(content, 'size'));
  return Number.isFinite(size) ? size : null;
}

/**
 * Whether the backlog card for `itemOrPr` carries evidence of being PREPARED (Definition-of-Ready — #2618):
 * filed and prepared with scope, risks, a test plan and tasks, reviewed before build, as opposed to a bespoke
 * ad-hoc prompt. Detected the same way {@link backlogSizeForItem} detects `size` — a direct read of the card's
 * `preparedDate` frontmatter field via {@link readField}, at SCORE time (#4304's chosen design; see that card)
 * — never inferred from `dispatchKind` alone, because a conveyor-dispatched item can itself be unprepared (a
 * scaffolded-but-never-reviewed card).
 *
 * This checks PRESENCE of a stamped `preparedDate`, not its ORDERING relative to any particular dispatch or
 * claim — a card is prepared once and can be claimed/dispatched any number of times after, and this module has
 * no per-dispatch "was it still prepared as of THIS run" timestamp to compare against (nothing else in the
 * codebase tracks that either). "Prepared" here means "this card was, at some point, brought to Definition of
 * Ready" — the same thing the story-preparation checklist itself stamps `preparedDate` for.
 *
 * Returns `false` — never `null` — whenever prepared status cannot be CONFIRMED: no `item` at all, a hash-only
 * id this numeric glob can't match, no matching card on disk, or a card with no `preparedDate` stamped.
 * "Prepared" is an affirmative claim a caller must be able to trust, so the absence of evidence is never
 * treated as evidence of readiness.
 * @param {string|number|null} itemOrPr
 * @param {{repoRoot?: string}} [o]
 * @returns {boolean}
 */
export function preparedForItem(itemOrPr, { repoRoot = REPO_ROOT } = {}) {
  const content = readBacklogCardContent(itemOrPr, { repoRoot });
  if (content === null) return false;
  const raw = readField(content, 'preparedDate');
  return typeof raw === 'string' && raw.trim() !== '';
}

/**
 * Waste flags across a set of rows: a `nothing-to-fix` run (tokens spent confirming nothing needed doing), any
 * repeated-identical-call count, and — when rows carry a `headSha` (not populated by slice 1's own hooks, an
 * honest known gap; a future caller that plumbs it through gets this for free) — more than one `review` row
 * against the same PR+head.
 */
export function flagWaste(rows) {
  const waste = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.outcome === 'nothing-to-fix') {
      waste.push({ type: 'nothing-to-fix', sessionName: row.handle ?? row.sessionName ?? null, pr: row.pr ?? null, item: row.item ?? null, tokens: row.tokens ?? null, costUsd: row.costUsd ?? null });
    }
    if ((row.repeatedCalls ?? 0) > 0) {
      waste.push({ type: 'repeated-identical-calls', sessionName: row.handle ?? row.sessionName ?? null, pr: row.pr ?? null, item: row.item ?? null, count: row.repeatedCalls });
    }
  }
  const byPrHead = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if ((row.dispatchKind ?? row.kind) !== 'review' || !row.pr || !row.headSha) continue;
    const key = `${row.pr}@${row.headSha}`;
    byPrHead.set(key, (byPrHead.get(key) ?? []).concat(row));
  }
  for (const [key, group] of byPrHead) {
    if (group.length > 1) {
      const priced = group.filter((r) => typeof r.costUsd === 'number');
      waste.push({
        type: 'repeat-review-same-head', key, count: group.length,
        costUsd: priced.length ? priced.reduce((s, r) => s + r.costUsd, 0) : null,
        costPartial: priced.length > 0 && group.some((r) => typeof r.costUsd !== 'number' || r.costUsdPartial === true),
      });
    }
  }
  return waste;
}

/**
 * Aggregate every row's `waste[]` (see {@link classifyRunWaste}) into totals per {@link WASTE_CAUSES} cause,
 * ranked by `by` (`'minutes'` or `'tokens'`), top `limit`. `guard-block` is reported by COUNT alongside the
 * ranked list (see {@link WASTE_CAUSES}'s own doc for why it never joins the minutes/tokens ranking itself).
 * @param {object[]} rows - scorecard rows (each carrying its own `waste[]` and `guardBlocks`).
 * @param {{by?:'minutes'|'tokens', limit?:number}} [o]
 * @returns {{ranked:{cause:string, minutes:number, tokens:number, instances:number}[], guardBlockCount:number}}
 */
export function topWasteCauses(rows, { by = 'minutes', limit = 5 } = {}) {
  const totals = new Map();
  let guardBlockCount = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    guardBlockCount += row.guardBlocks ?? 0;
    for (const w of Array.isArray(row.waste) ? row.waste : []) {
      if (!totals.has(w.cause)) totals.set(w.cause, { cause: w.cause, minutes: 0, tokens: 0, instances: 0 });
      const t = totals.get(w.cause);
      t.minutes += w.minutes ?? 0;
      t.tokens += w.tokens ?? 0;
      t.instances += 1;
    }
  }
  const ranked = [...totals.values()].sort((a, b) => b[by] - a[by]).slice(0, limit);
  return { ranked, guardBlockCount };
}

/**
 * Prepared-vs-unprepared comparison for the `report` CLI (#4304) — splits `rows` STRICTLY on the stamped
 * `row.prepared` boolean: `true` → "prepared", `false` → "unprepared". A row with `prepared` missing
 * entirely (`undefined` — every row scored before this field existed) is EXCLUDED from both buckets, never
 * folded into "unprepared": `false` is an affirmative "checked, and no evidence of readiness"; `undefined` is
 * "never checked at all", and conflating the two would silently contaminate the unprepared side with an
 * unknown-sized cohort of legacy rows the instant this ships (a real report-accuracy defect a red-team of this
 * very card's diff converged on independently across four lenses — never guess a legacy row's prepared-ness
 * either direction). Summarizes each side: row count, average wall time, tokens per demand (via
 * {@link rollupByDemand}), rework-round count (`dispatchKind` in {@link REWORK_KINDS}), and grade distribution.
 * PURE — takes no `sizeForItem` option: `tokensPerDemand` is `totalTokens / demandCount` only, never a
 * size-derived figure, so there is nothing here for a size resolver to feed (an earlier revision threaded one
 * through to {@link rollupByDemand} and it was genuinely never read — removed rather than kept as unused
 * plumbing).
 * @param {object[]} rows
 */
export function preparedComparison(rows) {
  const buckets = { prepared: [], unprepared: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.prepared === true) buckets.prepared.push(row);
    else if (row.prepared === false) buckets.unprepared.push(row);
    // `row.prepared === undefined` (a pre-#4304 row) is neither — excluded from both sides, not guessed.
  }
  const summarize = (groupRows) => {
    const wallTimes = groupRows.map((r) => r.wallMs).filter((w) => typeof w === 'number');
    const avgWallMs = wallTimes.length ? wallTimes.reduce((s, w) => s + w, 0) / wallTimes.length : null;
    const demand = rollupByDemand(groupRows);
    const totalTokens = demand.reduce((s, d) => s + d.totalTokens, 0);
    const tokensPerDemand = demand.length ? totalTokens / demand.length : null;
    const reworkRounds = groupRows.filter((r) => REWORK_KINDS.has(r.dispatchKind)).length;
    const gradeCounts = { A: 0, B: 0, C: 0, D: 0 };
    for (const r of groupRows) if (gradeCounts[r.grade] !== undefined) gradeCounts[r.grade] += 1;
    return { count: groupRows.length, avgWallMs, tokensPerDemand, demandCount: demand.length, reworkRounds, gradeCounts };
  };
  return { prepared: summarize(buckets.prepared), unprepared: summarize(buckets.unprepared) };
}

// ── PURE + IO: full-fleet token COVERAGE (message-2 recalibration, #4075, operator-directed 2026-09-27) ──────────
//
// THE GAP THIS CLOSES: slice 1's own backfill counted only ~193M of the operator's independently measured ~431M
// tokens across DISPATCHED DAEMON sessions alone in the same window — before even counting the orchestrator
// session itself (~1.0B), its Agent-tool subagent workers (~8.5B), or every other Claude session on the box
// (~2.0B: review jurors, health checks, interactive work). A rating tool whose own rollup silently covers a
// fraction of total spend is not a token-EFFICIENCY tool, it is a dispatched-daemon-efficiency tool wearing the
// wrong name. This section makes the coverage EXPLICIT rather than papering over it: every source is scanned,
// summed, and bucketed, and the report states what fraction of the observed total lands in each bucket —
// including "unattributed" when a source can't be read at all — so a reader never mistakes partial coverage for
// complete coverage again.
//
// THE FIVE COVERAGE BUCKETS:
//   • `dispatched-daemon`  — already the whole of the rest of this file; a session's tokens are ATTRIBUTED (a
//     PR or item is known).
//   • `review-juror`       — a review's judge-panel seats. THESE HAVE NO TRANSCRIPT OF THEIR OWN: `claude
//     --no-session-persistence` (`we:scripts/lib/judge-spawn.mjs`) means nothing is ever written to
//     `~/.claude/projects`. The durable record is instead each judge run's OWN run record
//     (`we:scripts/operations/run-store.mjs`, `.operations/runs/review-pr-<runId>.json`), whose `telemetry[]`
//     array already carries `{lens, model, usage, costUsd}` per seat and whose `input.pr` names the PR — so
//     these rows ARE attributed, same as dispatched-daemon.
//   • `orchestration-overhead` — the interactive orchestrator session's own top-level transcript PLUS every
//     Agent-tool subagent it spawned (`~/.claude/projects/<the orchestrator project dir>/<sessionId>.jsonl` and
//     `.../<sessionId>/subagents/agent-*.jsonl` — same line shape as any other transcript). Attributing a
//     SPECIFIC subagent's tokens to a SPECIFIC PR/item would need unreliable content-sniffing across a
//     free-text task description; this module takes the coordinator's own offered alternative instead and
//     buckets ALL of it as overhead — honest, not a guess.
//   • `operator-interactive` — every OTHER `~/.claude/projects/*/*.jsonl` this machine has (lane-clone sessions,
//     health checks, ad hoc interactive work) — never a demand's cost, never overhead from a delivery run either.
//   • `non-claude-judge`    — Codex/antigravity judge-panel seats. ALSO no transcript under `~/.claude/projects`
//     (a different provider's CLI entirely) — read instead from `~/.codex-judge-transcripts/*.jsonl` /
//     `~/.antigravity-judge-transcripts/*.jsonl` (`we:scripts/lib/codex-judge-spawn.mjs` /
//     `antigravity-judge-spawn.mjs`), each file's LAST `type:'turn.completed'` line. These providers report
//     `costUsd: 0` always (confirmed: no USD figure exists anywhere in either CLI's own output) and this module
//     has no declared non-Anthropic price table (unlike `cost-rates.mjs` for Claude) — tokens are real, `costUsd`
//     is honestly `null`, NEVER guessed at an invented GPT/Gemini rate. `we:scripts/codex-direct-task.mjs` /
//     `gemini-direct-task.mjs` (the PERSONAL escape hatches, distinct from the judge-panel seats above) keep no
//     durable usage log at all (their own log file is truncated at the start of every run) — genuinely nothing
//     to read there, not a gap this module failed to close.

export const COVERAGE_BUCKETS = Object.freeze([
  'dispatched-daemon', 'review-juror', 'orchestration-overhead', 'operator-interactive', 'non-claude-judge',
]);

function zeroTokenBag() { return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }; }
function addTokenBag(a, b) { return { in: a.in + b.in, out: a.out + b.out, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }; }
function tokenBagTotal(b) { return b.in + b.out + b.cacheRead + b.cacheWrite; }

/** The orchestrator's OWN `~/.claude/projects` directory name on this machine (`WE_ORCHESTRATOR_PROJECT_DIR` for
 *  a test/alternate layout) — confirmed live: `-Users-nicolasgilbert-workspace-webeverything`, one directory
 *  per checkout path, never per session. */
export function orchestratorProjectDirName(env = process.env) {
  return env?.WE_ORCHESTRATOR_PROJECT_DIR || '-Users-nicolasgilbert-workspace-webeverything';
}

/**
 * Scan every `~/.claude/projects/*` transcript (recursing into the orchestrator's own project dir to also pick
 * up its `<sessionId>/subagents/agent-*.jsonl` files) and bucket each file's token sum into `dispatched-daemon`
 * / `orchestration-overhead` / `operator-interactive` (see this section's own header for the bucket definitions).
 * Reuses {@link extractTurns}/{@link sumTokens}/{@link dominantModel}/{@link computeCostUsd} unchanged — a
 * coverage file is priced exactly like a rated one.
 * @returns {Record<string, {tokens: {in,out,cacheRead,cacheWrite}, costUsd: number, knownCostFiles: number,
 *   unpricedFiles: number, fileCount: number}>}
 */
export function scanClaudeProjectsCoverage({ projectsRoot = defaultProjectsRoot(), sinceMs = null, orchestratorDirName = orchestratorProjectDirName() } = {}) {
  const buckets = {};
  for (const b of ['dispatched-daemon', 'orchestration-overhead', 'operator-interactive']) {
    buckets[b] = { tokens: zeroTokenBag(), costUsd: 0, knownCostFiles: 0, unpricedFiles: 0, fileCount: 0, unreadableFiles: 0 };
  }
  let dirEntries;
  try { dirEntries = readdirSync(projectsRoot, { withFileTypes: true }); } catch { return buckets; }
  for (const d of dirEntries) {
    if (!d.isDirectory()) continue;
    const bucket = d.name.includes('operations-dispatch') ? 'dispatched-daemon'
      : d.name === orchestratorDirName ? 'orchestration-overhead'
        : 'operator-interactive';
    const dirPath = join(projectsRoot, d.name);
    // Only the orchestrator dir is recursed (for its `<sessionId>/subagents/agent-*.jsonl`) — every OTHER
    // project dir's own jsonl files sit flat, one level, same as `findTranscriptPath` already assumes.
    const files = bucket === 'orchestration-overhead' ? listJsonlRecursive(dirPath) : listJsonlFlat(dirPath);
    for (const path of files) {
      if (sinceMs !== null) {
        try { if (statSync(path).mtimeMs < sinceMs) continue; } catch { continue; }
      }
      const lines = readTranscriptLines(path);
      if (!lines.length) { buckets[bucket].unreadableFiles += 1; continue; }
      // File MTIME only bounds WHICH FILES are read (a still-being-written file was "modified recently" even
      // if most of its content is old) — a long-lived orchestrator/interactive session can span weeks in one
      // file. Filter to turns whose OWN timestamp falls in the window too, so a file touched today doesn't
      // pull in tokens from three weeks ago; a turn with no parseable timestamp is kept (never silently
      // dropped for lacking one).
      const allTurns = extractTurns(lines);
      const turns = sinceMs === null ? allTurns : allTurns.filter((t) => t.ts === null || t.ts >= sinceMs);
      const sums = sumTokens(turns);
      const model = dominantModel(turns);
      const cost = computeCostUsd(sums, model);
      buckets[bucket].tokens = addTokenBag(buckets[bucket].tokens, { in: sums.in, out: sums.out, cacheRead: sums.cacheRead, cacheWrite: sums.cacheWrite5m + sums.cacheWrite1h });
      if (cost !== null) { buckets[bucket].costUsd += cost; buckets[bucket].knownCostFiles += 1; } else buckets[bucket].unpricedFiles += 1;
      buckets[bucket].fileCount += 1;
    }
  }
  return buckets;
}

function listJsonlFlat(dirPath) {
  let names;
  try { names = readdirSync(dirPath); } catch { return []; }
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(dirPath, n));
}

function listJsonlRecursive(dirPath, depth = 0) {
  if (depth > 3) return []; // bounded — this tree is at most `<session>/subagents/agent-*.jsonl` deep
  let entries;
  try { entries = readdirSync(dirPath, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const p = join(dirPath, e.name);
    if (e.isDirectory()) out.push(...listJsonlRecursive(p, depth + 1));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Read every `.operations/runs/review-pr-*.json` judge-panel run record modified since `sinceMs` and sum its
 * `telemetry[]` seats' usage, split by whether the seat's own `model` prices under `we:scripts/backlog/
 * cost-rates.mjs` (a Claude-family model — bucket `review-juror`, cost computed) or not (a Codex/antigravity
 * seat riding the SAME run record — bucket `non-claude-judge`, tokens only, `costUsd` stays `null`). Rows are
 * ATTRIBUTED — each run record's own `input.pr` names the PR — returned per-PR so a caller can fold them
 * straight into {@link rollupByDemand}'s `review` phase.
 * @returns {{claudeRows: object[], nonClaudeRows: object[]}}
 */
/** `~/workspace` (or `WE_WORKSPACE_ROOT` for tests) — the ONE definition of "every checkout this machine might
 *  have" that {@link scanReviewJurorUsage} and `we:scripts/conveyor/backfill-2026-09-27-run-rating-slice1.mjs`
 *  both resolve through (that backfill script mirrors this same formula inline; keep them identical). */
export function defaultWorkspaceRoot(env = process.env) {
  return env?.WE_WORKSPACE_ROOT || resolve(homedir(), 'workspace');
}

/** Every checkout under `workspaceRoot` that has its own `.operations/<subdir>` — the multi-clone reality
 *  `we:scripts/lib/constellation-repos.mjs` already documents: a daemon's run records / review-job logs live
 *  wherever THAT daemon's clone is, never only under one canonically-named directory. */
function listWorkspaceOperationsDirs(workspaceRoot, subdir) {
  let names;
  try { names = readdirSync(workspaceRoot, { withFileTypes: true }); } catch { return []; }
  return names
    .filter((d) => d.isDirectory())
    .map((d) => join(workspaceRoot, d.name, '.operations', subdir))
    .filter((p) => existsSync(p));
}

function readReviewRunsIn(runsDir, sinceMs) {
  let names;
  try { names = readdirSync(runsDir); } catch { return { claudeRows: [], nonClaudeRows: [] }; }
  const claudeRows = [];
  const nonClaudeRows = [];
  for (const name of names) {
    if (!name.startsWith('review-pr-') || !name.endsWith('.json')) continue;
    const path = join(runsDir, name);
    if (sinceMs !== null) {
      try { if (statSync(path).mtimeMs < sinceMs) continue; } catch { continue; }
    }
    let record;
    try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    const pr = record?.input?.pr ?? null;
    for (const seat of Array.isArray(record?.telemetry) ? record.telemetry : []) {
      const usage = seat?.usage ?? {};
      const tokens = {
        in: Number(usage.input_tokens) || 0, out: Number(usage.output_tokens) || 0,
        cacheRead: Number(usage.cache_read_input_tokens) || 0, cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
      };
      const priced = rateFor(seat?.model ?? '') !== null;
      const row = {
        pr, kind: 'review', dispatchKind: 'review', lens: seat?.lens ?? null, model: seat?.model ?? null,
        wallMs: Number.isFinite(seat?.durationMs) ? seat.durationMs : null,
        tokens, costUsd: priced ? (Number(seat?.costUsd) || 0) : null,
        dataQuality: priced ? 'juror-telemetry' : 'juror-telemetry-unpriced',
      };
      (priced ? claudeRows : nonClaudeRows).push(row);
    }
  }
  return { claudeRows, nonClaudeRows };
}

/**
 * Read every `.operations/runs/review-pr-*.json` judge-panel run record modified since `sinceMs`, ACROSS EVERY
 * checkout under `workspaceRoot` (not just one directory) — a review's run record lives in whichever daemon
 * clone actually ran it (same multi-clone reality `we:scripts/conveyor/backfill-2026-09-27-run-rating-slice1.mjs
 * #candidateReviewJobDirs` already accounts for; live-caught: a single-`runsDir` default here resolved to THIS
 * module's own checkout and silently found ~none of the real records on any other clone). `runsDirs` (an
 * explicit array) overrides the whole-workspace scan for a caller — namely `we:scripts/conveyor/run-rating.mjs`
 * unit tests — that wants one exact directory instead.
 * @returns {{claudeRows: object[], nonClaudeRows: object[]}}
 */
export function scanReviewJurorUsage({ runsDirs = null, workspaceRoot = defaultWorkspaceRoot(), sinceMs = null } = {}) {
  const dirs = runsDirs ?? listWorkspaceOperationsDirs(workspaceRoot, 'runs');
  const claudeRows = [];
  const nonClaudeRows = [];
  for (const dir of dirs) {
    const found = readReviewRunsIn(dir, sinceMs);
    claudeRows.push(...found.claudeRows);
    nonClaudeRows.push(...found.nonClaudeRows);
  }
  return { claudeRows, nonClaudeRows };
}

/**
 * Read every `~/.codex-judge-transcripts/*.jsonl` / `~/.antigravity-judge-transcripts/*.jsonl` file modified
 * since `sinceMs` and pull the LAST `type:'turn.completed'` line's `usage` — the durable per-seat record for a
 * non-Claude judge seat that isn't already folded into a run record's own `telemetry[]` (a defensive belt: if a
 * future caller stops writing seat usage into the run record, this still finds it). Tokens only, `costUsd`
 * always `null` — see this section's own header for why. NOT attributed to a PR (the transcript filename is
 * only a session id) — reported as its own `non-claude-judge` total, not folded into a demand.
 */
export function scanNonClaudeJudgeTranscripts({ home = homedir(), sinceMs = null } = {}) {
  const dirs = [join(home, '.codex-judge-transcripts'), join(home, '.antigravity-judge-transcripts')];
  let tokens = zeroTokenBag();
  let fileCount = 0;
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      if (sinceMs !== null) {
        try { if (statSync(path).mtimeMs < sinceMs) continue; } catch { continue; }
      }
      let text;
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      let usage = null;
      for (const raw of text.split('\n').reverse()) {
        const line = raw.trim();
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed?.type === 'turn.completed' && parsed?.usage) { usage = parsed.usage; break; }
      }
      if (!usage) continue;
      tokens = addTokenBag(tokens, {
        in: Number(usage.input_tokens) || 0, out: Number(usage.output_tokens) || 0,
        cacheRead: Number(usage.cached_input_tokens) || 0, cacheWrite: Number(usage.cache_write_input_tokens) || 0,
      });
      fileCount += 1;
    }
  }
  return { tokens, costUsd: null, fileCount };
}

/**
 * THE COVERAGE REPORT: every bucket's tokens/cost, plus a single coverage line — what fraction of the observed
 * total is ATTRIBUTED to a demand (`dispatched-daemon` + `review-juror`) vs `orchestration-overhead` vs
 * `operator-interactive` vs `non-claude-judge` (tokens known, not attributed to a PR). Never claims 100%: a
 * file that failed to parse counts in `unattributedTokens`, not silently dropped from the denominator.
 *
 * #4473 (x4txc2g) — `projectsRoot`/`runsDirs`/`workspaceRoot`/`home` are the SAME override params
 * {@link scanClaudeProjectsCoverage}/{@link scanReviewJurorUsage}/{@link scanNonClaudeJudgeTranscripts} already
 * accept, threaded through here so a caller (namely this file's own tests) can point every scan root at an
 * isolated directory instead of the real live host state (`~/.claude/projects`, every workspace checkout's
 * `.operations/runs`, `~/.codex-judge-transcripts`). Before this, `buildCoverageReport` hardcoded all three
 * scanners' defaults, so its OWN test could only ever read real, live, ambient host state — non-hermetic, and
 * observed to flake under real concurrent multi-lane load (a live file's mtime ticking past a captured
 * `Date.now()` mid-scan). Omitted (the default for every existing caller) ⇒ each scanner's own real default —
 * byte-for-byte the prior behavior; nothing changes for `we:scripts/conveyor/run-rating.mjs`'s own `main()` call
 * site, which never passes these.
 * @param {{sinceMs?: number|null, projectsRoot?: string, runsDirs?: string[]|null, workspaceRoot?: string,
 *   home?: string}} args
 */
export function buildCoverageReport({ sinceMs = null, projectsRoot, runsDirs, workspaceRoot, home } = {}) {
  const claudeBuckets = scanClaudeProjectsCoverage({ sinceMs, projectsRoot });
  const juror = scanReviewJurorUsage({ sinceMs, runsDirs, workspaceRoot });
  const nonClaudeJudge = scanNonClaudeJudgeTranscripts({ sinceMs, home });

  const jurorTokens = juror.claudeRows.reduce((s, r) => addTokenBag(s, r.tokens), zeroTokenBag());
  const jurorCost = juror.claudeRows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const nonClaudeJurorTokens = juror.nonClaudeRows.reduce((s, r) => addTokenBag(s, r.tokens), zeroTokenBag());

  const attributedTokens = tokenBagTotal(claudeBuckets['dispatched-daemon'].tokens) + tokenBagTotal(jurorTokens);
  const attributedCostUsd = claudeBuckets['dispatched-daemon'].costUsd + jurorCost;
  const overheadTokens = tokenBagTotal(claudeBuckets['orchestration-overhead'].tokens);
  const interactiveTokens = tokenBagTotal(claudeBuckets['operator-interactive'].tokens);
  const nonClaudeTokens = tokenBagTotal(nonClaudeJurorTokens) + tokenBagTotal(nonClaudeJudge.tokens);
  const unattributedFiles = claudeBuckets['dispatched-daemon'].unreadableFiles + claudeBuckets['orchestration-overhead'].unreadableFiles + claudeBuckets['operator-interactive'].unreadableFiles;

  const total = attributedTokens + overheadTokens + interactiveTokens + nonClaudeTokens;
  const pct = (n) => (total > 0 ? (n / total) * 100 : null);

  return {
    totalTokens: total,
    attributed: { tokens: attributedTokens, costUsd: attributedCostUsd, pct: pct(attributedTokens) },
    orchestrationOverhead: { tokens: overheadTokens, costUsd: claudeBuckets['orchestration-overhead'].costUsd, pct: pct(overheadTokens) },
    operatorInteractive: { tokens: interactiveTokens, costUsd: claudeBuckets['operator-interactive'].costUsd, pct: pct(interactiveTokens) },
    nonClaudeJudge: { tokens: nonClaudeTokens, costUsd: null, pct: pct(nonClaudeTokens) },
    unattributedFileCount: unattributedFiles,
    fileCounts: {
      dispatchedDaemon: claudeBuckets['dispatched-daemon'].fileCount,
      orchestrationOverhead: claudeBuckets['orchestration-overhead'].fileCount,
      operatorInteractive: claudeBuckets['operator-interactive'].fileCount,
      reviewJurorRuns: juror.claudeRows.length + juror.nonClaudeRows.length,
      nonClaudeJudgeTranscripts: nonClaudeJudge.fileCount,
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true;
  }
  return flags;
}

/** Our own rows in the shared scorecard store, optionally filtered to `scoredAt >= sinceMs`. */
export function ourRows(sinceMs = null) {
  const store = readStore();
  return store.records.filter((r) => r.rubricVersion === RUBRIC_VERSION && (sinceMs === null || Date.parse(r.scoredAt ?? '') >= sinceMs));
}

function resolveSince(flag) {
  if (!flag || flag === true) return null;
  const m = /^(\d+)([hd])$/.exec(String(flag).trim());
  if (m) return Date.now() - Number(m[1]) * (m[2] === 'h' ? 3600_000 : 86_400_000);
  const t = Date.parse(String(flag));
  return Number.isFinite(t) ? t : null;
}

/**
 * Every review row's EFFECTIVE grade for THIS report: unchanged for a non-review row, or a non-`pending`
 * review row; for a `pending` one, resolved against every OTHER review row for the same PR anywhere in the
 * store (not just the `--since` window — a contradicting later round can land after the window's own cutoff
 * for an EARLIER round still being reported). See {@link resolveReviewGrade}'s own doc.
 */
function effectiveGrade(row, allRowsByPr) {
  if (row.dispatchKind !== 'review' || !row.pr) return row.grade;
  const group = allRowsByPr.get(row.pr) ?? [];
  const later = group.filter((g) => Date.parse(g.scoredAt ?? '') > Date.parse(row.scoredAt ?? ''));
  return resolveReviewGrade(row, later);
}

function buildReport(sinceMs) {
  const rows = ourRows(sinceMs);
  const allRows = sinceMs === null ? rows : ourRows(null);
  const allRowsByPr = new Map();
  for (const r of allRows) {
    if (r.dispatchKind !== 'review' || !r.pr) continue;
    if (!allRowsByPr.has(r.pr)) allRowsByPr.set(r.pr, []);
    allRowsByPr.get(r.pr).push(r);
  }
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0, pending: 0 };
  for (const r of rows) {
    const g = effectiveGrade(r, allRowsByPr);
    if (gradeCounts[g] !== undefined) gradeCounts[g] += 1;
  }
  const waste = flagWaste(rows);
  const wasteByType = {};
  for (const w of waste) wasteByType[w.type] = (wasteByType[w.type] ?? 0) + 1;
  const demand = rollupByDemand(rows, { sizeForItem: backlogSizeForItem });
  const wasteByMinutes = topWasteCauses(rows, { by: 'minutes', limit: 5 });
  const wasteByTokens = topWasteCauses(rows, { by: 'tokens', limit: 5 });
  const coverage = buildCoverageReport({ sinceMs });
  const prepared = preparedComparison(rows);
  return { rowCount: rows.length, gradeCounts, wasteByType, wasteTotal: waste.length, demand, wasteByMinutes, wasteByTokens, coverage, prepared };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  if (cmd !== 'report') {
    process.stderr.write('usage: run-rating.mjs report [--since=<Nh|Nd|ISO>] [--json]\n');
    process.exitCode = 2;
    return;
  }
  const sinceMs = resolveSince(flags.since);
  const report = buildReport(sinceMs);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`run-rating report${sinceMs ? ` (since ${new Date(sinceMs).toISOString()})` : ''}\n`);
  process.stdout.write(`  rows scored: ${report.rowCount}\n`);
  process.stdout.write(`  grade distribution: A=${report.gradeCounts.A} B=${report.gradeCounts.B} C=${report.gradeCounts.C} D=${report.gradeCounts.D} pending=${report.gradeCounts.pending}\n`);
  process.stdout.write(`  waste flags: ${report.wasteTotal} (${Object.entries(report.wasteByType).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})\n`);
  process.stdout.write(`  top waste causes by minutes (guard blocks tracked separately by count: ${report.wasteByMinutes.guardBlockCount}):\n`);
  for (const w of report.wasteByMinutes.ranked) process.stdout.write(`    ${w.cause}: ${w.minutes.toFixed(1)} min across ${w.instances} instance(s)\n`);
  process.stdout.write('  top waste causes by tokens:\n');
  for (const w of report.wasteByTokens.ranked) process.stdout.write(`    ${w.cause}: ${Math.round(w.tokens)} tok across ${w.instances} instance(s)\n`);
  const c = report.coverage;
  process.stdout.write(`  coverage: ${c.totalTokens} tok observed fleet-wide — attributed ${c.attributed.pct?.toFixed(1) ?? 'n/a'}%, orchestration-overhead ${c.orchestrationOverhead.pct?.toFixed(1) ?? 'n/a'}%, operator/interactive ${c.operatorInteractive.pct?.toFixed(1) ?? 'n/a'}%, non-claude-judge ${c.nonClaudeJudge.pct?.toFixed(1) ?? 'n/a'}% (${c.unattributedFileCount} file(s) unreadable)\n`);
  process.stdout.write('  per-demand tokens:\n');
  for (const d of report.demand) {
    const sp = d.tokensPerStoryPoint !== null ? d.tokensPerStoryPoint.toFixed(0) : 'n/a';
    // NEVER print a bare total for a demand that couldn't be fully measured — that reads as "this cost
    // nothing", not "this was never measured" (the confirmed review finding this line exists to fix).
    const tokLabel = d.hasUnknownTokens ? `${d.totalTokens}+ tok (partial — ${d.unmeasuredSessions} unmeasured session(s))` : `${d.totalTokens} tok`;
    const costLabel = d.hasUnknownCost ? `$${d.totalCostUsd.toFixed(2)}+ (partial)` : `$${d.totalCostUsd.toFixed(2)}`;
    process.stdout.write(`    ${d.key}: ${tokLabel}, ${costLabel}, ${d.sessions} session(s), tokens/pt=${sp}\n`);
  }
  process.stdout.write('  prepared vs unprepared:\n');
  for (const [label, s] of [['prepared', report.prepared.prepared], ['unprepared', report.prepared.unprepared]]) {
    const wall = s.avgWallMs !== null ? `${(s.avgWallMs / 60_000).toFixed(1)} min` : 'n/a';
    const perDemand = s.tokensPerDemand !== null ? Math.round(s.tokensPerDemand) : 'n/a';
    const grades = `A=${s.gradeCounts.A} B=${s.gradeCounts.B} C=${s.gradeCounts.C} D=${s.gradeCounts.D}`;
    process.stdout.write(`    ${label}: n=${s.count}, avg wall=${wall}, tok/demand=${perDemand} (${s.demandCount} demand(s)), rework rounds=${s.reworkRounds}, grades ${grades}\n`);
  }
}

const isMain = (() => {
  try { return import.meta.url === `file://${process.argv[1]}`; } catch { return false; }
})();
if (isMain) main();
