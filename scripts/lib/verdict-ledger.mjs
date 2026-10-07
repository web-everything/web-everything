#!/usr/bin/env node
/**
 * @file scripts/lib/verdict-ledger.mjs
 * @description THE REVIEW-VERDICT LEDGER (#3007) — an append-only JSONL record of every review verdict, and
 *   the format's single owner. **PHASE 1 (this file): SHADOW.** The ledger is written alongside the labels and
 *   compared against them; the drain still merges on labels and NOTHING here is consulted by a merge gate.
 *   Phase 2 — the drain reading only the ledger — is deliberately unbuilt, and the checker
 *   ({@link compareLedgerToLabels}, driven by `we:scripts/review-ledger-check.mjs`) exists to produce the
 *   agreement evidence that decides whether Phase 2 is safe.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * THE KEY, AND WHY IT IS **NOT** THE CONTENT HASH THE CARD ASKED FOR
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * #3007 specifies records "keyed by PR + the diff content-hash the verdict covered (content-pinned per
 * #2979, so a mechanical rebase does not void it)". **That premise is false, and it was proven false twice
 * on 2026-08-09**, after the card was written:
 *
 *   • [#3046] — `normalizeContributionFingerprint` (`we:scripts/lib/review-escalation.mjs`) EMBEDDED each
 *     hunk's INTER-HUNK GAP, which is invariant only under a *uniform* whole-file displacement. A base that
 *     grew by different amounts above two hunks diverged the digest on a byte-identical contribution.
 *     Measured on WE PR #1106: 1,534 projection lines each side, differing in exactly two, both gap values.
 *   • `#3052` — git's `xfuncname` picks the nearest preceding column-0 declaration as the `@@` heading, so a
 *     base INSERTION of a new declaration changed the heading with zero content lines differing. Observed on
 *     WE PR #1100, whose clearance was revoked 52 seconds after it was granted.
 *
 * Both were slices of epic `#3054`, and **both are now FIXED** — `#3054` dropped every base-derived position
 * signal from the digest, so neither a non-uniform base move nor a base declaration-insertion diverges it any
 * more. THE KEY DOES NOT CHANGE, and the reason it does not is worth stating rather than leaving as inertia:
 *   • A ledger whose records were *found* by that digest would have inherited the divergence in the worst
 *     place — a legitimate clearance failing to match its own PR after an unrelated rebase leaves the record
 *     UNREACHABLE rather than merely mis-scored. That hazard is gone.
 *   • What is NOT gone, and is the reason this key stays where it is, is the OPPOSITE direction: [#3021],
 *     still open and deliberately WIDENED by `#3054`'s repair. Two different contributions collide whenever
 *     one is a relocation of the other — same files, same hunk lengths, same context-run shape, same `+`/`-`
 *     lines. A lookup key that two DIFFERENT verdicts can share is worse than one a rebase can break: the
 *     first silently returns the wrong record, the second merely fails to find one.
 * So the digest is a coverage WITNESS and never an identity, exactly as below.
 *
 * SO THE IDENTITY IS `repo` + `pr` + APPEND ORDER, and nothing else. Those three are defect-free by
 * construction. The three content witnesses (`coverage.headSha`, `coverage.reviewedDiff`,
 * `coverage.reviewedContribution`) are recorded VERBATIM as **attributes** of the record, never as the thing
 * a lookup joins on. Two properties fall out and both are the reason:
 *
 *   1. When `#3054` fixed the digest, the stored witnesses stayed RE-INTERPRETABLE with no schema change and
 *      no migration — the ledger stored the diff text's digests, not a conclusion drawn from them. Note what
 *      "re-interpretable" does and does not mean, now that the repair has actually happened: a witness is a
 *      HASH, so one written under the old projection cannot be recomputed under the new one and will never
 *      match again. It re-interprets by falling through — {@link ledgerCoversHead} says "not covered", the PR
 *      re-parks, and the next clearance re-stamps it. Fail-closed and self-healing; no record is lost, no
 *      migration is owed, and no stale witness is ever read as a match.
 *   2. "Which verdict is current?" (append order) and "does that verdict still cover this head?" (the
 *      witnesses) stay SEPARATE questions. The second one already has exactly one owner,
 *      `acceptanceCoversHead`; {@link ledgerCoversHead} delegates to it rather than growing a second,
 *      divergent staleness rule here. A second staleness rule is the defect this whole item exists to stop.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE THE FILE LIVES — MACHINE-GLOBAL, AND THE CARD IS WRONG ABOUT THIS TOO
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * #3007 says "next to the drain's existing history", which reads as the per-checkout `.conveyor/` sidecar
 * convention `we:scripts/lib/jury-ledger.mjs` uses. **That cannot work for a merge authority.** The writers
 * and the eventual reader run in DIFFERENT CHECKOUTS on one machine: a `/review` runs from a lane clone, the
 * operation runs from wherever it was invoked, and the resident drain runs from its own dedicated clone —
 * whose per-checkout log `we:scripts/converge-daemon-pass.mjs` already documents as "its own EMPTY log". A
 * per-clone ledger would have the drain merging against a file no reviewer ever wrote to.
 *
 * So the home is HOME-anchored ({@link verdictLedgerDir}), for the identical reason
 * `we:scripts/readiness/drain-lock.mjs` gives for `DRAIN_LOCK_ROOT`: *"the contenders run in DIFFERENT
 * checkouts … otherwise two checkouts would never see each other's lock."* Local-only and machine-disposable
 * like every other lock/lease home here; it never lands on `main`. ONE file per repo (not per PR) so append
 * order is global and the single-writer question is one lock rather than N.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * SINGLE WRITER — THE CARD'S PREMISE DOES NOT HOLD, SO THIS TAKES A LOCK
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * #3007: *"the drain lease already guarantees a single writer"*. It does not, for this file. The drain lease
 * (`DRAIN_LEASE_PATH`) serializes DRAIN RUNS against each other. Every writer that now appends here reaches
 * the ledger through `we:scripts/review-set-label.mjs`, and NONE of its callers holds that lease: the
 * operator's `/review` ceremony from an arbitrary session, the declared `review-pr` operation (#3035), the
 * loop console, and the conveyor's `we:scripts/conveyor/rearm-review.mjs`. Two of those can run at once in
 * two checkouts.
 *
 * {@link appendVerdict} therefore serializes on its own short-TTL lock, built on the same atomic
 * `O_EXCL`-dir + TTL-lease primitive (`we:scripts/readiness/file-locks.mjs`) the drain locks use — never a
 * fork of it — in a machine-global root so two checkouts contend on the SAME lock. A blocked or expired
 * acquisition does NOT drop the record: the append proceeds unlocked and the record is stamped
 * `unlocked: true`, because a lost verdict is strictly worse than an interleaved line, and every line is a
 * single `appendFileSync` of one newline-terminated JSON string opened `O_APPEND`. The flag makes the
 * weaker case legible instead of silent.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * PURE-CORE / IO-SHELL SPLIT (mirrors `jury-ledger.mjs`)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * The schema, the builders, the validator, the fold, {@link compareLedgerToLabels} and
 * {@link labelVerdictOf} are PURE (no fs, no clock — every timestamp is injected) and unit-tested in
 * `__tests__/verdict-ledger.test.mjs`. The fs touches exactly three functions at the bottom, plus the CLI.
 * Reads NEVER throw: a blank, unparseable or schema-invalid line is skipped, mirroring `parseJuryLog`.
 */

