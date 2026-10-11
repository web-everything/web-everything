/**
 * @file scripts/lib/accept-carry-forward.mjs
 * @description Card xu7kxtt (#5472, ruling P4, operator 2026-10-08): "an equivalent merge-main keeps the accept; a heal
 *   commit gets a delta review of its own diff only".
 *
 *   THE RULE. An accept (an agent `review:accepted`, or the operator's `clear-human`) is recorded against a head SHA
 *   AND the strict `reviewed-diff` fingerprint of the PR's own net diff (vs its merge-base). When the head moves, the
 *   accept is CARRIED to the new head only when the new head's net diff fingerprint is byte-identical to the
 *   accepted one (`normalizeDiffFingerprint`: only text-section `index` lines and the root lane manifest are left
 *   out). That is what a pure merge/rebase of main produces. Anything else (a conflict resolution, a new commit,
 *   a fingerprint that cannot be read) is NOT carried: a review of the change is owed, as today.
 *
 *   WHY THIS EXISTS (live, #4535, 2026-10-09). The operator cleared #4535 at head fcc29ce1. The merge queue (#4619)
 *   refreshed it onto main at 14:25Z (new head 143107a87, a merge commit). The net diff stayed byte-identical
 *   (reviewed-diff b945d333… on both heads). The drain's anti-test-gaming gate bound the clearance to the SHA only,
 *   so it re-parked `review:human` at 14:36Z, and the PR waited for a second operator approval of the same diff.
 *
 *   WHAT IT NEVER DOES. It never widens to the contribution digest (context-insensitive): a carry needs the STRICT
 *   fingerprint. It never carries past a later verdict or a body-derived hold (manifest tamper): those are not
 *   content of the diff, so an identical diff proves nothing about them.
 *
 *   SETTING `acceptCarryForward` (`on` | `off`), policy cascade (card x5wnfcg): standard default (built-in `off` =
 *   today: a moved head loses a SHA-bound accept) → platform preference (`we:scripts/settings/accept-carry-forward.json`)
 *   → tool override (env `WE_ACCEPT_CARRY_FORWARD`).
 *
 *   Pure except {@link resolveAcceptCarryForward} (reads the settings file).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

export const ACCEPT_CARRY_FORWARD_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'accept-carry-forward.json');

/** Built-in standard default: today's behaviour. */
export const ACCEPT_CARRY_FORWARD_DEFAULT = 'off';

const onOff = (v) => { const x = String(v ?? '').trim().toLowerCase(); return x === 'on' || x === 'off' ? x : null; };

/** env `WE_ACCEPT_CARRY_FORWARD` > settings `acceptCarryForward` > built-in `off`. */
export function resolveAcceptCarryForward({ env = process.env, file = ACCEPT_CARRY_FORWARD_SETTINGS_FILE } = {}) {
  const fromEnv = onOff(env?.WE_ACCEPT_CARRY_FORWARD);
  if (fromEnv) return { value: fromEnv, source: 'env' };
  try { const f = onOff(JSON.parse(readFileSync(file, 'utf8'))?.acceptCarryForward); if (f) return { value: f, source: 'settings' }; } catch { /* built-in */ }
  return { value: ACCEPT_CARRY_FORWARD_DEFAULT, source: 'default' };
}

