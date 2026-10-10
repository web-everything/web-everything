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
 *   {@link decideMechanicalHold} (the restamp refuses unless the standing hold is the drain's own ledgered park).
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
 * (PR #4631 review round 3). Any review whose state is not APPROVED / DISMISSED / PENDING, submitted after the accept, counts; a
 * review with a missing or unparseable `submitted_at` counts too (fail closed). `acceptAt` null = unknown → every
 * such review counts.
 * @param {Array<{state?:string, submitted_at?:string, submittedAt?:string}>} reviews
 */
export function laterReviewHold(reviews, acceptAt = null) {
  const at = Date.parse(String(acceptAt ?? ''));
  return (Array.isArray(reviews) ? reviews : []).some((r) => {
    const state = String(r?.state ?? '').toUpperCase();
    // PENDING = an unsubmitted draft (visible only to its author): not an objection anyone has made yet.
    if (state === 'APPROVED' || state === 'DISMISSED' || state === 'PENDING') return false;
    const t = Date.parse(String(r?.submitted_at ?? r?.submittedAt ?? ''));
    return !Number.isFinite(at) || !Number.isFinite(t) || t > at;
  });
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

/** The drain's anti-test-gaming re-park, as its verdict-ledger row spells the reason (`merge-ai-prs.mjs`). */
const TEST_GAMING_PARK_REASON_RE = /^\s*test-gaming suspected\s+[—-]/i;
/**
 * The `actor.session` stamp on a drain park row, written by `applyTestGamingParkLabel` (`merge-ai-prs.mjs`) only AFTER a
 * live label read showed `review:human` absent and the drain's own add succeeded (PR #4631 round 4, F2). A row without
 * it — from an older drain build that wrote the row before the add, with no live read — proves nothing about who put the
 * label there, so it is not accepted as proof of a mechanical hold.
 */
export const LIVE_LABEL_ATTESTATION = 'live-label-absent-v1';
/**
 * The drain now writes the ledger row just AFTER its label add (round 4; the old order was row first, live #4535: row
 * 14:36:41, `labeled review:human` 14:36:50), so the label event may precede the row by the add's round trip plus clock
 * skew between GitHub and this host; the late window still covers the old order's observed gap.
 */
export const HOLD_PAIR_EARLY_MS = 15_000;
export const HOLD_PAIR_LATE_MS = 120_000;

const msOf = (iso) => { const t = Date.parse(String(iso ?? '')); return Number.isFinite(t) ? t : null; };
const isDrainTestGamingPark = (r) => r?.verdict === 'human' && r?.source === 'merge-ai-prs' && r?.actor?.declared === 'drain'
  && r?.actor?.session === LIVE_LABEL_ATTESTATION
  && TEST_GAMING_PARK_REASON_RE.test(String(r?.reason ?? ''));

/**
 * PR #4631 review round 2 (F3/F4): was the standing `review:human` put there by the drain's mechanical anti-test-gaming
 * re-park, or by a person? Carrying the operator's clearance across a hold is only safe for the first. Pure.
 *
 * WHY NOT THE COMMENT THREAD OR THE LABEL'S ACTOR. A label-only hold (`gh pr edit --add-label review:human`) leaves no
 * comment, and on this host the drain runs under the operator's own credential (live #4535: every label event and the
 * park comment are `chalbert`), so neither the thread nor the actor can tell the two apart. The drain's verdict ledger
 * can: the drain appends a `human` row (source `merge-ai-prs`, declared actor `drain`, reason `test-gaming suspected
 * — …`) immediately before it adds the label, and nothing else writes that row. So the hold is mechanical only when ALL of:
 *   1. the latest such ledger row for the PR is newer than the clearance;
 *   2. no later ledger row of any other kind follows it (a sanctioned verdict after the park supersedes the clearance);
 *   3. the LATEST `labeled review:human` event on the PR timeline is that park's own label add (it follows the row by
 *      at most {@link HOLD_PAIR_LATE_MS}). A person re-adding the label — before or after the park — is a later or
 *      unpaired event, so a deliberate hold is never explained away by an earlier or unrelated drain row;
 *   4. (round 3) from the park row onward that add is the ONLY `review:human` event on the timeline, adds AND removals: the
 *      drain adds the label once, so a person's remove + re-add seconds later (both inside the late window) is another
 *      event and refuses. An event with an unparseable time cannot be placed before the park, so it counts.
 *   0. (round 4) the row itself is attested by its WRITER: `applyTestGamingParkLabel` (`merge-ai-prs.mjs`) appends it only
 *      after a LIVE read shows `review:human` absent, so a drain add that was a no-op because a person's label already
 *      stood leaves NO row here. This rule cannot recover that on its own — same login, one label event, nothing to
 *      pair or count against — which is why the proof is withheld at the writer and missing proof refuses below.
 * Only the test-gaming park counts. The drain restating an already-standing hold (`held — a review hold`) is posted
 * BECAUSE a hold stands, whoever put it there, so it proves nothing about origin (and writes no such ledger row).
 * Missing proof refuses (the hold stays); an unreadable timeline refuses as `retryable` (a read miss, not a decision).
 *
 * The head SHA is deliberately NOT part of the binding: the live row names `b55fa00ae`, not the PR head
 * `143107a87` (the drain's verdict snapshot is not the refreshed head), so a SHA match would refuse the very case
 * this exists for. The net-diff identity is the content proof; this only attributes the hold.
 * @param {{rows?: Array, events?: Array|null, pr: number|string, clearAt?: string|null}} o — `events` null = unreadable.
 * @returns {{mechanical: boolean, retryable?: boolean, reason: string}}
 */
export function decideMechanicalHold({ rows = [], events = null, pr, clearAt = null } = {}) {
  if (!Array.isArray(events)) return { mechanical: false, retryable: true, reason: 'the label timeline could not be read; the hold\'s origin is unproven' };
  const n = Number(pr);
  // `observed` is a shadow prediction; `restamped` is this carry's OWN record, written before its label swap — if the swap
  // then failed, the retry must not read the earlier attempt's row as a later verdict that supersedes the clearance.
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => Number(r?.pr) === n && r?.verdict !== 'observed' && r?.verdict !== 'restamped');
  const clearMs = msOf(clearAt);
  const parks = mine.filter((r) => isDrainTestGamingPark(r) && msOf(r.at) !== null && (clearMs === null || msOf(r.at) > clearMs));
  if (!parks.length) return { mechanical: false, reason: 'no drain test-gaming park is ledgered since the clearance; the review:human hold is not proven mechanical (a deliberate label-only hold is indistinguishable)' };
  const park = parks.reduce((a, b) => (msOf(b.at) >= msOf(a.at) ? b : a));
  const parkMs = msOf(park.at);
  if (mine.some((r) => msOf(r.at) !== null && msOf(r.at) > parkMs && !isDrainTestGamingPark(r))) {
    return { mechanical: false, reason: 'a later ledgered verdict follows the drain park; the clearance does not cover it' };
  }
  const holdEvents = events.filter((e) => (e?.event === 'labeled' || e?.event === 'unlabeled') && e?.label?.name === 'review:human');
  const labeled = holdEvents
    .filter((e) => e.event === 'labeled' && msOf(e.created_at) !== null && (clearMs === null || msOf(e.created_at) > clearMs))
    .map((e) => msOf(e.created_at));
  if (!labeled.length) return { mechanical: false, reason: 'no review:human label event since the clearance explains the hold' };
  const last = Math.max(...labeled);
  if (last < parkMs - HOLD_PAIR_EARLY_MS || last > parkMs + HOLD_PAIR_LATE_MS) {
    return { mechanical: false, reason: 'the latest review:human label add is not the drain park\'s own (a person re-held it); the clearance is not carried over it' };
  }
  // PR #4631 round 3: the window alone cannot tell the drain's add from a person's REMOVE + RE-ADD a few seconds later
  // (same login, both inside the late window). The drain adds the label exactly once, so from its ledger row onward the
  // timeline must hold exactly ONE `review:human` event and it must be that add; any further add or removal is a person
  // touching the hold. An event with a missing / unparseable time cannot be placed before the park, so it counts.
  const sincePark = holdEvents.filter((e) => { const t = msOf(e.created_at); return t === null || t >= parkMs - HOLD_PAIR_EARLY_MS; });
  if (sincePark.length !== 1) {
    return { mechanical: false, reason: `the review:human label changed ${sincePark.length} times since the drain park's ledger row (expected exactly its own add); a person touched the hold, so the clearance is not carried over it` };
  }
  return { mechanical: true, reason: 'the standing review:human is the drain\'s own test-gaming re-park (ledger row paired with its label add)' };
}