import { isUnderTest } from './under-test.mjs';
import { appendFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';

import { REVIEW_LABELS, hasReviewLabel, acceptanceCoversHead } from './review-escalation.mjs';
import { reserve, releaseLockDir } from '../readiness/file-locks.mjs';
import { writeAllSync } from './write-all-sync.mjs';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The schema version every record carries. Bump ONLY on a breaking field change; readers keep handling
 *  older versions (a ledger is append-only, so v1 rows live forever beside v2 rows). */
export const VERDICT_LEDGER_VERSION = 1;

/** The record kind, so a ledger file is self-describing if it is ever moved next to another JSONL stream. */
export const VERDICT_LEDGER_KIND = 'we.review-verdict';

/**
 * THE CLOSED VERDICT SET. Each member is a review DISPOSITION, and the set is deliberately the union of what
 * `REVIEW_LABEL_TARGETS` (`we:scripts/review-set-label.mjs`) can write and the two hold labels the drain
 * parks under — so a Phase-2 gate reading this ledger can express every state a label can express, and the
 * Phase-1 checker can compare like with like. Adding a label without adding a member here is what makes a
 * ledger silently narrower than the thing it is meant to replace.
 *
 * SINCE #3329 THE SET IS NO LONGER TOTAL OVER {CLEARS, HOLDS}. Five members are DISPOSITIONS — each clears the
 * merge or holds it. `OBSERVED` is neither: it is NON-BEARING, a row recording THAT a review happened. See
 * {@link NON_BEARING}.
 */
export const VERDICTS = Object.freeze({
  ACCEPTED: 'accepted',         // the reviewer accepted → clears
  CHANGES: 'changes',           // the reviewer bounced → holds
  PENDING: 'pending',           // parked, awaiting an independent review → holds
  HUMAN: 'human',               // gate-self: only a human may clear → holds
  CLEAR_HUMAN: 'clear-human',   // the #2895 human ceremony lifted a `human` hold → clears
  // #x5e2ldj — an existing acceptance CARRIED across a head the drain's own rebase moved. It CLEARS, because
  // the PR was already cleared and nothing about the contribution changed; the row exists so the ledger holds
  // a witness at the new head rather than a marker nobody can reproduce. It is deliberately NOT `ACCEPTED`:
  // no review was run, and a reader counting acceptances must not count this as one.
  RESTAMPED: 'restamped',       // acceptance re-witnessed after a drain-authored rebase → clears
  // #3329 — A REVIEW HAPPENED. Nothing follows from it. It neither clears nor holds; see NON_BEARING.
  OBSERVED: 'observed',         // a review was run and recorded → bears on NOTHING
});

/** Verdicts in the closed set, as an array. */
export const VERDICT_VALUES = Object.freeze(Object.values(VERDICTS));

/** The three verdicts that CLEAR. Every other BEARING member of the closed set is a HOLD. A hold is only ever
 *  ended by a LATER clearing record — never by removing a row, which this format makes impossible anyway. */
const CLEARING = new Set([VERDICTS.ACCEPTED, VERDICTS.CLEAR_HUMAN, VERDICTS.RESTAMPED]);

/**
 * THE NON-BEARING MEMBERS (#3329). A non-bearing row is written into `history` and is INVISIBLE to every
 * question the ledger answers about whether a PR may land: it never becomes `current`, it never sets `clears`,
 * and it is never an outstanding hold.
 *
 * WHY A THIRD CATEGORY RATHER THAN A SIXTH DISPOSITION. Two situations on 2026-08-26 had a review that
 * genuinely ran and no honest verdict to record: one produced findings and recorded NOTHING (zero rows, label
 * unchanged — the findings survived only by being hand-carried between sessions), and one passed with zero
 * findings and had `changes` recorded on it with no reason, which #3334 now refuses. Neither existing value
 * fits. `accepted` is a lie AND a measurement bug — nothing was accepted, and a reader counting acceptances
 * would count it, the exact miscount `RESTAMPED` was added to prevent. `changes` HOLDS, and holding the merge
 * is precisely what an advisory look must not do.
 *
 * ENFORCED, NOT INTENDED — the enforcement point is {@link foldVerdictLedger}, which states the fold bug that
 * "non-clearing" alone would have shipped. What it costs: a PR whose ONLY rows are `observed` folds to
 * `current: null`, the same shape as a PR with no record, because that is the truth about its DISPOSITION.
 * Its `history` is not empty, and that is where "a review happened" is read back from.
 *
 * AN ARRAY, NOT AN EXPORTED SET, and not cosmetically: `Object.freeze` on a `Set` leaves the internal slots
 * writable, so an exported frozen Set still answers `.add('accepted')` — a public handle for making a CLEARING
 * verdict non-bearing. Membership goes through the private `NON_BEARING_SET`; the export is truly immutable.
 * No `BEARING_VERDICTS` companion: that subset is `VERDICT_VALUES` minus this list, and a third constant
 * nothing here uses is precisely what the #2967 test-only-export scan flags.
 */
export const NON_BEARING = Object.freeze([VERDICTS.OBSERVED]);

const NON_BEARING_SET = new Set(NON_BEARING);

/**
 * Does this verdict bear on whether the PR may land? Pure.
 *
 * FAIL-CLOSED IN THE OPPOSITE DIRECTION TO {@link verdictClears}. Only an EXPLICITLY enrolled member is
 * non-bearing; anything else — an unknown word included — BEARS, and a row that bears without clearing is a
 * hold. So a typo'd verdict holds the merge instead of silently vanishing from the disposition.
 */
export function verdictBears(verdict) {
  return !NON_BEARING_SET.has(String(verdict ?? ''));
}

/** Does this verdict clear the PR for merge? Pure. An unknown verdict is NOT clearing (fail closed), and
 *  neither is a non-bearing one — `observed` is not in `CLEARING` and must never be added to it. */
export function verdictClears(verdict) {
  return CLEARING.has(String(verdict ?? ''));
}

/**
 * THE VERDICT A LABEL-SWAP TARGET IMPLIES. Pure, total over `REVIEW_LABEL_TARGETS`
 * (`we:scripts/review-set-label.mjs`), and the INVERSE direction of {@link verdictLabel}.
 *
 * ONE HOME, TWO CALLERS, AND THAT IS THE WHOLE POINT. The single home of a label swap (`runReviewLabelCli`)
 * derives the row's verdict from `--to`; the declared operation's reconciling sink
 * (`we:scripts/operations/review-pr-io.mjs`) must derive the SAME verdict from the SAME `to` in order to ask
 * "is the row that exists this round's row?". Two copies of this ternary is what makes that comparison
 * unsound: if the reconciler and the writer disagree about what `to` means, the reconciler either appends a
 * second row for a verdict already recorded, or silently accepts a row for a different one. It lives here,
 * beside {@link VERDICTS}, rather than in `review-set-label.mjs`, because that module already imports this
 * one and the reverse edge would be a cycle.
 *
 * `rearm` is `pending`: the conveyor's re-arm swaps `review:changes` → `review:pending`, which is a HOLD
 * awaiting an independent review, not a verdict on the contribution. An unrecognized target is `null` —
 *
 * **NO `observed` CASE (#3329), AND THE ABSENCE IS THE FEATURE.** `observed` mirrors no label, so there is no
 * `--to=observed` swap to derive it from; its producer writes the row directly. Because this function is the
 * ONLY way a label target becomes a ledger verdict and it fails closed, an invented `--to=observed` yields
 * `null` and both the writer and the reconciling sink REFUSE — a label-shaped path to a label-less verdict
 * stays impossible.
 *
 * fail closed, never a guessed disposition, because the recorded verdict is the thing a Phase-2 gate will
 * merge on and a wrong one is worse than an absent one.
 *
 * @param {string} to - a member of `REVIEW_LABEL_TARGETS`.
 * @returns {string|null} the {@link VERDICTS} member, or `null` when `to` is not a known target.
 */
export function verdictForLabelTarget(to) {
  switch (String(to ?? '')) {
    case 'accepted': return VERDICTS.ACCEPTED;
    case 'changes': return VERDICTS.CHANGES;
    case 'clear-human': return VERDICTS.CLEAR_HUMAN;
    case 'rearm': return VERDICTS.PENDING;
    case 'restamp': return VERDICTS.RESTAMPED;
    default: return null;
  }
}

/**
 * The label a verdict MIRRORS. Pure, total over {@link VERDICTS}. This is the projection the Phase-1 checker
 * compares against the PR's live labels — and it is the ONLY place the ledger↔label mapping is written down,
 * so the writer and the checker cannot disagree about what "mirroring" means.
 * `clear-human` maps to `review:accepted` because that is exactly what `decideSetLabel`'s `clear-human`
 * branch applies (it adds `review:accepted` and drops `review:human`).
 *
 * TOTAL OVER THE **BEARING** SET ONLY (#3329). `observed` returns `null` by CONSTRUCTION, not by omission —
 * hence the explicit arm rather than a fallthrough. Every review label either clears the merge or holds it;
 * there is no label meaning "looked at, nothing follows", and inventing one is what would turn `observed`
 * into a soft accept.
 */
export function verdictLabel(verdict) {
  switch (String(verdict ?? '')) {
    case VERDICTS.ACCEPTED:
    case VERDICTS.CLEAR_HUMAN:
    case VERDICTS.RESTAMPED:
      return REVIEW_LABELS.accepted;
    case VERDICTS.CHANGES: return REVIEW_LABELS.changes;
    case VERDICTS.HUMAN: return REVIEW_LABELS.human;
    case VERDICTS.PENDING: return REVIEW_LABELS.pending;
    // #3329 — EXPLICIT, not a fallthrough. A non-bearing row mirrors no label; see the doc above.
    case VERDICTS.OBSERVED: return null;
    default: return null;
  }
}

/**
 * WHAT THE `actor` BLOCK CAN AND CANNOT PROVE. Stated in the schema itself, not in a doc somewhere, because
 * the single failure mode of a "reviewer identity" field is a reader trusting it further than it earns.
 *
 * IT CAN PROVE:
 *   • `session` — the harness session id (`CLAUDE_CODE_SESSION_ID`, via `currentActorId`) of the PROCESS that
 *     appended the row. Two rows with different session ids were written by different sessions.
 *   • `channel` / `source` — which code path produced the row, i.e. that the SANCTIONED tool wrote it rather
 *     than a raw `gh` call. That is the whole of `proves: 'sanctioned-path'`.
 *   • `independence` — the machine-checked `decideClearerIndependence` outcome at write time
 *     (`we:scripts/lib/review-independence.mjs`): whether the clearing session differs from the session
 *     stamped on the PR body as its author.
 *
 * IT CANNOT PROVE — and no field here should ever be read as proving:
 *   • THAT A HUMAN DID THIS. Nothing in this repo distinguishes the operator from an agent: everything runs
 *     under one token and one session id. That is [#2946] (`tier: someday`), whose WebAuthn gesture is the
 *     only mechanism that would change this answer. Until it lands, `human` here means "the human-ceremony
 *     CODE PATH", never "a human".
 *   • THE OPERATOR vs A SUBAGENT. A subagent inherits its parent's `CLAUDE_CODE_SESSION_ID`, so
 *     `independence: 'self-clear'` on a `clear-human` row is the ORDINARY operator workflow, not an alarm —
 *     see the exemption argued in `we:scripts/review-set-label.mjs`.
 *   • THAT `declared` NAMED A REAL PERSON, OR THAT THEY AUTHORISED IT. `declared` is the free-text `--actor`.
 *     #2895's honesty tax means misuse takes a written lie rather than a silence; it is not a check.
 *
 * ONE THING THE LEDGER *DOES* IMPROVE ON THE COMMENT TRAIL, and it is worth stating because it is the reason
 * the identity is captured here rather than parsed back later: this row is written from the WRITING PROCESS's
 * own `currentActorId()` at the moment of the write. It is never recovered by parsing a PR comment. The
 * comment trail is forgeable — `CLEARED_HUMAN_PROSE_RE` (`we:scripts/lib/review-escalation.mjs`) matches a
 * literal prose sentence with no HTML-comment syntax, so `neutralizeCommentMarkers` does not touch it and a
 * `--body-file` on an ordinary `changes` verdict makes `parseOperatorClearance` report a clearance that never
 * happened (reproduced against the live code on 2026-08-10; non-gating today, filed separately). A ledger row
 * cannot be forged that way because nothing here reads a comment.
 */
export const ACTOR_PROVES = 'sanctioned-path';

/**
 * @typedef {Object} VerdictRecord
 * @property {number} v - {@link VERDICT_LEDGER_VERSION}.
 * @property {string} kind - {@link VERDICT_LEDGER_KIND}.
 * @property {string} at - ISO-8601 write time (INJECTED — the pure builder never reads a clock).
 * @property {string} repo - `<owner>/<name>`.
 * @property {number} pr - the PR number.
 * @property {string} verdict - a {@link VERDICTS} member.
 * @property {boolean} clears - {@link verdictClears}, denormalized so a reader needs no second import.
 * @property {string} reason - why. The decider's `reason`, or the operator's quoted `--reason`.
 * @property {{headSha: string|null, reviewedDiff: string|null, reviewedContribution: string|null}} coverage -
 *   the CONTENT WITNESSES. Attributes, never the key — see the file header.
 * @property {{declared: string, session: string, channel: string, independence: string|null, proves: string}} actor -
 *   see {@link ACTOR_PROVES} for exactly what this block does and does not establish.
 * @property {string} source - which writer appended this row.
 * @property {string} writer - `host:pid:kind`, the appending process.
 * @property {boolean} [unlocked] - present and `true` only when the append could not take the writer lock.
 * @property {'shadow'} [mode] - a prediction, permitted ONLY on non-bearing `observed` rows.
 * @property {boolean} [wouldClear] - the shadow intent; never a disposition. Shadow rows also carry
 *   `applied: false` and `mutated: false`.
 */

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Normalize a witness to a lowercase digest string, or `null`. A malformed witness becomes `null` rather
 *  than failing the record: losing a witness costs a fail-closed coverage test later, losing the whole row
 *  costs the verdict. */
function digestOrNull(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return DIGEST_RE.test(s) ? s : null;
}

/** Same, for a git SHA (7–40 hex, as `buildReviewedShaMarker` accepts). */
function shaOrNull(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return SHA_RE.test(s) ? s : null;
}

/** Collapse free text to one line and cap it. A ledger line must stay small enough that a single
 *  `appendFileSync` is one write; an operator `--reason` and a decider reason are the only unbounded inputs. */
function oneLine(value, max = 500) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Build a schema-valid {@link VerdictRecord}. PURE — `at` is injected, never read from the wall clock, so the
 * builder is deterministic under test. THROWS on a shape a caller got wrong (a programming error, pinned by
 * tests); a record that reaches the file is validated again on the way in and on the way out.
 *
 * DELIBERATELY NOT RECORDED: the findings text. The jury ledger (`we:scripts/lib/jury-ledger.mjs`) already
 * owns findings, and duplicating them here would both fork that store and make a line big enough that the
 * single-write append stops being one write. `findingCount` is kept because it is one integer.
 *
 * @param {{repo: string, pr: number|string, verdict: string, at: string, reason?: string,
 *   headSha?: string|null, reviewedDiff?: string|null, reviewedContribution?: string|null,
 *   declaredActor?: string, session?: string, channel?: string, independence?: string|null,
 *   source: string, writer?: string, findingCount?: number|null, mode?: 'shadow', wouldClear?: boolean}} o
 * @returns {VerdictRecord}
 */
export function buildVerdictRecord({
  repo, pr, verdict, at, reason = '',
  headSha = null, reviewedDiff = null, reviewedContribution = null,
  declaredActor = '', session = '', channel = '', independence = null,
  source, writer = '', findingCount = null, mode, wouldClear,
} = {}) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw new TypeError(`verdict-ledger: \`repo\` must be <owner/name>, got ${JSON.stringify(repo)}`);
  }
  const n = Number(pr);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(`verdict-ledger: \`pr\` must be a positive integer, got ${JSON.stringify(pr)}`);
  }
  if (!VERDICT_VALUES.includes(verdict)) {
    throw new TypeError(
      `verdict-ledger: unknown verdict ${JSON.stringify(verdict)} — expected one of ${VERDICT_VALUES.join(', ')}`,
    );
  }
  if (typeof at !== 'string' || !ISO_RE.test(at)) {
    throw new TypeError(`verdict-ledger: \`at\` must be an ISO-8601 UTC timestamp, got ${JSON.stringify(at)}`);
  }
  if (typeof source !== 'string' || !source.trim()) {
    throw new TypeError('verdict-ledger: `source` is required — a row must name the writer that produced it');
  }
  const record = {
    v: VERDICT_LEDGER_VERSION,
    kind: VERDICT_LEDGER_KIND,
    at,
    repo,
    pr: n,
    verdict,
    clears: verdictClears(verdict),
    reason: oneLine(reason),
    coverage: {
      headSha: shaOrNull(headSha),
      reviewedDiff: digestOrNull(reviewedDiff),
      reviewedContribution: digestOrNull(reviewedContribution),
    },
    actor: {
      declared: oneLine(declaredActor, 200),
      session: oneLine(session, 200),
      channel: oneLine(channel, 200),
      independence: independence == null ? null : oneLine(independence, 64),
      // A CONSTANT, on every row, on purpose. The claim this record makes about identity is fixed and small,
      // and writing it into every row is what stops a later reader inferring a bigger one. See ACTOR_PROVES.
      proves: ACTOR_PROVES,
    },
    source: oneLine(source, 64),
    writer: oneLine(writer || processWriterId(), 128),
  };
  if (Number.isInteger(findingCount) && findingCount >= 0) record.findingCount = findingCount;
  if (mode !== undefined || wouldClear !== undefined) {
    if (mode !== 'shadow' || verdict !== VERDICTS.OBSERVED || typeof wouldClear !== 'boolean') {
      throw new TypeError('verdict-ledger: shadow predictions require observed, mode: shadow and boolean wouldClear');
    }
    Object.assign(record, { mode, wouldClear, applied: false, mutated: false });
  }
  return record;
}