const SHA_RE = /^[0-9a-f]{40}$/;
const FP_RE = /^[0-9a-f]{64}$/;
const REVIEWED_SHA_RE = /<!--\s*reviewed-sha:\s*([0-9a-f]{40})\s*-->/gi;
const REVIEWED_DIFF_RE = /<!--\s*reviewed-diff:\s*([0-9a-f]{64})\s*-->/gi;
const CLEARED_HUMAN_RE = /<!--\s*cleared-human:\s*([^>]*?)\s*-->/i;
/** A drain park whose reason is NOT a function of the diff: an identical diff proves nothing about it. */
const BODY_DERIVED_HOLD_RE = /manifest baseline mismatch/i;
/**
 * A LATER VERDICT or deliberate hold, recognised by positive identification of the shapes this repo writes (PR #4631
 * review, round 1). Neither leaves a `reviewed-sha` marker, so `latestAcceptRecord` cannot see it as a record:
 *   - a changes verdict (`review-set-label --to=changes`, the review-pr operation, the conflict watch): the durable
 *     heading `🔁 review — changes requested` / `🔁 human review — changes requested`;
 *   - a re-arm (`rearm-review.mjs`: an independent re-review is owed): its own marker line;
 *   - a stand-down, a CI-heal escalation / void verdict, or a referral hold (a person or an escalation now stands on it);
 *   - a drain park (`<!-- drain-park-reason -->`) whose reason is anything BUT the anti-test-gaming gate or the drain
 *     restating an already-standing hold. A test-gaming park is a function of the diff (the operator cleared exactly
 *     those bytes, so an identical diff proves it still covers: the #4535 shape this PR exists for); an
 *     escalation-policy park, a clearance-revocation park or any other reason is a decision about the PR, not the bytes.
 *   A label-only `review:human` re-add leaves no comment at all, so it is handled where the hold is crossed, not here:
 *   the restamp crosses only the drain's own `review:held-mechanical` label and never `review:human` (PR #4631 ruling a).
 *   Free text cannot be classified by author (the drain posts under the operator's own login on this host), so the rule
 *   is INVERTED (PR #4631 review round 3): a comment after the accept that is not positively recognised as a known
 *   MACHINE shape ({@link isKnownMachineBody}: fix claims, CI-heal / restack notes, advisory notes that are not a
 *   `changes` outcome, the drain's mechanical parks, this restamp's own note) is treated as a possible hold and
 *   supersedes the accept, whoever wrote it. A miss on the machine list only refuses a carry (the operator re-reviews,
 *   as today); a miss on a hold-phrase list would auto-accept over an objection.
 *   A formal GitHub review is a separate channel (`gh --json comments` never returns it): {@link laterReviewHold}.
 */
const LATER_VERDICT_HEADING_RE = /^\s*🔁\s+(?:human\s+)?review\s+[—-]\s+changes requested/i;
const LATER_REARM_RE = /^\s*🔧 conveyor fix — re-armed for re-review/i; // `REARM_COMMENT_MARKER`, we:scripts/conveyor/rearm-review.mjs
/** Other shapes that say a person or an escalation now stands on the PR (each a leading line some script writes). */
const LATER_STANDING_HOLD_RE = /^\s*(?:🛑 conveyor fix — stood down|🚦 conveyor CI-heal — (?:escalated|verdict void)|review paused:)/i;
const DRAIN_PARK_MARKER_RE = /<!--\s*drain-park-reason\s*-->/i;
/**
 * The ONLY drain parks that carry through, matched at the START of the comment under the drain's own heading (never
 * anywhere in the body: park reasons embed PR-author text such as file paths and `## Escalation reason` bullets, so an
 * unanchored match could be forged from the PR itself):
 *   - `test-gaming suspected —`: the anti-test-gaming gate, a function of the diff (live #4535);
 *   - `held — a review hold`: the drain restating a hold that already stands (`HELD_PARK_PREFIX`, merge-ai-prs.mjs); it
 *     decides nothing new, and it is posted mechanically after the test-gaming re-park strips `ready-to-merge`.
 */
const MECHANICAL_PARK_RE = /^\s*<!--\s*drain-park-reason\s*-->\s*\n⏸ \*\*Parked for review by the drain\*\*\s*\n\s*(?:test-gaming suspected\s+[—-]|held\s+[—-]\s+a review hold)/i;

/** Pure: is this (trusted) comment body a later verdict / deliberate hold that an identical diff proves nothing about? */
export function isLaterVerdictBody(body) {
  const text = typeof body === 'string' ? body : '';
  if (!text) return false;
  if (LATER_VERDICT_HEADING_RE.test(text) || LATER_REARM_RE.test(text) || LATER_STANDING_HOLD_RE.test(text)) return true;
  return DRAIN_PARK_MARKER_RE.test(text) && !MECHANICAL_PARK_RE.test(text);
}

/**
 * The MACHINE shapes that say nothing about the clearance, each anchored on the comment's leading line (a body that merely
 * CONTAINS one of these strings further down is not one). Extending this list is the only way a new bot comment stops
 * blocking a carry; leaving a shape off it fails safe (the carry is refused, the operator re-reviews).
 */
const KNOWN_MACHINE_SHAPE_RES = [
  /^\s*🔒 conveyor fix-begin —/, /^\s*🔓 conveyor fix-end —/, // the fix claim (`fix-procedure.mjs`)
  /^\s*🩹 conveyor CI-heal —/, // a CI repair note (a CI-heal ESCALATION / void verdict is `LATER_STANDING_HOLD_RE`, checked first)
  /^\s*(?:🔧|✅) conveyor (?:fix|restack) —/, // fix / restack evidence (a re-arm is `LATER_REARM_RE`, checked first)
  /^\s*🔔 conveyor —/, // a conveyor operator note
  /^\s*📌 review — acceptance re-stamped/, // this restamp's own comment
  // The drain's own reason comments (`buildDrainReasonComment`: skip / land / merge-trace / review-coverage / stacked-base-close).
  // Posted on every final skip of an AI PR, so one always follows a clearance. NOT `drain-park-reason`: a park is a verdict
  // unless it is the mechanical shape above, and `isLaterVerdictBody` has already claimed it by the time this list runs.
  /^\s*<!--\s*drain-(?!park-)[a-z0-9-]+-reason\s*-->/,
  /^\s*(?:🔀 conveyor rebase-onto-main|⏱️ conveyor CI-hung-recovery|🚦 conveyor missing-run-recovery|⏳ conveyor —|🔎 stuck-PR inspection)/, // conveyor recovery / queue notes
];
// The real note opens with the bold `ADVISORY_NOTE_MARKER` (`**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.**`).
const ADVISORY_NOTE_RE = /^\s*\**\s*⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT\./;
const ADVISORY_CHANGES_RE = /\*\*Advisory outcome:\*\*\s*`?changes`?/i;

/**
 * Pure: is this comment body (any author) a recognised machine shape that cannot be a hold? An empty body says nothing.
 * Verdicts, re-arms, stand-downs and non-mechanical drain parks are NOT machine shapes (they supersede the accept).
 */
export function isKnownMachineBody(body) {
  const text = typeof body === 'string' ? body : '';
  if (!text.trim()) return true;
  if (isLaterVerdictBody(text)) return false;
  if (MECHANICAL_PARK_RE.test(text)) return true;
  if (ADVISORY_NOTE_RE.test(text)) return !ADVISORY_CHANGES_RE.test(text);
  return KNOWN_MACHINE_SHAPE_RES.some((re) => re.test(text));
}

/**
 * Pure: did a formal GitHub review land after the accept that stands against it? `gh pr view --json comments` never
 * returns reviews, so a "Request changes" review (or a review that only comments) was invisible to the thread reader
 * (PR #4631 review round 3). Any review whose state is not APPROVED / DISMISSED / PENDING, submitted after the accept
 * (or in the same second: GitHub times are whole seconds), counts; a review with a missing or unparseable
 * `submitted_at` counts too (fail closed). `acceptAt` null = unknown → every such review counts.
 *
 * THE LATEST FORMAL REVIEW STATE (PR #4631 round 11, operator ruling 2026-10-10 ~19:25 ET: a later native GitHub
 * "changes requested" review, from any trusted reviewer identity including plateau-reviewer[bot] and the operator, must
 * stop accept carry-forward; "check the latest formal review state on the live head before carrying"). Timing alone
 * cannot decide it: a restamp re-dates the accept record without being a review, so a CHANGES_REQUESTED that landed
 * between the clearance and a restamp would read as "before the accept" and be laundered. So, whatever the timing, a
 * reviewer whose LATEST decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED; a COMMENTED or PENDING review decides
 * nothing) is CHANGES_REQUESTED holds: GitHub's own rule for a standing change request, which only that reviewer's
 * approval or a dismissal lifts. A review with no login is its own reviewer (nothing can supersede it).
 * @param {Array<{state?:string, submitted_at?:string, submittedAt?:string, user?:{login?:string}, author?:{login?:string}}>} reviews
 */