/**
 * Validate + normalize a raw parsed line. NEVER throws — mirrors `validateJuryEvent`'s contract, so one bad
 * line can never crash a reader. Returns `{ valid, errors, record }`.
 * @param {*} raw
 * @returns {{valid: boolean, errors: string[], record: VerdictRecord|null}}
 */
export function validateVerdictRecord(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['not an object'], record: null };
  }
  if (!Number.isInteger(raw.v) || raw.v < 1) errors.push(`bad \`v\`: ${JSON.stringify(raw.v)}`);
  if (raw.kind !== VERDICT_LEDGER_KIND) errors.push(`bad \`kind\`: ${JSON.stringify(raw.kind)}`);
  if (typeof raw.repo !== 'string' || !REPO_RE.test(raw.repo)) errors.push(`bad \`repo\`: ${JSON.stringify(raw.repo)}`);
  if (!Number.isInteger(raw.pr) || raw.pr <= 0) errors.push(`bad \`pr\`: ${JSON.stringify(raw.pr)}`);
  if (raw.type !== undefined && raw.type !== 'verdict') errors.push(`not a verdict row: type ${JSON.stringify(raw.type)}`);
  if (!VERDICT_VALUES.includes(raw.verdict)) errors.push(`bad \`verdict\`: ${JSON.stringify(raw.verdict)}`);
  if (typeof raw.at !== 'string' || !ISO_RE.test(raw.at)) errors.push(`bad \`at\`: ${JSON.stringify(raw.at)}`);
  const shadow = raw.mode !== undefined || raw.wouldClear !== undefined;
  if (shadow && (raw.mode !== 'shadow' || raw.verdict !== VERDICTS.OBSERVED
    || typeof raw.wouldClear !== 'boolean' || raw.applied !== false || raw.mutated !== false)) {
    errors.push('shadow predictions must be observed, with boolean wouldClear, applied: false and mutated: false');
  }
  if (errors.length) return { valid: false, errors, record: null };

  const coverage = raw.coverage && typeof raw.coverage === 'object' ? raw.coverage : {};
  const actor = raw.actor && typeof raw.actor === 'object' ? raw.actor : {};
  const record = {
    v: raw.v,
    kind: VERDICT_LEDGER_KIND,
    at: raw.at,
    repo: raw.repo,
    pr: raw.pr,
    verdict: raw.verdict,
    // DERIVED ON READ, never trusted from the line. `clears` is denormalized for convenience; a hand-edited
    // or forged row must not be able to say "changes, but it clears".
    clears: verdictClears(raw.verdict),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    coverage: {
      headSha: shaOrNull(coverage.headSha),
      reviewedDiff: digestOrNull(coverage.reviewedDiff),
      reviewedContribution: digestOrNull(coverage.reviewedContribution),
    },
    actor: {
      declared: typeof actor.declared === 'string' ? actor.declared : '',
      session: typeof actor.session === 'string' ? actor.session : '',
      channel: typeof actor.channel === 'string' ? actor.channel : '',
      independence: typeof actor.independence === 'string' ? actor.independence : null,
      proves: ACTOR_PROVES,
    },
    source: typeof raw.source === 'string' ? raw.source : '',
    writer: typeof raw.writer === 'string' ? raw.writer : '',
  };
  if (Number.isInteger(raw.findingCount) && raw.findingCount >= 0) record.findingCount = raw.findingCount;
  if (raw.unlocked === true) record.unlocked = true;
  if (shadow) Object.assign(record, { mode: 'shadow', wouldClear: raw.wouldClear, applied: false, mutated: false });
  return { valid: true, errors: [], record };
}

/**
 * Serialize ONE record to a JSONL line, validating first. PURE. `ok:false` means NOTHING should be written.
 * @param {*} raw
 * @returns {{ok: boolean, line: string|null, record: VerdictRecord|null, errors: string[]}}
 */
export function serializeVerdictRecord(raw) {
  const { valid, errors, record } = validateVerdictRecord(raw);
  if (!valid) return { ok: false, line: null, record: null, errors };
  // Serialize the RAW object (so a writer-only field such as `unlocked` survives), but only after the
  // normalized copy has proved the shape is sound.
  return { ok: true, line: JSON.stringify({ ...raw, clears: record.clears }), record, errors: [] };
}

/**
 * Parse a ledger's TEXT into normalized records. PURE + tolerant: a blank, unparseable or schema-invalid line
 * is SKIPPED, never thrown on, so a partially-written or hand-mangled file still folds to whatever is valid.
 * Append order is preserved and IS the ordering — `at` is informational.
 * @param {string} text
 * @returns {VerdictRecord[]}
 */
export function parseVerdictLog(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const { valid, record } = validateVerdictRecord(parsed);
    if (valid) out.push(record);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// V2 EVENT TYPES (#verdict-ledger-pr-state-store, plan slice B) — SCHEMA ONLY. PURE.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The schema version a non-verdict event carries. A verdict row keeps `VERDICT_LEDGER_VERSION` so v1 bytes
 *  never change; a v1 row reads as `type: verdict`. */
export const LEDGER_EVENT_VERSION = 2;

/** THE CLOSED SET OF EVENT TYPES (plan section 3.1). One append-only stream per repo; identity stays
 *  repo + PR + append order. Transitions are NOT a type: they are derived from these events plus GitHub facts. */
export const EVENT_TYPES = Object.freeze({
  VERDICT: 'verdict',       // the v1 row, unchanged
  REFERRAL: 'referral',     // findings opened on a head, with finding keys
  RULING: 'ruling',         // a ruling on one finding key
  REVIEW_RUN: 'review-run', // a review run on a head (counts visits; bears on nothing else)
  HOLD: 'hold',             // a hold with a reason code
  RELEASE: 'release',       // a release of a hold
  APPROVAL: 'approval',     // a clearing ceremony or judge, optionally delegated
  SEND_BACK: 'send-back',   // the PR goes back to its author
  AUTHOR: 'author',         // who opened the PR
  LABEL_INPUT: 'label-input', // a hand-applied label seen by the mirror
});

/** Every event type, as an array. */
export const EVENT_TYPE_VALUES = Object.freeze(Object.values(EVENT_TYPES));

export const RULING_VALUES = Object.freeze(['block', 'card', 'not-real']);
export const REVIEW_RUN_PHASES = Object.freeze(['started', 'completed']);
export const APPROVAL_KINDS = Object.freeze(['clear-human', 'clear-operator', 'judge']);
export const SEND_BACK_CAUSES = Object.freeze(['block-ruling', 'changes']);
export const LABEL_INPUT_CHANGES = Object.freeze(['added', 'removed']);

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const oneOf = (list) => (v) => list.includes(v);

/** Per-type payload fields: `[name, check, normalize]`. A required field that fails its check invalidates the
 *  event; an optional one (`opt`) is dropped when absent and invalidates when present and wrong. */
function delegationOrNull(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v) || !isStr(v.by) || !isStr(v.scope)
    || typeof v.expires !== 'string' || !ISO_RE.test(v.expires)) return undefined;
  return { by: oneLine(v.by, 200), scope: oneLine(v.scope, 200), expires: v.expires };
}