export function laterReviewHold(reviews, acceptAt = null) {
  const at = Date.parse(String(acceptAt ?? ''));
  const list = Array.isArray(reviews) ? reviews : [];
  const timeOf = (r) => Date.parse(String(r?.submitted_at ?? r?.submittedAt ?? ''));
  const laterObjection = list.some((r) => {
    const state = String(r?.state ?? '').toUpperCase();
    // PENDING = an unsubmitted draft (visible only to its author): not an objection anyone has made yet.
    if (state === 'APPROVED' || state === 'DISMISSED' || state === 'PENDING') return false;
    const t = timeOf(r);
    return !Number.isFinite(at) || !Number.isFinite(t) || t >= at;
  });
  if (laterObjection) return true;
  // Each reviewer's latest decisive review, in submission order. An unparseable time sorts last, so its
  // CHANGES_REQUESTED stands (fail closed); the stable sort keeps the REST list's own order on ties.
  const latest = new Map();
  list.map((r, i) => ({ r, i, t: timeOf(r) }))
    .sort((a, b) => (Number.isFinite(a.t) ? a.t : Infinity) - (Number.isFinite(b.t) ? b.t : Infinity) || a.i - b.i)
    .forEach(({ r, i }) => {
      const state = String(r?.state ?? '').toUpperCase();
      if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') return;
      const login = String(r?.user?.login ?? r?.author?.login ?? '').trim().toLowerCase();
      latest.set(login || `#${i}`, state);
    });
  return [...latest.values()].includes('CHANGES_REQUESTED');
}

const lastMatch = (re, body) => { re.lastIndex = 0; let m; let out = null; while ((m = re.exec(body)) !== null) out = m[1].toLowerCase(); return out; };

/**
 * The latest trusted accept record on a PR thread, and what was posted after it. Pure.
 * @param {Array<{body?:string, author?:object, createdAt?:string}>} comments
 * @param {Array|null|undefined} reviews — the PR's formal reviews (`pulls/{n}/reviews`): an array = read; `null` =
 *   UNREADABLE (the record is marked `reviewsUnreadable`, which {@link decideAcceptCarryForward} refuses as a retryable
 *   read miss); `undefined` = the caller has no review channel (pure thread analysis, e.g. the sweep's planning pass).
 * @returns {{sha:string, diff:string|null, humanCleared:boolean, actor:string|null, index:number, at:string|null,
 *   laterBodyDerivedHold:boolean, laterVerdict:boolean, reviewsUnreadable:boolean}|null}
 */
export function latestAcceptRecord(comments, reviews = undefined) {
  const list = Array.isArray(comments) ? comments : [];
  let rec = null;
  list.forEach((c, index) => {
    if (!isTrustedMarkerAuthor(c)) return;
    const body = typeof c?.body === 'string' ? c.body : '';
    const sha = body ? lastMatch(REVIEWED_SHA_RE, body) : null;
    if (!sha) return;
    const human = CLEARED_HUMAN_RE.exec(body);
    rec = { sha, diff: lastMatch(REVIEWED_DIFF_RE, body), humanCleared: !!human, actor: human ? human[1] || null : null, index,
      at: typeof c?.createdAt === 'string' ? c.createdAt : (typeof c?.created_at === 'string' ? c.created_at : null) };
  });
  if (!rec) return null;
  const later = list.slice(rec.index + 1);
  const laterBodyDerivedHold = later.filter((c) => isTrustedMarkerAuthor(c))
    .some((c) => BODY_DERIVED_HOLD_RE.test(typeof c?.body === 'string' ? c.body : ''));
  // ANY author: an unrecognised comment is a possible hold (see the file's "inverted rule" note), a recognised verdict
  // shape is one. A formal review that stands against the accept is the other channel.
  const laterVerdict = later.some((c) => !isKnownMachineBody(c?.body)) || (Array.isArray(reviews) && laterReviewHold(reviews, rec.at));
  return { ...rec, laterBodyDerivedHold, laterVerdict, reviewsUnreadable: reviews === null };
}