const EVENT_PAYLOAD = Object.freeze({
  [EVENT_TYPES.REFERRAL]: [
    ['headSha', (v) => shaOrNull(v) !== null, shaOrNull],
    ['findingKeys', (v) => Array.isArray(v) && v.length > 0 && v.every(isStr), (v) => v.map((k) => oneLine(k, 200))],
  ],
  [EVENT_TYPES.RULING]: [
    ['findingKey', isStr, (v) => oneLine(v, 200)],
    ['ruling', oneOf(RULING_VALUES), (v) => v],
  ],
  [EVENT_TYPES.REVIEW_RUN]: [
    ['headSha', (v) => shaOrNull(v) !== null, shaOrNull],
    ['phase', oneOf(REVIEW_RUN_PHASES), (v) => v],
    ['posted', (v) => v === null || typeof v === 'boolean', (v) => v],
  ],
  [EVENT_TYPES.HOLD]: [
    ['reasonCode', isStr, (v) => oneLine(v, 128)],
    ['holdSource', isStr, (v) => oneLine(v, 64)],
  ],
  [EVENT_TYPES.RELEASE]: [
    ['reasonCode', isStr, (v) => oneLine(v, 128)],
    ['holdSource', isStr, (v) => oneLine(v, 64)],
  ],
  [EVENT_TYPES.APPROVAL]: [
    ['approval', oneOf(APPROVAL_KINDS), (v) => v],
    ['delegation', (v) => delegationOrNull(v) !== undefined, delegationOrNull],
  ],
  [EVENT_TYPES.SEND_BACK]: [
    ['cause', oneOf(SEND_BACK_CAUSES), (v) => v],
  ],
  [EVENT_TYPES.AUTHOR]: [
    ['author', isStr, (v) => oneLine(v, 200)],
  ],
  [EVENT_TYPES.LABEL_INPUT]: [
    ['label', isStr, (v) => oneLine(v, 128)],
    ['sender', isStr, (v) => oneLine(v, 200)],
    ['change', oneOf(LABEL_INPUT_CHANGES), (v) => v],
  ],
});

/** Missing optional payload fields take these defaults on build, so a field written as absent still round-trips. */
const EVENT_DEFAULTS = Object.freeze({ posted: null, delegation: null });

/** Which event types BEAR on whether a PR may land (plan 3.1). `review-run` bears on caps only; the others that
 *  bear do so through the derive function, which is a later slice. Pure. */
export function eventBears(type) {
  return [EVENT_TYPES.VERDICT, EVENT_TYPES.REFERRAL, EVENT_TYPES.RULING, EVENT_TYPES.HOLD, EVENT_TYPES.RELEASE,
    EVENT_TYPES.APPROVAL, EVENT_TYPES.SEND_BACK].includes(String(type ?? ''));
}

/**
 * Build a schema-valid NON-VERDICT event. PURE (`at` injected). THROWS on a programming error, like
 * {@link buildVerdictRecord}. A verdict is built with `buildVerdictRecord`, never here.
 * @param {{type: string, repo: string, pr: number|string, at: string, source: string, writer?: string,
 *   declaredActor?: string, session?: string, channel?: string, headSha?: string|null}} o plus the type's payload.
 */
export function buildLedgerEvent({
  type, repo, pr, at, source, writer = '', declaredActor = '', session = '', channel = '', ...payload
} = {}) {
  if (type === EVENT_TYPES.VERDICT) {
    throw new TypeError('verdict-ledger: build a verdict row with buildVerdictRecord, not buildLedgerEvent');
  }
  const spec = EVENT_PAYLOAD[type];
  if (!spec) {
    throw new TypeError(`verdict-ledger: unknown event type ${JSON.stringify(type)} — expected one of ${EVENT_TYPE_VALUES.join(', ')}`);
  }
  const candidate = {
    v: LEDGER_EVENT_VERSION,
    kind: VERDICT_LEDGER_KIND,
    type,
    at,
    repo,
    pr: Number(pr),
    ...Object.fromEntries(spec.map(([name]) => [name, payload[name] === undefined ? EVENT_DEFAULTS[name] : payload[name]])),
    actor: { declared: declaredActor, session, channel, independence: null },
    source,
    writer: writer || processWriterId(),
  };
  const { valid, errors, record } = validateLedgerEvent(candidate);
  if (!valid) throw new TypeError(`verdict-ledger: invalid ${type} event — ${errors.join('; ')}`);
  return record;
}

/**
 * Validate + normalize a raw parsed line of ANY type. NEVER throws. A row with no `type`, or `type: verdict`,
 * is a verdict row and goes through {@link validateVerdictRecord} untouched (returned with `type: 'verdict'`
 * added to a COPY). Every other type is checked against its payload; `clears` is never stored on a non-verdict
 * event, because only a verdict row clears.
 * @param {*} raw
 * @returns {{valid: boolean, errors: string[], record: object|null}}
 */
export function validateLedgerEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['not an object'], record: null };
  }
  if (raw.type === undefined || raw.type === EVENT_TYPES.VERDICT) {
    const { valid, errors, record } = validateVerdictRecord(raw);
    return valid ? { valid, errors, record: { type: EVENT_TYPES.VERDICT, ...record } } : { valid, errors, record: null };
  }
  const spec = EVENT_PAYLOAD[raw.type];
  if (!spec) return { valid: false, errors: [`bad \`type\`: ${JSON.stringify(raw.type)}`], record: null };
  const errors = [];
  if (!Number.isInteger(raw.v) || raw.v < LEDGER_EVENT_VERSION) errors.push(`bad \`v\`: ${JSON.stringify(raw.v)}`);
  if (raw.kind !== VERDICT_LEDGER_KIND) errors.push(`bad \`kind\`: ${JSON.stringify(raw.kind)}`);
  if (typeof raw.repo !== 'string' || !REPO_RE.test(raw.repo)) errors.push(`bad \`repo\`: ${JSON.stringify(raw.repo)}`);
  if (!Number.isInteger(raw.pr) || raw.pr <= 0) errors.push(`bad \`pr\`: ${JSON.stringify(raw.pr)}`);
  if (typeof raw.at !== 'string' || !ISO_RE.test(raw.at)) errors.push(`bad \`at\`: ${JSON.stringify(raw.at)}`);
  if (!isStr(raw.source)) errors.push('bad `source`: a row must name its writer');
  for (const [name, check] of spec) {
    if (!check(raw[name])) errors.push(`bad \`${name}\`: ${JSON.stringify(raw[name])}`);
  }
  if (errors.length) return { valid: false, errors, record: null };
  const actor = raw.actor && typeof raw.actor === 'object' ? raw.actor : {};
  const record = {
    v: raw.v,
    kind: VERDICT_LEDGER_KIND,
    type: raw.type,
    at: raw.at,
    repo: raw.repo,
    pr: raw.pr,
    ...Object.fromEntries(spec.map(([name, , normalize]) => [name, normalize(raw[name])])),
    actor: {
      declared: typeof actor.declared === 'string' ? oneLine(actor.declared, 200) : '',
      session: typeof actor.session === 'string' ? oneLine(actor.session, 200) : '',
      channel: typeof actor.channel === 'string' ? oneLine(actor.channel, 200) : '',
      independence: null,
      proves: ACTOR_PROVES,
    },
    source: oneLine(raw.source, 64),
    writer: typeof raw.writer === 'string' ? raw.writer : '',
  };
  return { valid: true, errors: [], record };
}

/** Serialize ONE event of any type to a JSONL line. PURE. A verdict row delegates to
 *  {@link serializeVerdictRecord} so its bytes are unchanged; other types serialize the normalized record. */
export function serializeLedgerEvent(raw) {
  if (raw && typeof raw === 'object' && (raw.type === undefined || raw.type === EVENT_TYPES.VERDICT)) {
    return serializeVerdictRecord(raw);
  }
  const { valid, errors, record } = validateLedgerEvent(raw);
  if (!valid) return { ok: false, line: null, record: null, errors };
  return { ok: true, line: JSON.stringify(record), record, errors: [] };
}

/** Parse a ledger's TEXT into normalized events of every type, in append order. Tolerant, never throws.
 *  A v1 row comes back as `type: verdict`. The v1 readers ({@link parseVerdictLog}, the fold) skip the new
 *  types, so they keep seeing exactly the rows they always saw. */
export function parseLedgerEvents(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const { valid, record } = validateLedgerEvent(parsed);
    if (valid) out.push(record);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE FOLD — reconstruct the current verdict state per PR from the append-only stream. PURE.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FoldedPr
 * @property {number} pr
 * @property {string} repo
 * @property {VerdictRecord|null} current - the latest BEARING record, which is the live verdict. **`null` when
 *   the PR has only non-bearing rows** (#3329) — the same shape as a PR with no ledger record, because that is
 *   the truth about its disposition. Every consumer must null-guard this.
 * @property {boolean} clears - whether the live verdict clears. `false` when `current` is `null`.
 * @property {VerdictRecord[]} history - EVERY record for this PR, in append order, bearing or not. This is the
 *   only place a non-bearing row is visible, and it is where "a review happened" is read back from.
 * @property {VerdictRecord[]} outstandingHolds - BEARING holds appended after the last clearing record. Empty
 *   when the live verdict clears. This is the card's *"no unanswered hold may exist"* in its computed form.
 */

/**
 * THE FOLD (#3007). Replay the append-only stream into the current verdict per PR. PURE + total.
 *
 * THE ONLY RULE IS LATEST-WINS PER PR, and it is deliberately the whole rule:
 *   • "a newer verdict supersedes an older one" → the last record for a PR is the live one;
 *   • "a hold is cleared by a later clearing record, never by deleting anything" → the clearing record is
 *     simply a later row, and there is no delete in this format to begin with.
 * Nothing is keyed on a content hash, so no rebase can make a row unreachable — see the file header.
 *
 * LATEST-WINS RUNS OVER THE **BEARING** ROWS ONLY (#3329), AND THIS IS WHERE NON-BEARING IS ENFORCED. An
 * `observed` row is pushed to `history` and then skipped: it never becomes `current`, never sets `clears`, and
 * the outstanding-hold slice is taken over the bearing rows so it can neither BE a hold nor displace one. Had
 * it merely been marked non-CLEARING, `[accepted, observed]` would have folded to `clears: false` with a
 * phantom hold — a cleared PR silently re-held by an advisory note. That regression is pinned by a test; do
 * not "simplify" the two `verdictBears` filters away. Consequence a caller must handle: `current` is `null`
 * for a PR whose only rows are non-bearing.
 *
 * @param {VerdictRecord[]} records - in append order.
 * @returns {Map<number, FoldedPr>} pr → state, in first-seen order.
 */
export function foldVerdictLedger(records) {
  /** @type {Map<number, FoldedPr>} */
  const byPr = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !Number.isInteger(r.pr)) continue;
    let entry = byPr.get(r.pr);
    if (!entry) {
      entry = { pr: r.pr, repo: r.repo, current: null, clears: false, history: [], outstandingHolds: [] };
      byPr.set(r.pr, entry);
    }
    entry.history.push(r);
    entry.repo = r.repo;
    // #3329 — the non-bearing skip. `history` above is the ONLY thing an `observed` row touches.
    if (!verdictBears(r.verdict)) continue;
    entry.current = r;
    entry.clears = r.clears;
  }
  for (const entry of byPr.values()) {
    const bearing = entry.history.filter((r) => verdictBears(r.verdict));
    let lastClearAt = -1;
    bearing.forEach((r, i) => { if (r.clears) lastClearAt = i; });
    entry.outstandingHolds = bearing.slice(lastClearAt + 1).filter((r) => !r.clears);
  }
  return byPr;
}

/**
 * PHASE-2 AFFORDANCE, BUILT AND DELIBERATELY UNWIRED. Does a folded PR's live verdict still cover the head
 * the caller is holding? PURE. It DELEGATES to `acceptanceCoversHead` and adds no staleness rule of its own —
 * that is the point. When `#3054` repairs the digest, this improves for free and nothing here changes.
 *
 * Nothing calls this today. Phase 1 does not move the merge authority, and this function is not a gate; it
 * exists so the Phase-2 wiring is a call rather than a re-derivation, and so the "witnesses, not keys"
 * decision above is demonstrable rather than merely asserted.
 *
 * A `null` RECORD ANSWERS `covers: true`, WHICH IS SAFE AND NOT AN OVERSIGHT (#3329 re-checked it). Since
 * `observed` was added, `folded.current` is `null` for a PR with only non-bearing rows, so a Phase-2 gate fed
 * `{ record: folded.current }` gets `covers: true` from a PR nobody cleared. It cannot land on that: coverage
 * is the SECOND question, asked only of a verdict that already clears, and such a PR's `clears` is `false`.
 *
 * @param {{record: VerdictRecord|null, headSha?: string|null, headDiff?: string|null,
 *   headContribution?: string|null}} o
 * @returns {{covers: boolean, reason: string}}
 */