/**
 * THE RULE. Facts in, verdict out. Pure.
 * @param {{setting?:'on'|'off', record?:ReturnType<typeof latestAcceptRecord>, headSha?:string|null,
 *   headDiff?:string|null, laterVerdict?:boolean}} facts — `headDiff` is the strict `normalizeDiffFingerprint` of the
 *   live head's net diff (null when it could not be read).
 * @returns {{action:'off'|'none'|'same-head'|'carry'|'review-owed', from?:string, to?:string, human?:boolean,
 *   reason:string, retryable?:boolean}} — `retryable`: the refusal is a read miss, not a decision; try again later.
 *   `carry` = the accept holds on the new head (record both SHAs). `review-owed` = the net diff changed or could not
 *   be proven identical: today's path (a review of the change; a `review:human` PR goes back to the operator).
 */
export function decideAcceptCarryForward({ setting = ACCEPT_CARRY_FORWARD_DEFAULT, record = null, headSha = null, headDiff = null, laterVerdict = false } = {}) {
  if (setting !== 'on') return { action: 'off', reason: 'acceptCarryForward is off (today: a moved head loses a SHA-bound accept)' };
  const head = typeof headSha === 'string' ? headSha.toLowerCase() : '';
  if (!record || !SHA_RE.test(record.sha ?? '')) return { action: 'none', reason: 'no trusted accept record on the PR' };
  if (!SHA_RE.test(head)) return { action: 'none', reason: 'live head unknown', retryable: true };
  const base = { from: record.sha, to: head, human: !!record.humanCleared };
  if (record.sha === head) return { ...base, action: 'same-head', reason: 'the accept already names the live head' };
  // `laterVerdict` is derived from the thread by `latestAcceptRecord` (a caller cannot forget to supply it); the
  // explicit fact is kept as an OR for a caller that knows something the comments do not.
  if (laterVerdict || record.laterVerdict) return { ...base, action: 'none', reason: 'a later verdict or deliberate hold supersedes the accept' };
  if (record.laterBodyDerivedHold) return { ...base, action: 'none', reason: 'a later hold is not derived from the diff (manifest tamper); an identical diff proves nothing about it' };
  // Formal reviews are a read of their own; an unreadable one is a miss (retry), never "no review stands against it".
  if (record.reviewsUnreadable) return { ...base, action: 'review-owed', reason: 'the PR\'s formal reviews could not be read; a standing changes-requested review is unproven absent', retryable: true };
  const accepted = typeof record.diff === 'string' ? record.diff.toLowerCase() : '';
  const live = typeof headDiff === 'string' ? headDiff.toLowerCase() : '';
  // A read miss (git/gh) is not a verdict about the PR: `retryable` tells the caller not to remember it as a refusal.
  // Checked BEFORE the accepted fingerprint: with the live diff unread a diff-less accept (plateau-app #217) cannot be
  // re-derived either, so "no fingerprint" would otherwise mask the miss as a settled refusal.
  if (!FP_RE.test(live)) return { ...base, action: 'review-owed', reason: 'the live net diff could not be read; identity unproven', retryable: true };
  if (!FP_RE.test(accepted)) return { ...base, action: 'review-owed', reason: 'the accept carries no reviewed-diff fingerprint; identity unproven' };
  if (accepted !== live) {
    return { ...base, action: 'review-owed', reason: `net diff changed since the accept at ${record.sha.slice(0, 9)} — a review of the change is owed${record.humanCleared ? '; it goes back to the operator' : ''}` };
  }
  return { ...base, action: 'carry', reason: `net diff byte-identical to the accept at ${record.sha.slice(0, 9)} (reviewed-diff ${accepted.slice(0, 12)}); accept carried to ${head.slice(0, 9)}` };
}

/*
 * WHICH HOLD A CARRY MAY LIFT (PR #4631, operator ruling 2026-10-10 ~14:20 ET, option a). Not a function of this module:
 * a LABEL. The drain's mechanical park holds with its own `review:held-mechanical` (`REVIEW_LABELS.heldMechanical`,
 * written only by `decideTestGamingPark` in merge-ai-prs.mjs), and `review-set-label.mjs --to=restamp` lifts only that
 * label, only on a `carry` verdict from `decideAcceptCarryForward`. `review:human` always means a person set the hold and
 * is never removed automatically. No timing, label-timeline event or event count is read to attribute a hold: on this
 * host the drain shares the operator's login, so a person's concurrent or re-added `review:human` could never be told
 * apart from the drain's by its history (rounds 2-9 tried a ledger row, a live-read attestation and event counts).
 */