export function ledgerCoversHead({ record, headSha = null, headDiff = null, headContribution = null } = {}) {
  if (!record || !record.coverage) return { covers: true, reason: '' };
  return acceptanceCoversHead({
    acceptedSha: record.coverage.headSha,
    headSha,
    acceptedDiff: record.coverage.reviewedDiff,
    headDiff,
    acceptedContribution: record.coverage.reviewedContribution,
    headContribution,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE PHASE-1 CHECKER CORE — ledger vs label. PURE. This is the POINT of Phase 1.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The comparison outcomes. `DISAGREE` is the only one that is a defect; the other three are states. */
export const AGREEMENT = Object.freeze({
  AGREE: 'agree',                 // the ledger's live verdict mirrors the PR's live review label.
  DISAGREE: 'disagree',           // both present and they differ — the Phase-2 blocker signal.
  UNLEDGERED: 'unledgered',       // a review label with no ledger record. EXPECTED in Phase 1 (see below).
  UNLABELED: 'unlabeled',         // a ledger record with no review label on the PR at all.
});

/** The DIRECTION of a disagreement — which way it fails, because the two directions are not equally bad. */
export const DISAGREE_DIRECTION = Object.freeze({
  /** The ledger says HOLD, the label says CLEAR. **THE DANGEROUS ONE.** In Phase 2 the ledger refuses the
   *  merge, so this is safe THEN — but today the drain merges on the label, so this is a live "hold that did
   *  not hold" (#2750/#2820/#2745/#2416) caught in the act. The checker exits non-zero on it. */
  LEDGER_HOLDS_LABEL_CLEARS: 'ledger-holds-label-clears',
  /** The ledger says CLEAR, the label says HOLD. Today's drain refuses the merge, so nothing unreviewed
   *  lands; in Phase 2 the ledger would clear it, which is why this direction must be UNDERSTOOD, not merely
   *  counted. Its expected Phase-1 cause is a hold the DRAIN applied and did not ledger — see the note on
   *  `AGREEMENT.UNLEDGERED`. Reported, does not fail the run. */
  LEDGER_CLEARS_LABEL_HOLDS: 'ledger-clears-label-holds',
  /** Both hold, or both clear, but under different labels (e.g. ledger `changes` vs label `review:pending`).
   *  Neither gate would merge; a bookkeeping divergence. Reported, does not fail the run. */
  SAME_SIDE: 'same-side',
});

/**
 * The PR's LIVE label verdict, projected in the SAME precedence `decideReviewGate`
 * (`we:scripts/lib/review-escalation.mjs`) uses: accepted → changes → human → pending. Matching that order
 * is what makes the comparison a statement about what the drain would actually do, rather than about what a
 * label list looks like. Pure. `null` when the PR carries no review label.
 * @param {Array} labels - the observed label array (string or `{name}` shape).
 * @returns {string|null} a {@link VERDICTS} member, or null.
 */
export function labelVerdictOf(labels) {
  if (hasReviewLabel(labels, REVIEW_LABELS.accepted)) return VERDICTS.ACCEPTED;
  if (hasReviewLabel(labels, REVIEW_LABELS.changes)) return VERDICTS.CHANGES;
  if (hasReviewLabel(labels, REVIEW_LABELS.human)) return VERDICTS.HUMAN;
  if (hasReviewLabel(labels, REVIEW_LABELS.pending)) return VERDICTS.PENDING;
  return null;
}

/**
 * COMPARE ONE PR's ledger state against its live labels. PURE — this is the whole checker; the CLI
 * (`we:scripts/review-ledger-check.mjs`) only fetches the labels and prints what this returns.
 *
 * WHY `UNLEDGERED` IS A SEPARATE OUTCOME AND NOT A DISAGREEMENT. Phase 1 wires the writer at the seams #3007
 * names — `we:scripts/review-set-label.mjs` and, through it, every caller including the #3035 operation. It
 * does NOT wire the drain's own park path (`applyLabel` in `we:scripts/merge-ai-prs.mjs`), because touching
 * what the drain writes is outside a shadow slice. So every PR the drain parks carries a review label with no
 * ledger row behind it, and folding that into "disagreement" would drown the signal the phase exists to
 * measure. It is counted on its own line instead — and its count IS a Phase-2 precondition, because a ledger
 * that cannot express a drain-applied hold cannot be the merge authority. Say the number, do not hide it.
 *
 * A NON-BEARING ROW IS NOT DRIFT (#3329). `folded.current` is the latest BEARING row, so `observed` can never
 * be `ledgerVerdict` here nor be scored as a disagreement or an `unlabeled` orphan — it is CORRECTLY
 * label-less, and counting it as drift would inflate the number and bury a real orphan. The other half of that
 * filtering is `buildRows` (`we:scripts/review-ledger-check.mjs`), which must not admit a PR to the comparison
 * set on the strength of a non-bearing row alone.
 *
 * @param {{pr: number, labels?: Array, folded?: FoldedPr|null}} o
 * @returns {{pr: number, status: string, direction: string|null, ledgerVerdict: string|null,
 *   labelVerdict: string|null, ledgerClears: boolean|null, labelClears: boolean|null, at: string|null,
 *   actor: string|null, source: string|null, detail: string}}
 */
export function compareLedgerToLabels({ pr, labels = [], folded = null } = {}) {
  const labelVerdict = labelVerdictOf(labels);
  const ledgerVerdict = folded && folded.current ? folded.current.verdict : null;
  const base = {
    pr,
    ledgerVerdict,
    labelVerdict,
    ledgerClears: ledgerVerdict == null ? null : verdictClears(ledgerVerdict),
    labelClears: labelVerdict == null ? null : verdictClears(labelVerdict),
    at: folded && folded.current ? folded.current.at : null,
    actor: folded && folded.current ? (folded.current.actor.declared || folded.current.actor.session || '') : null,
    source: folded && folded.current ? folded.current.source : null,
  };

  if (ledgerVerdict == null && labelVerdict == null) {
    return { ...base, status: AGREEMENT.AGREE, direction: null, detail: 'no ledger record and no review label' };
  }
  if (ledgerVerdict == null) {
    return {
      ...base,
      status: AGREEMENT.UNLEDGERED,
      direction: null,
      detail: `label \`${verdictLabel(labelVerdict)}\` has no ledger record — written before the ledger, or by a `
        + 'writer Phase 1 does not cover (the drain\'s own park path)',
    };
  }
  if (labelVerdict == null) {
    return {
      ...base,
      status: AGREEMENT.UNLABELED,
      direction: null,
      detail: `ledger says \`${ledgerVerdict}\` but the PR carries no review label — the mirror to `
        + `\`${verdictLabel(ledgerVerdict)}\` did not land, or something removed it`,
    };
  }
  if (ledgerVerdict === labelVerdict
    || (verdictLabel(ledgerVerdict) && verdictLabel(ledgerVerdict) === verdictLabel(labelVerdict))) {
    return { ...base, status: AGREEMENT.AGREE, direction: null, detail: `both \`${verdictLabel(labelVerdict)}\`` };
  }

  const ledgerClears = verdictClears(ledgerVerdict);
  const labelClears = verdictClears(labelVerdict);
  const direction = ledgerClears === labelClears
    ? DISAGREE_DIRECTION.SAME_SIDE
    : ledgerClears
      ? DISAGREE_DIRECTION.LEDGER_CLEARS_LABEL_HOLDS
      : DISAGREE_DIRECTION.LEDGER_HOLDS_LABEL_CLEARS;
  return {
    ...base,
    status: AGREEMENT.DISAGREE,
    direction,
    detail: `ledger \`${ledgerVerdict}\` vs label \`${verdictLabel(labelVerdict)}\``,
  };
}

/**
 * Roll a set of per-PR comparisons into the report a human acts on. PURE.
 *
 * `phase2Safe` is the ONE question Phase 1 exists to answer, and it is answered narrowly on purpose: zero
 * DISAGREEMENTS of any direction. `unledgered` rows are reported separately with their own explicit
 * `owedBeforePhase2` count, because they are not disagreements — they are coverage the writer does not yet
 * have, and shipping Phase 2 with them outstanding would silently drop every drain-applied hold.
 * @param {Array} rows - {@link compareLedgerToLabels} results.
 * @returns {{total: number, counts: object, directions: object, dangerous: Array, disagreements: Array,
 *   owedBeforePhase2: number, phase2Safe: boolean}}
 */
export function summarizeAgreement(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = { agree: 0, disagree: 0, unledgered: 0, unlabeled: 0 };
  const directions = { 'ledger-holds-label-clears': 0, 'ledger-clears-label-holds': 0, 'same-side': 0 };
  for (const r of list) {
    if (counts[r.status] !== undefined) counts[r.status] += 1;
    if (r.direction && directions[r.direction] !== undefined) directions[r.direction] += 1;
  }
  const disagreements = list.filter((r) => r.status === AGREEMENT.DISAGREE);
  return {
    total: list.length,
    counts,
    directions,
    dangerous: disagreements.filter((r) => r.direction === DISAGREE_DIRECTION.LEDGER_HOLDS_LABEL_CLEARS),
    disagreements,
    owedBeforePhase2: counts.unledgered,
    phase2Safe: counts.disagree === 0 && counts.unledgered === 0,
  };
}

/**
 * Shadow intent vs the NEXT human outcome, in ledger append order (#3217). This is a different measurement
 * from summarizeAgreement's live label drift, and deliberately provides no enforce-readiness predicate.
 * A human outcome is a `clear-human` ceremony, or an accepted/changes verdict attributed to the explicitly
 * selected `humanActor`. Declared identity proves only the sanctioned path (ACTOR_PROVES), not personhood.
 * Repeated scheduled predictions replace the pending prediction for that repo/PR; each human outcome consumes
 * it once. Earlier human verdicts cannot validate later predictions. No content-equivalence claim is made.
 */
export function summarizeShadowAgreement(records, { humanActor = '' } = {}) {
  const pending = new Map();
  const rows = [];
  let superseded = 0;
  for (const raw of Array.isArray(records) ? records : []) {
    const { valid, record: r } = validateVerdictRecord(raw);
    if (!valid) continue;
    const key = `${r.repo}#${r.pr}`;
    if (r.mode === 'shadow') {
      if (pending.has(key)) superseded += 1;
      pending.set(key, r);
      continue;
    }
    const human = r.verdict === VERDICTS.CLEAR_HUMAN
      || (humanActor && r.actor.declared === humanActor
        && [VERDICTS.ACCEPTED, VERDICTS.CHANGES].includes(r.verdict));
    if (!human || !pending.has(key)) continue;
    const prediction = pending.get(key);
    pending.delete(key);
    rows.push({
      repo: r.repo, pr: r.pr, shadowAt: prediction.at, humanAt: r.at,
      wouldClear: prediction.wouldClear, humanVerdict: r.verdict, humanClears: r.clears,
      status: prediction.wouldClear === r.clears ? AGREEMENT.AGREE : AGREEMENT.DISAGREE,
    });
  }
  return {
    total: rows.length,
    agree: rows.filter((r) => r.status === AGREEMENT.AGREE).length,
    disagree: rows.filter((r) => r.status === AGREEMENT.DISAGREE).length,
    unmatched: [...pending.values()], superseded, rows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// IO SHELL — the machine-global home, the locked append, the read. Everything above this line is pure.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where the ledger lives when nothing redirects it: `~/.claude/verdict-ledger`. HOME-anchored, NOT
 * per-checkout — see the file header for why a per-clone ledger cannot be a merge authority. Pure (the home
 * is injectable) so the anchoring itself is testable.
 */
export function defaultVerdictLedgerDir(home = homedir()) {
  return join(home, '.claude', 'verdict-ledger');
}

/**
 * The ledger home in effect for this process.
 *
 * A TEST RUN NEVER TOUCHES THE REAL LEDGER, and that is enforced HERE rather than left to each test file to
 * remember. `we:scripts/review-set-label.mjs` appends on the ordinary verdict path, and its suite drives that
 * path 163 times with stubbed `gh` — so without this guard the unit suite writes rows into the operator's
 * merge authority, and the next test that happens to use the real repo slug corrupts it. A per-file
 * `beforeEach` would fix today's suite and re-open on the next caller; a redirect at the one place the path
 * is resolved cannot be forgotten. `WE_VERDICT_LEDGER_DIR` still wins, so a test that wants an inspectable
 * dir names one.
 */
export function verdictLedgerDir() {
  const env = process.env.WE_VERDICT_LEDGER_DIR;
  if (env && env.trim()) return env;
  if (isUnderTest()) return join(tmpdir(), 'we-verdict-ledger-vitest');
  return defaultVerdictLedgerDir();
}

/** The writer-lock home, a SIBLING of the ledger dir so a test that redirects one redirects both. Machine-
 *  global for the same reason `DRAIN_LOCK_ROOT` is. */
export function verdictLedgerLockRoot() {
  return `${verdictLedgerDir()}-locks`;
}

/** The lock key. One key for the whole ledger: appends are microseconds and per-repo keys would buy nothing
 *  but a second way to be wrong. */
export const VERDICT_LEDGER_LOCK_PATH = '<verdict-ledger:append>';

/** A short TTL — an append is a single line write. A crashed holder frees the section in a minute. */
export const VERDICT_LEDGER_LEASE_MINUTES = 1;

/** `host:pid:verdict-ledger`, matching `makeOwner` in `we:scripts/readiness/drain-lock.mjs`. */
export function processWriterId() {
  return `${hostname()}:${process.pid}:verdict-ledger`;
}

/** One JSONL file per repo: `<dir>/<owner>-<name>.jsonl`. The slug only replaces the path separator, so the
 *  mapping stays readable and reversible. */
export function verdictLedgerPath(repo) {
  const slug = String(repo ?? '').trim().replace(/[/\\\s\x00-\x1f]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return join(verdictLedgerDir(), `${slug}.jsonl`);
}

/**
 * APPEND one verdict record. The only write path.
 *
 * SERIALIZED, because the card's single-writer premise does not hold here (file header). The append takes the
 * machine-global writer lock, writes, and releases. **A lock it cannot get does NOT cost the record**: the
 * append proceeds and the row is stamped `unlocked: true`, so the weaker case is legible in the ledger itself
 * rather than being a silence. A lost verdict is worse than an interleaved line, and the line is one
 * `appendFileSync` of one newline-terminated string on a local filesystem.
 *
 * Validates before writing — an invalid record is REFUSED and nothing is written.
 *
 * @param {VerdictRecord} record - from {@link buildVerdictRecord}.
 * @returns {{ok: boolean, path: string|null, record: VerdictRecord|null, locked: boolean, errors: string[]}}
 */
export function appendVerdict(record) {
  const lockRoot = verdictLedgerLockRoot();
  const owner = processWriterId();
  let locked = false;
  try {
    mkdirSync(lockRoot, { recursive: true });
    locked = reserve(
      lockRoot, VERDICT_LEDGER_LOCK_PATH, owner, Date.now(), new Date().toISOString(),
      process.pid, 'unknown', VERDICT_LEDGER_LEASE_MINUTES,
    ).ok === true;
  } catch { locked = false; }

  try {
    const raw = locked ? record : { ...record, unlocked: true };
    const { ok, line, record: normalized, errors } = serializeVerdictRecord(raw);
    if (!ok) return { ok: false, path: null, record: null, locked, errors };
    const path = verdictLedgerPath(record.repo);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, 'utf8');
    return { ok: true, path, record: normalized, locked, errors: [] };
  } finally {
    if (locked) { try { releaseLockDir(lockRoot, VERDICT_LEDGER_LOCK_PATH); } catch { /* TTL reclaims it */ } }
  }
}

/** Read + normalize one repo's ledger. A missing file → `[]`. Never throws. */
export function readVerdictLedger(repo) {
  let text;
  try { text = readFileSync(verdictLedgerPath(repo), 'utf8'); } catch { return []; }
  return parseVerdictLog(text);
}

/** Read one repo's ledger and fold it. The single call a checker or a Phase-2 gate makes. */
export function foldRepo(repo) {
  return foldVerdictLedger(readVerdictLedger(repo));
}

/** The repos that have a ledger file. `[]` when none. Never throws. */
export function listLedgerRepos() {
  const dir = verdictLedgerDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length)).sort();
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// CLI — `show` (fold + print) · `path` (where the file is) · `repos`. Gated on direct invocation.
// The ledger↔label CHECKER is a separate CLI (`we:scripts/review-ledger-check.mjs`) because it needs `gh`;
// this module stays offline so the unit suite can import it freely.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

function main(argv) {
  const sub = argv[0];
  const flags = parseFlags(argv.slice(1));
  const repo = typeof flags.repo === 'string' ? flags.repo : '';

  if (sub === 'path') {
    writeAllSync(1, `${repo ? verdictLedgerPath(repo) : verdictLedgerDir()}\n`);
    process.exit(0);
  }
  if (sub === 'repos') {
    writeAllSync(1, `${listLedgerRepos().join('\n')}\n`);
    process.exit(0);
  }
  if (sub === 'shadow-agreement') {
    if (!REPO_RE.test(repo)) {
      process.stderr.write('verdict-ledger shadow-agreement: --repo=<owner/name> is required\n');
      process.exit(2);
    }
    const summary = summarizeShadowAgreement(readVerdictLedger(repo), {
      humanActor: typeof flags['human-actor'] === 'string' ? flags['human-actor'] : '',
    });
    writeAllSync(1, `${JSON.stringify(summary, null, flags.json ? 0 : 2)}\n`);
    process.exit(0);
  }
  if (sub === 'show') {
    if (!REPO_RE.test(repo)) {
      process.stderr.write('verdict-ledger show: --repo=<owner/name> is required\n');
      process.exit(2);
    }
    // `e.current` is NULL-GUARDED (#3329): a PR whose only rows are non-bearing has no live verdict, and a
    // bare `e.current.verdict` would throw on exactly the shape this ledger was widened to hold. The observed
    // count prints alongside so a review that HAPPENED stays visible even though it bears nothing.
    const folded = [...foldRepo(repo).values()].map((e) => ({
      pr: e.pr,
      verdict: e.current ? e.current.verdict : null,
      clears: e.clears,
      at: e.current ? e.current.at : null,
      actor: e.current ? e.current.actor : null,
      source: e.current ? e.current.source : null,
      coverage: e.current ? e.current.coverage : null,
      records: e.history.length,
      observed: e.history.filter((r) => !verdictBears(r.verdict)).length,
      outstandingHolds: e.outstandingHolds.length,
    }));
    writeAllSync(1, `${JSON.stringify(folded, null, flags.json ? 0 : 2)}\n`);
    process.exit(0);
  }
  process.stderr.write('usage: verdict-ledger <show --repo=<owner/name> [--json] | shadow-agreement --repo=<owner/name> [--human-actor=<name>] [--json] | path [--repo=…] | repos>\n');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}
